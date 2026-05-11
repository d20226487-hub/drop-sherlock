from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import Base, SessionLocal, engine
from .error_capture import DbExceptionMiddleware, install_db_log_handler
from .routers import (
    analyze,
    backlog as backlog_router,
    backups as backups_router,
    dashboard,
    database as database_router,
    errors as errors_router,
    jobs as jobs_router,
    settings as settings_router,
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_columns()
    _backfill_params_hash()
    _backfill_augmentation()
    _migrate_wayback_concurrency_default()
    _reconcile_stale_failed_statuses()
    _encrypt_legacy_secret_settings()
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
app.include_router(jobs_router.router)
app.include_router(jobs_router.runs_router)
app.include_router(jobs_router.run_domains_router)
app.include_router(database_router.router)
app.include_router(settings_router.router)
app.include_router(errors_router.router)
app.include_router(backlog_router.router)
app.include_router(backups_router.router)


@app.get("/health")
def health():
    return {"ok": True}
