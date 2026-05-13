"""Settings router — credential CRUD, test-connection, rate-limit CRUD."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..app_settings import (
    AI_PROVIDERS_FOR_MODELS,
    DEFAULT_SCORING_CONFIG,
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
    }


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
