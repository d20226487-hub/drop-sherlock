"""Backlog router — pre-analysis triage queue.

The backlog holds raw domain candidates pulled from registrars/auctions.
Listing is server-paginated (the table can grow into tens of thousands of
rows). Multi-select filters mirror the Database page's filters: status and
registrar are checkbox-multi (CSV in query string), expiration_date is a
range (from / to inclusive).

Phase 1 ships list + bulk-status + bulk-delete. CSV upload, send-to-analyze
redirect, and the passive 'were-analyzed' hint come in later phases.
"""
from __future__ import annotations

import asyncio
import csv
import io
from datetime import date, datetime
from typing import Iterator, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import distinct
from sqlalchemy.orm import Session

from ..app_settings import (
    IMPORT_MAX_ROWS_MAX,
    IMPORT_MAX_ROWS_MIN,
    get_import_max_rows,
    set_import_max_rows,
)
from ..db import SessionLocal, get_db
from ..models import (
    BACKLOG_STATUSES,
    BacklogDomain,
    JobCriterionPin,
    Run,
    RunDomain,
)

router = APIRouter(prefix="/backlog", tags=["backlog"])


# --- Schemas ----------------------------------------------------------------

class BacklogRow(BaseModel):
    id: int
    domain: str
    status: str
    registrar: str
    expiration_date: date | None
    comments: str
    desired_price: float | None
    max_price: float | None
    created_at: datetime
    updated_at: datetime
    # Set when the domain has been analyzed (most recent finished RunDomain
    # for that domain). Drives the clickable Domain cell — clicking opens
    # the per-domain page. Null when the domain isn't in the analysis
    # store yet.
    analyzed_run_domain_id: int | None = None
    analyzed_run_id: int | None = None
    analyzed_job_id: int | None = None


class BacklogListResponse(BaseModel):
    rows: list[BacklogRow]
    # `total` = count of every backlog row (no filters); `filtered_total` =
    # count after filters but before pagination. Both are needed to drive
    # the pagination bar AND the "X / Y total" hint.
    total: int
    filtered_total: int
    page: int
    per_page: int
    # Distinct registrar values across the full table — powers the
    # registrar filter's option list. May be null when the caller asked
    # to skip the options query (page navigation reuses the cached list).
    registrars: list[str] | None
    # Constant — echoed for the UI's status filter so the frontend doesn't
    # have to duplicate the enum.
    statuses: list[str]


class BulkStatusIn(BaseModel):
    ids: list[int]
    status: str


class BulkDeleteIn(BaseModel):
    ids: list[int]


# Caps for /backlog/import. The wizard's preview step warns the user
# before they upload thousands of rows; these caps are the backstop in
# case someone hits the endpoint directly (or accidentally pastes a
# multi-GB cell). The row cap is two-layered:
# - `_IMPORT_MAX_ROWS_HARD_CAP` is the absolute Pydantic-level safety
#   net; nothing larger than this is ever accepted, regardless of
#   settings.
# - The user-configurable cap (Settings → Others, default 50k) is
#   checked at request time below and produces a friendlier 422.
_IMPORT_MAX_ROWS_HARD_CAP = 500_000
_IMPORT_MAX_DOMAIN_LEN = 512
_IMPORT_MAX_REGISTRAR_LEN = 256
_IMPORT_MAX_COMMENTS_LEN = 4000


class ImportRowIn(BaseModel):
    """Pre-normalized row from the import wizard. The frontend parses CSV,
    applies the user's column mapping + format hints, and ships ISO date
    strings here so the backend stays format-agnostic."""
    domain: str = Field(max_length=_IMPORT_MAX_DOMAIN_LEN)
    status: str | None = None
    registrar: str | None = Field(default=None, max_length=_IMPORT_MAX_REGISTRAR_LEN)
    expiration_date: date | None = None
    comments: str | None = Field(default=None, max_length=_IMPORT_MAX_COMMENTS_LEN)
    desired_price: float | None = None
    max_price: float | None = None


class ImportIn(BaseModel):
    rows: list[ImportRowIn] = Field(max_length=_IMPORT_MAX_ROWS_HARD_CAP)


