"""SQLite VACUUM helper.

Why we need this: deletes mark pages as free but never shrink the file.
After the 2026-05-14 retention waves (availability_checks prune, ban
snapshots, bulk-delete-filtered) the live DB accumulates free pages
that nothing reclaims. VACUUM rewrites the DB file from scratch —
copying live data to a temp file then atomically replacing the
original. No data loss; backups untouched.

Cost during the run:
  - Temp file ~= live DB size on the same volume (the disk-space guard
    below checks for this).
  - Brief exclusive lock at the end while pages swap. Concurrent writes
    wait milliseconds-to-seconds depending on DB size; WAL-mode readers
    are mostly unaffected mid-rebuild.

Coordination: shares MAINTENANCE_LOCK with the backup job so the two
can't overlap (their lock patterns are page-stream vs whole-file
rewrite — fighting over the same write lock would burn user-facing
latency for nothing).
"""
from __future__ import annotations

import logging
import shutil
from typing import Any

from sqlalchemy import text

from .backups import MAINTENANCE_LOCK, _resolve_db_path
from .db import engine

log = logging.getLogger(__name__)


def try_vacuum(*, min_free_ratio: float = 2.0) -> dict[str, Any]:
    """Run VACUUM if it's safe to do so. Returns a result dict the
    scheduler logs / the Settings UI can surface later if desired.

    `min_free_ratio`: skip the run unless the filesystem holding the DB
    has at least `live_db_size * min_free_ratio` bytes free. Default 2x
    leaves comfortable headroom for the temp copy SQLite writes during
    the rebuild (the docs recommend "at least as much free space as
    the DB"; we double it for safety on tight volumes).

    Result keys:
      status: "ok" | "skipped_lock" | "skipped_disk" | "skipped_non_sqlite" | "error"
      reason: human-readable detail
      bytes_before: live DB file size before VACUUM (or None)
      bytes_after:  live DB file size after VACUUM (or None on skip)
      reclaimed:    bytes_before - bytes_after (or 0 on skip)
      free_before:  filesystem free space pre-VACUUM
    """
    db_path = _resolve_db_path()
    if db_path is None:
        return {
            "status": "skipped_non_sqlite",
            "reason": "database_url is non-SQLite",
            "bytes_before": None,
            "bytes_after": None,
            "reclaimed": 0,
            "free_before": None,
        }
    if not db_path.exists():
        return {
            "status": "error",
            "reason": f"source DB not found at {db_path}",
            "bytes_before": None,
            "bytes_after": None,
            "reclaimed": 0,
            "free_before": None,
        }

    bytes_before = db_path.stat().st_size
    free_before = shutil.disk_usage(db_path.parent).free
    needed = int(bytes_before * min_free_ratio)
    if free_before < needed:
        log.warning(
            "VACUUM skipped: filesystem free %d < required %d "
            "(DB %d bytes × %.1fx headroom)",
            free_before, needed, bytes_before, min_free_ratio,
        )
        return {
            "status": "skipped_disk",
            "reason": (
                f"free space {free_before} < required {needed} "
                f"(DB {bytes_before} × {min_free_ratio}x headroom)"
            ),
            "bytes_before": bytes_before,
            "bytes_after": None,
            "reclaimed": 0,
            "free_before": free_before,
        }

    acquired = MAINTENANCE_LOCK.acquire(blocking=False)
    if not acquired:
        log.info("VACUUM skipped: maintenance lock held (backup in flight)")
        return {
            "status": "skipped_lock",
            "reason": "maintenance lock held by another job",
            "bytes_before": bytes_before,
            "bytes_after": None,
            "reclaimed": 0,
            "free_before": free_before,
        }
    try:
        # `VACUUM` must run outside a transaction. SQLAlchemy's
        # `engine.begin()` implicitly opens one, so we use `engine.connect()`
        # and rely on the connection's autocommit-on-no-transaction mode.
        # The execute call commits before returning.
        with engine.connect() as conn:
            # Force the connection out of any implicit transaction.
            conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(text("VACUUM"))
    except Exception as e:  # noqa: BLE001
        log.exception("VACUUM failed")
        return {
            "status": "error",
            "reason": str(e),
            "bytes_before": bytes_before,
            "bytes_after": db_path.stat().st_size if db_path.exists() else None,
            "reclaimed": 0,
            "free_before": free_before,
        }
    finally:
        MAINTENANCE_LOCK.release()

    bytes_after = db_path.stat().st_size
    reclaimed = max(0, bytes_before - bytes_after)
    log.info(
        "VACUUM done: %d → %d bytes (reclaimed %d, %.1f%%)",
        bytes_before, bytes_after, reclaimed,
        (100.0 * reclaimed / bytes_before) if bytes_before else 0.0,
    )
    return {
        "status": "ok",
        "reason": "",
        "bytes_before": bytes_before,
        "bytes_after": bytes_after,
        "reclaimed": reclaimed,
        "free_before": free_before,
    }
