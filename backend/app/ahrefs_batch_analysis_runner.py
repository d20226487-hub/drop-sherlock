"""Runner for the `ahrefs_batch_analysis` Job kind (added 2026-06-02).

Bulk Ahrefs /batch-analysis metrics pull, built to stay resilient at
100k domains in one Run. Unlike the availability cascade (one upstream
call per domain), batch-analysis is naturally CHUNKED: up to 100 targets
per call (the API ceiling), so 100k domains = ~1000 calls. The runner
therefore processes by CHUNK, not per-domain:

  • One Ahrefs POST per ≤100-domain chunk → writes 100 CriterionResults.
  • Concurrency bounded by both `_OUTER_CONCURRENCY` (caps in-flight
    chunk coroutines / DB sessions) and `limit("ahrefs")` (the shared
    RPM + max-concurrent token bucket).
  • Each chunk uses SHORT-LIVED DB sessions only — never held across the
    HTTP await — so a 100k run never pins the connection pool.
  • Idempotent + resumable: a chunk re-queries which of its RDs are not
    yet terminal, so a re-dispatch (resume after pause / crash recovery
    via `mark_orphaned_runs_paused`) skips already-done domains and only
    re-fetches the remainder. Mirrors `resume_run_now`'s contract.
  • Responsive pause/cancel: polls `is_paused` / `is_canceled` before
    each chunk's work and bails. Finalize only writes `done` when the
    Run is still `running`, so a pause/cancel that flipped the status
    is never clobbered.

Dispatched by `tasks.dispatch_run` on `job.kind == 'ahrefs_batch_analysis'`.
Writes one CriterionResult(criterion='ahrefs_batch_analysis') per domain
with data_json `{"metrics": {field: value|None}, "http_status": int,
"error": str}`. No AI step — the metrics are the verdict.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime

import httpx
from sqlalchemy.orm import Session

from .app_settings import SessionLocal, get_provider_creds
from .limits import limit
from .models import CriterionResult, Run, RunDomain
from .providers.ahrefs_batch import (
    BATCH_SIZE,
    ChunkOutcome,
    canonical_metrics,
    fetch_batch_chunk,
)
from .schemas import AnalyzeSpec

log = logging.getLogger(__name__)

CRITERION = "ahrefs_batch_analysis"

# How many chunk coroutines may be live at once. Each holds a short DB
# session + (when it reaches the gate) one Ahrefs slot. The real HTTP
# throttle is `limit("ahrefs")`; this just stops a 100k run from
# scheduling ~1000 chunk tasks (and their mark-running DB writes) on the
# loop simultaneously.
_OUTER_CONCURRENCY = 8

# Statuses a RunDomain can be in and NOT need (re)processing. `done` =
# already fetched; `canceled` = user killed it. Everything else
# (pending / running / failed) is fair game on a fresh or resumed run.
_TERMINAL_RD = ("done", "canceled")


async def process_ahrefs_batch_analysis_run(run_id: int) -> None:
    """Top-level orchestrator. Dispatched by `tasks.dispatch_run`."""
    from .tasks import is_canceled, is_paused

    # --- Phase 1: mark running, capture ownership token, read spec,
    #     preload (rd_id, domain) pairs in stable id order.
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
        try:
            spec = AnalyzeSpec.model_validate_json(run.spec_json or "{}")
            cfg = spec.criteria.ahrefs_batch_analysis
            select = canonical_metrics(cfg.metrics) or ["domain_rating"]
            country = (cfg.country or "").strip() or None
        except Exception:  # noqa: BLE001
            select = ["domain_rating"]
            country = None
        rd_rows: list[tuple[int, str]] = [
            (r.id, r.domain)
            for r in (
                db.query(RunDomain)
                .filter(RunDomain.run_id == run_id)
                .order_by(RunDomain.id.asc())
                .all()
            )
        ]
    finally:
        db.close()

    api_key = get_provider_creds("ahrefs").get("api_key") or ""

    def _still_owns() -> bool:
        s = SessionLocal()
        try:
            r = s.get(Run, run_id)
            return r is not None and r.started_at == ownership_token
        finally:
            s.close()

    chunks = [
        rd_rows[i : i + BATCH_SIZE]
        for i in range(0, len(rd_rows), BATCH_SIZE)
    ]

    # Cooperative stop flag — set when a chunk observes pause/cancel so
    # peers can short-circuit without each re-hitting the DB.
    stop = {"flag": False}
    outer_sem = asyncio.Semaphore(_OUTER_CONCURRENCY)

    async with httpx.AsyncClient(timeout=60.0) as client:

        async def _one_chunk(chunk: list[tuple[int, str]]) -> None:
            if stop["flag"]:
                return
            if is_canceled(run_id) or is_paused(run_id):
                stop["flag"] = True
                return

            ids = [rid for rid, _ in chunk]

            # Mark the not-yet-terminal RDs running (short session).
            # Skip the chunk entirely if every RD is already terminal
            # (idempotent resume — done domains aren't re-fetched).
            s = SessionLocal()
            try:
                pending_rds = (
                    s.query(RunDomain)
                    .filter(
                        RunDomain.id.in_(ids),
                        RunDomain.status.notin_(_TERMINAL_RD),
                    )
                    .all()
                )
                if not pending_rds:
                    return
                pending_ids = [rd.id for rd in pending_rds]
                now = datetime.utcnow()
                for rd in pending_rds:
                    rd.status = "running"
                    rd.started_at = rd.started_at or now
                s.commit()
                # Only the domains we actually claimed get fetched.
                domains = [rd.domain for rd in pending_rds]
            finally:
                s.close()

            # Rate-limited Ahrefs call — token held only for the HTTP I/O,
            # never across DB work. Re-check cancel just before spending.
            async with limit("ahrefs"):
                if is_canceled(run_id) or is_paused(run_id):
                    stop["flag"] = True
                    return
                outcome: ChunkOutcome = await fetch_batch_chunk(
                    client, api_key, domains, select, country=country,
                )

            # Persist per-domain (short session). Upsert the latest CR per
            # RD so a resumed re-fetch overwrites the prior partial row
            # rather than stacking duplicates.
            s = SessionLocal()
            try:
                rds = (
                    s.query(RunDomain)
                    .filter(RunDomain.id.in_(pending_ids))
                    .all()
                )
                now = datetime.utcnow()
                for rd in rds:
                    if outcome.error:
                        data = {
                            "metrics": {},
                            "http_status": outcome.http_status,
                            "error": outcome.error,
                        }
                        cr_status = "failed"
                        rd.status = "failed"
                        rd.error = outcome.error
                    else:
                        data = {
                            "metrics": outcome.metrics_by_domain.get(rd.domain, {}),
                            "http_status": outcome.http_status,
                            "error": "",
                        }
                        cr_status = "done"
                        rd.status = "done"
                        rd.error = ""
                    cr = (
                        s.query(CriterionResult)
                        .filter(
                            CriterionResult.run_domain_id == rd.id,
                            CriterionResult.criterion == CRITERION,
                        )
                        .order_by(CriterionResult.id.desc())
                        .first()
                    )
                    if cr is None:
                        cr = CriterionResult(
                            run_domain_id=rd.id, criterion=CRITERION,
                        )
                        s.add(cr)
                    cr.status = cr_status
                    cr.data_json = json.dumps(data)
                    cr.error = outcome.error
                    cr.fetched_at = now
                    rd.finished_at = now
                    rd.last_analyzed_at = now
                s.commit()
            finally:
                s.close()

        async def _guarded(chunk: list[tuple[int, str]]) -> None:
            async with outer_sem:
                await _one_chunk(chunk)

        try:
            await asyncio.gather(
                *(_guarded(c) for c in chunks), return_exceptions=False,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("ahrefs_batch_analysis run %s failed", run_id)
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

    # --- Phase 3: finalize. Only mark done when the Run is STILL running
    # and we still own it. A pause/cancel flipped the status already, so
    # this is a no-op in those cases (the run resumes / stays canceled).
    if stop["flag"] or not _still_owns():
        return
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None and run.status == "running":
            run.status = "done"
            run.finished_at = datetime.utcnow()
            # Auto-pin this criterion to THIS run so the metrics surface
            # as a real pin everywhere (Job page pins panel, Database
            # pin-walk, run-page "pinned here") without the operator
            # having to click — the common workflow is one batch run per
            # job, latest wins. Re-running batch in the same job
            # re-points the pin (handled by the upsert). Lazy import to
            # avoid a circular at module load (jobs.py pulls in this
            # package indirectly).
            from .routers.jobs import _upsert_criterion_pins_for_run
            _upsert_criterion_pins_for_run(db, run, {CRITERION})
            db.commit()
            # Surface the just-autopinned batch metrics (DR / RD / B) on the
            # Database page without waiting for the snapshot's ~5 min TTL.
            # Patch ONLY this run's domains rather than a full rebuild: the
            # batch_metrics merge is per-domain, so only these domains change.
            # Unlike the run-pin ENDPOINTS (which trigger a non-blocking
            # rebuild because they're on a user request), this is the batch
            # WORKER thread and a typical check is a handful of domains — so a
            # bounded synchronous patch is ~instant here, versus a ~20s full
            # `_build_all_rows` (which loads the whole checked set). No-op when
            # no snapshot is warm yet (the next Database visit cold-builds with
            # this committed). This is the fix for "ran a DR/RD check, but the
            # Database doesn't show it for minutes".
            from .models import RunDomain
            from .routers.database import _patch_domains_in_cache
            run_domains = [
                d
                for (d,) in (
                    db.query(RunDomain.domain)
                    .filter(RunDomain.run_id == run.id)
                    .distinct()
                )
            ]
            _patch_domains_in_cache(db, run_domains)
    finally:
        db.close()
