from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import Base, SessionLocal, engine
from .error_capture import DbExceptionMiddleware, install_db_log_handler
from .routers import (
    analyze,
    availability as availability_router,
    backlog as backlog_router,
    backups as backups_router,
    banlist as banlist_router,
    dashboard,
    database as database_router,
    errors as errors_router,
    job_io as job_io_router,
    jobs as jobs_router,
    public_shares as public_shares_router,
    settings as settings_router,
    shares as shares_router,
)
from .scheduler import get_scheduler
from .tasks import mark_orphaned_runs_paused


def _migrate_sqlite_columns() -> None:
    """Idempotent additive migrations for SQLite. SQLAlchemy's create_all()
    doesn't ALTER existing tables, so we add new optional columns by hand.
    Safe to run on every boot."""
    from sqlalchemy import text
    additions = [
        # (table, column, ddl)
        ("criterion_results", "ai_verdict_json", "TEXT DEFAULT ''"),
        ("criterion_results", "ai_verdict_error", "TEXT DEFAULT ''"),
        ("run_domains", "final_assessment_json", "TEXT DEFAULT ''"),
        ("run_domains", "final_summary", "VARCHAR(20) DEFAULT ''"),
        ("jobs", "archived_at", "DATETIME"),
        # Per-job cache: hashes of the request shape and AI prompt + a
        # back-reference to the run that supplied the data/verdict on a
        # cache hit. NULL on fresh fetches/judges.
        ("criterion_results", "params_hash", "VARCHAR(64) DEFAULT ''"),
        ("criterion_results", "prompt_hash", "VARCHAR(64) DEFAULT ''"),
        ("criterion_results", "cached_from_run_id", "INTEGER"),
        ("criterion_results", "ai_cached_from_run_id", "INTEGER"),
        # Ahrefs unit accounting — captured from response headers per fetch.
        ("criterion_results", "units_cost_row", "INTEGER"),
        ("criterion_results", "units_cost_total", "INTEGER"),
        ("criterion_results", "units_cost_actual", "INTEGER"),
        # AI provenance per CriterionResult — provider + model that actually
        # produced the saved verdict (may differ from run.spec.ai when the
        # user reanalyzed with a different model).
        ("criterion_results", "ai_provider", "VARCHAR(32) DEFAULT ''"),
        ("criterion_results", "ai_model", "VARCHAR(128) DEFAULT ''"),
        # Tracks when AI most recently judged this domain. Distinct from
        # finished_at (which is the original run-completion time).
        ("run_domains", "last_analyzed_at", "DATETIME"),
        # Augmentation chain (added 2026-05-07). Points at the prior
        # RunDomain this one augments (criteria-set strict subset).
        # NULL means "this RunDomain is canonical / standalone."
        ("run_domains", "augments_rd_id", "INTEGER"),
        # Optional user-supplied run label (added 2026-05-08). Empty
        # string = unnamed; UI shows "Run #N" as fallback.
        ("runs", "name", "VARCHAR(255) DEFAULT ''"),
        # AI token + cost accounting (added 2026-05-08). All NULL on
        # pre-feature rows. Cost is locked in at write time and never
        # recomputed when the user edits a model_pricing row later.
        ("criterion_results", "ai_input_tokens", "INTEGER"),
        ("criterion_results", "ai_output_tokens", "INTEGER"),
        ("criterion_results", "ai_cost_usd", "REAL"),
        # Final-synth tokens/cost — separate AI call per domain.
        ("run_domains", "final_input_tokens", "INTEGER"),
        ("run_domains", "final_output_tokens", "INTEGER"),
        ("run_domains", "final_cost_usd", "REAL"),
        # Manual "definitive run" pin (added 2026-05-08). When 1, this
        # RunDomain is the canonical source for its domain on the
        # Database page. At most one rd per domain is pinned; enforcement
        # is at the pin endpoints, not via DB constraint (clearing the
        # prior pin and setting the new one happen inside one transaction).
        ("run_domains", "is_pinned", "BOOLEAN DEFAULT 0"),
        # Per-job Run pin (added 2026-05-10). When 1, this Run is the
        # canonical source for the Job-page L/M/H rollup pills. Distinct
        # from run_domains.is_pinned (per-domain, cross-job). Same
        # invariant pattern: at most one Run per job is pinned; enforced
        # at the endpoint.
        ("runs", "is_pinned", "BOOLEAN DEFAULT 0"),
        # Skip-reason for the availability cascade's skip-registered
        # policy (added 2026-05-12). Empty = was not skipped.
        ("run_domains", "skip_reason", "VARCHAR(256) DEFAULT ''"),
        # Per-run scoring-weights override (added 2026-05-13 wave J).
        # JSON shaped like `{"weights": {"backlinks": 0.4, ...}}` or "" if
        # the run uses the global Settings weights. Set/cleared by the
        # /runs/{id}/recompute-final endpoint family; rewrites every rd's
        # final_assessment_json + final_summary in the same transaction.
        ("runs", "scoring_override_json", "TEXT DEFAULT ''"),
        # Russian translation of the final-assessment prose (added
        # 2026-05-13 wave K). Mirror of final_assessment_json with
        # translated `summary` + `recommendation`. Empty when not yet
        # translated; populated by POST /database/translate-verdicts.
        ("run_domains", "final_assessment_ru_json", "TEXT DEFAULT ''"),
        # Russian translation of per-criterion AI verdict (added
        # 2026-05-13 wave K2). Mirror of `ai_verdict_json` with
        # translated `key_findings` + `red_flags` arrays. Same
        # endpoint populates both.
        ("criterion_results", "ai_verdict_ru_json", "TEXT DEFAULT ''"),
        # Backlog snapshot captured at ban time (added 2026-05-14).
        # JSON dict of the BacklogDomain fields, or "" when the banned
        # domain had no Backlog row. Used to restore the row on unban.
        ("domain_bans", "backlog_snapshot_json", "TEXT DEFAULT ''"),
        # Pillar discriminator (added 2026-05-15, Wave 1 of the
        # 3-pillar restructure). Every pre-wave row backfills to
        # 'quality' via the dedicated step below; the additive
        # migration here just makes the column exist. New jobs are
        # tagged by the create endpoint (analyze sets 'quality',
        # availability sets 'availability', whois_history sets
        # 'whois_history').
        ("jobs", "kind", "VARCHAR(32) DEFAULT 'quality'"),
        # Export bundle UUID (2026-05-17). NULL on jobs that have never
        # been exported; set on first /jobs/{id}/export and copied across
        # by /jobs/import so re-importing the same bundle is a no-op
        # (the importer looks up by this column). Plain string UUID4
        # text; not a DB-native UUID type for SQLite portability.
        ("jobs", "export_uuid", "VARCHAR(36)"),
        # Free-form per-row "Project" label on Backlog (added 2026-05-18).
        # Sits next to `comments`; same edit affordances, no semantics
        # enforced. NOT NULL via the "" default to match comments.
        ("backlog_domains", "project", "TEXT DEFAULT ''"),
    ]
    # Indexes added after the table existed in production. SQLAlchemy's
    # create_all only creates indexes alongside the table; adding
    # `index=True` later doesn't backfill them. CREATE INDEX IF NOT EXISTS
    # is fast and safe to run on every boot — even at hundreds of
    # thousands of rows the b-tree builds in a few seconds, only on the
    # first boot after the migration was added.
    backlog_indexes = [
        ("ix_backlog_domains_status", "backlog_domains", "status"),
        ("ix_backlog_domains_registrar", "backlog_domains", "registrar"),
        ("ix_backlog_domains_expiration_date", "backlog_domains", "expiration_date"),
        ("ix_backlog_domains_desired_price", "backlog_domains", "desired_price"),
        ("ix_backlog_domains_max_price", "backlog_domains", "max_price"),
        ("ix_backlog_domains_created_at", "backlog_domains", "created_at"),
        # Added 2026-05-10: drives the IN-list join in /database/domains
        # so the Notes lookup is index-served instead of full-scanning
        # domain_notes. See notes_by_domain in routers/database.py.
        ("ix_domain_notes_domain", "domain_notes", "domain"),
        # Added 2026-05-12: drives the per-(job, criterion) lookup in the
        # rewritten Database/Job rollup paths.
        ("ix_job_criterion_pins_job_id", "job_criterion_pins", "job_id"),
        ("ix_job_criterion_pins_run_id", "job_criterion_pins", "run_id"),
        # Added 2026-05-12: drives the per-domain cascade cache lookup
        # ("any recent check for this domain?") plus the per-run check
        # log and the monthly usage stats.
        ("ix_availability_checks_domain", "availability_checks", "domain"),
        ("ix_availability_checks_checked_at", "availability_checks", "checked_at"),
        ("ix_availability_checks_run_id", "availability_checks", "run_id"),
        # Added Wave 1 — drives the kind-filtered list endpoint
        # for the /jobs/{quality,whois_history,availability} pages.
        ("ix_jobs_kind", "jobs", "kind"),
        # Added 2026-05-16 — critical for large-job scaling. The
        # /jobs/{id} verdict-count aggregation and the
        # /runs/{id}/progress slim poll both filter run_domains by
        # run_id; CriterionResult lookups for per-domain CRs filter by
        # run_domain_id. Without these indexes, every WHERE on a large
        # run does a full table scan (e.g. 100k row scan per request).
        ("ix_run_domains_run_id", "run_domains", "run_id"),
        ("ix_criterion_results_run_domain_id", "criterion_results", "run_domain_id"),
        # 2026-05-17: import-dedup lookup keyed on the per-bundle UUID
        # written at export time.
        ("ix_jobs_export_uuid", "jobs", "export_uuid"),
    ]
    with engine.begin() as conn:
        for table, column, ddl in additions:
            existing = {
                row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))
            }
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        for index_name, table, column in backlog_indexes:
            conn.execute(
                text(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})")
            )


