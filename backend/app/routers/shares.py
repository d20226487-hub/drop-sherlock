"""Admin endpoints for managing view-only share links.

Mounted at `/shares` (behind the usual basic-auth via Caddy). Pairs with
the public-facing router at `/public/share/{token}` — this side handles
create / list / revoke / edit, the public side serves the view.

Token format: 32 chars urlsafe random (~190 bits of entropy). We pull
from `secrets.token_urlsafe` so it's cryptographically random — not
guessable even if an attacker harvests sample tokens.

The list endpoint server-paginates (matches the Ban List + Backlog
patterns from earlier waves) so the management UI can scale to
thousands of links without dragging a giant payload across the wire.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import DomainShare, Run, RunDomain

router = APIRouter(prefix="/shares", tags=["shares"])

# Length is bytes — token_urlsafe returns ~1.33x chars per byte due to
# base64. 24 bytes → 32 chars, ~192 bits of entropy. Bigger than UUID4
# (128 bits) and well past brute-force range.
_TOKEN_BYTES = 24


# --- Schemas --------------------------------------------------------------

class CreateShareIn(BaseModel):
    run_domain_id: int
    # Free-text label so the operator can later find "the share I sent
    # to ClientCorp in March". Optional.
    note: str = ""
    # Convenience picker: caller can pass either an absolute expires_at
    # (UTC datetime) or an `expires_in_days` integer; the second wins
    # if both are passed (matches the UI pattern of preset buttons that
    # set a numeric delta). Null/zero either way = never expires.
    expires_at: datetime | None = None
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ShareOut(BaseModel):
    token: str
    run_domain_id: int
    domain: str
    job_id: int | None
    job_name: str
    run_id: int | None
    note: str
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    view_count: int
    last_viewed_at: datetime | None
    is_active: bool


class ListSharesOut(BaseModel):
    total: int
    page: int
    per_page: int
    items: list[ShareOut]


class UpdateShareIn(BaseModel):
    # All optional. Empty-string `note` is a real update (clear the
    # label); pass `null` to leave unchanged. Same for the datetimes:
    # `null` = leave alone; explicit datetime = set; the literal
    # string `"clear"` is a sentinel for "remove expiry" (so the
    # never-expire state stays expressible).
    note: str | None = None
    expires_at: datetime | Literal["clear"] | None = None


class BulkRevokeIn(BaseModel):
    tokens: list[str] = Field(min_length=1, max_length=1000)


# --- Helpers --------------------------------------------------------------

def _share_to_out(share: DomainShare, rd: RunDomain | None, run: Run | None) -> ShareOut:
    is_active = share.revoked_at is None and (
        share.expires_at is None or share.expires_at > datetime.utcnow()
    )
    return ShareOut(
        token=share.token,
        run_domain_id=share.run_domain_id,
        domain=rd.domain if rd else "",
        job_id=run.job_id if run else None,
        job_name=run.job.name if (run and run.job) else "",
        run_id=run.id if run else None,
        note=share.note or "",
        created_at=share.created_at,
        expires_at=share.expires_at,
        revoked_at=share.revoked_at,
        view_count=share.view_count or 0,
        last_viewed_at=share.last_viewed_at,
        is_active=is_active,
    )


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",", 1)[0].strip()
    if request.client is not None:
        return request.client.host
    return ""


# --- Routes ---------------------------------------------------------------

@router.post("", response_model=ShareOut)
def create_share(
    payload: CreateShareIn,
    request: Request,
    db: Session = Depends(get_db),
) -> ShareOut:
    """Create a new share token for a RunDomain. Validates the target
    exists; refuses if no `expires_at` AND `expires_in_days` is null —
    that's deliberate: forever-shares are allowed but must be explicit
    (the UI passes 0 / null on purpose, not as a typo).
    """
    rd = db.get(RunDomain, payload.run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")

    # Resolve expiry. expires_in_days takes precedence (UI's primary input).
    expires_at: datetime | None = None
    if payload.expires_in_days is not None:
        expires_at = datetime.utcnow() + timedelta(days=payload.expires_in_days)
    elif payload.expires_at is not None:
        expires_at = payload.expires_at

    # Token collisions on 192 bits of entropy are statistically
    # impossible, but the retry loop costs nothing and protects against
    # any future RNG misconfiguration.
    for _ in range(5):
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        if db.get(DomainShare, token) is None:
            break
    else:
        raise HTTPException(500, "could not allocate a unique share token")

    share = DomainShare(
        token=token,
        run_domain_id=rd.id,
        note=payload.note or "",
        expires_at=expires_at,
        created_ip=_client_ip(request),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return _share_to_out(share, rd, rd.run)


@router.get("", response_model=ListSharesOut)
def list_shares(
    page: int = 1,
    per_page: int = 50,
    status: Literal["all", "active", "revoked", "expired"] = "all",
    search: str = "",
    db: Session = Depends(get_db),
) -> ListSharesOut:
    """Paginated list of shares with optional status filter + free-text
    search across `note` and `domain`. Joins to RunDomain+Run+Job so the
    UI can show meaningful labels without N+1 fetches."""
    page = max(1, page)
    per_page = max(1, min(200, per_page))

    q = (
        db.query(DomainShare, RunDomain, Run)
        .outerjoin(RunDomain, RunDomain.id == DomainShare.run_domain_id)
        .outerjoin(Run, Run.id == RunDomain.run_id)
    )

    now = datetime.utcnow()
    if status == "active":
        q = q.filter(
            DomainShare.revoked_at.is_(None),
            or_(DomainShare.expires_at.is_(None), DomainShare.expires_at > now),
        )
    elif status == "revoked":
        q = q.filter(DomainShare.revoked_at.is_not(None))
    elif status == "expired":
        q = q.filter(
            DomainShare.revoked_at.is_(None),
            DomainShare.expires_at.is_not(None),
            DomainShare.expires_at <= now,
        )

    if search.strip():
        like = f"%{search.strip().lower()}%"
        q = q.filter(
            or_(
                DomainShare.note.ilike(like),
                RunDomain.domain.ilike(like),
            )
        )

    total = q.count()
    rows = (
        q.order_by(DomainShare.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    items = [_share_to_out(share, rd, run) for share, rd, run in rows]
    return ListSharesOut(
        total=total, page=page, per_page=per_page, items=items
    )


@router.put("/{token}", response_model=ShareOut)
def update_share(
    token: str,
    payload: UpdateShareIn = Body(...),
    db: Session = Depends(get_db),
) -> ShareOut:
    share = db.get(DomainShare, token)
    if share is None:
        raise HTTPException(404, "share not found")
    if payload.note is not None:
        share.note = payload.note
    if payload.expires_at is not None:
        if payload.expires_at == "clear":
            share.expires_at = None
        else:
            share.expires_at = payload.expires_at  # type: ignore[assignment]
    db.commit()
    db.refresh(share)
    rd = db.get(RunDomain, share.run_domain_id)
    run = rd.run if rd else None
    return _share_to_out(share, rd, run)


@router.delete("/{token}", response_model=ShareOut)
def revoke_share(
    token: str,
    db: Session = Depends(get_db),
) -> ShareOut:
    """Soft-revoke (sets revoked_at). The share row is kept so the audit
    trail (view_count + last_viewed_at) survives — useful when
    investigating "was this link being used when I revoked it?"."""
    share = db.get(DomainShare, token)
    if share is None:
        raise HTTPException(404, "share not found")
    if share.revoked_at is None:
        share.revoked_at = datetime.utcnow()
        db.commit()
        db.refresh(share)
    rd = db.get(RunDomain, share.run_domain_id)
    run = rd.run if rd else None
    return _share_to_out(share, rd, run)


@router.post("/bulk-revoke")
def bulk_revoke(
    payload: BulkRevokeIn,
    db: Session = Depends(get_db),
) -> dict:
    """Revoke many shares in one call. Returns the count actually
    flipped (already-revoked tokens count as 0 changes — idempotent)."""
    now = datetime.utcnow()
    rows = (
        db.query(DomainShare)
        .filter(DomainShare.token.in_(payload.tokens))
        .filter(DomainShare.revoked_at.is_(None))
        .all()
    )
    for r in rows:
        r.revoked_at = now
    db.commit()
    return {"revoked": len(rows), "requested": len(payload.tokens)}


@router.delete("")
def revoke_all_active(db: Session = Depends(get_db)) -> dict:
    """Nuclear button — revoke every currently-active share. Returns
    the count. Used by the management UI's 'Revoke all active' action
    when the operator suspects a leak."""
    now = datetime.utcnow()
    rows = (
        db.query(DomainShare)
        .filter(DomainShare.revoked_at.is_(None))
        .all()
    )
    for r in rows:
        r.revoked_at = now
    db.commit()
    return {"revoked": len(rows)}
