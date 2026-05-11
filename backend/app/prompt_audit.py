"""Startup audit: warn when a customized prompt references column tokens
that aren't in the corresponding AI_FIELD_TRIM list.

Why this exists: when you trim a column from `SELECT_FIELDS` (and the
matching `AI_FIELD_TRIM`), any user-customized prompt in the DB that
still mentions that column is now misleading the AI — the prompt tells
it to weigh `is_spam`, but `is_spam` is no longer in the payload, so
the model either gets confused or hallucinates. The default prompt
gets edited in lockstep with the trim list (we own it), but customized
prompts live in the DB and don't move on their own.

This audit runs once at boot and emits a structured WARNING per stale
reference. Non-fatal: the app keeps starting; the warning gives the
operator something to act on (edit the custom prompt, or click Reset
to default in Settings → AI prompts).
"""
from __future__ import annotations

import logging
import re

from .ai_prompts import PROMPT_KEYS
from .db import SessionLocal
from .models import AppSetting

log = logging.getLogger(__name__)


# Per-criterion record of column tokens that USED TO BE in either the
# Ahrefs SELECT or the AI trim list but were intentionally removed. The
# audit only flags references to tokens in these sets — words like
# "domain" or "anchor" appear in the prompts as ordinary English prose
# AND as legitimate column names, so flagging "any column not in current
# trim" produces a flood of false positives. Restricting to "actually
# removed" columns keeps the signal clean: if a customized prompt
# mentions one of these, the AI is being told to weigh a field it can't
# see.
#
# When you remove a column from SELECT_FIELDS / AI_FIELD_TRIM, add it to
# the matching set here. Never remove entries (historical deletions are
# exactly what this audit is for). The set membership is the contract.
_REMOVED_PER_CRITERION: dict[str, frozenset[str]] = {
    "backlinks": frozenset({
        # Trimmed 2026-05-10 (default fetch filters made these redundant
        # for the AI verdict; see ahrefs_requests.py SELECT_FIELDS).
        "link_type", "is_dofollow", "is_nofollow", "is_ugc",
        "is_sponsored", "is_content", "is_spam", "http_code",
        "powered_by",
    }),
    "refdomains": frozenset({
        # Trimmed 2026-05-10.
        "is_spam",
    }),
    "anchors": frozenset({
        # AI trim dropped is_spam 2026-05-07; SELECT dropped 2026-05-10.
        "is_spam",
    }),
    "keywords": frozenset({
        # Trimmed 2026-05-10.
        "cpc", "keyword_country", "keyword_language",
        "best_position_url", "best_position_kind",
    }),
    "wayback": frozenset(),
}


def audit_customized_prompts() -> list[dict]:
    """Inspect every customized prompt in the DB and return the list of
    stale-token findings (also logged at WARNING level). Returns an
    empty list when everything is consistent.

    A finding fires only when a customized prompt references a column
    that has been REMOVED from its criterion's payload (see
    `_REMOVED_PER_CRITERION`). We deliberately don't flag "any column
    name not in the current trim" — that catches prose words like
    "domain" or "anchor" and makes the audit useless.

    Each finding: {key, stale_columns, prompt_length}.
    """
    findings: list[dict] = []
    db = SessionLocal()
    try:
        for key in PROMPT_KEYS:
            row = db.get(AppSetting, f"prompt__{key}")
            if row is None or not row.value or not row.value.strip():
                continue  # not customized
            default_text = PROMPT_KEYS[key]
            if row.value.strip() == default_text.strip():
                continue  # value matches default — treat as uncustomized
            removed = _REMOVED_PER_CRITERION.get(key)
            if not removed:
                continue  # criterion has no removed columns to look for
            stale = sorted(
                col
                for col in removed
                if re.search(rf"\b{re.escape(col)}\b", row.value)
            )
            if stale:
                finding = {
                    "key": key,
                    "stale_columns": stale,
                    "prompt_length": len(row.value),
                }
                findings.append(finding)
                log.warning(
                    "Customized prompt %r references columns no longer in the AI "
                    "payload: %s. The AI won't see these fields — edit the prompt "
                    "in Settings -> AI prompts, or click Reset to default.",
                    key, ", ".join(stale),
                )
    finally:
        db.close()
    return findings