def _backfill_params_hash() -> None:
    """One-shot: compute params_hash for existing CriterionResult rows that
    pre-date the cache feature. Without this, the first rerun after enabling
    the cache won't find any matching prior rows. Idempotent — skips rows
    that already have a hash."""
    import json as _json
    import logging

    from .cache import compute_params_hash
    from .models import CriterionResult, Run, RunDomain
    from .schemas import AnalyzeSpec

    db = SessionLocal()
    try:
        rows = (
            db.query(CriterionResult)
            .filter(
                (CriterionResult.params_hash == "")
                | (CriterionResult.params_hash.is_(None))
            )
            .all()
        )
        if not rows:
            return
        spec_cache: dict[int, AnalyzeSpec | None] = {}
        rd_cache: dict[int, RunDomain | None] = {}
        n = 0
        for cr in rows:
            rd = rd_cache.get(cr.run_domain_id)
            if rd is None:
                rd = db.get(RunDomain, cr.run_domain_id)
                rd_cache[cr.run_domain_id] = rd
            if rd is None:
                continue
            run_id = rd.run_id
            if run_id not in spec_cache:
                run = db.get(Run, run_id)
                if run is None:
                    spec_cache[run_id] = None
                else:
                    try:
                        spec_cache[run_id] = AnalyzeSpec.model_validate(
                            _json.loads(run.spec_json or "{}")
                        )
                    except Exception:  # noqa: BLE001
                        spec_cache[run_id] = None
            spec = spec_cache[run_id]
            if spec is None:
                continue
            cfg = getattr(spec.criteria, cr.criterion, None)
            if cfg is None:
                continue
            cr.params_hash = compute_params_hash(cr.criterion, cfg)
            n += 1
        if n:
            db.commit()
            logging.getLogger(__name__).info(
                "backfilled params_hash on %s criterion_result row(s)", n
            )
    finally:
        db.close()


