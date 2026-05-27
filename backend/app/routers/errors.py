"""Errors router — unified read view across every error source we persist.

Phase 1 (already-persisted sources, no new tables needed):
- AI verdict failures   → CriterionResult.ai_verdict_error
- Ahrefs fetch failures → CriterionResult.error
- Domain failures       → RunDomain.error
- Run failures          → Run.error

Phase 2 (sink for live capture):
- Server-side log/exception capture → ErrorLog table

Each error gets a stable identity `(source_kind, source_id, message_hash)`
where message_hash = sha256(message + traceback). The user can dismiss /
restore individual entries; if the source row's message later changes
(e.g. a refetch produces a new error), the dismissal naturally lapses
because the new message hashes differently.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, selectinload

from ..app_settings import (
    ERROR_RETENTION_OPTIONS,
    get_error_retention_days,
    set_error_retention_days,
)
from ..db import get_db
from ..models import (
    CriterionResult,
    DismissedError,
    ErrorLog,
    Run,
    RunDomain,
)

router = APIRouter(prefix="/errors", tags=["errors"])


# Public-facing category labels. `kind` (internal) is one of SourceKind;
# category for criterion_fetch rows is derived per-row from the criterion's
# upstream provider (Ahrefs vs Wayback) — see `_fetch_category_for_criterion`.
Category = Literal["ai", "ahrefs", "wayback", "domain", "run", "backend"]
SourceKind = Literal[
    "criterion_ai", "criterion_fetch", "run_domain", "run", "log"
]

ALL_CATEGORIES: list[Category] = [
    "ai", "ahrefs", "wayback", "domain", "run", "backend",
]


def _fetch_category_for_criterion(criterion: str) -> Category:
    """A failed criterion_fetch row's category depends on which provider
    actually owns the criterion. Without this Wayback errors would
    incorrectly surface under the Ahrefs tab."""
    if criterion == "wayback":
        return "wayback"
    return "ahrefs"


def _hash_message(message: str, traceback: str = "") -> str:
    """sha256(message + sep + traceback). Stable identifier for an error
    instance — used as part of the dismissal composite key so a different
    error on the same source row doesn't inherit a stale dismissal."""
    h = hashlib.sha256()
    h.update(message.encode("utf-8", errors="replace"))
    if traceback:
        h.update(b"\x1f")  # field separator
        h.update(traceback.encode("utf-8", errors="replace"))
    return h.hexdigest()


# --- Schemas ----------------------------------------------------------------

class ErrorRow(BaseModel):
    # Composite identity — used by dismiss/restore.
    source_kind: SourceKind
    source_id: int
    message_hash: str

    category: Category
    occurred_at: datetime | None
    message: str
    # Truncated single-line preview for the table row. Full message stays in
    # `message`. Empty when message has no newlines.
    preview: str
    # Free-form extras for context — current value depends on source.
    context: dict
    # Click-through pointers, populated when known.
    job_id: int | None = None
    run_id: int | None = None
    run_domain_id: int | None = None
    criterion: str | None = None

    dismissed_at: datetime | None = None


class ErrorListResponse(BaseModel):
    errors: list[ErrorRow]
    counts: dict[str, int]  # by category, plus 'total' / 'open' / 'dismissed'


class DismissIn(BaseModel):
    source_kind: SourceKind
    source_id: int
    message_hash: str


class BulkDismissIn(BaseModel):
    # Echo of the same filters as /errors GET so "dismiss everything I'm
    # currently looking at" is honest. Defaults: dismiss every open error.
    category: Category | None = None
    search: str | None = None


# --- Helpers ----------------------------------------------------------------

def _preview(message: str, maxlen: int = 200) -> str:
    if not message:
        return ""
    first_line = message.splitlines()[0]
    if len(first_line) > maxlen:
        return first_line[:maxlen] + "…"
    return first_line


