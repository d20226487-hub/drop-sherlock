"""Retention prune for the `availability_checks` history table.

The cascade writes one row per provider response on every check, so the
table grows linearly with usage. Settings → Domain Availability surfaces
"recent checks" by reading the most-recent N rows; the table itself was
unbounded until 2026-05-14. The pruner here applies two compounding
caps daily (APScheduler) + once at boot:

  1. Age cap: delete rows whose `checked_at < now - retention_days`.
     `retention_days = 0` means "never prune by age."
  2. Per-domain cap: after the age sweep, for each domain still holding
     more than `per_domain_keep` rows, drop the oldest until exactly
     `per_domain_keep` remain. `per_domain_keep = 0` means "no
     per-domain cap."

Neither pass deletes a domain's LATEST ANSWER (2026-11-01): its most
recent definitive check (available / registered / not supported) and its
most recent check of any status. The Backlog's Availability column and
filter read this table, so before this a domain whose last check was older
than the window lost its status entirely and read as "never checked".
Kept rows past the window have `raw_response` (up to 8 KB of provider
JSON) emptied, so keeping them costs ~1-2 small rows per domain.

Both passes are bounded and use single SQL statements (the per-domain
sweep is one IN-list DELETE built from a Python-side pick) so the prune
finishes in milliseconds even on millions of rows.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..models import AvailabilityCheck
from .common import TERMINAL_STATUSES

log = logging.getLogger(__name__)


def _latest_answer_ids():
    """SELECT of the ids neither prune pass may delete: per domain, the
    newest definitive check and the newest check of any status."""
    newest_first = (AvailabilityCheck.checked_at.desc(), AvailabilityCheck.id.desc())
    definitive = AvailabilityCheck.status.in_(TERMINAL_STATUSES)
    ranked = select(
        AvailabilityCheck.id.label("id"),
        definitive.label("definitive"),
        func.row_number().over(
            partition_by=AvailabilityCheck.domain, order_by=newest_first,
        ).label("rank_any"),
        func.row_number().over(
            partition_by=(AvailabilityCheck.domain, definitive),
            order_by=newest_first,
        ).label("rank_in_group"),
    ).subquery()
    return select(ranked.c.id).where(or_(
        ranked.c.rank_any == 1,
        and_(ranked.c.definitive, ranked.c.rank_in_group == 1),
    ))


def prune_availability_checks(
    db: Session,
    *,
    retention_days: int,
    per_domain_keep: int,
) -> dict[str, int]:
    """Run both prune passes against the current session. Returns counts
    for telemetry/log surfacing: `deleted_by_age`, `deleted_by_per_domain`,
    `total_after`.

    Caller commits — we don't, so an outer transaction can batch.
    """
    deleted_by_age = 0
    if retention_days > 0:
        cutoff = datetime.utcnow() - timedelta(days=retention_days)
        deleted_by_age = (
            db.query(AvailabilityCheck)
            .filter(AvailabilityCheck.checked_at < cutoff)
            .filter(~AvailabilityCheck.id.in_(_latest_answer_ids()))
            .delete(synchronize_session=False)
        )
        # What's left past the window is only latest answers: keep the
        # verdict, drop the bulky provider payload.
        db.query(AvailabilityCheck).filter(
            AvailabilityCheck.checked_at < cutoff,
            AvailabilityCheck.raw_response != "",
        ).update(
            {AvailabilityCheck.raw_response: ""}, synchronize_session=False,
        )
        if deleted_by_age:
            log.info(
                "availability_checks: age-pruned %d row(s) older than %d day(s)",
                deleted_by_age, retention_days,
            )

    deleted_by_per_domain = 0
    if per_domain_keep > 0:
        # Find domains that still have more rows than the cap. Cheap
        # group-by — index-served on `domain` exists.
        over = (
            db.query(
                AvailabilityCheck.domain,
                func.count(AvailabilityCheck.id),
            )
            .group_by(AvailabilityCheck.domain)
            .having(func.count(AvailabilityCheck.id) > per_domain_keep)
            .all()
        )
        ids_to_delete: list[int] = []
        protected = {int(i) for (i,) in db.execute(_latest_answer_ids())} if over else set()
        for domain, _count in over:
            # For each over-cap domain, pick the IDs to drop: everything
            # except the most-recent `per_domain_keep`. ORDER BY id DESC
            # (proxy for checked_at) + OFFSET + LIMIT-everything is the
            # cheapest way to express "skip the newest M, return the rest"
            # on SQLite.
            stale = (
                db.query(AvailabilityCheck.id)
                .filter(AvailabilityCheck.domain == domain)
                .order_by(AvailabilityCheck.id.desc())
                .offset(per_domain_keep)
                .all()
            )
            ids_to_delete.extend(
                int(r[0]) for r in stale if int(r[0]) not in protected
            )
        if ids_to_delete:
            deleted_by_per_domain = (
                db.query(AvailabilityCheck)
                .filter(AvailabilityCheck.id.in_(ids_to_delete))
                .delete(synchronize_session=False)
            )
            log.info(
                "availability_checks: per-domain-pruned %d row(s) "
                "(kept %d most-recent per domain across %d domain(s))",
                deleted_by_per_domain, per_domain_keep, len(over),
            )

    total_after = db.query(func.count(AvailabilityCheck.id)).scalar() or 0
    return {
        "deleted_by_age": int(deleted_by_age),
        "deleted_by_per_domain": int(deleted_by_per_domain),
        "total_after": int(total_after),
    }