class ImportResult(BaseModel):
    inserted: int
    skipped_duplicates: int
    skipped_invalid: int
    # Domains rejected because they appear on the ban list (added wave L).
    # Distinct from duplicates so the user can tell "this was already in
    # the backlog" apart from "this is permanently banned".
    skipped_banned: int = 0
    # Subset of rejected-row diagnostics the UI surfaces ("row 12: bad
    # date"). Capped on the backend to keep the response small for huge
    # imports — UI shows the first ~20 with a "+N more" hint.
    errors: list[dict]


# --- Helpers ----------------------------------------------------------------

def _parse_status_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    out: list[str] = []
    for piece in raw.split(","):
        s = piece.strip()
        if not s:
            continue
        if s not in BACKLOG_STATUSES:
            raise HTTPException(400, f"unknown status: {s}")
        out.append(s)
    return out


def _parse_registrar_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def _apply_backlog_filters(
    q,
    *,
    search: str = "",
    statuses: list[str] | None = None,
    registrars_filter: list[str] | None = None,
    expiry_from: date | None = None,
    expiry_to: date | None = None,
):
    """Compose the standard set of filters onto a BacklogDomain query.
    Used by every endpoint that scopes by user-chosen filters (list,
    export, bulk-status-filtered, send-to-analyze) so a new filter only
    needs to be added in one place."""
    if search and search.strip():
        needle = f"%{search.strip().lower()}%"
        q = q.filter(BacklogDomain.domain.ilike(needle))
    if statuses:
        q = q.filter(BacklogDomain.status.in_(statuses))
    if registrars_filter:
        q = q.filter(BacklogDomain.registrar.in_(registrars_filter))
    if expiry_from is not None:
        q = q.filter(BacklogDomain.expiration_date >= expiry_from)
    if expiry_to is not None:
        q = q.filter(BacklogDomain.expiration_date <= expiry_to)
    return q


# Whitelist of sortable columns. Anything else from the query string is
# rejected so the UI can't accidentally sort by an unindexed text field.
SORTABLE = {
    "expiration_date": BacklogDomain.expiration_date,
    "desired_price": BacklogDomain.desired_price,
    "max_price": BacklogDomain.max_price,
}


def _resolve_analyzed_links(
    db: Session, domains: list[str],
) -> dict[str, tuple[int, int, int]]:
    """For each backlog domain, return the (run_domain_id, run_id, job_id)
    we should deep-link to from the Backlog row's domain cell. Migrated
    2026-05-14 to read from JobCriterionPin instead of the legacy
    RunDomain.is_pinned column (which the pin endpoints no longer
    write). Strategy:

      1. Find every JobCriterionPin whose pinned Run contains a
         RunDomain for one of these domains.
      2. Among those, pick the pin with the largest `updated_at` per
         domain — that's "the most recently asserted truth."
      3. Resolve the corresponding RunDomain id for the deep-link.

    Domains with no JobCriterionPin pointing at any of their runs
    receive no link (matches the old "unpinned = blank" semantic).
    """
    if not domains:
        return {}
    rows = (
        db.query(
            RunDomain.domain,
            RunDomain.id,
            RunDomain.run_id,
            Run.job_id,
            JobCriterionPin.updated_at,
        )
        .join(Run, Run.id == RunDomain.run_id)
        .join(
            JobCriterionPin,
            (JobCriterionPin.run_id == Run.id)
            & (JobCriterionPin.job_id == Run.job_id),
        )
        .filter(RunDomain.domain.in_(domains))
        .all()
    )
    # Pick the most-recently-updated pin per domain. Sort then dict-build
    # (small enough to be cheap; max ~hundreds of rows per page).
    rows.sort(key=lambda r: (r[0], r[4] or 0), reverse=True)
    out: dict[str, tuple[int, int, int]] = {}
    for dom, rd_id, run_id, job_id, _ in rows:
        if dom not in out:
            out[dom] = (rd_id, run_id, job_id)
    return out