# Hard cap on rows pulled from each source per /errors call. With Phase-2
# log capture + retention auto-prune in place, the persisted-source tables
# stay small in normal use, but nothing prevents a runaway provider from
# flooding criterion_results.error during one bad run. SQL-side limit
# keeps the response time bounded even in that case; the per-request
# `limit` param further trims AFTER all sources are merged.
_PER_SOURCE_HARD_CAP = 5000


def _gather_persisted_errors(db: Session) -> list[ErrorRow]:
    """Walk the four DB sources and emit one ErrorRow per non-empty error
    field. NO joins on dismissal yet — that's done after collection.

    Eager-loads `run_domain` + `run_domain.run` on CriterionResult so the
    `cr.run_domain.run.job_id` access in the loop doesn't fire one query
    per row (was N+1 at hundreds of errors). Same for `run_domain.run` on
    the standalone RunDomain query."""
    rows: list[ErrorRow] = []

    # 1. CriterionResult.ai_verdict_error  → category=ai
    # 2. CriterionResult.error             → category=ahrefs
    crits: list[CriterionResult] = (
        db.query(CriterionResult)
        .options(
            selectinload(CriterionResult.run_domain).selectinload(
                RunDomain.run
            )
        )
        .filter(
            (CriterionResult.ai_verdict_error != "")
            | (CriterionResult.error != "")
        )
        .order_by(CriterionResult.id.desc())
        .limit(_PER_SOURCE_HARD_CAP)
        .all()
    )
    for cr in crits:
        rd = cr.run_domain
        run_id = rd.run_id if rd else None
        job_id = rd.run.job_id if rd and rd.run else None
        if cr.ai_verdict_error:
            msg = cr.ai_verdict_error
            rows.append(ErrorRow(
                source_kind="criterion_ai",
                source_id=cr.id,
                message_hash=_hash_message(msg),
                category="ai",
                occurred_at=cr.fetched_at,
                message=msg,
                preview=_preview(msg),
                context={
                    "ai_provider": cr.ai_provider,
                    "ai_model": cr.ai_model,
                    "criterion": cr.criterion,
                    "domain": rd.domain if rd else None,
                },
                job_id=job_id,
                run_id=run_id,
                run_domain_id=rd.id if rd else None,
                criterion=cr.criterion,
            ))
        if cr.error:
            msg = cr.error
            rows.append(ErrorRow(
                source_kind="criterion_fetch",
                source_id=cr.id,
                message_hash=_hash_message(msg),
                category=_fetch_category_for_criterion(cr.criterion),
                occurred_at=cr.fetched_at,
                message=msg,
                preview=_preview(msg),
                context={
                    "http_status": cr.http_status,
                    "criterion": cr.criterion,
                    "domain": rd.domain if rd else None,
                },
                job_id=job_id,
                run_id=run_id,
                run_domain_id=rd.id if rd else None,
                criterion=cr.criterion,
            ))

    # 3. RunDomain.error  → category=domain
    rds: list[RunDomain] = (
        db.query(RunDomain)
        .options(selectinload(RunDomain.run))
        .filter(RunDomain.error != "")
        .order_by(RunDomain.id.desc())
        .limit(_PER_SOURCE_HARD_CAP)
        .all()
    )
    for rd in rds:
        msg = rd.error
        job_id = rd.run.job_id if rd.run else None
        rows.append(ErrorRow(
            source_kind="run_domain",
            source_id=rd.id,
            message_hash=_hash_message(msg),
            category="domain",
            occurred_at=rd.finished_at or rd.started_at,
            message=msg,
            preview=_preview(msg),
            context={
                "domain": rd.domain,
                "status": rd.status,
            },
            job_id=job_id,
            run_id=rd.run_id,
            run_domain_id=rd.id,
        ))

    # 4. Run.error  → category=run
    runs: list[Run] = (
        db.query(Run)
        .filter(Run.error != "")
        .order_by(Run.id.desc())
        .limit(_PER_SOURCE_HARD_CAP)
        .all()
    )
    for r in runs:
        msg = r.error
        rows.append(ErrorRow(
            source_kind="run",
            source_id=r.id,
            message_hash=_hash_message(msg),
            category="run",
            occurred_at=r.finished_at or r.started_at,
            message=msg,
            preview=_preview(msg),
            context={"status": r.status},
            job_id=r.job_id,
            run_id=r.id,
        ))

    return rows


