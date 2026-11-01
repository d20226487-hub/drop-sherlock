"""Availability verdicts from Availability RUN results, as a fallback for the
check history (added 2026-11-01).

The Backlog's Availability column and filter read `availability_checks`,
which the daily retention prune trims. A domain whose history was trimmed
read as "never checked" even though its Availability run result — a
CriterionResult that is never pruned — still had the verdict (locally:
10,389 of 11,969 Backlog domains, 8,218 of them registered). When a domain
has no history row at all, these supply its status, with the same rule the
history uses: the newest DEFINITIVE verdict (available / registered / not
supported) wins; the newest verdict of any status counts only when there's
no definitive one. Newest = the run domain's finish time, then CR id.
"""
from __future__ import annotations

import json
from datetime import date, datetime

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from ..models import AvailabilityCheck, CriterionResult, RunDomain
from .common import TERMINAL_STATUSES

_NEWEST_FIRST = (RunDomain.finished_at.desc().nullslast(), CriterionResult.id.desc())


def run_verdict_subqueries():
    """Two subqueries of `(domain, status)`: the newest definitive run
    verdict per domain, and the newest run verdict of any status — for
    domains WITHOUT any history row only (the only ones the fallback can
    apply to). With history mostly intact the window then ranks almost
    nothing; with history trimmed it ranks what the history no longer
    covers."""
    return (
        _newest_per_domain(definitive_only=True),
        _newest_per_domain(definitive_only=False),
    )


def _newest_per_domain(*, definitive_only: bool):
    cr = CriterionResult
    # CASE keeps json_extract away from malformed JSON (SQLite would raise).
    status = case(
        (func.json_valid(cr.data_json) == 1,
         func.json_extract(cr.data_json, "$.verdict.status")),
        else_=None,
    )
    conds = [
        cr.criterion == "availability",
        cr.data_json != "",
        ~RunDomain.domain.in_(select(AvailabilityCheck.domain)),
    ]
    ranked = (
        select(
            RunDomain.domain.label("domain"),
            status.label("status"),
            func.row_number().over(
                partition_by=RunDomain.domain,
                order_by=_NEWEST_FIRST,
            ).label("rn"),
        )
        .select_from(cr)
        .join(RunDomain, RunDomain.id == cr.run_domain_id)
        .where(and_(*conds))
    )
    if definitive_only:
        # Filter BEFORE ranking so "newest" means newest definitive. The
        # json_valid guard sits inside the CASE; this predicate only sees
        # the CASE's result.
        ranked = ranked.where(status.in_(TERMINAL_STATUSES))
    else:
        ranked = ranked.where(status.isnot(None), status != "")
    sq = ranked.subquery()
    return select(sq.c.domain, sq.c.status).where(sq.c.rn == 1).subquery()


def latest_run_verdicts(
    db: Session, domains: list[str],
) -> dict[str, dict]:
    """Newest DEFINITIVE run verdict per domain, for the Backlog column
    (which, like its history source, shows definitive answers only).
    `{domain: {status, provider, registrar, expires_on, checked_at}}`."""
    if not domains:
        return {}
    rows = (
        db.query(
            RunDomain.domain, RunDomain.finished_at,
            CriterionResult.id, CriterionResult.data_json,
        )
        .join(CriterionResult, CriterionResult.run_domain_id == RunDomain.id)
        .filter(RunDomain.domain.in_(domains))
        .filter(CriterionResult.criterion == "availability")
        .filter(CriterionResult.data_json != "")
        .all()
    )
    best: dict[str, tuple] = {}
    for domain, finished_at, cr_id, data_json in rows:
        try:
            verdict = json.loads(data_json).get("verdict")
        except (ValueError, AttributeError):
            continue
        if not isinstance(verdict, dict):
            continue
        status = verdict.get("status")
        if status not in TERMINAL_STATUSES:
            continue
        key = (finished_at or datetime.min, cr_id)
        if domain not in best or key > best[domain][0]:
            best[domain] = (key, status, verdict, finished_at)
    out: dict[str, dict] = {}
    for domain, (_key, status, verdict, finished_at) in best.items():
        expires = verdict.get("expires_on")
        try:
            expires_on = date.fromisoformat(expires) if isinstance(expires, str) and expires else None
        except ValueError:
            expires_on = None
        out[domain] = {
            "status": status,
            "provider": verdict.get("provider") or "",
            "registrar": verdict.get("registrar") or "",
            "expires_on": expires_on,
            "checked_at": finished_at,
        }
    return out
