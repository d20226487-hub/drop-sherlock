"""Jobs / runs endpoints.

Job-level actions (rename, notes, delete, rerun) and the run-domain detail
endpoint live here. The Analyze submit endpoint stays in routers/analyze.py
since it's part of the analyze-flow surface."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import (
    and_,
    bindparam,
    case,
    func as sqla_func,
    literal,
    or_,
    select,
    text,
)
from sqlalchemy.orm import Session, aliased, selectinload

from ..db import SessionLocal, get_db
from ..models import (
    CriterionResult,
    DomainNote,
    Job,
    JobCriterionPin,
    Run,
    RunDomain,
)
from ..schemas import AnalyzeSpec
from ..tasks import cancel_run_now, dispatch_run, pause_run_now, resume_run_now

log = logging.getLogger(__name__)

router = APIRouter(prefix="/jobs", tags=["jobs"])
runs_router = APIRouter(prefix="/runs", tags=["runs"])
run_domains_router = APIRouter(prefix="/run-domains", tags=["run-domains"])


# --- Schemas (response shapes) ----------------------------------------------

class RunSummary(BaseModel):
    id: int
    name: str = ""
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str
    total_domains: int
    done_domains: int
    failed_domains: int
    # True when this Run is the pinned canonical run for its Job.
    # At most one run per job. Drives the Job-page rollup pills' source.
    is_pinned: bool = False


class JobDetail(BaseModel):
    id: int
    name: str
    notes: str
    # Pillar discriminator (added Wave 1, 2026-05-15). Drives which
    # /jobs/<pillar> page the JobDetail will be rendered on; null/empty
    # is treated as 'quality' on the frontend for pre-wave rows that
    # somehow slipped past the backfill.
    kind: str
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None
    runs: list[RunSummary]
    # Verdict roll-up across one of this job's runs' domains.
    # Keys: good / mixed / low_quality / partial / no_verdict.
    # Source-of-truth rule (added 2026-05-10):
    #   - If a run is PINNED in this job, counts come from that run.
    #   - Otherwise (no pinned run), counts come from the LATEST run
    #     (max(Run.id)) — preserves the legacy behavior.
    # Empty dict when the job has no runs yet.
    latest_run_verdict_counts: dict[str, int] = {}
    # The run id those counts came from (or null when no runs exist).
    # Distinct from `pinned_run_id` so the UI can render a label like
    # "Pinned: Run #N" vs "Latest: Run #N" depending on the source.
    latest_run_id: int | None = None
    # The pinned run for this job (or null when no pin is set). When
    # non-null, `latest_run_verdict_counts` was sourced from this run.
    pinned_run_id: int | None = None


class RunDomainProgress(BaseModel):
    id: int
    domain: str
    status: str
    error: str
    started_at: datetime | None
    finished_at: datetime | None
    last_analyzed_at: datetime | None
    criteria: dict[str, str]  # criterion -> fetch status
    # Per-criterion AI verdict status. Values: "done" | "failed" | "pending"
    # | absent. Distinct from `criteria` (which is the FETCH status) — a
    # criterion can fetch successfully and still have its AI step fail
    # (e.g. provider rate-limit). The run-page domain table renders this
    # as the "AI Wayback" + "AI Ahrefs (B D A K)" columns so AI failures
    # are visible without drilling into each domain.
    ai_status: dict[str, str] = {}
    # Verdict-level AI provenance: who actually produced THIS domain's
    # final assessment (may differ from run.spec.ai after reanalyze).
    # Empty string when no final has landed yet.
    ai_provider: str = ""
    ai_model: str = ""
    # Final score / bucket / confidence pulled out of final_assessment_json
    # so the run-page domain table can render the score-aware pill without
    # a per-row JSON fetch.
    final_score: float | None = None
    final_confidence: float | None = None
    final_bucket: str = ""
    # True when this domain produced verdicts for some-but-not-all enabled
    # criteria. Frontend swaps the score pill for a "partial" badge.
    final_partial: bool = False
    # True when this RunDomain is the currently-pinned definitive source
    # for its domain on the Database page. Per-domain header reads this
    # to label the Pin button as Pinned ★ / Replace pin / Pin.
    is_pinned: bool = False
    # True while ANY in-flight reanalyze (per-domain, per-criterion, or a
    # batched retry-failed) is touching this RD. Distinct from the run-
    # level `RunStatus.reanalyzing` which only reflects `_REANALYZING_RUNS`
    # (the run-wide reanalyze path). Surfaced so the run-page table can
    # show per-row progress and the Retry button can disable itself + show
    # "Retrying X of Y" while a retry batch drains.
    reanalyzing: bool = False
    # wayback_classify outputs (added 2026-05-09) — sourced from THIS rd's
    # wayback_classify CR's ai_verdict_json. Empty when the criterion is
    # disabled / hasn't run / failed for this rd. Same fields as the
    # Database row's classify columns so the table renders identically.
    primary_language: str = ""
    secondary_languages: list[str] = []
    language_confidence: float | None = None
    primary_theme: str = ""
    secondary_themes: list[str] = []
    theme_confidence: float | None = None
    classify_drift_detected: bool = False
    category: str = ""
    category_confidence: float | None = None
    category_was: str = ""
    # Wayback CDX row count for THIS rd. `None` when the wayback criterion
    # isn't on this rd at all (older runs, or wayback disabled in spec) OR
    # when the fetch hasn't reached status=done yet (pending/running/failed).
    # `0` means wayback ran cleanly and archive.org returned no snapshots —
    # the signal the Run-page filter targets, since 0 CDX rows guarantees
    # V2 sampling + wayback_classify will also have nothing to work with.
    wayback_rows: int | None = None
    # Availability verdict status for THIS rd's availability CR
    # (2026-05-16). One of "available"/"registered"/"unknown"/"error" or
    # empty when no availability CR exists on this rd / data_json is
    # malformed. Sourced from `cr.data_json.verdict.status`, the SAME
    # field the Job-page chip math reads. Drives the Run-page
    # Availability filter dropdown for availability-pillar runs.
    availability_status: str = ""
    # Ahrefs batch-analysis metrics for THIS rd's ahrefs_batch_analysis CR
    # (2026-06-02). {field_id: value|None} pulled from the latest CR's
    # data_json.metrics; empty when no CR / malformed / not this kind.
    # Drives the Run-page metric columns for ahrefs_batch_analysis runs.
    batch_metrics: dict[str, float | None] = {}


class RunDetail(BaseModel):
    id: int
    name: str = ""
    job_id: int
    job_name: str
    # Pillar discriminator (Wave 2b, 2026-05-15) — surfaced here so the
    # Run page can hide Quality-only controls (Score Weights panel,
    # Wayback CDX filter) when the parent job is whois_history or
    # availability. Defaults to 'quality' for pre-Wave-1 rows.
    job_kind: str = "quality"
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str
    spec_json: str
    domains: list[RunDomainProgress]
    # Server-side pagination support (added 2026-05-16). `domains` above
    # carries only the slice for the requested `offset/limit`; the
    # frontend uses `total_count` to render the pagination footer and
    # `filtered_count` (post-status-filter) to drive the page count.
    # Pre-pagination callers leave the defaults (page=1, large limit) and
    # see the same numbers, so existing tests + integrations keep working.
    total_count: int = 0
    filtered_count: int = 0
    # archive.org upstream-error breakdown for this run (added 2026-08-11).
    # Lets the operator see at a glance whether a disappointing Wayback run was
    # their config or the Internet Archive having a bad day -- during the
    # 2026-08-11 outage every snapshot returned a 503 maintenance page, which
    # previously looked like ordinary per-domain failure. Keys:
    # archive_offline / http_503 / http_429 / network / total / domains.
    wayback_upstream: dict[str, int] = {}
    # Run-wide aggregates (added 2026-06-14) for the server-paginated Run
    # page (availability / ahrefs_batch_analysis): in server mode the
    # frontend no longer holds every domain in memory, so it can't compute
    # these by scanning `domains`. All three are RUN-WIDE (ignore the
    # offset/limit/status/domain filters) so they match what the
    # client-side full-set scan produced before.
    #   last_analyzed_at_max — newest last_analyzed_at across the run
    #     (header "last analyzed" badge).
    #   failed_domains / failed_criteria — mirror the frontend `failedCount`
    #     scan (CR.status='failed' + CR.ai_verdict_error) used by the
    #     "Retry Failed" button label / enabled state.
    last_analyzed_at_max: datetime | None = None
    failed_domains: int = 0
    failed_criteria: int = 0
    # Per-run scoring override (added 2026-05-13 wave J). None = run uses
    # global Settings weights; dict = {"weights": {<criterion>: <float>}}
    # with the override that was last applied via the recompute endpoints.
    # The UI's "Score weights" panel pre-fills from this so reopening the
    # Run page after an apply shows the active weights, not the global
    # defaults.
    scoring_override: dict | None = None


class RunStatus(BaseModel):
    id: int
    status: str
    total: int
    pending: int
    running: int
    done: int
    failed: int
    # True while a Reanalyze (AI re-judge) task is in flight for this run.
    # The run's status stays "done" — reanalyze doesn't reset it.
    reanalyzing: bool = False


# Per-domain slice surfaced by the slim /runs/{id}/progress endpoint
# (added 2026-05-14). Carries ONLY the fields that change every tick
# during a run — no JSON parsing of `ai_verdict_json`, no walks of
# `final_assessment_json`, no extraction of wayback_classify
# language/theme/category fields. The full /runs/{id} payload remains
# for mount / focus / explicit reload; the polling loop reads progress
# instead, drops per-tick server CPU + wire bytes by ~30–40% at 1k+
# domains, and the Run page detects transitions in this payload to
# trigger an opportunistic full refresh when a domain reaches a new
# state (so the expensive columns stay current without being computed
# on every tick).
class RunDomainProgressSlim(BaseModel):
    id: int
    status: str
    # Per-criterion fetch status. CR.status is a short enum string;
    # cheap to ship.
    criteria: dict[str, str] = Field(default_factory=dict)
    # Per-criterion AI status derived from CR.ai_verdict_json presence
    # + CR.ai_verdict_error. Same enum shape as the full endpoint's
    # ai_status (done / failed / pending) but computed without parsing
    # the verdict body — only the existence-test matters here.
    ai_status: dict[str, str] = Field(default_factory=dict)
    reanalyzing: bool = False
    # Drives the frontend's "new data just landed" transition detector
    # — when this changes, the page fires a full /runs/{id} fetch so
    # the expensive columns (language / theme / category / final score)
    # refresh. The value itself is a cheap DATETIME column read.
    last_analyzed_at: datetime | None = None
    # Mirror of `RunDomainProgress.availability_status` (2026-05-16) so
    # the slim polling tick keeps the Availability filter source field
    # populated. Cheap: same data_json.verdict.status read the chip uses.
    availability_status: str = ""


class RunProgress(BaseModel):
    run_id: int
    status: str
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str = ""
    # `counts` is run-wide (always reflects every domain in the run,
    # independent of the requested page). Drives the progress bar in the
    # Run page header.
    counts: dict[str, int] = Field(default_factory=dict)
    domains: list[RunDomainProgressSlim] = Field(default_factory=list)
    # Server-side pagination (added 2026-05-16). `domains` is the slice
    # for the requested offset/limit; `total_count` is the run-wide
    # count and `filtered_count` is the post-status-filter count for
    # rendering the page footer.
    total_count: int = 0
    filtered_count: int = 0
    # Run-level reanalyze flag (added 2026-05-16). Was previously
    # derived in the frontend by OR'ing per-domain `reanalyzing` flags;
    # with paginated payloads the FE no longer sees every domain, so
    # the backend now reports the run-level signal directly.
    reanalyzing: bool = False


# --- Helpers ----------------------------------------------------------------

def _summarize_run(run: Run) -> RunSummary:
    """Per-run summary. ONLY use this for small jobs (≤ few hundred
    domains) or when you've already loaded `run.domains`. For large
    jobs, call `_batch_summarize_runs` instead — that one fetches all
    run-status counts in a single GROUP BY and avoids the O(N) walk.
    Kept here for the handful of callers that pass a single Run with
    pre-loaded domains (e.g. /runs/{id}/pin response builder)."""
    total = len(run.domains)
    done = sum(1 for d in run.domains if d.status == "done")
    failed = sum(1 for d in run.domains if d.status == "failed")
    return RunSummary(
        id=run.id,
        name=run.name or "",
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error=run.error,
        total_domains=total,
        done_domains=done,
        failed_domains=failed,
        is_pinned=bool(run.is_pinned),
    )


def _batch_summarize_runs(db: Session, runs: list[Run]) -> list[RunSummary]:
    """SQL-batched version of `_summarize_run` for use on the /jobs/{id}
    page. One GROUP BY query returns (run_id, status, count) for every
    run; we then build RunSummary objects from the small in-memory
    aggregate. Replaces the previous O(N domains) Python loop that
    timed out on 100k-domain runs (the user's /jobs/57 freeze, 2026-05-16).

    Preserves response shape exactly — same field set as _summarize_run."""
    if not runs:
        return []
    run_ids = [r.id for r in runs]
    rows = db.execute(
        text(
            "SELECT run_id, status, COUNT(*) AS cnt "
            "FROM run_domains "
            "WHERE run_id IN :run_ids "
            "GROUP BY run_id, status"
        ).bindparams(bindparam("run_ids", expanding=True)),
        {"run_ids": run_ids},
    ).all()
    # run_id -> status -> cnt
    by_run: dict[int, dict[str, int]] = {}
    for run_id, status, cnt in rows:
        by_run.setdefault(run_id, {})[status or ""] = int(cnt)
    out: list[RunSummary] = []
    for r in runs:
        statuses = by_run.get(r.id, {})
        out.append(RunSummary(
            id=r.id,
            name=r.name or "",
            status=r.status,
            started_at=r.started_at,
            finished_at=r.finished_at,
            error=r.error,
            total_domains=sum(statuses.values()),
            done_domains=statuses.get("done", 0),
            failed_domains=statuses.get("failed", 0),
            is_pinned=bool(r.is_pinned),
        ))
    return out


def _bucket_counts_for_run(
    db: Session,
    run: Run,
    *,
    kind: str,
    good_threshold: float,
    mixed_threshold: float,
) -> dict[str, int]:
    """Aggregate verdict-bucket counts for one Run via a single SQL
    query. Replaces the per-domain Python loop in get_job that walked
    `run.domains` and json.loads()'d every verdict — a pattern that
    timed out at 10k+ domains.

    Pillar-specific:
      • availability — bucketed off `data_json.verdict.status` on the
        availability CR.
      • whois_history — bucketed off `ai_verdict_json.dropped_confidence`
        on the whois_history CR, with the same thresholds the per-
        domain view uses (>0.80 low_quality, >0.50 mixed, ≥0.30
        no_verdict, <0.30 good).
      • quality (default) — bucketed off RunDomain.final_assessment_json's
        `partial` flag + `final` field (numeric score against the
        configurable good/mixed thresholds, or label-string fallback).

    Bucket keys: good / mixed / low_quality / partial / no_verdict —
    same vocabulary as the old Python path. Zero-count buckets are
    omitted so callers can `.get(key, 0)` freely."""
    # Malformed-JSON guard: SQLite's `json_extract` raises on invalid
    # input — the legacy Python path caught these via try/except, so a
    # naked json_extract here would 500 on rows that the old code
    # treated as "no verdict". Every json_extract call below is wrapped
    # in a `json_valid()` check that falls through to the no-verdict
    # branch when the JSON is unparseable. Cheap (SQLite parses once
    # and short-circuits the CASE).
    # Each pillar joins to the LATEST CR per (rd, criterion) so duplicate
    # CR rows on the same RD don't inflate the bucket counts. Production
    # data on run 99 had 616 RDs with 3 CRs each (availability runner
    # creates a fresh CR on every invocation; resume-after-restart paths
    # re-invoke for already-done RDs, leaving duplicates). Counting raw
    # JOIN rows gave 2317 for a 1000-domain run. The subselect picks the
    # newest CR id per RD via correlated lookup — indexes on
    # criterion_results.run_domain_id make it O(log N) per RD.
    if kind == "availability":
        # Split `unknown` and `error` into distinct buckets (2026-05-16):
        # they're different operator states. `unknown` = cascade ran to
        # completion but no provider could conclusively classify the
        # domain (e.g., RDAP returned ambiguous data for .kz) — final,
        # no retry helps. `error` = cascade itself failed (rate limits,
        # network, all providers down) — retryable. Lumping them under
        # `no_verdict` (pre-2026-05-16) hid which subset of "не
        # determined" rows the user could profitably re-run. `no_verdict`
        # now only catches truly anomalous rows (cr missing, status
        # 'failed' at the runner level, malformed data_json) — typically
        # zero in practice.
        sql = text("""
            SELECT
              CASE
                WHEN cr.id IS NULL THEN 'no_verdict'
                WHEN cr.status = 'failed' THEN 'no_verdict'
                WHEN cr.data_json IS NULL OR cr.data_json = '' THEN 'no_verdict'
                WHEN NOT json_valid(cr.data_json) THEN 'no_verdict'
                WHEN json_extract(cr.data_json, '$.verdict.status') = 'available' THEN 'good'
                WHEN json_extract(cr.data_json, '$.verdict.status') = 'registered' THEN 'mixed'
                WHEN json_extract(cr.data_json, '$.verdict.status') = 'not_supported' THEN 'not_supported'
                WHEN json_extract(cr.data_json, '$.verdict.status') = 'unknown' THEN 'unknown'
                WHEN json_extract(cr.data_json, '$.verdict.status') = 'error' THEN 'error'
                ELSE 'no_verdict'
              END AS bucket,
              COUNT(*) AS cnt
            FROM run_domains rd
            LEFT JOIN criterion_results cr ON cr.id = (
              SELECT cr2.id FROM criterion_results cr2
              WHERE cr2.run_domain_id = rd.id
                AND cr2.criterion = 'availability'
              ORDER BY cr2.id DESC
              LIMIT 1
            )
            WHERE rd.run_id = :run_id
            GROUP BY bucket
        """)
        rows = db.execute(sql, {"run_id": run.id}).all()
    elif kind == "whois_history":
        # Same latest-CR-per-RD trick as availability. Whois history is
        # less likely to accumulate duplicates today (the retry path
        # explicitly deletes the old CR before re-fetching, 2026-05-16),
        # but the SQL stays robust against future paths that don't.
        sql = text("""
            SELECT
              CASE
                WHEN cr.id IS NULL THEN 'no_verdict'
                WHEN cr.status = 'failed' THEN 'no_verdict'
                WHEN cr.ai_verdict_json IS NULL OR cr.ai_verdict_json = '' THEN 'no_verdict'
                WHEN NOT json_valid(cr.ai_verdict_json) THEN 'no_verdict'
                WHEN json_extract(cr.ai_verdict_json, '$.dropped_confidence') IS NULL THEN 'no_verdict'
                WHEN CAST(json_extract(cr.ai_verdict_json, '$.dropped_confidence') AS REAL) > 0.80 THEN 'low_quality'
                WHEN CAST(json_extract(cr.ai_verdict_json, '$.dropped_confidence') AS REAL) > 0.50 THEN 'mixed'
                WHEN CAST(json_extract(cr.ai_verdict_json, '$.dropped_confidence') AS REAL) >= 0.30 THEN 'no_verdict'
                ELSE 'good'
              END AS bucket,
              COUNT(*) AS cnt
            FROM run_domains rd
            LEFT JOIN criterion_results cr ON cr.id = (
              SELECT cr2.id FROM criterion_results cr2
              WHERE cr2.run_domain_id = rd.id
                AND cr2.criterion = 'whois_history'
              ORDER BY cr2.id DESC
              LIMIT 1
            )
            WHERE rd.run_id = :run_id
            GROUP BY bucket
        """)
        rows = db.execute(sql, {"run_id": run.id}).all()
    elif kind == "ahrefs_batch_analysis":
        # Metrics-only pillar — no AI verdict. Bucket purely on the CR's
        # fetch status: done → 'good' (metrics in hand), failed → 'error'
        # (chunk rejected / HTTP error, retryable), anything else (missing
        # CR, runner-level failed, still pending) → 'no_verdict'. Same
        # latest-CR-per-RD trick as the other pillars guards against
        # resume-path duplicates.
        sql = text("""
            SELECT
              CASE
                WHEN cr.id IS NULL THEN 'no_verdict'
                WHEN cr.status = 'done' THEN 'good'
                WHEN cr.status = 'failed' THEN 'error'
                ELSE 'no_verdict'
              END AS bucket,
              COUNT(*) AS cnt
            FROM run_domains rd
            LEFT JOIN criterion_results cr ON cr.id = (
              SELECT cr2.id FROM criterion_results cr2
              WHERE cr2.run_domain_id = rd.id
                AND cr2.criterion = 'ahrefs_batch_analysis'
              ORDER BY cr2.id DESC
              LIMIT 1
            )
            WHERE rd.run_id = :run_id
            GROUP BY bucket
        """)
        rows = db.execute(sql, {"run_id": run.id}).all()
    else:
        # Quality. The bucket logic mirrors _bucket_for in
        # routers/database.py: prefer numeric final.final against the
        # configured good/mixed thresholds, else match a text label in
        # final.final or final_summary, else no_verdict.
        sql = text("""
            SELECT
              CASE
                WHEN rd.final_assessment_json IS NULL OR rd.final_assessment_json = '' THEN
                  CASE LOWER(TRIM(COALESCE(rd.final_summary, '')))
                    WHEN 'good' THEN 'good'
                    WHEN 'quality' THEN 'good'
                    WHEN 'high_quality' THEN 'good'
                    WHEN 'mixed' THEN 'mixed'
                    WHEN 'low_quality' THEN 'low_quality'
                    WHEN 'low' THEN 'low_quality'
                    ELSE 'no_verdict'
                  END
                WHEN NOT json_valid(rd.final_assessment_json) THEN
                  CASE LOWER(TRIM(COALESCE(rd.final_summary, '')))
                    WHEN 'good' THEN 'good'
                    WHEN 'quality' THEN 'good'
                    WHEN 'high_quality' THEN 'good'
                    WHEN 'mixed' THEN 'mixed'
                    WHEN 'low_quality' THEN 'low_quality'
                    WHEN 'low' THEN 'low_quality'
                    ELSE 'no_verdict'
                  END
                WHEN json_extract(rd.final_assessment_json, '$.partial') = 1 THEN 'partial'
                WHEN typeof(json_extract(rd.final_assessment_json, '$.final')) IN ('integer','real') THEN
                  CASE
                    WHEN CAST(json_extract(rd.final_assessment_json, '$.final') AS REAL) >= :good_t THEN 'good'
                    WHEN CAST(json_extract(rd.final_assessment_json, '$.final') AS REAL) >= :mixed_t THEN 'mixed'
                    ELSE 'low_quality'
                  END
                ELSE
                  CASE LOWER(TRIM(COALESCE(json_extract(rd.final_assessment_json, '$.final'), rd.final_summary, '')))
                    WHEN 'good' THEN 'good'
                    WHEN 'quality' THEN 'good'
                    WHEN 'high_quality' THEN 'good'
                    WHEN 'mixed' THEN 'mixed'
                    WHEN 'low_quality' THEN 'low_quality'
                    WHEN 'low' THEN 'low_quality'
                    ELSE 'no_verdict'
                  END
              END AS bucket,
              COUNT(rd.id) AS cnt
            FROM run_domains rd
            WHERE rd.run_id = :run_id
            GROUP BY bucket
        """)
        rows = db.execute(sql, {
            "run_id": run.id,
            "good_t": good_threshold,
            "mixed_t": mixed_threshold,
        }).all()
    return {bucket: int(cnt) for bucket, cnt in rows if bucket}


# Short-TTL cache for the per-run verdict roll-up. The Job page polls
# /jobs/{id} every few seconds while a run is live, and each call ran the
# O(domains) GROUP BY above — ~1s on a 60k-domain availability run, and it
# stacked badly across the poll herd + concurrent tabs. The roll-up only
# needs to feel live, not be exact-to-the-second, so we memoize it for a
# few seconds. Keyed by (run_id, run.status, thresholds) so a status
# transition (running → done) busts the cache and shows final counts at
# once; a terminal run's counts never change so the stale window is moot.
import time as _time  # noqa: E402

_BUCKET_CACHE_TTL = 8.0
_bucket_counts_cache: dict[tuple, tuple[float, dict]] = {}


def _bucket_counts_cached(
    db: Session,
    run: Run,
    *,
    kind: str,
    good_threshold: float,
    mixed_threshold: float,
) -> dict:
    key = (run.id, run.status, kind, good_threshold, mixed_threshold)
    now = _time.monotonic()
    hit = _bucket_counts_cache.get(key)
    if hit is not None and now - hit[0] < _BUCKET_CACHE_TTL:
        return hit[1]
    counts = _bucket_counts_for_run(
        db, run,
        kind=kind,
        good_threshold=good_threshold,
        mixed_threshold=mixed_threshold,
    )
    # Bound the dict so a long-lived process that has viewed many jobs
    # doesn't grow it without limit (each run leaves ≤ a couple of keys).
    if len(_bucket_counts_cache) > 512:
        _bucket_counts_cache.clear()
    _bucket_counts_cache[key] = (now, counts)
    return counts


# --- Job endpoints ----------------------------------------------------------

@router.get("/")
def list_jobs(
    archived: str = "active",
    kind: str = "quality",
    db: Session = Depends(get_db),
) -> dict:
    """List jobs.

    `archived` filter:
    - "active" (default): only jobs with archived_at IS NULL
    - "archived": only archived jobs
    - "all": both

    `kind` filter (added Wave 1, 2026-05-15):
    - "quality" (default): Wayback+Ahrefs analysis jobs — the legacy
      pillar; default so pre-wave callers keep their behavior.
    - "availability": domain-availability cascade jobs (Wave 3)
    - "whois_history": historical-WHOIS drop-detection jobs (Wave 2)
    - "ahrefs_batch_analysis": bulk Ahrefs /batch-analysis metric jobs
    - "all": ignore the kind filter (admin / debug)
    """
    q = db.query(Job)
    if archived == "active":
        q = q.filter(Job.archived_at.is_(None))
    elif archived == "archived":
        q = q.filter(Job.archived_at.is_not(None))
    elif archived != "all":
        raise HTTPException(400, "archived must be one of: active, archived, all")
    if kind not in (
        "quality", "availability", "whois_history",
        "ahrefs_batch_analysis", "all",
    ):
        raise HTTPException(
            400,
            "kind must be one of: quality, availability, whois_history, "
            "ahrefs_batch_analysis, all",
        )
    if kind != "all":
        q = q.filter(Job.kind == kind)
    rows = q.order_by(Job.id.desc()).limit(500).all()
    return {
        "jobs": [
            {
                "id": j.id,
                "name": j.name,
                "notes": j.notes,
                "kind": j.kind,
                "created_at": j.created_at.isoformat(),
                "updated_at": j.updated_at.isoformat(),
                "archived_at": j.archived_at.isoformat() if j.archived_at else None,
                "run_count": len(j.runs),
            }
            for j in rows
        ]
    }


@router.get("/{job_id}", response_model=JobDetail)
def get_job(job_id: int, db: Session = Depends(get_db)) -> JobDetail:
    """Job detail with per-run summaries + verdict roll-up.

    Performance: every aggregate here is computed via SQL GROUP BY
    instead of walking `job.runs` × `run.domains` in Python. The
    earlier loop-based version timed out at 100k+ domains
    (incident 2026-05-16, /jobs/57 — the user's "all pages froze"
    report). Each large-scan endpoint now scales O(buckets), not
    O(domains)."""
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    # Source-of-truth rule: if the user pinned a run for this job,
    # count from that run; else fall back to the latest run (max(Run.id),
    # chronological since runs are insertion-ordered). The pin pattern
    # mirrors per-domain pinning: at most one run per job is pinned.
    from ..app_settings import get_scoring_config
    sc = get_scoring_config()
    good_t = sc["good_threshold"]
    mixed_t = sc["mixed_threshold"]
    pinned_run = next((r for r in job.runs if r.is_pinned), None)
    latest_run = max(job.runs, key=lambda r: r.id) if job.runs else None
    # `source_run` drives the pill counts; `latest_run_id` reports back
    # whichever run was actually used so the UI can render an accurate
    # "Pinned: Run #N" / "Latest: Run #N" label.
    source_run = pinned_run or latest_run
    counts: dict[str, int] = {}
    if source_run is not None:
        counts = _bucket_counts_cached(
            db, source_run,
            kind=(job.kind or "quality"),
            good_threshold=good_t,
            mixed_threshold=mixed_t,
        )
    return JobDetail(
        id=job.id,
        name=job.name,
        notes=job.notes,
        kind=job.kind or "quality",
        created_at=job.created_at,
        updated_at=job.updated_at,
        archived_at=job.archived_at,
        runs=_batch_summarize_runs(db, list(job.runs)),
        latest_run_verdict_counts=counts,
        latest_run_id=source_run.id if source_run else None,
        pinned_run_id=pinned_run.id if pinned_run else None,
    )


@router.get("/{job_id}/spec")
def get_job_spec(job_id: int, db: Session = Depends(get_db)) -> dict:
    """The latest AnalyzeSpec for this job — used by the Analyze page to
    prefill the form when rerunning.

    Domains source (2026-05-21 fix): the union of every RunDomain ever
    created under this Job, NOT just `Job.spec_json.domains`. The
    `/jobs/{id}/rerun` endpoint overwrites `Job.spec_json` with each
    rerun's curated subset (so the latest criteria + ai settings stick
    on the next prefill), which silently lost the original full domain
    list if the user ever re-ran with a narrower selection. Reading
    domains from the RunDomain table makes prefill always show every
    domain this Job has analyzed — the user can curate down from the
    full set on rerun without ever losing earlier-imported domains.

    All other spec fields (criteria, ai, lang, use_cache, etc.) still
    come from Job.spec_json — those are intentionally "latest config
    wins" so an operator's curated AI provider choice carries forward.
    """
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    try:
        raw = json.loads(job.spec_json or "{}")
    except json.JSONDecodeError:
        raw = {}
    # Round-trip through AnalyzeSpec so older specs (before per-criterion sort
    # existed) get the new defaults filled in. Falls back to the raw payload
    # if validation fails for any reason — we'd rather show a partially-broken
    # form than blank out the rerun.
    try:
        spec = AnalyzeSpec.model_validate(raw).model_dump(mode="json")
    except Exception:
        spec = raw

    # Override domains with the union of all RunDomain.domain rows
    # across every Run of this Job. Order: keep insertion order of the
    # first time each domain was seen so the original import sequence
    # is preserved (useful when the operator was applying spreadsheet
    # logic to ordering — e.g. high-priority first).
    seen: set[str] = set()
    all_domains: list[str] = []
    for (dom,) in (
        db.query(RunDomain.domain)
        .join(Run, Run.id == RunDomain.run_id)
        .filter(Run.job_id == job.id)
        .order_by(RunDomain.id.asc())
        .all()
    ):
        if dom and dom not in seen:
            seen.add(dom)
            all_domains.append(dom)
    if all_domains:
        # Only override when there ARE historical RunDomains — for a
        # brand-new Job with 0 runs, leave spec.domains as-is.
        if isinstance(spec, dict):
            spec["domains"] = all_domains

    return {"job_id": job.id, "name": job.name, "notes": job.notes, "spec": spec}


# --- Mutations -------------------------------------------------------------

class JobPatchIn(BaseModel):
    # Optional fields — None means "don't touch"; empty string means
    # "clear it explicitly".
    name: str | None = None
    notes: str | None = None


@router.patch("/{job_id}")
def patch_job(
    job_id: int, payload: JobPatchIn, db: Session = Depends(get_db)
) -> dict:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(400, "name cannot be empty")
        job.name = name
    if payload.notes is not None:
        # Notes can be cleared to empty string deliberately, so we don't
        # treat "" as a no-op.
        job.notes = payload.notes
    db.commit()
    return {
        "id": job.id,
        "name": job.name,
        "notes": job.notes,
        "updated_at": job.updated_at.isoformat(),
    }


@router.delete("/{job_id}")
def delete_job(job_id: int, db: Session = Depends(get_db)) -> dict:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    # Signal cancel to any in-flight worker BEFORE the cascade. The
    # worker checks `is_canceled(run_id)` between fetches/AI calls and
    # exits cleanly; without this, a paused/running worker keeps
    # writing CriterionResult rows after the cascade has removed the
    # parent RunDomains (FK enforcement is off in our SQLite config),
    # which leaks orphan CR rows that subsequent runs can claim via
    # rowid reuse. Also clear pause flags so the next Run that reuses
    # one of these rowids doesn't inherit a stale "paused" state.
    from ..tasks import _clear_cancel, _clear_pause, request_cancel
    run_ids = [r.id for r in job.runs]
    for rid in run_ids:
        request_cancel(rid)
    # JobCriterionPin has NO cascade (SQLite FK enforcement is off in our
    # config), so delete this job's pins explicitly — otherwise they
    # orphan and later collide on the (job_id, criterion) UNIQUE
    # constraint when SQLite reuses this job's rowid (e.g. a job import).
    db.query(JobCriterionPin).filter(
        JobCriterionPin.job_id == job.id
    ).delete(synchronize_session=False)
    # linked_domain_rows / serp_overview_rows likewise have no FK cascade —
    # bulk-delete by the denormalized job_id so output rows don't leak.
    from ..models import LinkedDomainRow, SerpOverviewRow
    db.query(LinkedDomainRow).filter(
        LinkedDomainRow.job_id == job.id
    ).delete(synchronize_session=False)
    db.query(SerpOverviewRow).filter(
        SerpOverviewRow.job_id == job.id
    ).delete(synchronize_session=False)
    db.delete(job)
    db.commit()
    for rid in run_ids:
        _clear_pause(rid)
        _clear_cancel(rid)
    return {"deleted": job_id}


class BulkDeleteJobsRequest(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


@router.post("/bulk-delete")
def bulk_delete_jobs(
    payload: BulkDeleteJobsRequest, db: Session = Depends(get_db)
) -> dict:
    """Delete N jobs in one round-trip. Frontend used to fan out
    `DELETE /jobs/{id}` per job — fine for small batches but slow + chatty
    when archiving the Active tab. Returns `{deleted, missing}` so the UI
    banner can show "Deleted N jobs (M not found)" honestly.

    No transaction-scoped delete: we let SQLAlchemy cascade through Run /
    RunDomain / CriterionResult one job at a time, same as the single
    endpoint. Stays correct under concurrent deletes from another tab —
    the missing-id list catches anything already gone."""
    found = (
        db.query(Job).filter(Job.id.in_(payload.ids)).all()
    )
    found_ids = {j.id for j in found}
    missing = [i for i in payload.ids if i not in found_ids]
    # Same in-flight-cleanup pattern as the single-job DELETE endpoint
    # above: cancel any active workers BEFORE the cascade, then clear
    # the in-memory pause/cancel flags AFTER so SQLite-reused rowids
    # in subsequent submits start with a clean slate. See that
    # endpoint's comment for the underlying reasoning.
    from ..tasks import _clear_cancel, _clear_pause, request_cancel
    run_ids: list[int] = []
    for j in found:
        run_ids.extend(r.id for r in j.runs)
    for rid in run_ids:
        request_cancel(rid)
    # Cascade JobCriterionPins explicitly — see the single-job DELETE
    # endpoint for why (no FK cascade; orphans collide on rowid reuse).
    if found_ids:
        db.query(JobCriterionPin).filter(
            JobCriterionPin.job_id.in_(found_ids)
        ).delete(synchronize_session=False)
        # Same for linked_domain_rows / serp_overview_rows (no FK cascade)
        # — bulk-delete by job_id.
        from ..models import LinkedDomainRow, SerpOverviewRow
        db.query(LinkedDomainRow).filter(
            LinkedDomainRow.job_id.in_(found_ids)
        ).delete(synchronize_session=False)
        db.query(SerpOverviewRow).filter(
            SerpOverviewRow.job_id.in_(found_ids)
        ).delete(synchronize_session=False)
    for j in found:
        db.delete(j)
    if found:
        db.commit()
    for rid in run_ids:
        _clear_pause(rid)
        _clear_cancel(rid)
    return {"deleted": sorted(found_ids), "missing": missing}


@router.post("/{job_id}/archive")
def archive_job(job_id: int, db: Session = Depends(get_db)) -> dict:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.archived_at is None:
        job.archived_at = datetime.utcnow()
        db.commit()
    return {"id": job.id, "archived_at": job.archived_at.isoformat()}


@router.post("/{job_id}/unarchive")
def unarchive_job(job_id: int, db: Session = Depends(get_db)) -> dict:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    job.archived_at = None
    db.commit()
    return {"id": job.id, "archived_at": None}


class RerunIn(BaseModel):
    spec: AnalyzeSpec


class RerunOut(BaseModel):
    job_id: int
    run_id: int


@router.post("/{job_id}/rerun", response_model=RerunOut)
async def rerun_job(
    job_id: int, payload: RerunIn, db: Session = Depends(get_db)
) -> RerunOut:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")

    cleaned = [d.strip() for d in payload.spec.domains if d.strip()]
    if not cleaned:
        raise HTTPException(400, "at least one domain is required")
    # Validate that the spec activates at least one criterion across ANY
    # pillar (Quality / Whois / Availability / Ahrefs Batch / Linked Domains /
    # SERP Overview). Earlier this only checked the 6 Quality criteria, which
    # rejected reruns of Whois and Availability jobs (their specs leave Quality
    # criteria off and turn on whois_history or availability instead). The
    # 2026-05-21 fix broadens the check so /jobs/{id}/rerun is kind-agnostic —
    # dispatch_run already routes by job.kind, so the rerun endpoint just needs
    # to accept any valid pillar spec.
    #
    # 2026-08-11: that broadening missed the three pillars added after it, so
    # rerunning an ahrefs_batch_analysis / linked_domains / serp_overview job
    # 400'd with "at least one criterion must be enabled" even though its spec
    # was valid. Keep this tuple in sync with `tasks.dispatch_run`'s kinds.
    enabled_count = sum(
        1
        for k in (
            "backlinks", "refdomains", "anchors", "keywords",
            "wayback", "wayback_classify",
            "whois_history", "availability",
            "ahrefs_batch_analysis", "linked_domains", "serp_overview",
        )
        if getattr(payload.spec.criteria, k).enabled
    )
    if enabled_count == 0:
        raise HTTPException(400, "at least one criterion must be enabled")

    # Use model_copy(update=) so EVERY spec field flows through automatically.
    # The field-by-field rebuild had silently dropped `check_availability` on
    # rerun (and `ai=` / `use_cache` / `lang` before that). See the matching
    # comment in routers/analyze.py.
    norm_spec = payload.spec.model_copy(update={"domains": cleaned})
    # Same Quality-pillar guard as `/analyze/jobs` — but ONLY for quality
    # jobs. Whois-kind / availability-kind reruns legitimately need those
    # criteria enabled (their pillar runners dispatch them), so we must
    # not strip them. Gated on `job.kind`. (2026-05-24)
    if (job.kind or "quality") == "quality":
        from ..schemas import strip_pillar_criteria_from_quality_spec
        norm_spec = strip_pillar_criteria_from_quality_spec(norm_spec)
    # Auto-enable wayback + V2 sampling when classify is on.
    from .analyze import auto_enable_wayback_for_classify
    auto_enable_wayback_for_classify(norm_spec)
    spec_json = norm_spec.model_dump_json()

    # Update Job.spec_json so a future Analyze prefill picks up the latest
    # criteria. Old runs keep their own spec_json snapshot.
    job.spec_json = spec_json

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()
    for d in cleaned:
        db.add(RunDomain(run_id=run.id, domain=d, status="pending"))
    db.commit()

    # Augmentation chain: see analyze.py for the full rationale. Reruns
    # benefit just as much (often more — wayback-only reruns are the
    # common pattern) so we link augmenters here too.
    from ..augmentation import link_augmenters_for_run
    link_augmenters_for_run(db, run_id=run.id)

    dispatch_run(run.id)
    return RerunOut(job_id=job.id, run_id=run.id)


# --- Run endpoints ----------------------------------------------------------

# Accepted values for the availability filter dropdown. Must match the
# bucket keys `_bucket_counts_for_run` emits for availability runs so
# "picking 'без вердикта' returns exactly the chip's no_verdict count".
# 'available'/'registered'/'unknown'/'error' map to the verdict.status
# values the runner writes; 'no_verdict' is the residual chip bucket
# (missing CR, status='failed'/'running'/'pending', empty/malformed
# data_json, or any other verdict.status not in the four known ones).
_AVAILABILITY_VERDICT_STATUSES = (
    "available", "registered", "not_supported", "unknown", "error",
)
_AVAILABILITY_FILTER_BUCKETS = _AVAILABILITY_VERDICT_STATUSES + ("no_verdict",)


def _apply_availability_filter(filter_q, buckets: list[str]):
    """Narrow a `RunDomain.query()` to rows whose latest availability CR
    falls into any of the chip-bucket keys in `buckets`. Mirrors the chip
    SQL exactly so filter results equal chip counts. Bucket vocabulary:
    available / registered / unknown / error / no_verdict.

    Implementation: LEFT OUTER JOIN the latest availability CR per RD
    (correlated subselect, same `ORDER BY cr.id DESC LIMIT 1` trick as
    the chip, so duplicate-CR-bug doesn't double-count). Then a CASE
    expression assigns each row to a bucket using the same WHEN-chain
    the chip uses (short-circuit on cr.id IS NULL, cr.status='failed',
    empty/invalid data_json BEFORE the json_extract call, so SQLite
    never sees malformed JSON). Filter by `bucket IN (selected)`."""
    requested = [b for b in buckets if b in _AVAILABILITY_FILTER_BUCKETS]
    if not requested:
        # Caller passed only unrecognised values — match nothing, same
        # as the strict status_filter behavior elsewhere.
        return filter_q.filter(literal(False))

    av_cr = aliased(CriterionResult)
    latest_av_cr_id = (
        select(CriterionResult.id)
        .where(CriterionResult.run_domain_id == RunDomain.id)
        .where(CriterionResult.criterion == "availability")
        .order_by(CriterionResult.id.desc())
        .limit(1)
        .correlate(RunDomain)
        .scalar_subquery()
    )
    filter_q = filter_q.outerjoin(av_cr, av_cr.id == latest_av_cr_id)
    # SQLite short-circuits CASE WHEN evaluation, so the json_extract
    # calls in the inner CASE only fire when all the data_json safety
    # checks above have passed. Without this guard `json_extract('')`
    # raises and 500s the whole endpoint.
    bucket_expr = case(
        (av_cr.id.is_(None), literal("no_verdict")),
        (av_cr.status == "failed", literal("no_verdict")),
        (av_cr.data_json.is_(None), literal("no_verdict")),
        (av_cr.data_json == "", literal("no_verdict")),
        (sqla_func.json_valid(av_cr.data_json) == 0, literal("no_verdict")),
        else_=case(
            (
                sqla_func.json_extract(av_cr.data_json, "$.verdict.status")
                == "available",
                literal("available"),
            ),
            (
                sqla_func.json_extract(av_cr.data_json, "$.verdict.status")
                == "registered",
                literal("registered"),
            ),
            (
                sqla_func.json_extract(av_cr.data_json, "$.verdict.status")
                == "not_supported",
                literal("not_supported"),
            ),
            (
                sqla_func.json_extract(av_cr.data_json, "$.verdict.status")
                == "unknown",
                literal("unknown"),
            ),
            (
                sqla_func.json_extract(av_cr.data_json, "$.verdict.status")
                == "error",
                literal("error"),
            ),
            else_=literal("no_verdict"),
        ),
    )
    return filter_q.filter(bucket_expr.in_(requested))


def _run_domain_filter_q(
    db: Session,
    run_id: int,
    *,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = None,
    domain_filter: str | None = None,
):
    """Build the `RunDomain` query for a run with the standard Run-page
    filters applied (status + availability verdict + domain substring).
    Shared by `get_run`, `get_run_progress`, and `get_run_domain_ids` so
    the three stay in lock-step — the domain-ids endpoint MUST match the
    table's filtered view exactly for "select all matching" to be correct.

    `domain_filter` (added 2026-06-14) is a case-insensitive substring
    match on the domain — the server-side equivalent of the Run page's
    client-side search box, needed once the page paginates server-side and
    no longer holds every domain in memory."""
    q = db.query(RunDomain).filter(RunDomain.run_id == run_id)
    if status_filter:
        q = q.filter(RunDomain.status == status_filter)
    if availability_status_filter:
        q = _apply_availability_filter(q, availability_status_filter)
    if domain_filter and domain_filter.strip():
        q = q.filter(RunDomain.domain.ilike(f"%{domain_filter.strip()}%"))
    return q


# Criteria the frontend `failedCount` scan counts toward the "Retry
# Failed" button. Mirrored here so the server-side aggregate matches the
# client's number exactly. NOTE: deliberately matches the frontend list
# (ahrefs_batch_analysis is NOT in it — the client never counted it, so a
# batch run shows 0 failed criteria, same as before).
_FAILED_CRITERIA_KEYS = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify", "whois_history", "availability",
)


# Substrings that identify an archive.org-side failure in CriterionResult.error.
# Matched on the error TEXT because a failed fetch stores http_status=None (see
# tasks._fetch_criterion) -- the status code only survives in the message.
_WB_UPSTREAM_PATTERNS: tuple[tuple[str, str], ...] = (
    ("archive_offline", "temporarily offline"),
    ("http_503", "503"),
    ("http_429", "429"),
    ("network", "network error"),
)


def _wayback_upstream_errors(db: Session, run_id: int) -> dict[str, int]:
    """Count wayback CRs that failed because ARCHIVE.ORG could not serve us,
    split by kind, plus the distinct domains affected.

    Scoped to criterion='wayback' so classify rows -- which now quote the
    wayback error verbatim -- don't double-count. `archive_offline` wins over
    the plain status buckets: those messages also contain "503", and the
    site-wide maintenance page is the more useful label.

    Cheap by construction: SQL LIKE counts over the error column, no JSON
    parsing and no per-domain scan."""
    base = (
        db.query(CriterionResult)
        .join(RunDomain, CriterionResult.run_domain_id == RunDomain.id)
        .filter(RunDomain.run_id == run_id)
        .filter(CriterionResult.criterion == "wayback")
        .filter(CriterionResult.error.isnot(None))
        .filter(CriterionResult.error != "")
    )
    offline_clause = CriterionResult.error.ilike("%temporarily offline%")
    out: dict[str, int] = {}
    for key, needle in _WB_UPSTREAM_PATTERNS:
        q = base.filter(CriterionResult.error.ilike(f"%{needle}%"))
        if key != "archive_offline":
            q = q.filter(~offline_clause)
        n = q.count()
        if n:
            out[key] = n
    if not out:
        return {}
    any_clause = or_(*[
        CriterionResult.error.ilike(f"%{needle}%")
        for _key, needle in _WB_UPSTREAM_PATTERNS
    ])
    out["total"] = base.filter(any_clause).count()
    out["domains"] = (
        base.filter(any_clause)
        .with_entities(CriterionResult.run_domain_id)
        .distinct()
        .count()
    )
    return out


def _run_failed_aggregates(db: Session, run_id: int) -> tuple[int, int]:
    """(failed_domains, failed_criteria) for the run page's "Retry failed"
    button. This is the SINGLE source of truth -- the frontend renders these
    verbatim rather than rescanning, because two implementations of the rule
    inevitably drifted apart.

    `failed_criteria` counts DISTINCT CriterionResult rows that the retry will
    actually re-run, matching `tasks._collect_failed_criteria` one-for-one. It
    used to sum two buckets, so a row that failed its fetch AND carried an
    ai_verdict_error added 2 -- the button then promised "retry 2" and did 1.
    For a control labelled "Retry N", N must be the number of things retried.

    A row is retryable when `status == 'failed'`, or it carries an
    `ai_verdict_error`, or it is orphaned (`status in ('running','pending')`)
    on a TERMINAL run -- there a non-terminal CR means its task died (e.g.
    uvicorn restart). On a live run those same statuses just mean "in flight",
    so they are excluded or the whole run would read as errored.

    wayback_classify rows the retry skips as futile (their wayback CR finished
    with 0 CDX rows -> no archive history, so classify can never succeed) are
    subtracted; see `_futile_classify_count`.

    Known, deliberate gap: a criterion enabled in the spec whose CR row was
    never created is retried but not counted -- counting it needs the spec plus
    a per-domain scan of the whole run, which is exactly the cost this cheap
    SQL aggregate exists to avoid."""
    run = db.get(Run, run_id)
    run_is_terminal = bool(
        run is not None and run.status in ("done", "failed", "canceled")
    )
    base = (
        db.query(CriterionResult)
        .join(RunDomain, CriterionResult.run_domain_id == RunDomain.id)
        .filter(RunDomain.run_id == run_id)
        .filter(CriterionResult.criterion.in_(_FAILED_CRITERIA_KEYS))
    )
    ai_failed = and_(
        CriterionResult.ai_verdict_error.isnot(None),
        CriterionResult.ai_verdict_error != "",
    )
    stuck_statuses = (
        ["failed", "running", "pending"] if run_is_terminal else ["failed"]
    )
    retryable = or_(CriterionResult.status.in_(stuck_statuses), ai_failed)
    failed_criteria = base.filter(retryable).count()
    failed_domains = (
        base.filter(retryable)
        .with_entities(CriterionResult.run_domain_id)
        .distinct()
        .count()
    )

    futile = _futile_classify_count(db, run_id, stuck_statuses)
    if futile:
        failed_criteria = max(0, failed_criteria - futile["rows"])
        failed_domains = max(0, failed_domains - futile["domains_only"])
    return failed_domains, failed_criteria


def _futile_classify_count(
    db: Session, run_id: int, stuck_statuses: list[str]
) -> dict | None:
    """How much of the raw failure count comes from wayback_classify rows the
    retry will skip as futile (their wayback CR finished with 0 CDX rows).

Returns `rows` (distinct futile CRs to subtract) and `domains_only`.
    Caught by the dpu.kz reproduction from run 97: a domain whose Wayback
    history is genuinely empty was advertised as a retryable error, and the
    retry then refused to touch it.

    `domains_only` counts RunDomains whose ONLY failure is that futile row, so
    they drop out of the domain count entirely; a domain with other genuine
    failures still counts once. The row's own ai_verdict_error does NOT
    disqualify it here -- that error IS the futile row, not a separate
    problem."""
    from ..tasks import _classify_retry_is_futile

    rows = (
        db.query(CriterionResult)
        .join(RunDomain, CriterionResult.run_domain_id == RunDomain.id)
        .filter(RunDomain.run_id == run_id)
        .filter(CriterionResult.criterion == "wayback_classify")
        .filter(
            or_(
                CriterionResult.status.in_(stuck_statuses),
                and_(
                    CriterionResult.ai_verdict_error.isnot(None),
                    CriterionResult.ai_verdict_error != "",
                ),
            )
        )
        .all()
    )
    if not rows:
        return None
    rd_ids = [r.run_domain_id for r in rows]
    siblings = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(rd_ids))
        .all()
    )
    by_rd: dict[int, dict] = {}
    for cr in siblings:
        by_rd.setdefault(cr.run_domain_id, {})[cr.criterion] = cr

    rows_futile = domains_only = 0
    for r in rows:
        by_name = by_rd.get(r.run_domain_id, {})
        if not _classify_retry_is_futile(by_name):
            continue
        rows_futile += 1
        others = [
            cr for cr in by_name.values()
            if cr.id != r.id
            and cr.criterion in _FAILED_CRITERIA_KEYS
            and (
                cr.status in stuck_statuses
                or (cr.ai_verdict_error or "").strip()
            )
        ]
        if not others:
            domains_only += 1
    return {"rows": rows_futile, "domains_only": domains_only}


def get_run(
    run_id: int,
    db: Session = Depends(get_db),
    *,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = None,
    domain_filter: str | None = None,
) -> RunDetail:
    """Run detail endpoint, now paginated (added 2026-05-16).

    Returns a SLICE of `limit` domains starting at `offset`, plus
    `total_count` (run-wide) and `filtered_count` (post-status filter
    when set). Default `limit=200` keeps pre-pagination callers happy
    while still capping the heavy JSON-parsing loop at a manageable
    window. Pass `limit=0` to disable pagination entirely — only
    appropriate when you know the run is small (e.g. tests).

    Performance: the per-domain loop below parses
    `ai_verdict_json` + `final_assessment_json` + wayback `data_json`
    for every domain it touches. At 100k+ domains, walking the full
    set in one request timed out (the 2026-05-16 incident on /jobs/57).
    Pagination caps the loop at O(limit) regardless of run size."""
    # Resolve the Run header first (lightweight) so we know it exists
    # before doing any heavy joins.
    run = db.query(Run).filter(Run.id == run_id).one_or_none()
    if run is None:
        raise HTTPException(404, "run not found")

    from ..app_settings import get_scoring_config
    from ..tasks import is_reanalyzing_run_domain
    from .database import _bucket_for, _parse_final_confidence, _parse_final_score
    sc = get_scoring_config()
    good_t = sc["good_threshold"]
    mixed_t = sc["mixed_threshold"]

    # Total + filtered counts via cheap SQL aggregations — never load
    # all rows just to count them.
    total_count = (
        db.query(RunDomain.id)
        .filter(RunDomain.run_id == run.id)
        .count()
    )
    # Status + availability-verdict + domain-substring filters, built via
    # the shared helper so /runs/{id}, /progress and /domain-ids stay in
    # lock-step (the "select all matching" feature relies on /domain-ids
    # returning exactly the rows this query would page through).
    filter_q = _run_domain_filter_q(
        db, run.id,
        status_filter=status_filter,
        availability_status_filter=availability_status_filter,
        domain_filter=domain_filter,
    )
    filtered_count = filter_q.with_entities(RunDomain.id).count()

    # Domain slice — apply pagination AT THE DB layer. `limit=0` is the
    # opt-out for "give me everything" (tests, exports). Always order
    # by id for stable pagination.
    page_q = filter_q.order_by(RunDomain.id.asc())
    if limit > 0:
        page_q = page_q.offset(max(offset, 0)).limit(limit)
    page_q = page_q.options(selectinload(RunDomain.results))
    page_domains: list[RunDomain] = list(page_q.all())

    progress: list[RunDomainProgress] = []
    for d in page_domains:
        parsed_final: dict | None = None
        if d.final_assessment_json:
            try:
                parsed_final = json.loads(d.final_assessment_json)
            except json.JSONDecodeError:
                parsed_final = None
        ai_provider = ""
        ai_model = ""
        if isinstance(parsed_final, dict):
            ai_provider = parsed_final.get("provider") or ""
            ai_model = parsed_final.get("model") or ""
        partial = bool(
            isinstance(parsed_final, dict) and parsed_final.get("partial")
        )
        ai_status: dict[str, str] = {}
        # `wayback_rows`: surfaced for the Run-page "Wayback CDX" filter so
        # the user can isolate done-but-empty-CDX rows for retry. Only
        # populated when the wayback CR reached status=done; failed/pending
        # rows stay None so they don't get lumped with genuine 0-row hits.
        wayback_rows: int | None = None
        for cr in d.results:
            if cr.ai_verdict_error:
                ai_status[cr.criterion] = "failed"
            elif cr.ai_verdict_json:
                ai_status[cr.criterion] = "done"
            else:
                ai_status[cr.criterion] = "pending"
            if (
                cr.criterion == "wayback"
                and cr.status == "done"
                and cr.data_json
            ):
                try:
                    wb_body = json.loads(cr.data_json)
                except json.JSONDecodeError:
                    wb_body = None
                if isinstance(wb_body, dict):
                    rows_val = wb_body.get("wayback")
                    if isinstance(rows_val, list):
                        wayback_rows = len(rows_val)
        # Availability verdict (2026-05-16) — same `data_json.verdict.status`
        # the chip SQL and Database column read. CRITICAL: pick the
        # LATEST availability CR by id, NOT the first one in iteration
        # order. The availability runner creates a fresh CR on every
        # invocation (resume-after-restart paths re-invoke for already-
        # done RDs — see memory line 2448), and the chip SQL and the
        # server-side filter both `ORDER BY cr.id DESC LIMIT 1`. Reading
        # the first CR in `d.results` (which is unordered for
        # selectinload) made the displayed status disagree with the
        # filter's view of the row on duplicated rds.
        availability_status = ""
        latest_av_cr = max(
            (cr for cr in d.results if cr.criterion == "availability"),
            key=lambda cr: cr.id,
            default=None,
        )
        if latest_av_cr is not None and latest_av_cr.data_json:
            try:
                av_body = json.loads(latest_av_cr.data_json)
            except json.JSONDecodeError:
                av_body = None
            if isinstance(av_body, dict):
                verdict = av_body.get("verdict")
                if isinstance(verdict, dict):
                    vs = verdict.get("status")
                    if isinstance(vs, str):
                        availability_status = vs
        # Ahrefs batch-analysis metrics (2026-06-02) — latest CR per rd
        # (same duplicate-guard as availability). Pull data_json.metrics
        # so the run page can render one column per selected metric.
        batch_metrics: dict[str, float | None] = {}
        latest_batch_cr = max(
            (cr for cr in d.results if cr.criterion == "ahrefs_batch_analysis"),
            key=lambda cr: cr.id,
            default=None,
        )
        if latest_batch_cr is not None and latest_batch_cr.data_json:
            try:
                batch_body = json.loads(latest_batch_cr.data_json)
            except json.JSONDecodeError:
                batch_body = None
            if isinstance(batch_body, dict):
                m = batch_body.get("metrics")
                if isinstance(m, dict):
                    batch_metrics = {
                        k: (float(v) if isinstance(v, (int, float)) else None)
                        for k, v in m.items()
                    }
        # wayback_classify columns — pull straight from THIS rd's
        # classify CR ai_verdict_json. No cross-run stitching here:
        # the run page is run-isolated by design (per 2026-05-08 fix),
        # so an empty wayback_classify CR for this rd → empty cells.
        wbc_primary_language = ""
        wbc_secondary_languages: list[str] = []
        wbc_language_confidence: float | None = None
        wbc_primary_theme = ""
        wbc_secondary_themes: list[str] = []
        wbc_theme_confidence: float | None = None
        wbc_drift = False
        wbc_category = ""
        wbc_category_confidence: float | None = None
        wbc_category_was = ""
        wbc_cr = next(
            (cr for cr in d.results if cr.criterion == "wayback_classify"),
            None,
        )
        if wbc_cr is not None and wbc_cr.ai_verdict_json:
            try:
                wbc_parsed = json.loads(wbc_cr.ai_verdict_json)
            except json.JSONDecodeError:
                wbc_parsed = None
            if isinstance(wbc_parsed, dict):
                v = wbc_parsed.get("primary_language")
                if isinstance(v, str):
                    wbc_primary_language = v
                sl = wbc_parsed.get("secondary_languages")
                if isinstance(sl, list):
                    wbc_secondary_languages = [
                        s for s in sl if isinstance(s, str) and s
                    ]
                lc = wbc_parsed.get("language_confidence")
                if isinstance(lc, (int, float)) and not isinstance(lc, bool):
                    if 0.0 <= float(lc) <= 1.0:
                        wbc_language_confidence = float(lc)
                t = wbc_parsed.get("primary_theme")
                if isinstance(t, str):
                    wbc_primary_theme = t
                st = wbc_parsed.get("secondary_themes")
                if isinstance(st, list):
                    wbc_secondary_themes = [
                        s for s in st if isinstance(s, str) and s
                    ]
                tc = wbc_parsed.get("theme_confidence")
                if isinstance(tc, (int, float)) and not isinstance(tc, bool):
                    if 0.0 <= float(tc) <= 1.0:
                        wbc_theme_confidence = float(tc)
                wbc_drift = bool(wbc_parsed.get("drift_detected"))
                cat = wbc_parsed.get("category")
                if isinstance(cat, str):
                    wbc_category = cat
                cc = wbc_parsed.get("category_confidence")
                if isinstance(cc, (int, float)) and not isinstance(cc, bool):
                    if 0.0 <= float(cc) <= 1.0:
                        wbc_category_confidence = float(cc)
                cw = wbc_parsed.get("category_was")
                if isinstance(cw, str):
                    wbc_category_was = cw
        progress.append(
            RunDomainProgress(
                id=d.id,
                domain=d.domain,
                status=d.status,
                error=d.error,
                started_at=d.started_at,
                finished_at=d.finished_at,
                last_analyzed_at=d.last_analyzed_at,
                criteria={cr.criterion: cr.status for cr in d.results},
                ai_status=ai_status,
                ai_provider=ai_provider,
                ai_model=ai_model,
                final_score=None if partial else _parse_final_score(parsed_final),
                final_confidence=None if partial else _parse_final_confidence(parsed_final),
                final_bucket="" if partial else _bucket_for(
                    parsed_final, d.final_summary or "",
                    good_threshold=good_t, mixed_threshold=mixed_t,
                ),
                final_partial=partial,
                is_pinned=bool(d.is_pinned),
                reanalyzing=is_reanalyzing_run_domain(d.id),
                primary_language=wbc_primary_language,
                secondary_languages=wbc_secondary_languages,
                language_confidence=wbc_language_confidence,
                primary_theme=wbc_primary_theme,
                secondary_themes=wbc_secondary_themes,
                theme_confidence=wbc_theme_confidence,
                classify_drift_detected=wbc_drift,
                category=wbc_category,
                category_confidence=wbc_category_confidence,
                category_was=wbc_category_was,
                wayback_rows=wayback_rows,
                availability_status=availability_status,
                batch_metrics=batch_metrics,
            )
        )
    # Run-wide aggregates (2026-06-14) — computed once per full reload so
    # the server-paginated Run page doesn't need every domain in memory to
    # render the "last analyzed" badge and the "Retry Failed" counts. Cheap
    # SQL (a MAX + a few COUNTs); skipped cost on the 2s slim poll because
    # that hits /progress, not this endpoint.
    last_analyzed_at_max = (
        db.query(sqla_func.max(RunDomain.last_analyzed_at))
        .filter(RunDomain.run_id == run.id)
        .scalar()
    )
    failed_domains, failed_criteria = _run_failed_aggregates(db, run.id)

    from ..tasks import get_run_scoring_override
    return RunDetail(
        id=run.id,
        name=run.name or "",
        job_id=run.job_id,
        job_name=run.job.name,
        job_kind=(run.job.kind or "quality"),
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error=run.error,
        spec_json=run.spec_json,
        domains=progress,
        total_count=total_count,
        filtered_count=filtered_count,
        last_analyzed_at_max=last_analyzed_at_max,
        failed_domains=failed_domains,
        failed_criteria=failed_criteria,
        wayback_upstream=_wayback_upstream_errors(db, run_id),
        scoring_override=get_run_scoring_override(run.id),
    )


@runs_router.get("/{run_id}", response_model=RunDetail)
async def _get_run_route(
    run_id: int,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = Query(None),
    domain_filter: str | None = None,
) -> RunDetail:
    """Async wrapper for `get_run`. Off-loads the eager-loaded query +
    per-domain JSON walk to `asyncio.to_thread` so the event loop stays
    free during multi-hundred-domain payloads. Opens a fresh Session
    inside the executor — no Session ever crosses thread boundaries.

    Pagination params (added 2026-05-16): the FE drives offset/limit
    from its current page; status_filter narrows to one of the
    pending/running/done/failed/canceled enum values.
    `availability_status_filter` (multi-valued, 2026-05-16) narrows to
    rows whose latest availability CR has verdict.status in the set —
    only meaningful for availability-pillar runs. `domain_filter`
    (2026-06-14) is the server-side domain substring search used by the
    server-paginated Run page."""
    return await asyncio.to_thread(
        _run_get_run, run_id, limit, offset, status_filter,
        availability_status_filter, domain_filter,
    )


def _run_get_run(
    run_id: int,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = None,
    domain_filter: str | None = None,
) -> RunDetail:
    db = SessionLocal()
    try:
        return get_run(
            run_id, db=db,
            limit=limit, offset=offset, status_filter=status_filter,
            availability_status_filter=availability_status_filter,
            domain_filter=domain_filter,
        )
    finally:
        db.close()


def get_run_progress(
    run_id: int,
    db: Session = Depends(get_db),
    *,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = None,
    domain_filter: str | None = None,
) -> RunProgress:
    """Slim companion to `get_run` for the Run-page polling loop. Returns
    just the fields that change every tick: per-domain status pills,
    criterion fetch+AI status, reanalyzing flag, last_analyzed_at.

    Now paginated (added 2026-05-16). The polling loop sends the
    current page's offset/limit so a 100k-domain run polls a fixed
    window's worth of rows per tick instead of all 100k. `counts` is
    still run-wide (it's a cheap GROUP BY) so the header progress bar
    keeps showing the full-run state."""
    from ..tasks import is_reanalyzing_run, is_reanalyzing_run_domain

    run = db.query(Run).filter(Run.id == run_id).one_or_none()
    if run is None:
        raise HTTPException(404, "run not found")

    run_reanalyzing = is_reanalyzing_run(run.id)
    # Run-wide status counts via SQL aggregation — never load all rows
    # just to count them.
    counts = {"total": 0, "done": 0, "failed": 0, "running": 0, "pending": 0}
    status_rows = (
        db.query(RunDomain.status, sqla_func.count(RunDomain.id))
        .filter(RunDomain.run_id == run.id)
        .group_by(RunDomain.status)
        .all()
    )
    total = 0
    for status, cnt in status_rows:
        total += int(cnt)
        if status in counts:
            counts[status] = int(cnt)
    counts["total"] = total

    # Domain slice — same shared filter as /runs/{id} (status +
    # availability verdict + domain substring) so a search active in the
    # page narrows the polled window too.
    filter_q = _run_domain_filter_q(
        db, run.id,
        status_filter=status_filter,
        availability_status_filter=availability_status_filter,
        domain_filter=domain_filter,
    )
    filtered_count = filter_q.with_entities(RunDomain.id).count()
    page_q = filter_q.order_by(RunDomain.id.asc())
    if limit > 0:
        page_q = page_q.offset(max(offset, 0)).limit(limit)
    page_q = page_q.options(selectinload(RunDomain.results))
    page_domains: list[RunDomain] = list(page_q.all())

    rows: list[RunDomainProgressSlim] = []
    for d in page_domains:
        ai_status: dict[str, str] = {}
        criteria: dict[str, str] = {}
        for cr in d.results:
            criteria[cr.criterion] = cr.status
            if cr.ai_verdict_error:
                ai_status[cr.criterion] = "failed"
            elif cr.ai_verdict_json:
                ai_status[cr.criterion] = "done"
            else:
                ai_status[cr.criterion] = "pending"
        # Availability verdict — latest CR by id (see full-path comment).
        availability_status = ""
        latest_av_cr = max(
            (cr for cr in d.results if cr.criterion == "availability"),
            key=lambda cr: cr.id,
            default=None,
        )
        if latest_av_cr is not None and latest_av_cr.data_json:
            try:
                av_body = json.loads(latest_av_cr.data_json)
            except json.JSONDecodeError:
                av_body = None
            if isinstance(av_body, dict):
                verdict = av_body.get("verdict")
                if isinstance(verdict, dict):
                    vs = verdict.get("status")
                    if isinstance(vs, str):
                        availability_status = vs
        rows.append(RunDomainProgressSlim(
            id=d.id,
            status=d.status,
            criteria=criteria,
            ai_status=ai_status,
            reanalyzing=is_reanalyzing_run_domain(d.id),
            last_analyzed_at=d.last_analyzed_at,
            availability_status=availability_status,
        ))

    return RunProgress(
        run_id=run.id,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error=run.error or "",
        counts=counts,
        domains=rows,
        total_count=total,
        filtered_count=filtered_count,
        reanalyzing=run_reanalyzing,
    )


@runs_router.get("/{run_id}/progress", response_model=RunProgress)
async def _get_run_progress_route(
    run_id: int,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = Query(None),
    domain_filter: str | None = None,
) -> RunProgress:
    """Async wrapper for the slim progress endpoint. Off-loads the
    eager-loaded query to asyncio.to_thread so the polling loop can
    run at 2s cadence without holding an anyio threadpool slot for
    each tick."""
    return await asyncio.to_thread(
        _run_get_run_progress, run_id, limit, offset, status_filter,
        availability_status_filter, domain_filter,
    )


def _run_get_run_progress(
    run_id: int,
    limit: int = 200,
    offset: int = 0,
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = None,
    domain_filter: str | None = None,
) -> RunProgress:
    db = SessionLocal()
    try:
        return get_run_progress(
            run_id, db=db,
            limit=limit, offset=offset, status_filter=status_filter,
            availability_status_filter=availability_status_filter,
            domain_filter=domain_filter,
        )
    finally:
        db.close()


@run_domains_router.get("/{run_domain_id}")
def get_run_domain_detail(
    run_domain_id: int, db: Session = Depends(get_db)
) -> dict:
    """Full per-domain payload — the four raw Ahrefs JSON bodies plus
    metadata, plus AI verdicts when present. Powers the SEO landing page
    (4 tabs of raw rows + per-criterion verdicts + final assessment)."""
    rd = db.get(RunDomain, run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")

    # Per-criterion sort fields the user chose at submit time. Surfaced so
    # the per-domain table can show those columns and the user can verify
    # the API actually ordered by them.
    sort_columns_by_criterion: dict[str, list[str]] = {}
    try:
        spec_raw = json.loads(rd.run.spec_json or "{}")
        crits = spec_raw.get("criteria") or {}
        for key in ("backlinks", "refdomains", "anchors", "keywords", "wayback", "wayback_classify"):
            cfg = crits.get(key) or {}
            sort_rules = cfg.get("sort") or []
            cols: list[str] = []
            for rule in sort_rules:
                f = rule.get("field") if isinstance(rule, dict) else None
                if f and f not in cols:
                    cols.append(f)
            sort_columns_by_criterion[key] = cols
    except (json.JSONDecodeError, AttributeError):
        pass

    # Augmentation chain: when this RunDomain has fewer criteria than
    # prior RunDomains for the same domain (e.g. wayback-only rerun on a
    # domain previously analyzed with full Ahrefs), stitch missing
    # criteria from prior runs so the per-domain page shows everything
    # we know about the domain — same logic the Database row uses.
    # Each criterion cell carries `source_run_id` and `source_run_domain_id`
    # so the UI can render a "from Run #N" badge when the cell came from
    # a different run than the one in the URL.
    prior_rds = (
        db.query(RunDomain)
        .filter(RunDomain.domain == rd.domain)
        .order_by(RunDomain.id.desc())
        .all()
    )
    # Build per-rd CR map.
    rd_ids = [d.id for d in prior_rds]
    cr_rows = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(rd_ids))
        .all()
    )
    crs_by_rd: dict[int, dict[str, CriterionResult]] = {}
    for cr in cr_rows:
        crs_by_rd.setdefault(cr.run_domain_id, {})[cr.criterion] = cr

    # Eager-load Run rows for every prior_rds.run_id so we can resolve
    # `job_id` per-cell without N+1 lookups when stitched chips need to
    # link to `/jobs/{job_id}/runs/{run_id}/domains/{rd_id}`.
    prior_run_ids = {d.run_id for d in prior_rds}
    runs_by_id = {
        r.id: r
        for r in db.query(Run).filter(Run.id.in_(prior_run_ids)).all()
    }

    # Cache sort_columns per run since prior runs may have different specs.
    sort_cols_by_run: dict[int, dict[str, list[str]]] = {
        rd.run_id: sort_columns_by_criterion,
    }

    def _sort_cols_for(run_id: int) -> dict[str, list[str]]:
        if run_id in sort_cols_by_run:
            return sort_cols_by_run[run_id]
        out: dict[str, list[str]] = {}
        run = db.get(Run, run_id)
        try:
            spec_raw = json.loads(run.spec_json or "{}") if run else {}
            for key in ("backlinks", "refdomains", "anchors", "keywords", "wayback", "wayback_classify"):
                cfg = (spec_raw.get("criteria") or {}).get(key) or {}
                sort_rules = cfg.get("sort") or []
                cols: list[str] = []
                for rule in sort_rules:
                    f = rule.get("field") if isinstance(rule, dict) else None
                    if f and f not in cols:
                        cols.append(f)
                out[key] = cols
        except (json.JSONDecodeError, AttributeError):
            pass
        sort_cols_by_run[run_id] = out
        return out

    # Rule (revised 2026-05-08 — see chat with user):
    #   1. If THIS rd has a CriterionResult for the criterion, show it. Always.
    #      No fallback to sibling runs even when the rd's CR is failed/pending.
    #      The user opened a specific run's domain page; they expect to see
    #      what THIS run did.
    #   2. Else, if `rd.augments_rd_id` is set (explicit strict-subset
    #      augmentation link, populated at run-creation time by
    #      augmentation.link_augmenters_for_run), follow that one hop and
    #      surface the parent rd's CR for the criterion. The "stitched from
    #      Run #N" chip on the UI tells the user this came from elsewhere.
    #   3. Otherwise the criterion is absent from the view. We do NOT walk
    #      arbitrary prior rds for the same domain — that was the previous
    #      behavior and it caused later runs to silently displace earlier
    #      runs on per-domain pages.
    own_crs = crs_by_rd.get(rd.id, {})
    parent_rd: RunDomain | None = None
    parent_crs: dict[str, CriterionResult] = {}
    if rd.augments_rd_id is not None:
        for d in prior_rds:
            if d.id == rd.augments_rd_id:
                parent_rd = d
                parent_crs = crs_by_rd.get(d.id, {})
                break

    criteria: dict[str, dict] = {}
    # Iteration list MUST include every criterion type that can show up
    # on a CR row, else the response's `criteria` dict comes back empty
    # for any rd whose only CR is one of the omitted criteria — which
    # is exactly what happened for whois_history rds pre-2026-05-15.
    for criterion_name in (
        "backlinks", "refdomains", "anchors", "keywords",
        "wayback", "wayback_classify",
        # Whois History pillar (Wave 2b, 2026-05-15) — single criterion,
        # same CR shape (data_json + ai_verdict_json), surfaced through
        # the same per-domain detail builder. Frontend's
        # WhoisHistoryDomainView reads criteria.whois_history.ai_verdict
        # + .raw, so the criterion MUST appear in this loop's output.
        "whois_history",
        # Availability pillar (Wave 3, 2026-05-15) — same shape. CR
        # has data_json (cascade trace + verdict) only; no
        # ai_verdict_json since no AI is involved. Frontend's
        # AvailabilityDomainView reads criteria.availability.raw.
        "availability",
    ):
        picked_cr: CriterionResult | None = own_crs.get(criterion_name)
        picked_rd: RunDomain | None = rd if picked_cr is not None else None
        if picked_cr is None and parent_rd is not None:
            picked_cr = parent_crs.get(criterion_name)
            picked_rd = parent_rd if picked_cr is not None else None
        if picked_cr is None or picked_rd is None:
            continue

        try:
            body = json.loads(picked_cr.data_json) if picked_cr.data_json else None
        except json.JSONDecodeError:
            body = None
        rows: list = []
        if isinstance(body, dict):
            for v in body.values():
                if isinstance(v, list):
                    rows = v
                    break
        ai_verdict: dict | None = None
        if picked_cr.ai_verdict_json:
            try:
                ai_verdict = json.loads(picked_cr.ai_verdict_json)
            except json.JSONDecodeError:
                ai_verdict = None
        # Russian-translation overlay (2026-05-13 wave K2): when the CR
        # has `ai_verdict_ru_json` populated by the bulk
        # POST /database/translate-verdicts endpoint, replace
        # key_findings + red_flags arrays in the response. Other fields
        # (assessment, confidence, primary_theme, category, etc.) come
        # from the canonical ai_verdict_json so any future re-judge on
        # the original is reflected. No UI toggle — RU is preferred
        # whenever present.
        if ai_verdict is not None and picked_cr.ai_verdict_ru_json:
            try:
                ru_v = json.loads(picked_cr.ai_verdict_ru_json)
            except json.JSONDecodeError:
                ru_v = None
            if isinstance(ru_v, dict):
                for f in ("key_findings", "red_flags"):
                    if isinstance(ru_v.get(f), list):
                        ai_verdict[f] = ru_v[f]
        is_stitched = picked_rd.id != rd.id
        criteria[criterion_name] = {
            "status": picked_cr.status,
            "http_status": picked_cr.http_status,
            "fetched_at": (
                picked_cr.fetched_at.isoformat() if picked_cr.fetched_at else None
            ),
            "request_url": picked_cr.request_url,
            "error": picked_cr.error,
            "rows": rows,
            "raw": body,
            "ai_verdict": ai_verdict,
            "ai_verdict_error": picked_cr.ai_verdict_error,
            "sort_columns": _sort_cols_for(picked_rd.run_id).get(
                criterion_name, []
            ),
            "cached_from_run_id": picked_cr.cached_from_run_id,
            "ai_cached_from_run_id": picked_cr.ai_cached_from_run_id,
            "units_cost_row": picked_cr.units_cost_row,
            "units_cost_total": picked_cr.units_cost_total,
            "units_cost_actual": picked_cr.units_cost_actual,
            "ai_provider": picked_cr.ai_provider or "",
            "ai_model": picked_cr.ai_model or "",
            # Provenance: when this cell was sourced from a prior rd,
            # surface the source run/rd/job ids so the UI can render the
            # "from Run #N" badge as a link to that prior rd's page.
            # Null when the cell came from the rd the user is currently
            # viewing (the common case).
            "source_run_id": picked_rd.run_id if is_stitched else None,
            "source_run_domain_id": picked_rd.id if is_stitched else None,
            "source_job_id": (
                runs_by_id.get(picked_rd.run_id).job_id
                if is_stitched and runs_by_id.get(picked_rd.run_id) is not None
                else None
            ),
        }

    # Final assessment: prefer the URL's rd, fall back to the most recent
    # prior rd whose final has a usable score (skip partials and
    # summary-only finals from wayback-only reruns).
    def _final_dict(d: RunDomain) -> dict | None:
        # Russian-translation overlay (2026-05-13 wave K): when the rd
        # has `final_assessment_ru_json` populated (by the bulk
        # `POST /database/translate-verdicts` endpoint), use its
        # `summary` and `recommendation` over the original. Numeric
        # fields (`final`, `confidence`) come from the canonical
        # `final_assessment_json` so any subsequent recompute on the
        # original is reflected. No UI toggle — display always prefers
        # RU when present.
        if not d.final_assessment_json:
            return None
        try:
            parsed = json.loads(d.final_assessment_json)
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed, dict):
            return parsed
        if d.final_assessment_ru_json:
            try:
                ru = json.loads(d.final_assessment_ru_json)
            except json.JSONDecodeError:
                ru = None
            if isinstance(ru, dict):
                if isinstance(ru.get("summary"), str):
                    parsed["summary"] = ru["summary"]
                if isinstance(ru.get("recommendation"), str):
                    parsed["recommendation"] = ru["recommendation"]
        return parsed

    def _is_partial_final(parsed: dict | None) -> bool:
        return bool(isinstance(parsed, dict) and parsed.get("partial"))

    def _has_usable_score(parsed: dict | None) -> bool:
        if not isinstance(parsed, dict):
            return False
        f = parsed.get("final")
        if isinstance(f, (int, float)) and not isinstance(f, bool):
            return True
        s = parsed.get("score")
        if isinstance(s, (int, float)) and not isinstance(s, bool):
            return True
        if isinstance(f, str) and f.strip():
            return True
        return False

    final_assessment: dict | None = _final_dict(rd)
    final_source_run_id: int | None = None
    final_source_run_domain_id: int | None = None
    final_source_job_id: int | None = None
    # Fallback to a prior rd's final when this rd has no final / a partial /
    # an unscorable one — so the augmentation case (a wayback-only rerun
    # that shouldn't lose the parent run's full final) still shows the
    # best-known final.
    #
    # BUT: while the URL's run is still in flight (pending / running), the
    # current rd's final_assessment_json is legitimately not yet populated.
    # Falling back in that window leaks a prior run's final into a live
    # in-progress page — the per-criterion cards fill in gradually but the
    # FinalBanner shows immediately, looking like the final fired before
    # the criteria. Skip the fallback for in-flight runs so the user sees
    # "Final pending…" until this run's own final lands.
    run_status = (rd.run.status or "").lower() if rd.run else ""
    run_in_flight = run_status in ("pending", "running")
    if (
        not run_in_flight
        and (
            final_assessment is None
            or _is_partial_final(final_assessment)
            or not _has_usable_score(final_assessment)
        )
    ):
        for d in prior_rds:
            if d.id == rd.id:
                continue
            cand = _final_dict(d)
            if (
                cand is not None
                and not _is_partial_final(cand)
                and _has_usable_score(cand)
            ):
                final_assessment = cand
                final_source_run_id = d.run_id
                final_source_run_domain_id = d.id
                src_run = runs_by_id.get(d.run_id)
                final_source_job_id = src_run.job_id if src_run else None
                break

    from ..tasks import is_reanalyzing_run_domain
    # Surface the run's spec.ai so the reanalyze picker can default to it.
    spec_ai_provider = ""
    spec_ai_model = ""
    try:
        spec_obj = json.loads(rd.run.spec_json or "{}")
        ai = (spec_obj or {}).get("ai") or {}
        spec_ai_provider = ai.get("provider") or ""
        spec_ai_model = ai.get("model") or ""
    except json.JSONDecodeError:
        pass
    # Augmentation pointer for the UI banner: when this rd was created
    # with a strict-subset criteria-set of a prior rd, surface that rd's
    # run_id (+ rd_id + job_id) so the page can render "Augments Run #N"
    # as a clickable link to that prior rd's domain page.
    augments_run_id: int | None = None
    augments_run_domain_id: int | None = None
    augments_job_id: int | None = None
    if rd.augments_rd_id is not None:
        target = db.get(RunDomain, rd.augments_rd_id)
        if target is not None:
            augments_run_id = target.run_id
            augments_run_domain_id = target.id
            target_run = runs_by_id.get(target.run_id) or db.get(
                Run, target.run_id
            )
            augments_job_id = target_run.job_id if target_run else None

    # Per-domain AI spend aggregation (added 2026-05-08). Same shape as
    # the run-level /runs/{id}/cost endpoint but scoped to this rd's OWN
    # CRs (not augmentation-stitched parent CRs — those were paid for on
    # the parent run, not this one). Final-synth tokens/cost come from
    # the rd row itself.
    cost_total = 0.0
    cost_in = 0
    cost_out = 0
    cost_fresh = 0
    cost_cache = 0
    cost_seen_models: set[tuple[str, str]] = set()
    # Per-domain WhoisFreaks request count (Wave 2b). Same accounting
    # rule as the run-level aggregate above. Surfaced on the domain
    # page header so the operator sees "1 whois request" alongside
    # the AI cost pill for whois_history runs.
    whois_fresh = 0
    whois_cache = 0
    own_crs_for_cost = crs_by_rd.get(rd.id, {})
    for cr in own_crs_for_cost.values():
        if cr.ai_input_tokens:
            cost_in += int(cr.ai_input_tokens)
        if cr.ai_output_tokens:
            cost_out += int(cr.ai_output_tokens)
        if cr.ai_cost_usd is not None:
            cost_total += float(cr.ai_cost_usd)
        if cr.ai_cached_from_run_id is not None:
            cost_cache += 1
        elif cr.ai_verdict_json:
            cost_fresh += 1
        if cr.ai_provider and cr.ai_model:
            cost_seen_models.add((cr.ai_provider, cr.ai_model))
        if cr.criterion == "whois_history":
            # WhoisFreaks bills per successful request. A failed fetch
            # (provider raised before producing records) doesn't consume a
            # plan unit — `cr.error` holds the fetch-side error (distinct
            # from `ai_verdict_error` which is the AI step). Count only
            # when both `fetched_at` is set AND no fetch error landed.
            if (
                cr.fetched_at is not None
                and cr.cached_from_run_id is None
                and not (cr.error or "")
            ):
                whois_fresh += 1
            elif cr.cached_from_run_id is not None:
                whois_cache += 1
    if rd.final_input_tokens:
        cost_in += int(rd.final_input_tokens)
    if rd.final_output_tokens:
        cost_out += int(rd.final_output_tokens)
    if rd.final_cost_usd is not None:
        cost_total += float(rd.final_cost_usd)
        if rd.final_cost_usd or rd.final_input_tokens or rd.final_output_tokens:
            cost_fresh += 1
    if rd.final_assessment_json:
        try:
            _fa = json.loads(rd.final_assessment_json)
        except json.JSONDecodeError:
            _fa = {}
        _p, _m = (_fa.get("provider") or ""), (_fa.get("model") or "")
        if _p and _m:
            cost_seen_models.add((_p, _m))
    from ..app_settings import get_model_price as _gmp
    cost_missing = [
        {"provider": p, "model": m}
        for p, m in sorted(cost_seen_models)
        if _gmp(p, m) is None
    ]
    from ..app_settings import get_whois_history_units_per_request
    _whois_upr = get_whois_history_units_per_request()
    cost_payload = {
        "total_cost_usd": round(cost_total, 6),
        "total_input_tokens": cost_in,
        "total_output_tokens": cost_out,
        "fresh_calls": cost_fresh,
        "cache_hits": cost_cache,
        "missing_pricing": cost_missing,
        # Wave 2b: WhoisFreaks request count + units for this domain.
        # Same multiplier as the run-level rollup so the per-domain
        # number matches what the operator's plan dashboard shows.
        "whois_fresh_calls": whois_fresh,
        "whois_cached_calls": whois_cache,
        "whois_units_per_request": _whois_upr,
        "whois_units_billed": whois_fresh * _whois_upr,
    }

    note_row = db.get(DomainNote, rd.domain)
    return {
        "id": rd.id,
        "run_id": rd.run_id,
        "domain": rd.domain,
        "status": rd.status,
        "started_at": rd.started_at.isoformat() if rd.started_at else None,
        "finished_at": rd.finished_at.isoformat() if rd.finished_at else None,
        "last_analyzed_at": (
            rd.last_analyzed_at.isoformat() if rd.last_analyzed_at else None
        ),
        "error": rd.error,
        "job_id": rd.run.job_id,
        "job_name": rd.run.job.name,
        # Pillar discriminator (Wave 2b, 2026-05-15) — drives the
        # per-domain page's choice of view (Quality criterion tabs vs
        # WhoisHistoryDomainView). Always populated post-Wave-1
        # backfill; empty fallback maps to 'quality' on the frontend.
        "job_kind": (rd.run.job.kind or "quality"),
        "criteria": criteria,
        "final_assessment": final_assessment,
        "final_summary": rd.final_summary,
        # When `final_source_run_id` is non-null, the score in
        # `final_assessment` came from a prior rd, not this one. The
        # accompanying rd_id + job_id let the UI link the chip to the
        # prior rd's domain page (`/jobs/{job}/runs/{run}/domains/{rd}`).
        "final_source_run_id": final_source_run_id,
        "final_source_run_domain_id": final_source_run_domain_id,
        "final_source_job_id": final_source_job_id,
        # When non-null, this rd was explicitly marked as augmenting the
        # run with this id. UI shows "Augments Run #N" banner so users
        # know they're looking at a partial-criteria rerun stitched onto
        # a prior comprehensive view.
        "augments_run_id": augments_run_id,
        "augments_run_domain_id": augments_run_domain_id,
        "augments_job_id": augments_job_id,
        "reanalyzing": is_reanalyzing_run_domain(rd.id),
        "spec_ai_provider": spec_ai_provider,
        "spec_ai_model": spec_ai_model,
        "note": note_row.note if note_row else "",
        "note_updated_at": (
            note_row.updated_at.isoformat() if note_row else None
        ),
        # Per-domain AI spend on THIS run (own CRs only, not augmentation
        # parent CRs). Same shape as /runs/{id}/cost.
        "cost": cost_payload,
        # True when this RunDomain is the currently-pinned definitive
        # source for its domain on the Database page.
        "is_pinned": bool(rd.is_pinned),
    }


def get_run_summary(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Compact payload for the Analyze page's summary table — one row per
    domain with criterion verdicts + final summary. Doesn't include raw
    Ahrefs rows (use /run-domains/{id} for that).

    Sync impl. The async route below (`_get_run_summary_route`) wraps
    this in `asyncio.to_thread` so the FastAPI event loop doesn't tie up
    its anyio threadpool slot for the duration of the DB walk. Tests
    import and call this function directly with a session — that path
    stays exercised."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    from ..app_settings import get_scoring_config
    sc = get_scoring_config()
    good_t = sc["good_threshold"]
    mixed_t = sc["mixed_threshold"]
    rows: list[dict] = []
    for d in run.domains:
        per_crit: dict[str, dict | None] = {}
        for cr in d.results:
            verdict: dict | None = None
            if cr.ai_verdict_json:
                try:
                    verdict = json.loads(cr.ai_verdict_json)
                except json.JSONDecodeError:
                    verdict = None
            entry: dict = {
                "fetch_status": cr.status,
                "ai_assessment": (verdict or {}).get("assessment")
                if verdict
                else None,
                "ai_confidence": (verdict or {}).get("confidence")
                if verdict
                else None,
                "ai_error": cr.ai_verdict_error or None,
                "ai_provider": cr.ai_provider or "",
                "ai_model": cr.ai_model or "",
            }
            # wayback_classify doesn't emit an `assessment` field — its
            # verdict shape is {primary_theme, primary_language, category,
            # drift_detected, ...}. Surface those explicitly so the Compare
            # page can render category as the cell value and theme as its
            # own column. Empty strings when missing so the FE can rely on
            # truthy checks without optional-chaining the whole way down.
            if cr.criterion == "wayback_classify" and isinstance(verdict, dict):
                entry["theme"] = verdict.get("primary_theme") or ""
                entry["language"] = verdict.get("primary_language") or ""
                entry["category"] = verdict.get("category") or ""
                entry["drift_detected"] = bool(verdict.get("drift_detected"))
            # whois_history also lacks an `assessment` — its verdict shape
            # is {dropped_confidence, transferred_confidence, summary, ...}.
            # The Compare page needs the band (dropped / mixed / insufficient
            # / stable) + ownership_cycles to render a meaningful cell.
            # Mirrors the Database page derivation in routers/database.py.
            if cr.criterion == "whois_history":
                from .database import _whois_band
                dc: float | None = None
                tc: float | None = None
                summ = ""
                if isinstance(verdict, dict):
                    raw_dc = verdict.get("dropped_confidence")
                    if isinstance(raw_dc, (int, float)) and not isinstance(
                        raw_dc, bool
                    ) and 0.0 <= float(raw_dc) <= 1.0:
                        dc = float(raw_dc)
                    raw_tc = verdict.get("transferred_confidence")
                    if isinstance(raw_tc, (int, float)) and not isinstance(
                        raw_tc, bool
                    ) and 0.0 <= float(raw_tc) <= 1.0:
                        tc = float(raw_tc)
                    raw_s = verdict.get("summary")
                    if isinstance(raw_s, str):
                        summ = raw_s
                cycles: int | None = None
                if cr.data_json:
                    try:
                        wh_data = json.loads(cr.data_json)
                    except json.JSONDecodeError:
                        wh_data = None
                    diff = (
                        ((wh_data or {}).get("diff") or {})
                        if isinstance(wh_data, dict)
                        else {}
                    )
                    # Always recompute via the shared helper — see
                    # routers/database.py for the rationale (retroactive
                    # correction for legacy CRs without re-fetching).
                    from ..whois_history.diff import (
                        compute_cycles_from_diff_dict,
                    )
                    recomputed = (
                        compute_cycles_from_diff_dict(diff)
                        if isinstance(diff, dict)
                        else None
                    )
                    raw_cycles = (
                        diff.get("ownership_cycles")
                        if isinstance(diff, dict)
                        else None
                    )
                    if (
                        recomputed is not None
                        and isinstance(raw_cycles, int)
                        and 1 <= raw_cycles <= 10
                    ):
                        cycles = max(raw_cycles, recomputed)
                    elif recomputed is not None:
                        cycles = recomputed
                    elif isinstance(raw_cycles, int) and 1 <= raw_cycles <= 10:
                        cycles = raw_cycles
                entry["dropped_confidence"] = dc
                entry["transferred_confidence"] = tc
                entry["band"] = _whois_band(dc)
                entry["ownership_cycles"] = cycles
                entry["summary"] = summ
            per_crit[cr.criterion] = entry
        # Surface the numeric score from final_assessment_json so the
        # Analyze summary table can render the score pill (the score is
        # computed deterministically from sub-verdicts; see scoring.py).
        # `final_confidence` powers the grey-on-low-confidence rule.
        from .database import _bucket_for, _parse_final_confidence, _parse_final_score
        parsed_final: dict | None = None
        if d.final_assessment_json:
            try:
                parsed_final = json.loads(d.final_assessment_json)
            except json.JSONDecodeError:
                parsed_final = None
        rows.append(
            {
                "id": d.id,
                "domain": d.domain,
                "status": d.status,
                "criteria": per_crit,
                "final_summary": d.final_summary or None,
                "final_partial": bool(
                    isinstance(parsed_final, dict)
                    and parsed_final.get("partial")
                ),
                "final_score": (
                    None
                    if isinstance(parsed_final, dict)
                    and parsed_final.get("partial")
                    else _parse_final_score(parsed_final)
                ),
                "final_confidence": (
                    None
                    if isinstance(parsed_final, dict)
                    and parsed_final.get("partial")
                    else _parse_final_confidence(parsed_final)
                ),
                "final_bucket": (
                    ""
                    if isinstance(parsed_final, dict)
                    and parsed_final.get("partial")
                    else _bucket_for(
                        parsed_final, d.final_summary or "",
                        good_threshold=good_t, mixed_threshold=mixed_t,
                    )
                ),
                "final_provider": (
                    (parsed_final or {}).get("provider") or ""
                ),
                "final_model": (parsed_final or {}).get("model") or "",
            }
        )
    return {
        "run_id": run.id,
        "name": run.name or "",
        "job_id": run.job_id,
        "job_name": run.job.name,
        "status": run.status,
        "domains": rows,
    }


@runs_router.get("/{run_id}/summary")
async def _get_run_summary_route(run_id: int) -> dict:
    """Async wrapper: dispatches the sync impl via asyncio.to_thread
    so the route doesn't occupy an anyio threadpool slot during the
    per-domain walk + JSON parsing. A fresh session is opened inside
    the executor thread so we never share a Session across threads."""
    return await asyncio.to_thread(_run_get_run_summary, run_id)


def _run_get_run_summary(run_id: int) -> dict:
    db = SessionLocal()
    try:
        return get_run_summary(run_id, db=db)
    finally:
        db.close()


@runs_router.get("/{run_id}/cost")
def get_run_cost(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Aggregate per-run AI spend AND Ahrefs unit spend. Sums `ai_cost_usd`
    + `ai_input_tokens` / `ai_output_tokens` across every CriterionResult
    for the run, plus the final-synth columns on every RunDomain. Also
    sums `units_cost_actual` (what Ahrefs billed us, the real cost) +
    `units_cost_total` (list price, what it would have cost without
    Ahrefs's own server-side cache short-circuiting some requests) for
    the B/D/A/K criteria. wayback doesn't bill Ahrefs units — its CDX
    endpoint is free — so it's excluded from the Ahrefs-units totals.

    Returns:
      total_cost_usd       — actual fresh-call $ (cache hits contribute 0)
      total_input_tokens   — across all calls, fresh + cached (visibility)
      total_output_tokens
      fresh_calls          — # of CriterionResult rows with non-null cost (i.e. real calls, not cache copies)
      cache_hits           — # of cache-copied verdicts (ai_cached_from_run_id non-null)
      missing_pricing      — list of {provider, model} pairs that have rows
                              but no pricing entry; their cost contribution
                              is 0 and totals are incomplete by that amount.
      ahrefs_units_billed  — sum of units_cost_actual for B/D/A/K (added 2026-05-13)
      ahrefs_units_list    — sum of units_cost_total for B/D/A/K (list price; difference vs billed = Ahrefs server-cache savings)
      ahrefs_fresh_calls   — # of B/D/A/K CRs that actually hit the Ahrefs API
      ahrefs_cached_calls  — # of B/D/A/K CRs served from our local cross-run cache (no Ahrefs API call)
    """
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")

    rd_ids = [rd.id for rd in run.domains]
    if not rd_ids:
        return {
            "total_cost_usd": 0.0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "fresh_calls": 0,
            "cache_hits": 0,
            "missing_pricing": [],
            "ahrefs_units_billed": 0,
            "ahrefs_units_list": 0,
            "ahrefs_fresh_calls": 0,
            "ahrefs_cached_calls": 0,
        }

    crs = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(rd_ids))
        .all()
    )

    total_cost = 0.0
    total_in = 0
    total_out = 0
    fresh_calls = 0
    cache_hits = 0
    seen_models: set[tuple[str, str]] = set()
    # Ahrefs unit accounting (added 2026-05-13). Sums over B/D/A/K only
    # — wayback uses the free CDX endpoint, its CRs always have NULL
    # units_cost_*. We filter by criterion explicitly rather than
    # relying on NULL-units, because that's clearer + future-proof
    # against accidentally counting some non-Ahrefs criterion.
    AHREFS_CRITERIA = frozenset(
        # linked_domains added 2026-07-02, serp_overview 2026-07-10 — their
        # per-target CRs carry units_cost_* exactly like B/D/A/K
        # (cached_from_run_id always NULL, so every one counts as a fresh
        # Ahrefs call), so those tools' spend surfaces in the run cost.
        ("backlinks", "refdomains", "anchors", "keywords",
         "linked_domains", "serp_overview")
    )
    ahrefs_units_billed = 0
    ahrefs_units_list = 0
    ahrefs_fresh_calls = 0
    ahrefs_cached_calls = 0
    # WhoisFreaks request accounting (Wave 2b, 2026-05-15). One
    # whois_history CR = one WhoisFreaks API request (the provider
    # bills per request, not per record returned, so no "units" math
    # like Ahrefs — just a count). `whois_cached_calls` is wired as 0
    # today; reserved for a future cache-pre-check optimisation.
    whois_fresh_calls = 0
    whois_cached_calls = 0
    for cr in crs:
        if cr.ai_input_tokens:
            total_in += int(cr.ai_input_tokens)
        if cr.ai_output_tokens:
            total_out += int(cr.ai_output_tokens)
        if cr.ai_cost_usd is not None:
            total_cost += float(cr.ai_cost_usd)
        if cr.ai_cached_from_run_id is not None:
            cache_hits += 1
        elif cr.ai_verdict_json:
            fresh_calls += 1
        if cr.ai_provider and cr.ai_model:
            seen_models.add((cr.ai_provider, cr.ai_model))
        # Ahrefs units: only for B/D/A/K. units_cost_actual is non-null
        # only on rows where an actual Ahrefs API call landed (fresh
        # fetch). cached_from_run_id is non-null on rows served from
        # our local cross-run cache (no Ahrefs call). The two are
        # mutually exclusive in practice — _create_cached_criterion_row
        # leaves units_cost_* NULL while setting cached_from_run_id.
        if cr.criterion in AHREFS_CRITERIA:
            if cr.units_cost_actual is not None:
                ahrefs_units_billed += int(cr.units_cost_actual)
                ahrefs_fresh_calls += 1
            elif cr.cached_from_run_id is not None:
                ahrefs_cached_calls += 1
            if cr.units_cost_total is not None:
                ahrefs_units_list += int(cr.units_cost_total)
        # WhoisFreaks: 1 CR = 1 request. We count CRs that landed
        # results in data_json — a CR with status=failed AND no
        # fetched_at represents a request that bailed before reaching
        # the provider (missing API key / config error) and didn't
        # touch quota. Anything with fetched_at set + no fetch error
        # hit the provider successfully (records may be empty but the
        # call was billed). Failed fetches (cr.error non-empty) raised
        # before producing a billable response, so don't count them.
        elif cr.criterion == "whois_history":
            if (
                cr.fetched_at is not None
                and cr.cached_from_run_id is None
                and not (cr.error or "")
            ):
                whois_fresh_calls += 1
            elif cr.cached_from_run_id is not None:
                whois_cached_calls += 1

    # Final-synth tokens land on RunDomain.
    for rd in run.domains:
        if rd.final_input_tokens:
            total_in += int(rd.final_input_tokens)
        if rd.final_output_tokens:
            total_out += int(rd.final_output_tokens)
        if rd.final_cost_usd is not None:
            total_cost += float(rd.final_cost_usd)
            if rd.final_cost_usd or rd.final_input_tokens or rd.final_output_tokens:
                # Synth ran fresh on this domain — count it. (Cache for
                # final synth doesn't exist; resume idempotency just
                # short-circuits and writes nothing new.)
                fresh_calls += 1

    # Identify (provider, model) pairs we charged calls under but lack a
    # price row for — those contributed 0 and the totals are incomplete by
    # that amount. We also include final-synth model pairs.
    for rd in run.domains:
        if rd.final_assessment_json:
            try:
                fa = json.loads(rd.final_assessment_json)
            except json.JSONDecodeError:
                fa = {}
            p, m = (fa.get("provider") or ""), (fa.get("model") or "")
            if p and m:
                seen_models.add((p, m))

    from ..app_settings import get_model_price
    missing_pricing: list[dict] = []
    for provider, model in sorted(seen_models):
        if get_model_price(provider, model) is None:
            missing_pricing.append({"provider": provider, "model": model})

    # Units-per-request multiplier reflects the WhoisFreaks plan tier
    # — settable in Settings → Whois History → "Units per request"
    # because pricing varies between Free / Standard / Pro / Premium.
    # Default 1; operator updates to match their plan dashboard.
    from ..app_settings import get_whois_history_units_per_request
    whois_units_per_request = get_whois_history_units_per_request()
    whois_units_billed = whois_fresh_calls * whois_units_per_request
    return {
        "total_cost_usd": round(total_cost, 6),
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "fresh_calls": fresh_calls,
        "cache_hits": cache_hits,
        "missing_pricing": missing_pricing,
        "ahrefs_units_billed": ahrefs_units_billed,
        "ahrefs_units_list": ahrefs_units_list,
        "ahrefs_fresh_calls": ahrefs_fresh_calls,
        "ahrefs_cached_calls": ahrefs_cached_calls,
        # WhoisFreaks request accounting (Wave 2b). One request per
        # whois_history CR; `units_per_request` is the plan-tier
        # multiplier, `units_billed = fresh_calls * units_per_request`
        # is what the operator's WhoisFreaks dashboard will reflect.
        "whois_fresh_calls": whois_fresh_calls,
        "whois_cached_calls": whois_cached_calls,
        "whois_units_per_request": whois_units_per_request,
        "whois_units_billed": whois_units_billed,
    }