def _gather_log_errors(db: Session) -> list[ErrorRow]:
    """Phase 2 — server-side captured errors. One ErrorRow per row."""
    out: list[ErrorRow] = []
    logs: list[ErrorLog] = (
        db.query(ErrorLog)
        .order_by(ErrorLog.id.desc())
        .limit(_PER_SOURCE_HARD_CAP)
        .all()
    )
    for l in logs:
        out.append(ErrorRow(
            source_kind="log",
            source_id=l.id,
            message_hash=_hash_message(l.message, l.traceback),
            category="backend",
            occurred_at=l.created_at,
            message=l.message + ("\n\n" + l.traceback if l.traceback else ""),
            preview=_preview(l.message),
            context={
                "source": l.source,
                "level": l.level,
                "ctx": l.context_json,
            },
        ))
    return out


def _annotate_dismissals(
    db: Session, rows: list[ErrorRow]
) -> None:
    """Mutate `rows` in place — set dismissed_at where a matching
    DismissedError row exists. Single query covers all rows."""
    if not rows:
        return
    keys = {(r.source_kind, r.source_id, r.message_hash) for r in rows}
    # SQLAlchemy doesn't have a clean tuple-IN — build an OR of ANDs by
    # batching unique source_ids per kind. For our scale (single user,
    # <thousands of error rows) one query that fetches all dismissals is
    # simpler and fast enough.
    dismissed: list[DismissedError] = db.query(DismissedError).all()
    by_key: dict[tuple[str, int, str], datetime] = {}
    for d in dismissed:
        by_key[(d.source_kind, d.source_id, d.message_hash)] = d.dismissed_at
    for r in rows:
        ts = by_key.get((r.source_kind, r.source_id, r.message_hash))
        if ts is not None:
            r.dismissed_at = ts


# --- Endpoints --------------------------------------------------------------

def prune_old_error_log(db: Session, retention_days: int | None) -> int:
    """Hard-delete ErrorLog rows older than `retention_days`, regardless
    of dismiss status. Companion to `prune_dismissed_errors`.

    Why both: `prune_dismissed_errors` only drops ErrorLog rows when
    the user has explicitly clicked Dismiss AND the dismissal has aged
    past retention. Undismissed-but-forgotten ErrorLog rows
    (background-job exceptions, opportunistic `log.exception` calls
    from cascade providers, the wayback / WhoisFreaks 429 retries that
    eventually succeed but log the intermediate failures) accumulate
    forever without this sweep. For a 30-day retention, "I haven't
    dismissed it AND it's >30 days old" reliably means "noise" — the
    operator wasn't going to look at it.

    Persisted-source errors (criterion_results.error / .ai_verdict_error
    / run_domains.error / runs.error) are NOT touched by this — they
    live on rows whose lifecycle is owned by the run system. Only the
    Phase-2 sink (`error_log` table) is age-pruned.

    Returns the count deleted. Batched (1000/round) to avoid long
    SQLite writer locks if a long-overdue prune sweeps a huge backlog
    (e.g. retention flipped Never → 7 after months of accumulation)."""
    if retention_days is None:
        return 0
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    BATCH = 1000
    total = 0
    while True:
        # Pull a batch of expired IDs first, then delete by IN-list.
        # Two-step rather than `DELETE … WHERE created_at < cutoff
        # LIMIT N` because SQLite's DELETE doesn't support LIMIT
        # without a non-default compile flag.
        ids = [
            row[0] for row in
            db.query(ErrorLog.id)
            .filter(ErrorLog.created_at < cutoff)
            .order_by(ErrorLog.id.asc())
            .limit(BATCH)
            .all()
        ]
        if not ids:
            break
        deleted = (
            db.query(ErrorLog)
            .filter(ErrorLog.id.in_(ids))
            .delete(synchronize_session=False)
        )
        # Cascade cleanup: any DismissedError that pointed at these
        # ErrorLog rows is now a dangling reference. Harmless (the
        # composite-key lookup would just miss) but unused, so drop
        # them here to keep the table tidy. This is also what
        # `prune_dismissed_errors`'s log-branch would have done if the
        # dismissal had been the one to expire first.
        db.query(DismissedError).filter(
            DismissedError.source_kind == "log",
            DismissedError.source_id.in_(ids),
        ).delete(synchronize_session=False)
        db.commit()
        total += deleted
        if len(ids) < BATCH:
            break
    return total


