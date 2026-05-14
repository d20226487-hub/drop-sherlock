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
    # will iterate (cleaned domain list, original criteria + ai). Forgetting
    # to pass ai= here was the bug that silently disabled AI verdicts even
    # when the form correctly chose a provider.
    norm_spec = AnalyzeSpec(
        domains=cleaned_domains,
        criteria=payload.spec.criteria,
        ai=payload.spec.ai,
        use_cache=payload.spec.use_cache,
        cross_job_cache=payload.spec.cross_job_cache,
        # Preserve the UI language the frontend sent. Without this, the
        # field falls back to AnalyzeSpec's default ("en") and the runner
        # never appends the RU output directive — every run would judge
        # in English regardless of what the user picked.
        lang=payload.spec.lang,
    )
    # Auto-enable wayback + V2 sampling when classify is on. Done AFTER
    # the empty-criteria guard above so a spec with ONLY classify on (and
    # everything else disabled) still passes — classify counts.
    auto_enable_wayback_for_classify(norm_spec)
    spec_json = norm_spec.model_dump_json()

    name = (payload.name or "").strip() or _autoname(cleaned_domains)
    notes = (payload.notes or "").strip()

    job = Job(name=name, notes=notes, spec_json=spec_json)
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
