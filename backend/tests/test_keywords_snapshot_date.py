"""Coverage for the organic-keywords snapshot date (added 2026-10-26).

Ahrefs `organic-keywords` REQUIRES a `date`. Both the K criterion and the
Stop Words keyword source previously hardcoded today, which is the wrong
question for this tool: a dropped domain is already deindexed, so today's
snapshot is empty and the criterion reported "no keywords" — and Stop
Words reported "clean" — for a domain that ranked for the banned terms
for years.

This is NOT `date_compared`. That keeps the snapshot on today and adds
prior-period `_prev` columns; it cannot look at the past by itself.
Tests here pin that `date` actually moves.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from app.cache import compute_params_hash
from app.providers.ahrefs_requests import (
    build_stop_words_requests,
    normalize_snapshot_date,
)
from app.schemas import KeywordsConfig, StopWordsConfig

TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
PAST = "2023-06-15"
FUTURE = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")


def _params(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


# --- validation ------------------------------------------------------------


def test_valid_past_date_is_accepted_and_trimmed():
    assert normalize_snapshot_date(PAST) == PAST
    assert normalize_snapshot_date("  %s  " % PAST) == PAST


def test_blank_means_today():
    assert normalize_snapshot_date("") == ""
    assert normalize_snapshot_date("   ") == ""


def test_future_date_is_rejected():
    """A future date has no Ahrefs data, and an empty result looks exactly
    like a legitimately dead domain — the failure this feature removes."""
    assert normalize_snapshot_date(FUTURE) == ""


def test_malformed_input_is_rejected():
    for bad in ("15/06/2023", "2023-13-45", "yesterday", None, 20230615, []):
        assert normalize_snapshot_date(bad) == "", bad


# --- the K criterion -------------------------------------------------------


def _kw_url(**kw):
    from app.providers.ahrefs_requests import _preview_keywords
    cfg = KeywordsConfig(enabled=True, limit=10, **kw)
    return _params(_preview_keywords("example.com", cfg).url)


def test_keywords_defaults_to_today():
    assert _kw_url()["date"] == TODAY


def test_keywords_uses_the_chosen_date():
    assert _kw_url(date=PAST)["date"] == PAST


def test_keywords_future_date_falls_back_to_today():
    assert _kw_url(date=FUTURE)["date"] == TODAY


def test_date_and_date_compared_are_independent():
    """date moves the snapshot; date_compared only annotates it. Both can
    be set, and date_compared must NOT overwrite date."""
    p = _kw_url(date=PAST, date_compared="1y")
    assert p["date"] == PAST
    assert "date_compared" in p and p["date_compared"] != PAST


def test_date_compared_is_anchored_on_the_snapshot_not_today():
    """Regression guard. The delta used to be measured from now(), which
    was invisible while `date` was locked to today but produces a
    comparison point AFTER the snapshot once the date is selectable."""
    p = _kw_url(date=PAST, date_compared="1y")
    assert p["date_compared"] < p["date"], (
        "comparison point must PRECEDE the snapshot, got %s vs %s"
        % (p["date_compared"], p["date"])
    )
    assert p["date_compared"].startswith("2022-")


def test_date_compared_still_uses_today_when_no_date_is_set():
    """Unchanged behaviour for the default live mode."""
    p = _kw_url(date_compared="1y")
    assert p["date"] == TODAY
    assert p["date_compared"] < p["date"]


# --- the Stop Words keyword source ----------------------------------------


def _sw(**kw):
    cfg = StopWordsConfig(
        enabled=True, terms=["casino", "porn"], anchor_limit=5,
        keyword_limit=5, **kw,
    )
    return build_stop_words_requests("example.com", cfg)


def test_stop_words_keywords_default_to_today():
    reqs = [r for r in _sw(source="keywords")]
    assert reqs and all(_params(r.url)["date"] == TODAY for r in reqs)


def test_stop_words_keywords_use_the_chosen_date():
    reqs = _sw(source="keywords", keyword_date=PAST)
    assert reqs and all(_params(r.url)["date"] == PAST for r in reqs)


def test_stop_words_anchors_never_get_a_date():
    """Backlinks persist after a site dies, so the anchors endpoint is not
    a dated snapshot and must not receive the parameter."""
    for r in _sw(source="anchors", keyword_date=PAST):
        assert "date" not in _params(r.url)


def test_both_sources_only_dates_the_keyword_half():
    reqs = _sw(source="both", keyword_date=PAST)
    by_source = {}
    for r in reqs:
        by_source.setdefault(r.source, []).append(_params(r.url))
    assert all("date" not in p for p in by_source["anchors"])
    assert all(p["date"] == PAST for p in by_source["keywords"])


# --- cache correctness -----------------------------------------------------


def test_blank_date_keeps_the_pre_feature_keywords_hash():
    """Rows cached before this field existed must keep matching."""
    a = compute_params_hash("keywords", KeywordsConfig(enabled=True, limit=10))
    b = compute_params_hash(
        "keywords", KeywordsConfig(enabled=True, limit=10, date=""))
    assert a == b


def test_a_chosen_date_busts_the_keywords_cache():
    live = compute_params_hash(
        "keywords", KeywordsConfig(enabled=True, limit=10))
    hist = compute_params_hash(
        "keywords", KeywordsConfig(enabled=True, limit=10, date=PAST))
    other = compute_params_hash(
        "keywords", KeywordsConfig(enabled=True, limit=10, date="2022-01-01"))
    assert live != hist != other and live != other


def test_blank_date_keeps_the_pre_feature_stop_words_hash():
    base = dict(enabled=True, terms=["casino"], anchor_limit=5, keyword_limit=5)
    a = compute_params_hash("stop_words", StopWordsConfig(**base))
    b = compute_params_hash("stop_words", StopWordsConfig(keyword_date="", **base))
    assert a == b


def test_a_chosen_date_busts_the_stop_words_cache():
    base = dict(enabled=True, terms=["casino"], anchor_limit=5, keyword_limit=5)
    live = compute_params_hash("stop_words", StopWordsConfig(**base))
    hist = compute_params_hash(
        "stop_words", StopWordsConfig(keyword_date=PAST, **base))
    assert live != hist
