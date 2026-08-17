"""Settings router — credential CRUD, test-connection, rate-limit CRUD."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from ..app_settings import (
    AI_PROVIDERS_FOR_MODELS,
    DEFAULT_SCORING_CONFIG,
    DOMAIN_FILTER_CATEGORIES,
    PROVIDER_FIELDS,
    RATE_LIMIT_FIELDS,
    add_categories,
    add_known_models,
    all_ai_prompts,
    all_known_models,
    all_model_pricing,
    all_rate_limits,
    clear_provider_creds,
    delete_model_price,
    get_ai_prompt,
    get_categories,
    get_classify_context_config,
    get_domain_filter,
    get_known_models,
    get_language_mode,
    get_rate_limits,
    get_scoring_config,
    provider_status,
    reset_ai_prompt,
    reset_classify_context_config,
    reset_scoring_config,
    seed_pricing_for_known_models,
    set_ai_prompt,
    set_categories,
    set_classify_context_config,
    set_domain_filter,
    set_known_models,
    set_language_mode,
    set_provider_creds,
    set_rate_limits,
    set_scoring_config,
    upsert_model_price,
)
from ..app_settings import (
    DEFAULT_CLASSIFY_CONTEXT_CONFIG,
    _CLASSIFY_CONTEXT_ALLOWED_CRITERIA,
    _CLASSIFY_CONTEXT_ALLOWED_FIELDS,
)
from ..ai_prompts import PROMPT_KEYS
from ..providers import ProviderConfigError, ProviderError, get_provider

router = APIRouter(prefix="/settings", tags=["settings"])


# --- Credentials -------------------------------------------------------------

class ProviderCredsIn(BaseModel):
    api_key: str | None = None
    token: str | None = None
    default_model: str | None = None
    # Vertex AI (added 2026-05-19). `service_account_json` is the raw
    # JSON paste; `project_id` and `location` are the two required
    # plain-text fields that pair with it.
    service_account_json: str | None = None
    project_id: str | None = None
    location: str | None = None


@router.get("/")
def settings_root():
    """Whole-page payload — providers + rate limits + known-model registry
    + scoring config in one trip. Skips providers with no credential fields
    (wayback) from the providers list since there's nothing to configure;
    they still surface in the rate-limits table."""
    return {
        "providers": [
            provider_status(p)
            for p in PROVIDER_FIELDS.keys()
            if PROVIDER_FIELDS[p]
        ],
        "rate_limits": all_rate_limits(),
        "known_models": all_known_models(),
        "scoring": get_scoring_config(),
        # wayback_classify settings — language detection mode + the
        # predefined site categories used by the chained category
        # classification pass (added 2026-05-09).
        "wayback_classify": {
            "language_mode": get_language_mode(),
            "categories": get_categories(),
        },
        # Classify-context → Ahrefs judges (added 2026-05-13). Surfaced on
        # the bundled root so the Brain Settings tab renders without a
        # second round-trip.
        "classify_context": {
            "config": get_classify_context_config(),
            "defaults": DEFAULT_CLASSIFY_CONTEXT_CONFIG,
            "allowed_criteria": list(_CLASSIFY_CONTEXT_ALLOWED_CRITERIA),
            "allowed_fields": list(_CLASSIFY_CONTEXT_ALLOWED_FIELDS),
        },
        # Post-run Wayback auto-retry knobs (added 2026-05-17). Surfaced
        # here so the Wayback tab renders without a second fetch.
        "wayback_auto_retry": {
            "config": _wayback_auto_retry_for_root(),
            "defaults": _wayback_auto_retry_defaults_for_root(),
        },
        # Post-run Availability auto-retry knobs (added 2026-05-18).
        # Same shape as wayback_auto_retry plus a `retry_providers`
        # whitelist (default ["rdap"]) so paid Domainr calls don't
        # silently fire on a flaky burst run.
        "availability_auto_retry": {
            "config": _availability_auto_retry_for_root(),
            "defaults": _availability_auto_retry_defaults_for_root(),
            "allowed_providers": list(_AVAILABILITY_RETRY_PROVIDERS_TUP),
        },
    }


def _wayback_auto_retry_for_root() -> dict:
    """Inline helper kept here (rather than imported at module top) so
    `app_settings` isn't pulled into the import graph until /settings/
    is actually called. Matches the pattern other recent settings
    blocks use."""
    from ..app_settings import get_wayback_auto_retry_config
    return get_wayback_auto_retry_config()


def _wayback_auto_retry_defaults_for_root() -> dict:
    from ..app_settings import DEFAULT_WAYBACK_AUTO_RETRY
    return DEFAULT_WAYBACK_AUTO_RETRY


def _availability_auto_retry_for_root() -> dict:
    from ..app_settings import get_availability_auto_retry_config
    return get_availability_auto_retry_config()


def _availability_auto_retry_defaults_for_root() -> dict:
    from ..app_settings import DEFAULT_AVAILABILITY_AUTO_RETRY
    # Deep-copy the list field so a frontend mutation can't poison
    # the module-level default by reference.
    out = dict(DEFAULT_AVAILABILITY_AUTO_RETRY)
    out["retry_providers"] = list(DEFAULT_AVAILABILITY_AUTO_RETRY["retry_providers"])
    return out


# Imported here once so the /settings/ root + the typed endpoints below
# share the same list. Inline import inside `_root` would also work but
# this keeps the lookup constant-time.
from ..app_settings import _AVAILABILITY_RETRY_PROVIDERS as _AVAILABILITY_RETRY_PROVIDERS_TUP


@router.get("/providers")
def list_providers():
    return [provider_status(p) for p in PROVIDER_FIELDS.keys()]


@router.get("/providers/{provider}")
def get_provider_status_route(provider: str):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    return provider_status(provider)


@router.put("/providers/{provider}")
def update_provider_creds(provider: str, payload: ProviderCredsIn):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    raw = payload.model_dump(exclude_unset=True)
    valid = {k: v for k, v in raw.items() if k in PROVIDER_FIELDS[provider]}
    if not valid:
        raise HTTPException(
            400,
            f"no valid fields for {provider}; expected one of {PROVIDER_FIELDS[provider]}",
        )
    # Vertex AI: validate the service-account JSON shape on save so the
    # user sees a clear error here rather than at first-judge time. Empty
    # / None means "clear it" — only validate when there's actual content.
    if provider == "vertex_ai" and valid.get("service_account_json"):
        import json as _json
        try:
            parsed = _json.loads(valid["service_account_json"])
        except _json.JSONDecodeError as e:
            raise HTTPException(400, f"service_account_json is not valid JSON: {e}")
        if not isinstance(parsed, dict):
            raise HTTPException(400, "service_account_json must be a JSON object")
        missing = [k for k in ("type", "private_key", "client_email") if not parsed.get(k)]
        if missing:
            raise HTTPException(
                400,
                f"service_account_json missing required fields: {', '.join(missing)}",
            )
        if parsed.get("type") != "service_account":
            raise HTTPException(
                400,
                f"service_account_json: expected type='service_account', got {parsed.get('type')!r}",
            )
    set_provider_creds(provider, valid)
    return provider_status(provider)


@router.delete("/providers/{provider}")
def clear_provider_route(provider: str):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    clear_provider_creds(provider)
    return provider_status(provider)


# --- Known-models registry --------------------------------------------------

class KnownModelsIn(BaseModel):
    """Replace the entire list. Caller can dedup client-side; server also
    dedups defensively (case-sensitive)."""
    models: list[str]


class KnownModelsAddIn(BaseModel):
    """Merge entries into the existing list. Used for bulk paste + single
    add — callers split textarea content on newlines/commas client-side."""
    models: list[str]


@router.get("/providers/{provider}/models")
def list_known_models(provider: str):
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise HTTPException(404, "provider has no model registry")
    return {"provider": provider, "models": get_known_models(provider)}


@router.put("/providers/{provider}/models")
def replace_known_models(provider: str, payload: KnownModelsIn):
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise HTTPException(404, "provider has no model registry")
    cleaned = set_known_models(provider, payload.models)
    return {"provider": provider, "models": cleaned}


@router.post("/providers/{provider}/models")
def add_known_models_route(provider: str, payload: KnownModelsAddIn):
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise HTTPException(404, "provider has no model registry")
    merged = add_known_models(provider, payload.models)
    return {"provider": provider, "models": merged}


@router.post("/providers/{provider}/test")
async def test_provider(provider: str):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    try:
        async with get_provider(provider) as p:
            return await p.test_credentials()
    except ProviderConfigError as e:
        raise HTTPException(401, str(e))
    except ProviderError as e:
        raise HTTPException(502, str(e))


# --- Webshare rotating-proxy list -------------------------------------------

class WebshareConfigIn(BaseModel):
    # Full Webshare "Download Proxy List" URL (download token embedded).
    # None = leave unchanged; "" = clear. Write-only — never read back.
    proxy_list_url: str | None = Field(default=None)
    refresh_day_of_month: int | None = Field(default=None, ge=1, le=28)


def _webshare_status_payload() -> dict:
    from ..app_settings import get_webshare_refresh_day
    from ..availability import webshare
    st = webshare.status()
    st["refresh_day_of_month"] = get_webshare_refresh_day()
    return st


@router.get("/webshare")
def get_webshare_status():
    """Live status of the Webshare proxy source. Write-only by design:
    reports whether a URL is configured + the pool state (proxy count, last
    refresh, last error) but NEVER the URL itself (it embeds a secret token)."""
    return _webshare_status_payload()


@router.put("/webshare")
def update_webshare_config(payload: WebshareConfigIn, background_tasks: BackgroundTasks):
    """Save the Webshare URL and/or refresh day, and kick off a re-download.

    Deliberately a SYNC endpoint: `set_webshare_config` does blocking SQLite
    I/O, and on the single-worker api that must run in the threadpool — NOT
    on the event loop (an earlier async version wedged the whole api when the
    write stalled on the bind-mount DB). The list re-download is a background
    task so saving never blocks on the network fetch either; poll
    GET /settings/webshare or hit POST .../refresh to see the proxy count."""
    from ..app_settings import set_webshare_config, get_webshare_refresh_day
    from ..availability import webshare
    set_webshare_config(payload.proxy_list_url, payload.refresh_day_of_month)
    if payload.refresh_day_of_month is not None:
        # Re-point the monthly cron (same id + replace_existing swaps the
        # trigger on the already-running scheduler).
        try:
            from ..scheduler import get_scheduler
            get_scheduler().add_job(
                webshare.scheduled_refresh, "cron",
                day=get_webshare_refresh_day(), hour=12, minute=0,
                id="webshare_proxy_refresh", replace_existing=True,
            )
        except Exception:  # noqa: BLE001
            pass
    # Re-download in the background so a URL save (or clear) reflects in the
    # pool shortly without holding the request open on the network fetch.
    background_tasks.add_task(webshare.scheduled_refresh)
    return _webshare_status_payload()


@router.post("/webshare/refresh")
async def refresh_webshare_now():
    """Manual 'Refresh now' — force an immediate re-download of the list."""
    from ..availability import webshare
    return await webshare.refresh()


# --- Wayback residential-proxy pool -----------------------------------------
# Mirrors the Webshare endpoints above but is a SEPARATE source: archive.org
# tarpits datacenter ranges, so this list must point at a residential/ISP plan.
# See wayback_proxies.py for why they can't share a pool.

class WaybackProxiesConfigIn(BaseModel):
    # None = leave unchanged. Lets the UI PATCH a single toggle without having
    # to round-trip the write-only URL.
    enabled: bool | None = Field(default=None)
    # Residential proxy-list download URL (token embedded).
    # None = unchanged; "" = clear. Write-only — never read back.
    proxy_list_url: str | None = Field(default=None)
    use_v1: bool | None = Field(default=None)
    use_v2: bool | None = Field(default=None)
    use_retry: bool | None = Field(default=None)
    refresh_day_of_month: int | None = Field(default=None, ge=1, le=28)


@router.get("/wayback-proxies")
def get_wayback_proxies_status():
    """Live status of the Wayback residential pool. Write-only by design:
    reports the toggles + pool health (total / available / cooling-down, last
    refresh, last error) but NEVER the URL itself."""
    from .. import wayback_proxies
    return wayback_proxies.status()


@router.put("/wayback-proxies")
def update_wayback_proxies_config(
    payload: WaybackProxiesConfigIn, background_tasks: BackgroundTasks,
):
    """Save the toggles and/or URL, then re-download in the background.

    SYNC for the same reason as the Webshare endpoint: `set_*_config` does
    blocking SQLite I/O, which must stay off the event loop on the
    single-worker api."""
    from ..app_settings import (
        set_wayback_proxies_config, get_wayback_proxies_config,
    )
    from .. import wayback_proxies
    set_wayback_proxies_config(
        enabled=payload.enabled,
        proxy_list_url=payload.proxy_list_url,
        use_v1=payload.use_v1,
        use_v2=payload.use_v2,
        use_retry=payload.use_retry,
        refresh_day_of_month=payload.refresh_day_of_month,
    )
    if payload.refresh_day_of_month is not None:
        try:
            from ..scheduler import get_scheduler
            get_scheduler().add_job(
                wayback_proxies.scheduled_refresh, "cron",
                day=get_wayback_proxies_config()["refresh_day_of_month"],
                hour=12, minute=0,
                id="wayback_proxy_refresh", replace_existing=True,
            )
        except Exception:  # noqa: BLE001
            pass
    background_tasks.add_task(wayback_proxies.scheduled_refresh)
    return wayback_proxies.status()


@router.post("/wayback-proxies/refresh")
async def refresh_wayback_proxies_now():
    """Manual 'Refresh now' — force an immediate re-download of the list."""
    from .. import wayback_proxies
    return await wayback_proxies.refresh()


# --- Rate limits -------------------------------------------------------------

class RateLimitsIn(BaseModel):
    rpm: int | None = Field(default=None, ge=1, le=10000)
    max_concurrent: int | None = Field(default=None, ge=1, le=1000)
    retry_max: int | None = Field(default=None, ge=0, le=20)


@router.get("/rate-limits")
def list_rate_limits():
    return all_rate_limits()


@router.get("/rate-limits/{provider}")
def get_rate_limits_route(provider: str):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    return get_rate_limits(provider)


@router.put("/rate-limits/{provider}")
def update_rate_limits(provider: str, payload: RateLimitsIn):
    if provider not in PROVIDER_FIELDS:
        raise HTTPException(404, "unknown provider")
    raw = payload.model_dump(exclude_unset=True)
    valid = {k: v for k, v in raw.items() if k in RATE_LIMIT_FIELDS and v is not None}
    if not valid:
        raise HTTPException(400, "no rate-limit fields to update")
    set_rate_limits(provider, valid)
    return get_rate_limits(provider)


# --- AI prompts -------------------------------------------------------------

class PromptUpdateIn(BaseModel):
    value: str


@router.get("/prompts")
def list_prompts():
    return all_ai_prompts()


@router.get("/prompts/{key}")
def get_prompt_route(key: str):
    if key not in PROMPT_KEYS:
        raise HTTPException(404, "unknown prompt key")
    return {
        "key": key,
        "value": get_ai_prompt(key),
        "default": PROMPT_KEYS[key],
    }


@router.put("/prompts/{key}")
def update_prompt(key: str, payload: PromptUpdateIn):
    if key not in PROMPT_KEYS:
        raise HTTPException(404, "unknown prompt key")
    try:
        set_ai_prompt(key, payload.value)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"key": key, "value": get_ai_prompt(key), "is_custom": True}


@router.delete("/prompts/{key}")
def reset_prompt_route(key: str):
    """Reset to the shipped default — clears the override row."""
    if key not in PROMPT_KEYS:
        raise HTTPException(404, "unknown prompt key")
    reset_ai_prompt(key)
    return {"key": key, "value": PROMPT_KEYS[key], "is_custom": False}


# --- Scoring config (final-score weights + thresholds) --------------------

class ScoringWeightsIn(BaseModel):
    backlinks: float | None = Field(default=None, ge=0, le=1)
    refdomains: float | None = Field(default=None, ge=0, le=1)
    anchors: float | None = Field(default=None, ge=0, le=1)
    keywords: float | None = Field(default=None, ge=0, le=1)


class ScoringConfigIn(BaseModel):
    weights: ScoringWeightsIn | None = None
    good_threshold: float | None = Field(default=None, ge=0, le=100)
    mixed_threshold: float | None = Field(default=None, ge=0, le=100)
    low_confidence_threshold: float | None = Field(default=None, ge=0, le=1)


@router.get("/scoring")
def get_scoring_route():
    """Returns the effective scoring config plus the shipped defaults so
    the UI can render a Reset button."""
    return {
        "config": get_scoring_config(),
        "defaults": DEFAULT_SCORING_CONFIG,
    }


# --- Wayback auto-retry config ---------------------------------------------
# Controls the post-run watcher that reruns /retry-failed against wayback
# (and chained wayback_classify) failures on a backoff schedule. See
# app_settings.get_wayback_auto_retry_config for the field semantics and
# the safety caps.

class WaybackAutoRetryIn(BaseModel):
    enabled: bool | None = None
    max_attempts: int | None = Field(default=None, ge=0)
    initial_delay_sec: int | None = Field(default=None, ge=0)
    backoff_multiplier: float | None = Field(default=None, ge=1.0)


@router.get("/wayback-auto-retry")
def get_wayback_auto_retry_route():
    from ..app_settings import (
        DEFAULT_WAYBACK_AUTO_RETRY,
        get_wayback_auto_retry_config,
    )
    return {
        "config": get_wayback_auto_retry_config(),
        "defaults": DEFAULT_WAYBACK_AUTO_RETRY,
    }


@router.put("/wayback-auto-retry")
def update_wayback_auto_retry_route(payload: WaybackAutoRetryIn):
    from ..app_settings import (
        DEFAULT_WAYBACK_AUTO_RETRY,
        set_wayback_auto_retry_config,
    )
    raw = payload.model_dump(exclude_unset=True)
    raw = {k: v for k, v in raw.items() if v is not None}
    try:
        new_cfg = set_wayback_auto_retry_config(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"config": new_cfg, "defaults": DEFAULT_WAYBACK_AUTO_RETRY}


# --- Availability auto-retry config ----------------------------------------
# Sibling of the Wayback editor above. Adds `retry_providers` — a
# whitelist of cascade providers whose terminal failure makes an RD
# eligible for auto-retry. Default ["rdap"] keeps the feature auto-on
# without firing paid Domainr / slow WHOIS calls behind the user's back.

class AvailabilityAutoRetryIn(BaseModel):
    enabled: bool | None = None
    max_attempts: int | None = Field(default=None, ge=0)
    initial_delay_sec: int | None = Field(default=None, ge=0)
    backoff_multiplier: float | None = Field(default=None, ge=1.0)
    # Optional whitelist override. Empty list is valid — it means "only
    # auto-retry cascade-crashed (CR.status='failed') rows; skip every
    # done+error row" — a legitimate "safest retries only" state.
    retry_providers: list[str] | None = None


@router.get("/availability-auto-retry")
def get_availability_auto_retry_route():
    from ..app_settings import (
        DEFAULT_AVAILABILITY_AUTO_RETRY,
        get_availability_auto_retry_config,
    )
    out_defaults = dict(DEFAULT_AVAILABILITY_AUTO_RETRY)
    out_defaults["retry_providers"] = list(
        DEFAULT_AVAILABILITY_AUTO_RETRY["retry_providers"],
    )
    return {
        "config": get_availability_auto_retry_config(),
        "defaults": out_defaults,
        "allowed_providers": list(_AVAILABILITY_RETRY_PROVIDERS_TUP),
    }


@router.put("/availability-auto-retry")
def update_availability_auto_retry_route(payload: AvailabilityAutoRetryIn):
    from ..app_settings import (
        DEFAULT_AVAILABILITY_AUTO_RETRY,
        set_availability_auto_retry_config,
    )
    raw = payload.model_dump(exclude_unset=True)
    # Strip Nones but PRESERVE empty lists — retry_providers=[] is a
    # meaningful "skip every done+error row" state, distinct from
    # "field absent" (no change to retry_providers).
    raw = {k: v for k, v in raw.items() if v is not None}
    try:
        new_cfg = set_availability_auto_retry_config(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    out_defaults = dict(DEFAULT_AVAILABILITY_AUTO_RETRY)
    out_defaults["retry_providers"] = list(
        DEFAULT_AVAILABILITY_AUTO_RETRY["retry_providers"],
    )
    return {
        "config": new_cfg,
        "defaults": out_defaults,
        "allowed_providers": list(_AVAILABILITY_RETRY_PROVIDERS_TUP),
    }


# --- SERP Overview settings (added 2026-07-10) ------------------------------
# One knob today: the dedup window — how many days a completed
# (keyword, country, top_positions) check suppresses re-checking the same
# triple at submit time on the SERP Overview tool.

class SerpOverviewSettingsIn(BaseModel):
    dedup_window_days: int = Field(ge=1, le=3650)


@router.get("/serp-overview")
def get_serp_overview_settings_route():
    from ..app_settings import (
        DEFAULT_SERP_DEDUP_WINDOW_DAYS,
        get_serp_dedup_window_days,
    )
    return {
        "dedup_window_days": get_serp_dedup_window_days(),
        "default_days": DEFAULT_SERP_DEDUP_WINDOW_DAYS,
    }


@router.put("/serp-overview")
def update_serp_overview_settings_route(payload: SerpOverviewSettingsIn):
    from ..app_settings import (
        DEFAULT_SERP_DEDUP_WINDOW_DAYS,
        set_serp_dedup_window_days,
    )
    try:
        v = set_serp_dedup_window_days(payload.dedup_window_days)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "dedup_window_days": v,
        "default_days": DEFAULT_SERP_DEDUP_WINDOW_DAYS,
    }


# --- Allowed TLDs (added 2026-07-10) ----------------------------------------
# Shared allowlist consumed by the Linked Domains fetch filter and the
# SERP Overview domains exports. Default = the DSF openly-registrable list.

class AllowedTldsIn(BaseModel):
    # Full replacement list. `reset=True` (or an empty list) restores the
    # built-in default.
    tlds: list[str] | None = None
    reset: bool = False


@router.get("/allowed-tlds")
def get_allowed_tlds_route():
    from ..allowed_tlds import DEFAULT_ALLOWED_TLDS
    from ..app_settings import get_allowed_tlds
    tlds = get_allowed_tlds()
    return {
        "tlds": tlds,
        "count": len(tlds),
        "default_count": len(DEFAULT_ALLOWED_TLDS),
    }


@router.put("/allowed-tlds")
def update_allowed_tlds_route(payload: AllowedTldsIn):
    from ..allowed_tlds import DEFAULT_ALLOWED_TLDS
    from ..app_settings import set_allowed_tlds
    try:
        tlds = set_allowed_tlds(None if payload.reset else payload.tlds)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "tlds": tlds,
        "count": len(tlds),
        "default_count": len(DEFAULT_ALLOWED_TLDS),
    }


@router.put("/scoring")
def update_scoring_route(payload: ScoringConfigIn):
    raw = payload.model_dump(exclude_unset=True)
    # Strip Nones that crept in from `exclude_unset=False` paths inside the
    # nested model — Pydantic includes them when only some weights are set.
    weights = raw.get("weights")
    if isinstance(weights, dict):
        weights = {k: v for k, v in weights.items() if v is not None}
        if weights:
            raw["weights"] = weights
        else:
            raw.pop("weights", None)
    try:
        new_cfg = set_scoring_config(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"config": new_cfg, "defaults": DEFAULT_SCORING_CONFIG}


# --- Model pricing ----------------------------------------------------------

class ModelPriceIn(BaseModel):
    input_per_million: float = Field(ge=0)
    output_per_million: float = Field(ge=0)


@router.get("/pricing")
def list_pricing_route():
    """Return all per-(provider, model) price rows. Auto-seeds empty
    rows for any registered model that doesn't have one yet, so the UI
    table is populated the first time the user opens it. Idempotent —
    re-opening the page after adding a new model registers the new row
    automatically."""
    seeded = seed_pricing_for_known_models()
    return {
        "rows": all_model_pricing(),
        "seeded": seeded,
    }


@router.put("/pricing/{provider}/{model:path}")
def upsert_pricing_route(provider: str, model: str, payload: ModelPriceIn):
    """Insert or update one (provider, model) price row. `model` is path-
    matched (with `:path` converter) so model names with slashes — common
    in OpenRouter (`anthropic/claude-3.5-haiku`) — work without URL-
    encoding."""
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise HTTPException(400, f"unknown provider: {provider}")
    try:
        upsert_model_price(
            provider, model,
            payload.input_per_million,
            payload.output_per_million,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"provider": provider, "model": model, **payload.model_dump()}


@router.delete("/pricing/{provider}/{model:path}")
def delete_pricing_route(provider: str, model: str):
    """Remove a (provider, model) price row. Future AI calls for this
    pair will record `ai_cost_usd = 0` and surface the model name in
    the run's `missing_pricing` list until you add it back."""
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise HTTPException(400, f"unknown provider: {provider}")
    if not delete_model_price(provider, model):
        raise HTTPException(404, "pricing row not found")
    return {"deleted": {"provider": provider, "model": model}}