@runs_router.post("/{run_id}/cancel")
def cancel_run_route(run_id: int) -> dict:
    """Mark a running run canceled. Already-fetched data is kept; pending
    domains/criteria flip to `canceled`. In-flight HTTPS requests finish
    naturally (we don't abort them mid-stream)."""
    return cancel_run_now(run_id)


@runs_router.post("/{run_id}/pause")
def pause_run_route(run_id: int) -> dict:
    """Stop work on a running run. Reversible via /resume. Workers exit at
    the next fetch / AI checkpoint; in-flight requests finish naturally."""
    return pause_run_now(run_id)


@runs_router.post("/{run_id}/resume")
async def resume_run_route(run_id: int) -> dict:
    """Restart a paused run. Already-fetched Ahrefs data and AI verdicts
    are reused so resume costs nothing for completed criteria.

    Async because resume_run_now calls dispatch_run which uses
    asyncio.create_task — that requires a running event loop, which sync
    handlers don't have when FastAPI runs them in a threadpool."""
    return resume_run_now(run_id)


class RunPatchIn(BaseModel):
    name: str | None = None


@runs_router.patch("/{run_id}")
def patch_run_route(
    run_id: int, payload: RunPatchIn, db: Session = Depends(get_db)
) -> dict:
    """Update run-level metadata. Currently only `name` (a short user-
    supplied label). Empty string clears the name — UI then falls back
    to "Run #N"."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    if payload.name is not None:
        run.name = payload.name.strip()[:255]
    db.commit()
    return {"id": run_id, "name": run.name}


@runs_router.delete("/{run_id}")
def delete_run_route(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Permanently delete a single run + its run_domains + criterion_results.
    The job survives. Two safety gates:

    1. Refuses non-terminal runs (pending/running/paused) with 409 — the
       user must Cancel first so we don't yank state out from under a live
       worker.
    2. Refuses if any RunDomain in another run points at this run via
       `augments_rd_id` — the schema's ON DELETE SET NULL would handle the
       FK, but we'd silently lose the user-visible "stitched from run #N"
       chips on the augmenter's domain pages. Block-and-explain is more
       useful than quietly degrading the augmenter.

    Also clears any in-memory cancel/pause flags for this run id. SQLite
    reuses deleted primary keys, so without this a stale flag from the
    deleted run can short-circuit a future run that gets the same id.
    """
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    if run.status in ("pending", "running", "paused"):
        raise HTTPException(
            409,
            f"run is {run.status} — cancel it first",
        )
    rd_ids = [rd.id for rd in run.domains]
    if rd_ids:
        augmenter_run_ids = [
            row[0]
            for row in db.query(RunDomain.run_id)
            .filter(RunDomain.augments_rd_id.in_(rd_ids))
            .filter(RunDomain.run_id != run_id)
            .distinct()
            .all()
        ]
        if augmenter_run_ids:
            preview = ", ".join(f"#{rid}" for rid in augmenter_run_ids[:3])
            more = (
                f" (+{len(augmenter_run_ids) - 3} more)"
                if len(augmenter_run_ids) > 3
                else ""
            )
            raise HTTPException(
                409,
                f"run is a data source for run(s) {preview}{more} — "
                f"delete those first",
            )
    # linked_domain_rows / serp_overview_rows have no FK cascade —
    # bulk-delete this run's output rows by the denormalized run_id
    # before dropping the run.
    from ..models import LinkedDomainRow, SerpOverviewRow
    db.query(LinkedDomainRow).filter(
        LinkedDomainRow.run_id == run_id
    ).delete(synchronize_session=False)
    db.query(SerpOverviewRow).filter(
        SerpOverviewRow.run_id == run_id
    ).delete(synchronize_session=False)
    db.delete(run)
    db.commit()
    from ..tasks import _clear_cancel, _clear_pause
    _clear_cancel(run_id)
    _clear_pause(run_id)
    return {"deleted": run_id}


