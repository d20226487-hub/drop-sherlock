"""Per-Run orchestrator for the availability pillar (Wave 3, 2026-05-15).

Promotes the existing availability cascade
(`backend/app/availability/cascade.py`) to a first-class Job kind.
Mirrors `whois_history.runner.process_whois_history_run` in shape, but:

  - No AI judge step. Cascade output is already a definitive label
    (available / registered / unknown / error) — no value in burning
    tokens to commentate.
  - `use_cache=False` per Wave 3 decision (c). A Job is an explicit
    "I want fresh state now" ask; the cache-honoring path stays on
    the per-row Recheck buttons in /database and /backlog.
  - Each domain produces one CriterionResult(criterion='availability')
    row. `data_json` carries the cascade trace + final verdict so the
    per-domain view can render the provider-by-provider walk; no
    `ai_verdict_json` since no AI is involved.

Persistence pipeline per rd:
  1. RunDomain → 'running'
  2. CriterionResult created with status='running'
  3. Cascade runs; trace rows accumulate in `availability_checks`
     table (via cascade's own _persist).
  4. CR.data_json + CR.status = 'done' / 'failed'
  5. RunDomain → 'done' / 'failed'

No per-criterion cache. The cascade's own use_cache lever is forced
off, so every job re-checks every domain.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy.orm import Session

from .app_settings import SessionLocal
from .availability.cascade import check_availability_async
from .availability.common import (
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    TERMINAL_STATUSES,
)
from .models import AvailabilityCheck, CriterionResult, Run, RunDomain

log = logging.getLogger(__name__)

# Outer fan-out cap. Per-provider concurrency is enforced inside the
# cascade (`_get_semaphore`), but we still want an outer ceiling so a
# 5,000-domain availability run doesn't spawn 5,000 concurrent task
# stacks. 8 matches whois_history; cascade's per-provider caps (default
# 4) prevent provider-side rate-limit hits.
_OUTER_CONCURRENCY = 8


def _serialize_trace(
    rows: list[AvailabilityCheck],
) -> list[dict[str, Any]]:
    """One dict per provider response. Newest-first by checked_at, then
    id, so reading the trace top-down reads as "what we tried last."
    Empty error_message/registrar/expires_on omitted to keep payloads
    tight."""
    out: list[dict[str, Any]] = []
    for r in sorted(rows, key=lambda r: (r.checked_at, r.id), reverse=True):
        item: dict[str, Any] = {
            "provider": r.provider,
            "status": r.status,
            "checked_at": r.checked_at.isoformat() if r.checked_at else "",
        }
        if r.latency_ms is not None:
            item["latency_ms"] = r.latency_ms
        if r.registrar:
            item["registrar"] = r.registrar
        if r.expires_on:
            item["expires_on"] = r.expires_on.isoformat()
        if r.error_message:
            item["error_message"] = r.error_message
        if r.error_category:
            item["error_category"] = r.error_category
        out.append(item)
    return out


async def _process_availability_domain(
    rd_id: int, run_id: int, client: httpx.AsyncClient,
) -> None:
    """Run the cascade for one domain.

    DB sessions are NEVER held across the cascade await (refactored
    2026-05-16). Previously the runner opened one session and kept it
    around for the entire cascade — including the provider HTTP calls,
    each of which could take seconds. With `_OUTER_CONCURRENCY=8` that
    meant 8 long-lived sessions during a 1000-domain run; combined with
    FE polling + a concurrent whois retry, the 15-slot pool exhausted
    and the entire app stopped responding (the user's "all pages
    stopped responding" report).

    Each DB step now opens its own short-lived session — fast in/out,
    no await held inside."""
    # --- Phase 1: mark RD running + create CR row (own session)
    domain: str | None = None
    cr_id: int | None = None
    db: Session = SessionLocal()
    try:
        rd = db.get(RunDomain, rd_id)
        if rd is None:
            log.warning("availability runner: rd_id=%s missing", rd_id)
            return
        domain = rd.domain
        rd.status = "running"
        rd.started_at = datetime.utcnow()
        db.commit()

        # Create the CR row up-front so the UI can poll status while
        # the cascade walks. status='running' until the cascade returns.
        cr = CriterionResult(
            run_domain_id=rd.id,
            criterion="availability",
            status="running",
            fetched_at=datetime.utcnow(),
            data_json="",
            request_url="",
            error="",
        )
        db.add(cr)
        db.commit()
        db.refresh(cr)
        cr_id = cr.id
    finally:
        db.close()

    # --- Phase 2: cascade (NO session held; cascade manages its own
    # short-lived sessions internally). use_cache=False because a Job
    # is an explicit "give me fresh state" request (Wave 3 decision (b)).
    # run_id stamping on the persisted AvailabilityCheck rows lets the
    # trace query below scope to "this run's results only" — critical
    # when the domain has prior availability_checks rows from other
    # contexts.
    cascade_error: str = ""
    result_status: str = STATUS_ERROR
    result_provider: str = ""
    result_registrar: str = ""
    result_expires_on = None
    try:
        result = await check_availability_async(
            domain,
            run_id=run_id,
            use_cache=False,
            client=client,
        )
        result_status = result.status
        result_provider = result.provider
        result_registrar = result.registrar
        result_expires_on = result.expires_on
    except Exception as e:  # noqa: BLE001
        # Cascade should never raise (it catches per-provider errors
        # and returns status='error'/'unknown'); if it does, log + mark
        # this rd failed but let the run continue.
        cascade_error = f"{type(e).__name__}: {e}"
        log.exception(
            "availability cascade raised for rd=%s domain=%s",
            rd_id, domain,
        )

    # --- Phase 3: query trace + write verdict (own session)
    db = SessionLocal()
    try:
        # Fetch the trace rows the cascade just wrote for this run.
        # `AvailabilityCheck.run_id` was added so we can scope exactly
        # to "this Run's cascade calls" — including the cases where a
        # provider was attempted and errored, not just the terminal row.
        trace_rows = (
            db.query(AvailabilityCheck)
            .filter(AvailabilityCheck.domain == domain)
            .filter(AvailabilityCheck.run_id == run_id)
            .all()
        )

        # Verdict-preservation across cascade retries (2026-05-17 fix
        # for B9). Each retry of a failed RD invokes a fresh cascade
        # call, but RDAP can intermittently rate-limit (429) AFTER an
        # earlier call already returned a confirmed terminal answer
        # (available / registered) for the same domain in this run. The
        # naive "latest cascade result wins" policy then silently
        # downgraded a known-good 'available' to 'error', and the user's
        # chip / filter showed the domain under "ошибка" forever. Now:
        # if the current cascade returned a non-terminal result but a
        # PRIOR row in this run's history is terminal, prefer that
        # terminal answer. Scope is `run_id` (not all-time), so the
        # operator can still get a fresh "now error" verdict by spinning
        # up a brand-new availability run.
        if result_status not in TERMINAL_STATUSES:
            terminal_row = (
                db.query(AvailabilityCheck)
                .filter(AvailabilityCheck.domain == domain)
                .filter(AvailabilityCheck.run_id == run_id)
                .filter(AvailabilityCheck.status.in_(
                    (STATUS_AVAILABLE, STATUS_REGISTERED),
                ))
                .order_by(AvailabilityCheck.checked_at.desc())
                .first()
            )
            if terminal_row is not None:
                result_status = terminal_row.status
                result_provider = terminal_row.provider or ""
                result_registrar = terminal_row.registrar or ""
                result_expires_on = terminal_row.expires_on

        data_payload = {
            "verdict": {
                "status": result_status,
                "provider": result_provider,
                "registrar": result_registrar,
                "expires_on": (
                    result_expires_on.isoformat()
                    if result_expires_on else None
                ),
            },
            "trace": _serialize_trace(trace_rows),
        }
        cr = db.get(CriterionResult, cr_id)
        rd = db.get(RunDomain, rd_id)
        if cr is None or rd is None:
            return
        cr.data_json = json.dumps(data_payload)
        cr.error = cascade_error

        # `done` even on status='error'/'unknown' — the cascade
        # completed; whether it found anything is the verdict. `failed`
        # is reserved for the case where the runner itself crashed
        # (cascade_error is set). The Job-page rollup branches on the
        # data_json verdict status, not CR.status.
        if cascade_error:
            cr.status = "failed"
            rd.status = "failed"
            rd.error = cascade_error
        else:
            cr.status = "done"
            rd.status = "done"
            rd.error = ""
        rd.finished_at = datetime.utcnow()
        rd.last_analyzed_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()

    # Approach-1↔approach-2 bridge — write expires_on back to the
    # BacklogDomain row so the Backlog Истечение column populates from
    # a standalone Availability pillar job too (2026-05-17). Previously
    # only the Quality runner (`tasks._run_availability_for_domain`)
    # called this; without it, dedicated availability jobs surfaced the
    # expiration in the Availability column but left Истечение empty.
    # Called AFTER the verdict-preservation block in Phase 3 above so we
    # use the post-preserved values when a stale 'error' was upgraded
    # to a prior terminal 'available'/'registered' row.
    if result_expires_on is not None:
        from .availability.backlog_upsert import upsert_backlog_expiration
        upsert_backlog_expiration(domain, result_expires_on, result_registrar)


async def process_availability_run(run_id: int) -> None:
    """Top-level orchestrator for an availability-kind Run. Dispatched
    by `tasks.dispatch_run` based on the parent Job's kind."""
    # 1. Mark Run running + capture an ownership token (the started_at
    #    we just wrote). Re-checked before finalize writes so a stale
    #    worker can't clobber a fresh Run that reused this run_id via
    #    SQLite rowid recycling. See tasks.process_run for the full
    #    rationale.
    db: Session = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.status != "pending":
            return
        ownership_token = datetime.utcnow()
        run.status = "running"
        run.started_at = ownership_token
        run.error = ""
        db.commit()
        rd_ids = [
            r.id for r in
            db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
        ]
    finally:
        db.close()

    def _still_owns() -> bool:
        s = SessionLocal()
        try:
            r = s.get(Run, run_id)
            return r is not None and r.started_at == ownership_token
        finally:
            s.close()

    # 2. Fan out, bounded. Share one httpx client across all domains
    # so the connection pool can reuse keep-alive sockets; without the
    # share, every domain's RDAP call would establish a fresh TLS
    # connection.
    outer_sem = asyncio.Semaphore(_OUTER_CONCURRENCY)
    async with httpx.AsyncClient(timeout=10.0) as client:
        async def _one(rd_id: int) -> None:
            async with outer_sem:
                await _process_availability_domain(rd_id, run_id, client)

        try:
            await asyncio.gather(
                *(_one(r) for r in rd_ids), return_exceptions=False,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("availability run %s failed", run_id)
            if not _still_owns():
                return
            db = SessionLocal()
            try:
                run = db.get(Run, run_id)
                if run is not None and run.status == "running":
                    run.status = "failed"
                    run.error = f"{type(e).__name__}: {e}"
                    run.finished_at = datetime.utcnow()
                    db.commit()
            finally:
                db.close()
            return

    # 3. Mark done.
    if not _still_owns():
        return
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None and run.status == "running":
            run.status = "done"
            run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()

    # 4. Schedule the auto-retry watcher (added 2026-05-18). Symmetric
    # with `schedule_wayback_auto_retry` at the end of `process_run`:
    # no-op when the Settings toggle is off, when the attempt budget
    # is 0, or when nothing failed. We call it unconditionally so the
    # wiring stays tight — all gating lives inside the scheduler.
    schedule_availability_auto_retry(run_id)


# --- Availability auto-retry watcher (added 2026-05-18) --------------------
#
# Mirror of `tasks._wayback_auto_retry_loop`: after the run finalizes,
# sleep / scan / retry on a backoff schedule until either every
# failure resolves or the attempt budget is exhausted. Lives next to
# `process_availability_run` so the runner + retry loop share the
# same imports + module-level concurrency caps.
#
# Scope (locked 2026-05-18 with user):
#   - CR.status='failed' (cascade runner crashed) → always retry
#   - CR.status='done' + verdict.status='error' AND
#     verdict.provider in cfg.retry_providers → retry
#   - CR.status='done' + verdict.status='unknown' → SKIP
#   - CR.status='done' + verdict.status='error' AND
#     verdict.provider NOT in cfg.retry_providers → SKIP
#
# Default retry_providers is ["rdap"] — user uses RDAP almost
# exclusively + RDAP is free, so the feature is auto-on without
# risking surprise Domainr bills.

# Process-level guard against double-scheduling. Shared with
# tasks._AUTO_RETRY_RUNS by intent but kept separate so a Wayback +
# Availability run could in principle both be retrying simultaneously
# (different run_ids — set membership wouldn't collide anyway, but a
# separate set keeps the ownership clear).
_AVAILABILITY_AUTO_RETRY_RUNS: set[int] = set()


def is_availability_auto_retry_active(run_id: int) -> bool:
    return run_id in _AVAILABILITY_AUTO_RETRY_RUNS


def schedule_availability_auto_retry(run_id: int) -> None:
    """Spawn the auto-retry watcher for `run_id` if Settings allow it.
    Idempotent — does nothing when an auto-retry loop is already in
    flight for this run."""
    if run_id in _AVAILABILITY_AUTO_RETRY_RUNS:
        return
    try:
        from .app_settings import get_availability_auto_retry_config
        cfg = get_availability_auto_retry_config()
    except Exception:  # noqa: BLE001
        log.exception("could not read availability_auto_retry config")
        return
    if not cfg.get("enabled") or int(cfg.get("max_attempts", 0)) <= 0:
        return
    _AVAILABILITY_AUTO_RETRY_RUNS.add(run_id)
    # Fire-and-forget; the loop's `finally` removes the run_id.
    asyncio.create_task(_availability_auto_retry_loop(run_id, dict(cfg)))


def _collect_availability_retry_candidates(
    run_id: int, retry_providers: list[str],
) -> list[int]:
    """Return the list of RunDomain ids on `run_id` worth retrying per
    the scope rules in the module docstring. Reads each candidate's CR
    once; no expensive joins."""
    out: list[int] = []
    retry_set = set(retry_providers)
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return out
        for rd in run.domains:
            if rd.status == "canceled":
                continue
            # Find the availability CR for this rd (1:1 in practice; the
            # cascade only writes one per rd per run).
            av_cr: CriterionResult | None = None
            for cr in rd.results:
                if cr.criterion == "availability":
                    av_cr = cr
                    break
            if av_cr is None:
                continue
            if av_cr.status == "failed":
                # Cascade crashed — runner-level error. Always
                # retryable; provider whitelist doesn't apply (we
                # don't know which provider was in flight when the
                # runner died).
                out.append(rd.id)
                continue
            if av_cr.status != "done":
                # pending / running — leave it; either it's still
                # in flight (shouldn't happen post-finalize) or
                # something pathological is going on.
                continue
            # status='done': inspect the verdict.
            if not av_cr.data_json:
                continue
            try:
                body = json.loads(av_cr.data_json)
            except json.JSONDecodeError:
                continue
            verdict = body.get("verdict") if isinstance(body, dict) else None
            if not isinstance(verdict, dict):
                continue
            v_status = verdict.get("status")
            v_provider = verdict.get("provider")
            if v_status != STATUS_ERROR:
                # 'available' / 'registered' — terminal success.
                # 'unknown' — terminal-not-actionable; skip.
                continue
            if not isinstance(v_provider, str) or v_provider not in retry_set:
                continue
            out.append(rd.id)
        return out
    finally:
        db.close()


def _read_run_status_for_retry(run_id: int) -> str | None:
    """Cheap status read used by the retry loop's pause/cancel/re-run
    bail-out. Returns None if the run row vanished (deleted between
    sleep ticks)."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.status if run is not None else None
    finally:
        db.close()


async def _availability_auto_retry_loop(run_id: int, cfg: dict) -> None:
    """Sleep / collect candidates / dispatch retries / repeat until
    budget hit or no candidates remain. Caller guarantees the Settings
    toggle is on, max_attempts > 0, and this run isn't already being
    auto-retried."""
    try:
        delay = float(cfg.get("initial_delay_sec", 60))
        multiplier = float(cfg.get("backoff_multiplier", 2.0))
        max_attempts = int(cfg.get("max_attempts", 2))
        retry_providers = list(cfg.get("retry_providers") or [])
        for _attempt in range(max_attempts):
            await asyncio.sleep(max(0.0, delay))
            delay *= multiplier

            # Bail if the user re-ran / canceled / paused this run
            # while we were sleeping — they're driving now, get out
            # of the way. Mirrors the wayback loop's check.
            cur_status = _read_run_status_for_retry(run_id)
            if cur_status not in ("done", "failed"):
                return

            # Skip RDs already being worked on by a manual retry —
            # avoids racing the in-flight workers + double-writing.
            # Import lazily to avoid the tasks↔availability_runner
            # cycle at module load time.
            from .tasks import _REANALYZING_RUN_DOMAINS

            candidates = _collect_availability_retry_candidates(
                run_id, retry_providers,
            )
            if not candidates:
                return
            candidates = [
                rd_id for rd_id in candidates
                if not _REANALYZING_RUN_DOMAINS.is_active(rd_id)
            ]
            if not candidates:
                continue

            # Build a fresh spec to hand the per-RD retry plumbing.
            # The availability branch of `_retry_failed_run_domain`
            # only reads `spec.criteria.availability.enabled` — but
            # we have to satisfy AnalyzeSpec's required `domains`
            # field with something, so we re-use the run's own spec.
            from .schemas import AnalyzeSpec
            db_spec = SessionLocal()
            try:
                run = db_spec.get(Run, run_id)
                if run is None:
                    return
                try:
                    spec = AnalyzeSpec.model_validate(
                        json.loads(run.spec_json or "{}"),
                    )
                except Exception:  # noqa: BLE001
                    return
            finally:
                db_spec.close()

            # Force use_cache=False so a stale cached row doesn't get
            # served back instead of re-running the cascade. (The
            # availability pillar's cascade already forces this on the
            # main path; this is belt-and-suspenders for the retry.)
            spec.use_cache = False

            from .tasks import _retry_failed_run_domain
            tasks: list[asyncio.Task] = []
            for rd_id in candidates:
                t = asyncio.create_task(
                    _retry_failed_run_domain(
                        rd_id, ["availability"], spec, track_set=True,
                    ),
                )
                _REANALYZING_RUN_DOMAINS.add_task(rd_id, t)
                tasks.append(t)
            await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:  # noqa: BLE001
        log.exception(
            "availability auto-retry loop crashed for run %s", run_id,
        )
    finally:
        _AVAILABILITY_AUTO_RETRY_RUNS.discard(run_id)
