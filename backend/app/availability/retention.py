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

Both passes are bounded and use single SQL statements (the per-domain
sweep is one IN-list DELETE built from a Python-side pick) so the prune
finishes in milliseconds even on millions of rows.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import AvailabilityCheck

log = logging.getLogger(__name__)


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
            .delete(synchronize_session=False)
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
            ids_to_delete.extend(int(r[0]) for r in stale)
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