class ReanalyzeIn(BaseModel):
    # Optional override — when provided, takes precedence over the run's
    # stored ai spec. Useful for cache-only / AI-off runs that don't have
    # an AI provider locked in.
    provider: str | None = None
    model: str | None = None


@runs_router.post("/{run_id}/reanalyze")
async def reanalyze_run_route(
    run_id: int, body: ReanalyzeIn | None = None
) -> dict:
    """Re-judge every domain in a terminal run with the AI. Bypasses the
    AI cache. Reuses existing Ahrefs data — no refetch.

    Async because the impl spawns asyncio tasks; sync handlers run in a
    threadpool with no event loop. Same trap as submit/rerun/resume."""
    from ..tasks import reanalyze_run_now
    override = body.model_dump() if body else None
    result = reanalyze_run_now(run_id, ai_override=override)
    if result.get("found") is False:
        raise HTTPException(404, "run not found")
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


@runs_router.post("/{run_id}/retry-failed")
async def retry_failed_run_route(
    run_id: int, body: ReanalyzeIn | None = None
) -> dict:
    """Retry every failed criterion across every domain in this run. A
    "failed criterion" = fetch errored, AI judge errored, or no CR row
    was ever created for an enabled criterion. Sequentially per RD,
    parallel across RDs. Reuses the per-criterion reanalyze infrastructure
    (refetch-on-no-data + re-judge), so the existing per-domain
    `reanalyzing` polling state surfaces progress without UI changes."""
    from ..tasks import retry_failed_run_now
    override = body.model_dump() if body else None
    result = retry_failed_run_now(run_id, ai_override=override)
    if result.get("found") is False:
        raise HTTPException(404, "run not found")
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


