"""Unit tests for the deterministic final-score math.

Coverage focuses on the cases that would silently produce wrong numbers
if anyone messes with the weight-renormalization or the
confidence-independence rule (see scoring.py docstring).
"""
from __future__ import annotations

import pytest

from app.scoring import (
    ASSESSMENT_SCORES,
    DEFAULT_CRITERION_WEIGHTS,
    assessment_to_score,
    compute_final,
)


def test_assessment_score_table():
    assert ASSESSMENT_SCORES["high_quality"] == 85.0
    assert ASSESSMENT_SCORES["mixed"] == 50.0
    assert ASSESSMENT_SCORES["low_quality"] == 15.0


def test_assessment_to_score_ignores_confidence():
    """Confidence is accepted for backwards compat but must NOT change
    the score — the prompt model that lets a low-confidence high_quality
    silently downscore to 70 is exactly what we don't want."""
    assert assessment_to_score("high_quality", confidence=0.99) == 85.0
    assert assessment_to_score("high_quality", confidence=0.01) == 85.0
    assert assessment_to_score("high_quality", confidence=None) == 85.0


def test_assessment_to_score_unknown_returns_none():
    assert assessment_to_score("garbage") is None
    assert assessment_to_score("") is None


def test_compute_final_no_verdicts_returns_none_pair():
    assert compute_final({}) == (None, None)


def test_compute_final_renormalizes_when_some_criteria_missing():
    """Backlinks (0.4) + Anchors (0.3) only. Weights renormalize over
    0.7 — score should still span 15..85 instead of being capped lower."""
    score, conf = compute_final(
        {
            "backlinks": {"assessment": "high_quality", "confidence": 0.9},
            "anchors": {"assessment": "high_quality", "confidence": 0.9},
        }
    )
    assert score == pytest.approx(85.0)
    assert conf == pytest.approx(0.9)


def test_compute_final_weighted_mix():
    """Backlinks high + Anchors low ⇒ score sits between 15 and 85,
    leaning toward 85 because backlinks is the heavier weight (0.4 vs 0.3)."""
    score, _ = compute_final(
        {
            "backlinks": {"assessment": "high_quality", "confidence": 0.9},
            "anchors": {"assessment": "low_quality", "confidence": 0.9},
        }
    )
    expected = (0.4 * 85.0 + 0.3 * 15.0) / 0.7
    assert score == pytest.approx(expected)


def test_compute_final_weighted_mean_confidence():
    """Confidence is weighted the same as score — high confidence on the
    heavy criterion matters more."""
    _, conf = compute_final(
        {
            "backlinks": {"assessment": "mixed", "confidence": 1.0},
            "anchors": {"assessment": "mixed", "confidence": 0.0},
        }
    )
    expected = (0.4 * 1.0 + 0.3 * 0.0) / 0.7
    assert conf == pytest.approx(expected)


def test_compute_final_skips_invalid_verdicts():
    score, _ = compute_final(
        {
            "backlinks": {"assessment": "high_quality", "confidence": 0.9},
            "anchors": "not a dict",  # malformed
            "refdomains": {"assessment": None, "confidence": 0.9},  # bad assess
            "keywords": {"assessment": "garbage", "confidence": 0.9},  # bad value
        }
    )
    assert score == pytest.approx(85.0)


def test_compute_final_default_confidence_when_missing():
    """When AI omits confidence, we default to 0.4 (below the UI grey
    threshold of 0.5) so untrustworthy verdicts are visibly flagged."""
    _, conf = compute_final(
        {
            "backlinks": {"assessment": "high_quality"},  # no confidence key
        }
    )
    assert conf == pytest.approx(0.4)


def test_compute_final_zero_weight_criterion_excluded():
    """A criterion with weight 0 must not move the score, even if it
    has a strong assessment — e.g. wayback is 0-weighted by default."""
    score, _ = compute_final(
        {
            "backlinks": {"assessment": "high_quality", "confidence": 0.9},
            # `wayback` is 0.0 in DEFAULT_CRITERION_WEIGHTS — its
            # low_quality verdict shouldn't pull the score below 85.
            "wayback": {"assessment": "low_quality", "confidence": 0.9},
        }
    )
    assert score == pytest.approx(85.0)


def test_compute_final_custom_weights_override_defaults():
    """User can pass custom weights that change the math (Settings UI)."""
    score, _ = compute_final(
        {
            "backlinks": {"assessment": "high_quality", "confidence": 0.9},
            "anchors": {"assessment": "low_quality", "confidence": 0.9},
        },
        weights={"backlinks": 0.5, "anchors": 0.5},
    )
    assert score == pytest.approx((85.0 + 15.0) / 2)


def test_default_weights_sum_close_to_one():
    """Quality smoke test on the default weights — should sum to 1.0
    across the four scoring criteria (wayback + wayback_classify are
    informational and weight 0). Caught a typo in this table once."""
    scoring_weights = sum(
        DEFAULT_CRITERION_WEIGHTS[k]
        for k in ("backlinks", "refdomains", "anchors", "keywords")
    )
    assert scoring_weights == pytest.approx(1.0)
