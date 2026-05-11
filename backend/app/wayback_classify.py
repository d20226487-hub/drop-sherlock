"""Wayback-derived classification: language + theme + auto-chained category.

This is the runner for the `wayback_classify` criterion (added 2026-05-09).
It is invoked from `tasks._run_ai_for_domain` after the regular Ahrefs/
Wayback per-criterion AI judges have run, because it depends on the
wayback CR row's V2 page samples being persisted already.

Design summary (also in project memory):
- One criterion, one CriterionResult row, one ai_verdict_json blob holding
  language + theme + (chained) category — saves ~40% AI tokens vs splitting
  into separate criteria (same input data, single round-trip in AI mode).
- `language_mode = "ai"`: combined prompt asks for language + theme in one
  call, with `<html lang>` snippets from the V2 sampler folded in as a
  hint. ~2 AI calls per domain (combined + category).
- `language_mode = "library"`: lingua-language-detector aggregates a
  primary language from the V2 sample text deterministically, then a
  theme-only AI prompt runs. Same ~2 AI calls per domain.
- Chained category prompt always runs after theme detection succeeds; uses
  the user's predefined Settings categories and outputs a single category
  name (or "other") with confidence.
- Both modes output ISO 639-1 language codes so Database filters work on a
  single value space regardless of which mode produced the row.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from .ai_judge import judge, ProviderConfigError, ProviderError
from .ai_prompts import (
    WAYBACK_CATEGORY_PROMPT,
    WAYBACK_CLASSIFY_COMBINED_PROMPT,
    WAYBACK_CLASSIFY_THEME_ONLY_PROMPT,
    localize_prompt,
)
from .app_settings import get_ai_prompt, get_categories, get_language_mode

log = logging.getLogger(__name__)


# --- Lingua wrapper (lazy import so the dependency is optional at boot) -----

_LINGUA_DETECTOR = None


def _get_lingua_detector():
    """Build the lingua detector once per process. Lazy-imported so the
    backend boots even if the wheel didn't install (the classify path is
    opt-in; raising on import would break the rest of the app)."""
    global _LINGUA_DETECTOR
    if _LINGUA_DETECTOR is not None:
        return _LINGUA_DETECTOR
    try:
        from lingua import LanguageDetectorBuilder
    except ImportError:
        log.warning(
            "lingua not installed — library-mode language detection will "
            "fall back to empty results. Install lingua-language-detector "
            "to enable it."
        )
        return None
    # Build with all languages — short-text accuracy benefits from the
    # full model. Memory cost (~1GB) is acceptable for a single-user app.
    _LINGUA_DETECTOR = LanguageDetectorBuilder.from_all_languages().build()
    return _LINGUA_DETECTOR


def _iso_code_for_language(language) -> str:
    """Convert a lingua `Language` enum to ISO 639-1 lowercase. Falls back
    to ISO 639-3 for languages without a 639-1 code (rare)."""
    try:
        if language.iso_code_639_1:
            return language.iso_code_639_1.name.lower()
    except (AttributeError, ValueError):
        pass
    try:
        return language.iso_code_639_3.name.lower()
    except (AttributeError, ValueError):
        return "und"


def _detect_language_with_lingua(samples: list[dict]) -> dict:
    """Aggregate a primary language from V2 page samples using lingua.

    Per-sample: concatenate title + h1s + h2s + body_excerpt, then call
    `detector.compute_language_confidence_values(text)` to get lingua's
    own per-language confidence (0..1). Take the top language per sample
    along with its lingua confidence. Aggregate across snapshots with
    recency weighting (newer = heavier) and return the MEAN lingua
    confidence of the snapshots that picked the primary — that's a real
    "how sure was the model" number, not "share of snapshots that voted
    for X" (which always rounded to 100% on single-language sites).

    Returns `{primary_language, secondary_languages, language_confidence,
    per_snapshot: [{timestamp, language, confidence}, ...]}`."""
    detector = _get_lingua_detector()
    if detector is None:
        return {
            "primary_language": "und",
            "secondary_languages": [],
            "language_confidence": 0.0,
            "per_snapshot": [],
            "error": "lingua not installed",
        }
    per_snapshot: list[dict] = []
    # Recency-weighted vote totals — used to pick the primary across
    # snapshots. Newer snapshots count more (weight = 1 + i/N), same
    # rationale as before: triage cares about the most-recent state.
    weighted_votes: Counter = Counter()
    # Confidence accumulator per language: list of lingua-confidence
    # values from snapshots that picked that language as their top.
    confs_by_lang: dict[str, list[float]] = {}
    sorted_samples = sorted(
        samples, key=lambda s: str(s.get("timestamp") or "")
    )
    n = max(len(sorted_samples), 1)
    for i, s in enumerate(sorted_samples):
        text_parts: list[str] = []
        if s.get("title"):
            text_parts.append(str(s["title"]))
        for h in s.get("h1s") or []:
            text_parts.append(str(h))
        for h in s.get("h2s") or []:
            text_parts.append(str(h))
        if s.get("body_excerpt"):
            text_parts.append(str(s["body_excerpt"]))
        text = " ".join(t for t in text_parts if t).strip()
        if len(text) < 10:
            # Skip near-empty samples (parked / 3xx / very short).
            continue
        try:
            cv = detector.compute_language_confidence_values(text)
        except Exception:  # noqa: BLE001 — lingua occasionally raises on weird input
            cv = []
        if not cv:
            continue
        # cv is a list of ConfidenceValue, sorted by .value descending.
        # Take the top entry as this snapshot's pick.
        top = cv[0]
        try:
            top_value = float(top.value)
        except (AttributeError, TypeError, ValueError):
            top_value = 0.0
        try:
            language = top.language
        except AttributeError:
            continue
        if language is None:
            continue
        code = _iso_code_for_language(language)
        per_snapshot.append({
            "timestamp": s.get("timestamp"),
            "language": code,
            "confidence": round(top_value, 3),
        })
        weight = 1.0 + (i / n)
        weighted_votes[code] += weight
        confs_by_lang.setdefault(code, []).append(top_value)
    if not weighted_votes:
        return {
            "primary_language": "und",
            "secondary_languages": [],
            "language_confidence": 0.0,
            "per_snapshot": per_snapshot,
        }
    ranked = weighted_votes.most_common()
    primary, _primary_votes = ranked[0]
    primary_confs = confs_by_lang.get(primary) or [0.0]
    # Mean lingua confidence across snapshots that picked the primary.
    # That's the honest answer to "how sure was the library" — it's
    # NOT 1.0 just because every snapshot voted for the same language.
    mean_conf = sum(primary_confs) / len(primary_confs)
    confidence = min(max(mean_conf, 0.0), 1.0)
    total_w = sum(weighted_votes.values())
    secondaries = [
        code for code, w in ranked[1:]
        if total_w > 0 and (w / total_w) >= 0.15
    ]
    return {
        "primary_language": primary,
        "secondary_languages": secondaries,
        "language_confidence": round(confidence, 3),
        "per_snapshot": per_snapshot,
    }


# --- Sample preparation for the AI prompt -----------------------------------


def _trim_sample_for_classify(s: dict) -> dict:
    """Compact a single V2 sample for the classify prompt. Drops the long
    `snapshot_url` and `url` (the model only needs the year + content),
    and only emits non-empty fields. lang_attr is preserved when present
    — the combined prompt uses it as a hint."""
    ts = str(s.get("timestamp") or "")
    year = ts[:4] if len(ts) >= 4 and ts[:4].isdigit() else ""
    out: dict[str, Any] = {}
    if year:
        out["year"] = int(year)
    if s.get("title"):
        out["title"] = s["title"]
    if s.get("h1s"):
        out["h1s"] = s["h1s"]
    if s.get("h2s"):
        out["h2s"] = s["h2s"]
    if s.get("h3s"):
        out["h3s"] = s["h3s"]
    if s.get("body_excerpt"):
        out["body_excerpt"] = s["body_excerpt"]
    if s.get("lang_attr"):
        out["lang_attr"] = s["lang_attr"]
    if s.get("redirect_to"):
        out["redirect_to"] = s["redirect_to"]
    http_status = s.get("http_status")
    if http_status and http_status != 200:
        out["http_status"] = http_status
    return out


def build_classify_user_message(
    *, domain: str, samples: list[dict], lingua_hint: dict | None = None
) -> str:
    """User message body for the combined / theme-only prompts. Both
    prompts read the same shape — the difference is what they're asked to
    output, encoded in the system prompt."""
    trimmed = [_trim_sample_for_classify(s) for s in samples]
    parts = [
        f"Domain: {domain}",
        f"Sample count: {len(trimmed)}",
        f"Page samples (chronological JSON):\n{json.dumps(trimmed, ensure_ascii=False)}",
    ]
    if lingua_hint:
        parts.append(
            "Language already detected by deterministic library "
            f"(use as ground truth, do not output language fields):\n"
            f"{json.dumps({'primary_language': lingua_hint.get('primary_language'), 'secondary_languages': lingua_hint.get('secondary_languages', []), 'confidence': lingua_hint.get('language_confidence')}, ensure_ascii=False)}"
        )
    return "\n\n".join(parts)


def build_category_user_message(
    *, theme_verdict: dict, categories: list[dict]
) -> str:
    """User message body for the chained category prompt. Includes the
    detected theme + drift info + the user's predefined categories."""
    theme_payload: dict = {
        "detected_theme": theme_verdict.get("primary_theme") or "",
        "secondary_themes": theme_verdict.get("secondary_themes") or [],
        "drift_detected": bool(theme_verdict.get("drift_detected")),
    }
    if theme_payload["drift_detected"]:
        # Surface the OLDEST historical theme as the "was" candidate so
        # the AI can populate category_was. Picking the oldest gives the
        # cleanest contrast with the most-recent category.
        history = theme_verdict.get("history") or []
        oldest = next(
            (h for h in history if isinstance(h, dict) and h.get("theme")),
            None,
        )
        if oldest:
            theme_payload["historical_theme"] = oldest.get("theme")
    parts = [
        f"Theme detection (JSON):\n{json.dumps(theme_payload, ensure_ascii=False)}",
        f"Predefined categories (JSON):\n{json.dumps(categories, ensure_ascii=False)}",
    ]
    return "\n\n".join(parts)


