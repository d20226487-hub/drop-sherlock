"""Provider-agnostic AI judge.

`judge()` takes a system prompt + a user message + provider name + optional
model override and returns a parsed JSON dict. It handles the three
provider-specific call shapes (Gemini's generateContent, GitHub Models +
OpenRouter chat-completions) and the three provider-specific failure modes.

Rate limiting is the caller's responsibility — wrap the call in
`async with limit("gemini"):` etc. so the AI provider's RPM/concurrency
budget from Settings is honoured.

JSON parsing is forgiving: providers sometimes wrap the JSON in markdown
fences despite explicit instructions. We strip those before json.loads().
A model that outputs prose around the JSON gets one extracting fallback
(find the first { and the matching last }) before we give up."""
from __future__ import annotations

import json
import logging
import re

import httpx

from .app_settings import get_provider_creds
from .providers.base import ProviderConfigError, ProviderError

log = logging.getLogger(__name__)

# Provider IDs we accept on the Analyze form's `ai.provider` field.
AI_PROVIDERS = {"gemini", "github_models", "openrouter", "vertex_ai"}


def parse_json_response(text: str) -> dict:
    """Best-effort JSON extraction. Models occasionally wrap responses in
    ```json ... ``` fences, add a sentence of prose, or (esp. smaller open
    models like Gemma) emit a second JSON object or reasoning trail after
    the answer. Be lenient."""
    if not text:
        raise ValueError("empty response")
    # Strip markdown fences if present.
    fenced = re.match(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fallback 1: raw_decode parses the FIRST complete JSON value and
    # ignores anything after it. Handles `{valid}{garbage}` and
    # `{valid}\nthen prose` cases that broke json.loads with "Extra data".
    first = text.find("{")
    if first != -1:
        decoder = json.JSONDecoder()
        try:
            obj, _end = decoder.raw_decode(text[first:])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    # Fallback 2: extract first-brace to last-brace, for the prose-with-
    # embedded-json case ("Here is the JSON: {...} Hope this helps!").
    last = text.rfind("}")
    if first != -1 and last > first:
        try:
            return json.loads(text[first : last + 1])
        except json.JSONDecodeError as e:
            raise ValueError(f"could not parse JSON: {e}") from e
    raise ValueError("response did not contain a JSON object")


# --- Resolve the model used for a given provider ---------------------------

def _resolve_model(provider: str, override: str | None) -> str:
    """Use the user-provided override, else the provider's default_model
    set in Settings, else fail loudly. The runner refuses to call with no
    model — better than silently hitting a provider's free tier default
    and getting a surprise."""
    if override and override.strip():
        return override.strip()
    creds = get_provider_creds(provider)
    default = (creds.get("default_model") or "").strip()
    if not default:
        raise ProviderConfigError(
            f"{provider}: no default_model configured in Settings, and no override provided"
        )
    return default


# --- Per-provider call paths -----------------------------------------------

async def _judge_gemini(
    *, system_prompt: str, user_message: str, model: str, timeout: float
) -> tuple[str, dict[str, int]]:
    """Returns (text, usage). Usage shape: {"input_tokens", "output_tokens"}.
    Both default to 0 when the upstream omits `usageMetadata` (rare but
    possible on some streaming responses or older API versions)."""
    creds = get_provider_creds("gemini")
    api_key = creds.get("api_key", "")
    if not api_key:
        raise ProviderConfigError("Gemini API key not set")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{model}:generateContent"
    )
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            # Don't set maxOutputTokens — Gemini decides; SEO verdicts are
            # short. Setting it too low truncates JSON and breaks parsing.
        },
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(url, params={"key": api_key}, json=body)
    if r.status_code in (401, 403):
        raise ProviderConfigError(f"Gemini rejected the API key ({r.status_code})")
    if r.status_code >= 400:
        raise ProviderError(f"Gemini returned {r.status_code}: {r.text[:300]}")
    payload = r.json() or {}
    candidates = payload.get("candidates") or []
    if not candidates:
        # Could be a safety block; surface what we got.
        raise ProviderError(f"Gemini returned no candidates: {payload}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise ProviderError(f"Gemini candidate had no text: {payload}")
    meta = payload.get("usageMetadata") or {}
    usage = {
        "input_tokens": int(meta.get("promptTokenCount") or 0),
        # Gemini API v1beta uses `candidatesTokenCount` (older docs
        # sometimes show `outputTokenCount`). Try both for safety.
        "output_tokens": int(
            meta.get("candidatesTokenCount")
            or meta.get("outputTokenCount")
            or 0
        ),
    }
    return text, usage


async def _judge_openai_compat(
    *,
    base_url: str,
    auth_header: dict[str, str],
    system_prompt: str,
    user_message: str,
    model: str,
    timeout: float,
) -> tuple[str, dict[str, int]]:
    """Shared body for GitHub Models and OpenRouter — both speak the OpenAI
    Chat Completions shape. `response_format: json_object` nudges them
    toward parseable output without depending on every model honouring it.

    Returns (text, usage). Usage uses the OpenAI shape's `prompt_tokens` /
    `completion_tokens`; both default to 0 when the upstream omits `usage`."""
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(
            f"{base_url}/chat/completions",
            headers={"Content-Type": "application/json", **auth_header},
            json=body,
        )
    if r.status_code in (401, 403):
        raise ProviderConfigError(f"upstream rejected credentials ({r.status_code})")
    if r.status_code >= 400:
        raise ProviderError(f"upstream returned {r.status_code}: {r.text[:300]}")
    payload = r.json() or {}
    choices = payload.get("choices") or []
    if not choices:
        raise ProviderError(f"upstream returned no choices: {payload}")
    msg = (choices[0].get("message") or {}).get("content")
    if not msg:
        raise ProviderError(f"upstream message empty: {payload}")
    u = payload.get("usage") or {}
    usage = {
        "input_tokens": int(u.get("prompt_tokens") or 0),
        "output_tokens": int(u.get("completion_tokens") or 0),
    }
    return msg, usage


async def _judge_github_models(
    *, system_prompt: str, user_message: str, model: str, timeout: float
) -> tuple[str, dict[str, int]]:
    creds = get_provider_creds("github_models")
    token = creds.get("token", "")
    if not token:
        raise ProviderConfigError("GitHub Models token not set")
    return await _judge_openai_compat(
        base_url="https://models.github.ai/inference",
        auth_header={"Authorization": f"Bearer {token}"},
        system_prompt=system_prompt,
        user_message=user_message,
        model=model,
        timeout=timeout,
    )


# --- Vertex AI ---------------------------------------------------------------

# Cached OAuth2 access token for the service-account path. Vertex tokens
# are valid for ~1 hour; we refresh ~10 min early so a long-running batch
# never trips a 401 mid-flight. Tuple shape: (token, epoch_seconds_expiry).
# Keyed by the service-account `client_email` so swapping the SA JSON in
# Settings doesn't keep serving a stale token from a previous identity.
_vertex_token_cache: dict[str, tuple[str, float]] = {}


def _mint_vertex_access_token(service_account_json: str) -> str:
    """Mint a short-lived OAuth2 access token from a service-account
    JSON, with a process-level cache. Synchronous (google-auth is sync);
    cheap enough to call from an async path without offloading."""
    import json as _json
    import time as _time
    try:
        info = _json.loads(service_account_json)
    except _json.JSONDecodeError as e:
        raise ProviderConfigError(
            f"Vertex AI: service_account_json is not valid JSON: {e}"
        ) from e
    client_email = info.get("client_email") or ""
    cached = _vertex_token_cache.get(client_email)
    now = _time.time()
    if cached and cached[1] > now + 60:
        return cached[0]
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
    except ImportError as e:
        raise ProviderConfigError(
            "Vertex AI service-account mode requires google-auth — "
            "rebuild the api container to install it."
        ) from e
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    try:
        creds.refresh(Request())
    except Exception as e:  # noqa: BLE001 — surface OAuth2 errors as config issues
        raise ProviderConfigError(
            f"Vertex AI: failed to mint access token: {e}"
        ) from e
    token = creds.token or ""
    if not token:
        raise ProviderConfigError("Vertex AI: token mint returned empty token")
    expiry = creds.expiry.timestamp() if creds.expiry else now + 3300
    _vertex_token_cache[client_email] = (token, expiry)
    return token


async def _judge_vertex_ai(
    *, system_prompt: str, user_message: str, model: str, timeout: float
) -> tuple[str, dict[str, int]]:
    """Vertex AI judge with two auth modes:

    1. Service-account JSON (enterprise) — mints OAuth2 token, calls the
       regional `aiplatform.googleapis.com` against a specific project.
    2. API key only (Vertex Express) — uses `?key=` against the global
       `aiplatform.googleapis.com` endpoint. Falls back to this when no
       service-account JSON is configured.

    Request/response body is the same Gemini shape Vertex accepts; we
    reuse the parsing logic from `_judge_gemini`."""
    creds = get_provider_creds("vertex_ai")
    sa_json = (creds.get("service_account_json") or "").strip()
    api_key = (creds.get("api_key") or "").strip()
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    if sa_json:
        project_id = (creds.get("project_id") or "").strip()
        location = (creds.get("location") or "").strip()
        if not project_id:
            raise ProviderConfigError(
                "Vertex AI: project_id required when using service-account JSON"
            )
        if not location:
            raise ProviderConfigError(
                "Vertex AI: location required when using service-account JSON"
            )
        token = _mint_vertex_access_token(sa_json)
        url = (
            f"https://{location}-aiplatform.googleapis.com/v1/"
            f"projects/{project_id}/locations/{location}/"
            f"publishers/google/models/{model}:generateContent"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, headers=headers, json=body)
    elif api_key:
        # Vertex Express Mode — global endpoint, no project/location.
        url = (
            "https://aiplatform.googleapis.com/v1/publishers/google/"
            f"models/{model}:generateContent"
        )
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, params={"key": api_key}, json=body)
    else:
        raise ProviderConfigError(
            "Vertex AI: neither service_account_json nor api_key is set"
        )
    if r.status_code in (401, 403):
        raise ProviderConfigError(
            f"Vertex AI rejected credentials ({r.status_code}): {r.text[:300]}"
        )
    if r.status_code >= 400:
        raise ProviderError(
            f"Vertex AI returned {r.status_code}: {r.text[:300]}"
        )
    payload = r.json() or {}
    candidates = payload.get("candidates") or []
    if not candidates:
        raise ProviderError(f"Vertex AI returned no candidates: {payload}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise ProviderError(f"Vertex AI candidate had no text: {payload}")
    meta = payload.get("usageMetadata") or {}
    usage = {
        "input_tokens": int(meta.get("promptTokenCount") or 0),
        "output_tokens": int(
            meta.get("candidatesTokenCount")
            or meta.get("outputTokenCount")
            or 0
        ),
    }
    return text, usage


async def _judge_openrouter(
    *, system_prompt: str, user_message: str, model: str, timeout: float
) -> tuple[str, dict[str, int]]:
    creds = get_provider_creds("openrouter")
    api_key = creds.get("api_key", "")
    if not api_key:
        raise ProviderConfigError("OpenRouter API key not set")
    return await _judge_openai_compat(
        base_url="https://openrouter.ai/api/v1",
        auth_header={
            "Authorization": f"Bearer {api_key}",
            # OpenRouter recommends an HTTP-Referer + X-Title for accounting
            # but accepts requests without them.
            "HTTP-Referer": "https://drop-sherlock.local",
            "X-Title": "Drop Sherlock",
        },
        system_prompt=system_prompt,
        user_message=user_message,
        model=model,
        timeout=timeout,
    )


# --- Public API -------------------------------------------------------------

async def judge(
    *,
    provider: str,
    system_prompt: str,
    user_message: str,
    model_override: str | None = None,
    timeout: float = 60.0,
) -> tuple[dict, str, dict[str, int]]:
    """Returns (parsed_json, raw_text, usage). `usage` is a dict with
    int keys `input_tokens` and `output_tokens` — captured from the
    provider response and used by the runner to compute per-call $
    cost via the model_pricing table. Both fields default to 0 when
    the upstream omits usage info; cost falls through to 0 in that
    case (visible in run-level missing_pricing if the model also has
    no price row).

    Raises ProviderConfigError or ProviderError on upstream failure;
    raises ValueError if JSON parsing fails after the lenient fallback."""
    if provider not in AI_PROVIDERS:
        raise ProviderConfigError(f"unknown AI provider: {provider}")
    model = _resolve_model(provider, model_override)
    if provider == "gemini":
        text, usage = await _judge_gemini(
            system_prompt=system_prompt,
            user_message=user_message,
            model=model,
            timeout=timeout,
        )
    elif provider == "github_models":
        text, usage = await _judge_github_models(
            system_prompt=system_prompt,
            user_message=user_message,
            model=model,
            timeout=timeout,
        )
    elif provider == "openrouter":
        text, usage = await _judge_openrouter(
            system_prompt=system_prompt,
            user_message=user_message,
            model=model,
            timeout=timeout,
        )
    elif provider == "vertex_ai":
        text, usage = await _judge_vertex_ai(
            system_prompt=system_prompt,
            user_message=user_message,
            model=model,
            timeout=timeout,
        )
    else:
        raise ProviderConfigError(f"unhandled AI provider: {provider}")
    parsed = parse_json_response(text)
    return parsed, text, usage
