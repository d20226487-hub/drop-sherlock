"""Backup status + manual trigger + remote-storage config + restore.

`GET /backups/` returns config + the snapshot list so the Settings UI
can render a table with a "Backup now" button.

`POST /backups/run` triggers a snapshot synchronously. Same code path
as the scheduled job; protected by the existing basic-auth on the
Caddy front (no extra ACL needed for a LAN deploy).

`GET /backups/remote` and `PUT /backups/remote` expose the off-box
upload config (S3-compatible). Secrets are masked on read. `POST
/backups/remote/test` does a `head_bucket` against the live config so
the user can validate creds before the next scheduled run uses them.

`POST /backups/restore` replaces the live DB with a previously-saved
snapshot. Refuses while any non-terminal run is in flight (workers
would silently fail their writes against rows that no longer exist).
Always takes a `prerestore` safety snapshot first so the action is
recoverable in one more click.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import backups as backups_mod
from .. import remote_backup as remote_mod
from ..db import get_db
from ..models import Run

router = APIRouter(prefix="/backups", tags=["backups"])


@router.get("/")
def get_status() -> dict:
    db_path = backups_mod._resolve_db_path()
    return {
        "enabled": backups_mod.BACKUP_ENABLED,
        "interval_hours": backups_mod.BACKUP_INTERVAL_HOURS,
        "keep": backups_mod.BACKUP_KEEP,
        "backup_dir": str(backups_mod.BACKUP_DIR),
        "supported": db_path is not None,
        "db_path": str(db_path) if db_path else None,
        "snapshots": backups_mod.list_snapshots(),
        "remote": remote_mod.get_config_masked(),
    }


@router.post("/run")
def run_now() -> dict:
    db_path = backups_mod._resolve_db_path()
    if db_path is None:
        raise HTTPException(
            400,
            "backup is only supported on SQLite — current database_url is not SQLite.",
        )
    try:
        return backups_mod.run_backup()
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.get("/remote")
def get_remote() -> dict:
    return remote_mod.get_config_masked()


@router.put("/remote")
def set_remote(payload: dict[str, Any] = Body(...)) -> dict:
    try:
        return remote_mod.set_config(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/remote/test")
def test_remote() -> dict:
    try:
        return remote_mod.test_connection()
    except RuntimeError as e:
        raise HTTPException(400, str(e))


# --- Restore (added 2026-05-10) -------------------------------------------

class RestoreIn(BaseModel):
    filename: str


class RestoreOut(BaseModel):
    restored_from: str
    prerestore_snapshot: str
    prerestore_size_bytes: int


@router.post("/restore", response_model=RestoreOut)
def restore_backup(
    payload: RestoreIn,
    db: Session = Depends(get_db),
) -> RestoreOut:
    # Refuse while any run is non-terminal. Restoring under a running
    # worker would have it write verdicts for RunDomain rows that no
    # longer exist in the new DB → FK errors + Errors-page noise.
    NON_TERMINAL = ("pending", "running", "paused")
    busy_runs = (
        db.query(Run)
        .filter(Run.status.in_(NON_TERMINAL))
        .order_by(Run.id.desc())
        .limit(5)
        .all()
    )
    if busy_runs:
        ids = ", ".join(str(r.id) for r in busy_runs)
        raise HTTPException(
            409,
            f"refusing to restore while runs are in flight: pause or cancel "
            f"runs ({ids}) first, then retry. (Statuses: {NON_TERMINAL})",
        )
    try:
        result = backups_mod.restore_from_snapshot(payload.filename)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return RestoreOut(**result)


# --- Upload + restore (added 2026-05-14) ---------------------------------
# Same shape as POST /backups/restore, but the snapshot source comes from
# a multipart upload instead of an existing on-disk file. The uploaded
# .db.gz lands in BACKUP_DIR as a regular snapshot (so it shows up in the
# snapshots list and can be re-restored later) before the standard
# restore_from_snapshot() flow runs against it. Pre-restore safety
# snapshot is taken by restore_from_snapshot() the same way.

# Cap upload size at 2 GiB. A typical Drop Sherlock SQLite file is small
# (single-digit MB), but we don't want to OOM the container on a
# pathological upload. boto3's default S3 part size is 5 MiB so this is
# generous for any realistic single-user deploy.
_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024


class UploadRestoreOut(BaseModel):
    imported_filename: str
    imported_size_bytes: int
    restored_from: str
    prerestore_snapshot: str
    prerestore_size_bytes: int


@router.post("/upload-restore", response_model=UploadRestoreOut)
async def upload_and_restore(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> UploadRestoreOut:
    db_path = backups_mod._resolve_db_path()
    if db_path is None:
        raise HTTPException(
            400,
            "restore is only supported on SQLite — current database_url is not SQLite.",
        )

    # Same in-flight-run guard as POST /backups/restore. Restoring under
    # a running worker would have it write verdicts for RunDomain rows
    # that no longer exist in the new DB → FK errors + Errors-page noise.
    NON_TERMINAL = ("pending", "running", "paused")
    busy_runs = (
        db.query(Run)
        .filter(Run.status.in_(NON_TERMINAL))
        .order_by(Run.id.desc())
        .limit(5)
        .all()
    )
    if busy_runs:
        ids = ", ".join(str(r.id) for r in busy_runs)
        raise HTTPException(
            409,
            f"refusing to restore while runs are in flight: pause or cancel "
            f"runs ({ids}) first, then retry. (Statuses: {NON_TERMINAL})",
        )

    # Stream-read with a hard cap. UploadFile.read() takes the whole body
    # into memory; capping it here protects the container from a
    # pathological upload and gives a clean 413 instead of an OOM kill.
    data = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            413,
            f"upload exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit.",
        )
    if not data:
        raise HTTPException(400, "uploaded file is empty.")

    try:
        imported = backups_mod.import_uploaded_snapshot(data)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    try:
        restored = backups_mod.restore_from_snapshot(imported["filename"])
    except RuntimeError as e:
        # The imported file is still on disk — leaving it lets the user
        # retry the restore directly from the snapshots list without
        # re-uploading.
        raise HTTPException(500, f"import succeeded but restore failed: {e}")

    return UploadRestoreOut(
        imported_filename=imported["filename"],
        imported_size_bytes=imported["size_bytes"],
        restored_from=restored["restored_from"],
        prerestore_snapshot=restored["prerestore_snapshot"],
        prerestore_size_bytes=restored["prerestore_size_bytes"],
    )
