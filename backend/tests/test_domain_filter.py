"""Coverage for the reshaped import-time Domain Filter (2026-08-24).

The old filter was a ccTLD blacklist; the new one is stop-keywords
(substring, anywhere) + an allowed-TLD whitelist, applied at
/backlog/import over potentially millions of rows. The invariants worth
pinning:

  • the Aho-Corasick automaton finds a keyword anywhere in the name, and
    matches exactly what a naive "any(k in domain)" would — just faster,
  • the matcher is cheap-first (TLD reject before the keyword scan),
  • the legacy {"cctld": [...]} config migrates without crashing,
  • an empty config filters nothing (no accidental mass-exclusion).
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

from app.domain_filter import (
    AhoCorasick,
    build_matcher,
    normalize_keyword,
    normalize_keywords,
)


# --- normalization ---------------------------------------------------------

def test_normalize_keyword_lowercases_and_trims():
    assert normalize_keyword("  Casino ") == "casino"
    assert normalize_keyword("Free  Spins") == "free spins"  # inner ws collapsed
    assert normalize_keyword("") is None
    assert normalize_keyword("x" * 100) is None  # over the length cap
    assert normalize_keyword(5) is None


def test_normalize_keywords_dedups_sorts_lowercases():
    assert normalize_keywords(["Porn", "casino", "porn", "CASINO"]) == [
        "casino",
        "porn",
    ]
    assert normalize_keywords("casino") == []  # a bare string isn't a list


# --- Aho-Corasick correctness (vs the naive oracle) ------------------------

def test_aho_corasick_matches_substring_anywhere():
    ac = AhoCorasick(["casino", "bet", "porn"])
    assert ac.contains("mycasino")           # suffix
    assert ac.contains("casinobonus")        # prefix
    assert ac.contains("x-casino-y")         # middle
    assert ac.contains("alphabet")           # 'bet' inside — real substring hit
    assert not ac.contains("cleansite")
    assert not ac.contains("")


def test_aho_corasick_overlapping_and_shared_prefixes():
    # Patterns sharing prefixes exercise the fail-link folding.
    ac = AhoCorasick(["he", "she", "his", "hers"])
    assert ac.contains("ushers")   # contains 'she' and 'hers'
    assert ac.contains("this")     # 'his'
    assert not ac.contains("xyz")


def test_aho_corasick_matches_the_naive_oracle_on_random_input():
    import random
    import string
    random.seed(7)
    kws = ["".join(random.choices(string.ascii_lowercase, k=3)) for _ in range(40)]
    ac = AhoCorasick(kws)
    kset = set(kws)
    for _ in range(2000):
        text = "".join(random.choices(string.ascii_lowercase, k=random.randint(2, 12)))
        naive = any(k in text for k in kset)
        assert ac.contains(text) == naive, text


# --- build_matcher ---------------------------------------------------------

def test_keyword_reason():
    m = build_matcher(
        keywords=["casino"], allowed_tlds=None, tld_whitelist_enabled=False,
    )
    assert m("mycasino.io") == "keyword"
    assert m("cleansite.com") is None


def test_tld_whitelist_reason_and_cheap_first_order():
    # 'casino' keyword AND a non-allowed TLD → TLD wins (checked first, so
    # the keyword scan is skipped for the many non-allowed-TLD domains).
    m = build_matcher(
        keywords=["casino"],
        allowed_tlds=["com", "net"],
        tld_whitelist_enabled=True,
    )
    assert m("casino.xyz") == "tld"      # both bad → attributed to tld
    assert m("mycasino.com") == "keyword"  # allowed tld, keyword hits
    assert m("clean.com") is None
    assert m("clean.xyz") == "tld"


def test_tld_disabled_ignores_tld():
    m = build_matcher(
        keywords=["casino"], allowed_tlds=["com"], tld_whitelist_enabled=False,
    )
    assert m("clean.xyz") is None          # tld gate off
    assert m("mycasino.xyz") == "keyword"


def test_empty_config_filters_nothing():
    m = build_matcher(keywords=[], allowed_tlds=None, tld_whitelist_enabled=False)
    assert m("anything.xyz") is None
    assert m("casino.com") is None


def test_www_prefix_stripped_before_matching():
    m = build_matcher(
        keywords=[], allowed_tlds=["com"], tld_whitelist_enabled=True,
    )
    assert m("www.example.com") is None    # tld still resolves to com


# --- config get/set/migration (DB-backed) ----------------------------------

@pytest.fixture
def fresh_db(monkeypatch):
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp.name}")
    for name in list(sys.modules):
        if name.startswith("app."):
            del sys.modules[name]
    if "app" in sys.modules:
        del sys.modules["app"]
    from app import db as db_mod
    from app import models  # noqa: F401
    from app.main import _migrate_sqlite_columns
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
    _migrate_sqlite_columns()
    yield
    try:
        os.unlink(tmp.name)
    except OSError:
        pass


def test_config_defaults_tld_off(fresh_db):
    """TLD whitelist ships OFF — the default allowed list omits CIS ccTLDs
    the operator relies on, so defaulting it on would silently drop their
    .kz/.ru imports."""
    from app.app_settings import get_domain_filter
    cfg = get_domain_filter()
    assert cfg == {"keywords": [], "tld_whitelist_enabled": False}


def test_legacy_cctld_config_migrates(fresh_db):
    """Old stored shape {"cctld": [...]} must not crash — it drops the
    retired category and yields the new empty shape."""
    from app.app_settings import _normalize_domain_filter
    assert _normalize_domain_filter({"cctld": ["uk", "de"]}) == {
        "keywords": [],
        "tld_whitelist_enabled": False,
    }


def test_set_get_round_trip_and_matcher(fresh_db):
    from app.app_settings import (
        build_domain_filter_matcher,
        set_domain_filter,
    )
    cfg = set_domain_filter(
        {"keywords": ["Casino", "casino", "1XBET"], "tld_whitelist_enabled": False},
    )
    assert cfg["keywords"] == ["1xbet", "casino"]  # lower + dedup + sort
    assert cfg["tld_whitelist_enabled"] is False
    m = build_domain_filter_matcher(cfg)
    assert m("best-casino.io") == "keyword"
    assert m("1xbet.com") == "keyword"
    assert m("clean.com") is None