@router.delete("/scoring")
def reset_scoring_route():
    return {
        "config": reset_scoring_config(),
        "defaults": DEFAULT_SCORING_CONFIG,
    }


# --- Classify context → Ahrefs judges --------------------------------------
# Per-Settings toggle for passing wayback_classify outputs (theme, category,
# language, ...) into the B/A/K judges' user messages. See app_settings.py
# for the storage shape + default rationale (refdomains OFF by default
# because no anchors/snippets = hallucination risk).

class ClassifyContextConfigIn(BaseModel):
    enabled: bool | None = None
    criteria: list[str] | None = None
    fields: list[str] | None = None


def _classify_context_envelope() -> dict:
    return {
        "config": get_classify_context_config(),
        "defaults": DEFAULT_CLASSIFY_CONTEXT_CONFIG,
        "allowed_criteria": list(_CLASSIFY_CONTEXT_ALLOWED_CRITERIA),
        "allowed_fields": list(_CLASSIFY_CONTEXT_ALLOWED_FIELDS),
    }


@router.get("/classify-context")
def get_classify_context_route():
    return _classify_context_envelope()


@router.put("/classify-context")
def update_classify_context_route(payload: ClassifyContextConfigIn):
    raw = payload.model_dump(exclude_unset=True)
    try:
        set_classify_context_config(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _classify_context_envelope()


@router.delete("/classify-context")
def reset_classify_context_route():
    reset_classify_context_config()
    return _classify_context_envelope()


# --- Wayback classification settings ---------------------------------------
# Two surfaces: language_mode (ai|library) and the predefined categories
# list ({name, description?}). Categories are auto-sorted alphabetical by
# the backend on every read/write.

class LanguageModeIn(BaseModel):
    mode: str  # "ai" or "library"


@router.get("/wayback-classify/language-mode")
def get_language_mode_route():
    return {"mode": get_language_mode()}


@router.put("/wayback-classify/language-mode")
def set_language_mode_route(payload: LanguageModeIn):
    try:
        mode = set_language_mode(payload.mode)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"mode": mode}


