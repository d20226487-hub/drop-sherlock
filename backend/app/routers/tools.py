"""Tooling endpoints — ad-hoc probes that don't fit the Job/Run/CR
pipeline. Lightweight, intended for hands-on experimentation.

Tools today:
- POST /tools/ahrefs-batch-analysis — bulk Ahrefs probe across multiple
  domains. Two independent data sources, both selectable per request:
    * Keywords history (Site Explorer /keywords-history) — per-domain
      time series of top4_10 / top11_20 ranking-keyword counts over a
      date range.
    * Batch Analysis (/batch-analysis/batch-analysis) — current-snapshot
      metrics (DR, referring domains follow/nofollow, dofollow
      backlinks, referring IP subnets, organic traffic + keyword bands)
      fetched in batched POSTs at ~1 unit/domain/field.
  Returns per-domain rows + cost summary so the operator can decide
  whether the signal is worth the unit spend. NO persistence — results
  live for the duration of the HTTP response.
- POST /tools/wayback-sparkline — bulk Wayback total-snapshot-count
  probe. Persistent (DB-backed) so 100k-domain batches can run for
  hours and survive tab closes / page reloads. See the section at the
  bottom of this file + `wayback_sparkline_runner.py`.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone, timedelta
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import WaybackSparklineJob, WaybackSparklineResult
from ..providers.ahrefs import AhrefsClient

router = APIRouter(prefix="/tools", tags=["tools"])


# Same predefined buckets as KeywordsConfig.date_compared for
# consistency. The /tools test page lets the operator pick one and
# probe across a batch.
DateRangeChoice = Literal["3m", "6m", "1y", "2y", "5y"]

_RANGE_DAYS: dict[str, int] = {
    "3m": 30 * 3,
    "6m": 30 * 6,
    "1y": 365,
    "2y": 365 * 2,
    "5y": 365 * 5,
}


# Allowlisted /batch-analysis metrics live in providers/ahrefs_batch.py
# now (shared with the Ahrefs Batch Analysis Job runner). Re-exported
# here so this module's existing references keep working.
from ..providers.ahrefs_batch import BATCH_METRICS  # noqa: E402


class AhrefsBatchToolIn(BaseModel):
    """Request body for the /tools/ahrefs-batch-analysis probe."""
    # Accept a generous list size — the test surface is hand-driven,
    # so a sensible upper bound prevents accidental cost blowouts.
    # 1000 × ~50 units = ~50k units worst case for KH (batch-analysis
    # adds ~1u/domain/field on top — batched, so cheap at this scale).
    domains: list[str] = Field(min_length=1, max_length=1000)
    date_range: DateRangeChoice = "2y"
    history_grouping: Literal["daily", "weekly", "monthly"] = "monthly"
    # Concurrency cap on the Ahrefs side. 4 is conservative — the
    # default Ahrefs rate-limit row in this app is RPM 60 / max
    # concurrent 4. Keep aligned so the probe doesn't crowd out
    # actual jobs.
    concurrency: int = Field(default=4, ge=1, le=10)
    # Independent SELECT toggles for /keywords-history (2026-05-17).
    # Split out so the operator can pick just one band — cuts cost_row
    # from 2 to 1 (matters at long ranges or fine groupings where
    # rows × cost_row exceeds the 50 floor).
    select_top4_10: bool = True
    select_top11_20: bool = True
    # /batch-analysis metric ids to fetch (subset of BATCH_METRICS keys).
    # Empty = skip the batch-analysis call entirely. At least one of
    # {KH bands, batch_metrics} must be non-empty or the endpoint 400s.
    batch_metrics: list[str] = Field(default_factory=list)


class KeywordsHistoryRow(BaseModel):
    """Single time bucket from the Ahrefs /keywords-history response."""
    date: str | None = None
    top11_20: int | None = None
    top4_10: int | None = None


class AhrefsBatchDomainResult(BaseModel):
    """Per-domain result + cost breakdown."""
    domain: str
    http_status: int
    cost_row: int | None = None
    cost_total: int | None = None
    cost_actual: int | None = None
    rows: list[KeywordsHistoryRow] = Field(default_factory=list)
    error: str = ""
    # Batch-analysis sub-result — populated only when batch_metrics is
    # non-empty. `batch` maps each requested field id → its value
    # (float for domain_rating, int for the rest, null if Ahrefs
    # omitted it). Cost lives in the aggregate totals, not per-domain,
    # because batch-analysis bills per batch call not per target.
    batch_http_status: int | None = None
    batch: dict[str, float | None] = Field(default_factory=dict)
    batch_error: str = ""


class AhrefsBatchToolOut(BaseModel):
    """Aggregate result + grand totals across all probed domains."""
    date_from: str
    date_to: str
    grouping: str
    # Echoed selected batch-analysis metric ids in canonical order so
    # the frontend can build columns without re-deriving the order.
    metrics: list[str] = Field(default_factory=list)
    results: list[AhrefsBatchDomainResult]
    totals: dict[str, int]


async def _probe_one(
    domain: str,
    date_from: str,
    date_to: str,
    grouping: str,
    select_fields: list[str],
    sem: asyncio.Semaphore,
    client: AhrefsClient,
) -> AhrefsBatchDomainResult:
    """One Ahrefs /keywords-history call per domain. Errors are returned
    in the result object (not raised) so a single bad domain doesn't fail
    the batch. `select_fields` is the user-trimmed list (date first)."""
    params = {
        "target": domain,
        "date_from": date_from,
        "date_to": date_to,
        "select": ",".join(select_fields),
        "history_grouping": grouping,
    }
    url = f"https://api.ahrefs.com/v3/site-explorer/keywords-history?{urlencode(params)}"
    async with sem:
        try:
            status, body, units = await client.fetch_url(url)
        except Exception as e:  # noqa: BLE001
            return AhrefsBatchDomainResult(
                domain=domain,
                http_status=0,
                error=f"{type(e).__name__}: {e}",
            )
    if status != 200:
        return AhrefsBatchDomainResult(
            domain=domain,
            http_status=status,
            cost_total=int(units.get("cost_total") or 0) or None,
            error=f"HTTP {status}",
        )
    body_json = body if isinstance(body, dict) else json.loads(body)
    raw_rows = body_json.get("keywords") if isinstance(body_json, dict) else None
    parsed_rows: list[KeywordsHistoryRow] = []
    if isinstance(raw_rows, list):
        for r in raw_rows:
            if isinstance(r, dict):
                parsed_rows.append(
                    KeywordsHistoryRow(
                        date=r.get("date") if isinstance(r.get("date"), str) else None,
                        top11_20=r.get("top11_20") if isinstance(r.get("top11_20"), int) else None,
                        top4_10=r.get("top4_10") if isinstance(r.get("top4_10"), int) else None,
                    )
                )
    return AhrefsBatchDomainResult(
        domain=domain,
        http_status=status,
        cost_row=int(units["cost_row"]) if units.get("cost_row") is not None else None,
        cost_total=int(units["cost_total"]) if units.get("cost_total") is not None else None,
        cost_actual=int(units["cost_actual"]) if units.get("cost_actual") is not None else None,
        rows=parsed_rows,
    )


async def _probe_batch_analysis(
    domains: list[str],
    select: list[str],
    sem: asyncio.Semaphore,
    client: AhrefsClient,
) -> tuple[dict[str, dict], dict[str, int]]:
    """Batched /batch-analysis call for the chosen current-snapshot
    metrics (`select` = subset of BATCH_METRICS keys). Thin adapter over
    the shared `providers.ahrefs_batch.fetch_batch_chunk` that keeps this
    ad-hoc probe's return shape: (map_by_domain, totals) where each map
    entry carries `batch_http_status`, a `batch` dict of {field_id:
    value}, and an optional `batch_error`."""
    from ..app_settings import get_provider_creds
    from ..providers.ahrefs_batch import (
        BATCH_SIZE,
        ChunkOutcome,
        fetch_batch_chunk,
    )

    api_key = get_provider_creds("ahrefs").get("api_key") or ""
    out_map: dict[str, dict] = {}
    totals = {"batch_list": 0, "batch_billed": 0, "batch_calls": 0}

    async def _one_batch(chunk: list[str]) -> None:
        async with sem:
            outcome: ChunkOutcome = await fetch_batch_chunk(
                client.client, api_key, chunk, select,
            )
        totals["batch_list"] += outcome.cost_list
        totals["batch_billed"] += outcome.cost_billed
        totals["batch_calls"] += 1
        if outcome.error:
            for d in chunk:
                out_map[d] = {
                    "batch_http_status": outcome.http_status,
                    "batch_error": outcome.error,
                }
            return
        for d in chunk:
            out_map[d] = {
                "batch_http_status": outcome.http_status,
                "batch": outcome.metrics_by_domain.get(d, {}),
            }

    chunks = [
        domains[i : i + BATCH_SIZE]
        for i in range(0, len(domains), BATCH_SIZE)
    ]
    await asyncio.gather(*(_one_batch(c) for c in chunks))
    return out_map, totals


@router.post("/ahrefs-batch-analysis", response_model=AhrefsBatchToolOut)
async def ahrefs_batch_analysis_tool(
    payload: AhrefsBatchToolIn,
) -> AhrefsBatchToolOut:
    """Bulk Ahrefs probe — Site-Explorer /keywords-history (one call per
    domain) and/or /batch-analysis (chunked POSTs) in parallel under a
    shared asyncio.Semaphore. Returns per-domain rows + batch metrics +
    cost breakdown + grand totals. No persistence; results are discarded
    after the response is sent."""
    days = _RANGE_DAYS.get(payload.date_range)
    if days is None:
        raise HTTPException(400, f"unknown date_range: {payload.date_range}")

    # Normalize + dedupe domains (lowercased + stripped, preserving
    # input order). Skip empties.
    seen: set[str] = set()
    domains: list[str] = []
    for raw in payload.domains:
        d = raw.strip().lower()
        if not d or d in seen:
            continue
        seen.add(d)
        domains.append(d)
    if not domains:
        raise HTTPException(400, "no valid domains after normalization")

    # Validate + canonicalize the requested batch-analysis metrics:
    # filter to the allowlist, in BATCH_METRICS declaration order, and
    # reject any unknown id so a frontend typo fails loud.
    unknown = [m for m in payload.batch_metrics if m not in BATCH_METRICS]
    if unknown:
        raise HTTPException(400, f"unknown batch_metrics: {', '.join(unknown)}")
    batch_select = [m for m in BATCH_METRICS if m in set(payload.batch_metrics)]

    include_kh = payload.select_top4_10 or payload.select_top11_20
    include_batch = len(batch_select) > 0
    if not include_kh and not include_batch:
        raise HTTPException(
            400,
            "enable at least one of select_top4_10 / select_top11_20 / "
            "batch_metrics",
        )

    # Build the /keywords-history SELECT dynamically — `date` always
    # included when KH is on so the timeline labels make sense.
    kh_select: list[str] = []
    if include_kh:
        kh_select.append("date")
        if payload.select_top4_10:
            kh_select.append("top4_10")
        if payload.select_top11_20:
            kh_select.append("top11_20")

    today = datetime.now(timezone.utc)
    date_to = today.strftime("%Y-%m-%d")
    date_from = (today - timedelta(days=days)).strftime("%Y-%m-%d")

    sem = asyncio.Semaphore(payload.concurrency)
    batch_totals = {"batch_list": 0, "batch_billed": 0, "batch_calls": 0}
    async with AhrefsClient() as client:
        # Both endpoints share the SAME semaphore so the operator's
        # concurrency setting bounds total in-flight Ahrefs calls,
        # not per-endpoint.
        if include_kh:
            results = await asyncio.gather(
                *(
                    _probe_one(
                        d, date_from, date_to,
                        payload.history_grouping, kh_select, sem, client,
                    )
                    for d in domains
                )
            )
        else:
            # Batch-only — synthesize "skipped" KH placeholders so the
            # response shape stays consistent. http_status=0 + error=""
            # means "not probed", distinct from a failure.
            results = [
                AhrefsBatchDomainResult(domain=d, http_status=0)
                for d in domains
            ]
        if include_batch:
            batch_map, batch_totals = await _probe_batch_analysis(
                domains, batch_select, sem, client,
            )
            for r in results:
                entry = batch_map.get(r.domain)
                if entry is not None:
                    for k, v in entry.items():
                        setattr(r, k, v)
                else:
                    # Domain didn't make it into any batch response.
                    r.batch_http_status = 0
                    r.batch_error = "no batch result returned"

    # Grand totals — list price = sum of per-domain KH cost_total +
    # batch-level list. Same for billed.
    kh_list = sum((r.cost_total or 0) for r in results)
    kh_billed = sum((r.cost_actual or 0) for r in results)
    total_list = kh_list + batch_totals["batch_list"]
    total_billed = kh_billed + batch_totals["batch_billed"]
    total_rows = sum(len(r.rows) for r in results)

    def _ok(r: AhrefsBatchDomainResult) -> bool:
        kh_ok = (not include_kh) or r.http_status == 200
        batch_ok = (not include_batch) or r.batch_http_status == 200
        return kh_ok and batch_ok
    successes = sum(1 for r in results if _ok(r))

    return AhrefsBatchToolOut(
        date_from=date_from,
        date_to=date_to,
        grouping=payload.history_grouping,
        metrics=batch_select,
        results=results,
        totals={
            "domains_total": len(results),
            "domains_ok": successes,
            "rows": total_rows,
            "cost_list_price": total_list,
            "cost_billed_actual": total_billed,
            # Cost split so the summary card can show "batch metrics were
            # batched at N units total across M batch calls" — much
            # cheaper than per-domain.
            "kh_cost_list": kh_list,
            "kh_cost_billed": kh_billed,
            "batch_cost_list": batch_totals["batch_list"],
            "batch_cost_billed": batch_totals["batch_billed"],
            "batch_calls": batch_totals["batch_calls"],
        },
    )


# --- Wayback Sparkline (bulk total-capture-count probe) -------------------
#
# Persistent flow because target scale is 100k domains/batch (~2-4h
# wall time at concurrency=8). Implementation lives in
# wayback_sparkline_runner.py; this section is just the HTTP shell.

# Cap chosen so a single user typo of "select 100k rows from a CSV"
# doesn't accidentally submit a 10-million-row request. 100k is the
# user-confirmed target; anything beyond should be split.
_SPARKLINE_MAX_DOMAINS_PER_JOB = 100_000

# Default + bounds for the per-job concurrency knob. Defaults match
# the rate-limit row in app_settings._RATE_LIMIT_DEFAULTS so the
# tool's "polite" defaults stay in one place.
#
# Calibrated 2026-05-23: original default of 8 hit 429s within the
# first 42 domains on a sample batch (Job 2 — 22/42 errored). 3 is
# the tested-good ceiling. The hard upper bound (16) is defensive —
# the rate-limit row in Settings is the real throttle, but capping
# the per-job knob prevents a typo from kicking off a 32-concurrent
# storm that the rate limiter has to slowly throttle down.
_SPARKLINE_CONCURRENCY_DEFAULT = 1
_SPARKLINE_CONCURRENCY_MAX = 16


class SparklineJobSubmitIn(BaseModel):
    domains: list[str] = Field(
        min_length=1, max_length=_SPARKLINE_MAX_DOMAINS_PER_JOB,
    )
    name: str | None = None
    notes: str | None = None
    # User-tunable concurrency (within bounds). The runner caps at the
    # rate-limit row's `max_concurrent` regardless — this is just the
    # ceiling the runner won't exceed; the rate limiter is the actual
    # throttle.
    concurrency: int = Field(
        default=_SPARKLINE_CONCURRENCY_DEFAULT,
        ge=1,
        le=_SPARKLINE_CONCURRENCY_MAX,
    )


class SparklineJobSubmitOut(BaseModel):
    job_id: int
    submitted: int
    deduped: int


@router.post("/wayback-sparkline", response_model=SparklineJobSubmitOut)
async def submit_sparkline_job(
    payload: SparklineJobSubmitIn,
    request: Request,
    db: Session = Depends(get_db),
) -> SparklineJobSubmitOut:
    """Create a sparkline job + per-domain result rows, then dispatch
    the runner. Returns job_id immediately — caller polls /status for
    progress.

    Input domains are normalized (lowercase, strip whitespace, strip
    https:// or http:// prefix, drop path) and deduped before the
    result rows are created. The runner is idempotent at the result-
    row level, but duplicate inputs would waste sparkline calls on
    the same host."""
    # Normalize + dedupe up-front so the result table has one row per
    # unique host. `cleaned` preserves input order for the UI display.
    cleaned: list[str] = []
    seen: set[str] = set()
    submitted = 0
    for raw in payload.domains:
        s = (raw or "").strip().lower()
        if not s:
            continue
        for prefix in ("https://", "http://"):
            if s.startswith(prefix):
                s = s[len(prefix):]
        s = s.split("/", 1)[0]
        if not s or s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
        submitted += 1
    if not cleaned:
        raise HTTPException(400, "no valid domains after normalization")
    deduped = len(payload.domains) - submitted

    # Best-effort source IP for audit. Behind Caddy this lands in
    # X-Forwarded-For; bare deploys see request.client.host.
    ip = (
        request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "")
    )

    job = WaybackSparklineJob(
        name=(payload.name or "").strip(),
        notes=(payload.notes or "").strip(),
        status="pending",
        submitted_count=submitted,
        concurrency=payload.concurrency,
        created_ip=ip,
    )
    db.add(job)
    db.flush()

    # Bulk-insert the result rows. SQLAlchemy's bulk_insert_mappings
    # bypasses ORM instance overhead — at 100k rows this matters
    # (single-instance INSERT loop is ~15s; bulk is ~0.5s).
    rows = [
        {"job_id": job.id, "domain": d, "status": "pending"}
        for d in cleaned
    ]
    db.bulk_insert_mappings(WaybackSparklineResult, rows)
    db.commit()

    # Dispatch the runner as a background task. Import here to avoid
    # a circular at module load (runner imports from .db / .models
    # which other routers also pull).
    from ..wayback_sparkline_runner import dispatch_sparkline_job
    dispatch_sparkline_job(job.id)

    return SparklineJobSubmitOut(
        job_id=job.id, submitted=submitted, deduped=deduped,
    )


class SparklineJobStatus(BaseModel):
    id: int
    name: str
    notes: str
    status: str
    error: str
    submitted_count: int
    concurrency: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    # Aggregated per-status counts across the result rows. Lets the UI
    # render a "X/N done · Y in flight · Z errors" header without
    # round-tripping all the rows.
    counts: dict[str, int]


@router.get("/wayback-sparkline", response_model=list[SparklineJobStatus])
def list_sparkline_jobs(
    db: Session = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[SparklineJobStatus]:
    """Most-recent-first list of sparkline jobs. Used by a future
    Tools index page; for now the FE goes directly to /{job_id}."""
    jobs = (
        db.query(WaybackSparklineJob)
        .order_by(WaybackSparklineJob.id.desc())
        .limit(limit)
        .all()
    )
    out: list[SparklineJobStatus] = []
    for j in jobs:
        out.append(_job_to_status(db, j))
    return out


@router.get("/wayback-sparkline/{job_id}", response_model=SparklineJobStatus)
def get_sparkline_job(
    job_id: int, db: Session = Depends(get_db),
) -> SparklineJobStatus:
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")
    return _job_to_status(db, job)


def _job_to_status(db: Session, job: WaybackSparklineJob) -> SparklineJobStatus:
    # GROUP BY status — single roundtrip aggregates the four buckets.
    rows = (
        db.query(
            WaybackSparklineResult.status,
            func.count(WaybackSparklineResult.id),
        )
        .filter(WaybackSparklineResult.job_id == job.id)
        .group_by(WaybackSparklineResult.status)
        .all()
    )
    counts = {"pending": 0, "fetching": 0, "ok": 0, "error": 0}
    for status, n in rows:
        counts[status] = int(n)
    return SparklineJobStatus(
        id=job.id,
        name=job.name or "",
        notes=job.notes or "",
        status=job.status,
        error=job.error or "",
        submitted_count=job.submitted_count,
        concurrency=job.concurrency,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        counts=counts,
    )


class SparklineResultRow(BaseModel):
    id: int
    domain: str
    status: str
    snapshot_count: int | None
    first_year: int | None
    last_year: int | None
    years_with_data: int | None
    error_msg: str
    elapsed_ms: int | None
    fetched_at: datetime | None


class SparklineResultsPage(BaseModel):
    rows: list[SparklineResultRow]
    total: int
    # Echoed page/page_size so the FE can sanity-check what it asked
    # for vs what got served (handy when the FE has stale pagination
    # state after a page-size change).
    page: int
    page_size: int


@router.get(
    "/wayback-sparkline/{job_id}/results",
    response_model=SparklineResultsPage,
)
def get_sparkline_results(
    job_id: int,
    db: Session = Depends(get_db),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=1000),
    q: str = Query(default=""),
    status: str = Query(default=""),
    sort: str = Query(
        default="domain_asc",
        description=(
            "domain_asc|domain_desc|count_asc|count_desc|"
            "first_asc|first_desc|last_asc|last_desc"
        ),
    ),
) -> SparklineResultsPage:
    """Paginated + searchable results for one sparkline job.

    `q` is a substring match against the domain column (lowered + LIKE
    with leading/trailing wildcards). Trivially indexed by the
    (job_id, domain) lookup; substring matches do a table scan within
    the job but at 100k rows it's still sub-second on SQLite.

    `status` filters to one of {pending, fetching, ok, error}; empty
    means all."""
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")

    base = db.query(WaybackSparklineResult).filter(
        WaybackSparklineResult.job_id == job_id,
    )
    if q:
        like = f"%{q.strip().lower()}%"
        base = base.filter(WaybackSparklineResult.domain.like(like))
    if status:
        if status not in ("pending", "fetching", "ok", "error"):
            raise HTTPException(400, "invalid status filter")
        base = base.filter(WaybackSparklineResult.status == status)

    total = base.count()

    # Server-side sorts. Snapshot-count desc is the most useful default
    # for drop hunters (find the highest-history domains first), but
    # we leave domain_asc as the API default so paged loads are
    # deterministic when the operator hasn't picked a sort yet.
    sort_map = {
        "domain_asc": WaybackSparklineResult.domain.asc(),
        "domain_desc": WaybackSparklineResult.domain.desc(),
        "count_asc": WaybackSparklineResult.snapshot_count.asc(),
        "count_desc": WaybackSparklineResult.snapshot_count.desc(),
        "first_asc": WaybackSparklineResult.first_year.asc(),
        "first_desc": WaybackSparklineResult.first_year.desc(),
        "last_asc": WaybackSparklineResult.last_year.asc(),
        "last_desc": WaybackSparklineResult.last_year.desc(),
    }
    order = sort_map.get(sort)
    if order is None:
        raise HTTPException(400, f"unknown sort: {sort}")
    base = base.order_by(order, WaybackSparklineResult.id.asc())

    offset = (page - 1) * page_size
    rows = base.offset(offset).limit(page_size).all()

    return SparklineResultsPage(
        rows=[
            SparklineResultRow(
                id=r.id,
                domain=r.domain,
                status=r.status,
                snapshot_count=r.snapshot_count,
                first_year=r.first_year,
                last_year=r.last_year,
                years_with_data=r.years_with_data,
                error_msg=r.error_msg or "",
                elapsed_ms=r.elapsed_ms,
                fetched_at=r.fetched_at,
            )
            for r in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


# `async def` on every route that dispatches a background task —
# `asyncio.create_task()` (used inside `dispatch_sparkline_job`)
# requires a running event loop, and FastAPI only runs sync routes
# inside the anyio threadpool where no loop is active. The first
# attempt at /resume was sync; it failed with "no running event loop"
# the first time a user hit Resume (Job 2, 2026-05-23). Pause +
# cancel get the same treatment for consistency, even though they
# don't strictly need it today, so a future change that adds a
# dispatch step doesn't reintroduce the same bug.
@router.post("/wayback-sparkline/{job_id}/pause")
async def pause_sparkline_job_route(
    job_id: int, db: Session = Depends(get_db),
) -> dict:
    from ..wayback_sparkline_runner import pause_sparkline_job as _pause
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")
    if job.status not in ("pending", "running"):
        return {"id": job_id, "status": job.status, "no_op": True}
    _pause(job_id)
    # Mark paused immediately so the UI reflects intent; the worker
    # will finish its current in-flight domain and exit.
    job.status = "paused"
    db.commit()
    return {"id": job_id, "status": "paused"}


@router.post("/wayback-sparkline/{job_id}/resume")
async def resume_sparkline_job_route(
    job_id: int, db: Session = Depends(get_db),
) -> dict:
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")
    if job.status != "paused":
        raise HTTPException(400, f"not paused (status={job.status})")
    # Reset any 'fetching' rows back to pending — they were mid-flight
    # when pause hit and got abandoned. Same idempotency contract the
    # runner expects: it only picks up pending rows.
    db.query(WaybackSparklineResult).filter(
        WaybackSparklineResult.job_id == job_id,
        WaybackSparklineResult.status == "fetching",
    ).update({"status": "pending"})
    # NOTE (2026-05-23): we deliberately do NOT auto-clear `error`
    # rows on resume. An earlier version did, on the theory that 429s
    # are transient — but archive.org has both transient (rolling
    # window) AND persistent (per-URL block) 429s. Auto-retry caused
    # workers to keep slamming into the persistent-block rows on
    # every resume, blocking forward progress on the rest of the
    # queue. If the operator wants to retry errored rows after a
    # cooldown, they can call /retry-failed (a separate endpoint,
    # added when there's user demand).
    job.status = "pending"
    job.started_at = None
    job.finished_at = None
    job.error = ""
    db.commit()
    from ..wayback_sparkline_runner import dispatch_sparkline_job
    dispatch_sparkline_job(job_id)
    return {"id": job_id, "status": "pending"}


@router.post("/wayback-sparkline/{job_id}/cancel")
async def cancel_sparkline_job_route(
    job_id: int, db: Session = Depends(get_db),
) -> dict:
    from ..wayback_sparkline_runner import cancel_sparkline_job as _cancel
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")
    if job.status in ("done", "failed", "canceled"):
        return {"id": job_id, "status": job.status, "no_op": True}
    _cancel(job_id)
    job.status = "canceled"
    job.finished_at = datetime.utcnow()
    db.commit()
    return {"id": job_id, "status": "canceled"}


@router.delete("/wayback-sparkline/{job_id}")
def delete_sparkline_job(
    job_id: int, db: Session = Depends(get_db),
) -> dict:
    job = db.get(WaybackSparklineJob, job_id)
    if job is None:
        raise HTTPException(404, "sparkline job not found")
    # Cascade-delete the result rows. WaybackSparklineResult declares
    # ondelete=CASCADE on the FK + cascade="all, delete-orphan" on the
    # relationship, so a single delete on the parent clears both. At
    # 100k rows the cascade can take a few seconds on SQLite — fine
    # for a one-off cleanup.
    db.delete(job)
    db.commit()
    return {"id": job_id, "deleted": True}
