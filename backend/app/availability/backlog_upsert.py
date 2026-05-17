"""Shared "approach-1 ↔ approach-2 bridge" — write cascade results
(expires_on + registrar) back to the BacklogDomain row.

Extracted 2026-05-17 so both the Quality runner (`tasks.py`) and the
standalone Availability pillar runner (`availability_runner.py`) hit
the same upsert path. Previously only the Quality runner wrote back,
which meant a dedicated Availability job populated the Availability
column on Backlog but left the Истечение column empty — the user
couldn't sort/filter on expiration after the cleaner pillar workflow.

Rules (carried over from the original inline block):
- No-op if `expires_on` is None.
- Existing BacklogDomain row → update expiration_date / registrar
  only when blank or differing (never trample a user-edited date with
  a stale registry response).
- Missing row → create with status='analyzed', UNLESS the domain is
  banned (the ban-list pre-filter is the same "leaky path" plug the
  original block had).
- Manages its own short-lived session (caller doesn't need to pass
  one and won't have one open across the await of the cascade fetch).

Signature takes raw fields rather than the cascade's `AvailabilityResult`
so the Availability-pillar runner can pass POST-verdict-preservation
values (it may upgrade the cascade's transient `error` to a prior
terminal result with a real expires_on) without constructing a fake
result object.
"""
from __future__ import annotations

import logging
from datetime import date, datetime

from ..db import SessionLocal
from ..models import BacklogDomain

log = logging.getLogger(__name__)


def upsert_backlog_expiration(
    domain: str,
    expires_on: date | None,
    registrar: str | None = None,
) -> None:
    """Write expires_on (and optionally registrar) back to BacklogDomain.
    Idempotent and safe to call from both pillars; opens its own session.
    """
    if expires_on is None:
        return

    bdb = SessionLocal()
    try:
        row = (
            bdb.query(BacklogDomain)
            .filter(BacklogDomain.domain == domain)
            .one_or_none()
        )
        now = datetime.utcnow()
        if row is None:
            # Ban-list pre-filter (originally added 2026-05-13 wave L):
            # refuse to auto-create a BacklogDomain for a banned domain.
            # Only the create branch runs the ban check — existing rows
            # are still updated (the user already owns them, even if
            # they later got banned).
            from ..ban_filter import is_banned
            if is_banned(bdb, domain):
                log.info(
                    "skipping availability auto-upsert for banned "
                    "domain=%s",
                    domain,
                )
                return
            bdb.add(BacklogDomain(
                domain=domain,
                status="analyzed",
                expiration_date=expires_on,
                registrar=registrar or "",
                created_at=now,
                updated_at=now,
            ))
        else:
            # Only update when there's actually new info — don't bump
            # updated_at on a no-op equal value.
            if row.expiration_date != expires_on:
                row.expiration_date = expires_on
                row.updated_at = now
            if registrar and not row.registrar:
                row.registrar = registrar
                row.updated_at = now
        bdb.commit()
    finally:
        bdb.close()
