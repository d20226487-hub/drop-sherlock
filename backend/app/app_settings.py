"""Runtime-mutable settings stored in the DB. Pattern mirrors SERP Monitor:
flat key/value rows in `app_settings`, masked status output that never echoes
secrets back to the UI. DB value beats env value at runtime — the env var is
just the bootstrap fallback for fresh installs."""
from __future__ import annotations

import json
import threading
import time

from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal
from .models import AppSetting


# --- TTL cache for hot-path getters (added 2026-05-10) -------------------
# `get_ai_prompt`, `get_provider_creds`, `get_rate_limits` etc. all bottom
# out in `_get(db, key)`. The runner calls them in tight per-criterion
# loops — a 100-domain × 5-criterion run was opening 500+ throwaway DB
# sessions just to read the same handful of rows. TTL cache lets those
# stay in-memory between calls; explicit invalidation on `_set` keeps
# the user's Settings edits visible immediately, and the TTL bounds
# divergence in the worst case (e.g. a write that bypasses _set).
_CACHE_TTL_SEC = 30.0
_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, str | None]] = {}


def _cache_get(key: str) -> tuple[bool, str | None]:
    """Returns (hit, value). hit=False means caller should query the DB."""
    with _cache_lock:
        entry = _cache.get(key)
    if entry is None:
        return False, None
    expires_at, value = entry
    if time.monotonic() >= expires_at:
        return False, None
    return True, value


def _cache_put(key: str, value: str | None) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic() + _CACHE_TTL_SEC, value)


def _cache_invalidate(key: str) -> None:
    with _cache_lock:
        _cache.pop(key, None)


def _cache_clear() -> None:
    """Drop the entire cache. Used by tests; not called in production."""
    with _cache_lock:
        _cache.clear()


# --- Provider field schema ---------------------------------------------------

# Each provider stores 1+ credential fields plus, for AI providers, an
# optional default model used during test-connection and pre-filling the
# Analyze page.
PROVIDER_FIELDS: dict[str, list[str]] = {
    "ahrefs": ["api_key"],
    "gemini": ["api_key", "default_model"],
    "github_models": ["token", "default_model"],
    "openrouter": ["api_key", "default_model"],
    # Vertex AI (added 2026-05-19). Auto-detects mode at call time:
    # if `service_account_json` is set → enterprise mode (mints OAuth2
    # token, calls `{location}-aiplatform.googleapis.com` against the
    # project), else if `api_key` is set → Vertex Express mode. Both
    # are masked on read.
    "vertex_ai": [
        "api_key",
        "service_account_json",
        "project_id",
        "location",
        "default_model",
    ],
    # Wayback CDX needs no creds — but surface it here so rate-limits and
    # status reporting flow through the same paths. Empty field list ⇒
    # status row shows "no fields", no test-credentials button.
    "wayback": [],
}

# Field name → DB key. Flat namespace prefixed by provider name keeps the
# `app_settings` table simple to inspect by hand.
def _key(provider: str, field: str) -> str:
    return f"{provider}__{field}"


# Env-var fallback per (provider, field). Only populated for credentials we
# accept from the env at boot — see config.py.
_ENV_FALLBACK: dict[tuple[str, str], str] = {
    ("ahrefs", "api_key"): settings.ahrefs_api_key,
    ("gemini", "api_key"): settings.gemini_api_key,
    ("github_models", "token"): settings.github_models_token,
    ("openrouter", "api_key"): settings.openrouter_api_key,
}


# Fields that are secrets and must be masked (last4 + length only) in any
# response that goes to the browser. Non-secret fields (like `default_model`)
# are echoed back in full.
SECRET_FIELDS = {"api_key", "token", "password", "service_account_json"}


# --- Low-level get/set --------------------------------------------------------

def _get(db: Session, key: str) -> str | None:
    """DB read with TTL cache in front. Cache hit short-circuits the
    SQLAlchemy query — important on the runner's per-criterion loops
    where this is called dozens of times per domain.

    Transparently decrypts Fernet-encrypted values (the cache stores
    decrypted form, so we pay the AES cost only on the cache miss).
    Legacy plaintext values pass through unchanged — the startup
    migration encrypts them lazily on the next write."""
    from . import crypto
    hit, cached = _cache_get(key)
    if hit:
        return cached
    row = db.get(AppSetting, key)
    value = row.value if row else None
    if value and crypto.is_encrypted(value):
        value = crypto.decrypt(value)
    _cache_put(key, value)
    return value


def _set(db: Session, key: str, value: str | None) -> None:
    """Write a setting. Secrets (api keys, tokens, S3 creds — see
    `crypto.key_is_secret`) are encrypted before persisting so the
    raw `app_settings.value` column never holds them in plaintext.
    Empty strings stay empty (no useful protection to apply, and
    encrypting "" would make it look "set" to consumers)."""
    from . import crypto
    to_store = value or ""
    if to_store and crypto.key_is_secret(key):
        to_store = crypto.encrypt(to_store)
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=to_store)
        db.add(row)
    else:
        row.value = to_store
    db.commit()
    # Drop the cached value so the next read sees the fresh write
    # immediately, regardless of TTL.
    _cache_invalidate(key)


# --- Public API: credentials --------------------------------------------------

def get_provider_creds(provider: str) -> dict[str, str]:
    """Effective values per field for a provider. DB wins; env is the
    fallback ONLY for credential fields explicitly listed in `_ENV_FALLBACK`."""
    fields = PROVIDER_FIELDS.get(provider, [])
    out: dict[str, str] = {}
    db = SessionLocal()
    try:
        for f in fields:
            val = _get(db, _key(provider, f))
            if not val:
                val = _ENV_FALLBACK.get((provider, f), "") or ""
            if val:
                out[f] = val
    finally:
        db.close()
    return out


def set_provider_creds(provider: str, values: dict[str, str | None]) -> None:
    fields = PROVIDER_FIELDS.get(provider)
    if not fields:
        raise ValueError(f"unknown provider: {provider}")
    db = SessionLocal()
    try:
        for f in fields:
            if f in values:
                v = values[f]
                cleaned = v.strip() if isinstance(v, str) and v.strip() else None
                _set(db, _key(provider, f), cleaned)
    finally:
        db.close()


def clear_provider_creds(provider: str) -> None:
    set_provider_creds(provider, {f: None for f in PROVIDER_FIELDS.get(provider, [])})


def provider_status(provider: str) -> dict:
    """Masked status — never echo full secrets back to the UI."""
    fields = PROVIDER_FIELDS.get(provider, [])
    creds = get_provider_creds(provider)
    masked: dict[str, dict] = {}
    for f in fields:
        v = creds.get(f, "")
        if not v:
            masked[f] = {"configured": False}
        elif f in SECRET_FIELDS:
            masked[f] = {"configured": True, "last4": v[-4:], "length": len(v)}
        else:
            masked[f] = {"configured": True, "value": v}
    return {"provider": provider, "fields": masked}


# --- Known-models registry ---------------------------------------------------
#
# Per-AI-provider list of model IDs the user has saved. Powers dropdowns
# everywhere a model is picked (Settings default_model, Analyze AI selector,
# Reanalyze pickers on run/domain/Database). Stored as a JSON array under
# `known_models__<provider>` — Ahrefs is excluded (no model concept).

AI_PROVIDERS_FOR_MODELS = ("gemini", "github_models", "openrouter", "vertex_ai")


def _models_key(provider: str) -> str:
    return f"known_models__{provider}"


def get_known_models(provider: str) -> list[str]:
    """Returns the saved list, plus the current `default_model` if it isn't
    in the list (so freshly-typed defaults from before this feature shipped
    still appear). Order is preserved as the user added them."""
    if provider not in AI_PROVIDERS_FOR_MODELS:
        return []
    db = SessionLocal()
    try:
        raw = _get(db, _models_key(provider)) or ""
        try:
            arr = json.loads(raw) if raw else []
        except json.JSONDecodeError:
            arr = []
        if not isinstance(arr, list):
            arr = []
        models: list[str] = [str(m).strip() for m in arr if str(m).strip()]
        # Backfill: surface the legacy default_model if it isn't tracked
        # yet — keeps the user from "losing" their default after enabling
        # this feature.
        default_val = (_get(db, _key(provider, "default_model")) or "").strip()
        if default_val and default_val not in models:
            models.append(default_val)
    finally:
        db.close()
    return models


def set_known_models(provider: str, models: list[str]) -> list[str]:
    """Replace the known-models list. Caller is responsible for dedup +
    trimming. Returns the cleaned list as persisted."""
    if provider not in AI_PROVIDERS_FOR_MODELS:
        raise ValueError(f"provider has no model registry: {provider}")
    cleaned: list[str] = []
    seen: set[str] = set()
    for m in models:
        s = str(m).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
    db = SessionLocal()
    try:
        _set(db, _models_key(provider), json.dumps(cleaned))
        # If the current default_model is no longer in the list, fall back
        # to the first remaining model (per the locked decision: "delete
        # the default → first remaining wins"). Empty list → clear default.
        current_default = (_get(db, _key(provider, "default_model")) or "").strip()
        if current_default and current_default not in seen:
            new_default = cleaned[0] if cleaned else None
            _set(db, _key(provider, "default_model"), new_default)
    finally:
        db.close()
    return cleaned


def add_known_models(provider: str, models: list[str]) -> list[str]:
    """Merge new entries into the existing list (dedup, preserve order).
    Used by both bulk-paste and single-add flows on the frontend."""
    existing = get_known_models(provider)
    seen = set(existing)
    merged = list(existing)
    for m in models:
        s = str(m).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        merged.append(s)
    return set_known_models(provider, merged)


def all_known_models() -> dict[str, list[str]]:
    return {p: get_known_models(p) for p in AI_PROVIDERS_FOR_MODELS}


# --- Public API: rate limits --------------------------------------------------

# Each provider gets the same three knobs. Defaults come from config.py for
# Ahrefs and from sensible AI-friendly numbers for the rest.
RATE_LIMIT_FIELDS = ("rpm", "max_concurrent", "retry_max")

