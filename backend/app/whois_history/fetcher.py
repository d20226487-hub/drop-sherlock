"""Top-level WHOIS-history fetch entrypoint.

The runner calls `fetch_history(domain, spec)` for each domain in a
whois_history-kind job. Returns a payload ready to drop into
CriterionResult.data_json (raw records + structured diff). The AI
judge runs on top of this output separately.

Provider is chosen at call time from `app_settings` so swapping
WhoisFreaks for WhoisXMLAPI later is a Settings change, not a code
change. Today only WhoisFreaks is wired up — the dispatch is
defensive structure for Wave-N follow-ups.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from ..app_settings import (
    get_whois_history_api_key,
    get_whois_history_coverage_gap_threshold,
    get_whois_history_max_records,
    get_whois_history_provider,
)
from .base import WhoisProvider, WhoisProviderError, WhoisRecord
from .diff import compute_diff
from .providers.whoisfreaks import WhoisFreaksProvider

log = logging.getLogger(__name__)

# Default soft cap on history depth — if a domain has more records,
# we keep the most-recent N (where drop signals are strongest).
# Override via Settings → Whois History → max_records.
DEFAULT_MAX_RECORDS = 100


@dataclass
class WhoisHistoryFetchResult:
    """Wraps everything one fetch produces — the raw record dicts (as
    they'll be stored in CR.data_json), the computed diff signals, and
    the provider name for audit / debug logging.

    Separate from `WhoisRecord` so callers don't need to import the
    dataclass module to handle the result; the dicts here are
    JSON-ready."""

    records: list[dict[str, Any]]
    diff: dict[str, Any]
    provider: str
    snapshot_count: int


def _get_provider() -> WhoisProvider:
    """Resolve the configured WhoisProvider from Settings. Today this
    is always WhoisFreaks; future cascades would extend the dispatch
    here based on `whois_history__provider`. The default provider
    string is 'whoisfreaks' so fresh deploys work without a setting
    write."""
    provider_name = get_whois_history_provider() or "whoisfreaks"
    if provider_name == "whoisfreaks":
        api_key = get_whois_history_api_key()
        return WhoisFreaksProvider(api_key=api_key)
    raise WhoisProviderError(
        f"Unknown whois_history provider: {provider_name!r}. "
        f"Set whois_history__provider to 'whoisfreaks' (the only "
        f"supported provider today) in Settings."
    )


async def fetch_history(domain: str) -> WhoisHistoryFetchResult:
    """Fetch + parse + diff WHOIS history for one domain.

    The function never raises; provider failures land in the returned
    result with `provider` set + empty `records`/`diff` so the runner
    can stash the error alongside the rest of the verdict. This
    mirrors the wayback/ahrefs criterion path (which also returns a
    CR with `error` set rather than throwing into the orchestrator).

    Returns a `WhoisHistoryFetchResult` with everything needed to:
      - write CriterionResult.data_json (records + diff + provider)
      - feed the AI judge (diff first, raw records second)
      - render the per-domain UI (records as table rows, diff as
        signal pills, current_state as headline)
    """
    try:
        provider = _get_provider()
    except WhoisProviderError as e:
        # Configuration error — surface as an empty result with a clear
        # message so the AI judge can short-circuit + the operator sees
        # the fix in the CR.error pill.
        raise
    max_records = get_whois_history_max_records()
    gap_days = get_whois_history_coverage_gap_threshold()
    records = await provider.fetch_history(domain, max_records=max_records)
    diff = compute_diff(records, coverage_gap_threshold_days=gap_days)
    return WhoisHistoryFetchResult(
        records=[r.to_dict() for r in records],
        diff=diff,
        provider=provider.name,
        snapshot_count=len(records),
    )


def parse_stored_payload(blob: dict[str, Any]) -> list[WhoisRecord]:
    """Inverse of `fetch_history()` for the cache path — given a
    previously-stored data_json, reconstruct the WhoisRecord list so
    the diff can be recomputed (e.g. when Settings change the gap
    threshold and the user reanalyzes the same domain)."""
    raw = blob.get("records") if isinstance(blob, dict) else None
    if not isinstance(raw, list):
        return []
    return [WhoisRecord.from_dict(d) for d in raw if isinstance(d, dict)]
