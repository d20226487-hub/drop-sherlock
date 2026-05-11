"""SQLite backup with rotation.

`run_backup()` snapshots the live DB to `/data/backups/` using SQLite's
online-backup API (`sqlite3.Connection.backup`). The backup API copies
pages while the source DB stays open and writable — no `VACUUM`-style
table lock — so the runner can keep judging during the snapshot.

Snapshots are gzipped (`.db.gz`, typically ~5x smaller than the raw
file). Older snapshots beyond the configured retention are pruned.

Why local-only for v1: pushing to S3/B2/Backblaze needs the user to
provide credentials (bucket, region, secret) and pick a storage class.
Doing that without a clear preference would lock in one provider; the
local snapshots are the universal piece — a remote-sync sidecar can
later mount `/data/backups/` and push wherever the user wants.

Settings: see the env block at the top — all knobs are env-driven so
this can be tuned without touching code OR adding a Settings UI page
for v1. The endpoints in routers/backups.py expose the same controls
for read-only inspection + a manual "Backup now" trigger.
"""
from __future__ import annotations

import gzip
import logging
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

# All knobs default to safe values for the LAN single-user deploy.
# Everything is env-driven so docker-compose can override without code
# changes. Keep the env names DROP_SHERLOCK_* so they don't collide.
BACKUP_DIR = Path(os.environ.get("DROP_SHERLOCK_BACKUP_DIR", "/data/backups"))
BACKUP_KEEP = int(os.environ.get("DROP_SHERLOCK_BACKUP_KEEP", "14"))
BACKUP_INTERVAL_HOURS = int(
    os.environ.get("DROP_SHERLOCK_BACKUP_INTERVAL_HOURS", "24")
)
BACKUP_ENABLED = os.environ.get(
    "DROP_SHERLOCK_BACKUP_ENABLED", "true"
).strip().lower() in ("1", "true", "yes", "on")

# Matches both regular snapshots and pre-restore safety snapshots.
# The latter use the `prerestore` infix so they're easy to filter and
# are EXEMPT from rotation pruning (they're undo-snapshots, written
# right before a restore — keeping them is the whole point).
_FILENAME_RE = re.compile(
    r"^drop_sherlock-(?:prerestore-)?(\d{8})-(\d{6})\.db\.gz$"
)
_PRERESTORE_RE = re.compile(
    r"^drop_sherlock-prerestore-\d{8}-\d{6}\.db\.gz$"
)


def _resolve_db_path() -> Path | None:
    """Extract the on-disk file path from the SQLite URL. Returns None for
    non-SQLite URLs (Postgres etc.) so the backup logic is a no-op then —
    upgrading to Postgres deserves a real `pg_dump` cron, not a SQLite
    workaround.

    SQLAlchemy's SQLite URL is `sqlite:///rel/path` (3 slashes = relative)
    or `sqlite:////abs/path` (4 slashes = absolute). The default config
    uses the absolute form pointing at /data/drop_sherlock.db."""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return None
    if url.startswith("sqlite:////"):
        return Path("/" + url[len("sqlite:////"):])
    if url.startswith("sqlite:///"):
        return Path(url[len("sqlite:///"):])
    return None


def _ensure_dir() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    return BACKUP_DIR


def _snapshot_filename(when: datetime, *, prerestore: bool = False) -> str:
    if prerestore:
        return when.strftime("drop_sherlock-prerestore-%Y%m%d-%H%M%S.db.gz")
    return when.strftime("drop_sherlock-%Y%m%d-%H%M%S.db.gz")