@runs_router.post("/{run_id}/cancel-retry-failed")
async def cancel_retry_failed_route(run_id: int) -> dict:
    """Force-cancel an in-flight Retry-failed dispatch.

    The standard `POST /runs/{id}/cancel` short-circuits with
    `already_terminal=True` for runs whose `status` is `done|failed|
    canceled` — which is precisely the state a retry-failed dispatch
    runs against (you can only retry-failed a terminal run). So that
    button can't stop the retry. This endpoint exists for that gap:
    it cancels the asyncio tasks dispatched by `retry_failed_run_now`
    + cleans up stuck-running RDs left behind by task death (uvicorn
    restart, exception, etc.).

    Always returns 200 with a counts envelope so the FE can render
    the same success banner regardless of whether anything was
    actually in flight — operator clicks "Cancel" expecting "stopped",
    not a 4xx because "nothing was running anyway."
    """
    from ..tasks import cancel_retry_failed_now
    result = cancel_retry_failed_now(run_id)
    if result.get("found") is False:
        raise HTTPException(404, "run not found")
    return result


class RetryBatchIn(BaseModel):
    """Scoped retry — pick exact RunDomain ids + (optional) criterion
    allow-list. Added 2026-05-12 to support the Run-page filter + multi-
    select + bulk-retry flow. `criteria=None` means "every enabled
    criterion on the run" (equivalent to the unscoped Retry failed).

    AI override fields mirror ReanalyzeIn — let the user retry under a
    different model than the spec's default.

    `wayback_resample_only` (added 2026-05-13) flips the selection
    semantics for wayback: instead of "retry failed wayback CRs",
    targets wayback CRs with ≥1 V1 row and re-collects V2 samples
    against them. CDX call is skipped — V1 is reused as-is. Caller
    must include "wayback" in `criteria` (or pass None)."""
    run_domain_ids: list[int]
    criteria: list[str] | None = None
    provider: str | None = None
    model: str | None = None
    wayback_resample_only: bool = False