_RATE_LIMIT_DEFAULTS: dict[str, dict[str, int]] = {
    "ahrefs": {
        "rpm": settings.ahrefs_rpm,
        "max_concurrent": settings.ahrefs_max_concurrent_domains,
        "retry_max": settings.ahrefs_retry_max,
    },
    "gemini": {"rpm": 60, "max_concurrent": 4, "retry_max": 3},
    "github_models": {"rpm": 30, "max_concurrent": 2, "retry_max": 3},
    "openrouter": {"rpm": 60, "max_concurrent": 4, "retry_max": 3},
    # Vertex AI (added 2026-05-19). Same shape as Gemini — Vertex's
    # per-region quota is generous on enterprise projects; user can
    # tune down if their GCP project has stricter limits.
    "vertex_ai": {"rpm": 60, "max_concurrent": 4, "retry_max": 3},
    # Wayback throttles aggressively if you fan out — it's a free
    # community service, not a paid quota. `max_concurrent=1` (single-
    # flight) added 2026-05-07 after a 35-domain batch cascaded into
    # 31/35 ConnectTimeouts: even with RPM 30, two concurrent slots
    # piled heavy `match_type=domain` queries onto an already-throttling
    # backend, and each retry made it worse. With concurrent=1 + RPM=30
    # plus the burst-cooldown gate in `providers/wayback.py`, large
    # batches now drain steadily. User can bump in Settings if their
    # workload tolerates it.
    "wayback": {"rpm": 30, "max_concurrent": 1, "retry_max": 3},
    # WhoisFreaks (added Wave 2b, 2026-05-15). The first user-side
    # 429 happened during the Settings → Test button — their free tier
    # limit is ~30/min and bursts hit it. Conservative defaults:
    #   - rpm=30: 1 request every 2s averages well under the free
    #     tier's published ceiling
    #   - max_concurrent=2: small bursts allowed (the runner's per-
    #     domain fan-out wants > 1), but never piles up.
    #   - retry_max=3: matches wayback. 429 IS now retried (2026-05-23)
    #     with jittered exponential backoff — see
    #     `whois_history/providers/whoisfreaks.py:fetch_history`.
    #     Combined with burst=1 (set in `limits._STRICT_BURST_PROVIDERS`)
    #     this gives the upstream window time to roll forward without
    #     amplifying the load. 5xx uses the same retry path.
    # User can tune in Settings → Whois History → Rate limits once they
    # confirm their plan's actual ceiling.
    "whoisfreaks": {"rpm": 30, "max_concurrent": 2, "retry_max": 3},
    # Wayback Sparkline tool (added 2026-05-23). Separate row from
    # `wayback` because the sparkline endpoint (`__wb/sparkline`) is
    # MUCH lighter than full CDX queries — small payload, simple
    # server-side computation (it backs the calendar UI sparkline
    # chart). Measured 0.4–1.0s/domain at sequential concurrency=1.
    #
    # Conservative defaults after live calibration on 2026-05-23
    # (Job 2, 248 domains, original concurrency=8 → 22/42 done
    # finished as 429s before the user paused):
    #   - rpm=180: ~3 req/s. archive.org's sparkline throttles when
    #     burst sustained around 6-8 in-flight; backing off to 3
    #     leaves comfortable headroom without dropping throughput
    #     below the "100k overnight" target.
    #   - max_concurrent=3: tested-good ceiling. Operator can bump
    #     via Settings → Rate limits once they confirm their network
    #     path holds at a higher number.
    #   - retry_max=3: jittered exponential. 429s get the same retry
    #     treatment as transient 5xx (the provider client already
    #     handles this); these defaults are the floor below which
    #     retries shouldn't be needed at all.
    # Independent from `wayback` so a sparkline batch doesn't
    # starve quality-pillar wayback fetches and vice versa.
    # `wayback_sparkline` is in `_STRICT_BURST_PROVIDERS` (limits.py)
    # so burst=1 — bucket can't accumulate tokens past one, requests
    # are strictly paced at 60/rpm seconds. rpm=180 → 0.33s spacing.
    #
    # retry_max=2 (3 total attempts) chosen empirically (2026-05-23):
    # archive.org has BOTH a transient rolling-window 429 (clears in
    # 60-120s) AND a per-domain "this URL is blocked" 429 that doesn't
    # clear on any timescale we can wait through. The global cooldown
    # gate in providers/wayback_sparkline.py:_arm_cooldown handles
    # case 1; case 2 just needs to fail fast so the rest of the queue
    # drains. With retry_max=5 a permanently-blocked domain held a
    # worker slot for ~3 minutes; at retry_max=2 it's <10s.
    "wayback_sparkline": {"rpm": 60, "max_concurrent": 1, "retry_max": 2},
}

# Providers that have configurable rate limits but are NOT exposed in
# the main `/settings` provider-cards section (their credentials live
# in dedicated pillar tabs). Used by the rate-limit getter/setter to
# validate "this is a known provider" without forcing the card UI to
# render it.
_RATE_LIMIT_EXTRAS: set[str] = {"whoisfreaks", "wayback_sparkline"}


def _rate_key(provider: str, field: str) -> str:
    return f"rate_limit__{provider}__{field}"


def _rate_limit_provider_allowed(provider: str) -> bool:
    """A provider can have rate limits if it's either a main API
    provider (`PROVIDER_FIELDS`) OR a pillar-specific extra. Centralized
    so both getter + setter agree on the check."""
    return provider in PROVIDER_FIELDS or provider in _RATE_LIMIT_EXTRAS


def get_rate_limits(provider: str) -> dict[str, int]:
    if not _rate_limit_provider_allowed(provider):
        raise ValueError(f"unknown provider: {provider}")
    out = dict(_RATE_LIMIT_DEFAULTS[provider])
    db = SessionLocal()
    try:
        for f in RATE_LIMIT_FIELDS:
            v = _get(db, _rate_key(provider, f))
            if v:
                try:
                    out[f] = int(v)
                except ValueError:
                    # Corrupt row — fall back to default rather than crash.
                    pass
    finally:
        db.close()
    return out


def set_rate_limits(provider: str, values: dict[str, int]) -> None:
    if not _rate_limit_provider_allowed(provider):
        raise ValueError(f"unknown provider: {provider}")
    db = SessionLocal()
    try:
        for f in RATE_LIMIT_FIELDS:
            if f in values:
                v = values[f]
                if not isinstance(v, int) or v < 1:
                    raise ValueError(f"{f} must be a positive integer")
                _set(db, _rate_key(provider, f), str(v))
    finally:
        db.close()


def all_rate_limits() -> dict[str, dict[str, int]]:
    return {p: get_rate_limits(p) for p in PROVIDER_FIELDS}


# --- Model pricing ----------------------------------------------------------

# User-maintained per-(provider, model) token-cost table. Rates in $ per 1M
# tokens. Stored in the dedicated `model_pricing` SQL table (not the
# key/value `app_settings` bag) because the Settings UI lists/edits rows.
# Cost per AI call is locked in at the time of the call using whichever
# row is present then; later edits to a row do NOT recompute prior
# CriterionResult.ai_cost_usd values.

def get_model_price(provider: str, model: str) -> tuple[float, float] | None:
    """Returns (input_per_million, output_per_million) for a (provider,
    model) pair, or None if no row exists. Used by the runner at AI-call
    write time."""
    from .models import ModelPricing
    db = SessionLocal()
    try:
        row = db.get(ModelPricing, (provider, model))
        if row is None:
            return None
        return (row.input_per_million, row.output_per_million)
    finally:
        db.close()


def all_model_pricing() -> list[dict]:
    """List every pricing row, sorted (provider asc, model asc). Each
    item: {provider, model, input_per_million, output_per_million,
    updated_at}."""
    from .models import ModelPricing
    db = SessionLocal()
    try:
        rows = db.query(ModelPricing).order_by(
            ModelPricing.provider.asc(), ModelPricing.model.asc()
        ).all()
        return [
            {
                "provider": r.provider,
                "model": r.model,
                "input_per_million": r.input_per_million,
                "output_per_million": r.output_per_million,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ]
    finally:
        db.close()


def seed_pricing_for_known_models() -> int:
    """Auto-create empty (0/0) pricing rows for every (provider, model)
    pair that exists in the model registry but doesn't already have a
    pricing row. Idempotent — only inserts missing rows. Returns count
    of newly inserted rows. Called from the Settings → Pricing GET so
    the UI table is never empty when the user opens it."""
    from datetime import datetime
    from .models import ModelPricing
    db = SessionLocal()
    try:
        existing = {
            (r.provider, r.model)
            for r in db.query(ModelPricing.provider, ModelPricing.model).all()
        }
        n = 0
        for provider in AI_PROVIDERS_FOR_MODELS:
            for model in get_known_models(provider):
                if (provider, model) in existing:
                    continue
                db.add(
                    ModelPricing(
                        provider=provider,
                        model=model,
                        input_per_million=0.0,
                        output_per_million=0.0,
                        updated_at=datetime.utcnow(),
                    )
                )
                n += 1
        if n:
            db.commit()
        return n
    finally:
        db.close()


def upsert_model_price(
    provider: str, model: str,
    input_per_million: float, output_per_million: float,
) -> None:
    """Insert or update one pricing row. Used by the Settings UI's PUT
    endpoint."""
    from datetime import datetime
    from .models import ModelPricing
    if input_per_million < 0 or output_per_million < 0:
        raise ValueError("rates must be non-negative")
    db = SessionLocal()
    try:
        row = db.get(ModelPricing, (provider, model))
        if row is None:
            db.add(
                ModelPricing(
                    provider=provider, model=model,
                    input_per_million=float(input_per_million),
                    output_per_million=float(output_per_million),
                    updated_at=datetime.utcnow(),
                )
            )
        else:
            row.input_per_million = float(input_per_million)
            row.output_per_million = float(output_per_million)
            row.updated_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def delete_model_price(provider: str, model: str) -> bool:
    """Remove a pricing row. Returns True if a row was deleted."""
    from .models import ModelPricing
    db = SessionLocal()
    try:
        row = db.get(ModelPricing, (provider, model))
        if row is None:
            return False
        db.delete(row)
        db.commit()
        return True
    finally:
        db.close()


# --- AI prompts --------------------------------------------------------------

# Prompts are stored under `prompt__<key>` rows. DB value beats default; an
# empty / cleared row falls back to the default. The default is shipped from
# `ai_prompts.PROMPT_KEYS` so UI + runner agree on what's available.

def _prompt_key(key: str) -> str:
    return f"prompt__{key}"


def get_ai_prompt(key: str) -> str:
    """Effective prompt — DB override if present and non-empty, else default."""
    from .ai_prompts import PROMPT_KEYS  # local import avoids circular at boot

    if key not in PROMPT_KEYS:
        raise ValueError(f"unknown prompt key: {key}")
    db = SessionLocal()
    try:
        v = _get(db, _prompt_key(key))
    finally:
        db.close()
    return v if v else PROMPT_KEYS[key]


def set_ai_prompt(key: str, value: str) -> None:
    from .ai_prompts import PROMPT_KEYS

    if key not in PROMPT_KEYS:
        raise ValueError(f"unknown prompt key: {key}")
    if not value or not value.strip():
        raise ValueError("prompt cannot be empty (use reset to clear)")
    db = SessionLocal()
    try:
        _set(db, _prompt_key(key), value)
    finally:
        db.close()


def reset_ai_prompt(key: str) -> None:
    """Drop the override so subsequent reads return the default."""
    from .ai_prompts import PROMPT_KEYS

    if key not in PROMPT_KEYS:
        raise ValueError(f"unknown prompt key: {key}")
    db = SessionLocal()
    try:
        # Setting empty string is treated as "no override" by `get_ai_prompt`.
        _set(db, _prompt_key(key), "")
    finally:
        db.close()


# --- Scoring config (weights + thresholds) ---------------------------------
#
# User-tunable knobs that drive the deterministic final-score math:
# - per-criterion weights for the weighted-average aggregation
# - bucket thresholds (good ≥ X, mixed ≥ Y, otherwise low_quality)
# - low-confidence threshold (verdict pill greys out below this)
#
# Stored as a single JSON blob under `scoring_config` so adding a knob later
# is one schema-less change. Empty/missing rows fall back to the defaults
# below — these defaults are the original locked values from project memory.

SCORING_CONFIG_KEY = "scoring_config"

DEFAULT_SCORING_CONFIG: dict = {
    "weights": {
        "backlinks": 0.4,
        "refdomains": 0.2,
        "anchors": 0.3,
        "keywords": 0.1,
        # Default 0 — wayback is informational only until the user dials
        # it up. Same value lives in scoring.DEFAULT_CRITERION_WEIGHTS;
        # both reads merge with this so the runner and the bucket
        # threshold call see the same effective weights.
        "wayback": 0.0,
        # wayback_classify is descriptive metadata (language/theme/
        # category), not a quality judgment — its verdict has no
        # `assessment` field so compute_final skips it regardless. Listed
        # here only so the Settings UI's weight editor stays consistent
        # across criteria.
        "wayback_classify": 0.0,
    },
    "good_threshold": 80.0,
    "mixed_threshold": 60.0,
    "low_confidence_threshold": 0.5,
}

_SCORING_CRITERIA = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify",
)


