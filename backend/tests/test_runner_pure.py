"""Pure-function coverage for the runner's most error-prone helpers.

These functions don't touch the DB, the AI providers, or HTTP — they're
the ones whose subtle invariants (cache-key stability, language-directive
plumbing, augmentation set math, JSON repair) silently break the system
when someone "refactors" them. Each test names the invariant it's
guarding so a future regression has a paper trail.

Scope intentionally narrow: we're not unit-testing the full runner here
(that needs a real DB + a fake AI provider — bigger lift). The pure
helpers are the cheap-to-test, high-value layer.
"""
from __future__ import annotations

import json

import pytest

from app.ai_judge import parse_json_response
from app.ai_prompts import (
    BACKLINKS_PROMPT,
    PROMPT_KEYS,
    localize_prompt,
)
from app.augmentation import _enabled_set_from_spec
from app.cache import compute_params_hash, compute_prompt_hash
from app.schemas import (
    AnalyzeSpec,
    AnchorsConfig,
    BacklinksConfig,
    BacklinksFilters,
    CriteriaSpec,
    KeywordsConfig,
    RefdomainsConfig,
    SortRule,
    WaybackClassifyConfig,
    WaybackConfig,
)


# --- localize_prompt -------------------------------------------------------

def test_localize_prompt_en_is_noop():
    """EN must NOT mutate the prompt — we depend on the EN path being
    byte-identical to the editable Settings prompt so prompt_hash on EN
    runs continues to match cache rows written before lang existed."""
    assert localize_prompt("X", "en") == "X"
    # Unknown lang values fall back to EN behavior (safe default).
    assert localize_prompt("X", None) == "X"
    assert localize_prompt("X", "") == "X"
    assert localize_prompt("X", "de") == "X"


def test_localize_prompt_ru_appends_directive():
    """RU appends the directive at the END (not in the middle) so the
    JSON-schema block at the bottom of every prompt stays visible to the
    model."""
    out = localize_prompt("BODY", "ru")
    assert out.startswith("BODY")
    assert len(out) > len("BODY")
    # Directive contains the language name and an enum-preservation note;
    # both are load-bearing for verdict integrity.
    assert "русском" in out.lower() or "russian" in out.lower()
    assert "high_quality" in out  # enum literals must stay English


def test_localize_prompt_ru_changes_prompt_hash():
    """The prompt_hash MUST differ between EN and RU so a cached EN
    verdict never serves on a RU lookup. Without this, switching the UI
    to RU would silently return the prior English text from cache."""
    h_en = compute_prompt_hash(
        localize_prompt(BACKLINKS_PROMPT, "en"), "gemini", "gemini-2.5-flash",
    )
    h_ru = compute_prompt_hash(
        localize_prompt(BACKLINKS_PROMPT, "ru"), "gemini", "gemini-2.5-flash",
    )
    assert h_en != h_ru


def test_all_prompt_keys_localizable():
    """Every prompt the runner can fetch via get_ai_prompt() must round
    through localize_prompt cleanly. Catches the case where a future
    prompt is added to PROMPT_KEYS but the localizer fails on it (e.g.
    if the directive is ever made to assume specific schema fields)."""
    for key, body in PROMPT_KEYS.items():
        assert isinstance(body, str) and body, f"empty default for {key}"
        ru = localize_prompt(body, "ru")
        assert ru.endswith(localize_prompt("", "ru"))  # directive at tail
        assert body in ru


# --- compute_prompt_hash ---------------------------------------------------

def test_prompt_hash_changes_on_provider_swap():
    a = compute_prompt_hash("P", "gemini", "x")
    b = compute_prompt_hash("P", "openrouter", "x")
    assert a != b


def test_prompt_hash_changes_on_model_swap():
    a = compute_prompt_hash("P", "gemini", "gemini-2.5-flash")
    b = compute_prompt_hash("P", "gemini", "gemini-2.5-pro")
    assert a != b


def test_prompt_hash_treats_missing_model_as_empty():
    """`model=None` and `model=''` are equivalent — they both mean 'use
    the provider's default'. Hashing them differently would cause spurious
    cache misses on the very common 'no override' case."""
    a = compute_prompt_hash("P", "gemini", None)
    b = compute_prompt_hash("P", "gemini", "")
    assert a == b


def test_prompt_hash_fields_sent_backward_compatible():
    """Old callers passed no fields_sent; the hash must remain identical
    when fields_sent=None so pre-feature cache rows still match. New
    callers with a non-None list correctly diverge."""
    a = compute_prompt_hash("P", "gemini", "m")
    b = compute_prompt_hash("P", "gemini", "m", fields_sent=None)
    c = compute_prompt_hash("P", "gemini", "m", fields_sent=[])
    assert a == b
    # Empty list is meaningfully different from None — it means "the
    # feature is wired, but this criterion sends nothing".
    assert a != c