def _migrate_wayback_concurrency_default() -> None:
    """One-shot: lower stored `wayback.max_concurrent` from 2 to 1 for
    users who never touched the default. Pre-2026-05-07 the default was
    2; we lowered it to 1 after observing batch cascades on free-tier
    Wayback CDX. If the stored value is exactly 2 (the old default),
    flip it to 1; if the user explicitly set a different value (1, 3, or
    higher), respect that. Idempotent — flipping `2 → 1` once leaves
    nothing further to do."""
    import logging
    db = SessionLocal()
    try:
        from sqlalchemy import select
        from .models import AppSetting
        stmt = select(AppSetting).where(
            AppSetting.key == "rate_limit__wayback__max_concurrent"
        )
        row = db.execute(stmt).scalar_one_or_none()
        if row is None or row.value != "2":
            return
        # Bump down only when the stored value matches the old default.
        row.value = "1"
        db.commit()
        logging.getLogger(__name__).info(
            "auto-lowered wayback.max_concurrent 2 → 1 (was old default)"
        )
    except Exception:  # noqa: BLE001
        # Best-effort — never block startup on this.
        pass
    finally:
        db.close()


def _reconcile_stale_failed_statuses() -> None:
    """Self-heal RunDomain.status='failed' rows whose criteria are now all
    'done' (typically because the user reanalyzed individual criteria after
    a fix). Pre-2026-05-07 reanalyze paths didn't refresh rd.status, so
    those rows are stuck on the failed pill until the next manual rerun.
    Idempotent — only flips clearly-stale rows.

    Also flips a Run.status='failed' to 'done' if every one of its domains
    is now done. Conservative: only ever forward (failed → done), never
    reopen a done run as failed."""
    import logging

    from .models import Run, RunDomain
    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        rds = db.query(RunDomain).filter(RunDomain.status == "failed").all()
        flipped_rds = 0
        affected_run_ids: set[int] = set()
        for rd in rds:
            if not rd.results:
                continue  # no rows to judge from — leave it
            if any(cr.status == "failed" for cr in rd.results):
                continue
            if not all(cr.status == "done" for cr in rd.results):
                continue
            rd.status = "done"
            rd.error = ""
            flipped_rds += 1
            affected_run_ids.add(rd.run_id)
        if flipped_rds:
            db.commit()
            log.info(
                "reconciled %s stale RunDomain.failed row(s) on startup",
                flipped_rds,
            )

        flipped_runs = 0
        for run_id in affected_run_ids:
            run = db.get(Run, run_id)
            if run is None or run.status != "failed":
                continue
            if all(d.status == "done" for d in run.domains):
                run.status = "done"
                run.error = ""
                flipped_runs += 1
        if flipped_runs:
            db.commit()
            log.info(
                "reconciled %s stale Run.failed row(s) on startup",
                flipped_runs,
            )
    finally:
        db.close()