# --- Wayback classification settings (added 2026-05-09) ---------------------
# `language_mode` selects the language-detection mechanism for the
# wayback_classify criterion: "ai" = let the combined AI prompt detect it
# (using <html lang> as a hint when present), "library" = run the lingua
# language detector deterministically and feed the AI a theme-only prompt.
# `categories` is the user's predefined list for the chained category
# classification pass — list of {name: str, description: str|None}.
LANGUAGE_MODE_KEY = "wayback_classify__language_mode"
DEFAULT_LANGUAGE_MODE = "ai"

CATEGORIES_KEY = "wayback_classify__categories"


def get_language_mode() -> str:
    db = SessionLocal()
    try:
        raw = (_get(db, LANGUAGE_MODE_KEY) or "").strip().lower()
    finally:
        db.close()
    if raw in ("ai", "library"):
        return raw
    return DEFAULT_LANGUAGE_MODE


def set_language_mode(mode: str) -> str:
    if mode not in ("ai", "library"):
        raise ValueError("language_mode must be 'ai' or 'library'")
    db = SessionLocal()
    try:
        _set(db, LANGUAGE_MODE_KEY, mode)
    finally:
        db.close()
    return mode


def _normalize_categories(raw_list: list) -> list[dict]:
    """Validate, dedup (case-insensitive on name), and sort categories
    alphabetically by name. Returns a clean list of {name, description}.
    Empty / non-string names are dropped silently."""
    seen: set[str] = set()
    out: list[dict] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        desc_raw = item.get("description")
        desc = str(desc_raw).strip() if isinstance(desc_raw, str) else ""
        out.append({"name": name, "description": desc})
    out.sort(key=lambda d: d["name"].lower())
    return out


def get_categories() -> list[dict]:
    """User's predefined site categories. Always returns alphabetical."""
    db = SessionLocal()
    try:
        raw = _get(db, CATEGORIES_KEY) or ""
    finally:
        db.close()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return _normalize_categories(parsed)


def set_categories(items: list) -> list[dict]:
    """Replace the entire category list. Inputs are normalized + sorted."""
    if not isinstance(items, list):
        raise ValueError("categories must be a list of {name, description?}")
    cleaned = _normalize_categories(items)
    db = SessionLocal()
    try:
        _set(db, CATEGORIES_KEY, json.dumps(cleaned))
    finally:
        db.close()
    return cleaned


def add_categories(items: list) -> list[dict]:
    """Merge new categories with existing — dedup by name (case-insensitive),
    descriptions from the new entries overwrite blank existing ones, then
    re-sort. Used by the bulk-paste UI on Settings."""
    if not isinstance(items, list):
        raise ValueError("categories must be a list of {name, description?}")
    existing = get_categories()
    by_key: dict[str, dict] = {c["name"].lower(): dict(c) for c in existing}
    new_normalized = _normalize_categories(items)
    for item in new_normalized:
        k = item["name"].lower()
        if k in by_key:
            # Preserve existing description unless the new one has content
            # AND the existing one is empty — non-empty existing wins.
            if item["description"] and not by_key[k]["description"]:
                by_key[k]["description"] = item["description"]
        else:
            by_key[k] = item
    merged = list(by_key.values())
    merged.sort(key=lambda d: d["name"].lower())
    db = SessionLocal()
    try:
        _set(db, CATEGORIES_KEY, json.dumps(merged))
    finally:
        db.close()
    return merged


# --- Wayback auto-retry settings (added 2026-05-17) -----------------------
# When a Quality run with `wayback` enabled finishes, optionally re-fire
# the existing /runs/{id}/retry-failed flow on a backoff schedule until
# either every Wayback (and chained classify) failure is resolved or the
# attempt budget runs out. Scoped to Wayback only — Ahrefs / Whois /
# Availability failures stay manual so we don't silently burn provider
# units. Knobs:
#   enabled              — master switch.
#   max_attempts         — how many retry passes after the initial run.
#                          1 means "one retry then stop"; 0 disables.
#   initial_delay_sec    — sleep before the first retry pass. Most CDX
#                          flakiness clears in <2 min so 60s is the
#                          default sweet spot.
#   backoff_multiplier   — applied between successive passes. 2.0 means
#                          60s → 120s → 240s for the 3-attempt default.
_WAYBACK_AUTO_RETRY_KEY = "wayback_auto_retry_config"
DEFAULT_WAYBACK_AUTO_RETRY = {
    "enabled": True,
    "max_attempts": 3,
    "initial_delay_sec": 60,
    "backoff_multiplier": 2.0,
}
# Conservative caps so a typo in Settings (`max_attempts: 9999`,
# `initial_delay_sec: 0`) can't pin the event loop or DDoS Wayback.
_AUTO_RETRY_MAX_ATTEMPTS_CAP = 20
_AUTO_RETRY_MAX_DELAY_SEC = 3600   # 1 h between passes
_AUTO_RETRY_MAX_MULTIPLIER = 10.0


def get_wayback_auto_retry_config() -> dict:
    """DB override merged onto defaults. Always returns the full 4-key
    shape so callers don't have to defend against partial dicts."""
    db = SessionLocal()
    try:
        raw = _get(db, _WAYBACK_AUTO_RETRY_KEY) or ""
    finally:
        db.close()
    out = dict(DEFAULT_WAYBACK_AUTO_RETRY)
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(parsed, dict):
        return out
    if isinstance(parsed.get("enabled"), bool):
        out["enabled"] = parsed["enabled"]
    if isinstance(parsed.get("max_attempts"), int):
        out["max_attempts"] = max(
            0, min(parsed["max_attempts"], _AUTO_RETRY_MAX_ATTEMPTS_CAP),
        )
    if isinstance(parsed.get("initial_delay_sec"), (int, float)):
        out["initial_delay_sec"] = max(
            0, min(int(parsed["initial_delay_sec"]), _AUTO_RETRY_MAX_DELAY_SEC),
        )
    if isinstance(parsed.get("backoff_multiplier"), (int, float)):
        out["backoff_multiplier"] = max(
            1.0, min(float(parsed["backoff_multiplier"]), _AUTO_RETRY_MAX_MULTIPLIER),
        )
    return out


def set_wayback_auto_retry_config(cfg: dict) -> dict:
    """Merge `cfg` over the current config + persist. Same key shape +
    cap semantics as `get_wayback_auto_retry_config`. Returns the
    effective post-merge value (so the API response can echo what
    actually got saved)."""
    if not isinstance(cfg, dict):
        raise ValueError("wayback_auto_retry config must be a dict")
    current = get_wayback_auto_retry_config()
    if "enabled" in cfg:
        if not isinstance(cfg["enabled"], bool):
            raise ValueError("enabled must be a boolean")
        current["enabled"] = cfg["enabled"]
    if "max_attempts" in cfg:
        if not isinstance(cfg["max_attempts"], int):
            raise ValueError("max_attempts must be an integer")
        current["max_attempts"] = max(
            0, min(cfg["max_attempts"], _AUTO_RETRY_MAX_ATTEMPTS_CAP),
        )
    if "initial_delay_sec" in cfg:
        if not isinstance(cfg["initial_delay_sec"], (int, float)):
            raise ValueError("initial_delay_sec must be a number")
        current["initial_delay_sec"] = max(
            0,
            min(int(cfg["initial_delay_sec"]), _AUTO_RETRY_MAX_DELAY_SEC),
        )
    if "backoff_multiplier" in cfg:
        if not isinstance(cfg["backoff_multiplier"], (int, float)):
            raise ValueError("backoff_multiplier must be a number")
        current["backoff_multiplier"] = max(
            1.0,
            min(float(cfg["backoff_multiplier"]), _AUTO_RETRY_MAX_MULTIPLIER),
        )
    db = SessionLocal()
    try:
        _set(db, _WAYBACK_AUTO_RETRY_KEY, json.dumps(current))
    finally:
        db.close()
    return current


# --- Share defaults (added 2026-05-24) -------------------------------------
# Operator-configurable defaults for newly-minted share tokens. Today only
# `default_expires_in_days` lives here; future toggles (default note
# template, max-views cap, etc.) can extend the same JSON blob.
#
# `default_expires_in_days = 0` (the shipped default) means "never expires".
# The /shares router uses this when the FE doesn't pass an explicit value,
# and the Database page's 1-click share icon uses it silently — those calls
# always rely on the configured default so the operator has one knob.
#
# Hard cap at 10 years (3650 days) mirrors the per-request validation on
# `POST /shares` and `POST /database/approve-share-links` so a misconfigured
# Setting can't mint a 100-year share by accident.
_SHARE_DEFAULTS_KEY = "share_defaults"
DEFAULT_SHARE_DEFAULTS = {
    "default_expires_in_days": 0,  # 0 = never expires (forever).
}
_SHARE_MAX_EXPIRES_DAYS = 3650


