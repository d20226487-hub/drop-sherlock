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
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..models import (
    CriterionResult,
    DomainNote,
    DomainShare,
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
    # Per-criterion AI verdict (added for confidence-aware Criteria pills
    # on the Database page). Populated from the source CR's
    # `ai_verdict_json` when present. `ai_assessment` is one of
    # "high_quality"/"mixed"/"low_quality" for Ahrefs + Wayback;
    # whois_history reports `dropped_confidence` here under
    # `ai_dropped_confidence` instead (different axis). Both null when
    # the AI hasn't produced a verdict for that criterion yet.
    ai_assessment: str | None = None
    ai_confidence: float | None = None
    ai_dropped_confidence: float | None = None


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
    # Whois-history verdict (added 2026-05-15 Wave 2 follow-up) — surfaced
    # separately like wayback. `dropped_confidence` is the per-domain
    # drop-evidence score from the WhoisFreaks judge (high = caution).
    # `whois_band` is the server-computed bucket — one of "dropped" /
    # "mixed" / "insufficient" / "stable" / "" — derived using the same
    # thresholds as the per-domain Whois view's `dropTone()` (>0.80 →
    # dropped, >0.50 → mixed, ≥0.30 → insufficient, <0.30 → stable).
    # Drives both the column tone and the filter dropdown so the
    # frontend doesn't have to keep the threshold constants in sync.
    whois_dropped_confidence: float | None = None
    whois_transferred_confidence: float | None = None
    whois_summary: str = ""
    whois_band: str = ""
    # Deterministic ownership-cycle counter from the whois diff (added
    # 2026-05-21). 1 = no drop evidence (likely original owner); 2 =
    # domain dropped once; 3+ = passed through multiple hands. Computed
    # in whois_history/diff._estimate_ownership_cycles from the HARD
    # signals only (creation_date changes, else coverage gaps). Null
    # when the domain has no whois CR or the CR has empty data_json.
    # See also the `whois_cycles_min` query param for filtering.
    whois_ownership_cycles: int | None = None
    # Domain-availability verdict (added 2026-05-16) — sourced from the
    # aux availability source's CR `data_json.verdict` so the column
    # agrees with the Job-page chip math. Pre-2026-05-16 the column
    # hydrated from a separate `/availability/latest` cache lookup
    # (cross-cutting, MAX(checked_at) over `availability_checks` with
    # only AVAILABLE/REGISTERED rows), which surfaced stale "registered"
    # data from older jobs even when the latest job concluded
    # "unknown" — producing the chip/Database discrepancy reported on
    # 2026-05-16 (Job 57: 3/832/165 vs Database 10/915). Now both views
    # read the same CR row. Empty string when no availability CR is
    # pinned or in fallback for this domain.
    availability_status: str = ""
    availability_provider: str = ""
    availability_registrar: str = ""
    availability_expires_on: date | None = None
    availability_checked_at: datetime | None = None
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
    # Backlog registrar (2026-05-17) — surfaced as the "Source" column on
    # Database, mirroring the same column on the Backlog page. Comes from
    # `BacklogDomain.registrar` (populated at import time from CSV / auction
    # feeds). Empty when the domain has no backlog row or the import didn't
    # carry a registrar string.
    backlog_registrar: str = ""
    # Backlog Ahrefs DR + domain age (added 2026-05-20). Captured at CSV
    # import time on the Backlog page; surfaced HERE so the Database row
    # can render them as small sub-line chips under the domain name. Both
    # null when the domain has no backlog row OR the imported CSV didn't
    # carry a value for that field. Kept on the row payload (not behind a
    # lazy lookup) because they're already on the joined BacklogDomain
    # row that hydrates `backlog_registrar` — zero extra cost.
    backlog_ahrefs_dr: float | None = None
    backlog_domain_age_years: float | None = None
    # Backlog expiration date (added 2026-05-20, Apruv export). Surfaced
    # from the same joined BacklogDomain row so the Apruv-export CSV
    # column-picker can offer it without a second lookup. Null when no
    # backlog row OR the import / availability cascade hasn't populated
    # it yet.
    backlog_expiration_date: date | None = None
    # Procurement price bracket from the BacklogDomain row (added
    # 2026-05-20, Apruv export). `desired_price` is the ideal (low-end)
    # bid; `max_price` is the absolute ceiling above which the operator
    # walks away. Null when the import didn't carry a value. Same join
    # as the other backlog_* fields — zero extra cost.
    backlog_desired_price: float | None = None
    backlog_max_price: float | None = None
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
    # whois_history added 2026-05-15: lets the Database page surface
    # whois-only domains (Quality-pillar pins not required) and the new
    # Whois column. compute_final ignores it (no weight in the scoring
    # config), and `CRITERIA_LETTERS` on the frontend doesn't render a
    # pill for it, so the only visible effect is the dedicated whois
    # column + the `pinned_criteria` list including "whois_history".
    "whois_history",
    # availability added 2026-05-15 Wave 3: same shape — lets
    # availability-only domains appear on Database, and lets the
    # existing Availability cell + filter source from the pinned
    # availability CR row when one exists. compute_final ignores it
    # (no weight in scoring config).
    "availability",
)

