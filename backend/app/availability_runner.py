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
        if result_status not in (STATUS_AVAILABLE, STATUS_REGISTERED):
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


async def process_availability_run(run_id: int) -> None:
    """Top-level orchestrator for an availability-kind Run. Dispatched
    by `tasks.dispatch_run` based on the parent Job's kind."""
    # 1. Mark Run running.
    db: Session = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.status != "pending":
            return
        run.status = "running"
        run.started_at = datetime.utcnow()
        run.error = ""
        db.commit()
        rd_ids = [
            r.id for r in
            db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
        ]
    finally:
        db.close()

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
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None and run.status == "running":
            run.status = "done"
            run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
