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

import json
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (
    BacklogDomain,
    CriterionResult,
    DomainBan,
    Run,
    RunDomain,
)
from .backlog import _normalize_domain


def _serialize_backlog_row(row: BacklogDomain) -> str:
    """Capture every column we need to faithfully recreate this row on
    unban. ISO strings for dates/datetimes — JSON-safe, and `fromisoformat`
    parses them back losslessly."""
    payload = {
        "status": row.status,
        "registrar": row.registrar or "",
        "expiration_date": (
            row.expiration_date.isoformat() if row.expiration_date else None
        ),
        "comments": row.comments or "",
        "desired_price": row.desired_price,
        "max_price": row.max_price,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    return json.dumps(payload, ensure_ascii=False)


def _snapshot_and_delete_backlog(
    db: Session, domains_to_snapshot: dict[str, "DomainBan"],
) -> int:
    """Symmetric ban semantic (locked 2026-05-14, supersedes wave-O β):
    when a domain is added to the ban list, capture its BacklogDomain row
    (if any) onto the corresponding new DomainBan's `backlog_snapshot_json`
    column, then delete the Backlog row. On unban we restore from the
    snapshot. Returns the count of Backlog rows actually deleted.

    `domains_to_snapshot` maps normalized domain → the newly-added
    DomainBan instance that should receive the snapshot. Callers pass
    only the domains that are *newly* banned in this transaction —
    re-banning an already-banned domain leaves the prior snapshot
    alone (the Backlog row is already gone)."""
    if not domains_to_snapshot:
        return 0
    rows = (
        db.query(BacklogDomain)
        .filter(BacklogDomain.domain.in_(list(domains_to_snapshot.keys())))
        .all()
    )
    deleted = 0
    for row in rows:
        ban = domains_to_snapshot.get(row.domain)
        if ban is None:
            continue
        ban.backlog_snapshot_json = _serialize_backlog_row(row)
        db.delete(row)
        deleted += 1
    return deleted


def _restore_backlog_from_snapshot(
    db: Session,
    ban: DomainBan,
    *,
    existing_domains: set[str] | None = None,
) -> bool:
    """Inverse of `_snapshot_and_delete_backlog`. Recreates the Backlog
    row from the JSON snapshot when unbanning. No-op when the ban has no
    snapshot (banned domains that never had a Backlog row) or when a
    Backlog row already exists for this domain (defensive — shouldn't
    happen since ingestion is ban-guarded). Returns True if a row was
    recreated.

    `existing_domains` is an optional preloaded set of domain strings
    that ALREADY have a BacklogDomain row — bulk callers preload it
    once for the whole batch to avoid an N+1 SELECT-per-ban. When
    omitted, falls back to a single-row SELECT (cheap for the single-
    domain unban endpoint).
    """
    if not ban.backlog_snapshot_json:
        return False
    if existing_domains is None:
        existing = (
            db.query(BacklogDomain)
            .filter(BacklogDomain.domain == ban.domain)
            .first()
        )
        if existing is not None:
            return False
    elif ban.domain in existing_domains:
        return False
    try:
        data = json.loads(ban.backlog_snapshot_json)
    except (ValueError, TypeError):
        return False
    exp_raw = data.get("expiration_date")
    created_raw = data.get("created_at")
    updated_raw = data.get("updated_at")
    db.add(
        BacklogDomain(
            domain=ban.domain,
            # Force status='banned' on restore — the user wants the row
            # to be clearly identifiable as "previously banned" in the
            # Backlog at Status=Banned, and to re-status manually if
            # they want it back in the active triage flow. The snapshot
            # still preserves the prior status in the JSON for audit;
            # we just don't honor it on restore.
            status="banned",
            registrar=data.get("registrar") or "",
            expiration_date=(
                date.fromisoformat(exp_raw) if exp_raw else None
            ),
            comments=data.get("comments") or "",
            desired_price=data.get("desired_price"),
            max_price=data.get("max_price"),
            created_at=(
                datetime.fromisoformat(created_raw)
                if created_raw
                else datetime.utcnow()
            ),
            updated_at=(
                datetime.fromisoformat(updated_raw)
                if updated_raw
                else datetime.utcnow()
            ),
        )
    )
    return True

router = APIRouter(prefix="/banlist", tags=["banlist"])


class AnalysisLink(BaseModel):
    """Pointer to the most-recent RunDomain page that holds a specific
    type of analysis for the banned domain. Lets the Ban List page link
    directly to the per-domain analysis page so operators can review
    why they banned. `kind` is informational ("ahrefs"/"wayback"/
    "whois") — the URL builds to `/jobs/{job_id}/runs/{run_id}/
    domains/{run_domain_id}` on the frontend regardless."""
    kind: str
    job_id: int
    run_id: int
    run_domain_id: int


class BanRow(BaseModel):
    domain: str
    note: str
    created_at: datetime
    # Analysis cross-links (added 2026-05-15) — null when the banned
    # domain has no rd of that type. Backed by the most-recent rd
    # whose CR for the respective criterion is `status='done'`. Ahrefs
    # is keyed off the `backlinks` criterion, wayback off `wayback`,
    # whois off `whois_history`. wayback_classify is intentionally NOT
    # surfaced as a separate link — it lives on the same rd as
    # `wayback` so the Wayback link already exposes it.
    ahrefs_link: AnalysisLink | None = None
    wayback_link: AnalysisLink | None = None
    whois_link: AnalysisLink | None = None


class BanListResponse(BaseModel):
    # `total` is the unfiltered ban-list size (drives the totalLine
    # footer and lets the frontend reason about "this much exists").
    # `filtered_total` is the count after `search` is applied — drives
    # pagination math and the "X of Y" hint. `page`/`per_page` echo
    # the inputs so the UI can self-correct after the search-reset.
    total: int
    filtered_total: int
    page: int
    per_page: int
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
def list_bans(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
    search: str = "",
    db: Session = Depends(get_db),
) -> BanListResponse:
    """Server-paginated ban list. `search` is a case-insensitive
    substring match on domain OR note. Replaces the prior load-all
    behavior (2026-05-14 perf pass) so the page scales past 10k bans
    without shipping the entire table on every reload."""
    base = db.query(DomainBan)
    total = base.count()
    q = base
    if search and search.strip():
        needle = f"%{search.strip().lower()}%"
        q = q.filter(
            (func.lower(DomainBan.domain).like(needle))
            | (func.lower(DomainBan.note).like(needle))
        )
    filtered_total = q.count() if (search and search.strip()) else total
    rows = (
        q.order_by(DomainBan.created_at.desc(), DomainBan.domain.asc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    # Analysis cross-link resolution (added 2026-05-15). For each
    # banned domain shown on this page, find the most-recent RunDomain
    # that has each of: backlinks CR (→ Ahrefs link), wayback CR (→
    # Wayback link), whois_history CR (→ Whois link). Three IN-list
    # queries scoped to the visible domains keeps the per-page cost
    # constant regardless of total ban count. CRITERION_TO_LINK_KIND
    # is the only thing that decides which criteria surface — adding
    # availability later means one more entry here.
    CRITERION_TO_LINK_KIND = {
        "backlinks": "ahrefs",
        "wayback": "wayback",
        "whois_history": "whois",
    }
    links_by_domain: dict[str, dict[str, AnalysisLink]] = {
        r.domain: {} for r in rows
    }
    visible_domains = list(links_by_domain.keys())
    if visible_domains:
        # Pull all rds for the visible banned domains.
        rds = (
            db.query(RunDomain)
            .filter(RunDomain.domain.in_(visible_domains))
            .all()
        )
        rd_by_id: dict[int, RunDomain] = {rd.id: rd for rd in rds}
        rd_ids = list(rd_by_id.keys())
        run_ids = {rd.run_id for rd in rds}
        runs_by_id: dict[int, Run] = (
            {r.id: r for r in db.query(Run).filter(Run.id.in_(run_ids)).all()}
            if run_ids else {}
        )
        # Pull only the CR criteria we care about — done status only,
        # since "done" is what we want the user to be able to view.
        crs = (
            db.query(CriterionResult)
            .filter(CriterionResult.run_domain_id.in_(rd_ids))
            .filter(
                CriterionResult.criterion.in_(
                    list(CRITERION_TO_LINK_KIND.keys())
                )
            )
            .filter(CriterionResult.status == "done")
            .all()
        ) if rd_ids else []
        # Resolve per-(domain, criterion) latest rd. Most-recent =
        # highest rd id (rds are created in order).
        best: dict[tuple[str, str], int] = {}  # (domain, criterion) → rd_id
        for cr in crs:
            rd = rd_by_id.get(cr.run_domain_id)
            if rd is None:
                continue
            key = (rd.domain, cr.criterion)
            cur = best.get(key)
            if cur is None or rd.id > cur:
                best[key] = rd.id
        # Build AnalysisLink objects.
        for (domain, criterion), rd_id in best.items():
            rd = rd_by_id.get(rd_id)
            if rd is None:
                continue
            run = runs_by_id.get(rd.run_id)
            if run is None:
                continue
            kind = CRITERION_TO_LINK_KIND[criterion]
            links_by_domain[domain][kind] = AnalysisLink(
                kind=kind,
                job_id=run.job_id,
                run_id=run.id,
                run_domain_id=rd.id,
            )

    return BanListResponse(
        total=total,
        filtered_total=filtered_total,
        page=page,
        per_page=per_page,
        rows=[
            BanRow(
                domain=r.domain,
                note=r.note or "",
                created_at=r.created_at,
                ahrefs_link=links_by_domain.get(r.domain, {}).get("ahrefs"),
                wayback_link=links_by_domain.get(r.domain, {}).get("wayback"),
                whois_link=links_by_domain.get(r.domain, {}).get("whois"),
            )
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

    # Chunked commit (added 2026-05-14): process the normalized list in
    # batches of CHUNK_SIZE and commit each. Keeps a 5k-row CSV import
    # from holding a single write lock for seconds and starving other
    # writers (analyze submits, status changes). Counters accumulate
    # across chunks. Per-chunk semantics match the old single-tx path:
    # existing-domain note merge, new bans get snapshots, _snapshot_and
    # _delete_backlog runs against the current chunk's new-ban dict.
    CHUNK_SIZE = 500
    added = 0
    already = 0
    rows_added: list[str] = []
    now = datetime.utcnow()
    for chunk_start in range(0, len(normalized), CHUNK_SIZE):
        chunk = normalized[chunk_start : chunk_start + CHUNK_SIZE]
        chunk_domains = [d for d, _ in chunk]
        existing = {
            b.domain: b
            for b in db.query(DomainBan)
            .filter(DomainBan.domain.in_(chunk_domains))
            .all()
        }
        new_bans_by_domain: dict[str, DomainBan] = {}
        for d, note in chunk:
            if d in existing:
                # Note merge: only overwrite when the new note is non-empty
                # AND differs — lets the user re-import a CSV with updated
                # notes without losing earlier annotations on rows whose
                # note column was blank.
                if note and existing[d].note != note:
                    existing[d].note = note
                already += 1
                continue
            ban = DomainBan(domain=d, note=note, created_at=now)
            db.add(ban)
            rows_added.append(d)
            new_bans_by_domain[d] = ban
            added += 1
        # Snapshot + delete the matching Backlog rows for THIS chunk.
        # (Locked 2026-05-14, supersedes wave-O β.) Only NEW bans
        # trigger this — re-banning an already-banned domain is a no-op
        # (the prior ban already snapshotted + deleted the Backlog row
        # if relevant).
        _snapshot_and_delete_backlog(db, new_bans_by_domain)
        db.commit()
    return BanAddBulkOut(
        added=added,
        already_banned=already,
        invalid=invalid,
        rows_added=rows_added,
    )


@router.delete("/{domain}")
def delete_ban(domain: str, db: Session = Depends(get_db)) -> dict:
    """Unban a single domain. Restores the Backlog row from the snapshot
    captured at ban time (if any) — symmetric ban/unban (locked
    2026-05-14)."""
    d = _normalize_domain(domain)
    if not d:
        raise HTTPException(400, "invalid domain")
    row = db.get(DomainBan, d)
    if row is None:
        raise HTTPException(404, "not banned")
    restored = _restore_backlog_from_snapshot(db, row)
    db.delete(row)
    db.commit()
    return {"deleted": True, "domain": d, "restored": restored}


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
    # Restore Backlog rows BEFORE deleting the bans so we can read each
    # ban's snapshot. Preload existing Backlog domains in ONE IN-list
    # query so the restore helper doesn't do a SELECT-per-ban (was the
    # N+1 flagged in the 2026-05-14 perf audit). `synchronize_session=
    # False` is safe because we commit once at the end.
    bans = (
        db.query(DomainBan)
        .filter(DomainBan.domain.in_(normalized))
        .all()
    )
    existing_domains = {
        d
        for (d,) in db.query(BacklogDomain.domain)
        .filter(BacklogDomain.domain.in_(normalized))
        .all()
    }
    for ban in bans:
        _restore_backlog_from_snapshot(
            db, ban, existing_domains=existing_domains,
        )
    deleted = (
        db.query(DomainBan)
        .filter(DomainBan.domain.in_(normalized))
        .delete(synchronize_session=False)
    )
    db.commit()
    return BanBulkDeleteOut(deleted=int(deleted))