def test_prompt_hash_fields_sent_order_matters():
    """Field order shapes the user message (Python dict iteration order
    is insertion order). The hash must reflect that or two trim lists
    that produce different prompts will collide."""
    a = compute_prompt_hash("P", "g", "m", fields_sent=["a", "b"])
    b = compute_prompt_hash("P", "g", "m", fields_sent=["b", "a"])
    assert a != b


# --- compute_params_hash ---------------------------------------------------

def test_params_hash_stable_across_runs():
    """Two identical configs MUST produce the same hash on every call —
    this is the cache's whole foundation."""
    cfg = BacklinksConfig(
        limit=20,
        filters=BacklinksFilters(dofollow=True, non_spammy=True),
        sort=[SortRule(field="domain_rating_source", direction="desc")],
    )
    assert compute_params_hash("backlinks", cfg) == compute_params_hash(
        "backlinks", cfg,
    )


def test_params_hash_filters_change_busts_cache():
    base = BacklinksConfig(filters=BacklinksFilters(dofollow=True))
    flipped = BacklinksConfig(filters=BacklinksFilters(dofollow=False))
    assert compute_params_hash("backlinks", base) != compute_params_hash(
        "backlinks", flipped,
    )


def test_params_hash_aggregation_default_omitted():
    """Refdomains has no `aggregation` field; backlinks does. The hash
    contract: aggregation is only in the payload when it's non-default
    ('similar_links'), so pre-aggregation cache rows still match. We
    test by constructing two backlinks specs that differ only in
    aggregation = default vs non-default."""
    default = BacklinksConfig(aggregation="similar_links", limit=20)
    one_per = BacklinksConfig(aggregation="1_per_domain", limit=20)
    # Different — non-default IS in the hash.
    assert compute_params_hash("backlinks", default) != compute_params_hash(
        "backlinks", one_per,
    )


def test_params_hash_wayback_sample_pages_off_unchanged():
    """Wayback V2 sampling fields are only included when sample_pages is
    on. A user with the default Wayback config (sampling off) must keep
    hitting cache rows written before V2 existed."""
    plain = WaybackConfig(enabled=True, limit=100)
    h1 = compute_params_hash("wayback", plain)
    plain_again = WaybackConfig(
        enabled=True, limit=100, sample_count=12, sample_strategy="anchor",
    )
    # sample_pages is False → sample_count/strategy are NOT in the hash.
    assert h1 == compute_params_hash("wayback", plain_again)


def test_params_hash_wayback_sample_pages_on_busts_on_change():
    """When sampling IS on, changing the strategy/count/path-mode must
    bust the cache — the fetched data is materially different."""
    a = WaybackConfig(
        enabled=True, limit=100, sample_pages=True, sample_count=6,
        sample_strategy="even", sample_path_mode="mixed",
    )
    b = WaybackConfig(
        enabled=True, limit=100, sample_pages=True, sample_count=6,
        sample_strategy="anchor", sample_path_mode="mixed",
    )
    assert compute_params_hash("wayback", a) != compute_params_hash("wayback", b)


def test_params_hash_wayback_classify_keyed_only_on_language_mode():
    """wayback_classify has no fetch knobs — its params_hash exists
    purely to differentiate library vs ai language mode (which changes
    the prompt path AND whether language is overwritten by lingua)."""
    ai_mode = WaybackClassifyConfig(enabled=True, language_mode="ai")
    lib_mode = WaybackClassifyConfig(enabled=True, language_mode="library")
    assert compute_params_hash(
        "wayback_classify", ai_mode,
    ) != compute_params_hash("wayback_classify", lib_mode)


# --- augmentation: enabled-set extraction ---------------------------------

def _spec(enabled: dict[str, bool]) -> AnalyzeSpec:
    """Helper: build an AnalyzeSpec with only the named criteria enabled.
    Every criterion is explicitly set (the four Ahrefs ones default to
    enabled=True via CriterionBase, so omitting any would leave it on)."""
    return AnalyzeSpec(
        domains=["x.com"],
        criteria=CriteriaSpec(
            backlinks=BacklinksConfig(enabled=enabled.get("backlinks", False)),
            refdomains=RefdomainsConfig(enabled=enabled.get("refdomains", False)),
            anchors=AnchorsConfig(enabled=enabled.get("anchors", False)),
            keywords=KeywordsConfig(enabled=enabled.get("keywords", False)),
            wayback=WaybackConfig(enabled=enabled.get("wayback", False)),
        ),
    )


def test_enabled_set_only_returns_enabled_criteria():
    s = _spec({"backlinks": True, "wayback": True})
    assert _enabled_set_from_spec(s) == frozenset({"backlinks", "wayback"})


