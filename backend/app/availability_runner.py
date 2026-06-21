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
from .availability.cascade import (
    AvailabilityResult,
    check_availability_async,
    run_cascade_network,
)
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

# Write-batch size (2026-06-21 throughput work). The main-run path
# processes the run in chunks of this many domains: mark the chunk
# 'running' (1 txn) → run the chunk's cascades over the network with NO DB
# writes → bulk-write the chunk's trace rows + verdicts + status flips +
# backlog (≈1-2 txns). This collapses the old ~5 tiny commits PER DOMAIN
# (which serialized on SQLite's single writer and capped throughput at
# tens/min) into ≈3 commits per 300 domains, so throughput becomes
# network-bound (the per-provider semaphores) instead of writer-bound.
# 300 balances transaction count against progress-bar granularity and the
# work re-done if the process dies mid-chunk (those rows are left
# 'running' under a running parent → the startup reconciler flips them to
# 'failed' → auto-retry repicks them).
_AV_WRITE_BATCH_SIZE = 300


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


def _serialize_trace_from_results(
    provider_results: list[Any], checked_at_iso: str,
) -> list[dict[str, Any]]:
    """Trace serialization for the batched path — same shape/fields as
    `_serialize_trace`, but from in-memory `ProviderResult` objects (the
    batched runner never queries the rows back). The cascade walks
    first-tried-first, so reverse for last-tried-first; this matches
    `_serialize_trace`'s checked_at/id-desc ordering, since every row in a
    chunk shares one `checked_at`."""
    out: list[dict[str, Any]] = []
    for r in reversed(provider_results):
        item: dict[str, Any] = {
            "provider": r.provider,
            "status": r.status,
            "checked_at": checked_at_iso,
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


def _av_batch_start(rd_ids: list[int]) -> list[tuple[int, str, int]]:
    """SYNC (worker thread): ONE transaction that marks a chunk of
    RunDomains 'running' and inserts their availability CriterionResults.
    Returns [(rd_id, domain, cr_id)] for the rows that were live —
    already-terminal rows (done/failed on a resume) are skipped, same
    guard as the per-domain `_av_phase1_start`. Collapses the old
    per-domain 2 commits (mark-running + create-CR) into 1 for the whole
    chunk."""
    db: Session = SessionLocal()
    try:
        rds = db.query(RunDomain).filter(RunDomain.id.in_(rd_ids)).all()
        now = datetime.utcnow()
        live: list[RunDomain] = []
        for rd in rds:
            if rd.status in ("done", "failed"):
                continue
            rd.status = "running"
            rd.started_at = now
            live.append(rd)
        if not live:
            db.commit()
            return []
        pairs: list[tuple[RunDomain, CriterionResult]] = []
        for rd in live:
            cr = CriterionResult(
                run_domain_id=rd.id,
                criterion="availability",
                status="running",
                fetched_at=now,
                data_json="",
                request_url="",
                error="",
            )
            db.add(cr)
            pairs.append((rd, cr))
        db.flush()  # assigns cr.id without ending the transaction
        out = [(rd.id, rd.domain, cr.id) for (rd, cr) in pairs]
        db.commit()
        return out
    finally:
        db.close()


def _av_batch_backlog(
    db: Session, backlog: list[tuple[str, "Any", str]],
) -> None:
    """Batched `upsert_backlog_expiration` for a chunk, run INSIDE the
    caller's transaction: one query to load existing rows, one ban-filter
    for would-be creates. Same rules as the per-domain version (never
    trample a user-edited date; don't auto-create a banned domain)."""
    if not backlog:
        return
    from .ban_filter import filter_banned
    from .models import BacklogDomain

    now = datetime.utcnow()
    domains = [d for (d, _, _) in backlog]
    existing = {
        row.domain: row
        for row in db.query(BacklogDomain)
        .filter(BacklogDomain.domain.in_(list({d for d in domains})))
        .all()
    }
    to_create = [d for (d, _, _) in backlog if d not in existing]
    banned: set[str] = set()
    if to_create:
        _, banned = filter_banned(db, to_create)
    created: set[str] = set()
    for (domain, exp, registrar) in backlog:
        row = existing.get(domain)
        if row is None:
            # Skip banned; skip a second create for the same domain within
            # this chunk (would collide on the unique domain key at flush).
            if domain in banned or domain in created:
                continue
            db.add(BacklogDomain(
                domain=domain,
                status="analyzed",
                expiration_date=exp,
                registrar=registrar or "",
                created_at=now,
                updated_at=now,
            ))
            created.add(domain)
        else:
            if row.expiration_date != exp:
                row.expiration_date = exp
                row.updated_at = now
            if registrar and not row.registrar:
                row.registrar = registrar
                row.updated_at = now


def _av_batch_finish(run_id: int, collected: list[dict[str, Any]]) -> None:
    """SYNC (worker thread): bulk-write a whole chunk's results in ONE
    transaction — trace rows, CR verdicts, RD status flips, and backlog
    expiration write-backs. Collapses the old per-domain ~3 commits
    (cascade `_persist` + verdict-write + backlog) into ≈1 per chunk.

    Verdict-preservation (run-scoped, matches `_av_phase3_finish`): a
    non-terminal current verdict yields to a terminal row for the same
    domain elsewhere in this run (a dup RD or a prior chunk), so an
    intermittent error can't downgrade a known answer. One indexed query
    (`ix_availability_checks_domain_checked_at`) covers the chunk instead
    of one per domain. Cross-ATTEMPT preservation (a retry that re-checks
    the same rd) lives in the per-domain `_av_phase3_finish` on the retry
    path; the batched main path checks each domain once."""
    if not collected:
        return
    db: Session = SessionLocal()
    try:
        now = datetime.utcnow()
        now_iso = now.isoformat()

        # 1. Bulk-insert every provider trace row for the chunk.
        trace_maps: list[dict[str, Any]] = []
        for it in collected:
            for r in it["trace"]:
                trace_maps.append({
                    "domain": it["domain"],
                    "provider": r.provider,
                    "status": r.status,
                    "checked_at": now,
                    "latency_ms": r.latency_ms,
                    "registrar": r.registrar or "",
                    "expires_on": r.expires_on,
                    "error_message": r.error_message or "",
                    "error_category": r.error_category or "",
                    "raw_response": r.raw_response or "",
                    "run_id": run_id,
                })
        if trace_maps:
            db.bulk_insert_mappings(AvailabilityCheck, trace_maps)
            db.flush()

        # 2. Run-scoped terminal preference for any non-terminal verdict.
        uniq_domains = list({it["domain"] for it in collected})
        best_terminal: dict[str, Any] = {}
        if uniq_domains:
            term_rows = (
                db.query(
                    AvailabilityCheck.domain,
                    AvailabilityCheck.status,
                    AvailabilityCheck.provider,
                    AvailabilityCheck.registrar,
                    AvailabilityCheck.expires_on,
                )
                .filter(AvailabilityCheck.run_id == run_id)
                .filter(AvailabilityCheck.domain.in_(uniq_domains))
                .filter(AvailabilityCheck.status.in_(
                    (STATUS_AVAILABLE, STATUS_REGISTERED),
                ))
                .order_by(AvailabilityCheck.checked_at.asc())
                .all()
            )
            for row in term_rows:
                best_terminal[row.domain] = row  # latest wins (asc order)

        # 3. Build CR + RD update mappings; gather backlog write-backs.
        cr_maps: list[dict[str, Any]] = []
        rd_maps: list[dict[str, Any]] = []
        backlog: list[tuple[str, Any, str]] = []
        for it in collected:
            result: AvailabilityResult = it["result"]
            status = result.status
            provider = result.provider
            registrar = result.registrar
            expires_on = result.expires_on
            cascade_error = it["cascade_error"]
            if status not in TERMINAL_STATUSES:
                t = best_terminal.get(it["domain"])
                if t is not None:
                    status = t.status
                    provider = t.provider or ""
                    registrar = t.registrar or ""
                    expires_on = t.expires_on
            data_payload = {
                "verdict": {
                    "status": status,
                    "provider": provider,
                    "registrar": registrar,
                    "expires_on": (
                        expires_on.isoformat() if expires_on else None
                    ),
                },
                "trace": _serialize_trace_from_results(it["trace"], now_iso),
            }
            # `failed` is reserved for a runner crash (cascade raised); a
            # provider-level 'error'/'unknown' still counts as a completed
            # cascade → 'done'. Mirrors `_av_phase3_finish`.
            failed = bool(cascade_error)
            cr_maps.append({
                "id": it["cr_id"],
                "data_json": json.dumps(data_payload),
                "status": "failed" if failed else "done",
                "error": cascade_error,
            })
            rd_maps.append({
                "id": it["rd_id"],
                "status": "failed" if failed else "done",
                "error": cascade_error,
                "finished_at": now,
                "last_analyzed_at": now,
            })
            if expires_on is not None:
                backlog.append((it["domain"], expires_on, registrar or ""))

        if cr_maps:
            db.bulk_update_mappings(CriterionResult, cr_maps)
        if rd_maps:
            db.bulk_update_mappings(RunDomain, rd_maps)

        # 4. Batched backlog expiration write-back (same transaction).
        _av_batch_backlog(db, backlog)

        db.commit()
    finally:
        db.close()


async def _run_chunk_network(
    live: list[tuple[int, str, int]],
    client: httpx.AsyncClient,
    concurrency: int,
) -> list[dict[str, Any]]:
    """Run `run_cascade_network` for each live (rd_id, domain, cr_id) in a
    chunk, bounded to `concurrency` in-flight cascades. PURE NETWORK — no
    DB session is held here (the writes happen in `_av_batch_finish`).
    Returns the per-domain result dicts the batch writer consumes."""
    sem = asyncio.Semaphore(max(1, concurrency))

    async def _one(rd_id: int, domain: str, cr_id: int) -> dict[str, Any]:
        async with sem:
            cascade_error = ""
            try:
                outcome = await run_cascade_network(domain, client=client)
                result = outcome.result
                trace = outcome.provider_results
            except Exception as e:  # noqa: BLE001
                # run_cascade_network catches per-provider errors; a raise
                # here is a genuine runner-level fault. Mark this rd failed
                # but let the rest of the chunk/run continue.
                cascade_error = f"{type(e).__name__}: {e}"
                log.exception(
                    "availability cascade raised for rd=%s domain=%s",
                    rd_id, domain,
                )
                result = AvailabilityResult(
                    domain=domain, status=STATUS_ERROR, provider="",
                    checked_at=datetime.utcnow(),
                )
                trace = []
            return {
                "rd_id": rd_id,
                "domain": domain,
                "cr_id": cr_id,
                "cascade_error": cascade_error,
                "result": result,
                "trace": trace,
            }

    return await asyncio.gather(*(_one(*t) for t in live))


def _av_phase1_start(rd_id: int) -> tuple[str | None, int | None]:
    """SYNC (runs in a worker thread): mark the rd running + create its
    availability CR. Returns (domain, cr_id), or (None, None) when the rd
    is missing or already terminal (caller skips).

    Skip-terminal guard (2026-06-15): the worker walks every id; on a
    resume the finished rows are still done/failed, and re-running them
    wastes the registry budget + churns the counts. `failed` rows are left
    to the auto-retry loop."""
    db: Session = SessionLocal()
    try:
        rd = db.get(RunDomain, rd_id)
        if rd is None:
            log.warning("availability runner: rd_id=%s missing", rd_id)
            return None, None
        if rd.status in ("done", "failed"):
            return None, None
        domain = rd.domain
        rd.status = "running"
        rd.started_at = datetime.utcnow()
        db.commit()
        # CR up-front so the UI can poll status while the cascade walks.
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
        return domain, cr.id
    finally:
        db.close()


def _av_phase3_finish(
    *,
    cr_id: int | None,
    rd_id: int,
    domain: str,
    run_id: int,
    cascade_error: str,
    result_status: str,
    result_provider: str,
    result_registrar: str,
    result_expires_on,
):
    """SYNC (runs in a worker thread): read this run's trace rows, apply
    verdict-preservation, write the verdict onto the CR, and flip rd/cr to
    done/failed. Returns the post-preservation (expires_on, registrar) so
    the caller can do the backlog write-back.

    Verdict-preservation (2026-05-17 B9 fix): a non-terminal current
    result yields to a PRIOR terminal row for the same domain in this run,
    so an intermittent 429 can't silently downgrade a known 'available'."""
    db: Session = SessionLocal()
    try:
        trace_rows = (
            db.query(AvailabilityCheck)
            .filter(AvailabilityCheck.domain == domain)
            .filter(AvailabilityCheck.run_id == run_id)
            .all()
        )
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
        cr = db.get(CriterionResult, cr_id) if cr_id is not None else None
        rd = db.get(RunDomain, rd_id)
        if cr is None or rd is None:
            return result_expires_on, result_registrar
        cr.data_json = json.dumps(data_payload)
        cr.error = cascade_error
        # `done` even on status='error'/'unknown' — the cascade completed;
        # `failed` is reserved for a runner crash (cascade_error set).
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
        return result_expires_on, result_registrar
    finally:
        db.close()


async def _process_availability_domain(
    rd_id: int, run_id: int, client: httpx.AsyncClient,
) -> None:
    """Run the cascade for one domain.

    The two synchronous DB phases (mark-running + create-CR, and
    write-verdict) plus the backlog write-back run in worker threads via
    `asyncio.to_thread` (2026-06-21). They used to run inline on the event
    loop; under a large run their commits serialized on SQLite's single
    writer and blocked the loop for seconds at a time — which is what made
    page loads + status polling time out ("the tool becomes unusable
    during large runs"). Off the loop, the API stays responsive AND the
    cascade's fast (proxied) network runs at full speed. Each phase still
    uses its own short-lived session — never held across the cascade
    await."""
    # --- Phase 1 (threaded): mark RD running + create CR row.
    domain, cr_id = await asyncio.to_thread(_av_phase1_start, rd_id)
    if domain is None:
        return  # rd missing or already terminal

    # --- Phase 2: cascade (async; no session held across the awaits).
    # use_cache=False — a Job is an explicit "give me fresh state" ask.
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
        # Cascade shouldn't raise (catches per-provider errors); if it
        # does, mark this rd failed but let the run continue.
        cascade_error = f"{type(e).__name__}: {e}"
        log.exception(
            "availability cascade raised for rd=%s domain=%s",
            rd_id, domain,
        )

    # --- Phase 3 (threaded): query trace + write verdict + flip statuses.
    result_expires_on, result_registrar = await asyncio.to_thread(
        _av_phase3_finish,
        cr_id=cr_id,
        rd_id=rd_id,
        domain=domain,
        run_id=run_id,
        cascade_error=cascade_error,
        result_status=result_status,
        result_provider=result_provider,
        result_registrar=result_registrar,
        result_expires_on=result_expires_on,
    )

    # Backlog expiration write-back (threaded) — Истечение column on a
    # standalone Availability job (2026-05-17). Uses the post-preservation
    # values returned by Phase 3.
    if result_expires_on is not None:
        from .availability.backlog_upsert import upsert_backlog_expiration
        await asyncio.to_thread(
            upsert_backlog_expiration,
            domain, result_expires_on, result_registrar,
        )


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
        # Only fan out over NON-terminal rows (2026-06-15). On a resume,
        # the finished rows are still `done`/`failed`; walking them just to
        # skip them inside the worker wastes the outer-concurrency slots on
        # a re-walk (a DB read per row) instead of real lookups — which is
        # why a high concurrency cap wasn't fully engaging. Querying ids
        # directly (not whole ORM rows) also keeps a 60k-row run cheap to
        # enumerate. The skip-done guard in `_av_batch_start` stays as a
        # race safety-net (a row could finish between this query and the
        # chunk being marked running).
        rd_ids = [
            rid for (rid,) in
            db.query(RunDomain.id)
            .filter(RunDomain.run_id == run_id)
            .filter(RunDomain.status.notin_(("done", "failed")))
            .all()
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

    # 2. Process the run in WRITE-BATCHED CHUNKS (2026-06-21). For each
    # chunk of `_AV_WRITE_BATCH_SIZE` domains: mark the chunk running (1
    # txn) → run its cascades over the network bounded to `concurrency`,
    # with NO DB writes → bulk-write the chunk's traces + verdicts + status
    # flips + backlog (≈1-2 txns). This replaces the old per-domain worker
    # pool whose ~5 tiny commits PER DOMAIN serialized on SQLite's single
    # writer and capped throughput at tens/min; throughput is now
    # network-bound (the cascade's per-provider semaphores). The network
    # fan-out per chunk is bounded inside `_run_chunk_network`, so peak
    # live-coroutine count stays at `concurrency` regardless of run size.
    # Share one httpx client across the whole run for keep-alive reuse.
    from .app_settings import get_availability_outer_concurrency
    from .tasks import is_canceled, is_paused
    concurrency = get_availability_outer_concurrency()
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            for i in range(0, len(rd_ids), _AV_WRITE_BATCH_SIZE):
                # Cancel / PAUSE / ownership check at every chunk boundary.
                # The pre-batching main path couldn't be interrupted at all —
                # it ran every domain to completion before re-checking
                # ownership — so a Cancel/Pause on a 60k run did nothing
                # visible until the end. Now they take effect within one
                # chunk (≤ chunk_size/concurrency × latency).
                #
                # PAUSE (2026-06-21 fix): `pause_run_now` sets run.status=
                # 'paused' + the `_PAUSED_RUNS` flag and relies on the worker
                # exiting on `is_paused`. The quality runner's per-domain loop
                # already does this; this batched availability loop did NOT,
                # so a paused availability run kept processing chunks to the
                # end (observed on run 157). Returning here leaves the run
                # 'paused' (we never reach the done-flip below); `resume_run_
                # now` resets the still-non-terminal rows to pending and
                # re-dispatches.
                if is_canceled(run_id) or is_paused(run_id) or not _still_owns():
                    return
                chunk = rd_ids[i : i + _AV_WRITE_BATCH_SIZE]
                live = await asyncio.to_thread(_av_batch_start, chunk)
                if not live:
                    continue
                collected = await _run_chunk_network(live, client, concurrency)
                await asyncio.to_thread(_av_batch_finish, run_id, collected)
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
        # Chunked iteration (2026-06-17) so the post-run auto-retry watcher
        # doesn't re-hydrate every RunDomain + results of a 60k-domain run
        # on each backoff pass (the pymalloc-fragmentation balloon).
        from .tasks import _iter_run_domains_chunked
        for rd in _iter_run_domains_chunked(db, run_id):
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

            # Bounded pool (2026-06-17) instead of one task (+ one httpx
            # client) per candidate — the auto-retry watcher could otherwise
            # spawn thousands of concurrent re-cascades and OOM the API.
            from .tasks import _run_retry_pool
            failed_per_rd = {rd_id: ["availability"] for rd_id in candidates}
            await _run_retry_pool(run_id, failed_per_rd, spec)
    except Exception:  # noqa: BLE001
        log.exception(
            "availability auto-retry loop crashed for run %s", run_id,
        )
    finally:
        _AVAILABILITY_AUTO_RETRY_RUNS.discard(run_id)
