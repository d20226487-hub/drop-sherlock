"""Structured signal extraction from a WhoisRecord timeline.

`compute_diff([records])` returns a dict shaped for the AI prompt:
  {
    "snapshot_count": int,
    "first_seen": "YYYY-MM-DD",
    "last_seen":  "YYYY-MM-DD",
    "drop_signals": {
      "creation_date_changes": [...],     # HARD signal — domain was deleted
      "drop_pipeline_status_events": [...],# HARD — pendingDelete/redemptionPeriod
      "coverage_gaps_days":         [...],# coverage gaps >= 30 days
    },
    "soft_signals": {
      "owner_changes":    [...],
      "org_changes":      [...],
      "email_changes":    [...],
      "country_changes":  [...],
      "city_changes":     [...],
      "registrar_changes":[...],
      "ns_changes":       [...],
      "dnssec_toggles":   [...],
    },
    "current_state": {
      "registrar": "...", "owner": "...", "country": "...",
      "creation_date": "YYYY-MM-DD", "status": [...], "ns": [...],
      "is_in_drop_pipeline": bool,
    },
  }

The AI judge reads this BEFORE seeing the raw records — diffs already
done, signals already classified by strength. Per the design choice
locked earlier, raw records are also attached to the AI prompt so the
judge can cross-check anything unusual.

Signal taxonomy comes from the user-facing answer earlier in the
project conversation:
  HARD (alone sufficient for a high-confidence "dropped" verdict):
    - creation_date changes between snapshots
    - any historical snapshot showing pendingDelete / redemptionPeriod /
      pendingRestore / clientHold
    - long coverage gaps (registry returned NXDOMAIN, provider had
      nothing to poll)

  STRONG:
    - registrant name change
    - registrant email change
    - registrant org/company change

  MEDIUM:
    - country change
    - city/state change

  WEAK (normal lifecycle activity, NOT a drop signal alone):
    - registrar change (transfers happen all the time)
    - nameserver changes (CDN migrations, hosting changes)
    - DNSSEC toggles
"""
from __future__ import annotations

from datetime import date
from typing import Any

from .base import WhoisRecord

# EPP status codes the registry uses for the deletion pipeline. Any
# historical snapshot carrying one of these is direct evidence the
# domain WAS being deleted. Case-insensitive match on the codes inside
# WhoisRecord.domain_status (which preserves original case).
_DROP_PIPELINE_CODES = {
    "pendingdelete",
    "redemptionperiod",
    "pendingrestore",
    "clienthold",
    "serverhold",
    # Auto-renew period covers the grace window AFTER expiry where the
    # registrant can still recover the domain. Not always a drop signal
    # but worth flagging — combined with other signals it's strong.
    "autorenewperiod",
}

# Default: flag any coverage gap of >= this many days as a signal.
# Tunable in Settings via `whois_history__coverage_gap_threshold_days`;
# the constant here is the fallback for fresh deploys.
DEFAULT_COVERAGE_GAP_DAYS = 30


def _ns_root_set(name_servers: list[str]) -> set[str]:
    """Reduce a nameserver list to the set of "registrar / DNS provider
    families" — i.e. drop the host prefix.

    `ns1.cloudflare.com`, `ns2.cloudflare.com`, `walt.ns.cloudflare.com`
    all collapse to `cloudflare.com`. Lets us detect "moved from
    Cloudflare to AWS Route53" without false-positive on routine
    `ns1 → ns2` rotations within the same provider.

    Logic: take the last two labels of each NS hostname. Good enough
    for ~99% of providers; some quirky ones (e.g. dnsimple.com using
    `ns1.dnsimple.com` AND `dns3.dnsimple.com`) collapse cleanly too.
    """
    out: set[str] = set()
    for ns in name_servers:
        parts = ns.lower().strip().split(".")
        if len(parts) >= 2:
            out.add(".".join(parts[-2:]))
    return out


def _diff_pairs(
    records: list[WhoisRecord],
    accessor,
) -> list[dict[str, Any]]:
    """Walk consecutive pairs of records (sorted oldest → newest) and
    emit a {from, to, at} event each time `accessor(record)` changes.

    `accessor` returns a comparable value; None / empty values are
    skipped so "redacted → also redacted" doesn't fire a false event.
    Only the FIRST occurrence of each transition is recorded — repeated
    same-value records between events don't multiply the signal.
    """
    events: list[dict[str, Any]] = []
    prev_val: Any = None
    prev_when: date | None = None
    for r in records:
        v = accessor(r)
        if not v:
            continue
        if prev_val is None:
            prev_val = v
            prev_when = r.query_time
            continue
        if v != prev_val:
            events.append({
                "from": prev_val,
                "to": v,
                "at": r.query_time.isoformat(),
                "prev_at": prev_when.isoformat() if prev_when else None,
            })
            prev_val = v
            prev_when = r.query_time
    return events


def _detect_creation_changes(
    records: list[WhoisRecord],
) -> list[dict[str, Any]]:
    """A live domain's creation_date is immutable; any change between
    snapshots means the domain was deleted and re-registered. We track
    creation_date as an ISO string so the events serialize cleanly."""
    return _diff_pairs(
        records,
        lambda r: r.creation_date.isoformat() if r.creation_date else None,
    )