class CategoryIn(BaseModel):
    name: str
    description: str | None = None


class CategoriesIn(BaseModel):
    items: list[CategoryIn]


@router.get("/wayback-classify/categories")
def list_categories_route():
    return {"categories": get_categories()}


@router.put("/wayback-classify/categories")
def replace_categories_route(payload: CategoriesIn):
    cleaned = set_categories([i.model_dump() for i in payload.items])
    return {"categories": cleaned}


@router.post("/wayback-classify/categories")
def add_categories_route(payload: CategoriesIn):
    """Bulk-merge: existing categories with the same (case-insensitive)
    name are kept; new descriptions only fill blank existing ones. Used
    by the Settings bulk-paste UI."""
    merged = add_categories([i.model_dump() for i in payload.items])
    return {"categories": merged}


# --- Domain Filter (added 2026-06-07) -------------------------------------
# User-managed exclusion list applied at /backlog/import. Schema is a
# dict of category -> list[str] so future categories (spam-keywords,
# banned-substrings, …) ship by extending DOMAIN_FILTER_CATEGORIES in
# app_settings — no router / migration changes needed.

class DomainFilterIn(BaseModel):
    # `state` is the whole dict the user wants persisted. Keys not in
    # DOMAIN_FILTER_CATEGORIES are silently dropped server-side, so a
    # stale category from an older frontend can't pollute the store.
    state: dict[str, list[str]]


