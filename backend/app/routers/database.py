"""Database page endpoints — domain-centric view across all jobs.

The Jobs/Runs tree is "how I batched the work"; the Database is "what do I
know about each domain."

Pin model v2 (LOCKED 2026-05-12): each (job, criterion) can have at most
one pinned Run. For each domain on the Database page, every criterion is
sourced INDEPENDENTLY from whichever pinned Run provides it: walk the
pins across all jobs that contain the domain, pick the most recent one
per criterion (by Run.finished_at desc). A row therefore can carry data
stitched from multiple runs — supports iterative workflows ("Wayback
first; if good, Ahrefs"). There is NO fallback to non-pinned runs — an
unpinned criterion renders empty.

When criteria come from multiple runs, FinalBanner becomes "partial"
even if individual run rds had complete-final verdicts: we re-derive a
synthetic final from the per-criterion AI verdicts and mark
`final_partial=True` with `pinned_criteria=[…]` so the UI can show
"Partial — based on W, B".

Notes remain domain-keyed (cross-run) and are unaffected by the pin.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections import Counter, defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

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

router = APIRouter(prefix="/database", tags=["database"])


# --- Response schemas -------------------------------------------------------

class CriterionSummary(BaseModel):
    enabled: bool
    rows: int  # row count from CriterionResult.data_json
    cached_from_run_id: int | None
    ai_cached_from_run_id: int | None
    sort_fields: list[str] = Field(default_factory=list)
    # Per-criterion source attribution (added 2026-05-12). Populated when
    # this criterion is sourced from a (job, criterion) pin — points at
    # the pinned Run + its job, so the Database UI can render tooltips
    # like "B from Run #3 in Job 'Q4 drops'". All null when criterion is
    # not pinned (the column renders empty).
    source_run_id: int | None = None
    source_run_name: str = ""
    source_job_id: int | None = None
    source_job_name: str = ""
    source_run_domain_id: int | None = None


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
    # Legacy combined flag: failed-at-synth OR underweight. Kept for
    # back-compat with readers that haven't migrated to the split. New
    # code should branch on `final_failed` / `final_underweight` so
    # the UI can render distinct badges (error vs subset).
    final_partial: bool = False
    # 2026-05-14 split. `final_failed` mirrors the rd's
    # final_assessment_json.partial — an enabled criterion failed at
    # AI synth time (genuine error state). `final_underweight` is the
    # subset-of-weighted-criteria state — weight>0 criterion isn't
    # pinned, so the score is derived from fewer signals than the
    # weights envision. Both can be true simultaneously.
    final_failed: bool = False
    final_underweight: bool = False
    # Weighted criteria that are NOT in pinned_criteria. Populated only
    # when final_underweight is true; lets the UI tooltip say
    # "missing: D, A" instead of inverting "pinned: B, W".
    missing_weighted_criteria: list[str] = Field(default_factory=list)
    # Sorted list of criterion names that have a pin contributing to this
    # row (added 2026-05-12). Empty when no criterion is pinned for this
    # domain. The UI uses it to render "Partial — based on W, B" alongside
    # the FinalBanner whenever len(pinned_criteria) < enabled criteria.
    pinned_criteria: list[str] = Field(default_factory=list)
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
    # Ban-list flag (added 2026-05-13 wave L). True when this domain is
    # on the ban list — drives the "banned" badge on Database rows.
    # Banning is orthogonal to pin/backlog status: a row can be both
    # pinned AND banned (per design call (i), the row stays visible
    # after banning so the user retains the audit trail).
    is_banned: bool = False


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
    rds_by_run_and_domain: dict[tuple[int, str], RunDomain] = {}
    for rd in all_rds:
        rds_by_domain[rd.domain].append(rd)
        rds_by_run_and_domain[(rd.run_id, rd.domain)] = rd

    all_run_ids = {rd.run_id for rd in all_rds}
    runs = {r.id: r for r in db.query(Run).filter(Run.id.in_(all_run_ids)).all()} if all_run_ids else {}
    job_ids = {r.job_id for r in runs.values()}
    jobs = {j.id: j for j in db.query(Job).filter(Job.id.in_(job_ids)).all()} if job_ids else {}

    # Per-(job, criterion) pins. Build a lookup that the per-domain loop
    # uses to resolve "which rd supplies criterion C for domain D?":
    #   pins_by_job[job_id][criterion] = run_id
    pin_rows: list[JobCriterionPin] = db.query(JobCriterionPin).all()
    pins_by_job: dict[int, dict[str, int]] = defaultdict(dict)
    for p in pin_rows:
        pins_by_job[p.job_id][p.criterion] = p.run_id

    # Set of (run_id, criterion) we actually need CriterionResults for —
    # only the criteria that have a pin AND a matching rd exist for the
    # domain in question. Compute once here so we can issue a single
    # IN-list query for CRs rather than per-domain.
    rd_ids_needed: set[int] = set()
    # Pre-resolve per-(domain, criterion) → (rd, run, job) so the main
    # loop doesn't re-walk pins_by_job.
    sources_by_domain: dict[str, dict[str, tuple[RunDomain, Run, Job]]] = {}
    for domain, domain_rds in rds_by_domain.items():
        # Which jobs contain this domain (via their runs)?
        jobs_for_domain: set[int] = set()
        for d in domain_rds:
            r = runs.get(d.run_id)
            if r is None:
                continue
            jobs_for_domain.add(r.job_id)
        if not jobs_for_domain:
            sources_by_domain[domain] = {}
            continue
        per_crit: dict[str, tuple[RunDomain, Run, Job]] = {}
        for crit in CRITERIA:
            # Candidate (run_id, finished_at) per job-with-pin-for-this-crit
            # — pick the most recent.
            best: tuple[datetime, RunDomain, Run, Job] | None = None
            for jid in jobs_for_domain:
                run_id = pins_by_job.get(jid, {}).get(crit)
                if run_id is None:
                    continue
                rd = rds_by_run_and_domain.get((run_id, domain))
                if rd is None:
                    # Pin points at a run that doesn't have this domain
                    # (legitimate when the domain set differs between
                    # runs in the same job). Skip — criterion stays empty
                    # for this domain even though the job has a pin.
                    continue
                run = runs.get(run_id)
                if run is None:
                    continue
                job = jobs.get(run.job_id)
                if job is None:
                    continue
                stamp = run.finished_at or datetime.min
                if best is None or stamp > best[0]:
                    best = (stamp, rd, run, job)
            if best is not None:
                per_crit[crit] = (best[1], best[2], best[3])
                rd_ids_needed.add(best[1].id)
        sources_by_domain[domain] = per_crit

    # Single IN-list for every CriterionResult we'll surface — covers
    # exactly the rds resolved above.
    cr_rows: list[CriterionResult] = (
        db.query(CriterionResult)
        .filter(CriterionResult.run_domain_id.in_(rd_ids_needed))
        .all()
    ) if rd_ids_needed else []
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

    # Banned-domain lookup (added 2026-05-13 wave L). Single IN-list
    # against `domain_bans` — same pattern as backlog_by_domain above.
    # Drives the per-row `is_banned` flag for the badge.
    from ..models import DomainBan
    banned_set: set[str] = set()
    if domain_keys:
        banned_set = {
            b.domain
            for b in db.query(DomainBan)
            .filter(DomainBan.domain.in_(domain_keys))
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

        per_crit_sources = sources_by_domain.get(domain, {})
        note_row = notes_by_domain.get(domain)
        backlog_row = backlog_by_domain.get(domain)

        if not per_crit_sources:
            # No criterion has a pin contributing to this domain. Emit an
            # empty row so the user can still pin one.
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
                is_banned=domain in banned_set,
                backlog_id=backlog_row.id if backlog_row else None,
                backlog_status=backlog_row.status if backlog_row else None,
            ))
            continue

        # Pick a "primary" source for the row-level pinned_* identity
        # fields (click-through, finished_at sort, ai provenance fallback)
        # — the most-recent contributing run wins. With per-criterion
        # pinning the row no longer has a single canonical rd, but the
        # frontend still wants ONE link target for the domain row chrome.
        primary_rd, primary_run, primary_job = max(
            per_crit_sources.values(),
            key=lambda triple: triple[1].finished_at or datetime.min,
        )

        # Pre-load spec for every contributing run so we know which
        # criteria each run had ENABLED — drives the per-criterion
        # "enabled" flag on the response.
        contributing_run_ids = {r.id for (_, r, _) in per_crit_sources.values()}
        specs_by_run: dict[int, AnalyzeSpec | None] = {}
        for rid in contributing_run_ids:
            r = runs.get(rid)
            specs_by_run[rid] = _spec_for_run(r.spec_json) if r else None

        spec_ai_provider = ""
        spec_ai_model = ""
        primary_spec = specs_by_run.get(primary_run.id)
        if primary_spec is not None and primary_spec.ai is not None:
            spec_ai_provider = primary_spec.ai.provider or ""
            spec_ai_model = primary_spec.ai.model or ""

        criteria_summary: dict[str, CriterionSummary] = {}
        any_cached = False
        # Collect per-criterion AI verdicts for synthetic-final derivation
        # below.
        per_crit_ai_verdicts: dict[str, dict] = {}
        for c in CRITERIA:
            src = per_crit_sources.get(c)
            if src is None:
                criteria_summary[c] = CriterionSummary(
                    enabled=False, rows=0, cached_from_run_id=None,
                    ai_cached_from_run_id=None, sort_fields=[],
                )
                continue
            src_rd, src_run, src_job = src
            src_spec = specs_by_run.get(src_run.id)
            enabled = False
            sort_fields: list[str] = []
            if src_spec is not None:
                cfg = getattr(src_spec.criteria, c, None)
                if cfg is not None:
                    enabled = bool(cfg.enabled)
                    sort_rules = getattr(cfg, "sort", []) or []
                    sort_fields = [r.field for r in sort_rules]
            cr = crs_by_rd.get(src_rd.id, {}).get(c)
            criteria_summary[c] = CriterionSummary(
                enabled=enabled,
                rows=_row_count(cr.data_json) if cr else 0,
                cached_from_run_id=cr.cached_from_run_id if cr else None,
                ai_cached_from_run_id=(
                    cr.ai_cached_from_run_id if cr else None
                ),
                sort_fields=sort_fields,
                source_run_id=src_run.id,
                source_run_name=src_run.name or "",
                source_job_id=src_job.id,
                source_job_name=src_job.name,
                source_run_domain_id=src_rd.id,
            )
            if cr and cr.cached_from_run_id is not None:
                any_cached = True
            if cr and cr.ai_verdict_json:
                try:
                    v = json.loads(cr.ai_verdict_json)
                    if isinstance(v, dict):
                        per_crit_ai_verdicts[c] = v
                except json.JSONDecodeError:
                    pass

        pinned_criteria_list = sorted(per_crit_sources.keys())

        # Final-assessment synthesis.
        #
        # `partial` fires when a criterion with weight > 0 in the
        # scoring config is missing from the pinned set — i.e., the
        # user hasn't supplied data for something that would actually
        # affect the score. Multi-source-vs-single-source no longer
        # implies partial: stitching Wayback (default weight 0) from
        # Run A and Ahrefs from Run B is a complete picture under
        # default weights, and the score should display normally.
        #
        # Score source priority:
        #   A. Single contributing rd whose own final_assessment_json
        #      is non-partial — use it as-is (matches what the AI
        #      synthesized end-of-run).
        #   B. Otherwise — re-derive via scoring.compute_final() from
        #      the per-criterion AI verdicts, weighted by the user's
        #      scoring config. Same math the AI synth step uses.
        weights = sc.get("weights") or {}
        weighted_crits = {c for c, w in weights.items() if w > 0}
        pinned_set = set(pinned_criteria_list)
        missing_weighted = sorted(weighted_crits - pinned_set)
        underweight = bool(missing_weighted)

        contributing_rd_ids = {src[0].id for src in per_crit_sources.values()}
        single_source_full = (
            len(contributing_rd_ids) == 1
            and primary_rd.final_assessment_json
        )
        parsed: dict | None = None
        if single_source_full:
            try:
                parsed = json.loads(primary_rd.final_assessment_json)
            except json.JSONDecodeError:
                parsed = None
        final_summary_text = (
            (primary_rd.final_summary or "").strip()
            if single_source_full else ""
        )
        underlying_partial = bool(
            isinstance(parsed, dict) and parsed.get("partial")
        )
        if single_source_full and not underlying_partial:
            # Case A — rd's recorded final is authoritative.
            score = _parse_final_score(parsed)
            confidence = _parse_final_confidence(parsed)
            bucket = _bucket_for(
                parsed, final_summary_text,
                good_threshold=good_t, mixed_threshold=mixed_t,
            )
        else:
            # Case B — synthesize from per-criterion AI verdicts.
            #
            # When the primary contributing run has a per-run scoring
            # override (2026-05-13 wave J), use those weights for the
            # synth instead of the global Settings ones. Otherwise
            # Case A (single-source) and Case B (Frankenstein) would
            # silently diverge: applying an override on Run X would
            # reflect on the Database page for domains where X is the
            # sole source, but not for domains where X's B/D/A/K are
            # stitched with wayback from a different run. The primary
            # contributing run (`primary_run`) is the most-recent of
            # the contributing set, which matches the user's mental
            # model of "the run I just tuned".
            synth_weights = weights
            if primary_run.scoring_override_json:
                try:
                    _po = json.loads(primary_run.scoring_override_json)
                    if isinstance(_po, dict):
                        _w = _po.get("weights")
                        if isinstance(_w, dict):
                            # Coerce only — the recompute endpoint
                            # always persists a complete 6-criterion
                            # dict, but be defensive against partials.
                            synth_weights = {
                                str(k): float(v)
                                for k, v in _w.items()
                                if isinstance(v, (int, float))
                                and not isinstance(v, bool)
                            }
                except json.JSONDecodeError:
                    pass
            from ..scoring import compute_final
            synth_score, synth_conf = compute_final(
                per_crit_ai_verdicts,
                weights=synth_weights or None,
            )
            score = synth_score
            confidence = synth_conf
            if score is None:
                bucket = ""
            elif score >= good_t:
                bucket = "good"
            elif score >= mixed_t:
                bucket = "mixed"
            else:
                bucket = "low_quality"
        # `final_failed` mirrors the rd's recorded partial flag (an
        # enabled criterion failed at AI synth time). Distinct from
        # `final_underweight` (weight>0 criterion not pinned). The
        # legacy `final_partial` is the OR of the two, kept so any
        # un-migrated readers stay correct.
        failed = bool(underlying_partial)
        partial = underweight or failed

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

        # Wayback per-criterion verdict — sourced from whichever rd
        # supplies the `wayback` criterion (may differ from primary_rd).
        wayback_assessment = ""
        wayback_confidence: float | None = None
        wayback_samples_count = 0
        wayback_src = per_crit_sources.get("wayback")
        wayback_cr = (
            crs_by_rd.get(wayback_src[0].id, {}).get("wayback")
            if wayback_src else None
        )
        # Backwards-compat alias for the unchanged Wayback parsing block
        # below. crs_for_rd is used by both wayback and wayback_classify
        # extraction in the legacy code path; the new sourcing above has
        # already supplied wayback_cr, but the classify block below
        # re-reads under the old name. We bridge by point-fetching the
        # classify CR similarly.
        crs_for_rd = {}
        if wayback_cr is not None:
            crs_for_rd["wayback"] = wayback_cr
        classify_src = per_crit_sources.get("wayback_classify")
        if classify_src is not None:
            classify_cr_candidate = (
                crs_by_rd.get(classify_src[0].id, {}).get("wayback_classify")
            )
            if classify_cr_candidate is not None:
                crs_for_rd["wayback_classify"] = classify_cr_candidate
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
            pinned_run_domain_id=primary_rd.id,
            pinned_run_id=primary_run.id,
            pinned_job_id=primary_job.id,
            pinned_job_name=primary_job.name,
            pinned_run_name=primary_run.name or "",
            pinned_finished_at=primary_rd.finished_at,
            pinned_started_at=primary_rd.started_at,
            final_summary=final_summary_text,
            final_score=score,
            final_confidence=confidence,
            final_bucket=bucket,
            final_partial=partial,
            final_failed=failed,
            final_underweight=underweight,
            missing_weighted_criteria=missing_weighted,
            pinned_criteria=pinned_criteria_list,
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
            is_banned=domain in banned_set,
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


@router.get("/domains", response_model=DomainListResponse)
async def _list_domains_route(
    offset: int = 0,
    limit: int | None = None,
) -> DomainListResponse:
    """Async wrapper for `list_domains`. The DB walk is the heaviest
    read in the app (per-criterion source resolution, JSON parsing per
    row, multi-source synth) — off-loading it to asyncio.to_thread
    keeps the event loop responsive when 5+ users land on the Database
    page during a busy analyze run. A fresh Session is opened inside
    the executor so it never crosses thread boundaries."""
    return await asyncio.to_thread(_run_list_domains, offset, limit)


def _run_list_domains(
    offset: int, limit: int | None,
) -> DomainListResponse:
    db = SessionLocal()
    try:
        return list_domains(db=db, offset=offset, limit=limit)
    finally:
        db.close()


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
    the Database page. Idempotent — already-pinned rd is a no-op.

    Behavior post-2026-05-12: also expands into per-(job, criterion)
    pins for every criterion this rd has CR data for, so the new
    Database aggregation pipeline picks it up. The Database page UI's
    "pin this rd" dropdown remains functional via this endpoint."""
    from datetime import datetime as _dt
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
    # Per-criterion pins only. Locked 2026-05-14: stopped writing the
    # legacy RunDomain.is_pinned column to match the cleanup of the
    # /run-domains/{id}/pin endpoint in routers/jobs.py.
    run = db.get(Run, rd.run_id)
    if run is not None:
        rd_crits = {
            cr.criterion for cr in rd.results
            if cr.status == "done" or cr.data_json
        }
        if rd_crits:
            existing = (
                db.query(JobCriterionPin)
                .filter(JobCriterionPin.job_id == run.job_id)
                .filter(JobCriterionPin.criterion.in_(rd_crits))
                .all()
            )
            by_crit = {p.criterion: p for p in existing}
            now = _dt.utcnow()
            for c in rd_crits:
                ex = by_crit.get(c)
                if ex is None:
                    db.add(JobCriterionPin(
                        job_id=run.job_id, criterion=c, run_id=run.id,
                    ))
                elif ex.run_id != run.id:
                    ex.run_id = run.id
                    ex.updated_at = now
    db.commit()
    return PinOut(domain=domain, pinned_run_domain_id=rd.id)


