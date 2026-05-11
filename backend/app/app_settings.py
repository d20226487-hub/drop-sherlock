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
SECRET_FIELDS = {"api_key", "token", "password"}


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

AI_PROVIDERS_FOR_MODELS = ("gemini", "github_models", "openrouter")


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
}


def _rate_key(provider: str, field: str) -> str:
    return f"rate_limit__{provider}__{field}"


def get_rate_limits(provider: str) -> dict[str, int]:
    if provider not in PROVIDER_FIELDS:
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
    if provider not in PROVIDER_FIELDS:
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


# --- Backlog CSV import row cap (added 2026-05-09) ------------------------
# User-configurable upper bound on rows accepted by `POST /backlog/import`
# (and the matching guard in the frontend CSV parser). Defaults to 50k —
# generous for a year's worth of auction lists. Hard limits are also
# enforced on the wire by Pydantic (`_IMPORT_MAX_ROWS_HARD_CAP` in the
# router) so a misconfigured DB value can't blow past sanity.
IMPORT_MAX_ROWS_KEY = "backlog_import_max_rows"
DEFAULT_IMPORT_MAX_ROWS = 50_000
IMPORT_MAX_ROWS_MIN = 100
IMPORT_MAX_ROWS_MAX = 500_000


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