def prune_dismissed_errors(db: Session, retention_days: int | None) -> dict[str, int]:
    """Delete dismissed errors whose `dismissed_at` is older than the cutoff.
    Open errors are never touched — only dismissed ones age out.

    For each expired DismissedError row:
    - source_kind=log: delete the ErrorLog row entirely.
    - persisted-source kinds: clear the `error` column on the source row,
      but ONLY when the current message still matches the dismissed hash
      (otherwise a fresh, undismissed error is on the row and we leave it
      alone). The CriterionResult/RunDomain/Run row itself stays.

    The dismissal record is always removed afterward so the prune is
    idempotent. Returns a per-kind count plus a 'pruned' total."""
    counts: dict[str, int] = {
        "log": 0,
        "criterion_ai": 0,
        "criterion_fetch": 0,
        "run_domain": 0,
        "run": 0,
        "pruned": 0,
    }
    if retention_days is None:
        return counts
    cutoff = datetime.utcnow() - timedelta(days=retention_days)

    # Process in batches so a long-overdue retention shrink (e.g. user
    # flips Never → 7 days against an old error_log) doesn't hold the
    # SQLite writer lock for minutes. Each batch commits independently;
    # if the loop is interrupted mid-prune the next /errors request
    # picks up where we left off.
    BATCH = 500
    while True:
        expired = (
            db.query(DismissedError)
            .filter(DismissedError.dismissed_at < cutoff)
            .order_by(DismissedError.dismissed_at.asc())
            .limit(BATCH)
            .all()
        )
        if not expired:
            break
        for d in expired:
            if d.source_kind == "log":
                row = db.get(ErrorLog, d.source_id)
                if row is not None:
                    db.delete(row)
                    counts["log"] += 1
            elif d.source_kind == "criterion_ai":
                cr = db.get(CriterionResult, d.source_id)
                if (
                    cr is not None
                    and cr.ai_verdict_error
                    and _hash_message(cr.ai_verdict_error) == d.message_hash
                ):
                    cr.ai_verdict_error = ""
                    counts["criterion_ai"] += 1
            elif d.source_kind == "criterion_fetch":
                cr = db.get(CriterionResult, d.source_id)
                if (
                    cr is not None
                    and cr.error
                    and _hash_message(cr.error) == d.message_hash
                ):
                    cr.error = ""
                    counts["criterion_fetch"] += 1
            elif d.source_kind == "run_domain":
                rd = db.get(RunDomain, d.source_id)
                if (
                    rd is not None
                    and rd.error
                    and _hash_message(rd.error) == d.message_hash
                ):
                    rd.error = ""
                    counts["run_domain"] += 1
            elif d.source_kind == "run":
                r = db.get(Run, d.source_id)
                if r is not None and r.error and _hash_message(r.error) == d.message_hash:
                    r.error = ""
                    counts["run"] += 1
            db.delete(d)
        db.commit()
        # Stop if we got fewer than BATCH rows — no point in another
        # round-trip; the next query would return zero anyway.
        if len(expired) < BATCH:
            break
    counts["pruned"] = sum(
        v for k, v in counts.items() if k != "pruned"
    )
    return counts


