"""Deterministic final-score computation.

The AI judges per-criterion (assessment + confidence). The final assessment's
NUMBER is derived in code rather than asked of the model — LLMs get the
arithmetic wrong (the user's first prompt had a `÷4` that capped output at
25 instead of 100). Doing it in code makes the formula reproducible, auditable,
and immune to model drift.

Mapping (discrete — confidence does NOT affect the score)
---------------------------------------------------------
- high_quality → 85
- mixed        → 50
- low_quality  → 15

Confidence and quality are independent dimensions: confidence drives the
grey-out rule on the UI pill (low confidence → grey regardless of value),
while the score itself is a clean function of the AI's assessment label.
This avoids the trap of "low-confidence high_quality" silently producing
a score of 70 just because the AI was unsure — confidence shouldn't
discount quality, it should flag the verdict as untrustworthy.

The weighted average across 4 criteria with weights {0.4, 0.2, 0.3, 0.1}
still produces plenty of granularity in the final score (any value
between 15 and 85 depending on the mix).

Weighted average is renormalized over the criteria that produced a usable
verdict — so a run with only backlinks + anchors enabled uses
(B·0.4 + A·0.3) / 0.7 and the score still spans 15..85.
"""
from __future__ import annotations

DEFAULT_CRITERION_WEIGHTS: dict[str, float] = {
    "backlinks": 0.4,
    "refdomains": 0.2,
    "anchors": 0.3,
    "keywords": 0.1,
    # Wayback intentionally defaults to weight 0 — opt-in informational
    # signal during testing. The verdict still appears on the domain page;
    # it just doesn't tug the final score until the user dials this up.
    "wayback": 0.0,
    # wayback_classify is also weight 0 — its verdict (language + theme +
    # category) is informational metadata, not a quality judgment. The
    # verdict shape doesn't include {assessment, confidence} so it would
    # be skipped by compute_final regardless, but listing it here keeps
    # the Settings UI honest about which criteria contribute.
    "wayback_classify": 0.0,
}

ASSESSMENT_SCORES: dict[str, float] = {
    "high_quality": 85.0,
    "mixed": 50.0,
    "low_quality": 15.0,
}


def assessment_to_score(
    assessment: str, confidence: float | None = None
) -> float | None:
    """Return a 0–100 quality score for a single criterion verdict.

    `confidence` is accepted for backward compat but deliberately ignored —
    confidence affects the UI tone (grey override) but never the score.
    """
    return ASSESSMENT_SCORES.get(assessment)


def compute_final(
    sub_verdicts: dict[str, dict],
    weights: dict[str, float] | None = None,
) -> tuple[float | None, float | None]:
    """Aggregate sub-verdicts into (final_score, weighted_mean_confidence).

    `sub_verdicts` is keyed by criterion ('backlinks'|'refdomains'|...) with
    values shaped like the AI's output: `{assessment, confidence, ...}`.
    Skips criteria with missing/invalid verdicts. Renormalizes weights over
    the criteria that DID produce a score so disabled criteria don't drag
    the max ceiling down.

    Both the score AND the mean confidence use the same per-criterion
    weights — being highly confident on backlinks (40% weight) matters more
    than being highly confident on keywords (10% weight), the same way the
    score is weighted.

    Returns (None, None) when no sub-verdict produced a usable score —
    callers should treat that as 'no AI signal yet'.
    """
    w = weights or DEFAULT_CRITERION_WEIGHTS
    total_weight = 0.0
    weighted_score_sum = 0.0
    weighted_conf_sum = 0.0
    for criterion, weight in w.items():
        v = sub_verdicts.get(criterion)
        if not isinstance(v, dict):
            continue
        a = v.get("assessment")
        c = v.get("confidence")
        if not isinstance(a, str):
            continue
        # Tolerate missing confidence — some models skip it despite the
        # prompt's schema. Default to 0.4: below the UI's grey-out threshold
        # of 0.5 so the user clearly sees "the AI didn't tell us how sure
        # it was" and treats the score with skepticism.
        if isinstance(c, bool) or not isinstance(c, (int, float)):
            conf_value = 0.4
        else:
            conf_value = float(c)
        score = assessment_to_score(a, conf_value)
        if score is None:
            continue
        weighted_score_sum += weight * score
        weighted_conf_sum += weight * conf_value
        total_weight += weight
    if total_weight == 0.0:
        return None, None
    return (
        weighted_score_sum / total_weight,
        weighted_conf_sum / total_weight,
    )
