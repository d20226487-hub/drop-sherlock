"""Coverage for blocked multi-label suffixes (added 2026-09-28).

Motivating case: NIC Panama leaves `.com.pa` / `.nom.pa` open to anyone
but restricts `.net.pa`, so a `.net.pa` drop can never be completed and
analysing one burns Ahrefs units. The parent ccTLD `pa` must stay
allowed, so the allowed-TLD whitelist cannot express this, and a keyword
cannot either -- keywords match a substring anywhere, so "net.pa" would
also swallow "magnet.paris". Hence a rule anchored to a label boundary
at the END of the domain.
"""
from __future__ import annotations

from app.domain_filter import build_matcher, normalize_suffix, normalize_suffixes


def _m(suffixes, *, tlds=None, keywords=()):
    """Matcher with the TLD whitelist OFF unless `tlds` is given, so the
    suffix rule is tested in isolation -- the TLD check short-circuits
    before it and would otherwise mask the result."""
    return build_matcher(
        keywords=list(keywords),
        allowed_tlds=tlds,
        tld_whitelist_enabled=tlds is not None,
        blocked_suffixes=suffixes,
    )


# --- normalisation ---------------------------------------------------------


def test_suffix_is_lowercased_and_stripped():
    assert normalize_suffix("  .NET.PA  ") == "net.pa"
    assert normalize_suffix("net.pa.") == "net.pa"


def test_single_label_is_rejected():
    # "pa" is a TLD and belongs in the allowed-TLD whitelist. Accepting it
    # here would silently block an entire ccTLD from a field meant for one
    # second level.
    assert normalize_suffix("pa") is None
    assert normalize_suffix(".pa") is None


def test_garbage_suffixes_are_dropped():
    assert normalize_suffix("") is None
    assert normalize_suffix("   ") is None
    assert normalize_suffix(None) is None
    assert normalize_suffix(123) is None
    assert normalize_suffix("net .pa") is None      # whitespace inside
    assert normalize_suffix("a." + "x" * 200) is None  # over-long


def test_suffix_list_dedupes_and_preserves_order():
    assert normalize_suffixes([".NET.PA", "org.pa", "net.pa"]) == [
        "net.pa", "org.pa",
    ]
    assert normalize_suffixes("not a list") == []


# --- matching --------------------------------------------------------------


def test_restricted_suffix_is_blocked():
    m = _m(["net.pa"])
    assert m("red.net.pa") == "suffix"
    assert m("a.b.net.pa") == "suffix"


def test_the_bare_suffix_itself_is_blocked():
    assert _m(["net.pa"])("net.pa") == "suffix"


def test_sibling_second_levels_still_pass():
    # The whole point: Panama's OPEN second levels must survive.
    m = _m(["net.pa"])
    assert m("canal.com.pa") is None
    assert m("algo.nom.pa") is None
    assert m("tienda.pa") is None


def test_substring_trap_is_not_triggered():
    """THE regression guard. A keyword of "net.pa" matches a substring
    anywhere and wrongly catches these; the suffix rule must not."""
    m = _m(["net.pa"])
    assert m("magnet.paris") is None
    assert m("telnet.parts") is None
    assert m("sunnet.pa") is None      # no label boundary before "net"
    assert m("x.net.pa.com") is None   # not at the END


def test_a_keyword_would_have_been_wrong():
    """Pins the rationale in the docstring: this is why the feature is not
    just 'add net.pa to the stop keywords'."""
    kw = build_matcher(
        keywords=["net.pa"], allowed_tlds=None, tld_whitelist_enabled=False,
    )
    assert kw("magnet.paris") == "keyword"   # false positive
    assert kw("red.net.pa") == "keyword"


def test_matching_is_case_and_www_insensitive():
    m = _m(["net.pa"])
    assert m("WWW.Red.NET.PA") == "suffix"


def test_empty_suffix_list_blocks_nothing():
    m = _m([])
    assert m("red.net.pa") is None
    assert _m(None)("red.net.pa") is None


def test_multiple_suffixes_all_apply():
    m = _m(["net.pa", "org.pa"])
    assert m("a.net.pa") == "suffix"
    assert m("b.org.pa") == "suffix"
    assert m("c.com.pa") is None


# --- interaction with the other two rules ----------------------------------


def test_tld_whitelist_still_wins_first():
    # Cheap-first ordering: a domain whose TLD isn't allowed is rejected
    # as "tld" before the suffix check ever runs.
    m = _m(["net.pa"], tlds=["com"])
    assert m("red.net.pa") == "tld"


def test_suffix_is_checked_before_keywords():
    m = _m(["net.pa"], keywords=["red"])
    assert m("red.net.pa") == "suffix"


def test_keyword_still_fires_on_allowed_suffixes():
    m = _m(["net.pa"], keywords=["casino"])
    assert m("casino.com.pa") == "keyword"