@router.get("", response_model=ErrorListResponse)
def list_errors(
    category: str = "all",
    status: str = "open",
    search: str = "",
    limit: int = 500,
    db: Session = Depends(get_db),
) -> ErrorListResponse:
    """List errors matching the filters. Default = open errors across all
    categories, newest first. `category` accepts one of
    'ai|ahrefs|domain|run|backend|all'. `status` is 'open|dismissed|all'."""
    if category != "all" and category not in ALL_CATEGORIES:
        raise HTTPException(400, f"unknown category: {category}")
    if status not in ("open", "dismissed", "all"):
        raise HTTPException(400, "status must be open|dismissed|all")
    if limit < 1 or limit > 5000:
        raise HTTPException(400, "limit must be 1..5000")

    # Opportunistic prune: if any dismissed errors have aged past the
    # retention window, drop them before listing. Cheap when there's
    # nothing to do (one indexed query, no rows returned).
    try:
        prune_dismissed_errors(db, get_error_retention_days())
    except Exception:
        # Never let prune failures block the list — log and move on.
        logging.getLogger(__name__).exception("opportunistic prune failed")

    all_rows = _gather_persisted_errors(db) + _gather_log_errors(db)
    _annotate_dismissals(db, all_rows)

    # Sort: newest first, with rows lacking a timestamp at the bottom.
    def _sort_key(r: ErrorRow):
        return (r.occurred_at or datetime.min)
    all_rows.sort(key=_sort_key, reverse=True)

    # Counts BEFORE category/status filters so the UI can show "12 ai · 5
    # ahrefs · ..." regardless of what tab is active.
    counts: dict[str, int] = {c: 0 for c in ALL_CATEGORIES}
    open_count = 0
    dismissed_count = 0
    for r in all_rows:
        counts[r.category] = counts.get(r.category, 0) + 1
        if r.dismissed_at is None:
            open_count += 1
        else:
            dismissed_count += 1
    counts["total"] = len(all_rows)
    counts["open"] = open_count
    counts["dismissed"] = dismissed_count

    # Apply filters.
    needle = search.strip().lower() if search else ""
    filtered: list[ErrorRow] = []
    for r in all_rows:
        if category != "all" and r.category != category:
            continue
        if status == "open" and r.dismissed_at is not None:
            continue
        if status == "dismissed" and r.dismissed_at is None:
            continue
        if needle and needle not in r.message.lower():
            # Also try preview + context value substrings — message is the
            # main signal but cheap to widen.
            ctx_blob = " ".join(str(v) for v in r.context.values()).lower()
            if needle not in ctx_blob:
                continue
        filtered.append(r)
        if len(filtered) >= limit:
            break

    return ErrorListResponse(errors=filtered, counts=counts)


@router.post("/dismiss")
def dismiss_one(payload: DismissIn, db: Session = Depends(get_db)) -> dict:
    """Mark a specific (source_kind, source_id, message_hash) as dismissed.
    Idempotent — repeated dismissals just update the timestamp."""
    existing = (
        db.query(DismissedError)
        .filter(
            DismissedError.source_kind == payload.source_kind,
            DismissedError.source_id == payload.source_id,
            DismissedError.message_hash == payload.message_hash,
        )
        .first()
    )
    if existing is None:
        existing = DismissedError(
            source_kind=payload.source_kind,
            source_id=payload.source_id,
            message_hash=payload.message_hash,
            dismissed_at=datetime.utcnow(),
        )
        db.add(existing)
    else:
        existing.dismissed_at = datetime.utcnow()
    db.commit()
    return {"dismissed_at": existing.dismissed_at.isoformat()}


