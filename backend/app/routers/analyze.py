"""Analyze endpoints. Preview is pure URL building (step 4); job submission
persists the spec + dispatches the runner (step 5)."""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Job, Run, RunDomain
from ..providers.ahrefs_requests import build_preview
from ..schemas import AnalyzeSpec, PreviewResponse
from ..tasks import dispatch_run

router = APIRouter(prefix="/analyze", tags=["analyze"])


@router.get("/last-spec")
def get_last_spec(db: Session = Depends(get_db)) -> dict:
    """Most-recent job's spec, used to pre-fill the Analyze form when the
    user arrives from a triage flow (e.g. Backlog → Analyze). Returns
    `{spec: null}` when no jobs exist so the UI keeps its hard-coded
    defaults."""
    job: Job | None = (
        db.query(Job).order_by(Job.id.desc()).first()
    )
    if job is None:
        return {"spec": None}
    try:
        raw = json.loads(job.spec_json or "{}")
    except json.JSONDecodeError:
        raw = {}
    try:
        spec = AnalyzeSpec.model_validate(raw).model_dump(mode="json")
    except Exception:  # noqa: BLE001
        spec = raw
    return {"spec": spec, "job_id": job.id, "name": job.name}


def auto_enable_wayback_for_classify(spec: AnalyzeSpec) -> AnalyzeSpec:
    """Mutate `spec.criteria` so the wayback_classify criterion has the
    inputs it needs: when classify is enabled, wayback must also be
    enabled AND its V2 page-content sampling must be on (classify reads
    titles + headings + body excerpts; CDX rows alone are too thin).

    Idempotent — only flips the booleans that aren't already set so we
    don't clobber the user's `sample_count` / `sample_strategy` /
    `sample_path_mode` choices. Returns the same spec for chaining."""
    wbc = getattr(spec.criteria, "wayback_classify", None)
    if wbc is None or not wbc.enabled:
        return spec
    wb = spec.criteria.wayback
    if not wb.enabled:
        wb.enabled = True
    if not wb.sample_pages:
        wb.sample_pages = True
    return spec


@router.post("/preview", response_model=PreviewResponse)
def preview(spec: AnalyzeSpec) -> PreviewResponse:
    """Build the canonical Ahrefs request URLs for the given spec, using the
    first domain in the list as the example. Returns 4 request entries — one
    per criterion — flagged enabled/disabled per the user's toggles."""
    spec = auto_enable_wayback_for_classify(spec)
    example_domain, requests = build_preview(spec)
    note = None
    cleaned = [d.strip() for d in spec.domains if d.strip()]
    if not cleaned:
        note = "Showing placeholder domain (example.com); add domains to see real targets."
    elif len(cleaned) > 1:
        note = f"Showing first of {len(cleaned)} domains; the same shape applies to all."
    return PreviewResponse(domain=example_domain, requests=requests, note=note)


# --- Submit ------------------------------------------------------------------

class SubmitJobIn(BaseModel):
    spec: AnalyzeSpec
    name: str | None = None
    notes: str | None = None


class SubmitJobOut(BaseModel):
    job_id: int
    run_id: int
    # Domains rejected because they're on the ban list (added wave L).
    # Per the (β) design call, banned domains are filtered at the
    # Analyze submit endpoint too — not just at Backlog insertion. The
    # frontend renders a "X domains skipped (banned)" notice when this
    # is non-empty.
    skipped_banned: list[str] = []


@router.post("/jobs", response_model=SubmitJobOut)
async def submit_job(
    payload: SubmitJobIn, db: Session = Depends(get_db)
) -> SubmitJobOut:
    from .backlog import _normalize_domain
    from ..ban_filter import filter_banned

    cleaned_domains = [d.strip() for d in payload.spec.domains if d.strip()]
    if not cleaned_domains:
        raise HTTPException(400, "at least one domain is required")

    # Ban-list pre-filter (added 2026-05-13 wave L, per design call β):
    # drop banned domains from the run BEFORE it costs anything. We
    # normalize for the lookup but keep the user's original casing on
    # any domains that pass — the runner does its own normalization.
    normalized_for_check = [_normalize_domain(d) for d in cleaned_domains]
    pairs = list(zip(cleaned_domains, normalized_for_check))
    _, banned_normalized = filter_banned(
        db, [n for n in normalized_for_check if n],
    )
    if banned_normalized:
        skipped_banned = [
            original for original, norm in pairs
            if norm and norm in banned_normalized
        ]
        cleaned_domains = [
            original for original, norm in pairs
            if not (norm and norm in banned_normalized)
        ]
        if not cleaned_domains:
            # Structured detail so the frontend can localize and we can
            # cap the listed sample. Raw list could be hundreds of items
            # long otherwise (locked: never include a comma-separated
            # dump of every banned domain).
            sample = sorted(banned_normalized)
            SAMPLE_CAP = 10
            raise HTTPException(
                400,
                detail={
                    "code": "all_banned",
                    "count": len(sample),
                    "sample": sample[:SAMPLE_CAP],
                    "truncated": len(sample) > SAMPLE_CAP,
                },
            )
    else:
        skipped_banned = []

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

    # Normalize the spec so the persisted snapshot matches what the runner
    # will iterate. Use model_copy(update=) so EVERY spec field flows through
    # automatically — `ai=`, `use_cache`, `lang`, and `check_availability`
    # have each gone missing in a field-by-field rebuild here at some point.
    norm_spec = payload.spec.model_copy(update={"domains": cleaned_domains})
    # Force-disable whois_history + availability — Quality runs never
    # dispatch these (they have their own pillar runners). Leaving them
    # enabled silently completed runs with missing CR rows, then Retry-
    # failed correctly identified the gap and dispatched per-domain
    # whois/availability work the operator didn't ask for. Closing the
    # footgun at submit (2026-05-24, runs 124+126 reproducer). See the
    # docstring of `strip_pillar_criteria_from_quality_spec` for the
    # full reasoning.
    from ..schemas import strip_pillar_criteria_from_quality_spec
    norm_spec = strip_pillar_criteria_from_quality_spec(norm_spec)
    # Auto-enable wayback + V2 sampling when classify is on. Done AFTER
    # the empty-criteria guard above so a spec with ONLY classify on (and
    # everything else disabled) still passes — classify counts.
    auto_enable_wayback_for_classify(norm_spec)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
    notes = (payload.notes or "").strip()

    # The analyze submit creates a Quality-pillar Job. The `kind`
    # column defaults to 'quality' so this is redundant, but making it
    # explicit defends against a future schema change that drops the
    # default.
    job = Job(name=name, notes=notes, spec_json=spec_json, kind="quality")
    db.add(job)
    db.flush()  # assign job.id

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()

    for d in cleaned_domains:
        db.add(RunDomain(run_id=run.id, domain=d, status="pending"))

    db.commit()

    # Augmentation chain: any RunDomain whose criteria-set is a strict
    # subset of a prior RunDomain (same domain) gets linked back, so the
    # Database page can show the row as "augments Run #N" instead of
    # treating it as a fresh comprehensive run that shadows older data.
    from ..augmentation import link_augmenters_for_run
    link_augmenters_for_run(db, run_id=run.id)

    # Hand off to the asyncio task. SessionLocal sessions are per-task in
    # the runner so this is safe to call before returning.
    dispatch_run(run.id)

    return SubmitJobOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
    )