# Independent-pillar criteria — surfacing only, never part of Quality
# scoring math. Kept out of `per_crit_sources` (a.k.a. sources_by_domain
# values) so they can't influence `primary_run`, `contributing_rd_ids`,
# or the `synth_weights` selection inside compute_final. Tracked in a
# parallel `aux_sources_by_domain` dict instead — the row still gets
# its whois/availability column populated, but the Quality math stays
# Quality-only.
#
# Concrete bug this prevents: a more-recent whois_history rd (e.g.,
# from a whois-only job that ran after the Quality job) was becoming
# `primary_run`, which dropped the Quality run's `scoring_override_json`
# off the synth, silently re-scoring rows under global weights. See
# 2026-05-16 fix for `45minut.kz` / `most.com.kz`.
AUX_CRITERIA = ("whois_history", "availability")


def _whois_band(dropped: float | None) -> str:
    """Bucket `dropped_confidence` into the same 4 bands the per-domain
    Whois view uses (see `dropTone()` in whois-history-domain-view.tsx).
    Empty string when no confidence is available."""
    if dropped is None:
        return ""
    if dropped > 0.80:
        return "dropped"
    if dropped > 0.50:
        return "mixed"
    if dropped >= 0.30:
        return "insufficient"
    return "stable"


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

    The `offset` and `limit` parameters slice the returned `rows` list
    in Python AFTER the global sort + filter-options computation. The
    full per-domain aggregation always runs across every RunDomain in
    the DB — this is heavy at large N (the load-everything design that
    pre-dates 2026-05-16) and is the known scale ceiling for the
    Database page."""
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
    #
    # The pin walk's output is split into two dicts:
    #   sources_by_domain        — Quality-scoring criteria
    #                              (backlinks/refdomains/anchors/keywords/
    #                              wayback/wayback_classify). These drive
    #                              the synth math: primary_run for weight
    #                              selection, contributing_rd_ids for
    #                              single-source detection, pinned_set for
    #                              underweight calc.
    #   aux_sources_by_domain    — Independent pillars (whois_history,
    #                              availability) that should SURFACE on the
    #                              row (whois column, criteria.X.enabled)
    #                              but must NOT influence Quality-scoring
    #                              math. Keeping them out prevents a more-
    #                              recent whois/availability rd from
    #                              hijacking `primary_run` and silently
    #                              switching `synth_weights` away from the
    #                              Quality run's scoring override.
    sources_by_domain: dict[str, dict[str, tuple[RunDomain, Run, Job]]] = {}
    aux_sources_by_domain: dict[str, dict[str, tuple[RunDomain, Run, Job]]] = {}
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
            aux_sources_by_domain[domain] = {}
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
        # Split aux out so Quality math doesn't see them.
        aux: dict[str, tuple[RunDomain, Run, Job]] = {}
        for c in AUX_CRITERIA:
            if c in per_crit:
                aux[c] = per_crit.pop(c)
        sources_by_domain[domain] = per_crit
        aux_sources_by_domain[domain] = aux

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

    # Whois-history: PIN-ONLY (2026-05-17). The fallback that surfaced
    # the most-recent whois CR per domain was removed at user request —
    # they want symmetric behavior with availability after the cross-job
    # surprises. The whois column on Database is now blank for any
    # domain that has no `JobCriterionPin(criterion='whois_history')`.
    # Workflow change: every whois run needs an explicit pin (via the
    # per-domain pin selector or the Job page's "Pin run" action) before
    # its data appears on Database. The trade-off — single-shot whois
    # jobs no longer auto-surface — is what the user wants in exchange
    # for guaranteed pin-driven provenance.
    # Availability fallback (Wave 3, 2026-05-15): when no pin
    # contributes an availability source, fall back to the most-recent
    # rd with a populated availability CR. Availability runs have no
    # AI verdict so we key off `data_json != ""` (a `done` cascade
    # always writes the trace + verdict there). Kept as fallback (vs.
    # whois which became pin-only) because availability is the cheap
    # pre-filter step every operator runs; requiring a pin click on
    # every availability job would be friction without a payoff —
    # availability never had the cross-job surprise problem whois did
    # (Availability has its own pillar runner; no Quality cascade
    # contamination since the 2026-05-16 aux_sources refactor).
    availability_crs_by_rd_id: dict[int, CriterionResult] = {
        cr.run_domain_id: cr
        for cr in db.query(CriterionResult)
        .filter(CriterionResult.criterion == "availability")
        .filter(CriterionResult.data_json != "")
        .all()
    }

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

    # Fallback source for the Availability column (added 2026-05-18).
    # Primary source is still the availability CR (so the column
    # matches the Job-page chip math row-for-row, per the 2026-05-16
    # rewire). But when NO availability Job has been run for a domain
    # — only a per-row Recheck or bulk Recheck — there's no CR, and
    # the column stayed empty even though `AvailabilityCheck` history
    # and `BacklogDomain.expiration_date` were updated. User report
    # 2026-05-18: rechecked boilerplus.com.ua on Backlog, expiry showed
    # there but Database Availability stayed blank. Fix: when the CR-
    # based extraction yields no status, fall back to the latest
    # AvailabilityCheck row for that domain (mirroring what the Backlog
    # page does via /availability/latest).
    #
    # Two queries instead of one: prefer the latest TERMINAL (available
    # / registered) row per domain — that's the "stable answer" the
    # cascade itself preserves across rate-limit retries — and only
    # fall through to the latest-of-any-status row for domains that
    # have never had a terminal answer. Same definitive-preferred
    # semantic as /availability/latest + the Backlog filter.
    from ..models import AvailabilityCheck
    from sqlalchemy import and_, func as sqla_func
    latest_av_by_domain: dict[str, AvailabilityCheck] = {}
    if domain_keys:
        term_sub = (
            db.query(
                AvailabilityCheck.domain.label("d"),
                sqla_func.max(AvailabilityCheck.checked_at).label("max_t"),
            )
            .filter(AvailabilityCheck.domain.in_(domain_keys))
            .filter(AvailabilityCheck.status.in_(("available", "registered")))
            .group_by(AvailabilityCheck.domain)
            .subquery()
        )
        for r in (
            db.query(AvailabilityCheck)
            .join(term_sub, and_(
                AvailabilityCheck.domain == term_sub.c.d,
                AvailabilityCheck.checked_at == term_sub.c.max_t,
            ))
            .all()
        ):
            latest_av_by_domain[r.domain] = r
        # Fill in domains with no terminal answer using their latest
        # overall row — gives the user 'unknown'/'error' visibility
        # so the column reflects "we tried, here's what came back"
        # rather than the misleading "blank = never checked" state.
        missing = [d for d in domain_keys if d not in latest_av_by_domain]
        if missing:
            any_sub = (
                db.query(
                    AvailabilityCheck.domain.label("d"),
                    sqla_func.max(AvailabilityCheck.checked_at).label("max_t"),
                )
                .filter(AvailabilityCheck.domain.in_(missing))
                .group_by(AvailabilityCheck.domain)
                .subquery()
            )
            for r in (
                db.query(AvailabilityCheck)
                .join(any_sub, and_(
                    AvailabilityCheck.domain == any_sub.c.d,
                    AvailabilityCheck.checked_at == any_sub.c.max_t,
                ))
                .all()
            ):
                latest_av_by_domain[r.domain] = r

    # Banned-domain lookup. Originally (Wave L, 2026-05-13) drove a
    # per-row "banned" badge but rows stayed visible. Revised
    # 2026-05-15: banned rows are now HIDDEN from the Database listing
    # entirely — operators view banned-domain analysis history via the
    # Ban List page's per-row links instead. The underlying rds + CRs
    # are NOT deleted (so unbanning restores the row to Database
    # automatically). `is_banned` field on the response is retained for
    # back-compat but will always be false on returned rows.
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
    # Whois-band universe for the new Whois filter dropdown (added
    # 2026-05-15). Always a subset of {dropped, mixed, insufficient,
    # stable} — the four bands `_whois_band` produces.
    whois_bands_seen: set[str] = set()
    # Availability-status universe for the Availability filter dropdown
    # (added 2026-05-16, alongside the column rewire from
    # `/availability/latest` cache to CR-scoped data). Subset of
    # {available, registered, unknown, error} — the verdict.status values
    # the availability runner writes into the CR data_json.
    availability_statuses_seen: set[str] = set()
    # Source universe (2026-05-17) for the Database "Source" filter
    # dropdown. Same data the Backlog page filter populates from —
    # BacklogDomain.registrar — scoped to domains that actually show up
    # on Database (i.e. have at least one RD). Sorted alphabetically.
    sources_seen: set[str] = set()

    for domain, domain_rds in rds_by_domain.items():
        # Banned domains are hidden from the Database listing entirely
        # (revised 2026-05-15). The underlying rds + CRs stay in the DB
        # so unbanning brings the row back; operators audit banned-
        # domain analysis history via the Ban List page's links.
        if domain in banned_set:
            continue
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
        aux_sources = aux_sources_by_domain.get(domain, {})
        note_row = notes_by_domain.get(domain)
        backlog_row = backlog_by_domain.get(domain)

        # Whois-history is PIN-ONLY (2026-05-17). `aux_sources` already
        # contains a "whois_history" entry IFF a JobCriterionPin exists
        # for this domain's job (handled by the pin-walk's AUX_CRITERIA
        # split above); the column stays blank otherwise. No fallback
        # block — see the comment near the (now-removed)
        # `whois_crs_by_rd_id` preload for the rationale.

        # Availability fallback: when
        # no pin contributes an availability source, fall back to the
        # most-recent rd that has an availability CR. Lets per-row
        # click-through reach the cascade trace page even before an
        # operator manually pins the run.
        if "availability" not in aux_sources:
            for d in domain_rds_sorted:
                if d.id not in availability_crs_by_rd_id:
                    continue
                d_run = runs.get(d.run_id)
                if d_run is None:
                    continue
                d_job = jobs.get(d_run.job_id)
                if d_job is None:
                    continue
                aux_sources["availability"] = (d, d_run, d_job)
                crs_by_rd[d.id]["availability"] = (
                    availability_crs_by_rd_id[d.id]
                )
                break

        if not per_crit_sources and not aux_sources:
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
                backlog_registrar=(backlog_row.registrar or "") if backlog_row else "",
                backlog_ahrefs_dr=backlog_row.ahrefs_dr if backlog_row else None,
                backlog_domain_age_years=(
                    backlog_row.domain_age_years if backlog_row else None
                ),
                backlog_expiration_date=(
                    backlog_row.expiration_date if backlog_row else None
                ),
                backlog_desired_price=(
                    backlog_row.desired_price if backlog_row else None
                ),
                backlog_max_price=(
                    backlog_row.max_price if backlog_row else None
                ),
            ))
            if backlog_row and backlog_row.registrar:
                sources_seen.add(backlog_row.registrar)
            continue

        # Pick a "primary" source for the row-level pinned_* identity
        # fields (click-through, finished_at sort, ai provenance fallback)
        # — the most-recent contributing Quality run wins. With per-
        # criterion pinning the row no longer has a single canonical rd,
        # but the frontend still wants ONE link target for the row chrome.
        #
        # CRITICAL: prefer per_crit_sources (Quality criteria) over
        # aux_sources. The most-recent rd from an aux pillar (whois /
        # availability) must NEVER be promoted to primary_run on a row
        # that has Quality data, because primary_run.scoring_override_json
        # drives synth_weights in Case B below. A whois rd with no
        # override would silently switch the synth to global weights and
        # change the displayed score for already-scored Quality rows.
        # Only fall back to aux when there is no Quality source at all
        # (whois-only or availability-only domain) — in that case the
        # Quality synth has no inputs and bucket stays "" anyway.
        primary_source_pool = per_crit_sources if per_crit_sources else aux_sources
        primary_rd, primary_run, primary_job = max(
            primary_source_pool.values(),
            key=lambda triple: triple[1].finished_at or datetime.min,
        )

        # Pre-load spec for every contributing run so we know which
        # criteria each run had ENABLED — drives the per-criterion
        # "enabled" flag on the response. Includes aux runs so the
        # whois_history / availability columns also get their `enabled`
        # flag populated correctly.
        contributing_run_ids = {r.id for (_, r, _) in per_crit_sources.values()}
        contributing_run_ids |= {r.id for (_, r, _) in aux_sources.values()}
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
        # below. Sourced ONLY from per_crit_sources so aux pillars cannot
        # leak into compute_final (defensive — neither whois nor
        # availability has an `assessment` field that compute_final
        # understands today, but a future format change shouldn't be able
        # to silently start contributing to the Quality score).
        per_crit_ai_verdicts: dict[str, dict] = {}
        for c in CRITERIA:
            # Per-criterion source: Quality criteria come from
            # per_crit_sources; aux pillars come from aux_sources. A
            # pinned aux criterion (rare) lives in aux_sources after the
            # pin-walk split above.
            src = per_crit_sources.get(c) or aux_sources.get(c)
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
            # Extract per-criterion AI verdict so the Database page's
            # Criteria pills can render confidence-aware coloring that
            # mirrors the per-domain page (grey-on-low-confidence + bucket
            # tone from assessment). Ahrefs/Wayback expose
            # {assessment, confidence}; whois_history exposes
            # {dropped_confidence} on a different axis (handled separately).
            ai_assessment_v: str | None = None
            ai_confidence_v: float | None = None
            ai_dropped_v: float | None = None
            if cr is not None and cr.ai_verdict_json:
                try:
                    _parsed = json.loads(cr.ai_verdict_json)
                except json.JSONDecodeError:
                    _parsed = None
                if isinstance(_parsed, dict):
                    _a = _parsed.get("assessment")
                    if isinstance(_a, str) and _a:
                        ai_assessment_v = _a
                    _cf = _parsed.get("confidence")
                    if (
                        isinstance(_cf, (int, float))
                        and not isinstance(_cf, bool)
                        and 0.0 <= float(_cf) <= 1.0
                    ):
                        ai_confidence_v = float(_cf)
                    _dc = _parsed.get("dropped_confidence")
                    if (
                        isinstance(_dc, (int, float))
                        and not isinstance(_dc, bool)
                        and 0.0 <= float(_dc) <= 1.0
                    ):
                        ai_dropped_v = float(_dc)
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
                ai_assessment=ai_assessment_v,
                ai_confidence=ai_confidence_v,
                ai_dropped_confidence=ai_dropped_v,
            )
            if cr and cr.cached_from_run_id is not None:
                any_cached = True
            if cr and cr.ai_verdict_json and c not in AUX_CRITERIA:
                try:
                    v = json.loads(cr.ai_verdict_json)
                    if isinstance(v, dict):
                        per_crit_ai_verdicts[c] = v
                except json.JSONDecodeError:
                    pass

        # `pinned_criteria` reports the Quality criteria that contribute
        # to the row's score. Aux pillars (whois / availability) are
        # surfaced via their own columns and the criteria_summary entries
        # above, but they don't count as "pinned" for the underweight /
        # subset-badge math that consumers use this list for.
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
        # `underweight` needs at least one weighted criterion to actually
        # be pinned. Otherwise the row simply has "no Ahrefs verdict"
        # (e.g. whois-only or wayback-only domains) and the "subset"
        # badge would be misleading — there's no subset, there's no
        # quality data at all. Same `final_bucket=""` state as a never-
        # analyzed row.
        has_any_weighted_pin = bool(weighted_crits & pinned_set)
        underweight = bool(missing_weighted) and has_any_weighted_pin

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

        # Whois-history verdict (added 2026-05-15) — sourced from
        # whichever rd supplies the `whois_history` criterion. Shape:
        # {dropped_confidence, transferred_confidence, summary,
        #  key_signals[], recommendation}. Lives in `aux_sources` (it's
        # an independent pillar that surfaces a column without joining
        # the Quality synth math).
        whois_dropped_confidence: float | None = None
        whois_transferred_confidence: float | None = None
        whois_summary = ""
        whois_band = ""
        whois_ownership_cycles: int | None = None
        whois_src = aux_sources.get("whois_history")
        whois_cr = (
            crs_by_rd.get(whois_src[0].id, {}).get("whois_history")
            if whois_src else None
        )
        if whois_cr is not None and whois_cr.ai_verdict_json:
            try:
                wh_parsed = json.loads(whois_cr.ai_verdict_json)
            except json.JSONDecodeError:
                wh_parsed = None
            if isinstance(wh_parsed, dict):
                dc = wh_parsed.get("dropped_confidence")
                if isinstance(dc, (int, float)) and not isinstance(dc, bool):
                    if 0.0 <= float(dc) <= 1.0:
                        whois_dropped_confidence = float(dc)
                tc = wh_parsed.get("transferred_confidence")
                if isinstance(tc, (int, float)) and not isinstance(tc, bool):
                    if 0.0 <= float(tc) <= 1.0:
                        whois_transferred_confidence = float(tc)
                s = wh_parsed.get("summary")
                if isinstance(s, str):
                    whois_summary = s
        # Pull `ownership_cycles` from the deterministic diff payload
        # (data_json.diff.ownership_cycles, set by whois_history/diff.py).
        # Legacy CRs from before 2026-05-21 don't have the explicit
        # field — fall back to recomputing on the fly from the same
        # underlying signals already in the diff so old whois runs
        # surface a count immediately without needing a re-analyze.
        if whois_cr is not None and whois_cr.data_json:
            try:
                wh_data = json.loads(whois_cr.data_json)
            except json.JSONDecodeError:
                wh_data = None
            diff = ((wh_data or {}).get("diff") or {}) if isinstance(
                wh_data, dict
            ) else {}
            cycles = diff.get("ownership_cycles") if isinstance(
                diff, dict
            ) else None
            # Always recompute on read via `compute_cycles_from_diff_dict`
            # rather than trusting `diff.ownership_cycles`. The helper
            # applies newer corrective signals (notably the post-dating
            # check landed 2026-05-23 that catches drops missed by the
            # original creation_date-changes-only formula) so existing
            # CRs surface a correct count without a paid re-fetch.
            # max() preserves any stored value that's larger than the
            # recomputed one — defensive against future formula tweaks
            # that might be more conservative than what produced the
            # stored data.
            from ..whois_history.diff import compute_cycles_from_diff_dict
            recomputed = compute_cycles_from_diff_dict(diff) if isinstance(
                diff, dict
            ) else None
            if recomputed is not None and isinstance(cycles, int) and 1 <= cycles <= 10:
                whois_ownership_cycles = max(cycles, recomputed)
            elif recomputed is not None:
                whois_ownership_cycles = recomputed
            elif isinstance(cycles, int) and 1 <= cycles <= 10:
                whois_ownership_cycles = cycles
        whois_band = _whois_band(whois_dropped_confidence)
        if whois_band:
            whois_bands_seen.add(whois_band)

        # Domain-availability verdict (added 2026-05-16) — sourced from
        # the aux availability CR's `data_json.verdict`. SAME source the
        # Job-page chip SQL reads (`json_extract(cr.data_json,
        # '$.verdict.status')` in `_bucket_counts_for_run`), so the
        # Database column now matches the chip counts row-for-row.
        # `availability_checked_at` reports the cascade-completion
        # timestamp from the aux rd (the runner sets `rd.finished_at`
        # immediately after writing `data_json` — see
        # `availability_runner.process_one`).
        availability_status = ""
        availability_provider = ""
        availability_registrar = ""
        availability_expires_on: date | None = None
        availability_checked_at: datetime | None = None
        av_src = aux_sources.get("availability")
        av_cr = (
            crs_by_rd.get(av_src[0].id, {}).get("availability")
            if av_src else None
        )
        if av_cr is not None and av_cr.data_json:
            try:
                av_parsed = json.loads(av_cr.data_json)
            except json.JSONDecodeError:
                av_parsed = None
            if isinstance(av_parsed, dict):
                verdict = av_parsed.get("verdict")
                if isinstance(verdict, dict):
                    vs = verdict.get("status")
                    if isinstance(vs, str) and vs:
                        availability_status = vs
                        availability_statuses_seen.add(vs)
                    vp = verdict.get("provider")
                    if isinstance(vp, str):
                        availability_provider = vp
                    vr = verdict.get("registrar")
                    if isinstance(vr, str):
                        availability_registrar = vr
                    ve = verdict.get("expires_on")
                    if isinstance(ve, str) and ve:
                        try:
                            availability_expires_on = date.fromisoformat(ve)
                        except ValueError:
                            pass
        if av_src is not None:
            availability_checked_at = av_src[0].finished_at

        # Fallback to latest AvailabilityCheck history row when no
        # CR-based verdict was extracted (added 2026-05-18). Closes
        # the gap where per-row Recheck / bulk Recheck on Backlog
        # updated `AvailabilityCheck` + `BacklogDomain.expiration_date`
        # but the Database Availability column stayed blank because no
        # Availability Job had ever run for this domain. Same
        # definitive-preferred semantic as the Backlog page's
        # /availability/latest hydration: terminal answer wins; we
        # fall through to overall-latest only when no terminal exists.
        if not availability_status:
            fallback = latest_av_by_domain.get(domain)
            if fallback is not None:
                availability_status = fallback.status
                availability_provider = fallback.provider or ""
                availability_registrar = fallback.registrar or ""
                availability_expires_on = fallback.expires_on
                availability_checked_at = fallback.checked_at
                availability_statuses_seen.add(fallback.status)

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
            whois_dropped_confidence=whois_dropped_confidence,
            whois_transferred_confidence=whois_transferred_confidence,
            whois_summary=whois_summary,
            whois_band=whois_band,
            whois_ownership_cycles=whois_ownership_cycles,
            availability_status=availability_status,
            availability_provider=availability_provider,
            availability_registrar=availability_registrar,
            availability_expires_on=availability_expires_on,
            availability_checked_at=availability_checked_at,
            total_runs=len(domain_rds),
            any_cached=any_cached,
            note=(note_row.note if note_row else ""),
            note_updated_at=(note_row.updated_at if note_row else None),
            pin_options_count=len(pin_options),
            is_banned=domain in banned_set,
            backlog_id=backlog_row.id if backlog_row else None,
            backlog_status=backlog_row.status if backlog_row else None,
            backlog_registrar=(backlog_row.registrar or "") if backlog_row else "",
            backlog_ahrefs_dr=backlog_row.ahrefs_dr if backlog_row else None,
            backlog_domain_age_years=(
                backlog_row.domain_age_years if backlog_row else None
            ),
            backlog_expiration_date=(
                backlog_row.expiration_date if backlog_row else None
            ),
            backlog_desired_price=(
                backlog_row.desired_price if backlog_row else None
            ),
            backlog_max_price=(
                backlog_row.max_price if backlog_row else None
            ),
        ))
        if backlog_row and backlog_row.registrar:
            sources_seen.add(backlog_row.registrar)

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
            "whois_bands": sorted(whois_bands_seen),
            # Subset of {available, registered, unknown, error}. Frontend
            # disables the Availability filter when empty (no availability
            # CR exists yet for any pinned/fallback rd).
            "availability_statuses": sorted(availability_statuses_seen),
            # Source filter dropdown (2026-05-17, broadened
            # 2026-05-17): union of (a) registrars surfaced on
            # currently-analyzed rows and (b) every distinct
            # BacklogDomain.registrar value in the table. (b) was added
            # so the operator can see a source they imported but
            # haven't analyzed yet — picking such a value will return 0
            # rows on Database, but its presence in the dropdown is the
            # honest "yes, you imported 346 from that source; none are
            # in Database yet" signal. Mirrors the Backlog page's
            # Source dropdown vocabulary (locked: chip/filter
            # vocabulary lines up 1:1 across pages).
            "sources": sorted(
                sources_seen
                | {
                    r[0]
                    for r in db.query(BacklogDomain.registrar)
                    .filter(BacklogDomain.registrar != "")
                    .distinct()
                    .all()
                }
            ),
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


# --- Apruv export: batch share-link resolution ----------------------------
#
# The Database page's "Apruv" bulk-action ships approver-ready CSV exports.
# Each selected domain needs a deep-link to its per-domain analysis page —
# this endpoint takes the domain list and returns one share token per domain.
#
# Resolution policy (locked 2026-05-20):
#   1. Pinned RunDomain wins (it's the canonical "this is the run I stand
#      behind" choice on the Database row). If multiple criteria are
#      pinned to different rds, we use the most-recent rd among them.
#   2. Fallback: the most-recent analyzed RunDomain for the domain
#      (finished_at desc), regardless of which Job. Matches the same
#      "latest wins" pattern other Database surfaces use.
#   3. No RunDomain at all (pure backlog-only domain): item is returned
#      with token=null and an error_message, so the FE can render the
#      Share-URL column as empty without failing the whole export.
#
# Reuse policy: prefer an existing active (non-revoked, non-expired)
# DomainShare for the resolved RunDomain. Only mints a fresh token when
# no active share exists. Keeps the /shares management page from
# bloating when an operator re-exports the same domains weekly.

class ApruvShareLinkItemIn(BaseModel):
    domain: str


class ApruvShareLinksIn(BaseModel):
    """Batch request: one item per selected domain, plus a default
    expiry for any freshly-minted share tokens."""
    items: list[ApruvShareLinkItemIn] = Field(default_factory=list)
    # Default 30 days per the locked decision. 0 = never expires; the
    # FE will surface this trade-off in the dialog copy.
    expires_in_days: int = 30


class ApruvShareLinkItemOut(BaseModel):
    domain: str
    # null when no run-domain was resolvable (pure backlog row). The FE
    # renders this row's Share URL cell as empty + a "no analysis yet"
    # note in the export summary.
    run_domain_id: int | None = None
    token: str | None = None
    share_url: str | None = None  # absolute path the FE composes against origin
    expires_at: datetime | None = None
    reused: bool = False
    error: str = ""


class ApruvShareLinksOut(BaseModel):
    items: list[ApruvShareLinkItemOut]


def _resolve_share_target_rd(db: Session, domain: str) -> RunDomain | None:
    """Pick the RunDomain to share for `domain` per the locked policy:
    pinned wins, else most-recent analyzed RunDomain (finished_at desc).
    Returns None when no analyzed rd exists at all.

    `JobCriterionPin` is keyed at the (job, criterion, run) level — NOT
    (job, criterion, run-domain). So "pinned" means: there's a run-domain
    for this `domain` whose `run_id` is referenced by ANY JobCriterionPin
    row. We join through Run to find such a match, then fall back to the
    plain most-recent rd when no pin overlaps.
    """
    # 1. Pinned: a JobCriterionPin references this rd's run.
    pinned = (
        db.query(RunDomain)
        .join(JobCriterionPin, JobCriterionPin.run_id == RunDomain.run_id)
        .filter(RunDomain.domain == domain)
        .order_by(RunDomain.finished_at.desc().nullslast(), RunDomain.id.desc())
        .first()
    )
    if pinned is not None:
        return pinned
    # 2. Fallback: most-recent finished rd for this domain.
    return (
        db.query(RunDomain)
        .filter(RunDomain.domain == domain)
        .order_by(RunDomain.finished_at.desc().nullslast(), RunDomain.id.desc())
        .first()
    )


def _find_active_share(db: Session, run_domain_id: int) -> DomainShare | None:
    """Most-recent non-revoked, non-expired share for this rd. The FE
    reuses this URL when present so re-exports don't multiply tokens."""
    now = datetime.utcnow()
    return (
        db.query(DomainShare)
        .filter(DomainShare.run_domain_id == run_domain_id)
        .filter(DomainShare.revoked_at.is_(None))
        .filter(
            (DomainShare.expires_at.is_(None)) | (DomainShare.expires_at > now)
        )
        .order_by(DomainShare.created_at.desc())
        .first()
    )


