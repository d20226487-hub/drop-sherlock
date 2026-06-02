"""Background runner for WaybackSparklineJob (Tools page, 2026-05-23).

A sparkline job is a flat fan-out: one HTTP call per domain into
archive.org's `__wb/sparkline` endpoint, capped at `concurrency`
in-flight requests via an asyncio Semaphore. Progress is committed
per-result so the UI can poll and show a live progress bar even on
100k-domain batches.

Differs from the Job/Run/CR pipeline:
  • One coroutine per domain, no per-criterion fan-out underneath
  • No AI step
  • No augmentation chain
  • No final synth
The runner is correspondingly shorter (~150 lines vs whois_history's
runner.py at >400) and reuses no Job-pipeline infrastructure.

Pause / cancel semantics mirror the main pipeline: process-level dicts
track which job_ids the operator has signaled, and the workers check
the flag between each domain. Workers in-flight when pause fires
finish their current domain (we don't kill mid-HTTP — would leave a
dangling rate-limit slot) and exit at the next check.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import httpx
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import WaybackSparklineJob, WaybackSparklineResult
from .providers.wayback_sparkline import (
    WaybackSparklineError,
    fetch_sparkline_count,
    _DEFAULT_HEADERS,
    _TIMEOUT_SECONDS,
)

log = logging.getLogger(__name__)


# Process-level signal flags — same pattern as tasks._PAUSED_RUNS /
# _CANCELED_RUNS but keyed on sparkline job ids. Single uvicorn worker
# only (matches the main app's deployment).
_PAUSED_JOBS: set[int] = set()
_CANCELED_JOBS: set[int] = set()


def pause_sparkline_job(job_id: int) -> None:
    _PAUSED_JOBS.add(job_id)


def clear_pause_sparkline_job(job_id: int) -> None:
    _PAUSED_JOBS.discard(job_id)


def cancel_sparkline_job(job_id: int) -> None:
    _CANCELED_JOBS.add(job_id)


def clear_cancel_sparkline_job(job_id: int) -> None:
    _CANCELED_JOBS.discard(job_id)


def is_paused_sparkline(job_id: int) -> bool:
    return job_id in _PAUSED_JOBS


def is_canceled_sparkline(job_id: int) -> bool:
    return job_id in _CANCELED_JOBS


# Commit cadence. SQLite WAL can absorb high commit rates but at 100k
# domains we don't need a commit per result — batching to one commit
# every N results halves the wall time on the DB side without
# meaningfully delaying progress updates. The UI polls every ~2s, so
# a commit every 20 results still shows smooth progress at 8 workers
# × 0.6s/domain ≈ 13 results/s.
_COMMIT_EVERY = 20


def _job_status_check(job_id: int) -> str | None:
    """Return the job's status from a fresh session, or None if missing.
    Used by the per-domain workers to detect operator-issued pause /
    cancel without holding an open session across the HTTP await."""
    db = SessionLocal()
    try:
        job = db.get(WaybackSparklineJob, job_id)
        return job.status if job else None
    finally:
        db.close()


async def process_sparkline_job(job_id: int) -> None:
    """Orchestrator for one WaybackSparklineJob. Picks up every result
    row with status='pending', fetches its sparkline count, commits
    the result, and marks the job done when the queue empties.

    Idempotent under resume: pending rows are picked up; already-done
    (ok / error) rows are skipped. Same shape as the whois runner's
    post-2026-05-23 resume-idempotency fix."""
    db: Session = SessionLocal()
    try:
        job = db.get(WaybackSparklineJob, job_id)
        if job is None or job.status != "pending":
            return
        ownership_token = datetime.utcnow()
        job.status = "running"
        job.started_at = ownership_token
        job.error = ""
        concurrency = max(1, int(job.concurrency or 8))
        db.commit()

        # Snapshot the pending row ids so we don't hold a session open
        # across the HTTP awaits. Result rows are pre-created at submit
        # time (see router) so the runner just walks them.
        pending = (
            db.query(WaybackSparklineResult.id, WaybackSparklineResult.domain)
            .filter(
                WaybackSparklineResult.job_id == job_id,
                WaybackSparklineResult.status == "pending",
            )
            .all()
        )
        work = [(r.id, r.domain) for r in pending]
    finally:
        db.close()

    if not work:
        # Nothing to do — mark done immediately. Handles the
        # "resume but every result already landed" edge case.
        _finalize_job(job_id, "done", "")
        return

    def _still_owns() -> bool:
        s = SessionLocal()
        try:
            j = s.get(WaybackSparklineJob, job_id)
            return j is not None and j.started_at == ownership_token
        finally:
            s.close()

    sem = asyncio.Semaphore(concurrency)
    progress = {"completed": 0}
    progress_lock = asyncio.Lock()

    async def _one(result_id: int, domain: str, client: httpx.AsyncClient) -> None:
        # Cooperative cancel/pause check BEFORE the rate-limit gate so
        # paused workers don't keep consuming rate-limit tokens.
        if is_canceled_sparkline(job_id):
            return
        if is_paused_sparkline(job_id):
            return
        async with sem:
            if is_canceled_sparkline(job_id) or is_paused_sparkline(job_id):
                return
            # Flip to 'fetching' so the UI's progress card can show
            # "N in flight" distinct from "M queued". Tiny commit
            # overhead but the operator information is worth it on
            # long batches.
            _set_result_status(result_id, "fetching")
            t0 = datetime.utcnow()
            try:
                result = await fetch_sparkline_count(domain, client=client)
                elapsed_ms = int(
                    (datetime.utcnow() - t0).total_seconds() * 1000
                )
                _commit_result(
                    result_id,
                    status="ok",
                    snapshot_count=result.snapshot_count,
                    first_year=result.first_year,
                    last_year=result.last_year,
                    years_with_data=result.years_with_data,
                    error_msg="",
                    elapsed_ms=elapsed_ms,
                )
            except WaybackSparklineError as e:
                elapsed_ms = int(
                    (datetime.utcnow() - t0).total_seconds() * 1000
                )
                _commit_result(
                    result_id,
                    status="error",
                    snapshot_count=None,
                    first_year=None,
                    last_year=None,
                    years_with_data=None,
                    error_msg=str(e),
                    elapsed_ms=elapsed_ms,
                )
            except (httpx.HTTPError, asyncio.TimeoutError, OSError) as e:
                # Defense-in-depth: the provider catches these via its
                # retry loop, but if anything slips past, treat it as a
                # per-domain failure. Same lesson as the whois runner's
                # widened except chain (2026-05-23).
                elapsed_ms = int(
                    (datetime.utcnow() - t0).total_seconds() * 1000
                )
                _commit_result(
                    result_id,
                    status="error",
                    snapshot_count=None,
                    first_year=None,
                    last_year=None,
                    years_with_data=None,
                    error_msg=f"{type(e).__name__}: {e}",
                    elapsed_ms=elapsed_ms,
                )
            async with progress_lock:
                progress["completed"] += 1

    # Share one httpx client across the whole batch — saves the TCP +
    # TLS handshake on every call, which is the dominant overhead at
    # ~0.5s/call. Same pattern as the Ahrefs client used by the Tools
    # page.
    async with httpx.AsyncClient(
        timeout=_TIMEOUT_SECONDS,
        headers=_DEFAULT_HEADERS,
        # Reuse one connection across the whole batch; keepalive is
        # crucial for high-concurrency runs on a single upstream host.
        limits=httpx.Limits(
            max_connections=max(16, concurrency * 2),
            max_keepalive_connections=max(16, concurrency * 2),
        ),
    ) as client:
        try:
            await asyncio.gather(
                *(_one(rid, d, client) for rid, d in work),
                return_exceptions=True,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("sparkline job %s orchestrator crashed", job_id)
            if _still_owns():
                _finalize_job(job_id, "failed", f"{type(e).__name__}: {e}")
            return

    # Finalize. If canceled mid-flight, leave job status='canceled'
    # so the UI surfaces what happened; otherwise mark done.
    if not _still_owns():
        return
    if is_canceled_sparkline(job_id):
        _finalize_job(job_id, "canceled", "")
        clear_cancel_sparkline_job(job_id)
    elif is_paused_sparkline(job_id):
        _finalize_job(job_id, "paused", "")
    else:
        _finalize_job(job_id, "done", "")


def _set_result_status(result_id: int, status: str) -> None:
    """Single-column update on one result row. Used for the
    pending → fetching flip so the UI in-flight counter moves
    immediately, before the slower HTTP+commit-result path lands."""
    db = SessionLocal()
    try:
        r = db.get(WaybackSparklineResult, result_id)
        if r is not None:
            r.status = status
            db.commit()
    finally:
        db.close()


def _commit_result(
    result_id: int,
    *,
    status: str,
    snapshot_count: int | None,
    first_year: int | None,
    last_year: int | None,
    years_with_data: int | None,
    error_msg: str,
    elapsed_ms: int | None,
) -> None:
    """Write the per-domain result. One commit per domain — at 100k
    domains × ~13 results/s that's ~14 commits/s, which SQLite WAL
    handles comfortably. Could batch but the per-row commit gives the
    UI clean progress updates without extra plumbing."""
    db = SessionLocal()
    try:
        r = db.get(WaybackSparklineResult, result_id)
        if r is None:
            return
        r.status = status
        r.snapshot_count = snapshot_count
        r.first_year = first_year
        r.last_year = last_year
        r.years_with_data = years_with_data
        r.error_msg = error_msg
        r.elapsed_ms = elapsed_ms
        r.fetched_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def _finalize_job(job_id: int, status: str, error: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(WaybackSparklineJob, job_id)
        if job is None:
            return
        # Don't overwrite a terminal state set by a competing flow.
        if job.status in ("done", "failed", "canceled"):
            return
        job.status = status
        job.error = error
        job.finished_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def dispatch_sparkline_job(job_id: int) -> asyncio.Task:
    """Schedule a background task for one sparkline job. Mirrors
    `tasks.dispatch_run`'s contract — caller hangs on to the returned
    Task reference (via the module-level set kept on `tasks._BG_TASKS`)
    so asyncio doesn't GC it mid-flight."""
    clear_pause_sparkline_job(job_id)
    clear_cancel_sparkline_job(job_id)
    task = asyncio.create_task(process_sparkline_job(job_id))
    # Reuse the existing tasks._BG_TASKS set so a single retention
    # location keeps every background task alive — saves us a parallel
    # set + done callback here.
    from .tasks import _BG_TASKS
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task