def _autoname(domains: list[str]) -> str:
    """Default job name: '<first-domain> +N more · <yyyy-mm-dd HH:MM>'."""
    head = domains[0]
    extra = f" +{len(domains) - 1} more" if len(domains) > 1 else ""
    when = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    return f"{head}{extra} · {when}"


# --- Whois History submit (added Wave 2, 2026-05-15) -----------------------
#
# Parallel to /analyze/jobs but for the whois_history pillar. Shape is
# narrower: no per-criterion knobs (the only "criterion" is whois_history
# itself), so the payload carries just domains + AI selection + an
# optional name/notes label. The shared `AnalyzeSpec` model is reused
# as the persisted spec_json shape — we toggle ONLY the whois_history
# criterion on and leave every other criterion disabled.

class SubmitWhoisHistoryIn(BaseModel):
    domains: list[str]
    # AI provider + optional model. Required — there's no point running
    # this pillar without an AI verdict (the diff alone is not what the
    # operator is buying). Frontend form blocks submission when these
    # are empty.
    ai_provider: str
    ai_model: str | None = None
    # Same UI-language carry as the Quality pillar so the AI prompt
    # gets the RU output directive appended for RU users.
    lang: str = "en"
    name: str | None = None
    notes: str | None = None


class SubmitWhoisHistoryOut(BaseModel):
    job_id: int
    run_id: int
    skipped_banned: list[str]


@router.post("/whois-history", response_model=SubmitWhoisHistoryOut)
async def submit_whois_history_job(
    payload: SubmitWhoisHistoryIn, db: Session = Depends(get_db)
) -> SubmitWhoisHistoryOut:
    """Mint a Job(kind='whois_history') + first Run + per-domain
    RunDomains, then dispatch. Mirrors `submit_job` but the spec is
    canonicalized to only enable the whois_history criterion."""
    from .backlog import _normalize_domain
    from ..ban_filter import filter_banned

    cleaned_domains = [d.strip() for d in payload.domains if d.strip()]
    if not cleaned_domains:
        raise HTTPException(400, "at least one domain is required")

    ai_provider = (payload.ai_provider or "").strip()
    if not ai_provider:
        raise HTTPException(400, "ai_provider is required")

    # Ban-list pre-filter (same shape + error envelope as Quality
    # submit so the frontend's "all_banned" handler matches).
    normalized_for_check = [_normalize_domain(d) for d in cleaned_domains]
    pairs = list(zip(cleaned_domains, normalized_for_check))
    _, banned_normalized = filter_banned(
        db, [n for n in normalized_for_check if n],
    )
    if banned_normalized:
        skipped_banned = [
            original for original, norm in pairs
            if norm and norm in banned_normalized
        ]
        cleaned_domains = [
            original for original, norm in pairs
            if not (norm and norm in banned_normalized)
        ]
        if not cleaned_domains:
            sample = sorted(banned_normalized)
            SAMPLE_CAP = 10
            raise HTTPException(
                400,
                detail={
                    "code": "all_banned",
                    "count": len(sample),
                    "sample": sample[:SAMPLE_CAP],
                    "truncated": len(sample) > SAMPLE_CAP,
                },
            )
    else:
        skipped_banned = []

    # Build a canonical AnalyzeSpec that ONLY has whois_history enabled.
    # We reuse the existing schema rather than introducing a separate
    # one — this keeps spec_json shape uniform across pillars so the
    # Job-tree readers (per-job page, per-run page, etc.) don't need to
    # branch on kind for serialization.
    spec_dict = {
        "domains": cleaned_domains,
        "criteria": {
            # Every Ahrefs/Wayback criterion explicitly OFF — only
            # the whois_history one runs on this pillar.
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": False},
            "wayback_classify": {"enabled": False},
            "whois_history": {"enabled": True},
        },
        "ai": {
            "provider": ai_provider,
            "model": payload.ai_model or "",
        },
        "use_cache": True,
        "cross_job_cache": False,
        "lang": payload.lang or "en",
    }
    # Validate via the schema so any future field renames trip a 422
    # here rather than surfacing as a runner-side crash.
    norm_spec = AnalyzeSpec.model_validate(spec_dict)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
    notes = (payload.notes or "").strip()

    job = Job(
        name=name,
        notes=notes,
        spec_json=spec_json,
        kind="whois_history",
    )
    db.add(job)
    db.flush()

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()
    for d in cleaned_domains:
        db.add(RunDomain(run_id=run.id, domain=d, status="pending"))
    db.commit()

    # Augmentation logic is Quality-only (the augmentation chain
    # tracks per-criterion strict subsets). Whois History has one
    # criterion so the concept doesn't apply.

    dispatch_run(run.id)
    return SubmitWhoisHistoryOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
    )


