"""Runner for the `serp_overview` Job kind (added 2026-07-10).

Persistent SERP Overview: for each keyword target (a RunDomain whose
`domain` column holds the keyword), fetch the ranking-page URLs via
Ahrefs `/serp-overview/serp-overview` — one GET per keyword. Successor
to the stateless /tools/ahrefs-serp-overview probe, rebuilt on the same
resilience contract as linked_domains_runner:

  • One Ahrefs GET per keyword → writes N SerpOverviewRow rows plus one
    CriterionResult(criterion='serp_overview') carrying the per-keyword
    status + Ahrefs unit accounting.
  • Concurrency bounded by `_OUTER_CONCURRENCY` AND `limit("ahrefs")`.
  • Short-lived DB sessions only — never held across the HTTP await.
  • Idempotent + resumable: re-queries not-yet-terminal RDs, and DELETEs a
    keyword's prior SerpOverviewRows before re-inserting, so a resume after
    pause / crash-recovery (`mark_orphaned_runs_paused`) re-fetches only
    the remainder without duplicating rows.
  • Responsive pause/cancel; finalize only writes `done` when the Run is
    STILL running, so a user pause/cancel is never clobbered.
  • Optional per-run unit budget (spec.criteria.serp_overview.unit_budget):
    once cumulative billed units cross the ceiling, the run auto-pauses
    (resumable) instead of spending more.

Cost shape: select=url only (cheapest column set), ~50-unit floor per
keyword. Keywords 'ahrefs' and 'wordcount' are free (Ahrefs test words).

Dispatched by `tasks.dispatch_run` on `job.kind == 'serp_overview'`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from urllib.parse import urlencode, urlsplit

from sqlalchemy.orm import Session

from .db import SessionLocal
from .limits import limit
from .models import CriterionResult, Run, RunDomain, SerpOverviewRow
from .providers.ahrefs import AhrefsClient
from .providers.base import ProviderConfigError, ProviderError
from .schemas import AnalyzeSpec

log = logging.getLogger(__name__)

CRITERION = "serp_overview"

# In-flight keyword coroutines; the real HTTP throttle is `limit("ahrefs")`.
_OUTER_CONCURRENCY = 8

# RunDomain statuses that don't need (re)processing on a fresh/resumed run.
_TERMINAL_RD = ("done", "canceled")

_ENDPOINT = "https://api.ahrefs.com/v3/serp-overview/serp-overview"


def _build_url(keyword: str, *, country: str, top_positions: int | None) -> str:
    """Compose the serp-overview GET URL — identical shape to the old
    stateless probe (`select=url`, SERP-ordered `positions` array back)."""
    params: list[tuple[str, str]] = [
        ("select", "url"),
        ("country", country),
        ("keyword", keyword),
        ("output", "json"),
    ]
    if top_positions is not None:
        params.append(("top_positions", str(top_positions)))
    return f"{_ENDPOINT}?{urlencode(params)}"


def _billed(units: dict) -> int:
    """Units actually charged for one call (cost_actual, falling back to
    cost_total) — same accounting as linked_domains_runner."""
    actual = units.get("cost_actual")
    if actual is not None:
        return int(actual)
    total = units.get("cost_total")
    return int(total) if total is not None else 0


async def process_serp_overview_run(run_id: int) -> None:
    """Top-level orchestrator. Dispatched by `tasks.dispatch_run`."""
    from .tasks import is_canceled, is_paused

    # --- Phase 1: mark running, capture ownership token, read spec,
    #     preload (rd_id, keyword) pairs in stable id order.
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
            cfg = spec.criteria.serp_overview
            country = (cfg.country or "us").strip().lower()
            top_positions = cfg.top_positions
            unit_budget = cfg.unit_budget
        except Exception:  # noqa: BLE001
            country, top_positions, unit_budget = "us", 10, None
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

    stop = {"flag": False, "budget": False}
    spent = {"units": 0}
    spent_lock = asyncio.Lock()
    outer_sem = asyncio.Semaphore(_OUTER_CONCURRENCY)

    async with AhrefsClient() as client:

        async def _one_keyword(rd_id: int, keyword: str) -> None:
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

            url = _build_url(
                keyword, country=country, top_positions=top_positions,
            )

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
                # Missing/invalid API key — fatal for the whole run.
                err = f"{type(e).__name__}: {e}"
                stop["flag"] = True
            except ProviderError as e:
                err = f"{type(e).__name__}: {e}"
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"

            # Parse ranking URLs — SERP-ordered `positions` array; drop
            # SERP-feature rows whose url is null (same rule as the old
            # probe). `position` = 1-based order among the KEPT urls.
            rows: list[dict] = []
            positions_count = 0
            if not err:
                raw = body.get("positions") if isinstance(body, dict) else None
                raw_list = raw if isinstance(raw, list) else []
                positions_count = len(raw_list)
                n = 0
                for r in raw_list:
                    if not isinstance(r, dict):
                        continue
                    u = r.get("url")
                    if isinstance(u, str) and u:
                        n += 1
                        # Derive the ranking-page domain at write time so
                        # the global unique-domains export is an indexed
                        # DISTINCT (hostname, lowercased, www. stripped).
                        try:
                            host = (urlsplit(u).hostname or "").lower()
                        except ValueError:
                            host = ""
                        if host.startswith("www."):
                            host = host[4:]
                        rows.append({
                            "run_domain_id": rd_id,
                            "run_id": run_id,
                            "job_id": job_id,
                            "keyword": keyword,
                            "position": n,
                            "url": u,
                            "domain": host,
                        })

            async with spent_lock:
                spent["units"] += _billed(units)

            # Persist per-keyword (short session). DELETE prior rows for
            # this RD first so a resumed re-fetch overwrites, not stacks.
            s = SessionLocal()
            try:
                s.query(SerpOverviewRow).filter(
                    SerpOverviewRow.run_domain_id == rd_id
                ).delete(synchronize_session=False)
                if rows:
                    s.bulk_insert_mappings(SerpOverviewRow, rows)

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
                cr.data_json = json.dumps({
                    "urls": len(rows),
                    "positions_count": positions_count,
                    "error": err,
                })
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

        async def _guarded(rd_id: int, keyword: str) -> None:
            async with outer_sem:
                await _one_keyword(rd_id, keyword)

        try:
            await asyncio.gather(
                *(_guarded(rid, k) for rid, k in rd_rows),
                return_exceptions=False,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("serp_overview run %s failed", run_id)
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
                run.status = "paused"
                run.error = (
                    f"Unit budget reached ({spent['units']:,} units spent, "
                    f"cap {unit_budget:,}); auto-paused. Raise or clear the "
                    "budget and Resume to continue with the remaining "
                    "keywords."
                )
            else:
                run.status = "done"
                run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