@router.post("/approve-share-links", response_model=ApruvShareLinksOut)
def approve_share_links(
    payload: ApruvShareLinksIn,
    db: Session = Depends(get_db),
) -> ApruvShareLinksOut:
    """Resolve one share token per selected Database-page domain for
    the Apruv export. See the policy comment block above for the full
    contract."""
    import secrets
    from datetime import timedelta

    # Caller-controlled expiry. 0 = never expires (matches the existing
    # /shares endpoint contract). Clamp to a sane upper bound so a typo
    # can't create a 100-year share by accident.
    if payload.expires_in_days < 0 or payload.expires_in_days > 3650:
        raise HTTPException(
            400,
            f"expires_in_days must be in [0, 3650]; got {payload.expires_in_days}",
        )

    out: list[ApruvShareLinkItemOut] = []
    for item in payload.items:
        domain = (item.domain or "").strip().lower()
        if not domain:
            out.append(ApruvShareLinkItemOut(
                domain=item.domain or "",
                error="empty domain",
            ))
            continue
        rd = _resolve_share_target_rd(db, domain)
        if rd is None:
            out.append(ApruvShareLinkItemOut(
                domain=domain,
                error="no analyzed RunDomain for this domain — pure backlog row",
            ))
            continue
        # Reuse policy first.
        share = _find_active_share(db, rd.id)
        reused = share is not None
        if share is None:
            # Mint a new token with the requested expiry.
            expires_at: datetime | None = None
            if payload.expires_in_days > 0:
                expires_at = datetime.utcnow() + timedelta(
                    days=payload.expires_in_days,
                )
            # 32 bytes urlsafe == 256 bits — same shape as the existing
            # /shares endpoint; collision retry loop for paranoia.
            for _ in range(5):
                token = secrets.token_urlsafe(32)
                if db.get(DomainShare, token) is None:
                    break
            else:
                out.append(ApruvShareLinkItemOut(
                    domain=domain,
                    error="could not allocate a unique share token",
                ))
                continue
            share = DomainShare(
                token=token,
                run_domain_id=rd.id,
                note="apruv-export",
                expires_at=expires_at,
                created_ip="",  # not surfaced; batch endpoint, no per-row source
            )
            db.add(share)
            db.flush()  # so share.created_at is set for the response
        out.append(ApruvShareLinkItemOut(
            domain=domain,
            run_domain_id=rd.id,
            token=share.token,
            share_url=f"/share/{share.token}",
            expires_at=share.expires_at,
            reused=reused,
        ))
    db.commit()
    return ApruvShareLinksOut(items=out)


