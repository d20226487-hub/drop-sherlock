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
    creation_date as an ISO string so the events serialize cleanly.

    Two paths produce an event:

    1. **Value-to-value transition** via `_diff_pairs` — the registry
       reported one creation_date in an earlier snapshot and a different
       one later. Direct evidence of re-registration.

    2. **Post-dating** — the registry's currently-reported creation_date
       is LATER than the earliest snapshot's `query_time`. Logical proof
       of re-registration: we have a whois record for the domain before
       the registry claims it was created, which is impossible unless
       it was deleted and re-registered. This catches the common ccTLD
       case where the original snapshot lacked `creation_date` (so
       `_diff_pairs` skips it as None) but a later snapshot exposes
       a date that contradicts our earlier observation of the domain
       being live. Example: ospanovfund.kz had a 2020-04-03 whois
       snapshot with creation_date=None and a different registrant,
       then a 2024-03-23 snapshot with creation_date=2024-03-02 —
       impossible without a drop. Without this branch the deterministic
       counter returned 1 even though the AI judge gave dropped=0.95.
    """
    events = _diff_pairs(
        records,
        lambda r: r.creation_date.isoformat() if r.creation_date else None,
    )
    # Post-dating check. Pick the most recent reported creation_date
    # (the registry's current claim) and compare against our earliest
    # observation. If the claim post-dates the observation, synthesize
    # an event so the primary branch of `_estimate_ownership_cycles`
    # fires. Only add if there's no value-to-value transition already
    # for the same date — avoids double-counting when both signals fire.
    if records:
        earliest = records[0].query_time
        latest_creation: date | None = None
        for r in reversed(records):
            if r.creation_date is not None:
                latest_creation = r.creation_date
                break
        if latest_creation is not None and latest_creation > earliest:
            iso = latest_creation.isoformat()
            already_present = any(
                e.get("to") == iso for e in events
            )
            if not already_present:
                events.append({
                    "from": None,
                    "to": iso,
                    "at": latest_creation.isoformat(),
                    "prev_at": earliest.isoformat(),
                    "reason": "post_dates_history",
                })
    return events


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


def _estimate_ownership_cycles(
    creation_changes: list[dict[str, Any]],
    coverage_gaps: list[dict[str, Any]],
    has_creation_data: bool,
) -> int:
    """Conservative count of distinct registration cycles a domain has
    been through. Used by the Database page filter to flag domains that
    have changed hands more than N times (high-risk for a drop hunter:
    "the domain already passed through other drop hunters' hands").

    Counting rules (deliberately strict — only HARD signals):

      - creation_date is immutable on a live domain. Every change is
        unambiguous evidence of one full delete + re-register cycle.
        Primary signal: `cycles = 1 + len(creation_date_changes)`.

      - When creation_date IS present and stable across snapshots,
        the domain CANNOT have been deleted between them (the
        immutability invariant — a re-registration would have changed
        creation_date). So even if coverage_gaps are detected, they
        must be polling-cadence artefacts, not drops. Return 1.

      - Coverage-gaps fallback fires ONLY when creation_date is fully
        absent from every record (registry doesn't expose it post-GDPR
        in some ccTLDs). In that case each NXDOMAIN gap is the best
        evidence we have: `cycles = 1 + len(coverage_gaps_days)`.

    Soft signals (owner / email / org changes) are NOT counted here.
    Post-GDPR redactions mean a REDACTED → REDACTED transition is just
    a provider artefact, not necessarily an ownership change. The AI
    judge weights those nuances; this counter stays deterministic.

    Returns 1 for "no evidence of any drop" (likely original owner, or
    insufficient history) up to a cap of 10 (anything higher is almost
    certainly polling-noise, not real cycles)."""
    if creation_changes:
        return min(10, 1 + len(creation_changes))
    if has_creation_data:
        # creation_date was visible and stable -> no drop happened
        # between snapshots regardless of any gap noise.
        return 1
    if coverage_gaps:
        return min(10, 1 + len(coverage_gaps))
    return 1


def compute_cycles_from_diff_dict(diff: dict[str, Any]) -> int | None:
    """Compute ownership_cycles from a stored `diff` dict (i.e. the
    serialized form already on a CriterionResult.data_json). Mirrors
    `_estimate_ownership_cycles` and applies the post-dating signal so
    existing CRs surface a correct count without needing a re-fetch.

    Returns None when `diff` is malformed (no signal data present).

    The DB/run-summary read paths both call this rather than reading
    the stored `diff.ownership_cycles` directly — the stored value was
    computed at fetch time with whatever formula was current then, but
    the read path can apply newer corrective signals without changing
    the underlying data. Re-fetching to backfill old CRs would burn
    paid WhoisFreaks calls; recomputing on read is free.
    """
    if not isinstance(diff, dict):
        return None
    drop_sig = diff.get("drop_signals") or {}
    cc = drop_sig.get("creation_date_changes") or []
    cg = drop_sig.get("coverage_gaps_days") or []
    current_state = diff.get("current_state") or {}
    first_seen = diff.get("first_seen")
    current_creation = current_state.get("creation_date") if isinstance(
        current_state, dict
    ) else None

    # Post-dating synthetic signal — see `_detect_creation_changes`. We
    # only apply it when the stored `creation_date_changes` doesn't
    # already cover it (idempotent with new CRs whose compute_diff
    # already emitted the event).
    extra = 0
    if (
        isinstance(current_creation, str)
        and isinstance(first_seen, str)
        and current_creation > first_seen
    ):
        already_listed = (
            isinstance(cc, list)
            and any(
                isinstance(e, dict) and e.get("to") == current_creation
                for e in cc
            )
        )
        if not already_listed:
            extra = 1

    if isinstance(cc, list) and len(cc) > 0:
        return min(10, 1 + len(cc) + extra)
    if extra:
        return min(10, 1 + extra)
    has_creation = bool(current_creation)
    if has_creation:
        return 1
    if isinstance(cg, list) and len(cg) > 0:
        return min(10, 1 + len(cg))
    return 1


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
            "ownership_cycles": 1,
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

    creation_changes = _detect_creation_changes(records)
    coverage_gaps = _detect_coverage_gaps(records, coverage_gap_threshold_days)
    # creation_date is the immutability anchor — if it's present at
    # all in any record, we trust it as evidence (stable = no drop;
    # changed = drop). Only fall back to gap-based estimates when no
    # record exposed creation_date.
    has_creation_data = any(r.creation_date is not None for r in records)

    return {
        "snapshot_count": len(records),
        "first_seen": records[0].query_time.isoformat(),
        "last_seen": latest.query_time.isoformat(),
        # Deterministic cycle counter (see _estimate_ownership_cycles).
        # Surfaced on Database rows so the operator can filter
        # "multi-hand" domains (cycles >= 3 = passed through 2+ owners
        # after the original registrant) without needing to read every
        # AI summary by hand.
        "ownership_cycles": _estimate_ownership_cycles(
            creation_changes, coverage_gaps, has_creation_data,
        ),
        "drop_signals": {
            "creation_date_changes": creation_changes,
            "drop_pipeline_status_events": _detect_drop_pipeline_events(records),
            "coverage_gaps_days": coverage_gaps,
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
