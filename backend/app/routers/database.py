"""Database page endpoints — domain-centric view across all jobs.

The Jobs/Runs tree is "how I batched the work"; the Database is "what do I
know about each domain."

Pin model (LOCKED 2026-05-08): every Database row's data comes from a
manually-pinned RunDomain (`RunDomain.is_pinned=True`). At most one rd per
`domain` is pinned at any time. When no rd is pinned for a domain, the
row still appears (so the user can pin one) but every cell — Ahrefs
verdicts, Wayback, AI provenance, final assessment — renders empty. There
is NO automatic fallback to the latest run; the previous "latest-per-
criterion" stitching has been removed at the user's request to make the
Database surface fully curatorial.

Notes remain domain-keyed (cross-run, decision #17) and are unaffected by
the pin.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CriterionResult, DomainNote, Job, Run, RunDomain
from ..schemas import AnalyzeSpec

router = APIRouter(prefix="/database", tags=["database"])


# --- Response schemas -------------------------------------------------------

class CriterionSummary(BaseModel):
    enabled: bool
    rows: int  # row count from CriterionResult.data_json
    cached_from_run_id: int | None
    ai_cached_from_run_id: int | None
    sort_fields: list[str] = Field(default_factory=list)


class PinOption(BaseModel):
    """One candidate run a user can pin for this domain. The Database UI
    surfaces these in a dropdown so the user can switch the pin without
    leaving the page."""
    run_domain_id: int
    run_id: int
    run_name: str
    job_id: int
    job_name: str
    status: str
    finished_at: datetime | None


class DomainRow(BaseModel):
    domain: str
    # True when a RunDomain for this domain has is_pinned=True. When False,
    # all cell values below are empty/zero — the row exists only so the
    # user can choose which run to pin.
    is_pinned: bool = False
    # Identity of the pinned RunDomain (and click-through pointers). All
    # null when is_pinned is False. Frontend navigates to
    # /jobs/{job_id}/runs/{run_id}/domains/{run_domain_id}.
    pinned_run_domain_id: int | None = None
    pinned_run_id: int | None = None
    pinned_job_id: int | None = None
    pinned_job_name: str = ""
    pinned_finished_at: datetime | None = None
    pinned_started_at: datetime | None = None
    pinned_run_name: str = ""
    # Verdict + AI metadata — sourced from the pinned RunDomain only.
    final_summary: str = ""
    final_score: float | None = None
    final_confidence: float | None = None
    final_bucket: str = ""
    final_partial: bool = False
    ai_provider: str = ""
    ai_model: str = ""
    spec_ai_provider: str = ""
    spec_ai_model: str = ""
    # Per-criterion summary, all from the pinned rd's CRs only. Empty cell
    # for a criterion that didn't run on the pinned rd.
    criteria: dict[str, CriterionSummary] = Field(default_factory=dict)
    # Wayback verdict — surfaced separately from the aggregated final
    # since wayback is informational (default weight=0).
    wayback_assessment: str = ""
    wayback_confidence: float | None = None
    wayback_samples_count: int = 0
    # wayback_classify outputs (added 2026-05-09) — language + theme +
    # category derived from the wayback V2 samples. All sourced from the
    # pinned RunDomain's wayback_classify CR row only. Empty when the
    # criterion isn't enabled / hasn't run / failed for the pinned rd.
    primary_language: str = ""
    secondary_languages: list[str] = Field(default_factory=list)
    language_confidence: float | None = None
    primary_theme: str = ""
    secondary_themes: list[str] = Field(default_factory=list)
    theme_confidence: float | None = None
    classify_drift_detected: bool = False
    category: str = ""
    category_confidence: float | None = None
    category_was: str = ""
    # Across-runs aggregates for the domain (independent of the pin).
    total_runs: int
    any_cached: bool = False
    # User-authored note (cross-run, survives reruns and pinning).
    note: str = ""
    note_updated_at: datetime | None = None
    # Number of pinnable RunDomains for this domain. The full list of
    # PinOption objects is NOT included here — it's lazy-loaded via
    # `GET /database/domains/{domain}/pin-options` when the user opens
    # the pin dropdown. Used to be inline and was inflating the
    # /database/domains payload by 5-15 nested objects per row.
    pin_options_count: int = 0
    # Backlog cross-link (added 2026-05-10). Joined by `domain`. The
    # Database row exposes the current backlog status so the inline
    # Order/Discard actions know what's already set, and creates a
    # backlog row on first action for ad-hoc-analyzed domains. Both
    # null when the domain has no backlog row yet.
    backlog_id: int | None = None
    backlog_status: str | None = None


class DomainListResponse(BaseModel):
    rows: list[DomainRow]
    # Materialized filter universes — easier than reconstructing on the
    # frontend. Sorted, no dedup needed beyond what the set provides.
    # Always computed across the FULL row set (regardless of pagination)
    # so the dropdown options stay complete.
    filter_options: dict[str, list[str]]
    # Total domain count across all pages (added 2026-05-10 for
    # optional server-side pagination — see ?offset=&limit= on
    # /database/domains).
    total: int = 0


# --- Helpers ----------------------------------------------------------------

CRITERIA = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify",
)


def _row_count(data_json: str) -> int:
    """Count rows inside a CriterionResult.data_json body. Ahrefs wraps the
    list under a key matching the criterion (e.g. {"backlinks": [...]})."""
    if not data_json:
        return 0
    try:
        body = json.loads(data_json)
    except json.JSONDecodeError:
        return 0
    if isinstance(body, dict):
        for v in body.values():
            if isinstance(v, list):
                return len(v)
    return 0


def _spec_for_run(spec_json: str) -> AnalyzeSpec | None:
    if not spec_json:
        return None
    try:
        return AnalyzeSpec.model_validate(json.loads(spec_json))
    except Exception:  # noqa: BLE001
        return None


_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _parse_final_score(parsed: dict | None) -> float | None:
    if not isinstance(parsed, dict):
        return None
    f = parsed.get("final")
    if isinstance(f, bool):
        return None
    if isinstance(f, (int, float)) and -1 <= f <= 1000:
        return float(f)
    if isinstance(f, str):
        m = _NUMBER_RE.search(f)
        if m:
            try:
                return float(m.group(0))
            except ValueError:
                pass
    return None


def _parse_final_confidence(parsed: dict | None) -> float | None:
    if not isinstance(parsed, dict):
        return None
    c = parsed.get("confidence")
    if isinstance(c, bool):
        return None
    if isinstance(c, (int, float)) and 0.0 <= c <= 1.0:
        return float(c)
    return None


def _bucket_for(
    parsed: dict | None,
    summary_text: str,
    *,
    good_threshold: float | None = None,
    mixed_threshold: float | None = None,
) -> str:
    if good_threshold is None or mixed_threshold is None:
        from ..app_settings import get_scoring_config
        cfg = get_scoring_config()
        if good_threshold is None:
            good_threshold = cfg["good_threshold"]
        if mixed_threshold is None:
            mixed_threshold = cfg["mixed_threshold"]
    score = _parse_final_score(parsed)
    if score is not None:
        if score >= good_threshold:
            return "good"
        if score >= mixed_threshold:
            return "mixed"
        return "low_quality"
    candidates: list[str] = []
    if isinstance(parsed, dict):
        f = parsed.get("final")
        if isinstance(f, str):
            candidates.append(f)
    if summary_text:
        candidates.append(summary_text)
    for c in candidates:
        s = c.strip().lower()
        if s in ("good", "quality", "high_quality"):
            return "good"
        if s == "mixed":
            return "mixed"
        if s in ("low_quality", "low"):
            return "low_quality"
    return ""


# --- Endpoint ---------------------------------------------------------------

@router.get("/domains", response_model=DomainListResponse)
def list_domains(
    db: Session = Depends(get_db),
    offset: int = 0,
    limit: int | None = None,
) -> DomainListResponse:
    """One row per unique domain across all jobs/runs.

    Each row's data comes from the explicitly-pinned RunDomain (if any).
    Domains with no pin still appear so the user can pin one — their cells
    are blank. Notes are domain-keyed and unaffected by the pin.

    Pagination (added 2026-05-10): pass `offset` + `limit` to slice the
    response. Filter universes (`filter_options`) are always computed
    across the FULL row set so the frontend dropdowns stay complete.
    `total` is the unpaginated row count. When `limit` is omitted (the
    default and the legacy behavior) the full list is returned."""
    all_rds: list[RunDomain] = db.query(RunDomain).all()
    rds_by_domain: dict[str, list[RunDomain]] = defaultdict(list)
    for rd in all_rds:
        rds_by_domain[rd.domain].append(rd)

    all_run_ids = {rd.run_id for rd in all_rds}
    runs = {r.id: r for r in db.query(Run).filter(Run.id.in_(all_run_ids)).all()} if all_run_ids else {}
    job_ids = {r.job_id for r in runs.values()}
    jobs = {j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()} if job_ids else {}

    # Eager-load CriterionResults for the pinned rds only — no need to walk
    # the rest. We figure out which rds are pinned first, then load their
    # CRs in a single query.
    pinned_rd_ids = {rd.id for rd in all_rds if rd.is_pinned}
    cr_rows: list[CriterionResult] = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(pinned_rd_ids))
        .all()
    ) if pinned_rd_ids else []
    crs_by_rd: dict[int, dict[str, CriterionResult]] = defaultdict(dict)
    for cr in cr_rows:
        crs_by_rd[cr.run_domain_id][cr.criterion] = cr

    # Notes: same IN-list pattern as backlog below. The notes table is
    # smaller in practice but the principle is identical — fetch only
    # the rows the page will actually display. (Index added 2026-05-10
    # alongside this change; see _migrate_sqlite_columns.)
    domain_keys = list(rds_by_domain.keys())
    notes_by_domain: dict[str, DomainNote] = {}
    if domain_keys:
        notes_by_domain = {
            n.domain: n
            for n in db.query(DomainNote)
            .filter(DomainNote.domain.in_(domain_keys))
            .all()
        }
    # Backlog cross-link: join by `domain` so the Database row exposes
    # the current backlog status. CRITICAL: filter to the ~tens of
    # domains actually shown on the Database page — the backlog table
    # holds 100k+ rows in normal use, and a full-table fetch here was
    # the cause of the page's perceived slowness (regression introduced
    # 2026-05-10 in the same commit that added the Backlog column).
    # `domain` is indexed (see models.BacklogDomain) so the IN-list
    # query is sub-millisecond.
    from ..models import BacklogDomain
    backlog_by_domain: dict[str, BacklogDomain] = {}
    if domain_keys:
        backlog_by_domain = {
            b.domain: b
            for b in db.query(BacklogDomain)
            .filter(BacklogDomain.domain.in_(domain_keys))
            .all()
        }

    from ..app_settings import get_scoring_config
    sc = get_scoring_config()
    good_t = sc["good_threshold"]
    mixed_t = sc["mixed_threshold"]

    rows: list[DomainRow] = []
    providers: set[str] = set()
    models: set[str] = set()
    verdicts: set[str] = set()
    wayback_assessments: set[str] = set()
    # Filter universes for wayback_classify columns (added 2026-05-09).
    languages_seen: set[str] = set()
    categories_seen: set[str] = set()

    for domain, domain_rds in rds_by_domain.items():
        domain_rds_sorted = sorted(domain_rds, key=lambda r: r.id, reverse=True)
        # Build the pin-options dropdown for the UI. Always present so the
        # user can pick or change the pin.
        pin_options: list[PinOption] = []
        for d in domain_rds_sorted:
            d_run = runs.get(d.run_id)
            if d_run is None:
                continue
            d_job = jobs.get(d_run.job_id)
            if d_job is None:
                continue
            pin_options.append(PinOption(
                run_domain_id=d.id,
                run_id=d_run.id,
                run_name=d_run.name or "",
                job_id=d_job.id,
                job_name=d_job.name,
                status=d.status,
                finished_at=d.finished_at,
            ))

        pinned_rd = next((d for d in domain_rds if d.is_pinned), None)
        note_row = notes_by_domain.get(domain)

        backlog_row = backlog_by_domain.get(domain)
        if pinned_rd is None:
            # Empty row — user has yet to pin. Still emit so it's pickable.
            rows.append(DomainRow(
                domain=domain,
                is_pinned=False,
                criteria={
                    c: CriterionSummary(
                        enabled=False, rows=0, cached_from_run_id=None,
                        ai_cached_from_run_id=None, sort_fields=[],
                    )
                    for c in CRITERIA
                },
                total_runs=len(domain_rds),
                any_cached=False,
                note=(note_row.note if note_row else ""),
                note_updated_at=(note_row.updated_at if note_row else None),
                pin_options_count=len(pin_options),
                backlog_id=backlog_row.id if backlog_row else None,
                backlog_status=backlog_row.status if backlog_row else None,
            ))
            continue

        run = runs.get(pinned_rd.run_id)
        if run is None:
            # Defensive — shouldn't happen, but skip rather than crash.
            continue
        job = jobs.get(run.job_id)
        if job is None:
            continue
        spec = _spec_for_run(run.spec_json)

        spec_ai_provider = ""
        spec_ai_model = ""
        enabled_map: dict[str, bool] = {c: False for c in CRITERIA}
        sort_map: dict[str, list[str]] = {c: [] for c in CRITERIA}
        if spec is not None:
            if spec.ai is not None:
                spec_ai_provider = spec.ai.provider or ""
                spec_ai_model = spec.ai.model or ""
            for c in CRITERIA:
                cfg = getattr(spec.criteria, c, None)
                if cfg is None:
                    continue
                enabled_map[c] = bool(cfg.enabled)
                sort_rules = getattr(cfg, "sort", []) or []
                sort_map[c] = [r.field for r in sort_rules]

        crs_for_rd = crs_by_rd.get(pinned_rd.id, {})

        criteria_summary: dict[str, CriterionSummary] = {}
        any_cached = False
        for c in CRITERIA:
            cr = crs_for_rd.get(c)
            criteria_summary[c] = CriterionSummary(
                enabled=enabled_map[c],
                rows=_row_count(cr.data_json) if cr else 0,
                cached_from_run_id=cr.cached_from_run_id if cr else None,
                ai_cached_from_run_id=(
                    cr.ai_cached_from_run_id if cr else None
                ),
                sort_fields=sort_map[c],
            )
            if cr and cr.cached_from_run_id is not None:
                any_cached = True

        # Final assessment from the pinned rd's row (no fallback to other runs).
        parsed: dict | None = None
        if pinned_rd.final_assessment_json:
            try:
                parsed = json.loads(pinned_rd.final_assessment_json)
            except json.JSONDecodeError:
                parsed = None
        final_summary_text = (pinned_rd.final_summary or "").strip()
        partial = bool(isinstance(parsed, dict) and parsed.get("partial"))
        if partial:
            score = None
            confidence = None
            bucket = ""
        else:
            score = _parse_final_score(parsed)
            confidence = _parse_final_confidence(parsed)
            bucket = _bucket_for(
                parsed, final_summary_text,
                good_threshold=good_t, mixed_threshold=mixed_t,
            )

        verdict_provider = (
            isinstance(parsed, dict) and (parsed.get("provider") or "") or ""
        )
        verdict_model = (
            isinstance(parsed, dict) and (parsed.get("model") or "") or ""
        )
        ai_provider = verdict_provider or spec_ai_provider
        ai_model = verdict_model or spec_ai_model

        if ai_provider:
            providers.add(ai_provider)
        if ai_model:
            models.add(ai_model)
        if bucket:
            verdicts.add(bucket)

        # Wayback per-criterion verdict for the pinned rd only.
        wayback_assessment = ""
        wayback_confidence: float | None = None
        wayback_samples_count = 0
        wayback_cr = crs_for_rd.get("wayback")
        if wayback_cr is not None and wayback_cr.ai_verdict_json:
            try:
                w_parsed = json.loads(wayback_cr.ai_verdict_json)
            except json.JSONDecodeError:
                w_parsed = None
            if isinstance(w_parsed, dict):
                a = w_parsed.get("assessment")
                if isinstance(a, str):
                    wayback_assessment = a
                    wayback_assessments.add(a)
                c = w_parsed.get("confidence")
                if isinstance(c, (int, float)) and not isinstance(c, bool):
                    if 0.0 <= float(c) <= 1.0:
                        wayback_confidence = float(c)
        if wayback_cr is not None and wayback_cr.data_json:
            try:
                w_body = json.loads(wayback_cr.data_json)
            except json.JSONDecodeError:
                w_body = None
            if isinstance(w_body, dict):
                samples = w_body.get("samples")
                if isinstance(samples, list):
                    wayback_samples_count = len(samples)

        # wayback_classify per-criterion verdict for the pinned rd only.
        # Schema (from wayback_classify.py): {primary_language,
        # secondary_languages, language_confidence, primary_theme,
        # secondary_themes, theme_confidence, drift_detected, history?,
        # category, category_confidence, category_was?, ...}.
        primary_language = ""
        secondary_languages: list[str] = []
        language_confidence: float | None = None
        primary_theme = ""
        secondary_themes: list[str] = []
        theme_confidence: float | None = None
        classify_drift_detected = False
        category = ""
        category_confidence: float | None = None
        category_was = ""
        classify_cr = crs_for_rd.get("wayback_classify")
        if classify_cr is not None and classify_cr.ai_verdict_json:
            try:
                wc_parsed = json.loads(classify_cr.ai_verdict_json)
            except json.JSONDecodeError:
                wc_parsed = None
            if isinstance(wc_parsed, dict):
                v = wc_parsed.get("primary_language")
                if isinstance(v, str) and v:
                    primary_language = v
                    languages_seen.add(v)
                sl = wc_parsed.get("secondary_languages")
                if isinstance(sl, list):
                    secondary_languages = [
                        s for s in sl if isinstance(s, str) and s
                    ]
                lc = wc_parsed.get("language_confidence")
                if isinstance(lc, (int, float)) and not isinstance(lc, bool):
                    if 0.0 <= float(lc) <= 1.0:
                        language_confidence = float(lc)
                t = wc_parsed.get("primary_theme")
                if isinstance(t, str):
                    primary_theme = t
                st = wc_parsed.get("secondary_themes")
                if isinstance(st, list):
                    secondary_themes = [
                        s for s in st if isinstance(s, str) and s
                    ]
                tc = wc_parsed.get("theme_confidence")
                if isinstance(tc, (int, float)) and not isinstance(tc, bool):
                    if 0.0 <= float(tc) <= 1.0:
                        theme_confidence = float(tc)
                classify_drift_detected = bool(wc_parsed.get("drift_detected"))
                cat = wc_parsed.get("category")
                if isinstance(cat, str) and cat:
                    category = cat
                    categories_seen.add(cat)
                cc = wc_parsed.get("category_confidence")
                if isinstance(cc, (int, float)) and not isinstance(cc, bool):
                    if 0.0 <= float(cc) <= 1.0:
                        category_confidence = float(cc)
                cw = wc_parsed.get("category_was")
                if isinstance(cw, str):
                    category_was = cw

        rows.append(DomainRow(
            domain=domain,
            is_pinned=True,
            pinned_run_domain_id=pinned_rd.id,
            pinned_run_id=run.id,
            pinned_job_id=job.id,
            pinned_job_name=job.name,
            pinned_run_name=run.name or "",
            pinned_finished_at=pinned_rd.finished_at,
            pinned_started_at=pinned_rd.started_at,
            final_summary=final_summary_text,
            final_score=score,
            final_confidence=confidence,
            final_bucket=bucket,
            final_partial=partial,
            ai_provider=ai_provider,
            ai_model=ai_model,
            spec_ai_provider=spec_ai_provider,
            spec_ai_model=spec_ai_model,
            criteria=criteria_summary,
            wayback_assessment=wayback_assessment,
            wayback_confidence=wayback_confidence,
            wayback_samples_count=wayback_samples_count,
            primary_language=primary_language,
            secondary_languages=secondary_languages,
            language_confidence=language_confidence,
            primary_theme=primary_theme,
            secondary_themes=secondary_themes,
            theme_confidence=theme_confidence,
            classify_drift_detected=classify_drift_detected,
            category=category,
            category_confidence=category_confidence,
            category_was=category_was,
            total_runs=len(domain_rds),
            any_cached=any_cached,
            note=(note_row.note if note_row else ""),
            note_updated_at=(note_row.updated_at if note_row else None),
            pin_options_count=len(pin_options),
            backlog_id=backlog_row.id if backlog_row else None,
            backlog_status=backlog_row.status if backlog_row else None,
        ))

    # Sort: pinned rows first (by pinned_finished_at desc), then unpinned
    # rows alphabetically.
    rows.sort(
        key=lambda r: (
            0 if r.is_pinned else 1,
            -(r.pinned_finished_at.timestamp() if r.pinned_finished_at else 0)
            if r.is_pinned else 0,
            r.domain,
        ),
    )

    total = len(rows)
    if limit is not None:
        # Slice AFTER the global sort + filter-options computation so
        # paged consumers still see a stable, complete picture.
        sliced = rows[offset : offset + max(0, limit)]
    else:
        sliced = rows
    return DomainListResponse(
        rows=sliced,
        filter_options={
            "ai_providers": sorted(providers),
            "ai_models": sorted(models),
            "verdicts": sorted(verdicts),
            "wayback_verdicts": sorted(wayback_assessments),
            "languages": sorted(languages_seen),
            "categories": sorted(categories_seen),
        },
        total=total,
    )


# --- Pin / unpin endpoints --------------------------------------------------

class PinIn(BaseModel):
    run_domain_id: int


class PinOut(BaseModel):
    domain: str
    pinned_run_domain_id: int


@router.post("/domains/{domain}/pin", response_model=PinOut)
def pin_domain(
    domain: str, payload: PinIn, db: Session = Depends(get_db)
) -> PinOut:
    """Pin a specific RunDomain as the definitive source for `domain` on
    the Database page. Idempotent — already-pinned rd is a no-op. Clears
    any other pin for the same domain in the same transaction so the
    "at most one pinned per domain" invariant holds without a DB constraint."""
    domain = domain.strip()
    if not domain:
        raise HTTPException(400, "domain required")
    rd = db.get(RunDomain, payload.run_domain_id)
    if rd is None:
        raise HTTPException(404, f"run_domain {payload.run_domain_id} not found")
    if rd.domain != domain:
        raise HTTPException(
            400,
            f"run_domain {payload.run_domain_id} belongs to domain "
            f"'{rd.domain}', not '{domain}'",
        )
    # Clear any other pins for this domain.
    others = (
        db.query(RunDomain)
        .filter(RunDomain.domain == domain)
        .filter(RunDomain.is_pinned == True)  # noqa: E712
        .filter(RunDomain.id != rd.id)
        .all()
    )
    for o in others:
        o.is_pinned = False
    rd.is_pinned = True
    db.commit()
    return PinOut(domain=domain, pinned_run_domain_id=rd.id)


@router.delete("/domains/{domain}/pin")
def unpin_domain(domain: str, db: Session = Depends(get_db)) -> dict:
    """Clear the pin for a domain. Idempotent — no-op when no rd is pinned."""
    domain = domain.strip()
    if not domain:
        raise HTTPException(400, "domain required")
    rds = (
        db.query(RunDomain)
        .filter(RunDomain.domain == domain)
        .filter(RunDomain.is_pinned == True)  # noqa: E712
        .all()
    )
    for rd in rds:
        rd.is_pinned = False
    db.commit()
    return {"unpinned": domain, "count": len(rds)}


# --- Domain bulk delete (unchanged behavior) -------------------------------

class DeleteDomainsIn(BaseModel):
    domains: list[str]


class DeleteDomainsOut(BaseModel):
    deleted_run_domains: int
    deleted_runs: int = 0
    deleted_jobs: int = 0
    domains: list[str]


_TERMINAL_RUN_STATUSES = ("done", "failed", "canceled")


@router.post("/domains/delete", response_model=DeleteDomainsOut)
def delete_domains(
    payload: DeleteDomainsIn, db: Session = Depends(get_db)
) -> DeleteDomainsOut:
    """Bulk-delete every RunDomain (and CriterionResult via cascade) whose
    domain string matches one in `payload.domains`."""
    cleaned = sorted({d.strip() for d in payload.domains if d.strip()})
    if not cleaned:
        raise HTTPException(400, "no domains provided")

    rds = db.query(RunDomain).filter(RunDomain.domain.in_(cleaned)).all()
    deleted_run_domains = len(rds)
    affected_run_ids = {rd.run_id for rd in rds}
    for rd in rds:
        db.delete(rd)
    db.flush()

    deleted_runs = 0
    affected_job_ids: set[int] = set()
    if affected_run_ids:
        empty_runs = (
            db.query(Run)
            .filter(Run.id.in_(affected_run_ids))
            .filter(Run.status.in_(_TERMINAL_RUN_STATUSES))
            .filter(~Run.domains.any())
            .all()
        )
        affected_job_ids = {r.job_id for r in empty_runs}
        deleted_runs = len(empty_runs)
        for r in empty_runs:
            db.delete(r)
        db.flush()

    deleted_jobs = 0
    if affected_job_ids:
        empty_jobs = (
            db.query(Job)
            .filter(Job.id.in_(affected_job_ids))
            .filter(~Job.runs.any())
            .all()
        )
        deleted_jobs = len(empty_jobs)
        for j in empty_jobs:
            db.delete(j)

    db.query(DomainNote).filter(DomainNote.domain.in_(cleaned)).delete(
        synchronize_session=False
    )
    db.commit()
    return DeleteDomainsOut(
        deleted_run_domains=deleted_run_domains,
        deleted_runs=deleted_runs,
        deleted_jobs=deleted_jobs,
        domains=cleaned,
    )


# --- Notes (domain-keyed, cross-run) ---------------------------------------

class NotePayload(BaseModel):
    note: str


class NoteOut(BaseModel):
    domain: str
    note: str
    updated_at: datetime


@router.get("/notes/{domain}", response_model=NoteOut | None)
def get_note(domain: str, db: Session = Depends(get_db)) -> NoteOut | None:
    row = db.get(DomainNote, domain)
    if row is None:
        return None
    return NoteOut(domain=row.domain, note=row.note, updated_at=row.updated_at)


@router.put("/notes/{domain}", response_model=NoteOut)
def upsert_note(
    domain: str, payload: NotePayload, db: Session = Depends(get_db)
) -> NoteOut:
    domain = domain.strip()
    if not domain:
        raise HTTPException(400, "domain required")
    row = db.get(DomainNote, domain)
    if row is None:
        row = DomainNote(domain=domain, note=payload.note)
        db.add(row)
    else:
        row.note = payload.note
        row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return NoteOut(domain=row.domain, note=row.note, updated_at=row.updated_at)


@router.delete("/notes/{domain}")
def delete_note(domain: str, db: Session = Depends(get_db)) -> dict:
    row = db.get(DomainNote, domain)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"deleted": domain}


# --- Bulk reanalyze --------------------------------------------------------

class BulkReanalyzeIn(BaseModel):
    run_domain_ids: list[int]
    provider: str | None = None
    model: str | None = None


class BulkReanalyzeItem(BaseModel):
    run_domain_id: int
    started: bool
    error: str = ""


class BulkReanalyzeOut(BaseModel):
    started: int
    skipped: int
    items: list[BulkReanalyzeItem]


@router.post("/domains/bulk-reanalyze", response_model=BulkReanalyzeOut)
async def bulk_reanalyze(payload: BulkReanalyzeIn) -> BulkReanalyzeOut:
    from ..tasks import reanalyze_run_domain_now
    if not payload.run_domain_ids:
        raise HTTPException(400, "no run_domain_ids provided")
    override: dict | None = None
    if payload.provider or payload.model:
        override = {"provider": payload.provider, "model": payload.model}
    items: list[BulkReanalyzeItem] = []
    started = 0
    skipped = 0
    seen: set[int] = set()
    for rd_id in payload.run_domain_ids:
        if rd_id in seen:
            continue
        seen.add(rd_id)
        result = reanalyze_run_domain_now(rd_id, ai_override=override)
        if result.get("found") is False:
            items.append(BulkReanalyzeItem(
                run_domain_id=rd_id, started=False, error="not found",
            ))
            skipped += 1
        elif "error" in result:
            items.append(BulkReanalyzeItem(
                run_domain_id=rd_id, started=False, error=result["error"],
            ))
            skipped += 1
        else:
            items.append(BulkReanalyzeItem(run_domain_id=rd_id, started=True))
            started += 1
    return BulkReanalyzeOut(started=started, skipped=skipped, items=items)


# --- Lazy pin_options (added 2026-05-10) -----------------------------------
# Returns the full pinnable-runs list for ONE domain — used when the user
# opens the pin dropdown on the Database page. The /database/domains
# response only includes a count; loading the per-domain options here
# saves 5-15 nested objects per row × every page load.

class PinOptionsOut(BaseModel):
    domain: str
    options: list[PinOption]


@router.get(
    "/domains/{domain}/pin-options",
    response_model=PinOptionsOut,
)
def get_pin_options(
    domain: str, db: Session = Depends(get_db),
) -> PinOptionsOut:
    rds = (
        db.query(RunDomain)
        .filter(RunDomain.domain == domain)
        .order_by(RunDomain.id.desc())
        .all()
    )
    if not rds:
        return PinOptionsOut(domain=domain, options=[])
    run_ids = {rd.run_id for rd in rds}
    runs = {
        r.id: r for r in db.query(Run).filter(Run.id.in_(run_ids)).all()
    }
    job_ids = {r.job_id for r in runs.values()}
    jobs = {
        j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()
    }
    options: list[PinOption] = []
    for rd in rds:
        run = runs.get(rd.run_id)
        if run is None:
            continue
        job = jobs.get(run.job_id)
        if job is None:
            continue
        options.append(PinOption(
            run_domain_id=rd.id,
            run_id=run.id,
            run_name=run.name or "",
            job_id=job.id,
            job_name=job.name,
            status=rd.status,
            finished_at=rd.finished_at,
        ))
    return PinOptionsOut(domain=domain, options=options)


# --- Backlog status from Database (added 2026-05-10) -----------------------
# Lets the user mark a domain as ordered/discarded/etc. directly from the
# Database row without bouncing back to the Backlog page. Upserts: if the
# domain already has a backlog row, PATCH its status; if not (ad-hoc
# analyzed), create one with the chosen status. Result: Backlog becomes a
# single source of truth for "current standing of every domain I've ever
# considered," even when the analysis bypassed the import flow.

class BacklogStatusIn(BaseModel):
    status: str


class BacklogStatusOut(BaseModel):
    domain: str
    backlog_id: int
    status: str
    created: bool  # True when the upsert had to insert a fresh row


@router.post(
    "/domains/{domain}/backlog-status",
    response_model=BacklogStatusOut,
)
def set_backlog_status(
    domain: str,
    payload: BacklogStatusIn,
    db: Session = Depends(get_db),
) -> BacklogStatusOut:
    from ..models import BACKLOG_STATUSES, BacklogDomain

    if payload.status not in BACKLOG_STATUSES:
        raise HTTPException(400, f"unknown status: {payload.status}")
    # Normalize the same way backlog import does — lowercase + strip
    # scheme/path so a domain typed as `https://Example.com/page` matches
    # the canonical `example.com` row.
    normalized = domain.strip().lower()
    for prefix in ("https://", "http://"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
    normalized = normalized.split("/", 1)[0]
    if not normalized:
        raise HTTPException(400, "domain is empty")

    existing = (
        db.query(BacklogDomain)
        .filter(BacklogDomain.domain == normalized)
        .one_or_none()
    )
    now = datetime.utcnow()
    if existing is not None:
        existing.status = payload.status
        existing.updated_at = now
        db.commit()
        return BacklogStatusOut(
            domain=normalized,
            backlog_id=existing.id,
            status=existing.status,
            created=False,
        )
    # Auto-create for ad-hoc analyzed domains. Other backlog fields stay
    # at their defaults (registrar/expiration/comments/prices left empty).
    row = BacklogDomain(
        domain=normalized,
        status=payload.status,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    return BacklogStatusOut(
        domain=normalized,
        backlog_id=row.id,
        status=row.status,
        created=True,
    )


# --- Bulk variant of the same upsert (added 2026-05-10) -------------------

class BulkBacklogStatusIn(BaseModel):
    domains: list[str]
    status: str


class BulkBacklogStatusOut(BaseModel):
    updated: int
    created: int
    skipped: int
    status: str


@router.post(
    "/domains/bulk-backlog-status",
    response_model=BulkBacklogStatusOut,
)
def bulk_set_backlog_status(
    payload: BulkBacklogStatusIn,
    db: Session = Depends(get_db),
) -> BulkBacklogStatusOut:
    """Apply the same status to many domains in one round-trip. Same
    upsert semantics as the per-domain endpoint: existing rows get
    PATCHed, missing ones get created. Counts are returned so the UI
    can render a meaningful "Marked N as ordered (M created)" hint."""
    from ..models import BACKLOG_STATUSES, BacklogDomain

    if payload.status not in BACKLOG_STATUSES:
        raise HTTPException(400, f"unknown status: {payload.status}")
    if not payload.domains:
        raise HTTPException(400, "no domains provided")

    # Normalize once — same rule as the single-row endpoint.
    normalized: list[str] = []
    seen: set[str] = set()
    for d in payload.domains:
        s = d.strip().lower()
        for prefix in ("https://", "http://"):
            if s.startswith(prefix):
                s = s[len(prefix):]
        s = s.split("/", 1)[0]
        if s and s not in seen:
            normalized.append(s)
            seen.add(s)
    if not normalized:
        raise HTTPException(400, "no valid domains after normalization")

    now = datetime.utcnow()
    existing = {
        b.domain: b
        for b in db.query(BacklogDomain)
        .filter(BacklogDomain.domain.in_(normalized))
        .all()
    }
    updated = 0
    created = 0
    for d in normalized:
        row = existing.get(d)
        if row is not None:
            row.status = payload.status
            row.updated_at = now
            updated += 1
        else:
            db.add(BacklogDomain(
                domain=d,
                status=payload.status,
                created_at=now,
                updated_at=now,
            ))
            created += 1
    db.commit()
    return BulkBacklogStatusOut(
        updated=updated,
        created=created,
        skipped=len(payload.domains) - len(normalized),
        status=payload.status,
    )
