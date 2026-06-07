"""DB schema. Job-tree (Job → Run → RunDomain → CriterionResult) supports
the rerun-as-new-run semantics user picked: every rerun creates a new Run row
attached to the same Job, so history is preserved.

CriterionResult.data_json holds the raw Ahrefs response — large but fine for
SQLite at single-user scale; we don't index into it from SQL, only reread it
when AI step 7 runs the verdicts."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class DomainNote(Base):
    """User-authored note attached to a domain string. Domain-keyed (NOT
    RunDomain-keyed), so a single note survives across reruns and shows up
    on the Database page next to the latest verdict — the workflow goal is
    "my judgment about THIS domain persists even when AI re-runs change."

    Empty `note` is allowed but typically callers DELETE the row instead so
    the Database page can filter "with notes" / "without notes" cleanly."""
    __tablename__ = "domain_notes"

    domain: Mapped[str] = mapped_column(String(512), primary_key=True)
    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# --- Backlog ----------------------------------------------------------------

# Pre-analysis triage queue. Domain lists pulled from registrars/auctions
# land here, get filtered/triaged manually, and a subset gets sent to
# Analyze. Domain is the natural unique key — uploads silently dedupe
# against the existing backlog. Status is a free-string column but the
# router enforces the allowed values (kept in BACKLOG_STATUSES).
#
# Status semantics (added 'bought' 2026-05-10, 'order' 2026-05-10):
#   backlog       — discovered, not yet triaged
#   in_progress   — being analyzed (auto-set when sent to Analyze)
#   analyzed      — analysis done, decision pending
#   order         — queued for purchase (we want to buy this; order not
#                   yet placed). Set by Database page "Order" action.
#   backordered   — order placed (registrar drop-catch / auction bid /
#                   manual purchase pending settlement). Manual flip from
#                   the Backlog page row.
#   bought        — domain is acquired and owned (TERMINAL — the
#                   transferred-and-yours state)
#   discarded    — decided to pass on it (TERMINAL)
#   banned       — added to the ban list AFTER having a backlog row.
#                   Auto-set when a domain with an existing
#                   BacklogDomain row is added to DomainBan; never set
#                   for ban actions on domains without a backlog row.
#                   Per design (β), unbanning leaves status='banned'
#                   intact — the user re-statuses manually if desired.
BACKLOG_STATUSES = (
    "backlog",
    "in_progress",
    "analyzed",
    "order",
    "backordered",
    "bought",
    "discarded",
    "banned",
)


class BacklogDomain(Base):
    __tablename__ = "backlog_domains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Stored lowercased + scheme/path-stripped; the import path normalizes
    # before insert. Unique via the index below so dedup is enforced at the
    # DB layer too, not just the application.
    domain: Mapped[str] = mapped_column(String(512), nullable=False)
    # `index=True` on the columns that drive filters / sorts / the
    # registrar-options DISTINCT query. Without these, the Backlog page
    # was full-table-scanning at 200k rows on every page navigation.
    status: Mapped[str] = mapped_column(String(32), default="backlog", index=True)
    registrar: Mapped[str] = mapped_column(String(128), default="", index=True)
    expiration_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    # Free-form per-row label (added 2026-05-18). Sits next to `comments`
    # — same edit affordances, no semantic constraint. The user can drop
    # a project / campaign / batch tag here to triage their backlog by
    # context without inventing a structured taxonomy. Plain text, not
    # indexed (no filter on it yet).
    project: Mapped[str] = mapped_column(Text, default="")
    comments: Mapped[str] = mapped_column(Text, default="")
    desired_price: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    max_price: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    # Ahrefs DR (Domain Rating, 0-100) captured at backlog-import time
    # (added 2026-05-20). Stored only — NOT surfaced on the Backlog UI
    # or the Database UI for now; reserved for a future export of "rows
    # we want to order" where DR is a procurement signal. Nullable +
    # not indexed (no filter/sort planned yet). Float (not Int) because
    # Ahrefs occasionally returns fractional DR via the API even though
    # the UI rounds it.
    ahrefs_dr: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Domain age in years (added 2026-05-20). Same storage-only
    # contract as ahrefs_dr — no UI surface yet; reserved for the same
    # future procurement export. Float because Spamzilla / Ahrefs /
    # ExpiredDomains.net all surface fractional ages (e.g. "5.2"); the
    # importer's parser sanity-rejects values <0 or >100 to drop
    # malformed cells. Column name encodes the unit so future "X age"
    # fields don't collide.
    domain_age_years: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    __table_args__ = (
        UniqueConstraint("domain", name="uq_backlog_domains_domain"),
    )


# --- Job tree ----------------------------------------------------------------

# Status is a free-string column rather than an Enum to keep migrations
# painless on SQLite (which doesn't support ALTER ENUM). The application
# layer enforces the allowed values: pending / running / done / failed /
# canceled.

class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    spec_json: Mapped[str] = mapped_column(Text, default="{}")  # Last-used AnalyzeSpec
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    # Pillar this Job belongs to (added 2026-05-15, Wave 1 of the
    # 3-pillar restructure). Values:
    #   quality        — Wayback + Ahrefs analysis (the original/legacy
    #                    pipeline; every pre-wave row backfills here)
    #   availability   — Domain availability cascade (RDAP / Domainr /
    #                    WHOIS-43); Wave 3
    #   whois_history  — Historical WHOIS / drop-detection via
    #                    WhoisFreaks-style provider + AI judge; Wave 2
    # Free-string column (not Enum) so migrations stay painless on
    # SQLite — the application layer enforces allowed values.
    kind: Mapped[str] = mapped_column(String(32), default="quality", index=True)
    # Soft-archive marker. NULL = active; non-NULL = archived at that time.
    # Active queries default to filtering archived jobs out; the Jobs UI has
    # an explicit Archived tab to bring them back into view.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Export/import idempotency key (2026-05-17). NULL by default; set on
    # first /jobs/{id}/export and preserved by /jobs/import so re-importing
    # the same bundle into a server that already holds that Job is a no-op
    # (dupe-skipped in the import summary). Indexed because the import
    # path looks the value up. Plain string column (UUID4 text); not a DB-
    # native UUID type to keep SQLite portability painless.
    export_uuid: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True, unique=True,
    )

    runs: Mapped[list["Run"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="Run.id.desc()"
    )


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    spec_json: Mapped[str] = mapped_column(Text, default="{}")  # Snapshot at run-time
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    # Optional user-supplied label. Empty string = unnamed; UI falls back
    # to "Run #N". Useful for distinguishing reruns ("with gpt-4o", "after
    # quota refilled") in the job's run list.
    name: Mapped[str] = mapped_column(String(255), default="")
    # Manual "definitive run" pin at the JOB level (added 2026-05-10).
    # Distinct from RunDomain.is_pinned (which is per-domain, cross-job).
    # When 1, this Run is the canonical source for the Job-page L/M/H
    # rollup pills; counts come from this run instead of the latest.
    # Invariant: at most one Run per job has is_pinned=1; enforced at
    # the pin endpoint inside one transaction.
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    # Per-run scoring override (added 2026-05-13 wave J). JSON dict shaped
    # like `{"weights": {"backlinks": 0.40, "refdomains": 0.20, ...}}` or
    # empty string when the run uses the global Settings weights. When
    # non-empty, the run's final scores were recomputed against these
    # weights and persisted into each RunDomain.final_assessment_json /
    # final_summary. Cleared by `DELETE /runs/{id}/recompute-final` which
    # recomputes back to current global weights in the same pass.
    scoring_override_json: Mapped[str] = mapped_column(Text, default="")

    job: Mapped[Job] = relationship(back_populates="runs")
    domains: Mapped[list["RunDomain"]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="RunDomain.id"
    )


class RunDomain(Base):
    __tablename__ = "run_domains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    # Indexed 2026-06-07: augmentation chain (`link_augmenters_for_run`),
    # Database row builder (`rds_by_domain` lookup), share-link resolver,
    # and the bulk-delete-by-domain path all filter `run_domains.domain
    # == ?`. Without an index, the priors_query inside
    # `link_augmenters_for_run` scans the whole table by rowid for every
    # new RunDomain — at ~10k RDs that turned a 76-domain Analyze submit
    # into a 21-second hang (profiled 2026-06-07). The startup migration
    # creates the index in-place for pre-existing DBs.
    domain: Mapped[str] = mapped_column(String(512), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")

    # AI final-assessment fields. JSON column keeps the full {final, summary,
    # recommendation} object; final_summary holds the short label (e.g.
    # "quality"|"mixed"|"low_quality") for the summary-table column without
    # needing to parse JSON for every row.
    final_assessment_json: Mapped[str] = mapped_column(Text, default="")
    # Russian translation of `final_assessment_json` (added 2026-05-13
    # wave K). Same shape as the original — only `summary` and
    # `recommendation` are translated; other fields (final, confidence,
    # provider, model) are mirrored unchanged. Empty when the rd has
    # never been translated. Display logic prefers this over the original
    # whenever it's populated; no UI toggle. Populated by the bulk
    # `POST /database/translate-verdicts` endpoint.
    final_assessment_ru_json: Mapped[str] = mapped_column(Text, default="")
    final_summary: Mapped[str] = mapped_column(String(20), default="")
    # Updated whenever the AI step completes for this domain (fresh judge,
    # reanalyze, or cache copy). `finished_at` represents the ORIGINAL run
    # completion and is left untouched by reanalyze; `last_analyzed_at`
    # answers "when was AI most recently applied here?".
    last_analyzed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    # Augmentation chain (added 2026-05-07): when this RunDomain was created
    # with a STRICT SUBSET of the criteria-set of a prior RunDomain for the
    # same domain, this points at that prior RunDomain. The Database page
    # uses this as a hint that the row is "stitched" — the latest run did
    # not displace earlier richer data; instead it augments it. Display
    # logic always falls back to per-criterion-latest regardless, so this
    # field is also informational (drives the "augments Run #N" chip).
    # `ON DELETE SET NULL` so deleting a canonical run doesn't cascade-
    # delete its augmenters; they re-root as standalone runs in the chain.
    augments_rd_id: Mapped[int | None] = mapped_column(
        ForeignKey("run_domains.id", ondelete="SET NULL"), nullable=True
    )

    # Final-assessment AI call accounting (added 2026-05-08). Per-criterion
    # judges record their own tokens on CriterionResult; these columns
    # capture the SEPARATE final-synth call ("aggregate the 4 sub-verdicts
    # into one final summary"). All NULL on pre-feature rows. Same lock-
    # at-write-time semantics as the CR-level columns: editing a model's
    # price later does NOT recompute past values.
    final_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    final_output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    final_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Manual "definitive run" pin (added 2026-05-08). When true, this
    # RunDomain is the canonical source for its `domain` on the Database
    # page — every cell (Ahrefs criteria, Wayback, AI verdicts, final
    # assessment, AI provenance) is read from this row only. App-level
    # invariant: at most one RunDomain per `domain` can have is_pinned=1
    # at any time; the pin endpoints enforce by clearing prior pins for
    # the same domain before flipping a new one. Database aggregation
    # now requires a pin — domains with no pin render with empty cells.
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)

    # Skip-reason for the availability cascade (added 2026-05-12). Non-
    # empty when the runner short-circuited Ahrefs/Wayback/AI because
    # the availability check classified the domain as registered with a
    # far-out expiration date (skip-registered policy). The RunDomain
    # row still exists with status='done' so the run can complete, but
    # no CriterionResult rows are written. The Run page UI shows the
    # skip reason in place of the criteria pills.
    #
    # Examples: 'registered, expires 2028-04-12'.
    # Empty string = was not skipped.
    skip_reason: Mapped[str] = mapped_column(String(256), default="")

    run: Mapped[Run] = relationship(back_populates="domains")
    results: Mapped[list["CriterionResult"]] = relationship(
        back_populates="run_domain", cascade="all, delete-orphan", order_by="CriterionResult.id"
    )


class AvailabilityCheck(Base):
    """History of domain-availability checks (added 2026-05-12).

    Every cascade invocation appends one row PER provider that responded
    (not just the final-answer provider) so the per-run check log shows
    full cost — e.g. RDAP timed out, Domainr answered — both rows
    written. The cascade's overall result is the *last* row for the
    domain (the one that resolved the status).

    `status` values:
      - 'available'   — confirmed unregistered
      - 'registered'  — confirmed registered; registrar/expires_on usually set
      - 'unknown'     — provider answered but couldn't determine (rare)
      - 'error'       — provider call failed (timeout, 429, 5xx, parse error)

    `provider` values: 'dns' | 'rdap' | 'domainr' | 'whois'

    `error_category` values: 'dns' | 'rdap' | 'domainr' | 'whois' |
    'quota' | 'network' | 'parse'. Drives the Errors-page category
    filter. NULL on successful checks.

    `run_id` links the check to the Run that triggered it (null for
    manual ad-hoc and bulk-recheck calls from the Database/Backlog
    pages).
    """
    __tablename__ = "availability_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain: Mapped[str] = mapped_column(String(512), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    checked_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True,
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    registrar: Mapped[str] = mapped_column(String(255), default="")
    # `expires_on` is a date (no time component) — that's what registry
    # responses commit to. Stored as DATE for clean sorting + range
    # queries (drives the skip-registered policy at runner time).
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    error_message: Mapped[str] = mapped_column(Text, default="")
    error_category: Mapped[str] = mapped_column(String(16), default="")
    raw_response: Mapped[str] = mapped_column(Text, default="")
    # Optional link to the Run that triggered this check (null for
    # manual / scheduled).
    run_id: Mapped[int | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True,
    )


class JobCriterionPin(Base):
    """Per-job × per-criterion pin (added 2026-05-12).

    Supersedes the older Run.is_pinned + RunDomain.is_pinned model for
    Database-page rollup. A row here says: "for this Job, the canonical
    source of criterion C is Run R." Multiple criteria within one Job can
    point at different Runs — the workflow this enables is iterative
    cascade (cheap Wayback first, expensive Ahrefs only on survivors;
    each step lives in its own Run but the Job's final view stitches
    them together).

    Invariants:
      - unique on (job_id, criterion) — at most one pin per criterion per job
      - run_id must belong to job_id (enforced in the endpoint, not the DB)
      - criterion ∈ CRITERIA (see routers/database.py CRITERIA tuple)

    Migration: legacy Run.is_pinned=True expands at startup to one
    JobCriterionPin row per criterion that pinned run has data for.
    Legacy RunDomain.is_pinned=True expands similarly, on the rd's run.
    """
    __tablename__ = "job_criterion_pins"
    __table_args__ = (
        UniqueConstraint(
            "job_id", "criterion", name="uq_job_criterion_pins_job_crit",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    criterion: Mapped[str] = mapped_column(String(32))
    run_id: Mapped[int] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class CriterionResult(Base):
    __tablename__ = "criterion_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_domain_id: Mapped[int] = mapped_column(
        ForeignKey("run_domains.id", ondelete="CASCADE")
    )
    criterion: Mapped[str] = mapped_column(String(20))  # backlinks/refdomains/anchors/keywords
    request_url: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    data_json: Mapped[str] = mapped_column(Text, default="")  # Raw Ahrefs response
    error: Mapped[str] = mapped_column(Text, default="")

    # AI per-criterion verdict — populated when the run included AI analysis.
    # Empty string when AI was disabled (or when the AI step itself failed —
    # ai_verdict_error captures that).
    ai_verdict_json: Mapped[str] = mapped_column(Text, default="")
    ai_verdict_error: Mapped[str] = mapped_column(Text, default="")
    # Russian translation of `ai_verdict_json` (added 2026-05-13 wave K2).
    # Mirror with translated `key_findings` + `red_flags` arrays —
    # everything else (assessment enum, confidence, primary_theme,
    # category, etc.) copied unchanged. Empty when not yet translated.
    # Populated alongside `RunDomain.final_assessment_ru_json` by the
    # bulk POST /database/translate-verdicts endpoint. Display logic in
    # routers/jobs.get_run_domain_detail prefers this when populated.
    ai_verdict_ru_json: Mapped[str] = mapped_column(Text, default="")

    # Per-job cache support. `params_hash` uniquely identifies the Ahrefs
    # request shape (criterion + filters + sort + limit) so a rerun with the
    # same shape can reuse data from a prior run. `prompt_hash` covers the
    # AI side (system prompt + provider + model). `cached_from_run_id` /
    # `ai_cached_from_run_id` are NULL on a fresh fetch/judge; otherwise they
    # point at the source run that supplied the data/verdict.
    params_hash: Mapped[str] = mapped_column(String(64), default="")
    prompt_hash: Mapped[str] = mapped_column(String(64), default="")
    cached_from_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_cached_from_run_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )

    # Ahrefs unit accounting captured from response headers. NULL on cache
    # hits (no Ahrefs call was made) or pre-feature rows. `cost_total` is
    # the list-price for this request; `cost_actual` is what Ahrefs billed
    # — the gap means Ahrefs's own server-side cache saved the call.
    units_cost_row: Mapped[int | None] = mapped_column(Integer, nullable=True)
    units_cost_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    units_cost_actual: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Provider + model that produced ai_verdict_json. Captured at write time
    # so reanalyze-with-different-model is provenance-correct: the run's
    # `spec.ai` records the original choice; these columns record what
    # actually judged the row most recently. Empty string when no AI verdict.
    ai_provider: Mapped[str] = mapped_column(String(32), default="")
    ai_model: Mapped[str] = mapped_column(String(128), default="")

    # AI token + cost accounting (added 2026-05-08). All three are NULL on
    # pre-feature rows. On a fresh AI call, the runner reads usage from the
    # provider response and computes `cost_usd` at write time using the
    # current `model_pricing` row — locked in, never recomputed when the
    # user edits prices later. On an AI cache hit, tokens copy from the
    # source row but `ai_cost_usd = 0` so run-level totals reflect only
    # actual fresh-call spend.
    ai_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    run_domain: Mapped[RunDomain] = relationship(back_populates="results")


# --- Error log + dismissals -------------------------------------------------

class ErrorLog(Base):
    """Server-side error sink. Two write paths feed it (Phase 2):
    1. The custom `DbLogHandler` attached to root logging — every
       `log.exception()` / `log.error()` lands here.
    2. The FastAPI exception middleware — uncaught request handler errors
       persist before the response goes out.

    `source` distinguishes them at read time. `context_json` is a free-form
    bag (request path/method, runtime hints) that stays cheap to add to
    without schema changes.

    NOT used by Phase 1 sources (CriterionResult.error etc. — those stay
    on their original rows). The Errors page UNION's both pools at read
    time so the user sees one unified list."""
    __tablename__ = "error_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )
    # 'backend_log' (Python logging) | 'backend_exception' (FastAPI middleware)
    source: Mapped[str] = mapped_column(String(32), default="backend_log")
    level: Mapped[str] = mapped_column(String(16), default="error")
    message: Mapped[str] = mapped_column(Text, default="")
    traceback: Mapped[str] = mapped_column(Text, default="")
    context_json: Mapped[str] = mapped_column(Text, default="")


class DismissedError(Base):
    """Records a user-dismissed error. Composite key (source_kind, source_id,
    message_hash) ensures dismissal is tied to the SPECIFIC error message —
    if the source row gets re-fetched and produces a new error, the new
    message hashes differently and shows up un-dismissed. Restore = delete
    the row."""
    __tablename__ = "dismissed_errors"
    __table_args__ = (
        UniqueConstraint(
            "source_kind", "source_id", "message_hash",
            name="uq_dismissed_errors_kind_id_hash",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 'criterion_ai' | 'criterion_fetch' | 'run_domain' | 'run' | 'log'
    source_kind: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[int] = mapped_column(Integer)
    message_hash: Mapped[str] = mapped_column(String(64))
    dismissed_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )


# --- Model pricing ---------------------------------------------------------

class ModelPricing(Base):
    """User-maintained price table for AI model token costs. One row per
    (provider, model) pair; rates in $ per 1M tokens.

    Auto-seeded with 0/0 placeholders for any (provider, model) present in
    the model registry that doesn't yet have a row — see settings/pricing
    GET handler. The user fills the actual rates from each provider's
    pricing page.

    Cost is locked in at AI call time using whatever rate is in this table
    when the call writes; later edits to a row do NOT retroactively
    recompute prior CriterionResult rows (intentional — keeps run-level
    cost totals stable so they reflect what was actually paid)."""
    __tablename__ = "model_pricing"

    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    model: Mapped[str] = mapped_column(String(128), primary_key=True)
    input_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    output_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# --- Domain ban list (added 2026-05-13 wave L) -----------------------------
#
# Permanent "never want this domain again" filter. Distinct from the
# Backlog `discarded` status (which is a soft per-decision flag) — a ban
# is a hard, recurring pre-filter applied at every domain-ingestion
# point: backlog CSV import, the Database page Order/Discard upserts,
# the availability cascade's auto-create bridge, and the Analyze
# submit. Existing BacklogDomain rows are NEVER touched by banning
# (pure pre-filter) — un-banning has no inverse cleanup work to do.

class DomainBan(Base):
    """One row per banned domain. Lowercase-normalized — same normalization
    used everywhere else in the app (no protocol, no path)."""
    __tablename__ = "domain_bans"

    domain: Mapped[str] = mapped_column(String(512), primary_key=True)
    # Optional free-form note explaining why this domain was banned.
    # Empty string by default — UI shows the note column muted when empty.
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow,
    )
    # Snapshot of the BacklogDomain row at the moment of banning (JSON
    # dict with status / registrar / expiration_date / comments /
    # desired_price / max_price / created_at / updated_at). Empty string
    # when banning happened without a matching Backlog row (e.g., CSV
    # Ban List import of unknown domains). On unban, the snapshot is
    # used to restore the Backlog row — symmetric ban/unban semantics
    # (locked 2026-05-14, supersedes the wave-O β "leave-status-alone"
    # design after the user hit the discoverability problem).
    backlog_snapshot_json: Mapped[str] = mapped_column(Text, default="")


# --- Public view-only share links (added 2026-05-15) ----------------------
#
# Lets the operator generate an unguessable URL that anyone can open to
# view a single RunDomain's analysis page WITHOUT the basic-auth
# credential. Targets a specific (job, run, domain) so the view is
# frozen — re-pins or re-judges on other runs don't change what the
# recipient sees. Caddy bypasses basicauth for `/share/*` (frontend)
# and `/api/public/*` (backend). The backend route checks the token
# here on every hit and 404s on revoked/expired tokens.
#
# Token is 32 chars urlsafe (~190 bits of entropy — well past
# unguessable). Distinct from a Fernet payload — there's no need to
# encode anything inside it; the lookup keys this table.

class DomainShare(Base):
    """One row per share link. PK on the token so lookups are index-served
    and the public endpoint never has to scan."""
    __tablename__ = "domain_shares"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Target run-domain. We do NOT cascade-delete on RunDomain deletion
    # at the DB layer — RunDomain deletes are exceedingly rare in this
    # app, and a dangling share simply 404s in the public handler
    # (resolved row is None). Keeping the share row preserves an audit
    # trail (who created it, when, how many views) even after the
    # underlying analysis is purged.
    run_domain_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # Creator's free-text label (e.g. "demo for ClientCorp", "internal
    # SEO team"). Surfaced in the management table for searchability.
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True,
    )
    # Optional expiry. NULL = never expires; public handler 404s past
    # the date. Stored in UTC like every other datetime in the app.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Revocation tombstone. NULL = active; non-NULL = the moment the
    # operator clicked revoke. We do NOT hard-delete revoked rows so
    # the view_count + last_viewed_at audit trail survives — useful
    # for "was this link being used when I revoked it?" forensics.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Source IP of the creator (best-effort; behind Caddy this is the
    # X-Forwarded-For first hop). Audit-only — never surfaced to the
    # recipient.
    created_ip: Mapped[str] = mapped_column(String(64), default="")


# --- Wayback Sparkline batch jobs (Tools page, added 2026-05-23) ---------
#
# Standalone Tools-page flow for getting the TOTAL Wayback snapshot count
# per domain at scale (target: 100k domains per submit). Sourced from
# archive.org's `__wb/sparkline` endpoint — the same JSON the calendar
# UI uses for its sparkline chart. Returns exact capture counts in ~0.4
# to 1.0s/domain, ~130× faster than full CDX queries.
#
# Why a separate table tree (not the Job/Run/CR pipeline):
#   - No criteria, no AI, no quality scoring — the only output is an
#     integer per domain plus a couple of year markers. Reusing
#     CriterionResult would force null columns everywhere and add noise
#     to the Database page's row builder.
#   - 100k results per submit don't fit the existing per-domain
#     RunDomain pattern at sensible query speed — RunDomain has too
#     many index-amplifying columns (criteria links, AI provenance,
#     final_assessment). A flat sparkline-only result table indexes
#     much tighter.
#   - Cancelable/pausable independent of the Job pipeline so a 100k
#     job doesn't compete with quality runs for the same orchestrator
#     attention.
#
# Status semantics:
#   pending    — created but not yet picked up by the runner
#   running    — worker actively processing
#   paused     — operator-issued pause (in-flight tasks finish then idle)
#   done       — every domain has a terminal result row (ok or error)
#   failed     — orchestrator-level failure (rare; per-domain errors
#                stay on the result row and don't fail the job)
#   canceled   — operator-issued cancel (worker exits; results stay)
class WaybackSparklineJob(Base):
    __tablename__ = "wayback_sparkline_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Optional user label so the list page can identify a job at a
    # glance. Empty string ⇒ list page shows "Job #N" fallback.
    name: Mapped[str] = mapped_column(String(255), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # Free-string status (same pattern as Run.status); allowed values
    # listed in the class docstring above. The router enforces.
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    error: Mapped[str] = mapped_column(Text, default="")

    # Submission stats — these don't move after submit. The
    # progress counters live on the result rows (server-aggregates).
    submitted_count: Mapped[int] = mapped_column(Integer, default=0)
    # Concurrency knob captured at submit time so changing the global
    # default doesn't retroactively affect already-running jobs.
    concurrency: Mapped[int] = mapped_column(Integer, default=8)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # IP of the user who submitted (best-effort, same pattern as
    # DomainShare). Audit-only.
    created_ip: Mapped[str] = mapped_column(String(64), default="")

    results: Mapped[list["WaybackSparklineResult"]] = relationship(
        back_populates="job",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class WaybackSparklineResult(Base):
    """One row per domain per WaybackSparklineJob. Flat schema — no
    foreign keys to RunDomain / CriterionResult; this is a standalone
    Tools-page result table.

    Sized for 100k rows per job. The composite (job_id, domain) index
    powers the per-job results list; the (job_id, status) partial index
    powers the runner's pending-pick query without scanning done rows."""
    __tablename__ = "wayback_sparkline_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("wayback_sparkline_jobs.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # Lowercased + trimmed at submit time so duplicate inputs collapse.
    # NOT host-validated server-side; sparkline gracefully returns 0
    # captures on garbage input so we just record the raw answer.
    domain: Mapped[str] = mapped_column(String(512), index=True, nullable=False)
    # pending → fetching → ok | error. fetching exists so the UI
    # progress bar can show "X in flight" distinct from queued; the
    # runner flips it on worker entry and back to ok/error on exit.
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)

    # Total captures across all years. NULL until the result lands.
    # Capped at sparkline's natural ceiling (~20M observed for
    # google.com); int32 is plenty.
    snapshot_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # First / last calendar year that has at least one capture. NULL
    # when snapshot_count == 0 (no history). Useful for "drop hunter"
    # filtering — short-history domains vs long-running brands.
    first_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Count of distinct years in the sparkline payload's `years` map.
    # Cheap quality signal — a domain with 10 captures spread over
    # 15 years is likely a long-lived brand; 10 captures all in 2024
    # is an active-but-young site.
    years_with_data: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Free-text on error path (HTTP status, network exception). Empty
    # on the happy path.
    error_msg: Mapped[str] = mapped_column(Text, default="")
    # Captured response time (ms) — useful for capacity planning
    # ("which provider host is slow today?") and for the calibration
    # logic that nudges concurrency down on sustained slowness.
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    fetched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    job: Mapped["WaybackSparklineJob"] = relationship(back_populates="results")

    __table_args__ = (
        # Per-job uniqueness on the domain so a buggy retry doesn't
        # double-insert. Enforced at the DB level since the runner
        # touches rows from multiple coroutines.
        UniqueConstraint("job_id", "domain", name="uq_wayback_spark_job_domain"),
    )