def _apply_sort(q, sort: str | None, direction: str | None):
    """Apply user-chosen sort to a backlog query. Default (no sort) is
    newest-first by created_at — same as the original list behaviour.
    Nulls are pushed to the end in both directions so the user always sees
    real values first regardless of asc/desc."""
    if not sort:
        return q.order_by(
            BacklogDomain.created_at.desc(), BacklogDomain.id.desc(),
        )
    col = SORTABLE.get(sort)
    if col is None:
        raise HTTPException(400, f"unknown sort column: {sort}")
    dir_ = (direction or "asc").lower()
    if dir_ not in ("asc", "desc"):
        raise HTTPException(400, "direction must be asc or desc")
    # `col.is_(None)` evaluates to 0/1; ordering by it ascending puts
    # non-null rows first regardless of the main sort direction.
    nulls_last = col.is_(None).asc()
    main = col.asc() if dir_ == "asc" else col.desc()
    return q.order_by(nulls_last, main, BacklogDomain.id.desc())


# --- Endpoints --------------------------------------------------------------

def list_backlog(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
    search: str = "",
    status: str | None = None,
    registrar: str | None = None,
    expiry_from: date | None = None,
    expiry_to: date | None = None,
    sort: str | None = None,
    direction: str | None = None,
    # When false, the response skips `total` (full-table count) and
    # `registrars` (DISTINCT scan) — at hundreds of thousands of rows
    # those add up across page-by-page navigation. The frontend uses the
    # cached values from the initial fetch and only re-fetches them after
    # mutations.
    include_options: bool = Query(True),
    db: Session = Depends(get_db),
) -> BacklogListResponse:
    """Server-paginated list. Filters compose with AND across kinds; OR
    inside each multi-select kind.

    Sync impl. The async route (`_list_backlog_route`) wraps this in
    asyncio.to_thread."""
    statuses = _parse_status_csv(status)
    registrars_filter = _parse_registrar_csv(registrar)

    base = db.query(BacklogDomain)
    total = base.count() if include_options else 0

    q = _apply_backlog_filters(
        base,
        search=search,
        statuses=statuses,
        registrars_filter=registrars_filter,
        expiry_from=expiry_from,
        expiry_to=expiry_to,
    )

    filtered_total = q.count()

    q = _apply_sort(q, sort, direction)
    rows: list[BacklogDomain] = (
        q.offset((page - 1) * per_page).limit(per_page).all()
    )

    registrar_options: list[str] | None = None
    if include_options:
        # Distinct registrars across the FULL table (not the filtered set) so
        # the registrar filter's options stay stable as the user toggles other
        # filters. Empty-string registrar is excluded.
        registrar_rows = (
            db.query(distinct(BacklogDomain.registrar))
            .filter(BacklogDomain.registrar != "")
            .order_by(BacklogDomain.registrar.asc())
            .all()
        )
        registrar_options = [r[0] for r in registrar_rows]

    analyzed_links = _resolve_analyzed_links(db, [r.domain for r in rows])

    return BacklogListResponse(
        rows=[
            BacklogRow(
                id=r.id,
                domain=r.domain,
                status=r.status,
                registrar=r.registrar,
                expiration_date=r.expiration_date,
                comments=r.comments,
                desired_price=r.desired_price,
                max_price=r.max_price,
                created_at=r.created_at,
                updated_at=r.updated_at,
                analyzed_run_domain_id=(analyzed_links.get(r.domain) or (None, None, None))[0],
                analyzed_run_id=(analyzed_links.get(r.domain) or (None, None, None))[1],
                analyzed_job_id=(analyzed_links.get(r.domain) or (None, None, None))[2],
            )
            for r in rows
        ],
        total=total,
        filtered_total=filtered_total,
        page=page,
        per_page=per_page,
        registrars=registrar_options,
        statuses=list(BACKLOG_STATUSES),
    )


@router.get("", response_model=BacklogListResponse)
async def _list_backlog_route(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
    search: str = "",
    status: str | None = None,
    registrar: str | None = None,
    expiry_from: date | None = None,
    expiry_to: date | None = None,
    sort: str | None = None,
    direction: str | None = None,
    include_options: bool = Query(True),
) -> BacklogListResponse:
    """Async wrapper for `list_backlog`. The DB-bound work (filter
    counts, paged read, registrar DISTINCT, analyzed-links lookup)
    runs in an executor thread so the event loop stays responsive
    even when /backlog is hit concurrently."""
    return await asyncio.to_thread(
        _run_list_backlog,
        page,
        per_page,
        search,
        status,
        registrar,
        expiry_from,
        expiry_to,
        sort,
        direction,
        include_options,
    )