@runs_router.post("/{run_id}/retry-batch")
async def retry_batch_route(run_id: int, body: RetryBatchIn) -> dict:
    """Retry failed criteria on a *subset* of this run's RunDomains,
    optionally narrowed to a subset of criteria.

    Semantics:
      - Only failed criteria are dispatched. A criterion already in
        good shape on a selected RD is skipped (no wasted refetch /
        AI call).
      - When `criteria` is provided, only those in the allow-list are
        considered; the rest are left alone even if they failed.
      - Same terminal-status + busy-RD guards as `/retry-failed`.
    """
    from ..tasks import retry_run_batch_now
    if not body.run_domain_ids:
        raise HTTPException(400, "no run_domain_ids provided")
    override = (
        {"provider": body.provider, "model": body.model}
        if body.provider or body.model
        else None
    )
    result = retry_run_batch_now(
        run_id=run_id,
        run_domain_ids=body.run_domain_ids,
        criteria=body.criteria,
        ai_override=override,
        wayback_resample_only=body.wayback_resample_only,
    )
    if result.get("found") is False:
        raise HTTPException(404, "run not found")
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


@run_domains_router.post("/{run_domain_id}/reanalyze")
async def reanalyze_run_domain_route(
    run_domain_id: int, body: ReanalyzeIn | None = None
) -> dict:
    """Re-judge a single domain's criteria with the AI. Bypasses the AI
    cache. Reuses existing Ahrefs data."""
    from ..tasks import reanalyze_run_domain_now
    override = body.model_dump() if body else None
    result = reanalyze_run_domain_now(run_domain_id, ai_override=override)
    if result.get("found") is False:
        raise HTTPException(404, "run domain not found")
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