# --- Wave 3 (2026-05-15): Availability pillar submit ----------------------
# Same shape as the Whois Wave 2 endpoint but without AI fields — the
# cascade output is the verdict. Forces use_cache=False in the canonical
# spec so the runner gets fresh state per Job (Wave 3 decision (b)).

class SubmitAvailabilityIn(BaseModel):
    domains: list[str]
    # No AI fields — the cascade is deterministic, no judge needed
    # (Wave 3 decision (a)). lang carries through for any future
    # localization of result strings.
    lang: str = "en"
    name: str | None = None
    notes: str | None = None


class SubmitAvailabilityOut(BaseModel):
    job_id: int
    run_id: int
    skipped_banned: list[str]


@router.post("/availability", response_model=SubmitAvailabilityOut)
async def submit_availability_job(
    payload: SubmitAvailabilityIn, db: Session = Depends(get_db)
) -> SubmitAvailabilityOut:
    """Mint a Job(kind='availability') + first Run + per-domain
    RunDomains, then dispatch. Mirrors `submit_whois_history_job` but
    the spec enables only the `availability` criterion and carries no
    AI provider."""
    from ..ban_filter import filter_banned
    from ..availability.suffix import registrable_domain

    # Trim each input (URL / host / bare domain) to its registrable domain
    # (eTLD+1) so ONLY domains are checked — not URLs or non-registrable
    # subdomains, which the registry RDAP/WHOIS would 404 as false
    # `available` (added 2026-06-21). Dedupe so many URLs of one site
    # collapse to a single check; preserve first-seen order.
    domains: list[str] = []
    seen: set[str] = set()
    for raw in payload.domains:
        d = registrable_domain(raw)
        if d and d not in seen:
            seen.add(d)
            domains.append(d)
    if not domains:
        raise HTTPException(400, "at least one domain is required")

    # Ban-list pre-filter on the trimmed domains — same envelope as Quality
    # / Whois submits so the frontend's `all_banned` handler matches.
    _, banned = filter_banned(db, domains)
    if banned:
        skipped_banned = [d for d in domains if d in banned]
        domains = [d for d in domains if d not in banned]
        if not domains:
            sample = sorted(banned)
            SAMPLE_CAP = 10
            raise HTTPException(
                400,
                detail={
                    "code": "all_banned",
                    "count": len(sample),
                    "sample": sample[:SAMPLE_CAP],
                    "truncated": len(sample) > SAMPLE_CAP,
                },
            )
    else:
        skipped_banned = []

    # Canonical spec with ONLY availability enabled. use_cache=False
    # because a Job is an explicit "give me fresh state" ask (Wave 3
    # decision (b)). The runner re-reads this and passes it to the
    # cascade; we set it here for downstream visibility too.
    spec_dict = {
        "domains": domains,
        "criteria": {
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": False},
            "wayback_classify": {"enabled": False},
            "whois_history": {"enabled": False},
            "availability": {"enabled": True},
        },
        # No AI on this pillar. AISpec.provider is Optional[AIProvider]
        # so None is the canonical "no AI" sentinel — the runner reads
        # spec.ai.provider and is a no-op when missing. Don't pass
        # provider:"" — the Literal validator rejects the empty string.
        "ai": {"provider": None, "model": None},
        "use_cache": False,
        "cross_job_cache": False,
        "lang": payload.lang or "en",
    }
    norm_spec = AnalyzeSpec.model_validate(spec_dict)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(domains)
    notes = (payload.notes or "").strip()

    job = Job(
        name=name,
        notes=notes,
        spec_json=spec_json,
        kind="availability",
    )
    db.add(job)
    db.flush()

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()
    for d in domains:
        db.add(RunDomain(run_id=run.id, domain=d, status="pending"))
    db.commit()

    dispatch_run(run.id)
    return SubmitAvailabilityOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
    )


# --- Ahrefs Batch Analysis pillar submit (2026-06-02) ---------------------
# Bulk Ahrefs /batch-analysis metrics as a first-class Job kind. Like the
# Availability pillar: no AI. Unlike it, carries per-job knobs (which
# metrics, optional country). Built for 100k domains — RunDomains are
# bulk-inserted and the chunked runner streams them in 100s.

# Match the wayback-sparkline cap: a single typo shouldn't submit a
# 10-million-row job. 100k is the user-confirmed target ceiling.
_BATCH_MAX_DOMAINS = 100_000


class SubmitAhrefsBatchAnalysisIn(BaseModel):
    domains: list[str]
    # Subset of providers.ahrefs_batch.BATCH_METRICS keys. Empty → DR
    # only (the cheapest single field), matching the setup-page default.
    metrics: list[str] = []
    # Optional ISO alpha-2 country scoping org_traffic / org_keywords.
    country: str | None = None
    name: str | None = None
    notes: str | None = None


class SubmitAhrefsBatchAnalysisOut(BaseModel):
    job_id: int
    run_id: int
    skipped_banned: list[str]