@router.get("/domain-filter")
def get_domain_filter_route():
    """Return current filter state + the list of recognised categories.
    The categories array drives the Settings UI section ordering; the
    frontend doesn't have to keep a duplicate list in sync."""
    return {
        "state": get_domain_filter(),
        "categories": list(DOMAIN_FILTER_CATEGORIES),
    }


@router.put("/domain-filter")
def set_domain_filter_route(payload: DomainFilterIn):
    try:
        cleaned = set_domain_filter(payload.state)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "state": cleaned,
        "categories": list(DOMAIN_FILTER_CATEGORIES),
    }


# --- Availability cascade settings (added 2026-05-12) ---------------------

class AvailabilitySettingIn(BaseModel):
    key: str
    value: str


@router.get("/availability")
def get_availability_settings():
    from ..app_settings import get_availability_config
    return get_availability_config()


@router.put("/availability")
def set_availability_setting_route(payload: AvailabilitySettingIn):
    from ..app_settings import set_availability_setting
    try:
        set_availability_setting(payload.key, payload.value)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"updated": payload.key}


# --- DB maintenance (VACUUM) ----------------------------------------------


class VacuumToggleIn(BaseModel):
    enabled: bool


@router.get("/db-maintenance")
def get_db_maintenance_settings():
    from ..app_settings import get_vacuum_enabled
    return {"vacuum_enabled": get_vacuum_enabled()}