def _reconcile_orphaned_running_run_domains() -> int:
    """Self-heal RunDomain rows stuck in `status='running'` whose parent
    Run is terminal. Pattern: a uvicorn restart killed the cascade task
    mid-flight; the rd never reached its phase-3 'flip to done/failed'
    write, so the badge says "running" forever and the chip silently
    buckets it as "без вердикта" (no_verdict). At the user's scale this
    accumulated to 40 zombie RDs across the DB and 8 in run 99 alone
    before the 2026-05-17 fix.

    Behaviour: flips rd.status='running' → 'failed' and any availability
    CR also stuck at status='running' with empty data_json → 'failed'.
    `rd.error` and `cr.error` get a stamp so operators know why. The
    existing 'Retry failed' path catches `cr.status='failed'` and
    deletes+re-cascades cleanly. Idempotent — only flips rows that meet
    both 'rd is running' AND 'parent run is terminal' AND 'cr.data_json
    is empty' (real partial data is preserved untouched).

    Returns the number of RDs flipped."""
    import logging

    from .models import CriterionResult, Run, RunDomain
    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        # Only act on RDs whose parent Run is in a terminal state — a
        # running parent might legitimately have running children.
        terminal_runs = {
            r.id for r in db.query(Run).filter(
                Run.status.in_(("done", "failed", "canceled")),
            ).all()
        }
        if not terminal_runs:
            return 0
        rds = (
            db.query(RunDomain)
            .filter(RunDomain.status == "running")
            .filter(RunDomain.run_id.in_(terminal_runs))
            .all()
        )
        if not rds:
            return 0
        flipped = 0
        now = datetime.utcnow()
        for rd in rds:
            rd.status = "failed"
            rd.error = (
                "orphaned at startup: cascade did not complete (likely "
                "uvicorn restart mid-flight); reset by reconciliation"
            )
            if rd.finished_at is None or rd.finished_at < (rd.started_at or now):
                rd.finished_at = now
            for cr in rd.results:
                if cr.status == "running" and not cr.data_json:
                    cr.status = "failed"
                    cr.error = (cr.error or "") + (
                        "" if not cr.error else "; "
                    ) + "orphaned at startup reconciliation"
            flipped += 1
        db.commit()
        log.info(
            "reconciled %s orphaned RunDomain.running row(s) on startup",
            flipped,
        )
        return flipped
    finally:
        db.close()


def _backfill_augmentation() -> None:
    """One-shot: link existing RunDomain rows that were created before the
    augmentation feature existed. Cheap (in-memory walk per domain) and
    idempotent — only touches rows whose `augments_rd_id` is null."""
    import logging
    from .augmentation import backfill_augmentation_for_existing_rows
    db = SessionLocal()
    try:
        n = backfill_augmentation_for_existing_rows(db)
        if n:
            logging.getLogger(__name__).info(
                "backfilled augments_rd_id on %s RunDomain row(s)", n
            )
    finally:
        db.close()