@router.post("/ahrefs-batch-analysis", response_model=SubmitAhrefsBatchAnalysisOut)
async def submit_ahrefs_batch_analysis_job(
    payload: SubmitAhrefsBatchAnalysisIn, db: Session = Depends(get_db)
) -> SubmitAhrefsBatchAnalysisOut:
    """Mint a Job(kind='ahrefs_batch_analysis') + first Run + per-domain
    RunDomains, then dispatch the chunked runner. Mirrors
    `submit_availability_job` but carries the metric selection + country
    on the spec and bulk-inserts RunDomains for 100k-scale submits."""
    from .backlog import _normalize_domain
    from ..ban_filter import filter_banned
    from ..providers.ahrefs_batch import BATCH_METRICS, canonical_metrics

    cleaned_domains = [d.strip() for d in payload.domains if d.strip()]
    if not cleaned_domains:
        raise HTTPException(400, "at least one domain is required")
    if len(cleaned_domains) > _BATCH_MAX_DOMAINS:
        raise HTTPException(
            400,
            f"max {_BATCH_MAX_DOMAINS:,} domains per job "
            f"(you have {len(cleaned_domains):,})",
        )

    # Validate + canonicalize the requested metrics; default to DR only.
    unknown = [m for m in payload.metrics if m not in BATCH_METRICS]
    if unknown:
        raise HTTPException(400, f"unknown metrics: {', '.join(unknown)}")
    metrics = canonical_metrics(payload.metrics) or ["domain_rating"]
    country = (payload.country or "").strip() or None

    # Ban-list pre-filter — same envelope as the other pillar submits.
    normalized_for_check = [_normalize_domain(d) for d in cleaned_domains]
    pairs = list(zip(cleaned_domains, normalized_for_check))
    _, banned_normalized = filter_banned(
        db, [n for n in normalized_for_check if n],
    )
    if banned_normalized:
        skipped_banned = [
            original for original, norm in pairs
            if norm and norm in banned_normalized
        ]
        cleaned_domains = [
            original for original, norm in pairs
            if not (norm and norm in banned_normalized)
        ]
        if not cleaned_domains:
            sample = sorted(banned_normalized)
            SAMPLE_CAP = 10
            raise HTTPException(
                400,
                detail={
                    "code": "all_banned",
                    "count": len(sample),
                    "sample": sample[:SAMPLE_CAP],
                    "truncated": len(sample) > SAMPLE_CAP,
                },
            )
    else:
        skipped_banned = []

    # Canonical spec: only the ahrefs_batch_analysis criterion enabled,
    # carrying the metric selection + country. No AI. use_cache=False —
    # a Job is an explicit "fetch fresh now" ask (mirrors availability).
    spec_dict = {
        "domains": cleaned_domains,
        "criteria": {
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": False},
            "wayback_classify": {"enabled": False},
            "whois_history": {"enabled": False},
            "availability": {"enabled": False},
            "ahrefs_batch_analysis": {
                "enabled": True,
                "metrics": metrics,
                "country": country,
            },
        },
        "ai": {"provider": None, "model": None},
        "use_cache": False,
        "cross_job_cache": False,
        "lang": "en",
    }
    norm_spec = AnalyzeSpec.model_validate(spec_dict)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
    notes = (payload.notes or "").strip()

    job = Job(
        name=name,
        notes=notes,
        spec_json=spec_json,
        kind="ahrefs_batch_analysis",
    )
    db.add(job)
    db.flush()

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()

    # Bulk-insert RunDomains — at 100k a per-row add loop is ~15s; the
    # mapping bulk insert is sub-second (same pattern as the wayback
    # sparkline job submit).
    db.bulk_insert_mappings(
        RunDomain,
        [
            {"run_id": run.id, "domain": d, "status": "pending"}
            for d in cleaned_domains
        ],
    )
    db.commit()

    dispatch_run(run.id)
    return SubmitAhrefsBatchAnalysisOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
    )


# --- Linked Domains Checker submit (added 2026-07-02) ----------------------
#
# Parallel to /analyze/ahrefs-batch-analysis but for the linked_domains
# pillar. Carries the checker knobs (root_only / min_dr / per_target_limit /
# unit_budget) on the spec; no AI, use_cache=False. The runner fetches one
# Ahrefs /site-explorer/linked-domains call per target and stores the
# returned domains in linked_domain_rows for the unique-domains CSV export.

_LINKED_MAX_DOMAINS = 1000


class SubmitLinkedDomainsIn(BaseModel):
    domains: list[str]
    # Keep only root linked domains (drop subdomains). Default OFF — opt-in
    # (adds ~1 unit/row and rarely removes many rows, so it raises cost).
    root_only: bool = False
    # Optional DR floor (0-100) applied as a server-side filter; None = none.
    min_dr: int | None = None
    # Cap linked domains fetched per target (1-5000); None = 5000 (default).
    per_target_limit: int | None = None
    # Optional per-run Ahrefs unit budget; None = uncapped.
    unit_budget: int | None = None
    # When True, drop domains that already completed (status='done') as a
    # target in ANY prior linked_domains run — skip re-checking what you've
    # already pulled. ON by default (2026-07-07, user request): re-checking
    # a domain re-bills its full row count, so the safe default is to skip;
    # the response reports exactly what was dropped. Failed prior targets
    # stay re-checkable either way. Untick in the UI / send false to force
    # a re-check.
    skip_checked: bool = True
    # When True, only linked domains whose TLD is in the Settings
    # allowed-TLDs list are fetched (server-side suffix filter — free per
    # row, cuts billed rows). The list is snapshotted into the run's spec.
    allowed_tlds_only: bool = False
    name: str | None = None
    notes: str | None = None


class SubmitLinkedDomainsOut(BaseModel):
    job_id: int
    run_id: int
    skipped_banned: list[str]
    # Domains dropped because skip_checked was on and they already completed
    # in a prior run. Empty when skip_checked is off / nothing matched.
    skipped_already_checked: list[str] = []