@router.delete("/domains/{domain}/pin")
def unpin_domain(domain: str, db: Session = Depends(get_db)) -> dict:
    """Clear every JobCriterionPin where the pinned run contains an rd
    for this domain. Locked 2026-05-14: stopped touching the legacy
    RunDomain.is_pinned column. Idempotent."""
    domain = domain.strip()
    if not domain:
        raise HTTPException(400, "domain required")
    # Find all (job, run) pairs that have an rd for this domain, then
    # delete every pin whose (job_id, run_id) is in that set. Two
    # queries; cheap at any realistic scale.
    pairs = (
        db.query(Run.job_id, Run.id)
        .join(RunDomain, RunDomain.run_id == Run.id)
        .filter(RunDomain.domain == domain)
        .distinct()
        .all()
    )
    if not pairs:
        db.commit()
        return {"unpinned": domain, "count": 0}
    # SQLite doesn't support row-tuple IN clauses cleanly via SQLAlchemy.
    # Build an OR-chain on (job_id, run_id) pairs.
    from sqlalchemy import and_, or_
    conds = [
        and_(JobCriterionPin.job_id == jid, JobCriterionPin.run_id == rid)
        for (jid, rid) in pairs
    ]
    n = (
        db.query(JobCriterionPin)
        .filter(or_(*conds))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"unpinned": domain, "count": int(n)}


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