class ReanalyzeCriterionIn(BaseModel):
    # Required — one of backlinks/refdomains/anchors/keywords.
    criterion: str
    provider: str | None = None
    model: str | None = None


@run_domains_router.get("/{run_domain_id}/ai-preview/{criterion}")
def ai_preview_route(run_domain_id: int, criterion: str) -> dict:
    """Return exactly what the AI would see if you reanalyzed this
    criterion right now — system prompt + user message + the trimmed row
    set. Pure inspection; doesn't run the AI."""
    from ..tasks import build_ai_preview
    try:
        return build_ai_preview(run_domain_id, criterion)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@run_domains_router.post("/{run_domain_id}/reanalyze-criterion")
async def reanalyze_run_domain_criterion_route(
    run_domain_id: int, body: ReanalyzeCriterionIn
) -> dict:
    """Re-judge a SINGLE criterion on one domain. Other criteria's existing
    verdicts are reused; the final assessment is recomputed. Same in-flight
    set as the per-domain reanalyze, so existing `reanalyzing` polling
    covers it without UI plumbing changes."""
    from ..tasks import reanalyze_run_domain_criterion_now
    override = {"provider": body.provider, "model": body.model}
    result = reanalyze_run_domain_criterion_now(
        run_domain_id, body.criterion, ai_override=override
    )
    if result.get("found") is False:
        raise HTTPException(404, "run domain not found")
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