@router.put("/db-maintenance/vacuum-enabled")
def set_vacuum_enabled_route(payload: VacuumToggleIn):
    from ..app_settings import set_vacuum_enabled
    return {"vacuum_enabled": set_vacuum_enabled(payload.enabled)}


@router.post("/db-maintenance/vacuum-now")
def run_vacuum_now():
    """Manual one-shot VACUUM trigger. Honors the same disk + lock
    guards as the scheduled cron — won't run if a backup is in flight
    or disk is tight. Returns the result dict so the UI can surface
    bytes reclaimed / skip reason."""
    from ..db_maintenance import try_vacuum
    return try_vacuum()


# --- Whois History pillar settings (added Wave 2, 2026-05-15) -------------


class WhoisHistorySettingIn(BaseModel):
    key: str
    value: str


class WhoisHistoryApiKeyIn(BaseModel):
    api_key: str


@router.get("/whois-history")
def get_whois_history_settings_route():
    """Bundle: provider + api_key_set flag + numeric knobs. The actual
    api_key value is NEVER returned (Fernet-encrypted at rest and
    operator-only)."""
    from ..app_settings import get_whois_history_config
    return get_whois_history_config()


@router.put("/whois-history")
def set_whois_history_setting_route(payload: WhoisHistorySettingIn):
    """Per-knob update for non-secret settings (provider / max_records /
    coverage_gap_threshold_days / drop_confidence_threshold). API key
    has its own dedicated endpoint below because the secret-write path
    must never leak the key value through validation error messages."""
    from ..app_settings import set_whois_history_setting
    try:
        set_whois_history_setting(payload.key, payload.value)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"updated": payload.key}


