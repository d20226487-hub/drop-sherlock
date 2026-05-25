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
    from .backlog import _normalize_domain
    from ..ban_filter import filter_banned

    cleaned_domains = [d.strip() for d in payload.domains if d.strip()]
    if not cleaned_domains:
        raise HTTPException(400, "at least one domain is required")

    # Ban-list pre-filter — same shape + envelope as Quality / Whois
    # submits so the frontend's `all_banned` handler matches.
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

    # Canonical spec with ONLY availability enabled. use_cache=False
    # because a Job is an explicit "give me fresh state" ask (Wave 3
    # decision (b)). The runner re-reads this and passes it to the
    # cascade; we set it here for downstream visibility too.
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

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
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
    for d in cleaned_domains:
        db.add(RunDomain(run_id=run.id, domain=d, status="pending"))
    db.commit()

    dispatch_run(run.id)
    return SubmitAvailabilityOut(
        job_id=job.id, run_id=run.id, skipped_banned=skipped_banned,
    )