class PinRunDomainOut(BaseModel):
    run_domain_id: int
    domain: str
    is_pinned: bool


def _upsert_criterion_pins_for_run(
    db: Session, run: Run, criteria: set[str]
) -> int:
    """Helper: upsert (job_id=run.job_id, criterion=C, run_id=run.id) for
    every C in `criteria`. Returns the count of pins overwritten (rows
    that previously pointed at a different run in the same job)."""
    if not criteria:
        return 0
    existing = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == run.job_id)
        .filter(JobCriterionPin.criterion.in_(criteria))
        .all()
    )
    by_crit = {p.criterion: p for p in existing}
    now = datetime.utcnow()
    replaced = 0
    for c in criteria:
        ex = by_crit.get(c)
        if ex is None:
            db.add(JobCriterionPin(
                job_id=run.job_id, criterion=c, run_id=run.id,
            ))
        elif ex.run_id != run.id:
            ex.run_id = run.id
            ex.updated_at = now
            replaced += 1
    return replaced


def _criteria_with_data_for_run(db: Session, run_id: int) -> set[str]:
    """Criteria this run has produced data for (status=='done' or
    non-empty data_json). Drives auto-expansion when a legacy pin
    endpoint fires."""
    rows = (
        db.query(CriterionResult.criterion)
        .join(RunDomain, RunDomain.id == CriterionResult.run_domain_id)
        .filter(RunDomain.run_id == run_id)
        .filter(
            (CriterionResult.status == "done")
            | (CriterionResult.data_json != "")
        )
        .distinct()
        .all()
    )
    return {r[0] for r in rows}


@run_domains_router.post("/{run_domain_id}/pin", response_model=PinRunDomainOut)
def pin_run_domain_route(
    run_domain_id: int, db: Session = Depends(get_db)
) -> PinRunDomainOut:
    """Pin: set per-(job, criterion) pins for every criterion this rd
    has CR data for, pointing at rd.run. Locked 2026-05-14: stopped
    writing the legacy RunDomain.is_pinned column. Read paths that
    still consulted that column (Backlog `linked-to-analyzed-domain`
    lookup, see routers/backlog._resolve_analyzed_links) were migrated
    to read from JobCriterionPin in the same wave."""
    rd = db.get(RunDomain, run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")
    run = db.get(Run, rd.run_id)
    if run is not None:
        rd_crits = {
            cr.criterion for cr in rd.results
            if cr.status == "done" or cr.data_json
        }
        if rd_crits:
            _upsert_criterion_pins_for_run(db, run, rd_crits)
    db.commit()
    # Reflect the pin on the Database page immediately by patching just this
    # domain into the aggregation snapshot. Without it the snapshot keeps
    # serving the pre-pin row until its TTL lapses (up to _ROWS_CACHE_TTL_SEC
    # ~ 5 min) — the "I pinned it but the Database doesn't show it for
    # minutes" bug. Local import avoids a module-load circular (jobs <->
    # database).
    from .database import _patch_domains_in_cache
    _patch_domains_in_cache(db, [rd.domain])
    return PinRunDomainOut(
        run_domain_id=rd.id, domain=rd.domain, is_pinned=True,
    )


@run_domains_router.delete("/{run_domain_id}/pin", response_model=PinRunDomainOut)
def unpin_run_domain_route(
    run_domain_id: int, db: Session = Depends(get_db)
) -> PinRunDomainOut:
    """Unpin: clear any JobCriterionPin where (job=rd.run.job, run=rd.run)
    AND the criterion is one this rd contributed. Idempotent — pins for
    criteria pointing at a different run are left alone (they came from
    another rd's pin action). Locked 2026-05-14 alongside the pin
    endpoint's dual-write removal."""
    rd = db.get(RunDomain, run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")
    run = db.get(Run, rd.run_id)
    if run is not None:
        rd_crits = {
            cr.criterion for cr in rd.results
            if cr.status == "done" or cr.data_json
        }
        if rd_crits:
            (
                db.query(JobCriterionPin)
                .filter(JobCriterionPin.job_id == run.job_id)
                .filter(JobCriterionPin.run_id == run.id)
                .filter(JobCriterionPin.criterion.in_(rd_crits))
                .delete(synchronize_session=False)
            )
    db.commit()
    # Mirror the pin path: patch this domain into the snapshot so the unpin
    # shows on the Database page at once instead of after the TTL. See
    # pin_run_domain_route above.
    from .database import _patch_domains_in_cache
    _patch_domains_in_cache(db, [rd.domain])
    return PinRunDomainOut(
        run_domain_id=rd.id, domain=rd.domain, is_pinned=False,
    )


class PinRunOut(BaseModel):
    """Response for the per-job Run pin endpoints. `is_pinned` is the
    new state of THIS run after the call (true after POST, false after
    DELETE). `previously_pinned_run_id` is the run we unpinned to honor
    the one-pin-per-job invariant — null when no prior pin existed."""
    run_id: int
    job_id: int
    is_pinned: bool
    previously_pinned_run_id: int | None = None


@runs_router.post("/{run_id}/pin", response_model=PinRunOut)
def pin_run_route(
    run_id: int, db: Session = Depends(get_db)
) -> PinRunOut:
    """Pin this Run as the canonical run for its Job. The Job-page L/M/H
    rollup pills will count domains from this run instead of the latest.
    At most one Run per Job can be pinned — pinning a different run in
    the same job clears the old pin in the same transaction.

    Only `done` runs are pinnable. A pending/running/paused/failed/
    canceled run isn't a stable enough definitive source — its counts
    would shift under the user."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    if run.status != "done":
        raise HTTPException(
            400,
            f"only 'done' runs can be pinned (this run is '{run.status}')",
        )
    # Find any other pinned run in the same job (should be at most one
    # if the invariant has held). Clear it first.
    others = (
        db.query(Run)
        .filter(Run.job_id == run.job_id)
        .filter(Run.is_pinned == True)  # noqa: E712
        .filter(Run.id != run.id)
        .all()
    )
    prev_id = others[0].id if others else None
    for o in others:
        o.is_pinned = False
    run.is_pinned = True
    # Per-criterion expansion: pin every criterion this run produced.
    _upsert_criterion_pins_for_run(
        db, run, _criteria_with_data_for_run(db, run.id),
    )
    db.commit()
    # Pinning a run re-points the job's per-criterion pins across the WHOLE
    # job — a potentially large set. This runs on a user request, so kick a
    # NON-BLOCKING background rebuild rather than synthesizing the job's rows
    # inline: a full build is ~20s at the ~20-30K checked-domain scale and must
    # not block the pin request. Coalesced; the stale snapshot is served
    # meanwhile. (The snapshot only ever holds CHECKED domains — never the far
    # larger backlog — so "full" is that bounded set.) Local import dodges a
    # module-load circular.
    from .database import _invalidate_rows_cache
    _invalidate_rows_cache()
    return PinRunOut(
        run_id=run.id,
        job_id=run.job_id,
        is_pinned=True,
        previously_pinned_run_id=prev_id,
    )


@runs_router.delete("/{run_id}/pin", response_model=PinRunOut)
def unpin_run_route(
    run_id: int, db: Session = Depends(get_db)
) -> PinRunOut:
    """Clear the pin from this Run. Idempotent — unpinning an already-
    unpinned run is a no-op. After unpinning, the Job page's rollup
    falls back to the latest run."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    run.is_pinned = False
    db.commit()
    # Same job-wide reshaping as pinning, on a user request → non-blocking
    # background rebuild (never block the request on a ~20s full build). See
    # pin_run_route above.
    from .database import _invalidate_rows_cache
    _invalidate_rows_cache()
    return PinRunOut(
        run_id=run.id,
        job_id=run.job_id,
        is_pinned=False,
    )


# --- Per-run scoring-weights override (added 2026-05-13 wave J) -------------
# Three sibling endpoints that share the same recompute path in
# `tasks.recompute_run_finals`:
#   POST /runs/{id}/preview-final     — recompute without writing
#   POST /runs/{id}/recompute-final   — recompute + persist override
#   DELETE /runs/{id}/recompute-final — clear override + recompute with global
#
# Body shape for the POST endpoints: {"weights": {<criterion>: <float>, ...}}.
# Weights are accepted in 0..1 (Shape A — sum-to-1 sliders on the UI) and
# validated the same way as the global Settings endpoint. Excluding a
# criterion = weight 0; `compute_final` renormalizes over what's left.

class RecomputeFinalIn(BaseModel):
    weights: dict[str, float]


class RecomputeFinalRowOut(BaseModel):
    run_domain_id: int
    domain: str
    score_old: float | None
    score_new: float | None
    confidence_new: float | None
    bucket_new: str
    partial: bool


class RecomputeFinalOut(BaseModel):
    run_id: int
    preview: bool
    weights_applied: dict[str, float]
    override_active: bool
    rows: list[RecomputeFinalRowOut]


_RECOMPUTE_ALLOWED_CRITERIA: tuple[str, ...] = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify",
)


def _validate_recompute_weights(weights: dict[str, float]) -> dict[str, float]:
    """Coerce + validate the incoming weights dict. Drops unknown keys
    (forward-compat), rejects non-numeric values + negatives, and enforces
    sum>0. The UI uses Shape A (sum-to-1 inputs) but we don't STRICTLY
    enforce sum==1 here — `compute_final` renormalizes internally, so a
    tolerant validator means rounding noise (e.g. 0.4 + 0.2 + 0.3 + 0.1 +
    0.0 + 0.0 = 1.0000000000000002) doesn't reject an otherwise-fine
    request. The frontend shows the live sum so the user can see it
    explicitly without the backend gatekeeping."""
    out: dict[str, float] = {}
    for c in _RECOMPUTE_ALLOWED_CRITERIA:
        v = weights.get(c)
        if v is None:
            out[c] = 0.0
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"weights.{c} must be a number")
        f = float(v)
        if f < 0:
            raise ValueError(f"weights.{c} must be non-negative")
        if f > 1:
            raise ValueError(f"weights.{c} must be in 0..1")
        out[c] = f
    if sum(out.values()) <= 0:
        raise ValueError("at least one weight must be > 0")
    return out


@runs_router.post(
    "/{run_id}/preview-final", response_model=RecomputeFinalOut,
)
def preview_run_final(
    run_id: int, body: RecomputeFinalIn,
) -> RecomputeFinalOut:
    """Recompute every non-partial rd's final score in `run_id` using
    the supplied weights. Pure preview — no DB writes. Returns the
    per-domain old→new table so the UI can render a diff before the user
    commits to applying the weights."""
    try:
        clean = _validate_recompute_weights(body.weights)
    except ValueError as e:
        raise HTTPException(400, str(e))
    from ..tasks import recompute_run_finals
    try:
        result = recompute_run_finals(run_id, clean, preview=True)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return RecomputeFinalOut(**result)


@runs_router.post(
    "/{run_id}/recompute-final", response_model=RecomputeFinalOut,
)
def recompute_run_final(
    run_id: int, body: RecomputeFinalIn,
) -> RecomputeFinalOut:
    """Persist the supplied weights as this run's `scoring_override_json`
    and rewrite every non-partial rd's final_assessment_json /
    final_summary using `compute_final` against the existing
    sub-verdicts. The AI-written prose (summary, recommendation) is
    left untouched — only the `final` and `confidence` numeric fields
    are replaced. Partial rds (whose existing final is the
    `{"partial": true}` stub) are skipped."""
    try:
        clean = _validate_recompute_weights(body.weights)
    except ValueError as e:
        raise HTTPException(400, str(e))
    from ..tasks import recompute_run_finals
    try:
        result = recompute_run_finals(run_id, clean, preview=False)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return RecomputeFinalOut(**result)


@runs_router.delete(
    "/{run_id}/recompute-final", response_model=RecomputeFinalOut,
)
def reset_run_final(run_id: int) -> RecomputeFinalOut:
    """Clear this run's `scoring_override_json` and recompute every
    rd's final using the CURRENT global Settings weights. If global
    Settings haven't changed since the original synth, this restores
    the exact original scores; if they have, the rd finals will match
    the new global config. Either way, the run is no longer in an
    override state — `scoring_override` returns null in `/runs/{id}`."""
    from ..tasks import recompute_run_finals
    try:
        result = recompute_run_finals(run_id, None, preview=False)
    except LookupError as e:
        raise HTTPException(404, str(e))
    return RecomputeFinalOut(**result)


# --- Per-(job, criterion) pins (added 2026-05-12) ---------------------------
# Replaces the older Run.is_pinned / RunDomain.is_pinned model for the
# Database-page rollup. Each pin says "for this Job, criterion C is sourced
# from Run R." Multiple criteria within one job can point at different runs
# — supports iterative cascade (Wayback first, Ahrefs later, etc.).

CRITERIA_NAMES = (
    "backlinks",
    "refdomains",
    "anchors",
    "keywords",
    "wayback",
    "wayback_classify",
    # whois_history (added 2026-05-15 Wave 2 follow-up). Lets the
    # Whois job's run page expose the same per-criterion pin UI as
    # Quality jobs — the panel auto-filters by which criteria have
    # data on the run, so Quality runs still show B/D/A/K/W/C only
    # and whois runs show just H.
    "whois_history",
    # availability (added 2026-05-15 Wave 3). Same data-driven
    # filter handles the rest — Availability runs surface just V on
    # the pin panel; Quality / Whois runs don't show it.
    "availability",
)


class CriterionPinIn(BaseModel):
    criterion: str
    run_id: int


class CriterionPinOut(BaseModel):
    job_id: int
    criterion: str
    run_id: int
    pinned: bool


class CriterionPinsListItem(BaseModel):
    criterion: str
    run_id: int
    run_name: str = ""
    run_finished_at: datetime | None = None


class CriterionPinsListOut(BaseModel):
    job_id: int
    pins: list[CriterionPinsListItem]


@router.get(
    "/{job_id}/criterion-pins", response_model=CriterionPinsListOut
)
def list_criterion_pins(
    job_id: int, db: Session = Depends(get_db),
) -> CriterionPinsListOut:
    """Return every (criterion, run) currently pinned for this Job."""
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    rows = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == job_id)
        .all()
    )
    run_ids = {r.run_id for r in rows}
    runs = {
        r.id: r
        for r in (
            db.query(Run).filter(Run.id.in_(run_ids)).all() if run_ids else []
        )
    }
    items: list[CriterionPinsListItem] = []
    for p in rows:
        r = runs.get(p.run_id)
        items.append(CriterionPinsListItem(
            criterion=p.criterion,
            run_id=p.run_id,
            run_name=(r.name or "") if r else "",
            run_finished_at=(r.finished_at if r else None),
        ))
    items.sort(key=lambda i: i.criterion)
    return CriterionPinsListOut(job_id=job_id, pins=items)


# Above this many affected domains, an inline re-synthesis would stall the
# pin endpoint (a 25k-domain run's patch ≈ a near-full rebuild), so we fall
# back to a non-blocking background rebuild instead. Below it, the inline
# patch makes the pin show on /database instantly. ~1000 domains
# re-synthesizes in ~1-2s — an acceptable cost for a deliberate pin click.
_MAX_SYNC_PATCH_DOMAINS = 1000


def _patch_database_cache_for_runs(db: Session, run_ids: set[int]) -> None:
    """After a criterion-pin change here, refresh the Database rows snapshot
    for exactly the domains whose row synthesis the change touches — those in
    the affected runs (the newly-pinned run, and any run a pin moved AWAY
    from, whose domains now resolve that criterion elsewhere). Mirrors
    `database.py:pin_domain`/`unpin_domain`, which patch their own per-domain
    pins; without this, a Jobs-page pin change only shows on /database after
    the ~tens-of-seconds background rebuild.

    For a modest number of affected domains the patch is inline (instant on
    /database). Beyond `_MAX_SYNC_PATCH_DOMAINS` it would stall the endpoint
    (re-synthesizing tens of thousands of rows ≈ a full rebuild), so it falls
    back to a non-blocking background rebuild — the pin then lands on the next
    snapshot, same as any external change.

    Best-effort: a failure just leaves the snapshot to self-heal on its TTL /
    next background rebuild — never break the pin write over a cache refresh."""
    run_ids = {r for r in run_ids if r}
    if not run_ids:
        return
    try:
        domains = [
            d for (d,) in db.query(RunDomain.domain)
            .filter(RunDomain.run_id.in_(run_ids))
            .distinct()
            .all()
        ]
        if not domains:
            return
        from .database import (
            _patch_domains_in_cache,
            _trigger_background_rebuild,
        )
        if len(domains) > _MAX_SYNC_PATCH_DOMAINS:
            # Too many to re-synthesize inline without stalling the request.
            _trigger_background_rebuild()
            return
        _patch_domains_in_cache(db, domains)
    except Exception:  # noqa: BLE001
        log.exception(
            "Database rows-cache patch after pin change failed (run_ids=%s); "
            "snapshot will self-heal on the next background rebuild", run_ids,
        )