def list_snapshots() -> list[dict]:
    """All snapshots in BACKUP_DIR, newest first. Each entry has:
    `filename`, `size_bytes`, `created_at` (ISO), `age_seconds`,
    `prerestore` (true for safety snapshots written right before a
    restore — these are exempt from rotation).
    """
    if not BACKUP_DIR.exists():
        return []
    out: list[dict] = []
    now = datetime.now(timezone.utc)
    for p in BACKUP_DIR.iterdir():
        if not p.is_file():
            continue
        if not _FILENAME_RE.match(p.name):
            continue
        try:
            stat = p.stat()
        except OSError:
            continue
        ctime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        out.append({
            "filename": p.name,
            "size_bytes": stat.st_size,
            "created_at": ctime.isoformat(),
            "age_seconds": int((now - ctime).total_seconds()),
            "prerestore": bool(_PRERESTORE_RE.match(p.name)),
        })
    # Newest first by filename. Note: prerestore filenames sort
    # alongside regular ones because they share the timestamp; the
    # `prerestore` flag tells the UI which is which.
    out.sort(key=lambda r: (r["created_at"]), reverse=True)
    return out


def _prune(keep: int) -> int:
    """Drop regular snapshots beyond `keep`. Pre-restore snapshots are
    EXEMPT — they're undo-snapshots written right before a restore and
    losing them defeats the purpose. Returns the number of files
    removed (regular only)."""
    if keep <= 0:
        return 0
    regular = [s for s in list_snapshots() if not s["prerestore"]]
    removed = 0
    for entry in regular[keep:]:
        p = BACKUP_DIR / entry["filename"]
        try:
            p.unlink()
            removed += 1
        except OSError as e:
            log.warning("backup prune failed for %s: %s", p, e)
    return removed


def run_backup(*, keep: int | None = None, prerestore: bool = False) -> dict:
    """Snapshot the SQLite DB to BACKUP_DIR (gzipped) and prune older
    snapshots beyond retention. Returns a result dict with the new file's
    metadata + how many old files were pruned.

    `prerestore=True` flags this snapshot as an undo-snapshot taken
    right before a restore: the filename gets the `prerestore` infix,
    rotation skips it, and the result dict carries the `prerestore`
    flag so the caller can surface it.

    Safe to call concurrently with read/write traffic — uses SQLite's
    online backup API which copies pages without blocking other
    connections (WAL mode is already on, see db.py).

    Raises RuntimeError when the configured DB isn't SQLite (the caller
    is expected to gate the call on `_resolve_db_path()` if it cares)."""
    src = _resolve_db_path()
    if src is None:
        raise RuntimeError(
            "backup requires a SQLite database; configured database_url "
            "is non-SQLite. For Postgres, use pg_dump on a separate cron."
        )
    if not src.exists():
        raise RuntimeError(f"source DB not found at {src}")

    _ensure_dir()
    when = datetime.now(timezone.utc)
    out_name = _snapshot_filename(when, prerestore=prerestore)
    out_path = BACKUP_DIR / out_name

    # Two-step write: dump to a temp .db, then gzip → final .db.gz.
    # Doing the gzip on a separate file lets the SQLite backup API run
    # against a real DB destination (it doesn't accept arbitrary file
    # objects), and the gzip pass shrinks the result ~5x.
    raw_path = BACKUP_DIR / (out_name + ".raw")
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(str(raw_path))
        try:
            with dest_conn:
                src_conn.backup(dest_conn, pages=200, sleep=0.0)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()

    try:
        with open(raw_path, "rb") as fin, gzip.open(out_path, "wb", compresslevel=6) as fout:
            shutil.copyfileobj(fin, fout, length=1024 * 1024)
    finally:
        # Always remove the temp .raw file even if gzip fails — a partial
        # .db.gz is removed too so the next list_snapshots() doesn't show
        # a corrupt entry.
        try:
            raw_path.unlink()
        except OSError:
            pass
        if not out_path.exists() or out_path.stat().st_size == 0:
            try:
                out_path.unlink()
            except OSError:
                pass

    if not out_path.exists():
        raise RuntimeError("backup failed: gzipped snapshot was not written")

    size_bytes = out_path.stat().st_size
    pruned = _prune(keep if keep is not None else BACKUP_KEEP)
    log.info(
        "DB backup written: %s (%d bytes); pruned %d old snapshot(s)",
        out_path, size_bytes, pruned,
    )

    # Optional remote upload. We don't fail the local backup if remote
    # fails — the user wants the local snapshot regardless, and the
    # remote-failed status is surfaced separately so they can fix
    # creds / connectivity without losing local rotation.
    remote_result: dict | None = None
    remote_error: str | None = None
    try:
        from . import remote_backup
        if remote_backup.is_enabled():
            remote_result = remote_backup.upload_snapshot(str(out_path))
    except Exception as e:  # noqa: BLE001
        log.warning("remote backup upload failed: %s", e)
        remote_error = str(e)

    return {
        "filename": out_name,
        "size_bytes": size_bytes,
        "created_at": when.isoformat(),
        "pruned": pruned,
        "remote": remote_result,
        "remote_error": remote_error,
    }