@router.post("/linked-domains", response_model=SubmitLinkedDomainsOut)
async def submit_linked_domains_job(
    payload: SubmitLinkedDomainsIn, db: Session = Depends(get_db)
) -> SubmitLinkedDomainsOut:
    """Mint a Job(kind='linked_domains') + first Run + per-domain RunDomains,
    then dispatch the per-target runner. Mirrors submit_ahrefs_batch_analysis
    but carries the linked-domains knobs on the spec instead of metrics."""
    from .backlog import _normalize_domain
    from ..ban_filter import filter_banned

    cleaned_domains = [d.strip() for d in payload.domains if d.strip()]
    if not cleaned_domains:
        raise HTTPException(400, "at least one domain is required")
    if len(cleaned_domains) > _LINKED_MAX_DOMAINS:
        raise HTTPException(
            400,
            f"max {_LINKED_MAX_DOMAINS:,} domains per run "
            f"(you have {len(cleaned_domains):,})",
        )

    # Validate knob ranges (mirror the LinkedDomainsConfig field bounds so a
    # direct API caller gets a clean 400 instead of a pydantic 422 downstream).
    min_dr = payload.min_dr
    if min_dr is not None and not (0 <= min_dr <= 100):
        raise HTTPException(400, "min_dr must be between 0 and 100")
    per_target_limit = payload.per_target_limit
    if per_target_limit is not None and not (1 <= per_target_limit <= 5000):
        raise HTTPException(400, "per_target_limit must be between 1 and 5000")
    unit_budget = payload.unit_budget
    if unit_budget is not None and unit_budget < 1:
        raise HTTPException(400, "unit_budget must be >= 1")

    # Ban-list pre-filter — same envelope as the other pillar submits.
    normalized_for_check = [_normalize_domain(d) for d in cleaned_domains]
    pairs = list(zip(cleaned_domains, normalized_for_check))
    _, banned_normalized = filter_banned(
        db, [n for n in normalized_for_check if n],
    )
    if banned_normalized:
        skipped_banned = [
            original for original, norm in pairs
            if norm and norm in banned_normalized
        ]
        cleaned_domains = [
            original for original, norm in pairs
            if not (norm and norm in banned_normalized)
        ]
        if not cleaned_domains:
            sample = sorted(banned_normalized)
            SAMPLE_CAP = 10
            raise HTTPException(
                400,
                detail={
                    "code": "all_banned",
                    "count": len(sample),
                    "sample": sample[:SAMPLE_CAP],
                    "truncated": len(sample) > SAMPLE_CAP,
                },
            )
    else:
        skipped_banned = []

    # Skip-already-checked pre-filter (opt-in). Drop domains that already
    # completed (status='done') as a target in ANY prior linked_domains run,
    # so the user doesn't re-spend on domains they've already pulled. Matched
    # on the normalized form (same normalizer as the ban filter). Failed
    # prior targets are NOT skipped — they still need a real result.
    skipped_already_checked: list[str] = []
    if payload.skip_checked and cleaned_domains:
        prior_done = (
            db.query(RunDomain.domain)
            .join(Run, RunDomain.run_id == Run.id)
            .join(Job, Run.job_id == Job.id)
            .filter(
                Job.kind == "linked_domains",
                RunDomain.status == "done",
            )
            .distinct()
            .all()
        )
        checked_norm = {
            _normalize_domain(row[0]) for row in prior_done if row[0]
        }
        if checked_norm:
            kept: list[str] = []
            for d in cleaned_domains:
                if _normalize_domain(d) in checked_norm:
                    skipped_already_checked.append(d)
                else:
                    kept.append(d)
            cleaned_domains = kept
            if not cleaned_domains:
                raise HTTPException(
                    400,
                    detail={
                        "code": "all_already_checked",
                        "count": len(skipped_already_checked),
                    },
                )

    # Snapshot the allowed-TLD list into the spec when requested, so the
    # run stays reproducible even if the Settings list changes later.
    tlds: list[str] | None = None
    if payload.allowed_tlds_only:
        from ..app_settings import get_allowed_tlds
        tlds = get_allowed_tlds()

    # Canonical spec: only the linked_domains criterion enabled. No AI.
    # use_cache=False — a Job is an explicit "fetch fresh now" ask (mirrors
    # the other pillar submits; keeps spec_json shape uniform).
    spec_dict = {
        "domains": cleaned_domains,
        "criteria": {
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": False},
            "wayback_classify": {"enabled": False},
            "whois_history": {"enabled": False},
            "availability": {"enabled": False},
            "ahrefs_batch_analysis": {"enabled": False},
            "linked_domains": {
                "enabled": True,
                "root_only": payload.root_only,
                "min_dr": min_dr,
                "per_target_limit": per_target_limit,
                "unit_budget": unit_budget,
                "tlds": tlds,
            },
        },
        "ai": {"provider": None, "model": None},
        "use_cache": False,
        "cross_job_cache": False,
        "lang": "en",
    }
    norm_spec = AnalyzeSpec.model_validate(spec_dict)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
    notes = (payload.notes or "").strip()

    job = Job(
        name=name,
        notes=notes,
        spec_json=spec_json,
        kind="linked_domains",
    )
    db.add(job)
    db.flush()

    run = Run(job_id=job.id, status="pending", spec_json=spec_json)
    db.add(run)
    db.flush()

    # Bulk-insert RunDomains (sub-second even at the 1000 cap).
    db.bulk_insert_mappings(
        RunDomain,
        [
            {"run_id": run.id, "domain": d, "status": "pending"}
            for d in cleaned_domains
        ],
    )
    db.commit()

    dispatch_run(run.id)
    return SubmitLinkedDomainsOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
        skipped_already_checked=skipped_already_checked,
    )


class LinkedDomainsRunSummary(BaseModel):
    job_id: int
    run_id: int
    name: str
    status: str
    created_at: datetime
    targets_total: int
    targets_done: int
    targets_failed: int
    unique_domains: int
    units_billed: int


