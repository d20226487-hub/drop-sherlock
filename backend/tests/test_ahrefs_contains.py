"""Coverage for the Database page's "Ahrefs contains" filter
(added 2026-09-29).

Free-text, pipe-separated, OR'd, against a CHOSEN Ahrefs criterion:
backlinks (url_from), refdomains (domain), anchors (anchor) or keywords
(keyword). A domain is kept when ANY entry in that criterion contains
ANY term.

For backlinks the searched field is `url_from`, never `url_to` — url_to
is the analysed domain itself, so including it would make every escort
domain match "escort" and tell the operator nothing.
"""
from __future__ import annotations

import json

from app.routers.database import (
    DomainRow,
    _apply_domain_filters,
    _criterion_text_blob,
)

OFF = dict(
    verdicts=[], wayback_verdicts=[], stop_words_verdicts=[],
    whois_bands=[], availability=[], languages=[],
    language_match="primary", categories=[], criteria=[],
    notes="any", sources=[], statuses=[],
    wayback_conf_min=0.0, ahrefs_conf_min=0.0,
    dr_min=0.0, ref_domains_min=0.0,
    ahrefs_contains="", ahrefs_contains_in="backlinks",
    whois_cycles_max=0, max_price_min=0.0, max_price_max=0.0,
)


def _row(domain: str, urls) -> DomainRow:
    return DomainRow(
        domain=domain, total_runs=1,
        backlink_urls="\n".join(u.lower() for u in urls),
    )


def _names(rows, **kw):
    opts = dict(OFF)
    opts.update(kw)
    return [r.domain for r in _apply_domain_filters(rows, **opts)]


ROWS = [
    _row("a.kz", ["https://bigcasino.com/x", "https://news.example/y"]),
    _row("b.kz", ["https://pornhub-clone.net/z"]),
    _row("c.kz", ["https://legit-blog.org/post"]),
    _row("nodata.kz", []),
]


# --- extraction ------------------------------------------------------------


def test_extractor_pulls_url_from_lowercased():
    body = json.dumps({"backlinks": [
        {"url_from": "HTTPS://Example.COM/A", "url_to": "https://target.kz/"},
        {"url_from": "https://two.com/b"},
    ]})
    assert _criterion_text_blob("backlinks", body) == "https://example.com/a\nhttps://two.com/b"


def test_extractor_excludes_url_to():
    """The whole reason the filter is useful: url_to is the analysed
    domain, so including it would self-match every term in its name."""
    body = json.dumps({"backlinks": [
        {"url_from": "https://source.com/", "url_to": "https://escorts-eden.com/"},
    ]})
    assert "escorts-eden" not in _criterion_text_blob("backlinks", body)


def test_extractor_survives_garbage():
    assert _criterion_text_blob("backlinks", "") == ""
    assert _criterion_text_blob("backlinks", "{not json") == ""
    assert _criterion_text_blob("backlinks", json.dumps([1, 2])) == ""
    assert _criterion_text_blob("backlinks", json.dumps({"backlinks": "nope"})) == ""
    assert _criterion_text_blob("backlinks", json.dumps({"backlinks": [{}, {"url_from": ""}]})) == ""


# --- matching --------------------------------------------------------------


def test_blank_query_is_off():
    assert _names(ROWS, ahrefs_contains="") == [r.domain for r in ROWS]
    assert _names(ROWS, ahrefs_contains="   ") == [r.domain for r in ROWS]


def test_single_term_substring_match():
    assert _names(ROWS, ahrefs_contains="casino") == ["a.kz"]


def test_pipe_separated_terms_are_ord():
    assert _names(ROWS, ahrefs_contains="casino|porn") == ["a.kz", "b.kz"]


def test_match_is_case_insensitive():
    assert _names(ROWS, ahrefs_contains="CASINO") == ["a.kz"]
    assert _names(ROWS, ahrefs_contains="CaSiNo|PORN") == ["a.kz", "b.kz"]


def test_terms_are_trimmed_and_blanks_ignored():
    assert _names(ROWS, ahrefs_contains="  casino  ") == ["a.kz"]
    # Empty segments from sloppy typing must not match everything.
    assert _names(ROWS, ahrefs_contains="casino||") == ["a.kz"]
    assert _names(ROWS, ahrefs_contains="|") == [r.domain for r in ROWS]


def test_domains_without_backlink_data_are_hidden_when_set():
    assert "nodata.kz" not in _names(ROWS, ahrefs_contains="casino")
    assert "nodata.kz" in _names(ROWS, ahrefs_contains="")


def test_any_row_matching_keeps_the_domain():
    # a.kz's SECOND url is the non-matching one; first still wins.
    assert _names(ROWS, ahrefs_contains="news.example") == ["a.kz"]


def test_no_match_returns_nothing():
    assert _names(ROWS, ahrefs_contains="zzzznope") == []


def test_combines_with_other_filters_as_and():
    rows = [
        _row("hit.kz", ["https://casino.com/a"]),
        _row("miss.kz", ["https://casino.com/b"]),
    ]
    out = _names(rows, ahrefs_contains="casino")
    assert out == ["hit.kz", "miss.kz"]
    # Adding an unrelated active filter narrows it (no DR on either row).
    assert _names(rows, ahrefs_contains="casino", dr_min=10) == []


# --- the source selector ---------------------------------------------------


def _multi(domain: str, **blobs) -> DomainRow:
    return DomainRow(domain=domain, total_runs=1, **blobs)


MIXED = [
    _multi("bl.kz", backlink_urls="https://casino-source.com/x"),
    _multi("rd.kz", refdomain_names="casino-ref.net"),
    _multi("an.kz", anchor_texts="best casino bonus"),
    _multi("kw.kz", keyword_texts="online casino kz"),
]


def test_each_source_searches_only_its_own_criterion():
    for src, expected in [
        ("backlinks", "bl.kz"), ("refdomains", "rd.kz"),
        ("anchors", "an.kz"), ("keywords", "kw.kz"),
    ]:
        got = _names(MIXED, ahrefs_contains="casino", ahrefs_contains_in=src)
        assert got == [expected], "%s -> %s" % (src, got)


def test_unknown_source_falls_back_to_backlinks():
    """A stale bookmarked URL should degrade usefully, not match nothing."""
    assert _names(
        MIXED, ahrefs_contains="casino", ahrefs_contains_in="bogus",
    ) == ["bl.kz"]


def test_extractor_handles_each_criterion_field():
    cases = [
        ("refdomains", "domain", "Ref-Site.COM", "ref-site.com"),
        ("anchors", "anchor", "Buy CHEAP Pills", "buy cheap pills"),
        ("keywords", "keyword", "Online Casino", "online casino"),
    ]
    for crit, field, raw, want in cases:
        body = json.dumps({crit: [{field: raw}]})
        assert _criterion_text_blob(crit, body) == want


def test_extractor_falls_back_when_the_body_key_differs():
    """keywords has no stored results to verify against, so an upstream
    key rename must degrade to 'still works', not 'silently empty'."""
    body = json.dumps({"organic_keywords": [{"keyword": "Casino KZ"}]})
    assert _criterion_text_blob("keywords", body) == "casino kz"


def test_unknown_criterion_extracts_nothing():
    assert _criterion_text_blob("wayback", json.dumps({"wayback": [{"x": 1}]})) == ""