def get_share_defaults() -> dict:
    """DB override merged onto defaults. Always returns the full shape so
    callers don't have to defend against partial dicts."""
    db = SessionLocal()
    try:
        raw = _get(db, _SHARE_DEFAULTS_KEY) or ""
    finally:
        db.close()
    out = dict(DEFAULT_SHARE_DEFAULTS)
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(parsed, dict):
        return out
    if isinstance(parsed.get("default_expires_in_days"), int):
        out["default_expires_in_days"] = max(
            0, min(parsed["default_expires_in_days"], _SHARE_MAX_EXPIRES_DAYS),
        )
    return out


def set_share_defaults(cfg: dict) -> dict:
    """Merge `cfg` over the current defaults + persist. Returns the
    effective post-merge value (so the API response can echo what
    actually got saved)."""
    if not isinstance(cfg, dict):
        raise ValueError("share defaults must be a dict")
    current = get_share_defaults()
    if "default_expires_in_days" in cfg:
        if not isinstance(cfg["default_expires_in_days"], int):
            raise ValueError("default_expires_in_days must be an integer")
        current["default_expires_in_days"] = max(
            0, min(cfg["default_expires_in_days"], _SHARE_MAX_EXPIRES_DAYS),
        )
    db = SessionLocal()
    try:
        _set(db, _SHARE_DEFAULTS_KEY, json.dumps(current))
    finally:
        db.close()
    return current


def reset_share_defaults() -> dict:
    """Clear the override → next read returns shipped defaults. Sets the
    blob to empty rather than deleting the row since `get_share_defaults`
    treats empty as "fall through to defaults" (mirrors the pattern used
    everywhere else in this module — there's no `_delete` helper)."""
    db = SessionLocal()
    try:
        _set(db, _SHARE_DEFAULTS_KEY, "")
    finally:
        db.close()
    return dict(DEFAULT_SHARE_DEFAULTS)


# --- Availability auto-retry (added 2026-05-18) -----------------------------
# Mirrors the Wayback post-run watcher but for the Availability cascade.
# Behavioural twist: the cascade has multiple providers and they don't all
# have the same cost / failure semantics, so we add a `retry_providers`
# whitelist on top of the standard 4-key shape. Only RDs whose terminal
# failure came from a provider in this set get retried. Default is
# ["rdap"] — RDAP is free + the user's primary cascade — so the feature
# is auto-on without risking surprise Domainr bills.
#
# Skip rules (locked 2026-05-18):
#   - CR.status='failed' (cascade runner crashed) → always retry
#   - CR.status='done' + verdict.status='error' + verdict.provider in
#     retry_providers → retry (transient: rate-limit / timeout / network)
#   - CR.status='done' + verdict.status='unknown' → SKIP (all providers
#     ran to completion, none had a usable answer — TLD likely has no
#     cascade path; retrying won't change that)
#   - CR.status='done' + verdict.status='error' + verdict.provider NOT in
#     retry_providers → SKIP (operator opted out — usually to avoid
#     burning paid Domainr units on a flaky run)
# Canonical availability-cascade provider names — single source of truth so
# the cascade order, per-provider enabled/rate-limit getters, the setting
# validators, and the auto-retry whitelist all stay in lockstep. Adding a
# provider = add it here + a dispatch branch in cascade.py + its defaults in
# AVAILABILITY_DEFAULTS. 'whoisfreaks' added 2026-06-08 (live-WHOIS
# availability via the Whois History key; paid, off by default).
AVAILABILITY_PROVIDER_NAMES = ("dns", "rdap", "domainr", "whois", "whoisfreaks")

_AVAILABILITY_AUTO_RETRY_KEY = "availability_auto_retry_config"
# Valid retry_providers entries — matches the cascade's provider names.
_AVAILABILITY_RETRY_PROVIDERS = AVAILABILITY_PROVIDER_NAMES
DEFAULT_AVAILABILITY_AUTO_RETRY = {
    "enabled": True,
    # Conservative default: 2 attempts (vs Wayback's 3). Availability
    # errors are less reliably transient than CDX flakiness, so the
    # marginal value of a third attempt is lower while the cost
    # (RDAP unit pressure on a bursty run) is real.
    "max_attempts": 2,
    "initial_delay_sec": 60,
    "backoff_multiplier": 2.0,
    # Provider whitelist — only RDs whose terminal failing provider is
    # in this list get retried. Default is RDAP-only per user request
    # 2026-05-18 ("Default to RDAP. I mainly use RDAP now"). Adding
    # 'domainr' or 'whois' here is opt-in — both have real downsides
    # (Domainr is metered/paid; whois port-43 is rate-limited and
    # often the slowest provider in the cascade).
    "retry_providers": ["rdap"],
}


def get_availability_auto_retry_config() -> dict:
    """DB override merged onto defaults. Always returns the full
    5-key shape so callers don't have to defend against partial dicts."""
    db = SessionLocal()
    try:
        raw = _get(db, _AVAILABILITY_AUTO_RETRY_KEY) or ""
    finally:
        db.close()
    out = dict(DEFAULT_AVAILABILITY_AUTO_RETRY)
    # Deep-copy the list field so a caller mutating it doesn't poison
    # the module-level default.
    out["retry_providers"] = list(DEFAULT_AVAILABILITY_AUTO_RETRY["retry_providers"])
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(parsed, dict):
        return out
    if isinstance(parsed.get("enabled"), bool):
        out["enabled"] = parsed["enabled"]
    if isinstance(parsed.get("max_attempts"), int):
        out["max_attempts"] = max(
            0, min(parsed["max_attempts"], _AUTO_RETRY_MAX_ATTEMPTS_CAP),
        )
    if isinstance(parsed.get("initial_delay_sec"), (int, float)):
        out["initial_delay_sec"] = max(
            0, min(int(parsed["initial_delay_sec"]), _AUTO_RETRY_MAX_DELAY_SEC),
        )
    if isinstance(parsed.get("backoff_multiplier"), (int, float)):
        out["backoff_multiplier"] = max(
            1.0, min(float(parsed["backoff_multiplier"]), _AUTO_RETRY_MAX_MULTIPLIER),
        )
    raw_providers = parsed.get("retry_providers")
    if isinstance(raw_providers, list):
        # Preserve order + dedup + drop unknown entries.
        seen: set[str] = set()
        cleaned: list[str] = []
        for p in raw_providers:
            if not isinstance(p, str):
                continue
            if p in _AVAILABILITY_RETRY_PROVIDERS and p not in seen:
                cleaned.append(p)
                seen.add(p)
        # Empty list is valid — it means "auto-retry NO done+error
        # rows; only retry status='failed' cascade-crashed rows."
        # That's a legitimate "I want only the safest retries" state,
        # so we don't backfill to the default here.
        out["retry_providers"] = cleaned
    return out


def set_availability_auto_retry_config(cfg: dict) -> dict:
    """Merge `cfg` over the current config + persist. Same key shape +
    cap semantics as `get_availability_auto_retry_config`. Returns the
    effective post-merge value (so the API response can echo what
    actually got saved)."""
    if not isinstance(cfg, dict):
        raise ValueError("availability_auto_retry config must be a dict")
    current = get_availability_auto_retry_config()
    if "enabled" in cfg:
        if not isinstance(cfg["enabled"], bool):
            raise ValueError("enabled must be a boolean")
        current["enabled"] = cfg["enabled"]
    if "max_attempts" in cfg:
        if not isinstance(cfg["max_attempts"], int):
            raise ValueError("max_attempts must be an integer")
        current["max_attempts"] = max(
            0, min(cfg["max_attempts"], _AUTO_RETRY_MAX_ATTEMPTS_CAP),
        )
    if "initial_delay_sec" in cfg:
        if not isinstance(cfg["initial_delay_sec"], (int, float)):
            raise ValueError("initial_delay_sec must be a number")
        current["initial_delay_sec"] = max(
            0,
            min(int(cfg["initial_delay_sec"]), _AUTO_RETRY_MAX_DELAY_SEC),
        )
    if "backoff_multiplier" in cfg:
        if not isinstance(cfg["backoff_multiplier"], (int, float)):
            raise ValueError("backoff_multiplier must be a number")
        current["backoff_multiplier"] = max(
            1.0,
            min(float(cfg["backoff_multiplier"]), _AUTO_RETRY_MAX_MULTIPLIER),
        )
    if "retry_providers" in cfg:
        raw_providers = cfg["retry_providers"]
        if not isinstance(raw_providers, list):
            raise ValueError("retry_providers must be a list")
        seen: set[str] = set()
        cleaned: list[str] = []
        for p in raw_providers:
            if not isinstance(p, str):
                raise ValueError(
                    "retry_providers entries must be strings",
                )
            if p not in _AVAILABILITY_RETRY_PROVIDERS:
                raise ValueError(
                    f"unknown retry provider: {p!r} "
                    f"(allowed: {list(_AVAILABILITY_RETRY_PROVIDERS)})",
                )
            if p not in seen:
                cleaned.append(p)
                seen.add(p)
        current["retry_providers"] = cleaned
    db = SessionLocal()
    try:
        _set(db, _AVAILABILITY_AUTO_RETRY_KEY, json.dumps(current))
    finally:
        db.close()
    return current


def get_scoring_config() -> dict:
    """Effective scoring config — DB override merged on top of defaults.
    Always returns a complete config (every key present) so downstream
    callers don't need to defend against partial dicts."""
    db = SessionLocal()
    try:
        raw = _get(db, SCORING_CONFIG_KEY) or ""
    finally:
        db.close()
    out = {
        "weights": dict(DEFAULT_SCORING_CONFIG["weights"]),
        "good_threshold": DEFAULT_SCORING_CONFIG["good_threshold"],
        "mixed_threshold": DEFAULT_SCORING_CONFIG["mixed_threshold"],
        "low_confidence_threshold": DEFAULT_SCORING_CONFIG[
            "low_confidence_threshold"
        ],
    }
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(parsed, dict):
        return out
    w = parsed.get("weights")
    if isinstance(w, dict):
        for c in _SCORING_CRITERIA:
            v = w.get(c)
            if isinstance(v, (int, float)):
                out["weights"][c] = float(v)
    for k in ("good_threshold", "mixed_threshold", "low_confidence_threshold"):
        v = parsed.get(k)
        if isinstance(v, (int, float)):
            out[k] = float(v)
    return out


