"""Domain ban list — permanent "never want this domain again" filter.

Distinct from the Backlog `discarded` status (which is a soft per-decision
flag). A ban is a hard, recurring pre-filter applied at every domain
ingestion point. Existing BacklogDomain rows are NEVER touched by banning
(pure pre-filter semantic — option (a) per the design call) — un-banning
has no inverse cleanup work to do.

Endpoints
---------
GET    /banlist                        — paginated list
POST   /banlist                        — add domains (single, bulk, or paste)
DELETE /banlist/{domain}               — unban
POST   /banlist/bulk-delete            — bulk unban

Central guards live in `apply_ban_filter` (re-exported from .ban_filter so
other routers can call it without importing this module).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import DomainBan
from .backlog import _normalize_domain

router = APIRouter(prefix="/banlist", tags=["banlist"])


class BanRow(BaseModel):
    domain: str
    note: str
    created_at: datetime


class BanListResponse(BaseModel):
    total: int
    rows: list[BanRow]


class BanAddIn(BaseModel):
    """One row per domain. `note` is optional. Used by both the single-add
    path and the bulk import (CSV-paste) — the frontend POSTs an array of
    these. Domains are normalized server-side."""
    domain: str
    note: str = ""


class BanAddBulkIn(BaseModel):
    rows: list[BanAddIn]


class BanAddBulkOut(BaseModel):
    added: int
    already_banned: int
    invalid: int
    rows_added: list[str]


class BanBulkDeleteIn(BaseModel):
    domains: list[str]


class BanBulkDeleteOut(BaseModel):
    deleted: int


@router.get("", response_model=BanListResponse)
def list_bans(db: Session = Depends(get_db)) -> BanListResponse:
    rows = (
        db.query(DomainBan)
        .order_by(DomainBan.created_at.desc(), DomainBan.domain.asc())
        .all()
    )
    return BanListResponse(
        total=len(rows),
        rows=[
            BanRow(domain=r.domain, note=r.note or "", created_at=r.created_at)
            for r in rows
        ],
    )


@router.post("", response_model=BanAddBulkOut)
def add_bans(
    payload: BanAddBulkIn,
    db: Session = Depends(get_db),
) -> BanAddBulkOut:
    """Add one-or-many domains to the ban list. Idempotent — already-banned
    domains are reported via `already_banned` but don't error. Empty /
    unparseable domain strings count toward `invalid` so the user can
    spot bad CSV rows."""
    if not payload.rows:
        return BanAddBulkOut(
            added=0, already_banned=0, invalid=0, rows_added=[],
        )

    # Normalize + dedupe within the payload.
    seen: set[str] = set()
    normalized: list[tuple[str, str]] = []  # (domain, note)
    invalid = 0
    for r in payload.rows:
        d = _normalize_domain(r.domain or "")
        if not d:
            invalid += 1
            continue
        if d in seen:
            continue
        seen.add(d)
        normalized.append((d, (r.note or "").strip()))

    if not normalized:
        return BanAddBulkOut(
            added=0, already_banned=0, invalid=invalid, rows_added=[],
        )

    existing = {
        b.domain: b
        for b in db.query(DomainBan)
        .filter(DomainBan.domain.in_([d for d, _ in normalized]))
        .all()
    }
    added = 0
    already = 0
    rows_added: list[str] = []
    now = datetime.utcnow()
    for d, note in normalized:
        if d in existing:
            # Note merge: only overwrite when the new note is non-empty
            # AND differs — lets the user re-import a CSV with updated
            # notes without losing earlier annotations on rows whose
            # note column was blank.
            if note and existing[d].note != note:
                existing[d].note = note
            already += 1
            continue
        db.add(DomainBan(domain=d, note=note, created_at=now))
        rows_added.append(d)
        added += 1
    db.commit()
    return BanAddBulkOut(
        added=added,
        already_banned=already,
        invalid=invalid,
        rows_added=rows_added,
    )


@router.delete("/{domain}")
def delete_ban(domain: str, db: Session = Depends(get_db)) -> dict:
    """Unban a single domain. Idempotent — un-banning an absent domain
    is a 404 only if the URL didn't normalize; for the bulk-unban use
    case prefer POST /banlist/bulk-delete."""
    d = _normalize_domain(domain)
    if not d:
        raise HTTPException(400, "invalid domain")
    row = db.get(DomainBan, d)
    if row is None:
        raise HTTPException(404, "not banned")
    db.delete(row)
    db.commit()
    return {"deleted": True, "domain": d}


@router.post("/bulk-delete", response_model=BanBulkDeleteOut)
def bulk_delete_bans(
    payload: BanBulkDeleteIn, db: Session = Depends(get_db),
) -> BanBulkDeleteOut:
    if not payload.domains:
        return BanBulkDeleteOut(deleted=0)
    normalized = {
        d for d in (_normalize_domain(x) for x in payload.domains) if d
    }
    if not normalized:
        return BanBulkDeleteOut(deleted=0)
    deleted = (
        db.query(DomainBan)
        .filter(DomainBan.domain.in_(normalized))
        .delete(synchronize_session=False)
    )
    db.commit()
    return BanBulkDeleteOut(deleted=int(deleted))