# --- Bulk ban: Database page → Ban List (added 2026-05-13 wave L) ----------
# `POST /database/domains/bulk-ban` lets the user multi-select Database
# rows and ban them in one call. Domains are normalized via the shared
# `_normalize_domain` helper so the keys match what the ban filter checks
# at every other insertion point. Existing BacklogDomain rows are NOT
# touched — per the (a) design call, banning is a pure pre-filter.

class BulkBanIn(BaseModel):
    domains: list[str]
    note: str = ""


class BulkBanOut(BaseModel):
    added: int
    already_banned: int
    invalid: int


@router.post("/domains/bulk-ban", response_model=BulkBanOut)
def bulk_ban_domains(
    payload: BulkBanIn, db: Session = Depends(get_db),
) -> BulkBanOut:
    """Add the supplied domains to the ban list. Idempotent. Note is
    applied to every newly-added row (existing banned rows keep their
    own note unless empty AND a non-empty new note is supplied — same
    merge rule as the /banlist POST endpoint).

    The user picks domains via Database-page multi-select; we don't
    require them to first toggle anything else (no auto-discard — per
    the (a) design call the ban list is orthogonal to backlog status)."""
    from ..models import DomainBan
    from .backlog import _normalize_domain

    if not payload.domains:
        return BulkBanOut(added=0, already_banned=0, invalid=0)
    seen: set[str] = set()
    normalized: list[str] = []
    invalid = 0
    for d in payload.domains:
        n = _normalize_domain(d or "")
        if not n:
            invalid += 1
            continue
        if n in seen:
            continue
        seen.add(n)
        normalized.append(n)
    if not normalized:
        return BulkBanOut(added=0, already_banned=0, invalid=invalid)
    existing = {
        b.domain: b
        for b in db.query(DomainBan)
        .filter(DomainBan.domain.in_(normalized))
        .all()
    }
    added = 0
    already = 0
    rows_added: list[str] = []
    new_bans_by_domain: dict[str, DomainBan] = {}
    now = datetime.utcnow()
    note = (payload.note or "").strip()
    for d in normalized:
        existing_row = existing.get(d)
        if existing_row is not None:
            if note and not existing_row.note:
                existing_row.note = note
            already += 1
            continue
        ban = DomainBan(domain=d, note=note, created_at=now)
        db.add(ban)
        rows_added.append(d)
        new_bans_by_domain[d] = ban
        added += 1
    # Snapshot + delete the matching Backlog rows (locked 2026-05-14,
    # supersedes wave-O β). See routers/banlist._snapshot_and_delete_backlog
    # for rationale.
    from .banlist import _snapshot_and_delete_backlog
    _snapshot_and_delete_backlog(db, new_bans_by_domain)
    db.commit()
    return BulkBanOut(added=added, already_banned=already, invalid=invalid)