def scheduled_backup() -> None:
    """Wrapper that swallows + logs exceptions so a failed snapshot
    doesn't kill the scheduler thread. Used by the APScheduler job."""
    try:
        run_backup()
    except Exception:
        log.exception("scheduled DB backup failed")


# --- Restore (added 2026-05-10) -------------------------------------------
# Reverse of run_backup(): take a previously-written .db.gz, decompress
# it, and copy its pages over the live DB via SQLite's online-backup API
# (in reverse). The live DB is write-locked for the ~2-5s the copy
# takes; readers keep working (WAL mode). No container restart needed.
#
# Always takes a `prerestore` snapshot of the CURRENT state first, so
# restoring the wrong file is recoverable in one more click.

def restore_from_snapshot(filename: str) -> dict:
    """Replace the live DB with the contents of `filename` (which must
    be a snapshot in BACKUP_DIR). Returns a result dict with the
    pre-restore snapshot's filename so the caller can show it as the
    undo target. Raises RuntimeError on any failure."""
    if not _FILENAME_RE.match(filename):
        # Defense-in-depth: the route validates this too, but enforce
        # at the helper so internal callers can't sneak in a path
        # traversal via a crafted filename.
        raise RuntimeError(
            f"invalid snapshot filename (must match drop_sherlock-*.db.gz): {filename}"
        )
    src_snapshot = BACKUP_DIR / filename
    if not src_snapshot.exists():
        raise RuntimeError(f"snapshot not found: {filename}")

    live_db = _resolve_db_path()
    if live_db is None:
        raise RuntimeError(
            "restore requires a SQLite database; configured database_url is not SQLite"
        )
    if not live_db.exists():
        raise RuntimeError(f"live DB not found at {live_db}")

    # Step 1: take a safety snapshot of the current state. If anything
    # below fails, the user has a clean undo target. The pre-restore
    # snapshot is exempt from rotation so it sticks around.
    pre = run_backup(prerestore=True)

    # Step 2: decompress the chosen snapshot to a temp .db file. SQLite
    # backup API needs a real file as the source DB, not a stream.
    import tempfile
    tmp = Path(tempfile.mkstemp(
        prefix="restore-", suffix=".db", dir=str(BACKUP_DIR)
    )[1])
    try:
        with gzip.open(src_snapshot, "rb") as fin, open(tmp, "wb") as fout:
            shutil.copyfileobj(fin, fout, length=1024 * 1024)

        # Step 3: copy pages from the temp DB INTO the live DB. The live
        # DB gets a reserved write-lock for the duration; existing
        # WAL-mode readers keep working, but writes block. ~2-5s for a
        # typical small DB. After this returns, the live DB IS the
        # snapshot's contents — same file path, same fd-pointers held
        # by other connections (SQLite handles this cleanly).
        src_conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            dest_conn = sqlite3.connect(str(live_db))
            try:
                with dest_conn:
                    src_conn.backup(dest_conn, pages=200, sleep=0.0)
            finally:
                dest_conn.close()
        finally:
            src_conn.close()
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass

    # Invalidate the app_settings TTL cache — restored DB rows are
    # different from the in-memory cache the runner is holding.
    try:
        from . import app_settings as _app_settings
        _app_settings._cache_clear()
    except Exception:
        log.warning("failed to clear app_settings cache after restore")

    log.info(
        "restored DB from %s (pre-restore safety snapshot: %s)",
        filename, pre["filename"],
    )
    return {
        "restored_from": filename,
        "prerestore_snapshot": pre["filename"],
        "prerestore_size_bytes": pre["size_bytes"],
    }
