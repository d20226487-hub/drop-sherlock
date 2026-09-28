"""Coverage for the Database page's search box (`_apply_domain_search`).

Theme matching was added 2026-09-28: the Theme column renders
`primary_theme` and its tooltip lists `secondary_themes`, so both are
searchable. The pre-existing domain / pinned-run / note behavior is
pinned here too so the addition can't quietly break it.
"""
from __future__ import annotations

from app.routers.database import DomainRow, _apply_domain_search


def _row(domain: str, **kw) -> DomainRow:
    # `domain` + `total_runs` are the required fields on DomainRow.
    return DomainRow(domain=domain, total_runs=1, **kw)


ROWS = [
    _row("a.kz", primary_theme="Casino", secondary_themes=["Betting"]),
    _row("b.kz", primary_theme="Recipes", secondary_themes=["Casino reviews"]),
    _row("c.kz", primary_theme="News", secondary_themes=[]),
    _row("casino-d.kz", primary_theme="Blog", secondary_themes=[]),
    _row("e.kz", pinned_job_name="Casino batch", secondary_themes=[]),
    _row("f.kz", note="looks like a casino takeover", secondary_themes=[]),
]


def _hits(q: str) -> set[str]:
    return {r.domain for r in _apply_domain_search(ROWS, q)}


def test_matches_primary_theme():
    assert "a.kz" in _hits("casino")


def test_matches_secondary_theme():
    # b.kz's theme is "Recipes"; only its SECONDARY mentions casino.
    assert "b.kz" in _hits("casino")


def test_theme_match_is_case_insensitive():
    assert _hits("CASINO") == _hits("casino") == _hits("CaSiNo")


def test_theme_match_is_substring_not_whole_word():
    # "Casino reviews" must match on a bare "review".
    assert "b.kz" in _hits("review")


def test_legacy_fields_still_match():
    assert "casino-d.kz" in _hits("casino")   # domain
    assert "e.kz" in _hits("casino")          # pinned job name
    assert "f.kz" in _hits("casino")          # note


def test_non_matching_row_is_excluded():
    assert "c.kz" not in _hits("casino")


def test_all_expected_rows_for_one_query():
    assert _hits("casino") == {"a.kz", "b.kz", "casino-d.kz", "e.kz", "f.kz"}


def test_empty_query_returns_everything_unchanged():
    out = _apply_domain_search(ROWS, "")
    assert out == ROWS
    assert _apply_domain_search(ROWS, "   ") == ROWS


def test_empty_theme_fields_do_not_crash():
    rows = [_row("x.kz", primary_theme="", secondary_themes=[])]
    assert _apply_domain_search(rows, "anything") == []
    assert _apply_domain_search(rows, "x.kz") == rows