# --- Bulk Russian translation of final-assessment prose (2026-05-13 wave K)
# Translates `summary` and `recommendation` on every rd currently surfaced
# by the Database page (one row per unique domain, sourced via the same
# per-(job, criterion) pin logic the page uses for display). Other prose
# (per-criterion key_findings/red_flags, category_reasoning) is left in
# English. Idempotent — re-running skips already-translated rds.

class TranslateVerdictsOut(BaseModel):
    total: int
    translated: int
    skipped: int
    failed: int
    errors: list[str]


@router.post("/translate-verdicts", response_model=TranslateVerdictsOut)
async def translate_database_verdicts(
    db: Session = Depends(get_db),
) -> TranslateVerdictsOut:
    """Translate the final-assessment prose (summary + recommendation)
    of every rd backing the Database page to Russian. Stores the
    translation in `run_domains.final_assessment_ru_json` alongside the
    original — display code prefers it whenever populated; no UI toggle.
    Rds whose prose is already mostly Russian get their original mirrored
    into the _ru slot so subsequent reads short-circuit consistently."""
    # Re-resolve the set of "current" rd ids using the same pin-driven
    # source logic as `list_domains` so the bulk action targets exactly
    # what the page shows.
    response = list_domains(db=db, offset=0, limit=None)
    rd_ids: list[int] = []
    for row in response.rows:
        if row.pinned_run_domain_id is not None:
            rd_ids.append(row.pinned_run_domain_id)
    if not rd_ids:
        return TranslateVerdictsOut(
            total=0, translated=0, skipped=0, failed=0, errors=[],
        )
    from ..tasks import translate_database_view_verdicts
    result = await translate_database_view_verdicts(rd_ids)
    return TranslateVerdictsOut(**result)


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
    # Ban-list check (added 2026-05-13 wave L): refuse to create a new
    # BacklogDomain for banned domains. Per the (a) design call,
    # banning is a pure pre-filter — existing rows above were updated
    # freely; only the CREATE path consults the ban list.
    from ..ban_filter import is_banned
    if is_banned(db, normalized):
        raise HTTPException(409, f"domain is banned: {normalized}")
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
    # Domains rejected because they're on the ban list (added wave L).
    # Banned domains that ALREADY have a BacklogDomain row are still
    # updated normally per (a) — only the create branch refuses.
    skipped_banned: int = 0
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
    # Ban check (added 2026-05-13 wave L): only blocks the CREATE branch
    # per (a) — existing BacklogDomain rows whose domain is banned can
    # still be updated. Lets the user retroactively pin a status on
    # already-recorded domains without un-banning first.
    from ..ban_filter import filter_banned
    create_candidates = [d for d in normalized if d not in existing]
    _allowed_creates, banned_for_create = filter_banned(db, create_candidates)
    updated = 0
    created = 0
    skipped_banned = 0
    for d in normalized:
        row = existing.get(d)
        if row is not None:
            row.status = payload.status
            row.updated_at = now
            updated += 1
        elif d in banned_for_create:
            skipped_banned += 1
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
        skipped_banned=skipped_banned,
        status=payload.status,
    )
