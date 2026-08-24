"""Coverage for the Database language-match modes (added 2026-08-24).

The language multi-select gained a mode: "primary" (legacy — match the
dominant language only) vs "any" (also match domains where the selected
language is a secondary/tertiary from wayback_classify's
`secondary_languages`). `_match_language` is the pure predicate behind it.
"""
from __future__ import annotations

from app.routers.database import _match_language


def test_primary_mode_matches_only_the_dominant_language():
    # ru is a SECONDARY language here — primary mode must NOT match it.
    assert _match_language("en", ["ru", "kk"], ["ru"], "primary") is False
    assert _match_language("en", ["ru", "kk"], ["en"], "primary") is True


def test_any_mode_matches_secondary_and_tertiary():
    assert _match_language("en", ["ru", "kk"], ["ru"], "any") is True   # 2nd
    assert _match_language("en", ["ru", "kk"], ["kk"], "any") is True   # 3rd
    assert _match_language("en", ["ru", "kk"], ["en"], "any") is True   # 1st
    assert _match_language("en", ["ru", "kk"], ["fr"], "any") is False  # absent


def test_empty_selection_always_matches():
    assert _match_language("en", ["ru"], [], "any") is True
    assert _match_language("en", ["ru"], [], "primary") is True


def test_none_sentinel_means_no_language_at_all():
    # __none__ matches only when there's neither a primary nor a secondary.
    assert _match_language("", [], ["__none__"], "any") is True
    assert _match_language("", [], ["__none__"], "primary") is True
    assert _match_language("en", ["ru"], ["__none__"], "any") is False


def test_any_mode_ors_across_selected_languages():
    # Multiple selected languages OR together against the row's full set.
    assert _match_language("en", ["ru"], ["fr", "ru"], "any") is True
    assert _match_language("en", ["ru"], ["fr", "de"], "any") is False


def test_unknown_mode_falls_back_to_primary():
    # Defensive: any non-"any" value behaves like "primary".
    assert _match_language("en", ["ru"], ["ru"], "garbage") is False
    assert _match_language("en", ["ru"], ["en"], "garbage") is True