@router.put("/whois-history/api-key")
def set_whois_history_api_key_route(payload: WhoisHistoryApiKeyIn):
    """Persist or clear the API key for the currently-configured
    provider. Empty string clears. Encrypted at rest via the
    `__api_key`-suffix rule in `crypto.key_is_secret`."""
    from ..app_settings import set_whois_history_api_key
    set_whois_history_api_key(payload.api_key)
    return {"ok": True, "api_key_set": bool(payload.api_key)}


class WhoisHistoryRateLimitsIn(BaseModel):
    """Both fields optional — patch semantics. The frontend usually
    sends both at once but a single-field write works the same way."""
    rpm: int | None = None
    max_concurrent: int | None = None


@router.put("/whois-history/rate-limits")
def set_whois_history_rate_limits_route(payload: WhoisHistoryRateLimitsIn):
    """Update RPM + max_concurrent for the currently-configured
    WHOIS provider. Stored under `<provider>__rpm` /
    `<provider>__max_concurrent` keys; the limits middleware picks the
    new values up on the next acquire (no restart needed thanks to the
    cache invalidation in `limits.get_limiter`)."""
    from ..app_settings import get_whois_history_provider, set_rate_limits
    values: dict[str, int] = {}
    if payload.rpm is not None:
        values["rpm"] = payload.rpm
    if payload.max_concurrent is not None:
        values["max_concurrent"] = payload.max_concurrent
    if not values:
        raise HTTPException(400, "no rate-limit fields provided")
    try:
        set_rate_limits(get_whois_history_provider(), values)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"updated": list(values.keys())}


