"""Runner for the `linked_domains` Job kind (added 2026-07-02).

Linked Domains Checker: for each input target (a RunDomain), fetch the
external domains it links out to via Ahrefs
`/site-explorer/linked-domains` — ONE GET per target (this endpoint isn't
chunkable like /batch-analysis). Built to stay resilient at 1000 targets
× up to ~1000 linked domains each (~1M output rows) in one Run.

  • One Ahrefs GET per target → writes N LinkedDomainRow rows plus one
    CriterionResult(criterion='linked_domains') carrying the per-target
    status + Ahrefs unit accounting.
  • Concurrency bounded by `_OUTER_CONCURRENCY` (in-flight target
    coroutines / DB sessions) AND `limit("ahrefs")` (the shared RPM +
    max-concurrent token bucket). Mirrors ahrefs_batch_analysis_runner.
  • Short-lived DB sessions only — never held across the HTTP await, so a
    1000-target run never pins the connection pool.
  • Idempotent + resumable: re-queries not-yet-terminal RDs, and DELETEs a
    target's prior LinkedDomainRows before re-inserting, so a resume after
    pause / crash-recovery (`mark_orphaned_runs_paused`) re-fetches only
    the remainder without duplicating rows. Mirrors the batch runner's
    resume contract.
  • Responsive pause/cancel: polls `is_paused` / `is_canceled` before each
    target. Finalize only writes `done` when the Run is STILL running, so
    a pause/cancel that already flipped the status is never clobbered.
  • Optional per-run unit budget (spec.criteria.linked_domains.unit_budget):
    once cumulative billed units cross the ceiling, the run auto-pauses
    (resumable) instead of spending more.

Cost shape: select=domain only (1 unit/row); `root_only` and `min_dr` are
applied as server-side `where` filters, so they shrink the billed row
count and cost nothing extra to display (DR is filtered, never selected).

Dispatched by `tasks.dispatch_run` on `job.kind == 'linked_domains'`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from urllib.parse import urlencode

from sqlalchemy.orm import Session

from .db import SessionLocal
from .limits import limit
from .models import CriterionResult, LinkedDomainRow, Run, RunDomain
from .providers.ahrefs import AhrefsClient
from .providers.ahrefs_requests import API_BASE as _SE_BASE
from .providers.base import ProviderConfigError, ProviderError
from .schemas import AnalyzeSpec

log = logging.getLogger(__name__)

CRITERION = "linked_domains"

# In-flight target coroutines. Each holds a short DB session + (at the
# gate) one Ahrefs slot. The real HTTP throttle is `limit("ahrefs")`; this
# just stops a 1000-target run from scheduling 1000 coroutines at once.
_OUTER_CONCURRENCY = 8

# RunDomain statuses that don't need (re)processing on a fresh/resumed run.
_TERMINAL_RD = ("done", "canceled")

# Ahrefs v3 path segment is `linkeddomains` (no hyphen) — matches the
# response key and the docs slug. `linked-domains` returns HTTP 404.
_ENDPOINT = f"{_SE_BASE}/linkeddomains"

# Ahrefs `limit` for this endpoint. The API accepts up to _MAX_PER_TARGET
# (verified HTTP 200 at 5000 on 2026-07-02). When the user leaves the
# per-target limit unset we fetch to _DEFAULT_PER_TARGET — the user chose to
# default to the full 5000 ("get everything per domain"); the per-run unit
# budget is the cost guardrail. Explicit values are still clamped to
# _MAX_PER_TARGET.
_MAX_PER_TARGET = 5000
_DEFAULT_PER_TARGET = 5000


def _normalize_target(domain: str) -> str:
    """Strip scheme/path/whitespace and lowercase. Ahrefs accepts a bare
    domain as the target; `mode=subdomains` (set at call build time) scopes
    the crawl to the domain AND its subdomains."""
    d = domain.strip().lower()
    for prefix in ("https://", "http://"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d.split("/", 1)[0]


def _build_url(
    target: str, *, root_only: bool, min_dr: int | None, limit_n: int,
    tlds: list[str] | None = None,
) -> str:
    """Compose the linked-domains GET URL. `where` uses the same
    `{"and":[{"field":..,"is":[op,val]}]}` shape as ahrefs_requests, encoded
    with urlencode so reserved chars match what httpx puts on the wire.

    `tlds` becomes an OR of `domain suffix ".{tld}"` clauses — free per row
    (domain is the already-selected column) and it CUTS billed rows. Probed
    2026-07-10: the full 563-entry default list fits one GET (46KB URL)."""
    clauses: list[dict] = []
    if root_only:
        clauses.append({"field": "is_root_domain", "is": ["eq", True]})
    if min_dr is not None:
        clauses.append({"field": "domain_rating", "is": ["gte", min_dr]})
    if tlds:
        clauses.append({"or": [
            {"field": "domain", "is": ["suffix", f".{t}"]} for t in tlds
        ]})
    params: list[tuple[str, str]] = [
        ("limit", str(limit_n)),
        ("select", "domain"),
        ("target", target),
        ("mode", "subdomains"),
        ("protocol", "both"),
        ("output", "json"),
    ]
    if clauses:
        params.append(("where", json.dumps({"and": clauses}, separators=(",", ":"))))
    return f"{_ENDPOINT}?{urlencode(params)}"


def _billed(units: dict) -> int:
    """Units actually charged for one call. Ahrefs may report cost_actual=0
    (its own server-side cache saved the call); fall back to cost_total, then
    0, so the budget tracker never under- or double-counts."""
    actual = units.get("cost_actual")
    if actual is not None:
        return int(actual)
    total = units.get("cost_total")
    return int(total) if total is not None else 0


async def process_linked_domains_run(run_id: int) -> None:
    """Top-level orchestrator. Dispatched by `tasks.dispatch_run`."""
    from .tasks import is_canceled, is_paused

    # --- Phase 1: mark running, capture ownership token, read spec,
    #     preload (rd_id, domain) pairs in stable id order.
    db: Session = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.status != "pending":
            return
        job_id = run.job_id
        ownership_token = datetime.utcnow()
        run.status = "running"
        run.started_at = ownership_token
        run.error = ""
        db.commit()
        try:
            spec = AnalyzeSpec.model_validate_json(run.spec_json or "{}")
            cfg = spec.criteria.linked_domains
            root_only = bool(cfg.root_only)
            min_dr = cfg.min_dr
            per_target = min(int(cfg.per_target_limit or _DEFAULT_PER_TARGET), _MAX_PER_TARGET)
            unit_budget = cfg.unit_budget
            tlds = list(cfg.tlds) if cfg.tlds else None
        except Exception:  # noqa: BLE001
            root_only, min_dr, per_target, unit_budget = False, None, _DEFAULT_PER_TARGET, None
            tlds = None
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

    def _still_owns() -> bool:
        s = SessionLocal()
        try:
            r = s.get(Run, run_id)
            return r is not None and r.started_at == ownership_token
        finally:
            s.close()

    # Cooperative stop flags — set when a target observes pause/cancel or the
    # budget is spent, so peers short-circuit without each re-hitting the DB.
    stop = {"flag": False, "budget": False}
    spent = {"units": 0}
    spent_lock = asyncio.Lock()
    outer_sem = asyncio.Semaphore(_OUTER_CONCURRENCY)

    async with AhrefsClient() as client:

        async def _one_target(rd_id: int, domain: str) -> None:
            if stop["flag"]:
                return
            if is_canceled(run_id) or is_paused(run_id):
                stop["flag"] = True
                return
            if unit_budget is not None and spent["units"] >= unit_budget:
                stop["budget"] = True
                stop["flag"] = True
                return

            # Claim the RD (skip if already terminal — idempotent resume).
            s = SessionLocal()
            try:
                rd = s.get(RunDomain, rd_id)
                if rd is None or rd.status in _TERMINAL_RD:
                    return
                rd.status = "running"
                rd.started_at = rd.started_at or datetime.utcnow()
                s.commit()
            finally:
                s.close()

            target = _normalize_target(domain)
            url = _build_url(
                target, root_only=root_only, min_dr=min_dr,
                limit_n=per_target, tlds=tlds,
            )

            # Rate-limited Ahrefs call — token held only for the HTTP I/O.
            # Re-check pause/cancel just before spending.
            status = None
            body: dict = {}
            units: dict = {}
            err = ""
            try:
                async with limit("ahrefs"):
                    if is_canceled(run_id) or is_paused(run_id):
                        stop["flag"] = True
                        return
                    status, body, units = await client.fetch_url(url)
            except ProviderConfigError as e:
                # Missing/invalid API key — fatal for the whole run, no point
                # hammering the remaining targets. Flag stop and record.
                err = f"{type(e).__name__}: {e}"
                stop["flag"] = True
            except ProviderError as e:
                err = f"{type(e).__name__}: {e}"
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"

            # Parse linked domains (dedupe within this target defensively —
            # Ahrefs returns each linked domain once, but a set is cheap).
            rows: list[dict] = []
            if not err:
                seen: set[str] = set()
                for it in (body.get("linkeddomains") or []):
                    dom = (it.get("domain") or "").strip().lower()
                    if not dom or dom in seen:
                        continue
                    seen.add(dom)
                    rows.append({
                        "run_domain_id": rd_id,
                        "run_id": run_id,
                        "job_id": job_id,
                        "linked_domain": dom,
                        "domain_rating": it.get("domain_rating"),
                    })

            async with spent_lock:
                spent["units"] += _billed(units)

            # Persist per-target (short session). DELETE prior rows for this
            # RD first so a resumed re-fetch overwrites rather than stacks.
            s = SessionLocal()
            try:
                s.query(LinkedDomainRow).filter(
                    LinkedDomainRow.run_domain_id == rd_id
                ).delete(synchronize_session=False)
                if rows:
                    s.bulk_insert_mappings(LinkedDomainRow, rows)

                rd = s.get(RunDomain, rd_id)
                now = datetime.utcnow()
                cr = (
                    s.query(CriterionResult)
                    .filter(
                        CriterionResult.run_domain_id == rd_id,
                        CriterionResult.criterion == CRITERION,
                    )
                    .order_by(CriterionResult.id.desc())
                    .first()
                )
                if cr is None:
                    cr = CriterionResult(run_domain_id=rd_id, criterion=CRITERION)
                    s.add(cr)
                cr.request_url = url
                cr.http_status = status
                cr.fetched_at = now
                cr.data_json = json.dumps({"count": len(rows), "error": err})
                cr.units_cost_row = units.get("cost_row")
                cr.units_cost_total = units.get("cost_total")
                cr.units_cost_actual = units.get("cost_actual")
                if err:
                    cr.status = "failed"
                    cr.error = err
                    if rd is not None:
                        rd.status = "failed"
                        rd.error = err
                else:
                    cr.status = "done"
                    cr.error = ""
                    if rd is not None:
                        rd.status = "done"
                        rd.error = ""
                if rd is not None:
                    rd.finished_at = now
                s.commit()
            finally:
                s.close()

        async def _guarded(rd_id: int, domain: str) -> None:
            async with outer_sem:
                await _one_target(rd_id, domain)

        try:
            await asyncio.gather(
                *(_guarded(rid, d) for rid, d in rd_rows),
                return_exceptions=False,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("linked_domains run %s failed", run_id)
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

    # --- Phase 3: finalize. Only touch the Run if we still own it AND it's
    # still running (a user pause/cancel already flipped the status).
    if not _still_owns():
        return
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None and run.status == "running":
            if stop["budget"]:
                # Auto-pause on budget: resumable via the normal Resume path,
                # which re-dispatches and skips the already-done targets.
                run.status = "paused"
                run.error = (
                    f"Unit budget reached ({spent['units']:,} units spent, "
                    f"cap {unit_budget:,}); auto-paused. Raise or clear the "
                    "budget and Resume to continue with the remaining targets."
                )
            else:
                run.status = "done"
                run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