@router.post(
    "/{job_id}/criterion-pins", response_model=CriterionPinOut
)
def set_criterion_pin(
    job_id: int, payload: CriterionPinIn, db: Session = Depends(get_db),
) -> CriterionPinOut:
    """Upsert pin for (job, criterion) → run.

    Validates: criterion ∈ CRITERIA_NAMES; run belongs to this job; run is
    in 'done' status (pinning an unfinished run yields shifting data).
    """
    if payload.criterion not in CRITERIA_NAMES:
        raise HTTPException(400, f"unknown criterion: {payload.criterion}")
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    run = db.get(Run, payload.run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    if run.job_id != job_id:
        raise HTTPException(
            400, f"run {run.id} does not belong to job {job_id}",
        )
    if run.status != "done":
        raise HTTPException(
            400, f"only 'done' runs can be pinned (this run is '{run.status}')",
        )
    existing = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == job_id)
        .filter(JobCriterionPin.criterion == payload.criterion)
        .one_or_none()
    )
    prev_run_id = existing.run_id if existing is not None else 0
    if existing is None:
        db.add(JobCriterionPin(
            job_id=job_id,
            criterion=payload.criterion,
            run_id=payload.run_id,
        ))
    else:
        existing.run_id = payload.run_id
        existing.updated_at = datetime.utcnow()
    db.commit()
    # Reflect the pin on /database immediately: patch the newly-pinned run's
    # domains, plus the run this pin moved away from (their criterion source
    # flips), instead of waiting for the background rebuild.
    affected = {payload.run_id}
    if prev_run_id and prev_run_id != payload.run_id:
        affected.add(prev_run_id)
    _patch_database_cache_for_runs(db, affected)
    return CriterionPinOut(
        job_id=job_id,
        criterion=payload.criterion,
        run_id=payload.run_id,
        pinned=True,
    )


@router.delete(
    "/{job_id}/criterion-pins/{criterion}", response_model=CriterionPinOut
)
def clear_criterion_pin(
    job_id: int, criterion: str, db: Session = Depends(get_db),
) -> CriterionPinOut:
    """Clear pin for (job, criterion). Idempotent."""
    if criterion not in CRITERIA_NAMES:
        raise HTTPException(400, f"unknown criterion: {criterion}")
    existing = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == job_id)
        .filter(JobCriterionPin.criterion == criterion)
        .one_or_none()
    )
    prev_run_id = existing.run_id if existing else 0
    if existing is not None:
        db.delete(existing)
        db.commit()
        # Reflect the unpin on /database immediately: the formerly-pinned
        # run's domains re-resolve this criterion (fallback or blank).
        _patch_database_cache_for_runs(db, {prev_run_id})
    return CriterionPinOut(
        job_id=job_id, criterion=criterion, run_id=prev_run_id, pinned=False,
    )


class PinRunCriteriaOut(BaseModel):
    """Response for the bulk per-run pin-all-populated endpoint."""
    run_id: int
    job_id: int
    pinned_criteria: list[str]  # criteria now pointing at this run
    replaced: int  # criterion-pins on other runs in this job that were overwritten


@runs_router.post(
    "/{run_id}/pin-all-criteria", response_model=PinRunCriteriaOut
)
def pin_run_all_criteria(
    run_id: int, db: Session = Depends(get_db),
) -> PinRunCriteriaOut:
    """Pin every criterion this run produced data for, in its Job context.

    For each criterion C this run has a populated CriterionResult for
    (`status=='done'` OR non-empty data_json), upsert (job_id=run.job_id,
    criterion=C, run_id=run_id). Pre-existing pins for the same (job, C)
    pointing at a different run are replaced.

    Only `done` runs are pinnable — the same invariant as the older
    Run.is_pinned pin endpoint.
    """
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    if run.status != "done":
        raise HTTPException(
            400, f"only 'done' runs can be pinned (this run is '{run.status}')",
        )
    crits = (
        db.query(CriterionResult.criterion)
        .join(RunDomain, RunDomain.id == CriterionResult.run_domain_id)
        .filter(RunDomain.run_id == run_id)
        .filter(
            (CriterionResult.status == "done")
            | (CriterionResult.data_json != "")
        )
        .distinct()
        .all()
    )
    crit_set = {r[0] for r in crits if r[0] in CRITERIA_NAMES}
    if not crit_set:
        return PinRunCriteriaOut(
            run_id=run_id, job_id=run.job_id, pinned_criteria=[], replaced=0,
        )
    existing = (
        db.query(JobCriterionPin)
        .filter(JobCriterionPin.job_id == run.job_id)
        .filter(JobCriterionPin.criterion.in_(crit_set))
        .all()
    )
    existing_by_crit: dict[str, JobCriterionPin] = {p.criterion: p for p in existing}
    replaced = 0
    replaced_run_ids: set[int] = set()
    now = datetime.utcnow()
    for c in crit_set:
        ex = existing_by_crit.get(c)
        if ex is None:
            db.add(JobCriterionPin(job_id=run.job_id, criterion=c, run_id=run_id))
        elif ex.run_id != run_id:
            replaced_run_ids.add(ex.run_id)
            ex.run_id = run_id
            ex.updated_at = now
            replaced += 1
    db.commit()
    # Reflect on /database immediately: this run's domains, plus any runs
    # whose criterion-pins were overwritten here.
    _patch_database_cache_for_runs(db, {run_id} | replaced_run_ids)
    return PinRunCriteriaOut(
        run_id=run_id,
        job_id=run.job_id,
        pinned_criteria=sorted(crit_set),
        replaced=replaced,
    )


@runs_router.get("/{run_id}/status", response_model=RunStatus)
def get_run_status(run_id: int, db: Session = Depends(get_db)) -> RunStatus:
    """Compact polling payload — used by the Analyze page's progress bar
    and the Jobs page's status pills. Cheap query, suitable for a 1–2 s
    polling cadence."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    # SQL GROUP BY instead of hydrating run.domains (2026-06-17). This is a
    # 1-2s polling endpoint; the ORM walk loaded every RunDomain of a 60k+
    # run on each poll (~290 MB of unreclaimable pymalloc per call). Counts
    # straight off the (run_id, status) index instead.
    counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
    total = 0
    for status, cnt in (
        db.query(RunDomain.status, sqla_func.count(RunDomain.id))
        .filter(RunDomain.run_id == run_id)
        .group_by(RunDomain.status)
        .all()
    ):
        n = int(cnt)
        total += n
        counts[status] = counts.get(status, 0) + n
    from ..tasks import is_reanalyzing_run
    return RunStatus(
        id=run.id,
        status=run.status,
        total=total,
        reanalyzing=is_reanalyzing_run(run.id),
        **counts,
    )


@runs_router.get("/{run_id}/ahrefs-batch-analysis.csv")
def export_ahrefs_batch_analysis_csv(run_id: int, db: Session = Depends(get_db)):
    """Stream the full domain × metrics table for an ahrefs_batch_analysis
    run as CSV. Streamed + chunked at the DB layer so a 100k-domain run
    exports without loading every row into memory. Columns are derived
    from the run's spec (selected metrics, canonical order)."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    from ..providers.ahrefs_batch import BATCH_METRICS, canonical_metrics

    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")

    # Selected metrics drive the columns. Fall back to all known metrics
    # if the spec is missing/old so we never silently drop data.
    try:
        spec = AnalyzeSpec.model_validate_json(run.spec_json or "{}")
        metrics = canonical_metrics(spec.criteria.ahrefs_batch_analysis.metrics)
    except Exception:  # noqa: BLE001
        metrics = []
    if not metrics:
        metrics = list(BATCH_METRICS.keys())

    header = ["domain", "status"] + [BATCH_METRICS.get(m, m) for m in metrics]

    def _rows():
        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(header)
        yield _flush()

        # Page through RunDomains in id order, joining the latest
        # batch-analysis CR per domain. selectinload keeps it to O(page)
        # queries instead of N+1.
        PAGE = 1000
        offset = 0
        while True:
            page = (
                db.query(RunDomain)
                .filter(RunDomain.run_id == run_id)
                .order_by(RunDomain.id.asc())
                .options(selectinload(RunDomain.results))
                .offset(offset)
                .limit(PAGE)
                .all()
            )
            if not page:
                break
            for rd in page:
                latest = max(
                    (
                        cr for cr in rd.results
                        if cr.criterion == "ahrefs_batch_analysis"
                    ),
                    key=lambda cr: cr.id,
                    default=None,
                )
                values: dict[str, float | None] = {}
                if latest is not None and latest.data_json:
                    try:
                        body = json.loads(latest.data_json)
                        m = body.get("metrics")
                        if isinstance(m, dict):
                            values = m
                    except json.JSONDecodeError:
                        pass
                row = [rd.domain, rd.status]
                for mid in metrics:
                    v = values.get(mid)
                    if v is None:
                        row.append("")
                    elif mid == "domain_rating":
                        row.append(f"{float(v):.1f}")
                    else:
                        row.append(str(int(v)))
                writer.writerow(row)
            yield _flush()
            offset += PAGE

    filename = f"ahrefs-batch-analysis-run-{run_id}.csv"
    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/{run_id}/linked-domains.csv")
def export_linked_domains_csv(
    run_id: int, scope: str = "new", db: Session = Depends(get_db)
):
    """Stream a linked_domains run's unique linked domains as CSV.

    scope='new' (the DEFAULT, 2026-07-10 per user): only domains that NO
    EARLIER run (smaller run_id) had ever collected — "what did this run
    newly discover". The batch workflow feeds each run's fresh finds
    downstream, so re-exporting the ~90% overlap with prior runs was
    noise. scope='all' returns every unique domain in the run regardless
    of history (the original behavior).

    Both scopes stream via yield_per (flat memory). The new-only filter
    is an anti-join probing the (linked_domain, run_id) composite index
    per candidate domain, so it stays index-served at scale."""
    import csv
    import io

    from fastapi.responses import StreamingResponse
    from sqlalchemy import and_, exists
    from sqlalchemy.orm import aliased

    from ..models import LinkedDomainRow

    if scope not in ("new", "all"):
        raise HTTPException(400, "scope must be 'new' or 'all'")
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")

    def _rows():
        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(["linked_domain"])
        yield _flush()

        q = db.query(LinkedDomainRow.linked_domain).filter(
            LinkedDomainRow.run_id == run_id
        )
        if scope == "new":
            prior = aliased(LinkedDomainRow)
            q = q.filter(
                ~exists().where(and_(
                    prior.linked_domain == LinkedDomainRow.linked_domain,
                    prior.run_id < run_id,
                ))
            )
        q = (
            q.distinct()
            .order_by(LinkedDomainRow.linked_domain)
            .yield_per(1000)
        )
        n = 0
        for (dom,) in q:
            writer.writerow([dom])
            n += 1
            if n % 1000 == 0:
                yield _flush()
        yield _flush()

    suffix = "-new" if scope == "new" else ""
    filename = f"linked-domains-run-{run_id}{suffix}.csv"
    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/{run_id}/serp-overview.csv")
def export_serp_overview_csv(run_id: int, db: Session = Depends(get_db)):
    """Stream a serp_overview run's (keyword, position, url) rows as CSV,
    ordered by keyword then SERP position. Served off the
    (run_id, keyword) composite index with yield_per, so even a
    500-keyword × 100-URL run exports with flat memory."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    from ..models import SerpOverviewRow

    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")

    def _rows():
        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(["keyword", "position", "url"])
        yield _flush()

        q = (
            db.query(
                SerpOverviewRow.keyword,
                SerpOverviewRow.position,
                SerpOverviewRow.url,
            )
            .filter(SerpOverviewRow.run_id == run_id)
            .order_by(SerpOverviewRow.keyword, SerpOverviewRow.position)
            .yield_per(1000)
        )
        n = 0
        for kw, pos, u in q:
            writer.writerow([kw, pos if pos is not None else "", u])
            n += 1
            if n % 1000 == 0:
                yield _flush()
        yield _flush()

    filename = f"serp-overview-run-{run_id}.csv"
    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/{run_id}/serp-overview-domains.csv")
def export_serp_overview_domains_csv(
    run_id: int, tlds: str = "all", db: Session = Depends(get_db)
):
    """Unique ranking DOMAINS across every keyword of a serp_overview run —
    the 'just give me the domains' companion to the full keyword/position/url
    export. Domain = URL hostname, lowercased, leading `www.` stripped
    (no public-suffix collapsing — blog.example.com stays distinct from
    example.com). Deduped across the whole run, sorted A→Z.

    `tlds=allowed` keeps only domains whose TLD is in the Settings
    allowed-TLDs list (read-time filter — stored data stays complete)."""
    import csv
    import io
    from urllib.parse import urlsplit

    from fastapi.responses import StreamingResponse

    from ..models import SerpOverviewRow

    if tlds not in ("all", "allowed"):
        raise HTTPException(400, "tlds must be 'all' or 'allowed'")
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    matcher = None
    if tlds == "allowed":
        from ..allowed_tlds import make_tld_matcher
        from ..app_settings import get_allowed_tlds
        matcher = make_tld_matcher(get_allowed_tlds())

    def _rows():
        hosts: set[str] = set()
        q = (
            db.query(SerpOverviewRow.url)
            .filter(SerpOverviewRow.run_id == run_id)
            .yield_per(1000)
        )
        for (u,) in q:
            try:
                host = (urlsplit(u or "").hostname or "").lower()
            except ValueError:
                host = ""
            if host.startswith("www."):
                host = host[4:]
            if host and (matcher is None or matcher(host)):
                hosts.add(host)

        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(["domain"])
        yield _flush()
        n = 0
        for host in sorted(hosts):
            writer.writerow([host])
            n += 1
            if n % 1000 == 0:
                yield _flush()
        yield _flush()

    filename = f"serp-overview-domains-run-{run_id}.csv"
    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/{run_id}/availability.csv")
def export_availability_csv(run_id: int, db: Session = Depends(get_db)):
    """Stream an availability run's domain × verdict table as CSV.
    Streamed + chunked at the DB layer (1000 rows/page) so a 100k-domain
    run exports without loading every row into memory — the server-side
    counterpart of the old client-side CSV, needed now that the
    availability Run page paginates server-side and never holds the full
    set. Verdict comes from the LATEST availability CR per domain (same
    `max(cr.id)` duplicate-guard the page uses)."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "run not found")

    header = ["domain", "status", "availability_status", "error"]

    def _rows():
        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(header)
        yield _flush()

        PAGE = 1000
        offset = 0
        while True:
            page = (
                db.query(RunDomain)
                .filter(RunDomain.run_id == run_id)
                .order_by(RunDomain.id.asc())
                .options(selectinload(RunDomain.results))
                .offset(offset)
                .limit(PAGE)
                .all()
            )
            if not page:
                break
            for rd in page:
                latest = max(
                    (cr for cr in rd.results if cr.criterion == "availability"),
                    key=lambda cr: cr.id,
                    default=None,
                )
                verdict_status = ""
                if latest is not None and latest.data_json:
                    try:
                        body = json.loads(latest.data_json)
                        v = body.get("verdict")
                        if isinstance(v, dict) and isinstance(
                            v.get("status"), str
                        ):
                            verdict_status = v["status"]
                    except json.JSONDecodeError:
                        pass
                writer.writerow(
                    [rd.domain, rd.status, verdict_status, rd.error or ""]
                )
            yield _flush()
            offset += PAGE

    filename = f"availability-run-{run_id}.csv"
    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@runs_router.get("/{run_id}/domain-ids")
def get_run_domain_ids(
    run_id: int,
    db: Session = Depends(get_db),
    status_filter: str | None = None,
    availability_status_filter: list[str] | None = Query(None),
    domain_filter: str | None = None,
) -> dict:
    """Every RunDomain id matching the current Run-page filters (status +
    availability verdict + domain substring), in stable id order. Powers
    "select all matching" on the server-paginated Run page, where the
    frontend can no longer derive the full matching set from the in-memory
    page. Ids-only keeps it light (~400 KB even at 100k rows) and it's
    fetched lazily — only when the user clicks the link."""
    run = db.query(Run).filter(Run.id == run_id).one_or_none()
    if run is None:
        raise HTTPException(404, "run not found")
    q = _run_domain_filter_q(
        db, run.id,
        status_filter=status_filter,
        availability_status_filter=availability_status_filter,
        domain_filter=domain_filter,
    )
    ids = [
        rid
        for (rid,) in q.with_entities(RunDomain.id)
        .order_by(RunDomain.id.asc())
        .all()
    ]
    return {"ids": ids, "count": len(ids)}


@runs_router.get("/{run_id}/events")
async def stream_run_events(run_id: int):
    """Server-Sent Events stream of run status. Wraps `get_run_status`
    on a server-side timer so the frontend can subscribe via
    `EventSource` instead of polling. Cuts request volume from N/sec to
    1 long-lived connection per active run.

    Stream stops automatically once the run reaches a terminal state
    (done / failed / canceled) and emits one final event before closing
    so the client gets a clean disconnect.

    Falls back gracefully: if the client can't or doesn't use
    EventSource (e.g. behind a strict proxy that buffers), nothing
    breaks — they keep polling `/status` as before."""
    import asyncio
    import json as _json

    from fastapi.responses import StreamingResponse

    POLL_INTERVAL_SEC = 1.0
    # Hard cap: even if the run never terminates (bug?), drop the
    # connection after ~30 minutes so a stuck client doesn't hold the
    # API socket forever.
    MAX_DURATION_SEC = 1800

    async def gen():
        # Use a fresh session per tick — the request-scoped session
        # would close as soon as we yield.
        from ..db import SessionLocal as _SessionLocal
        from ..tasks import is_reanalyzing_run

        terminal = {"done", "failed", "canceled"}
        elapsed = 0.0
        while elapsed < MAX_DURATION_SEC:
            db = _SessionLocal()
            try:
                run = db.get(Run, run_id)
                if run is None:
                    yield f"event: error\ndata: {_json.dumps({'detail': 'run not found'})}\n\n"
                    return
                # SQL GROUP BY instead of hydrating run.domains every tick
                # (2026-06-17). This SSE loop re-counted by walking the full
                # ORM collection on each push — a per-tick 60k-row hydration
                # for the life of the stream.
                counts = {
                    "pending": 0, "running": 0, "done": 0, "failed": 0,
                }
                total = 0
                for status, cnt in (
                    db.query(RunDomain.status, sqla_func.count(RunDomain.id))
                    .filter(RunDomain.run_id == run_id)
                    .group_by(RunDomain.status)
                    .all()
                ):
                    n = int(cnt)
                    total += n
                    counts[status] = counts.get(status, 0) + n
                payload = {
                    "id": run.id,
                    "status": run.status,
                    "total": total,
                    "reanalyzing": is_reanalyzing_run(run.id),
                    **counts,
                }
                yield f"data: {_json.dumps(payload)}\n\n"
                if run.status in terminal:
                    return
            finally:
                db.close()
            await asyncio.sleep(POLL_INTERVAL_SEC)
            elapsed += POLL_INTERVAL_SEC

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            # Disable nginx/Caddy proxy buffering so events flush as
            # they're emitted, not when the buffer fills.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