def _detect_drop_pipeline_events(
    records: list[WhoisRecord],
) -> list[dict[str, Any]]:
    """Flag every snapshot where ANY drop-pipeline EPP status code
    appears. Returns one event per snapshot (not per code) — the AI
    judge cares about "when was this in the pipeline" more than which
    specific code applied."""
    events: list[dict[str, Any]] = []
    for r in records:
        hit = [
            c for c in r.domain_status
            if c.strip().lower() in _DROP_PIPELINE_CODES
        ]
        if hit:
            events.append({
                "at": r.query_time.isoformat(),
                "codes": hit,
            })
    return events


def _detect_coverage_gaps(
    records: list[WhoisRecord],
    threshold_days: int,
) -> list[dict[str, Any]]:
    """Snapshots are sorted ascending by query_time. A gap > threshold
    between consecutive snapshots usually means the registry returned
    NXDOMAIN (the domain was deleted) — the provider had nothing to
    poll until someone re-registered it.

    Caveat: it can also mean polling broke on the provider side. The
    diff computer reports raw gaps; the AI judge weighs them in context
    of the other signals (a gap PLUS a creation_date change is
    near-definitive; a gap alone is suggestive)."""
    if len(records) < 2:
        return []
    gaps: list[dict[str, Any]] = []
    for i in range(1, len(records)):
        prev = records[i - 1].query_time
        cur = records[i].query_time
        days = (cur - prev).days
        if days >= threshold_days:
            gaps.append({
                "from": prev.isoformat(),
                "to": cur.isoformat(),
                "gap_days": days,
            })
    return gaps


def compute_diff(
    records: list[WhoisRecord],
    *,
    coverage_gap_threshold_days: int = DEFAULT_COVERAGE_GAP_DAYS,
) -> dict[str, Any]:
    """Public entrypoint. Returns the structured signal dict the AI
    prompt + frontend both read. See module docstring for shape.

    Empty input is handled — returns a minimal envelope with zero
    counts so the caller doesn't need a special branch. This matters
    for domains with no recorded WHOIS history (very new domains).
    """
    if not records:
        return {
            "snapshot_count": 0,
            "first_seen": None,
            "last_seen": None,
            "drop_signals": {
                "creation_date_changes": [],
                "drop_pipeline_status_events": [],
                "coverage_gaps_days": [],
            },
            "soft_signals": {
                "owner_changes": [],
                "org_changes": [],
                "email_changes": [],
                "country_changes": [],
                "city_changes": [],
                "registrar_changes": [],
                "ns_changes": [],
                "dnssec_toggles": [],
            },
            "current_state": {},
        }

    # Records arrive sorted by the provider mapper; defensively re-sort
    # here so callers building from arbitrary sources get correct diffs.
    records = sorted(records, key=lambda r: r.query_time)
    latest = records[-1]

    return {
        "snapshot_count": len(records),
        "first_seen": records[0].query_time.isoformat(),
        "last_seen": latest.query_time.isoformat(),
        "drop_signals": {
            "creation_date_changes": _detect_creation_changes(records),
            "drop_pipeline_status_events": _detect_drop_pipeline_events(records),
            "coverage_gaps_days": _detect_coverage_gaps(
                records, coverage_gap_threshold_days
            ),
        },
        "soft_signals": {
            # Track on EMAIL hashing-aware comparison since most
            # registrant fields are redacted post-GDPR; email patterns
            # often differ even when names are uniformly "REDACTED".
            "owner_changes": _diff_pairs(records, lambda r: r.registrant_name),
            "org_changes": _diff_pairs(records, lambda r: r.registrant_org),
            "email_changes": _diff_pairs(records, lambda r: r.registrant_email),
            "country_changes": _diff_pairs(
                records, lambda r: r.registrant_country
            ),
            "city_changes": _diff_pairs(records, lambda r: r.registrant_city),
            "registrar_changes": _diff_pairs(
                records, lambda r: r.registrar_name
            ),
            # NS changes use the root-family collapse — see _ns_root_set
            # for rationale (skip ns1→ns2 rotations within the same
            # provider so we only flag actual hosting moves).
            "ns_changes": _diff_pairs(
                records,
                lambda r: ",".join(sorted(_ns_root_set(r.name_servers)))
                if r.name_servers else None,
            ),
            "dnssec_toggles": _diff_pairs(
                records, lambda r: r.dnssec_enabled,
            ),
        },
        "current_state": {
            "registrar": latest.registrar_name,
            "owner": latest.registrant_name,
            "org": latest.registrant_org,
            "country": latest.registrant_country,
            "creation_date": (
                latest.creation_date.isoformat()
                if latest.creation_date else None
            ),
            "status": list(latest.domain_status),
            "name_servers": list(latest.name_servers),
            "dnssec_enabled": latest.dnssec_enabled,
            "is_in_drop_pipeline": bool(
                any(
                    c.strip().lower() in _DROP_PIPELINE_CODES
                    for c in latest.domain_status
                )
            ),
        },
    }