def test_enabled_set_excludes_wayback_classify():
    """`wayback_classify` is intentionally NOT in the augmentation set —
    augmentation tracks fetch-criteria coverage, not AI-only derivations.
    A run that only enables wayback_classify still has the same fetch
    surface as a wayback-only run."""
    s = _spec({"wayback": True})
    s.criteria.wayback_classify.enabled = True
    assert "wayback_classify" not in _enabled_set_from_spec(s)


def test_enabled_set_subset_relationship_holds():
    """Augmentation links a NEW run to a prior run when the new run's
    enabled set is a STRICT SUBSET of the prior. Test the set algebra."""
    parent = _enabled_set_from_spec(_spec({
        "backlinks": True, "refdomains": True, "wayback": True,
    }))
    child = _enabled_set_from_spec(_spec({"backlinks": True, "wayback": True}))
    assert child < parent
    assert not (parent < child)
    # Equal sets are NOT a strict subset — same coverage, not augmentation.
    same = _enabled_set_from_spec(_spec({
        "backlinks": True, "refdomains": True, "wayback": True,
    }))
    assert not (same < parent)


# --- parse_json_response ---------------------------------------------------

def test_parse_strips_json_fence():
    obj = parse_json_response('```json\n{"a": 1}\n```')
    assert obj == {"a": 1}


def test_parse_strips_bare_fence():
    obj = parse_json_response('```\n{"a": 1}\n```')
    assert obj == {"a": 1}


def test_parse_handles_extra_data_after_object():
    """Smaller models (esp. Gemma family) sometimes append a second JSON
    object or chain-of-thought trail after the answer. raw_decode must
    return only the first complete object."""
    obj = parse_json_response('{"a": 1}{"b": 2}')
    assert obj == {"a": 1}


def test_parse_handles_prose_then_json():
    obj = parse_json_response('Here is your answer: {"a": 1, "b": 2}')
    assert obj == {"a": 1, "b": 2}


def test_parse_handles_prose_around_json():
    obj = parse_json_response(
        'Here is your answer: {"a": 1} I hope this helps!',
    )
    assert obj == {"a": 1}


def test_parse_empty_raises():
    with pytest.raises(ValueError):
        parse_json_response("")


def test_parse_no_json_raises():
    with pytest.raises(ValueError):
        parse_json_response("definitely not json at all")


# --- prompt audit ----------------------------------------------------------

def test_prompt_audit_removed_set_covers_known_drops():
    """The per-criterion removed-columns map must include every column
    we've intentionally pulled out of SELECT_FIELDS. If you trim a
    column without adding it here, the audit can't flag customized
    prompts that still reference it."""
    from app.prompt_audit import _REMOVED_PER_CRITERION
    assert "is_spam" in _REMOVED_PER_CRITERION["backlinks"]
    assert "is_dofollow" in _REMOVED_PER_CRITERION["backlinks"]
    assert "link_type" in _REMOVED_PER_CRITERION["backlinks"]
    assert "is_spam" in _REMOVED_PER_CRITERION["refdomains"]
    assert "is_spam" in _REMOVED_PER_CRITERION["anchors"]
    assert "cpc" in _REMOVED_PER_CRITERION["keywords"]
    assert "best_position_url" in _REMOVED_PER_CRITERION["keywords"]


def test_app_settings_cache_invalidates_on_write():
    """The TTL cache short-circuits _get when a value is fresh, but a
    subsequent _set MUST invalidate the cache so the next read sees the
    written value. Without invalidation, Settings edits would silently
    take up to TTL seconds to take effect."""
    from unittest.mock import MagicMock
    from app import app_settings as ap

    ap._cache_clear()
    fake_db = MagicMock()
    # First call: cache miss → DB query.
    fake_db.get.return_value = MagicMock(value="alpha")
    assert ap._get(fake_db, "k") == "alpha"
    assert fake_db.get.call_count == 1
    # Second call: cache hit → no DB query.
    assert ap._get(fake_db, "k") == "alpha"
    assert fake_db.get.call_count == 1
    # Write invalidates.
    fake_db.get.return_value = MagicMock(value="beta")
    ap._set(fake_db, "k", "beta")
    # Third get: cache miss again → DB query, returns new value.
    assert ap._get(fake_db, "k") == "beta"
    ap._cache_clear()


def test_prompt_audit_does_not_flag_prose_words():
    """The audit must NOT flag column names that overlap with ordinary
    prose ('domain', 'anchor', 'traffic'). These are still valid current
    columns AND common English words — flagging them turns the audit
    into noise. Only columns in `_REMOVED_PER_CRITERION` should fire."""
    from app.prompt_audit import _REMOVED_PER_CRITERION
    for crit, removed in _REMOVED_PER_CRITERION.items():
        assert "domain" not in removed, f"{crit}: 'domain' must not be in removed set"
        assert "anchor" not in removed, f"{crit}: 'anchor' must not be in removed set"
        assert "traffic" not in removed, f"{crit}: 'traffic' must not be in removed set"