# --- One-click quick-share for the Database page (added 2026-05-24) -------
# UX: per-row link icon on /database. Single round-trip:
#   1. Resolve the canonical RunDomain for `domain` (pinned wins, else
#      most-recent finished) via `_resolve_share_target_rd`.
#   2. Reuse the most-recent active share for that rd if one exists
#      (`_find_active_share`) — so re-clicking the icon doesn't multiply
#      tokens for the same domain.
#   3. Otherwise mint a new token with the operator's configured default
#      expiry (`app_settings.get_share_defaults()`). The default ships as
#      `default_expires_in_days=0` (never expires) — operator changes it
#      on the /shares page.
#
# Returns the share URL path (`/share/<token>`); FE composes against
# window.location.origin and copies to clipboard.

class QuickShareIn(BaseModel):
    domain: str


class QuickShareOut(BaseModel):
    domain: str
    # NULL when no analyzed RunDomain exists for this domain — pure
    # backlog rows or domains that were deleted from runs. FE renders a
    # toast explaining there's nothing to share yet.
    run_domain_id: int | None = None
    token: str | None = None
    share_url: str | None = None
    expires_at: datetime | None = None
    # True when an existing active share was reused instead of minting
    # a fresh token. FE can adjust the toast wording ("Copied existing
    # link" vs "Created and copied new link").
    reused: bool = False
    error: str = ""