@router.post("/restore")
def restore_one(payload: DismissIn, db: Session = Depends(get_db)) -> dict:
    """Drop the dismissal — the error reappears in the open list."""
    existing = (
        db.query(DismissedError)
        .filter(
            DismissedError.source_kind == payload.source_kind,
            DismissedError.source_id == payload.source_id,
            DismissedError.message_hash == payload.message_hash,
        )
        .first()
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
    return {"restored": True}


class DismissManyIn(BaseModel):
    items: list[DismissIn]


@router.post("/dismiss-many")
def dismiss_many(payload: DismissManyIn, db: Session = Depends(get_db)) -> dict:
    """Bulk dismiss by explicit composite-key list — used by the Errors
    page's row-checkbox selection. Idempotent per row; existing dismissals
    just update their timestamp."""
    n_new = 0
    n_touched = 0
    now = datetime.utcnow()
    for it in payload.items:
        existing = (
            db.query(DismissedError)
            .filter(
                DismissedError.source_kind == it.source_kind,
                DismissedError.source_id == it.source_id,
                DismissedError.message_hash == it.message_hash,
            )
            .first()
        )
        if existing is None:
            db.add(DismissedError(
                source_kind=it.source_kind,
                source_id=it.source_id,
                message_hash=it.message_hash,
                dismissed_at=now,
            ))
            n_new += 1
        else:
            existing.dismissed_at = now
        n_touched += 1
    db.commit()
    return {"dismissed": n_new, "touched": n_touched}


@router.post("/dismiss-all")
def dismiss_all(
    payload: BulkDismissIn, db: Session = Depends(get_db)
) -> dict:
    """Bulk-dismiss every CURRENTLY OPEN error matching the given filters.
    Honest about scope: returns count of new dismissals."""
    if payload.category is not None and payload.category not in ALL_CATEGORIES:
        raise HTTPException(400, f"unknown category: {payload.category}")
    rows = _gather_persisted_errors(db) + _gather_log_errors(db)
    _annotate_dismissals(db, rows)

    needle = (payload.search or "").strip().lower()
    n = 0
    for r in rows:
        if r.dismissed_at is not None:
            continue
        if payload.category and r.category != payload.category:
            continue
        if needle:
            ctx_blob = " ".join(str(v) for v in r.context.values()).lower()
            if needle not in r.message.lower() and needle not in ctx_blob:
                continue
        # Reuse the single dismiss helper to stay consistent.
        existing = (
            db.query(DismissedError)
            .filter(
                DismissedError.source_kind == r.source_kind,
                DismissedError.source_id == r.source_id,
                DismissedError.message_hash == r.message_hash,
            )
            .first()
        )
        if existing is None:
            db.add(DismissedError(
                source_kind=r.source_kind,
                source_id=r.source_id,
                message_hash=r.message_hash,
                dismissed_at=datetime.utcnow(),
            ))
            n += 1
    db.commit()
    return {"dismissed": n}


class RetentionIn(BaseModel):
    """7 / 15 / 30 days, or null for 'never prune'."""
    days: int | None


@router.get("/retention")
def get_retention():
    return {
        "days": get_error_retention_days(),
        "options": list(ERROR_RETENTION_OPTIONS),
    }


@router.put("/retention")
def put_retention(payload: RetentionIn):
    try:
        v = set_error_retention_days(payload.days)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"days": v}


@router.delete("/log/{error_log_id}")
def delete_log_error(error_log_id: int, db: Session = Depends(get_db)) -> dict:
    """Permanently delete a row from `error_log`. Persisted-source errors
    (ai/ahrefs/run/domain) can only be DISMISSED — their truth lives on
    the source row and we don't touch it. Log rows are pure ours, so a
    hard delete is offered for cleanup."""
    row = db.get(ErrorLog, error_log_id)
    if row is None:
        raise HTTPException(404, "log error not found")
    db.delete(row)
    # Also drop any dismissal so we don't leave an orphan reference.
    db.query(DismissedError).filter(
        DismissedError.source_kind == "log",
        DismissedError.source_id == error_log_id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": error_log_id}