def _encrypt_legacy_secret_settings() -> None:
    """One-shot: encrypt any pre-existing plaintext rows in app_settings
    whose key ends with a secret-field suffix (api_key, token,
    password, access_key_id, secret_access_key).

    Idempotent — already-encrypted rows are detected by the Fernet
    prefix and skipped. Safe to run on every boot.

    Touching the DB triggers Fernet key bootstrap (env → file → auto-
    generate); a fresh deploy with no plaintext rows still ends up with
    a key on disk for future writes."""
    import logging
    from . import crypto
    from .models import AppSetting

    db = SessionLocal()
    try:
        rows = db.query(AppSetting).all()
        n = 0
        for r in rows:
            if not r.value or not crypto.key_is_secret(r.key):
                continue
            if crypto.is_encrypted(r.value):
                continue
            r.value = crypto.encrypt(r.value)
            n += 1
        if n:
            db.commit()
            logging.getLogger(__name__).info(
                "Encrypted %s legacy plaintext secret row(s) in app_settings",
                n,
            )
    except Exception as e:  # noqa: BLE001
        # Don't crash the whole boot if encryption fails — log and
        # continue. The app still works; secrets just remain plaintext
        # until the user re-saves them via the UI.
        import logging
        logging.getLogger(__name__).exception(
            "Legacy secret encryption migration failed: %s", e,
        )
    finally:
        db.close()


def _backfill_job_kind() -> None:
    """Wave 1 (2026-05-15): every existing Job row dates from before the
    3-pillar restructure → tag them all `'quality'`. The additive ALTER
    in `_migrate_sqlite_columns` sets a column-level default of 'quality'
    so new INSERTs are fine; this one-shot covers the (rare) case where
    a row was inserted with `kind=NULL` or `kind=''` before the column
    default kicked in for that particular client.

    Idempotent — only touches rows whose `kind` is null/empty.
    """
    import logging
    from sqlalchemy import text

    log = logging.getLogger(__name__)
    try:
        with engine.begin() as conn:
            result = conn.execute(
                text(
                    "UPDATE jobs SET kind = 'quality' "
                    "WHERE kind IS NULL OR kind = ''"
                )
            )
            if result.rowcount:
                log.info(
                    "Wave-1 backfill: tagged %s pre-existing Job row(s) as kind='quality'",
                    result.rowcount,
                )
    except Exception:  # noqa: BLE001
        log.exception("job kind backfill failed")


