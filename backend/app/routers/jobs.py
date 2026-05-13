"""Jobs / runs endpoints.

Job-level actions (rename, notes, delete, rerun) and the run-domain detail
endpoint live here. The Analyze submit endpoint stays in routers/analyze.py
since it's part of the analyze-flow surface."""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
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


class RunDetail(BaseModel):
    id: int
    name: str = ""
    job_id: int
    job_name: str
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str
    spec_json: str
    domains: list[RunDomainProgress]
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


# --- Helpers ----------------------------------------------------------------

def _summarize_run(run: Run) -> RunSummary:
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


# --- Job endpoints ----------------------------------------------------------

@router.get("/")
def list_jobs(
    archived: str = "active",
    db: Session = Depends(get_db),
) -> dict:
    """List jobs.

    `archived` filter:
    - "active" (default): only jobs with archived_at IS NULL
    - "archived": only archived jobs
    - "all": both
    """
    q = db.query(Job)
    if archived == "active":
        q = q.filter(Job.archived_at.is_(None))
    elif archived == "archived":
        q = q.filter(Job.archived_at.is_not(None))
    elif archived != "all":
        raise HTTPException(400, "archived must be one of: active, archived, all")
    rows = q.order_by(Job.id.desc()).limit(500).all()
    return {
        "jobs": [
            {
                "id": j.id,
                "name": j.name,
                "notes": j.notes,
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
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    # Roll up verdict counts. Source-of-truth rule (added 2026-05-10):
    # if the user pinned a run for this job, count from that run; else
    # fall back to the latest run (max(Run.id) — chronological since
    # runs are insertion-ordered). The pin pattern mirrors per-domain
    # pinning: at most one run per job is pinned, enforced at the pin
    # endpoint inside one transaction.
    from ..app_settings import get_scoring_config
    from .database import _bucket_for
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
        for d in source_run.domains:
            parsed: dict | None = None
            if d.final_assessment_json:
                try:
                    parsed = json.loads(d.final_assessment_json)
                except json.JSONDecodeError:
                    parsed = None
            if isinstance(parsed, dict) and parsed.get("partial"):
                key = "partial"
            else:
                bucket = _bucket_for(
                    parsed, d.final_summary or "",
                    good_threshold=good_t, mixed_threshold=mixed_t,
                )
                key = bucket or "no_verdict"
            counts[key] = counts.get(key, 0) + 1
    return JobDetail(
        id=job.id,
        name=job.name,
        notes=job.notes,
        created_at=job.created_at,
        updated_at=job.updated_at,
        archived_at=job.archived_at,
        runs=[_summarize_run(r) for r in job.runs],
        latest_run_verdict_counts=counts,
        # `latest_run_id` reports the run the counts actually came from
        # (pinned when set, else newest). Frontend cross-references with
        # `pinned_run_id` to pick the pill label ("Pinned" vs "Latest").
        latest_run_id=source_run.id if source_run else None,
        pinned_run_id=pinned_run.id if pinned_run else None,
    )


@router.get("/{job_id}/spec")
def get_job_spec(job_id: int, db: Session = Depends(get_db)) -> dict:
    """The latest AnalyzeSpec for this job — used by the Analyze page to
    prefill the form when rerunning."""
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
    db.delete(job)
    db.commit()
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
    for j in found:
        db.delete(j)
    if found:
        db.commit()
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
    enabled_count = sum(
        1
        for k in (
            "backlinks", "refdomains", "anchors", "keywords",
            "wayback", "wayback_classify",
        )
        if getattr(payload.spec.criteria, k).enabled
    )
    if enabled_count == 0:
        raise HTTPException(400, "at least one criterion must be enabled")

    norm_spec = AnalyzeSpec(
        domains=cleaned,
        criteria=payload.spec.criteria,
        ai=payload.spec.ai,
        use_cache=payload.spec.use_cache,
        cross_job_cache=payload.spec.cross_job_cache,
        # Preserve the UI language. Same fix as the /analyze/jobs path —
        # without this, reruns silently fall back to lang="en".
        lang=payload.spec.lang,
    )
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

@runs_router.get("/{run_id}", response_model=RunDetail)
def get_run(run_id: int, db: Session = Depends(get_db)) -> RunDetail:
    # Eager-load Run → RunDomains → CriterionResults in one IN-list
    # query each instead of lazy-loading per-domain (regression observed
    # 2026-05-12 with a 352-domain run — N+1 became 700+ SQLite
    # roundtrips and the endpoint timed out at 15s, freezing the Run
    # page). `selectinload` issues 3 queries total: Run, RunDomains,
    # CriterionResults. The per-domain loop below accesses .results
    # purely from the populated collection.
    run = (
        db.query(Run)
        .options(selectinload(Run.domains).selectinload(RunDomain.results))
        .filter(Run.id == run_id)
        .one_or_none()
    )
    if run is None:
        raise HTTPException(404, "run not found")

    from ..app_settings import get_scoring_config
    from ..tasks import is_reanalyzing_run, is_reanalyzing_run_domain
    from .database import _bucket_for, _parse_final_confidence, _parse_final_score
    sc = get_scoring_config()
    good_t = sc["good_threshold"]
    mixed_t = sc["mixed_threshold"]
    # Run-level reanalyze applies to every RD in the run. Cache once per
    # request so we don't re-check the TaskMap N times.
    run_reanalyzing = is_reanalyzing_run(run.id)
    progress: list[RunDomainProgress] = []
    for d in run.domains:
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
                reanalyzing=run_reanalyzing or is_reanalyzing_run_domain(d.id),
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
            )
        )
    from ..tasks import get_run_scoring_override
    return RunDetail(
        id=run.id,
        name=run.name or "",
        job_id=run.job_id,
        job_name=run.job.name,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error=run.error,
        spec_json=run.spec_json,
        domains=progress,
        scoring_override=get_run_scoring_override(run.id),
    )


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
    for criterion_name in ("backlinks", "refdomains", "anchors", "keywords", "wayback", "wayback_classify"):
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
        if not d.final_assessment_json:
            return None
        try:
            return json.loads(d.final_assessment_json)
        except json.JSONDecodeError:
            return None

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

    from ..tasks import is_reanalyzing_run, is_reanalyzing_run_domain
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
    cost_payload = {
        "total_cost_usd": round(cost_total, 6),
        "total_input_tokens": cost_in,
        "total_output_tokens": cost_out,
        "fresh_calls": cost_fresh,
        "cache_hits": cost_cache,
        "missing_pricing": cost_missing,
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
        "reanalyzing": is_reanalyzing_run_domain(rd.id)
        or is_reanalyzing_run(rd.run_id),
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


@runs_router.get("/{run_id}/summary")
def get_run_summary(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Compact payload for the Analyze page's summary table — one row per
    domain with criterion verdicts + final summary. Doesn't include raw
    Ahrefs rows (use /run-domains/{id} for that)."""
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
            per_crit[cr.criterion] = (
                {
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
            )
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
        ("backlinks", "refdomains", "anchors", "keywords")
    )
    ahrefs_units_billed = 0
    ahrefs_units_list = 0
    ahrefs_fresh_calls = 0
    ahrefs_cached_calls = 0
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
    """Mark this RunDomain as the definitive source for its `domain` on
    the Database page. Clears any other pin for the same domain so the
    "at most one pinned per domain" invariant holds.

    Also expands into per-(job, criterion) pins (added 2026-05-12): for
    every criterion this rd has CR data for, sets (job_id=rd.run.job_id,
    criterion=C, run_id=rd.run_id). Keeps the legacy per-domain pin
    button functional after the Database rollup rewrite — the user can
    keep clicking the same "Pin" affordance and the new Database page
    aggregation will source criteria from this rd's run."""
    rd = db.get(RunDomain, run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")
    others = (
        db.query(RunDomain)
        .filter(RunDomain.domain == rd.domain)
        .filter(RunDomain.is_pinned == True)  # noqa: E712
        .filter(RunDomain.id != rd.id)
        .all()
    )
    for o in others:
        o.is_pinned = False
    rd.is_pinned = True
    # Per-criterion expansion. Only criteria this rd has CR data for —
    # avoids overwriting another run's pin with one that wouldn't
    # actually provide data for the criterion.
    run = db.get(Run, rd.run_id)
    if run is not None:
        rd_crits = {
            cr.criterion for cr in rd.results
            if cr.status == "done" or cr.data_json
        }
        _upsert_criterion_pins_for_run(db, run, rd_crits)
    db.commit()
    return PinRunDomainOut(
        run_domain_id=rd.id, domain=rd.domain, is_pinned=True,
    )


@run_domains_router.delete("/{run_domain_id}/pin", response_model=PinRunDomainOut)
def unpin_run_domain_route(
    run_domain_id: int, db: Session = Depends(get_db)
) -> PinRunDomainOut:
    """Clear the pin from this RunDomain. Idempotent."""
    rd = db.get(RunDomain, run_domain_id)
    if rd is None:
        raise HTTPException(404, "run domain not found")
    rd.is_pinned = False
    db.commit()
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
    now = datetime.utcnow()
    for c in crit_set:
        ex = existing_by_crit.get(c)
        if ex is None:
            db.add(JobCriterionPin(job_id=run.job_id, criterion=c, run_id=run_id))
        elif ex.run_id != run_id:
            ex.run_id = run_id
            ex.updated_at = now
            replaced += 1
    db.commit()
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
    counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
    for d in run.domains:
        counts[d.status] = counts.get(d.status, 0) + 1
    from ..tasks import is_reanalyzing_run
    return RunStatus(
        id=run.id,
        status=run.status,
        total=len(run.domains),
        reanalyzing=is_reanalyzing_run(run.id),
        **counts,
    )


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
                counts = {
                    "pending": 0, "running": 0, "done": 0, "failed": 0,
                }
                for d in run.domains:
                    counts[d.status] = counts.get(d.status, 0) + 1
                payload = {
                    "id": run.id,
                    "status": run.status,
                    "total": len(run.domains),
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