def set_scoring_config(cfg: dict) -> dict:
    """Validate + persist. Caller may pass a partial dict — only provided
    keys are updated; the rest stay at whatever's currently effective.
    Returns the new effective config."""
    current = get_scoring_config()
    new_weights = dict(current["weights"])
    if "weights" in cfg and isinstance(cfg["weights"], dict):
        for c in _SCORING_CRITERIA:
            if c in cfg["weights"]:
                v = cfg["weights"][c]
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    raise ValueError(f"weights.{c} must be a number")
                f = float(v)
                if f < 0 or f > 1:
                    raise ValueError(f"weights.{c} must be in 0..1")
                new_weights[c] = f
    if sum(new_weights.values()) <= 0:
        raise ValueError("at least one weight must be > 0")

    out = {
        "weights": new_weights,
        "good_threshold": current["good_threshold"],
        "mixed_threshold": current["mixed_threshold"],
        "low_confidence_threshold": current["low_confidence_threshold"],
    }
    for k in ("good_threshold", "mixed_threshold"):
        if k in cfg:
            v = cfg[k]
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ValueError(f"{k} must be a number")
            f = float(v)
            if f < 0 or f > 100:
                raise ValueError(f"{k} must be in 0..100")
            out[k] = f
    if "low_confidence_threshold" in cfg:
        v = cfg["low_confidence_threshold"]
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ValueError("low_confidence_threshold must be a number")
        f = float(v)
        if f < 0 or f > 1:
            raise ValueError("low_confidence_threshold must be in 0..1")
        out["low_confidence_threshold"] = f
    if out["mixed_threshold"] >= out["good_threshold"]:
        raise ValueError(
            "mixed_threshold must be lower than good_threshold"
        )
    db = SessionLocal()
    try:
        _set(db, SCORING_CONFIG_KEY, json.dumps(out))
    finally:
        db.close()
    return out


def reset_scoring_config() -> dict:
    db = SessionLocal()
    try:
        _set(db, SCORING_CONFIG_KEY, "")
    finally:
        db.close()
    return get_scoring_config()


# --- Error log retention (added 2026-05-09) ---------------------------------
# Auto-prune dismissed errors older than N days. Applies to ALL sources:
# - error_log rows are deleted entirely
# - persisted-source errors (CriterionResult/RunDomain/Run) have their
#   `error` column cleared on the source row
# Open (non-dismissed) errors are never auto-pruned — the user has to
# acknowledge them first by dismissing.
ERROR_RETENTION_KEY = "error_retention_days"
ERROR_RETENTION_OPTIONS = (7, 15, 30)
DEFAULT_ERROR_RETENTION_DAYS: int | None = 30
NEVER_SENTINEL = "never"


def get_error_retention_days() -> int | None:
    """Effective retention. None = never prune. Default = 30 days for fresh
    installs (no row stored yet)."""
    db = SessionLocal()
    try:
        raw = (_get(db, ERROR_RETENTION_KEY) or "").strip().lower()
    finally:
        db.close()
    if raw == "":
        return DEFAULT_ERROR_RETENTION_DAYS
    if raw == NEVER_SENTINEL:
        return None
    try:
        v = int(raw)
    except ValueError:
        return DEFAULT_ERROR_RETENTION_DAYS
    return v if v in ERROR_RETENTION_OPTIONS else DEFAULT_ERROR_RETENTION_DAYS


def set_error_retention_days(value: int | None) -> int | None:
    """Persist the retention choice. None means 'never prune'."""
    if value is not None and value not in ERROR_RETENTION_OPTIONS:
        raise ValueError(
            f"error_retention_days must be one of {ERROR_RETENTION_OPTIONS} or None"
        )
    db = SessionLocal()
    try:
        _set(db, ERROR_RETENTION_KEY, NEVER_SENTINEL if value is None else str(value))
    finally:
        db.close()
    return value


# --- SERP Overview dedup window (added 2026-07-10) --------------------------
# How long a completed (keyword, country, top_positions) check suppresses
# re-checking the same triple at submit time. The "Recheck keywords" toggle
# on the tool bypasses it per-run. Plain integer days, 1..3650.
SERP_DEDUP_WINDOW_KEY = "serp_dedup_window_days"
DEFAULT_SERP_DEDUP_WINDOW_DAYS = 30


def get_serp_dedup_window_days() -> int:
    db = SessionLocal()
    try:
        raw = (_get(db, SERP_DEDUP_WINDOW_KEY) or "").strip()
    finally:
        db.close()
    try:
        v = int(raw)
    except ValueError:
        return DEFAULT_SERP_DEDUP_WINDOW_DAYS
    return v if 1 <= v <= 3650 else DEFAULT_SERP_DEDUP_WINDOW_DAYS


def set_serp_dedup_window_days(value: int) -> int:
    v = int(value)
    if not (1 <= v <= 3650):
        raise ValueError(
            "serp_dedup_window_days must be between 1 and 3650"
        )
    db = SessionLocal()
    try:
        _set(db, SERP_DEDUP_WINDOW_KEY, str(v))
    finally:
        db.close()
    return v


# --- Backlog CSV import row cap (added 2026-05-09) ------------------------
# User-configurable upper bound on rows accepted by `POST /backlog/import`
# (and the matching guard in the frontend CSV parser). Defaults to 50k —
# generous for a year's worth of auction lists. Hard limits are also
# enforced on the wire by Pydantic (`_IMPORT_MAX_ROWS_HARD_CAP` in the
# router) so a misconfigured DB value can't blow past sanity.
IMPORT_MAX_ROWS_KEY = "backlog_import_max_rows"
DEFAULT_IMPORT_MAX_ROWS = 50_000
IMPORT_MAX_ROWS_MIN = 100
# Upper bound for the user-editable cap in Settings → Others. Set
# generously so the user owns the practical ceiling — the wire-level
# Pydantic hard cap was removed 2026-05-17 along with this bump. 10M
# covers ~5× the largest "store + occasionally browse" use case we
# discussed; raise this constant if you ever need more.
IMPORT_MAX_ROWS_MAX = 10_000_000


def get_import_max_rows() -> int:
    db = SessionLocal()
    try:
        raw = (_get(db, IMPORT_MAX_ROWS_KEY) or "").strip()
    finally:
        db.close()
    if not raw:
        return DEFAULT_IMPORT_MAX_ROWS
    try:
        v = int(raw)
    except ValueError:
        return DEFAULT_IMPORT_MAX_ROWS
    # Clamp on read so an out-of-range stored value (e.g. left over from a
    # past wider bound) still produces a usable cap.
    return max(IMPORT_MAX_ROWS_MIN, min(IMPORT_MAX_ROWS_MAX, v))