class LinkedDomainsRunsPage(BaseModel):
    runs: list[LinkedDomainsRunSummary]
    total: int
    page: int
    page_size: int


@router.get(
    "/linked-domains/runs", response_model=LinkedDomainsRunsPage
)
def list_linked_domains_runs(
    q: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
) -> LinkedDomainsRunsPage:
    """Linked-domains runs history (most-recent first), paginated +
    searchable by job name (`q` = case-insensitive substring). Per run:
    RunDomain status counts, the unique linked-domain count (= CSV size),
    and Ahrefs units billed — all from data already stored, so a run stays
    revisitable after leaving the page."""
    from sqlalchemy import distinct, func as sfunc

    from ..models import CriterionResult, Job, LinkedDomainRow, RunDomain

    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    base = (
        db.query(Run, Job)
        .join(Job, Run.job_id == Job.id)
        .filter(Job.kind == "linked_domains")
    )
    term = q.strip()
    if term:
        base = base.filter(Job.name.ilike(f"%{term}%"))
    total = base.count()
    rows = (
        base.order_by(Run.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    if not rows:
        return LinkedDomainsRunsPage(
            runs=[], total=total, page=page, page_size=page_size,
        )
    run_ids = [r.id for r, _ in rows]

    status_counts: dict[int, dict[str, int]] = {}
    for rid, status, cnt in (
        db.query(RunDomain.run_id, RunDomain.status, sfunc.count(RunDomain.id))
        .filter(RunDomain.run_id.in_(run_ids))
        .group_by(RunDomain.run_id, RunDomain.status)
        .all()
    ):
        status_counts.setdefault(rid, {})[status] = cnt

    unique_by_run = {
        rid: int(cnt)
        for rid, cnt in (
            db.query(
                LinkedDomainRow.run_id,
                sfunc.count(distinct(LinkedDomainRow.linked_domain)),
            )
            .filter(LinkedDomainRow.run_id.in_(run_ids))
            .group_by(LinkedDomainRow.run_id)
            .all()
        )
    }

    units_by_run = {
        rid: int(total or 0)
        for rid, total in (
            db.query(
                RunDomain.run_id,
                sfunc.sum(CriterionResult.units_cost_actual),
            )
            .join(CriterionResult, CriterionResult.run_domain_id == RunDomain.id)
            .filter(
                RunDomain.run_id.in_(run_ids),
                CriterionResult.criterion == "linked_domains",
            )
            .group_by(RunDomain.run_id)
            .all()
        )
    }

    out: list[LinkedDomainsRunSummary] = []
    for run, job in rows:
        sc = status_counts.get(run.id, {})
        out.append(LinkedDomainsRunSummary(
            job_id=job.id,
            run_id=run.id,
            name=job.name or "",
            status=run.status,
            created_at=run.started_at or job.created_at,
            targets_total=sum(sc.values()),
            targets_done=sc.get("done", 0),
            targets_failed=sc.get("failed", 0),
            unique_domains=unique_by_run.get(run.id, 0),
            units_billed=units_by_run.get(run.id, 0),
        ))
    return LinkedDomainsRunsPage(
        runs=out, total=total, page=page, page_size=page_size,
    )


@router.get("/linked-domains/domains.csv")
def export_all_linked_domains_csv(db: Session = Depends(get_db)):
    """GLOBAL unique-linked-domains export: every distinct linked domain
    ever collected across ALL linked_domains runs, sorted A→Z, one column.

    Safe at scale by construction: the DISTINCT + ORDER BY is served by
    the single-column ix_linked_domain_rows_domain index (ordered index
    walk, no temp sort), rows stream via yield_per with a reused buffer
    (flat memory), and SQLite WAL means this read never blocks an
    in-flight runner's writes."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    from ..models import LinkedDomainRow

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
        q = (
            db.query(LinkedDomainRow.linked_domain)
            .distinct()
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

    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={
            "Content-Disposition":
                'attachment; filename="linked-domains-all-runs.csv"',
        },
    )


# --- SERP Overview submit (added 2026-07-10) --------------------------------
#
# Persistent-job successor to the stateless /tools/ahrefs-serp-overview
# probe — same pattern as /analyze/linked-domains but the targets are
# KEYWORDS (stored in RunDomain.domain), so there is no ban-list filter.

_SERP_MAX_KEYWORDS = 500


class SubmitSerpOverviewIn(BaseModel):
    keywords: list[str]
    # Two-letter ISO-3166-1 alpha-2 country codes. One Job+Run is created
    # PER country — every keyword is checked in every selected country's
    # SERP. `country` (single, legacy) is honored when `countries` is
    # absent; `countries` wins when both are sent.
    countries: list[str] | None = None
    country: str | None = None
    # Cap on top organic positions per keyword (1-100); None = all.
    top_positions: int | None = 10
    # Optional per-run Ahrefs unit budget; None = uncapped. Applies to
    # EACH created run (a per-run ceiling, not per-submit).
    unit_budget: int | None = None
    # When False (the default), keywords whose EXACT (keyword, country,
    # top_positions) triple already completed within the dedup window
    # (Settings → SERP Overview, default 30 days) are dropped before
    # submitting — no Ahrefs call, no credits. True = recheck everything.
    recheck_keywords: bool = False
    name: str | None = None
    notes: str | None = None


class SerpOverviewCreatedRun(BaseModel):
    country: str
    job_id: int
    run_id: int
    # Keywords dropped for THIS country by the duplicate-skip rule.
    skipped_duplicates: list[str] = []


class SerpOverviewSkippedCountry(BaseModel):
    """A country for which EVERY keyword was a duplicate — no run created."""
    country: str
    count: int


class SubmitSerpOverviewOut(BaseModel):
    runs: list[SerpOverviewCreatedRun] = []
    skipped_countries: list[SerpOverviewSkippedCountry] = []


_SERP_MAX_COUNTRIES = 30


@router.post("/serp-overview", response_model=SubmitSerpOverviewOut)
async def submit_serp_overview_job(
    payload: SubmitSerpOverviewIn, db: Session = Depends(get_db)
) -> SubmitSerpOverviewOut:
    """Mint one Job(kind='serp_overview') + Run PER selected country, each
    with one RunDomain per keyword, then dispatch the per-keyword runner
    for each. The duplicate-skip is evaluated per country (the dedup key
    is the (keyword, country, top_positions) triple); a country whose
    keywords are ALL duplicates gets no run and is reported in
    skipped_countries instead. Multi-country jobs get a ' · {cc}' name
    suffix so the history rows stay tellable-apart."""
    # Countries: prefer the list; fall back to the legacy single field.
    raw_countries = payload.countries if payload.countries else (
        [payload.country] if payload.country else []
    )
    countries: list[str] = []
    seen_c: set[str] = set()
    for rc in raw_countries:
        c = (rc or "").strip().lower()
        if not c or c in seen_c:
            continue
        if len(c) != 2 or not c.isalpha():
            raise HTTPException(
                400, f"country '{rc}' must be a two-letter code",
            )
        seen_c.add(c)
        countries.append(c)
    if not countries:
        raise HTTPException(400, "at least one country is required")
    if len(countries) > _SERP_MAX_COUNTRIES:
        raise HTTPException(
            400,
            f"max {_SERP_MAX_COUNTRIES} countries per submit "
            f"(you have {len(countries)})",
        )
    top_positions = payload.top_positions
    if top_positions is not None and not (1 <= top_positions <= 100):
        raise HTTPException(400, "top_positions must be between 1 and 100")
    unit_budget = payload.unit_budget
    if unit_budget is not None and unit_budget < 1:
        raise HTTPException(400, "unit_budget must be >= 1")

    # Normalize + dedupe keywords (lower-cased + stripped, preserving
    # order) — Ahrefs SERPs are case-insensitive, same rule as the probe.
    seen: set[str] = set()
    keywords: list[str] = []
    for raw in payload.keywords:
        k = (raw or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        keywords.append(k)
    if not keywords:
        raise HTTPException(400, "at least one keyword is required")
    if len(keywords) > _SERP_MAX_KEYWORDS:
        raise HTTPException(
            400,
            f"max {_SERP_MAX_KEYWORDS:,} keywords per run "
            f"(you have {len(keywords):,})",
        )

    # Duplicate-skip (default ON; "Recheck keywords" bypasses), evaluated
    # PER COUNTRY: a keyword is a duplicate for a country when the exact
    # (keyword, country, top_positions) triple completed (rd.status='done')
    # within the configurable window. Prior runs' spec_json is parsed ONCE
    # into a country→run_ids map (the runs table is small); the RunDomain
    # lookups are index-served.
    dups_by_country: dict[str, set[str]] = {c: set() for c in countries}
    window_days = 0
    if not payload.recheck_keywords:
        from datetime import timedelta

        from ..app_settings import get_serp_dedup_window_days

        window_days = get_serp_dedup_window_days()
        cutoff = datetime.utcnow() - timedelta(days=window_days)
        wanted = set(countries)
        run_ids_by_country: dict[str, list[int]] = {}
        for pr in (
            db.query(Run)
            .join(Job, Run.job_id == Job.id)
            .filter(Job.kind == "serp_overview")
            .all()
        ):
            try:
                pcfg = AnalyzeSpec.model_validate_json(
                    pr.spec_json or "{}"
                ).criteria.serp_overview
            except Exception:  # noqa: BLE001
                continue
            pc = (pcfg.country or "").strip().lower()
            if pc in wanted and pcfg.top_positions == top_positions:
                run_ids_by_country.setdefault(pc, []).append(pr.id)
        for c, rids in run_ids_by_country.items():
            dup_rows = (
                db.query(RunDomain.domain)
                .filter(
                    RunDomain.run_id.in_(rids),
                    RunDomain.status == "done",
                    RunDomain.finished_at >= cutoff,
                    RunDomain.domain.in_(keywords),
                )
                .distinct()
                .all()
            )
            dups_by_country[c] = {r[0] for r in dup_rows}

    base_name = (payload.name or "").strip() or _autoname(keywords)
    notes = (payload.notes or "").strip()
    multi = len(countries) > 1

    created: list[SerpOverviewCreatedRun] = []
    skipped_countries: list[SerpOverviewSkippedCountry] = []
    for c in countries:
        dups = dups_by_country.get(c) or set()
        kw = [k for k in keywords if k not in dups]
        if not kw:
            skipped_countries.append(SerpOverviewSkippedCountry(
                country=c, count=len(keywords),
            ))
            continue
        spec_dict = {
            "domains": kw,
            "criteria": {
                "backlinks": {"enabled": False},
                "refdomains": {"enabled": False},
                "anchors": {"enabled": False},
                "keywords": {"enabled": False},
                "wayback": {"enabled": False},
                "wayback_classify": {"enabled": False},
                "whois_history": {"enabled": False},
                "availability": {"enabled": False},
                "ahrefs_batch_analysis": {"enabled": False},
                "linked_domains": {"enabled": False},
                "serp_overview": {
                    "enabled": True,
                    "country": c,
                    "top_positions": top_positions,
                    "unit_budget": unit_budget,
                },
            },
            "ai": {"provider": None, "model": None},
            "use_cache": False,
            "cross_job_cache": False,
            "lang": "en",
        }
        norm_spec = AnalyzeSpec.model_validate(spec_dict)
        spec_json = norm_spec.model_dump_json()

        job = Job(
            name=f"{base_name} · {c}" if multi else base_name,
            notes=notes,
            spec_json=spec_json,
            kind="serp_overview",
        )
        db.add(job)
        db.flush()

        run = Run(job_id=job.id, status="pending", spec_json=spec_json)
        db.add(run)
        db.flush()

        db.bulk_insert_mappings(
            RunDomain,
            [
                {"run_id": run.id, "domain": k, "status": "pending"}
                for k in kw
            ],
        )
        db.commit()

        dispatch_run(run.id)
        created.append(SerpOverviewCreatedRun(
            country=c,
            job_id=job.id,
            run_id=run.id,
            skipped_duplicates=[k for k in keywords if k in dups],
        ))

    if not created:
        raise HTTPException(
            400,
            detail={
                "code": "all_duplicates",
                "count": sum(s.count for s in skipped_countries),
                "window_days": window_days,
                "countries": [s.country for s in skipped_countries],
            },
        )
    return SubmitSerpOverviewOut(
        runs=created, skipped_countries=skipped_countries,
    )


class SerpOverviewRunSummary(BaseModel):
    job_id: int
    run_id: int
    name: str
    status: str
    created_at: datetime
    keywords_total: int
    keywords_done: int
    keywords_failed: int
    urls_total: int
    units_billed: int


class SerpOverviewRunsPage(BaseModel):
    runs: list[SerpOverviewRunSummary]
    total: int
    page: int
    page_size: int


@router.get(
    "/serp-overview/runs", response_model=SerpOverviewRunsPage
)
def list_serp_overview_runs(
    q: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
) -> SerpOverviewRunsPage:
    """SERP Overview runs history (most-recent first), paginated +
    searchable by job name (`q` = case-insensitive substring) — same
    contract as the linked-domains history: everything is already stored,
    so a run stays revisitable after leaving the page."""
    from sqlalchemy import func as sfunc

    from ..models import CriterionResult, Job, RunDomain, SerpOverviewRow

    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    base = (
        db.query(Run, Job)
        .join(Job, Run.job_id == Job.id)
        .filter(Job.kind == "serp_overview")
    )
    term = q.strip()
    if term:
        base = base.filter(Job.name.ilike(f"%{term}%"))
    total = base.count()
    rows = (
        base.order_by(Run.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    if not rows:
        return SerpOverviewRunsPage(
            runs=[], total=total, page=page, page_size=page_size,
        )
    run_ids = [r.id for r, _ in rows]

    status_counts: dict[int, dict[str, int]] = {}
    for rid, status, cnt in (
        db.query(RunDomain.run_id, RunDomain.status, sfunc.count(RunDomain.id))
        .filter(RunDomain.run_id.in_(run_ids))
        .group_by(RunDomain.run_id, RunDomain.status)
        .all()
    ):
        status_counts.setdefault(rid, {})[status] = cnt

    urls_by_run = {
        rid: int(cnt)
        for rid, cnt in (
            db.query(SerpOverviewRow.run_id, sfunc.count(SerpOverviewRow.id))
            .filter(SerpOverviewRow.run_id.in_(run_ids))
            .group_by(SerpOverviewRow.run_id)
            .all()
        )
    }

    units_by_run = {
        rid: int(total or 0)
        for rid, total in (
            db.query(
                RunDomain.run_id,
                sfunc.sum(CriterionResult.units_cost_actual),
            )
            .join(CriterionResult, CriterionResult.run_domain_id == RunDomain.id)
            .filter(
                RunDomain.run_id.in_(run_ids),
                CriterionResult.criterion == "serp_overview",
            )
            .group_by(RunDomain.run_id)
            .all()
        )
    }

    out: list[SerpOverviewRunSummary] = []
    for run, job in rows:
        sc = status_counts.get(run.id, {})
        out.append(SerpOverviewRunSummary(
            job_id=job.id,
            run_id=run.id,
            name=job.name or "",
            status=run.status,
            created_at=run.started_at or job.created_at,
            keywords_total=sum(sc.values()),
            keywords_done=sc.get("done", 0),
            keywords_failed=sc.get("failed", 0),
            urls_total=urls_by_run.get(run.id, 0),
            units_billed=units_by_run.get(run.id, 0),
        ))
    return SerpOverviewRunsPage(
        runs=out, total=total, page=page, page_size=page_size,
    )


@router.get("/serp-overview/domains.csv")
def export_all_serp_domains_csv(
    tlds: str = "all", db: Session = Depends(get_db)
):
    """GLOBAL unique ranking-domains export: every distinct domain that has
    ever ranked in any serp_overview run, sorted A→Z, one column. Same
    safety profile as the linked-domains global export: ordered DISTINCT
    served by ix_serp_overview_rows_domain (domains are stored per row at
    write time — no URL parsing at read time), streamed via yield_per.

    `tlds=allowed` keeps only domains whose TLD is in the Settings
    allowed-TLDs list (read-time filter — stored data stays complete)."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    from ..models import SerpOverviewRow

    if tlds not in ("all", "allowed"):
        raise HTTPException(400, "tlds must be 'all' or 'allowed'")
    matcher = None
    if tlds == "allowed":
        from ..allowed_tlds import make_tld_matcher
        from ..app_settings import get_allowed_tlds
        matcher = make_tld_matcher(get_allowed_tlds())

    def _rows():
        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            out = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return out

        writer.writerow(["domain"])
        yield _flush()
        q = (
            db.query(SerpOverviewRow.domain)
            .filter(SerpOverviewRow.domain != "")
            .distinct()
            .order_by(SerpOverviewRow.domain)
            .yield_per(1000)
        )
        n = 0
        for (dom,) in q:
            if matcher is not None and not matcher(dom):
                continue
            writer.writerow([dom])
            n += 1
            if n % 1000 == 0:
                yield _flush()
        yield _flush()

    return StreamingResponse(
        _rows(),
        media_type="text/csv",
        headers={
            "Content-Disposition":
                'attachment; filename="serp-overview-domains-all-runs.csv"',
        },
    )