def _migrate_legacy_pins_to_criterion_pins() -> None:
    """One-shot: expand legacy Run.is_pinned + RunDomain.is_pinned rows into
    the per-(job, criterion) `job_criterion_pins` table introduced
    2026-05-12. Idempotent — only emits new rows when no pin exists for
    (job, criterion).

    Expansion rules:
      1. For every Run with is_pinned=True: walk its CriterionResults
         across all RunDomains; for each criterion the run produced data
         for (cr.data_json non-empty OR cr.status == 'done'), insert
         (job_id=run.job_id, criterion=cr.criterion, run_id=run.id) if
         no pin exists yet.
      2. For every RunDomain with is_pinned=True: same as above but the
         per-criterion data is taken from that rd's CRs only — represents
         a curator's intent that those criteria's verdicts come from
         that run on the Database page.

    Conflict resolution: Run.is_pinned expansion runs first; RunDomain
    expansion only fills gaps. This favors the broader "this whole run is
    canonical" intent over the per-domain pin when both were set on
    different runs in the same job.
    """
    import logging

    from sqlalchemy import select

    from .models import CriterionResult, JobCriterionPin, Run, RunDomain
    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        # Snapshot existing pins so we don't double-insert across reboots.
        existing_pairs: set[tuple[int, str]] = {
            (p.job_id, p.criterion)
            for p in db.execute(select(JobCriterionPin)).scalars().all()
        }
        inserted = 0

        def _criteria_with_data(run_id: int) -> set[str]:
            """Set of criterion names this run has at least one populated
            CriterionResult for. Status=='done' or non-empty data_json
            both count (covers Wayback which sometimes has empty
            data_json but a done verdict)."""
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

        # Phase 1 — Run.is_pinned expansion
        pinned_runs = db.query(Run).filter(Run.is_pinned == True).all()  # noqa: E712
        for run in pinned_runs:
            crits = _criteria_with_data(run.id)
            for c in crits:
                key = (run.job_id, c)
                if key in existing_pairs:
                    continue
                db.add(JobCriterionPin(
                    job_id=run.job_id, criterion=c, run_id=run.id,
                ))
                existing_pairs.add(key)
                inserted += 1

        # Phase 2 — RunDomain.is_pinned gap-fill (only criteria not yet
        # covered by a Run-level pin for the same job).
        pinned_rds = db.query(RunDomain).filter(RunDomain.is_pinned == True).all()  # noqa: E712
        for rd in pinned_rds:
            run = db.get(Run, rd.run_id)
            if run is None:
                continue
            for cr in rd.results:
                if not (cr.status == "done" or cr.data_json):
                    continue
                key = (run.job_id, cr.criterion)
                if key in existing_pairs:
                    continue
                db.add(JobCriterionPin(
                    job_id=run.job_id, criterion=cr.criterion, run_id=run.id,
                ))
                existing_pairs.add(key)
                inserted += 1

        if inserted:
            db.commit()
            log.info(
                "expanded %s legacy pin(s) into job_criterion_pins", inserted,
            )
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_columns()
    _backfill_params_hash()
    _backfill_augmentation()
    _migrate_wayback_concurrency_default()
    _reconcile_stale_failed_statuses()
    _reconcile_orphaned_running_run_domains()
    _encrypt_legacy_secret_settings()
    _backfill_job_kind()
    _migrate_legacy_pins_to_criterion_pins()
    # Phase 2 — start capturing every error from any logger into error_log.
    # Idempotent so reload-on-edit dev scenarios don't double-attach.
    install_db_log_handler()
    db = SessionLocal()
    try:
        n = mark_orphaned_runs_paused(db)
        if n:
            import logging
            logging.getLogger(__name__).info(
                "auto-paused %s orphaned run(s) on startup; user can resume", n
            )
    finally:
        db.close()
    sched = get_scheduler()
    sched.start()
    # Daily auto-prune of dismissed errors past their retention window.
    # The same prune also runs opportunistically on every GET /errors call;
    # the scheduled job covers the case where the Errors page is never
    # opened. Idempotent — safe to run as often as needed.
    from .app_settings import get_error_retention_days
    from .routers.errors import prune_dismissed_errors

    def _scheduled_error_prune() -> None:
        days = get_error_retention_days()
        if days is None:
            return
        db = SessionLocal()
        try:
            prune_dismissed_errors(db, days)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("scheduled error prune failed")
        finally:
            db.close()

    sched.add_job(
        _scheduled_error_prune,
        "interval",
        hours=24,
        id="prune_dismissed_errors",
        replace_existing=True,
    )

    # Retention prune for `availability_checks` (added 2026-05-14). The
    # cascade writes 1+ row per check; without retention the table grows
    # forever and DB backups balloon. Two compounding caps configurable
    # via Settings → Domain Availability. The job runs once at boot
    # (catches up any drift from a long-stopped instance) and then on
    # the same 24h cadence as the error prune. Idempotent.
    from .app_settings import (
        get_availability_per_domain_keep,
        get_availability_retention_days,
    )
    from .availability.retention import prune_availability_checks

    def _scheduled_availability_prune() -> None:
        days = get_availability_retention_days()
        per_dom = get_availability_per_domain_keep()
        if days == 0 and per_dom == 0:
            return  # both caps disabled → no-op
        db = SessionLocal()
        try:
            result = prune_availability_checks(
                db, retention_days=days, per_domain_keep=per_dom,
            )
            if (
                result["deleted_by_age"] > 0
                or result["deleted_by_per_domain"] > 0
            ):
                # Single commit per run; the helper doesn't commit.
                db.commit()
            else:
                db.rollback()
        except Exception:
            db.rollback()
            import logging
            logging.getLogger(__name__).exception(
                "scheduled availability_checks prune failed"
            )
        finally:
            db.close()

    # One-shot at boot — covers the case where the container was down
    # past the daily cadence (e.g., a host reboot) or this is the first
    # boot after the retention feature shipped (catches up the historical
    # accumulation in one pass).
    try:
        _scheduled_availability_prune()
    except Exception:
        import logging
        logging.getLogger(__name__).exception(
            "boot availability_checks prune failed"
        )

    sched.add_job(
        _scheduled_availability_prune,
        "interval",
        hours=24,
        id="prune_availability_checks",
        replace_existing=True,
    )

    # Prompt audit: flag customized prompts that still reference Ahrefs
    # columns we've since dropped from AI_FIELD_TRIM. Non-fatal — emits
    # WARNING per stale reference for the operator to act on.
    try:
        from .prompt_audit import audit_customized_prompts
        audit_customized_prompts()
    except Exception:
        import logging
        logging.getLogger(__name__).exception("prompt audit failed")

    # SQLite backup with rotation. Off-switch via env so a Postgres
    # deployment (or a dev box) doesn't accumulate stale snapshots.
    from . import backups as _backups
    if _backups.BACKUP_ENABLED and _backups._resolve_db_path() is not None:
        sched.add_job(
            _backups.scheduled_backup,
            "interval",
            hours=_backups.BACKUP_INTERVAL_HOURS,
            id="db_backup",
            replace_existing=True,
        )

        # Monthly VACUUM (added 2026-05-14). Reclaims free pages that
        # the various delete paths leave behind. Runs at 03:30 UTC on
        # the 1st of each month — after midnight UTC so the nightly
        # backup (default 00:00 UTC on a 24h interval) has comfortably
        # finished, but still in the low-traffic window. Skips when:
        #   - the per-call Settings toggle says off, OR
        #   - filesystem free < 2x DB size (disk guard), OR
        #   - the maintenance lock is held by another job.
        # All gates are inside try_vacuum() so this wrapper just dispatches.
        from .app_settings import get_vacuum_enabled
        from .db_maintenance import try_vacuum

        def _scheduled_vacuum() -> None:
            if not get_vacuum_enabled():
                import logging
                logging.getLogger(__name__).info(
                    "monthly VACUUM skipped: disabled in Settings"
                )
                return
            try:
                try_vacuum()
            except Exception:
                import logging
                logging.getLogger(__name__).exception(
                    "scheduled VACUUM dispatcher failed"
                )

        sched.add_job(
            _scheduled_vacuum,
            "cron",
            day=1,
            hour=3,
            minute=30,
            id="db_vacuum",
            replace_existing=True,
        )

    try:
        yield
    finally:
        sched.shutdown(wait=False)