def set_import_max_rows(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("backlog_import_max_rows must be an integer")
    if value < IMPORT_MAX_ROWS_MIN or value > IMPORT_MAX_ROWS_MAX:
        raise ValueError(
            f"backlog_import_max_rows must be between {IMPORT_MAX_ROWS_MIN} "
            f"and {IMPORT_MAX_ROWS_MAX}"
        )
    db = SessionLocal()
    try:
        _set(db, IMPORT_MAX_ROWS_KEY, str(value))
    finally:
        db.close()
    return value


# --- Domain Filter (added 2026-06-07) -------------------------------------
# User-managed exclusion list applied to /backlog/import. The state is a
# dict of category -> list[str] so we can add new exclusion categories
# (spam-keywords, banned-substrings, …) without touching the schema or
# the API surface — frontends just render whichever categories are
# present in the response.
#
# Today the only category is `cctld` — a list of TLD labels (e.g.
# ["uk", "de", "fr"]). The match rule is intentionally narrow: a domain
# is excluded ONLY when it has exactly TWO labels (`example.uk`) and the
# last label is in the ccTLD list. Three-label names like `example.co.uk`
# / `bbc.org.uk` are NOT excluded, because second-level SLDs under
# ccTLDs (.co.uk, .org.uk, .com.au, .co.jp, …) are freely registrable
# and the user explicitly wants them through. This avoids needing a
# Public Suffix List dependency at the cost of allowing a handful of
# exotic 2-label edge cases through; if that ever bites we'd revisit.
DOMAIN_FILTER_KEY = "domain_filter"

# Recognised category keys. The frontend renders a section per recognised
# key; unknown keys in the stored dict are silently dropped on read so
# stale entries from a removed category don't surface in the UI.
DOMAIN_FILTER_CATEGORIES: tuple[str, ...] = ("cctld",)

# Per-entry hard cap so a typo / paste of a giant blob doesn't blow up
# the JSON column. List-length cap too, for the same reason. Both are
# enforced at write time; reads silently truncate to be defensive.
_DOMAIN_FILTER_ENTRY_MAX_LEN = 64
_DOMAIN_FILTER_LIST_MAX_LEN = 5_000


def _normalize_filter_entry(raw: object) -> str | None:
    """Coerce a single user-entered filter value into the canonical
    stored form: lowercase, no surrounding whitespace, no leading dot.
    Returns None for empty / non-string / over-long inputs so the caller
    can drop the row silently."""
    if not isinstance(raw, str):
        return None
    v = raw.strip().lower()
    if not v:
        return None
    # Strip a leading dot if the user typed ".uk" — store the bare label.
    while v.startswith("."):
        v = v[1:]
    if not v:
        return None
    if len(v) > _DOMAIN_FILTER_ENTRY_MAX_LEN:
        return None
    # ccTLDs are letters/digits/hyphens only (RFC 1035 LDH). Reject
    # anything that doesn't look like a label so we don't accept random
    # strings that'd never match — including internal dots: the cctld
    # match rule only inspects the final label, so storing `co.uk`
    # would silently never match and confuse the user. Force them to
    # store the bare TLD label.
    for ch in v:
        if not (ch.isalnum() or ch == "-"):
            return None
    return v


def _normalize_filter_list(raw_list: object) -> list[str]:
    """Validate + dedup (preserving first-seen order) + cap length."""
    if not isinstance(raw_list, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw_list:
        v = _normalize_filter_entry(item)
        if v is None or v in seen:
            continue
        seen.add(v)
        out.append(v)
        if len(out) >= _DOMAIN_FILTER_LIST_MAX_LEN:
            break
    out.sort()
    return out


def _normalize_filter_state(raw_state: object) -> dict[str, list[str]]:
    """Coerce stored / submitted state into the canonical dict shape.
    Always returns a key per recognised category (empty list when the
    user hasn't populated it) so the frontend can render every section
    without null-checks."""
    out: dict[str, list[str]] = {cat: [] for cat in DOMAIN_FILTER_CATEGORIES}
    if not isinstance(raw_state, dict):
        return out
    for cat in DOMAIN_FILTER_CATEGORIES:
        if cat in raw_state:
            out[cat] = _normalize_filter_list(raw_state[cat])
    return out


def get_domain_filter() -> dict[str, list[str]]:
    """Current domain-filter state. Always returns a full dict keyed by
    every recognised category — keys with no user entries map to []."""
    db = SessionLocal()
    try:
        raw = _get(db, DOMAIN_FILTER_KEY) or ""
    finally:
        db.close()
    if not raw:
        return _normalize_filter_state(None)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return _normalize_filter_state(None)
    return _normalize_filter_state(parsed)


def set_domain_filter(state: dict) -> dict[str, list[str]]:
    """Replace the entire filter state. Inputs are normalised + sorted.
    Unknown category keys are silently dropped — only categories in
    DOMAIN_FILTER_CATEGORIES are persisted."""
    if not isinstance(state, dict):
        raise ValueError(
            "domain_filter state must be an object keyed by category name",
        )
    cleaned = _normalize_filter_state(state)
    db = SessionLocal()
    try:
        _set(db, DOMAIN_FILTER_KEY, json.dumps(cleaned))
    finally:
        db.close()
    return cleaned


def check_domain_filter(
    domain: str,
    state: dict[str, list[str]] | None = None,
) -> tuple[bool, str | None]:
    """Return (excluded, category_key) for a single domain. Pure — takes
    a pre-fetched state for hot loops, falls back to a DB read for
    one-offs. Reuses the canonical 2-label rule for the `cctld`
    category; future categories add their own branch here.

    Match rule for `cctld`:
      - `example.uk`     → 2 labels, last in list → excluded.
      - `example.co.uk`  → 3 labels → NOT excluded (open SLD).
      - `bbc.co.uk`      → 3 labels → NOT excluded.
      - `example.com`    → 2 labels but `com` not in list → NOT excluded.
    """
    if not domain:
        return False, None
    s = state if state is not None else get_domain_filter()
    cctlds = s.get("cctld") or []
    if cctlds:
        # Domain is already normalised by the time it reaches the
        # import pipeline (lowercased, scheme/path/www stripped). Be
        # defensive in case a future caller forgets.
        dom = domain.strip().lower()
        if dom.startswith("www."):
            dom = dom[4:]
        parts = dom.split(".")
        if len(parts) == 2:
            tld = parts[-1]
            if tld in set(cctlds):
                return True, "cctld"
    return False, None


# --- Availability cascade settings (added 2026-05-12) ---------------------
# Flat key→value rows; all single-tab-managed in Settings → Domain
# availability. Defaults match what an honest first user should expect:
# RDAP enabled, others off; conservative rate limits; 24h cache.

AVAILABILITY_DEFAULTS: dict[str, str] = {
    "availability__dns__enabled":         "true",
    "availability__rdap__enabled":        "true",
    "availability__domainr__enabled":     "false",
    "availability__whois__enabled":       "false",
    # WhoisFreaks live-WHOIS availability (added 2026-06-08). Off by
    # default — it's paid/metered (1 credit per lookup) and reuses the
    # Whois History API key. Opt-in for ccTLDs the cheaper providers miss.
    "availability__whoisfreaks__enabled": "false",
    # User-orderable cascade. Comma-separated list of providers to try
    # in order. Providers not enabled are silently skipped at runtime.
    "availability__cascade_order":        "dns,rdap,domainr,whois,whoisfreaks",
    # Outer fan-out cap — how many domains the availability runner
    # processes concurrently (added 2026-06-15). The HARD ceiling on
    # throughput: per-provider max_concurrent can't exceed this because
    # each domain runs the cascade serially. Default 8; raise it (e.g.
    # 50+) once RDAP egress is spread across a proxy pool so the extra
    # provider concurrency actually has domains to feed it. Read at run
    # dispatch, so a change takes effect on the next run / resume.
    "availability__outer_concurrency":    "8",
    # Per-provider rate limits (req/s + max concurrent).
    "availability__dns__rps":             "20",
    "availability__dns__max_concurrent":  "10",
    "availability__rdap__rps":            "3",
    "availability__rdap__max_concurrent": "4",
    # RDAP egress proxies (added 2026-06-15). Newline/comma-separated list
    # of HTTP/HTTPS/SOCKS5 proxy URLs the RDAP provider rotates through, so
    # bulk lookups spread across many source IPs and don't trip the
    # registries' per-IP throttle. Empty = direct (current behavior).
    # Applies to RDAP ONLY — WhoisFreaks is a paid API and stays direct.
    "availability__rdap__proxies":        "",
    "availability__domainr__rps":         "5",
    "availability__domainr__max_concurrent": "4",
    "availability__whois__rps":           "1",
    "availability__whois__max_concurrent": "2",
    # WhoisFreaks live-WHOIS rate limits — conservative; it's a paid API.
    "availability__whoisfreaks__rps":           "1",
    "availability__whoisfreaks__max_concurrent": "2",
    # Domainr (Fastly Domain Research API) token — Fernet-encrypted at rest
    # via the __api_key suffix detection in `_set`.
    "availability__domainr__api_key":     "",
    # Cache TTL hours — cascade returns the prior result if its
    # checked_at is within this window. 24h is a reasonable default;
    # drop-hunters near close-to-drop dates may want 1h.
    "availability__cache_ttl_hours":      "24",
    # Skip-registered policy. When both `skip_registered` is on AND a
    # domain is `registered` AND `expires_on > now + skip_horizon_days`,
    # the runner skips Ahrefs/Wayback/AI for this domain (saves units).
    # Registered-but-soon-expiring domains still flow through analysis.
    "availability__skip_registered":      "false",
    "availability__skip_horizon_days":    "90",
    # Retention prune for the `availability_checks` history table
    # (added 2026-05-14). Two compounding caps applied daily by an
    # APScheduler job + once at boot:
    #   - retention_days: delete rows older than N days. 0 = never
    #     prune by age. Reads as int, "never" sentinel persisted as 0.
    #   - per_domain_keep: after the age sweep, for each domain that
    #     still has > M rows, drop the oldest until M remain. 0 =
    #     no per-domain cap (keep everything within retention window).
    # Defaults: 30d / 20 rows per domain — bounds the most-recent
    # check column on the Settings page while leaving a useful audit
    # trail for "why did the cascade pick provider X for this domain
    # last week?" questions.
    "availability__retention_days":       "30",
    "availability__per_domain_keep":      "20",
}

# Maintenance toggles (separate namespace from availability__*; these
# are DB-wide concerns, not provider-specific). Surfaced in Settings
# alongside the backup config.
DB_MAINTENANCE_DEFAULTS: dict[str, str] = {
    # Monthly VACUUM cron (added 2026-05-14). Reclaims free pages left
    # behind by the various delete paths (retention prunes, bulk
    # delete-filtered, ban snapshots overwriting Backlog rows). VACUUM
    # is safe — transactional, no data loss — but takes an exclusive
    # lock while it runs. The job has its own disk-free guard
    # (skips if free < 2x DB size) and the shared MAINTENANCE_LOCK
    # so it never overlaps with a backup. Default ON.
    "db_maintenance__vacuum_enabled": "true",
}

# Hardcoded ceiling so a runaway Settings edit can't accidentally hammer
# the registry. Settings UI accepts higher values, this clamps at write
# time.
AVAILABILITY_RPS_CEILING = 10


def _availability_int(key: str, default: int) -> int:
    db = SessionLocal()
    try:
        raw = _get(db, key)
    finally:
        db.close()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _availability_bool(key: str, default: bool) -> bool:
    db = SessionLocal()
    try:
        raw = (_get(db, key) or "").strip().lower()
    finally:
        db.close()
    if raw in ("true", "1", "yes", "on"):
        return True
    if raw in ("false", "0", "no", "off"):
        return False
    return default


def _availability_str(key: str, default: str) -> str:
    db = SessionLocal()
    try:
        raw = _get(db, key)
    finally:
        db.close()
    if raw is None:
        return default
    return raw


def get_availability_config() -> dict:
    """Return the full availability config snapshot for the Settings UI
    and the cascade. Single roundtrip — useful for the
    per-run-overhead-sensitive runner path."""
    out: dict = {}
    db = SessionLocal()
    try:
        for k, default in AVAILABILITY_DEFAULTS.items():
            v = _get(db, k)
            out[k] = v if v is not None else default
    finally:
        db.close()
    # Mask the API key for safe display — callers that need the raw key
    # call `get_domainr_api_key()` directly.
    if out.get("availability__domainr__api_key"):
        out["availability__domainr__api_key__set"] = True
        out["availability__domainr__api_key"] = ""
    else:
        out["availability__domainr__api_key__set"] = False
    return out


def get_domainr_api_key() -> str:
    """Raw key for the Domainr HTTP call. Auto-decrypts via _get."""
    return _availability_str("availability__domainr__api_key", "")


def get_availability_cascade_order() -> list[str]:
    raw = _availability_str(
        "availability__cascade_order",
        AVAILABILITY_DEFAULTS["availability__cascade_order"],
    )
    seen: set[str] = set()
    order: list[str] = []
    for p in raw.split(","):
        p = p.strip().lower()
        if p in AVAILABILITY_PROVIDER_NAMES and p not in seen:
            order.append(p)
            seen.add(p)
    # Append any missing providers at the end so a malformed config
    # still reaches them. Order in defaults wins.
    for p in AVAILABILITY_PROVIDER_NAMES:
        if p not in seen:
            order.append(p)
    return order


def is_provider_enabled(provider: str) -> bool:
    if provider not in AVAILABILITY_PROVIDER_NAMES:
        return False
    return _availability_bool(
        f"availability__{provider}__enabled",
        AVAILABILITY_DEFAULTS[f"availability__{provider}__enabled"] == "true",
    )


def get_provider_rate_limits(provider: str) -> dict[str, int]:
    """Returns {rps, max_concurrent} for the named provider, clamped to
    the AVAILABILITY_RPS_CEILING regardless of stored value."""
    if provider not in AVAILABILITY_PROVIDER_NAMES:
        return {"rps": 1, "max_concurrent": 1}
    rps = _availability_int(
        f"availability__{provider}__rps",
        int(AVAILABILITY_DEFAULTS[f"availability__{provider}__rps"]),
    )
    mc = _availability_int(
        f"availability__{provider}__max_concurrent",
        int(AVAILABILITY_DEFAULTS[f"availability__{provider}__max_concurrent"]),
    )
    return {
        "rps": min(max(rps, 1), AVAILABILITY_RPS_CEILING),
        "max_concurrent": max(mc, 1),
    }


AVAILABILITY_OUTER_CONCURRENCY_MAX = 256


def get_availability_outer_concurrency() -> int:
    """How many domains the availability runner fans out concurrently.
    Clamped to 1..AVAILABILITY_OUTER_CONCURRENCY_MAX so a typo can't spawn
    a runaway number of task stacks."""
    v = _availability_int(
        "availability__outer_concurrency",
        int(AVAILABILITY_DEFAULTS["availability__outer_concurrency"]),
    )
    return max(1, min(v, AVAILABILITY_OUTER_CONCURRENCY_MAX))


def get_rdap_proxies() -> list[str]:
    """Parsed, normalized list of RDAP egress proxy URLs (added
    2026-06-15). The raw setting is a free-form list separated by
    newlines / commas / whitespace; each entry is normalized to a full
    proxy URL the RDAP pool can hand to httpx:

      - bare ``host:port``            → ``http://host:port``
      - ``http://`` / ``https://`` / ``socks5://`` / ``socks5h://``  → kept
      - anything else (unparseable scheme) is dropped

    Order is preserved and duplicates removed so the round-robin is
    deterministic. Empty config → [] (RDAP runs direct)."""
    raw = _availability_str("availability__rdap__proxies", "")
    if not raw.strip():
        return []
    out: list[str] = []
    seen: set[str] = set()
    # Split on any whitespace OR comma; tolerates one-per-line or CSV.
    import re as _re
    for tok in _re.split(r"[\s,]+", raw.strip()):
        tok = tok.strip()
        if not tok:
            continue
        url = _normalize_proxy_token(tok)
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _normalize_proxy_token(tok: str) -> str | None:
    """Normalize one proxy entry to a URL httpx accepts, or None to drop
    it. Handles the formats proxy providers actually export:

      - ``http://…`` / ``https://…`` / ``socks5://…`` / ``socks5h://…``
        → kept as-is.
      - ``user:pass@host:port``      → ``http://user:pass@host:port``.
      - ``host:port``                → ``http://host:port``.
      - ``host:port:user:pass``      → ``http://user:pass@host:port``
        (the super-common colon-separated export, e.g. Webshare/IPRoyal;
        password may itself contain ``:``). Credentials are URL-encoded so
        special characters don't break the URL.

    Anything else (unsupported scheme, 1- or 3-part tokens) → None."""
    from urllib.parse import quote
    low = tok.lower()
    if low.startswith(("http://", "https://", "socks5://", "socks5h://")):
        return tok
    if "://" in tok:
        return None  # some scheme we don't support
    if "@" in tok:
        return f"http://{tok}"  # already creds@host:port
    parts = tok.split(":")
    if len(parts) == 2:
        host, port = parts
        return f"http://{host}:{port}"
    if len(parts) >= 4:
        host, port, user = parts[0], parts[1], parts[2]
        pwd = ":".join(parts[3:])  # tolerate ':' inside the password
        return f"http://{quote(user, safe='')}:{quote(pwd, safe='')}@{host}:{port}"
    return None  # 1 or 3 parts → ambiguous, skip


def get_cache_ttl_hours() -> int:
    return max(_availability_int(
        "availability__cache_ttl_hours",
        int(AVAILABILITY_DEFAULTS["availability__cache_ttl_hours"]),
    ), 0)


def get_skip_registered_policy() -> dict:
    return {
        "enabled": _availability_bool(
            "availability__skip_registered",
            AVAILABILITY_DEFAULTS["availability__skip_registered"] == "true",
        ),
        "horizon_days": max(_availability_int(
            "availability__skip_horizon_days",
            int(AVAILABILITY_DEFAULTS["availability__skip_horizon_days"]),
        ), 0),
    }


# --- Retention prune for availability_checks ------------------------------
# Both reads clamp to non-negative and apply sane upper bounds — a
# misconfigured value (left over from a past wider range, or a hostile
# input that slipped past validation) can't break the prune job.
AVAILABILITY_RETENTION_DAYS_MAX = 3650  # 10 years — basically "never" without sentinel
AVAILABILITY_PER_DOMAIN_KEEP_MAX = 10_000


def get_availability_retention_days() -> int:
    """0 = never prune by age. Otherwise N days back from now."""
    v = _availability_int(
        "availability__retention_days",
        int(AVAILABILITY_DEFAULTS["availability__retention_days"]),
    )
    return max(0, min(v, AVAILABILITY_RETENTION_DAYS_MAX))


def get_availability_per_domain_keep() -> int:
    """0 = no per-domain cap. Otherwise keep most-recent M rows."""
    v = _availability_int(
        "availability__per_domain_keep",
        int(AVAILABILITY_DEFAULTS["availability__per_domain_keep"]),
    )
    return max(0, min(v, AVAILABILITY_PER_DOMAIN_KEEP_MAX))


def get_vacuum_enabled() -> bool:
    """Monthly VACUUM toggle. Default ON. The scheduler reads this on
    every cron fire so the user can turn it off without a restart."""
    db = SessionLocal()
    try:
        raw = (_get(db, "db_maintenance__vacuum_enabled") or "").strip().lower()
    finally:
        db.close()
    if raw == "":
        return DB_MAINTENANCE_DEFAULTS["db_maintenance__vacuum_enabled"] == "true"
    return raw in ("true", "1", "yes", "on")


def set_vacuum_enabled(enabled: bool) -> bool:
    db = SessionLocal()
    try:
        _set(db, "db_maintenance__vacuum_enabled", "true" if enabled else "false")
    finally:
        db.close()
    return enabled


def set_availability_setting(key: str, value: str) -> None:
    """Validated setter. Raises ValueError on unknown keys or invalid
    values; the route handler turns that into HTTP 400."""
    if key not in AVAILABILITY_DEFAULTS:
        raise ValueError(f"unknown availability key: {key}")
    if key.endswith("__rps"):
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 1:
            raise ValueError(f"{key} must be ≥ 1")
        if n > AVAILABILITY_RPS_CEILING:
            n = AVAILABILITY_RPS_CEILING
        value = str(n)
    elif key.endswith("__max_concurrent") or key.endswith("__hours") or key.endswith("__days"):
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 0:
            raise ValueError(f"{key} must be ≥ 0")
        value = str(n)
    elif key.endswith("__enabled") or key == "availability__skip_registered":
        v = value.strip().lower()
        if v not in ("true", "false"):
            raise ValueError(f"{key} must be true|false")
        value = v
    elif key == "availability__cascade_order":
        cleaned = []
        for p in value.split(","):
            p = p.strip().lower()
            if p in AVAILABILITY_PROVIDER_NAMES and p not in cleaned:
                cleaned.append(p)
        if not cleaned:
            raise ValueError("cascade order needs at least one provider")
        value = ",".join(cleaned)
    elif key == "availability__per_domain_keep":
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 0:
            raise ValueError(f"{key} must be ≥ 0 (0 = unlimited)")
        if n > AVAILABILITY_PER_DOMAIN_KEEP_MAX:
            n = AVAILABILITY_PER_DOMAIN_KEEP_MAX
        value = str(n)
    elif key == "availability__rdap__proxies":
        # Free-form list — stored raw (just trim outer whitespace).
        # Per-line normalization + validation happens at read time in
        # `get_rdap_proxies()` so a malformed line can't 400 the whole save.
        value = value.strip()
    elif key == "availability__outer_concurrency":
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 1:
            raise ValueError(f"{key} must be ≥ 1")
        if n > AVAILABILITY_OUTER_CONCURRENCY_MAX:
            n = AVAILABILITY_OUTER_CONCURRENCY_MAX
        value = str(n)
    db = SessionLocal()
    try:
        _set(db, key, value)
    finally:
        db.close()


def all_ai_prompts() -> list[dict]:
    """For the Settings page — current effective prompt + whether it's
    customized + the default for "Reset" UX."""
    from .ai_prompts import PROMPT_KEYS

    db = SessionLocal()
    try:
        out = []
        for key, default in PROMPT_KEYS.items():
            override = _get(db, _prompt_key(key))
            is_custom = bool(override)
            out.append(
                {
                    "key": key,
                    "value": override if is_custom else default,
                    "default": default,
                    "is_custom": is_custom,
                }
            )
        return out
    finally:
        db.close()


# --- Wayback classify → Ahrefs context (added 2026-05-13) -------------------
# When enabled, the Ahrefs B/A/K judges receive a "Site context" block built
# from the rd's wayback_classify CR verdict (theme, category, language, ...).
# Helps the judges flag PBN-style theme mismatches (e.g. "pet care site with
# backlinks from gambling/loan domains").
#
# Stored as one JSON blob under `classify_context_config`. Missing/empty row
# falls back to DEFAULT_CLASSIFY_CONTEXT_CONFIG (feature ON, criteria =
# B/A/K, fields = all 9 classify outputs). refdomains defaults OFF because
# refdomain rows lack anchors/snippets — the judge would hallucinate theme
# inferences. The user can opt refdomains in from Settings.
CLASSIFY_CONTEXT_CONFIG_KEY = "classify_context_config"

_CLASSIFY_CONTEXT_ALLOWED_CRITERIA: tuple[str, ...] = (
    "backlinks", "refdomains", "anchors", "keywords",
)
_CLASSIFY_CONTEXT_ALLOWED_FIELDS: tuple[str, ...] = (
    "primary_theme",
    "category",
    "theme_confidence",
    "category_confidence",
    "primary_language",
    "secondary_themes",
    "secondary_languages",
    "drift_detected",
    "category_was",
)

DEFAULT_CLASSIFY_CONTEXT_CONFIG: dict = {
    "enabled": True,
    # refdomains deliberately omitted from defaults — see module docstring.
    "criteria": ["backlinks", "anchors", "keywords"],
    "fields": list(_CLASSIFY_CONTEXT_ALLOWED_FIELDS),
}


def get_classify_context_config() -> dict:
    """Effective classify-context config. Always returns the full shape
    (every key present); partial DB overrides merge on top of defaults."""
    db = SessionLocal()
    try:
        raw = _get(db, CLASSIFY_CONTEXT_CONFIG_KEY) or ""
    finally:
        db.close()
    out = {
        "enabled": bool(DEFAULT_CLASSIFY_CONTEXT_CONFIG["enabled"]),
        "criteria": list(DEFAULT_CLASSIFY_CONTEXT_CONFIG["criteria"]),
        "fields": list(DEFAULT_CLASSIFY_CONTEXT_CONFIG["fields"]),
    }
    if not raw:
        return out
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return out
    if not isinstance(parsed, dict):
        return out
    if "enabled" in parsed:
        out["enabled"] = bool(parsed["enabled"])
    crits = parsed.get("criteria")
    if isinstance(crits, list):
        # Preserve allowed-list order so two installs with the same
        # underlying set produce identical fields_sent sentinels (and thus
        # identical cache keys). User toggle order in the UI doesn't
        # affect hashing.
        seen = {c for c in crits if isinstance(c, str)}
        out["criteria"] = [
            c for c in _CLASSIFY_CONTEXT_ALLOWED_CRITERIA if c in seen
        ]
    flds = parsed.get("fields")
    if isinstance(flds, list):
        seen_f = {f for f in flds if isinstance(f, str)}
        out["fields"] = [
            f for f in _CLASSIFY_CONTEXT_ALLOWED_FIELDS if f in seen_f
        ]
    return out


def set_classify_context_config(cfg: dict) -> dict:
    """Validate + persist. Caller may pass a partial dict — only provided
    keys update; the rest stay at current effective values. Unknown
    criteria / fields are silently dropped (forward-compat).
    Returns the new effective config."""
    if not isinstance(cfg, dict):
        raise ValueError("config must be an object")
    current = get_classify_context_config()
    new_enabled = current["enabled"]
    new_criteria = list(current["criteria"])
    new_fields = list(current["fields"])
    if "enabled" in cfg:
        new_enabled = bool(cfg["enabled"])
    if "criteria" in cfg:
        crits = cfg["criteria"]
        if not isinstance(crits, list):
            raise ValueError("criteria must be a list")
        seen = {c for c in crits if isinstance(c, str)}
        new_criteria = [
            c for c in _CLASSIFY_CONTEXT_ALLOWED_CRITERIA if c in seen
        ]
    if "fields" in cfg:
        flds = cfg["fields"]
        if not isinstance(flds, list):
            raise ValueError("fields must be a list")
        seen_f = {f for f in flds if isinstance(f, str)}
        new_fields = [
            f for f in _CLASSIFY_CONTEXT_ALLOWED_FIELDS if f in seen_f
        ]
    out = {
        "enabled": new_enabled,
        "criteria": new_criteria,
        "fields": new_fields,
    }
    db = SessionLocal()
    try:
        _set(db, CLASSIFY_CONTEXT_CONFIG_KEY, json.dumps(out))
    finally:
        db.close()
    return out


def reset_classify_context_config() -> dict:
    db = SessionLocal()
    try:
        _set(db, CLASSIFY_CONTEXT_CONFIG_KEY, "")
    finally:
        db.close()
    return get_classify_context_config()


# --- Whois History pillar (added Wave 2, 2026-05-15) -----------------------
#
# Settings for the new whois_history pillar. The API key is the secret
# bit (Fernet-encrypted at rest via `crypto.key_is_secret(...)` which
# matches the `__api_key` suffix); everything else is plain int/string.
#
# Default provider is `whoisfreaks` so a fresh deploy works the moment
# the operator drops a key into Settings — no extra provider toggle
# needed. The dispatch in `whois_history/fetcher.py` falls back to
# WhoisFreaks when the value is empty.

WHOIS_HISTORY_DEFAULTS = {
    "whois_history__provider": "whoisfreaks",
    "whois_history__max_records": "100",
    "whois_history__coverage_gap_threshold_days": "30",
    # Drop-confidence threshold the UI uses for the green "high
    # confidence: dropped" chip. Verdicts at-or-above this score get
    # the chip + are eligible for the Backlog "send to Quality" bulk
    # filter. 0.8 is a reasonable conservative default.
    "whois_history__drop_confidence_threshold": "0.8",
    # Units billed per provider request (Wave 2b, added 2026-05-15).
    # WhoisFreaks's pricing differs by plan tier — some plans bill 1
    # unit per request, others 2+. Default 1; operator sets the real
    # number from their plan dashboard. Used purely for display (the
    # Whois request pill shows "N units"); doesn't affect quota math
    # since WhoisFreaks bills server-side regardless of what we count.
    "whois_history__units_per_request": "1",
}
WHOIS_HISTORY_MAX_RECORDS_CEILING = 500
WHOIS_HISTORY_UNITS_PER_REQUEST_CEILING = 100


def get_whois_history_provider() -> str:
    """Provider name used by the fetcher. Defaults to 'whoisfreaks'."""
    db = SessionLocal()
    try:
        raw = (_get(db, "whois_history__provider") or "").strip()
    finally:
        db.close()
    return raw or "whoisfreaks"


def get_whois_history_api_key() -> str:
    """API key for the configured provider. Today only WhoisFreaks is
    wired; the key suffix `__api_key` triggers Fernet encryption at
    rest (see `crypto.key_is_secret`)."""
    provider = get_whois_history_provider()
    db = SessionLocal()
    try:
        # Per-provider key naming convention: `<provider>__api_key`.
        # Mirrors the existing AI / Ahrefs / Domainr settings keys.
        raw = (_get(db, f"{provider}__api_key") or "").strip()
    finally:
        db.close()
    return raw


def set_whois_history_api_key(value: str) -> None:
    """Persist the API key for the currently-configured provider.
    Empty string clears the credential."""
    provider = get_whois_history_provider()
    db = SessionLocal()
    try:
        _set(db, f"{provider}__api_key", value or "")
    finally:
        db.close()


def get_whois_history_max_records() -> int:
    """Soft cap on history depth per domain. Clamped to [1, 500]."""
    db = SessionLocal()
    try:
        raw = (_get(db, "whois_history__max_records") or "").strip()
    finally:
        db.close()
    try:
        v = int(raw) if raw else int(
            WHOIS_HISTORY_DEFAULTS["whois_history__max_records"]
        )
    except ValueError:
        v = int(WHOIS_HISTORY_DEFAULTS["whois_history__max_records"])
    return max(1, min(WHOIS_HISTORY_MAX_RECORDS_CEILING, v))


def get_whois_history_coverage_gap_threshold() -> int:
    """Days of "no snapshots" between consecutive records that the
    diff computer treats as a hard drop signal. Clamped to [1, 365]."""
    db = SessionLocal()
    try:
        raw = (
            _get(db, "whois_history__coverage_gap_threshold_days") or ""
        ).strip()
    finally:
        db.close()
    try:
        v = int(raw) if raw else int(
            WHOIS_HISTORY_DEFAULTS["whois_history__coverage_gap_threshold_days"]
        )
    except ValueError:
        v = int(
            WHOIS_HISTORY_DEFAULTS["whois_history__coverage_gap_threshold_days"]
        )
    return max(1, min(365, v))


def get_whois_history_units_per_request() -> int:
    """How many provider-plan units each WhoisFreaks request consumes.
    Defaults to 1 (free / starter tier); operators on higher tiers set
    the actual value. Clamped to [1, WHOIS_HISTORY_UNITS_PER_REQUEST_CEILING]."""
    db = SessionLocal()
    try:
        raw = (
            _get(db, "whois_history__units_per_request") or ""
        ).strip()
    finally:
        db.close()
    try:
        v = int(raw) if raw else int(
            WHOIS_HISTORY_DEFAULTS["whois_history__units_per_request"]
        )
    except ValueError:
        v = int(WHOIS_HISTORY_DEFAULTS["whois_history__units_per_request"])
    return max(1, min(WHOIS_HISTORY_UNITS_PER_REQUEST_CEILING, v))


def get_whois_history_drop_threshold() -> float:
    """Float in [0, 1]. AI verdicts whose `dropped_confidence` >= this
    threshold get the green "high confidence: dropped" chip in the UI
    and are eligible for the Backlog 'send-passers-to-Quality' bulk
    filter."""
    db = SessionLocal()
    try:
        raw = (
            _get(db, "whois_history__drop_confidence_threshold") or ""
        ).strip()
    finally:
        db.close()
    try:
        v = float(raw) if raw else float(
            WHOIS_HISTORY_DEFAULTS["whois_history__drop_confidence_threshold"]
        )
    except ValueError:
        v = float(
            WHOIS_HISTORY_DEFAULTS["whois_history__drop_confidence_threshold"]
        )
    return max(0.0, min(1.0, v))


def get_whois_history_config() -> dict:
    """Bundle of all whois_history settings for the Settings UI to
    render in one shot. Mirrors `get_availability_config()` shape."""
    # Rate limits are stored against the *concrete* provider name so
    # a future provider swap (DomainTools / WhoisXMLAPI) lands its own
    # row rather than inheriting WhoisFreaks's tuning. Today only
    # WhoisFreaks is wired so this always reads from there.
    rl = get_rate_limits(get_whois_history_provider())
    return {
        "provider": get_whois_history_provider(),
        "api_key_set": bool(get_whois_history_api_key()),
        "max_records": get_whois_history_max_records(),
        "coverage_gap_threshold_days": (
            get_whois_history_coverage_gap_threshold()
        ),
        "drop_confidence_threshold": get_whois_history_drop_threshold(),
        "units_per_request": get_whois_history_units_per_request(),
        "rate_limits": {
            "rpm": rl["rpm"],
            "max_concurrent": rl["max_concurrent"],
        },
    }


def set_whois_history_setting(key: str, value: str) -> None:
    """Validated setter for the non-secret knobs. Raises ValueError
    on unknown keys or invalid values; the route handler turns that
    into HTTP 400."""
    if key not in WHOIS_HISTORY_DEFAULTS:
        raise ValueError(f"unknown whois_history key: {key}")
    if key == "whois_history__max_records":
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 1 or n > WHOIS_HISTORY_MAX_RECORDS_CEILING:
            raise ValueError(
                f"{key} must be between 1 and {WHOIS_HISTORY_MAX_RECORDS_CEILING}"
            )
        value = str(n)
    elif key == "whois_history__coverage_gap_threshold_days":
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 1 or n > 365:
            raise ValueError(f"{key} must be between 1 and 365")
        value = str(n)
    elif key == "whois_history__drop_confidence_threshold":
        try:
            f = float(value)
        except ValueError as e:
            raise ValueError(f"{key} must be a number") from e
        if f < 0 or f > 1:
            raise ValueError(f"{key} must be between 0 and 1")
        value = f"{f:.4f}".rstrip("0").rstrip(".")
        if not value:
            value = "0"
    elif key == "whois_history__units_per_request":
        try:
            n = int(value)
        except ValueError as e:
            raise ValueError(f"{key} must be an integer") from e
        if n < 1 or n > WHOIS_HISTORY_UNITS_PER_REQUEST_CEILING:
            raise ValueError(
                f"{key} must be between 1 and "
                f"{WHOIS_HISTORY_UNITS_PER_REQUEST_CEILING}"
            )
        value = str(n)
    elif key == "whois_history__provider":
        if value not in ("whoisfreaks",):
            raise ValueError(
                f"unknown provider {value!r}; only 'whoisfreaks' is "
                f"supported today"
            )
    db = SessionLocal()
    try:
        _set(db, key, value)
    finally:
        db.close()