# --- Top-level entry point --------------------------------------------------


async def classify_wayback_for_domain(
    *,
    domain: str,
    samples: list[dict],
    language_mode: str,
    provider: str,
    resolved_model: str,
    judge_limit_ctx,
    lang: str = "en",
) -> tuple[dict, list[dict]]:
    """Run the wayback_classify pipeline for one domain. Returns
    `(combined_verdict, usages)` where `combined_verdict` is the merged
    {language, theme, category, drift, ...} dict to persist as the CR's
    ai_verdict_json, and `usages` is a list of per-AI-call usage dicts
    (input_tokens / output_tokens) so the caller can attribute cost.

    Raises ProviderConfigError / ProviderError / ValueError on failure —
    caller persists the error onto the CR row.

    `judge_limit_ctx` is a callable returning an async context manager
    bound to the AI provider's rate-limit slot (`limits.limit(provider)`
    in tasks.py). Passed in so this module doesn't need to import the
    rate limiter directly."""
    if not samples:
        raise ValueError(
            "wayback_classify needs Wayback V2 page samples — none found "
            "on the wayback CR row. Enable Wayback page sampling and "
            "rerun, or wait for an in-flight wayback fetch to finish."
        )

    usages: list[dict] = []
    lingua_result: dict | None = None
    if language_mode == "library":
        lingua_result = _detect_language_with_lingua(samples)

    # --- Step 1: language + theme (or theme only) AI call -------------------
    if language_mode == "library":
        system_prompt = localize_prompt(
            get_ai_prompt("wayback_classify_theme_only"), lang
        )
        user_msg = build_classify_user_message(
            domain=domain, samples=samples, lingua_hint=lingua_result,
        )
    else:
        system_prompt = localize_prompt(
            get_ai_prompt("wayback_classify_combined"), lang
        )
        user_msg = build_classify_user_message(
            domain=domain, samples=samples, lingua_hint=None,
        )
    async with judge_limit_ctx(provider):
        parsed_classify, _raw, usage = await judge(
            provider=provider,
            system_prompt=system_prompt,
            user_message=user_msg,
            model_override=resolved_model,
        )
    if usage:
        usages.append(usage)
    if not isinstance(parsed_classify, dict):
        parsed_classify = {}

    # Library mode: stamp the lingua result into the verdict (overrides
    # anything the AI might have leaked in for language). AI mode: trust
    # the AI's language fields (they're in the prompt schema).
    if language_mode == "library" and lingua_result:
        parsed_classify["primary_language"] = lingua_result["primary_language"]
        parsed_classify["secondary_languages"] = lingua_result["secondary_languages"]
        parsed_classify["language_confidence"] = lingua_result["language_confidence"]
        parsed_classify["language_source"] = "library"
    else:
        parsed_classify["language_source"] = "ai"

    # --- Step 2: chained category classification AI call --------------------
    primary_theme = (parsed_classify.get("primary_theme") or "").strip()
    if not primary_theme:
        # No theme detected — skip categorization. Caller still persists
        # the language fields. This isn't an error (e.g. all-3xx domain).
        parsed_classify["category"] = ""
        parsed_classify["category_confidence"] = 0.0
        return parsed_classify, usages

    categories = get_categories()
    if not categories:
        # User hasn't defined any categories yet — record that explicitly
        # so the UI can prompt them to add some, but don't fail.
        parsed_classify["category"] = ""
        parsed_classify["category_confidence"] = 0.0
        parsed_classify["category_skipped_reason"] = (
            "no categories configured in Settings"
        )
        return parsed_classify, usages

    category_prompt = localize_prompt(get_ai_prompt("wayback_category"), lang)
    category_user_msg = build_category_user_message(
        theme_verdict=parsed_classify, categories=categories,
    )
    try:
        async with judge_limit_ctx(provider):
            parsed_category, _raw2, cat_usage = await judge(
                provider=provider,
                system_prompt=category_prompt,
                user_message=category_user_msg,
                model_override=resolved_model,
            )
        if cat_usage:
            usages.append(cat_usage)
    except (ProviderConfigError, ProviderError, ValueError) as e:
        # Category step failed but classify (language + theme) succeeded;
        # surface the error inside the verdict rather than failing the
        # whole criterion. Cheaper to retry just category later.
        log.warning(
            "wayback category step failed for %s: %s", domain, e,
        )
        parsed_classify["category"] = ""
        parsed_classify["category_confidence"] = 0.0
        parsed_classify["category_error"] = f"{type(e).__name__}: {e}"
        return parsed_classify, usages

    if not isinstance(parsed_category, dict):
        parsed_category = {}

    # Validate the category against the predefined list — accept
    # case-insensitive matches, fall back to "other" on anything else so
    # the user can spot bad outputs without re-running.
    valid_names = {c["name"].lower(): c["name"] for c in categories}
    valid_names["other"] = "other"
    raw_cat = (parsed_category.get("category") or "").strip()
    canonical = valid_names.get(raw_cat.lower(), "other")
    parsed_classify["category"] = canonical
    parsed_classify["category_confidence"] = float(
        parsed_category.get("category_confidence") or 0.0
    )
    if parsed_category.get("reasoning"):
        parsed_classify["category_reasoning"] = parsed_category["reasoning"]

    # category_was — only when drift was detected AND the AI actually
    # produced a non-empty value.
    raw_was = (parsed_category.get("category_was") or "").strip()
    if raw_was and parsed_classify.get("drift_detected"):
        canonical_was = valid_names.get(raw_was.lower(), "other")
        parsed_classify["category_was"] = canonical_was
        parsed_classify["category_was_confidence"] = float(
            parsed_category.get("category_was_confidence") or 0.0
        )

    return parsed_classify, usages