@router.post("/quick-share", response_model=QuickShareOut)
def quick_share(
    payload: QuickShareIn,
    db: Session = Depends(get_db),
) -> QuickShareOut:
    """One-click share for a Database-page row. Uses the configured
    `share_defaults.default_expires_in_days` for new tokens.

    Returns a structured error in the response body (HTTP 200) rather
    than throwing for the no-analyzed-rd case — the FE wants to render
    a polite toast, not an exception splash."""
    import secrets
    from datetime import timedelta
    from .. import app_settings
    from ..models import DomainShare

    domain = (payload.domain or "").strip().lower()
    if not domain:
        return QuickShareOut(domain=payload.domain or "", error="empty domain")

    rd = _resolve_share_target_rd(db, domain)
    if rd is None:
        return QuickShareOut(
            domain=domain,
            error="no analyzed RunDomain for this domain yet",
        )

    # Reuse first — operator hits the icon repeatedly when sending links
    # to multiple recipients; minting a fresh token each time would
    # multiply rows on /shares for no operator benefit.
    share = _find_active_share(db, rd.id)
    reused = share is not None
    if share is None:
        cfg = app_settings.get_share_defaults()
        days = int(cfg.get("default_expires_in_days") or 0)
        expires_at: datetime | None = None
        if days > 0:
            expires_at = datetime.utcnow() + timedelta(days=days)
        for _ in range(5):
            token = secrets.token_urlsafe(24)
            if db.get(DomainShare, token) is None:
                break
        else:
            return QuickShareOut(
                domain=domain,
                run_domain_id=rd.id,
                error="could not allocate a unique share token",
            )
        share = DomainShare(
            token=token,
            run_domain_id=rd.id,
            note="quick-share (Database)",
            expires_at=expires_at,
            created_ip="",
        )
        db.add(share)
        db.commit()
        db.refresh(share)

    return QuickShareOut(
        domain=domain,
        run_domain_id=rd.id,
        token=share.token,
        share_url=f"/share/{share.token}",
        expires_at=share.expires_at,
        reused=reused,
    )