def _run_list_backlog(
    page: int,
    per_page: int,
    search: str,
    status: str | None,
    registrar: str | None,
    expiry_from: date | None,
    expiry_to: date | None,
    sort: str | None,
    direction: str | None,
    include_options: bool,
) -> BacklogListResponse:
    db = SessionLocal()
    try:
        return list_backlog(
            page=page,
            per_page=per_page,
            search=search,
            status=status,
            registrar=registrar,
            expiry_from=expiry_from,
            expiry_to=expiry_to,
            sort=sort,
            direction=direction,
            include_options=include_options,
            db=db,
        )
    finally:
        db.close()


class UpdateRowIn(BaseModel):
    """Per-row partial update from the inline editors. Only fields actually
    sent are applied (Pydantic's `exclude_unset` discriminates between
    'absent' and 'set to null'), so the user can clear a price by sending
    `{desired_price: null}` without nuking the other fields."""
    model_config = {"extra": "forbid"}

    comments: str | None = None
    desired_price: float | None = None
    max_price: float | None = None


@router.patch("/{row_id}", response_model=BacklogRow)
def update_row(row_id: int, payload: UpdateRowIn, db: Session = Depends(get_db)):
    row = db.get(BacklogDomain, row_id)
    if row is None:
        raise HTTPException(404, "backlog row not found")
    data = payload.model_dump(exclude_unset=True)
    if "comments" in data:
        # comments column is NOT NULL (defaults to ""), so a "clear" from
        # the UI lands as an empty string, not NULL.
        row.comments = data["comments"] or ""
    for k in ("desired_price", "max_price"):
        if k in data:
            v = data[k]
            if v is not None and v < 0:
                raise HTTPException(400, f"{k} must be non-negative")
            setattr(row, k, v)
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return BacklogRow(
        id=row.id,
        domain=row.domain,
        status=row.status,
        registrar=row.registrar,
        expiration_date=row.expiration_date,
        comments=row.comments,
        desired_price=row.desired_price,
        max_price=row.max_price,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


EXPORT_COLUMNS: list[str] = [
    "domain",
    "status",
    "registrar",
    "expiration_date",
    "comments",
    "desired_price",
    "max_price",
    "created_at",
    "updated_at",
]


def _row_to_csv_values(r: BacklogDomain) -> list[str]:
    """Convert one backlog row into the export's column order. Empty
    strings for None so spreadsheet apps don't show 'None'."""
    return [
        r.domain,
        r.status,
        r.registrar or "",
        r.expiration_date.isoformat() if r.expiration_date else "",
        r.comments or "",
        "" if r.desired_price is None else f"{r.desired_price:g}",
        "" if r.max_price is None else f"{r.max_price:g}",
        r.created_at.isoformat() if r.created_at else "",
        r.updated_at.isoformat() if r.updated_at else "",
    ]


def _csv_stream(rows: Iterator[BacklogDomain]) -> Iterator[str]:
    """Yield CSV chunks one row at a time. csv.writer wants a file-like;
    we reuse a single StringIO and reset between rows so we don't allocate
    a fresh buffer per row at thousands-of-row scale."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(EXPORT_COLUMNS)
    yield buf.getvalue()
    buf.seek(0)
    buf.truncate(0)
    for r in rows:
        w.writerow(_row_to_csv_values(r))
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)


@router.get("/export.csv")
def export_csv(
    scope: str = Query("filtered", pattern="^(filtered|all)$"),
    search: str = "",
    status: str | None = None,
    registrar: str | None = None,
    expiry_from: date | None = None,
    expiry_to: date | None = None,
    sort: str | None = None,
    direction: str | None = None,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Streaming CSV download. `scope=filtered` honours the same filter
    params as the list endpoint (so the user can export exactly what
    they're looking at); `scope=all` ignores filters and dumps the whole
    backlog. Streamed row-by-row to keep memory flat at thousands-of-row
    scale."""
    q = db.query(BacklogDomain)
    if scope == "filtered":
        q = _apply_backlog_filters(
            q,
            search=search,
            statuses=_parse_status_csv(status),
            registrars_filter=_parse_registrar_csv(registrar),
            expiry_from=expiry_from,
            expiry_to=expiry_to,
        )
    q = _apply_sort(q, sort, direction)

    today = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"drop-sherlock-backlog-{scope}-{today}.csv"
    return StreamingResponse(
        _csv_stream(iter(q.yield_per(500))),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Statuses that DON'T trigger the "X were analyzed; mark them?" hint.
# `analyzed` is obvious; `discarded` means the user has actively dismissed
# the domain so don't nag about it.
_ANALYZED_HINT_EXCLUDED = (
    "analyzed",
    "order",
    "backordered",
    "bought",
    "discarded",
)


@router.get("/analyzed-pending")
def analyzed_pending(db: Session = Depends(get_db)) -> dict:
    """Backlog rows whose domain has a manually-pinned definitive
    RunDomain but whose backlog status hasn't been moved to
    'analyzed'/'discarded' yet. Drives the passive 'X domains were
    analyzed; mark them?' hint.

    Pinned-only semantics — matches the Domain cell link's rule (a
    domain only "counts as analyzed" once the user has pinned a
    definitive run for it). Done-but-unpinned domains don't fire the
    hint. Returns the row ids so the frontend can hand them straight to
    bulk-status without re-querying.

    Migrated 2026-05-14: reads pin-state from JobCriterionPin instead of
    the legacy RunDomain.is_pinned column."""
    pinned_domains_subq = (
        db.query(distinct(RunDomain.domain))
        .join(Run, Run.id == RunDomain.run_id)
        .join(
            JobCriterionPin,
            (JobCriterionPin.run_id == Run.id)
            & (JobCriterionPin.job_id == Run.job_id),
        )
        .subquery()
    )
    rows = (
        db.query(BacklogDomain.id)
        .filter(~BacklogDomain.status.in_(_ANALYZED_HINT_EXCLUDED))
        .filter(BacklogDomain.domain.in_(pinned_domains_subq))
        .all()
    )
    ids = [r[0] for r in rows]
    return {"count": len(ids), "ids": ids}


@router.post("/bulk-status")
def bulk_status(payload: BulkStatusIn, db: Session = Depends(get_db)) -> dict:
    """Set `status` on every row whose id is in the list. No-op for unknown
    ids. Idempotent."""
    if payload.status not in BACKLOG_STATUSES:
        raise HTTPException(400, f"unknown status: {payload.status}")
    if not payload.ids:
        return {"updated": 0}
    n = (
        db.query(BacklogDomain)
        .filter(BacklogDomain.id.in_(payload.ids))
        .update({"status": payload.status, "updated_at": datetime.utcnow()},
                synchronize_session=False)
    )
    db.commit()
    return {"updated": n}


class BulkStatusFilteredIn(BaseModel):
    """Bulk status change scoped by the same filters as the list endpoint.
    Lets the user say "set every filtered row to discarded" without first
    selecting a page's worth of rows. Filters are CSV strings to match the
    list endpoint's query-param shape."""
    status: str
    search: str = ""
    status_filter: str | None = None
    registrar: str | None = None
    expiry_from: date | None = None
    expiry_to: date | None = None


class SendToAnalyzeIn(BaseModel):
    """Two scopes: 'ids' uses an explicit row-id list (selection toolbar);
    'filtered' resolves the same filter shape as the list endpoint
    (all-filtered bar). The endpoint always returns the resolved domain
    strings so the frontend can hand them to the Analyze form, and as a
    side effect flips the affected rows' status to 'in_progress' (the
    locked exception to the otherwise-manual status rule)."""
    scope: Literal["ids", "filtered"]
    ids: list[int] | None = None
    search: str = ""
    status_filter: str | None = None
    registrar: str | None = None
    expiry_from: date | None = None
    expiry_to: date | None = None


@router.post("/send-to-analyze")
def send_to_analyze(
    payload: SendToAnalyzeIn, db: Session = Depends(get_db),
) -> dict:
    if payload.scope == "ids":
        if not payload.ids:
            return {"domains": [], "count": 0, "status_changed": 0}
        q = db.query(BacklogDomain).filter(BacklogDomain.id.in_(payload.ids))
    else:
        q = _apply_backlog_filters(
            db.query(BacklogDomain),
            search=payload.search,
            statuses=_parse_status_csv(payload.status_filter),
            registrars_filter=_parse_registrar_csv(payload.registrar),
            expiry_from=payload.expiry_from,
            expiry_to=payload.expiry_to,
        )

    # Pull just the domain strings + ids — no need for full rows.
    rows = q.with_entities(BacklogDomain.id, BacklogDomain.domain).all()
    if not rows:
        return {"domains": [], "count": 0, "status_changed": 0}
    domains = [d for _id, d in rows]
    ids = [_id for _id, _d in rows]

    # Side-effect: auto-flip status to in_progress. This is the one
    # exception to the "statuses change manually only" rule (locked
    # 2026-05-09). Excludes already-in_progress rows from the count so
    # the UI's "marked X as in_progress" hint stays honest.
    n = (
        db.query(BacklogDomain)
        .filter(BacklogDomain.id.in_(ids))
        .filter(BacklogDomain.status != "in_progress")
        .update(
            {"status": "in_progress", "updated_at": datetime.utcnow()},
            synchronize_session=False,
        )
    )
    db.commit()
    return {"domains": domains, "count": len(domains), "status_changed": n}


@router.post("/bulk-status-filtered")
def bulk_status_filtered(
    payload: BulkStatusFilteredIn, db: Session = Depends(get_db),
) -> dict:
    if payload.status not in BACKLOG_STATUSES:
        raise HTTPException(400, f"unknown status: {payload.status}")
    q = _apply_backlog_filters(
        db.query(BacklogDomain),
        search=payload.search,
        statuses=_parse_status_csv(payload.status_filter),
        registrars_filter=_parse_registrar_csv(payload.registrar),
        expiry_from=payload.expiry_from,
        expiry_to=payload.expiry_to,
    )

    n = q.update(
        {"status": payload.status, "updated_at": datetime.utcnow()},
        synchronize_session=False,
    )
    db.commit()
    return {"updated": n}


@router.post("/bulk-delete")
def bulk_delete(payload: BulkDeleteIn, db: Session = Depends(get_db)) -> dict:
    """Permanently delete the listed rows. No-op for unknown ids."""
    if not payload.ids:
        return {"deleted": 0}
    n = (
        db.query(BacklogDomain)
        .filter(BacklogDomain.id.in_(payload.ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": n}


class BulkDeleteFilteredIn(BaseModel):
    """Bulk delete scoped by the same filters as the list endpoint. Lets
    the user say "delete every row matching this registrar+status filter"
    without first selecting page-by-page. Mirrors BulkStatusFilteredIn."""
    search: str = ""
    status_filter: str | None = None
    registrar: str | None = None
    expiry_from: date | None = None
    expiry_to: date | None = None


@router.post("/bulk-delete-filtered")
def bulk_delete_filtered(
    payload: BulkDeleteFilteredIn, db: Session = Depends(get_db),
) -> dict:
    q = _apply_backlog_filters(
        db.query(BacklogDomain),
        search=payload.search,
        statuses=_parse_status_csv(payload.status_filter),
        registrars_filter=_parse_registrar_csv(payload.registrar),
        expiry_from=payload.expiry_from,
        expiry_to=payload.expiry_to,
    )
    n = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": int(n)}


def _normalize_domain(raw: str) -> str:
    """Strip scheme + leading www + trailing slash/path, lowercase. Mirrors
    the Analyze pipeline's normalization so a domain imported here has the
    same key it'd have on a Database row, enabling Phase 4's "linked to
    analyzed domain" lookup."""
    s = raw.strip().lower()
    if not s:
        return ""
    # Strip scheme
    if "://" in s:
        s = s.split("://", 1)[1]
    # Strip leading www.
    if s.startswith("www."):
        s = s[4:]
    # Drop anything from the first slash onward (paths, query strings)
    if "/" in s:
        s = s.split("/", 1)[0]
    # Drop port if present
    if ":" in s:
        s = s.split(":", 1)[0]
    return s


class ImportLimitIn(BaseModel):
    """Caller passes an integer in [IMPORT_MAX_ROWS_MIN, IMPORT_MAX_ROWS_MAX]."""
    rows: int


@router.get("/import-limit")
def get_import_limit():
    """Current user-configured cap on rows accepted by /backlog/import.
    Also returns the absolute min/max bounds so the Settings UI can
    validate without hard-coding them."""
    return {
        "rows": get_import_max_rows(),
        "min": IMPORT_MAX_ROWS_MIN,
        "max": IMPORT_MAX_ROWS_MAX,
    }


@router.put("/import-limit")
def put_import_limit(payload: ImportLimitIn):
    try:
        v = set_import_max_rows(payload.rows)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"rows": v}


@router.post("/import", response_model=ImportResult)
def import_rows(payload: ImportIn, db: Session = Depends(get_db)) -> ImportResult:
    """Bulk-insert pre-normalized rows. Domain dedup is across the entire
    backlog: a row whose domain already exists is silently skipped (per the
    user's locked policy — re-uploads of the same auction list don't
    re-create or mutate existing rows). Status defaults to 'backlog' when
    not provided; unknown statuses map to 'backlog' rather than failing the
    row, since the import wizard's mapping UI already constrains the choice."""
    # User-configurable row cap (Settings → Others). Read at request time
    # so changes take effect without restarting. The Pydantic
    # `_IMPORT_MAX_ROWS_HARD_CAP` already rejected anything obviously
    # absurd above; this just enforces the user's narrower preference
    # with a friendly message.
    user_cap = get_import_max_rows()
    if len(payload.rows) > user_cap:
        raise HTTPException(
            413,
            f"Import has {len(payload.rows)} rows; the configured limit is "
            f"{user_cap}. Raise it under Settings → Others, or split the file.",
        )
    if not payload.rows:
        return ImportResult(
            inserted=0, skipped_duplicates=0, skipped_invalid=0, errors=[],
        )

    # Normalize domains + collect errors before touching the DB. Capping
    # at 20 errors keeps the response payload small even when an entire
    # 5000-row import is malformed.
    MAX_ERRORS = 20
    errors: list[dict] = []
    valid: list[ImportRowIn] = []
    seen_in_payload: set[str] = set()
    intra_payload_dupes = 0
    for i, row in enumerate(payload.rows):
        norm = _normalize_domain(row.domain)
        if not norm:
            if len(errors) < MAX_ERRORS:
                errors.append({"row_index": i, "message": "empty domain"})
            continue
        if norm in seen_in_payload:
            # Duplicate inside the upload itself — count as a dupe so the
            # UI's "skipped X duplicates" total reflects everything skipped.
            intra_payload_dupes += 1
            continue
        seen_in_payload.add(norm)
        # Fix the row's domain to the normalized form for the actual insert.
        row.domain = norm
        if row.status not in BACKLOG_STATUSES:
            row.status = "backlog"
        valid.append(row)

    if not valid:
        return ImportResult(
            inserted=0,
            skipped_duplicates=intra_payload_dupes,
            skipped_invalid=len(payload.rows) - intra_payload_dupes,
            errors=errors,
        )

    # Ban-list pre-filter (added 2026-05-13 wave L). Surfaced as a
    # separate counter so the user can tell "duplicate" apart from
    # "banned" in the import summary.
    from ..ban_filter import filter_banned
    domains_for_ban_check = [r.domain for r in valid]
    _allowed, banned_set = filter_banned(db, domains_for_ban_check)
    if banned_set:
        valid = [r for r in valid if r.domain not in banned_set]
    skipped_banned = len(banned_set)

    # One query to find which of the payload's domains are already in the
    # DB — vastly faster than per-row INSERT-with-IntegrityError-catch.
    domains = [r.domain for r in valid]
    existing = {
        d
        for (d,) in db.query(BacklogDomain.domain)
        .filter(BacklogDomain.domain.in_(domains))
        .all()
    } if domains else set()
    db_dupes = 0
    inserted = 0
    for r in valid:
        if r.domain in existing:
            db_dupes += 1
            continue
        db.add(
            BacklogDomain(
                domain=r.domain,
                status=r.status or "backlog",
                registrar=r.registrar or "",
                expiration_date=r.expiration_date,
                comments=r.comments or "",
                desired_price=r.desired_price,
                max_price=r.max_price,
            )
        )
        inserted += 1
    db.commit()

    skipped_invalid = (
        len(payload.rows) - len(valid) - intra_payload_dupes - skipped_banned
    )
    return ImportResult(
        inserted=inserted,
        skipped_duplicates=intra_payload_dupes + db_dupes,
        skipped_invalid=skipped_invalid,
        skipped_banned=skipped_banned,
        errors=errors,
    )