app = FastAPI(title="Drop Sherlock", lifespan=lifespan)

# Persist every uncaught request-handler exception to error_log before
# FastAPI's default 500 response goes out. Add BEFORE the CORS middleware
# so failures inside CORS pre-flight handling still get captured.
app.add_middleware(DbExceptionMiddleware)

# Same-origin via Caddy reverse proxy in prod. Origins are allowlisted
# from `CORS_ALLOW_ORIGINS` env var (comma-separated). Set to "*" in
# development only — leaving "*" in prod lets any LAN device's browser
# fetch responses on behalf of a logged-in user. `allow_credentials` is
# left at the default (False) so even a wildcard origin can't piggy-back
# on browser cookies.
from .config import settings as _cfg

_origins = [o.strip() for o in _cfg.cors_allow_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard.router)
app.include_router(analyze.router)
# job_io must register BEFORE jobs_router so `/jobs/import` (literal)
# doesn't get swallowed by the `/jobs/{job_id}` int-typed catch-all
# defined in jobs_router. Starlette tries routes in registration order
# and a failed int-parse on "import" would return 422 instead of
# falling through.
app.include_router(job_io_router.router)
app.include_router(jobs_router.router)
app.include_router(jobs_router.runs_router)
app.include_router(jobs_router.run_domains_router)
app.include_router(database_router.router)
app.include_router(settings_router.router)
app.include_router(errors_router.router)
app.include_router(backlog_router.router)
app.include_router(backups_router.router)
app.include_router(availability_router.router)
app.include_router(banlist_router.router)
app.include_router(shares_router.router)
# Public router — Caddy bypasses basic-auth for `/api/public/*`. The
# endpoints inside do their OWN access control via share tokens; no other
# auth layer is in front of them, so each handler MUST validate.
app.include_router(public_shares_router.router)


@app.get("/health")
async def health():
    """Async on purpose: a `def` handler would be dispatched to Starlette's
    thread pool, and a saturated thread pool (lots of slow sync GETs while
    a big run is in flight) starves the healthcheck. With `async def` the
    handler runs directly on the event loop and stays fast even under
    threadpool pressure. The healthcheck only matters when Docker's
    health probe can't reach a thread."""
    return {"ok": True}