class WhoisHistoryTestIn(BaseModel):
    # Domain to probe with. Defaults to a well-known long-lived one
    # so a sane test still works when the operator just clicks Test
    # with no domain in mind. `example.com` is reserved by IANA, has
    # decades of WHOIS history, and won't burn meaningful quota on
    # any reasonable provider.
    domain: str = "example.com"


@router.post("/whois-history/test")
async def test_whois_history_route(
    payload: WhoisHistoryTestIn | None = None,
):
    """Live probe — fetch a single domain's history through the
    configured provider + API key, return a tiny diagnostic envelope.
    Costs the operator 1 provider request (a few cents on WhoisFreaks).

    Designed so the UI can render three outcomes:
      • ok=true, records_found > 0 → green: "working, found N records"
      • ok=true, records_found = 0 → amber: "auth fine, no history
        for this domain — try a different one"
      • ok=false              → rose:  error message verbatim

    We don't write anything to the DB on test — no CriterionResult,
    no Run, no availability_checks row. Pure read-through to surface
    config issues before the operator burns credits on a real job."""
    domain = (
        (payload.domain if payload else "example.com") or "example.com"
    ).strip().lower()
    if not domain or "." not in domain:
        raise HTTPException(400, "domain must include a TLD (e.g. example.com)")

    # Imports inside the handler — the whois_history module pulls in
    # httpx which is already loaded, but keep the import lazy so the
    # base settings router doesn't tug on an extra subtree at import
    # time. Also defends against circulars during boot ordering tweaks.
    from ..whois_history.base import WhoisProviderError
    from ..whois_history.fetcher import fetch_history

    try:
        result = await fetch_history(domain)
    except WhoisProviderError as e:
        return {
            "ok": False,
            "error": str(e),
            "domain": domain,
        }
    except Exception as e:  # noqa: BLE001
        # Anything else (timeout, JSON parse, etc.) — surface the
        # class name so the operator can grep logs if needed, but
        # don't 500 the test endpoint itself.
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "domain": domain,
        }

    return {
        "ok": True,
        "domain": domain,
        "provider": result.provider,
        "records_found": result.snapshot_count,
        # Tiny sample so the UI can show "yes, this is real data" —
        # pick the latest record's most-useful fields. Skip raw_text
        # / extras to keep the response tiny.
        "latest_record_preview": (
            {
                "query_time": result.records[-1].get("query_time"),
                "creation_date": result.records[-1].get("creation_date"),
                "expiry_date": result.records[-1].get("expiry_date"),
                "registrar_name": result.records[-1].get("registrar_name"),
                "registrant_country": (
                    result.records[-1].get("registrant_country")
                ),
                "domain_status": result.records[-1].get("domain_status"),
            }
            if result.records else None
        ),
    }
