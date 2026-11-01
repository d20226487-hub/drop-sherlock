"""Database ▸ Чистка (Cleanup) API (added 2026-11-01). See app/cleanup.py
for what each category can and can never delete."""
from __future__ import annotations

import csv
import io
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import cleanup
from ..db import get_db

router = APIRouter(prefix="/cleanup", tags=["cleanup"])

# Statuses the operator can add to `registered` (cleanup.OPTIONAL).
Optional = Literal["not_supported", "unknown", "error"]


def _checks_running() -> list[dict]:
    from .database import active_heavy_checks
    return active_heavy_checks()


@router.get("/taken")
def preview_taken(
    include: list[Optional] = Query([]),
    protect_expiry_days: int = Query(30, ge=0, le=3650),
    db: Session = Depends(get_db),
) -> dict:
    sel = cleanup.select_taken(db, include=include,
                               protect_expiry_days=protect_expiry_days)
    return {
        "count": len(sel["domains"]),
        "sample": sel["domains"][:cleanup._SAMPLE],
        "kept": sel["kept"],
        "with_backlog_row": sel["with_backlog_row"],
        "never_analyzed": cleanup.never_analyzed_count(db),
        "checks_running": _checks_running(),
        "status": cleanup.status(),
    }


@router.get("/taken.csv")
def taken_csv(
    include: list[Optional] = Query([]),
    protect_expiry_days: int = Query(30, ge=0, le=3650),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    sel = cleanup.select_taken(db, include=include,
                               protect_expiry_days=protect_expiry_days)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["domain", "status", "expires_on", "source"])
    for d in sel["domains"]:
        w.writerow([d["domain"], d["status"], d["expires_on"] or "", d["source"]])
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="cleanup-taken.csv"'},
    )


class TakenCleanupIn(BaseModel):
    include: list[Optional] = []
    protect_expiry_days: int = Field(30, ge=0, le=3650)
    delete_backlog: bool = True
    ban: bool = False
    # The count the operator confirmed in the preview; a mismatch means the
    # data changed in between, so nothing is deleted.
    expected_count: int = Field(..., ge=1)


@router.post("/taken")
def run_taken(payload: TakenCleanupIn) -> dict:
    try:
        return cleanup.start_taken_cleanup(**payload.model_dump())
    except cleanup.CleanupRefused as e:
        raise HTTPException(409, str(e)) from e


@router.get("/orphans")
def preview_orphans(db: Session = Depends(get_db)) -> dict:
    counts = cleanup.orphan_counts(db)
    return {
        "delete": counts["delete"],
        "kept": counts["kept"],
        "total": sum(counts["delete"].values()),
        "checks_running": _checks_running(),
        "status": cleanup.status(),
    }


class OrphanCleanupIn(BaseModel):
    expected_count: int = Field(..., ge=1)


@router.post("/orphans")
def run_orphans(payload: OrphanCleanupIn) -> dict:
    try:
        return cleanup.start_orphan_cleanup(expected_count=payload.expected_count)
    except cleanup.CleanupRefused as e:
        raise HTTPException(409, str(e)) from e


@router.get("/status")
def cleanup_status() -> dict:
    return cleanup.status()
