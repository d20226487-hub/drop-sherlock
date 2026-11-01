"""Cleanup — Database ▸ Чистка (added 2026-11-01).

Centralized, previewed deletion for two categories. Both are defined by
what a row MUST have, so anything that doesn't qualify is untouched by
construction — notably every domain on the Database page, in Linked
Domains or in SERP Overview, and every Backlog domain that was uploaded
but never analyzed (it has no verdict and no missing parent, so it can't
qualify for either).

TAKEN DOMAINS. A domain qualifies only if ALL hold:
  - every check of it is from an Availability job (no Quality, Wayback,
    Whois, Batch, Linked Domains or SERP check);
  - every populated Availability verdict is registered — or, per opt-in,
    also not supported / unknown / error; none available, none malformed;
  - no note; no per-domain pin (a pinned Availability RUN does not
    protect: that pin is about the run, not the domain);
  - none of its runs is still in progress;
  - not expiring soon: the newest registered verdict's expiry and the Backlog
    row's expiration date are both later than today + N days (already
    expired counts as soon — those are the drop candidates).
Deleting one removes its Availability checks + results, its share links,
its availability history, and (default) its Backlog row; optionally adds
it to the ban list. Runs left empty are kept.

ORPHANS. Rows whose parent no longer exists AND that nothing reads:
share links to a missing check, results without a check, checks without
a run, runs without a job, pins to a missing run/job, sparkline results
without a job. Never: Linked Domains / SERP rows (their exports read them
by run_id), notes, empty runs.

Every run is refused while a Wayback / Availability check is running, then
works in a background thread: backup first (a failure stops it before any
row is deleted), then deletion in chunks, each its own short transaction.
Measured on a production-shaped DB (100k checked domains, 330k Backlog
rows): preview 1 s, backup 7 s, deleting 77,600 taken domains 4.6 s with the
longest chunk holding the write lock 90 ms, +45 MB memory, and no visible
effect on concurrent requests or the event loop."""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timedelta

from sqlalchemy import text

from .db import SessionLocal

log = logging.getLogger(__name__)

# Registered is always taken; these count only when the operator ticks them.
# `available` (or anything else) is never deletable.
OPTIONAL = ("not_supported", "unknown", "error")
_CHUNK = 500
_SAMPLE = 50

# ---- Taken domains -----------------------------------------------------------

# One row per domain whose checks are ALL Availability checks and whose
# populated verdicts are all registered or an opted-in status; the
# protections (note, pin, in progress, expiry) are reported as flags so the
# preview can count them.
_TAKEN_SQL = text("""
WITH checks AS (
  SELECT rd.domain AS domain,
         SUM(COALESCE(j.kind, 'quality') != 'availability') AS other_checks,
         SUM(COALESCE(rd.is_pinned, 0)) AS domain_pins,
         SUM(r.id IS NULL OR r.status NOT IN ('done', 'failed', 'canceled')) AS unfinished
  FROM run_domains rd
  LEFT JOIN runs r ON r.id = rd.run_id
  LEFT JOIN jobs j ON j.id = r.job_id
  GROUP BY rd.domain
),
raw AS (
  SELECT rd.domain AS domain,
         CASE WHEN json_valid(cr.data_json)
              THEN json_extract(cr.data_json, '$.verdict.status') END AS status,
         CASE WHEN json_valid(cr.data_json)
              THEN json_extract(cr.data_json, '$.verdict.expires_on') END AS expires_on,
         rd.finished_at AS finished_at, cr.id AS cr_id
  FROM criterion_results cr
  JOIN run_domains rd ON rd.id = cr.run_domain_id
  WHERE cr.criterion = 'availability' AND cr.data_json != ''
),
ranked AS (
  SELECT raw.*,
         ROW_NUMBER() OVER (PARTITION BY domain
                            ORDER BY finished_at DESC NULLS LAST, cr_id DESC) AS newest,
         ROW_NUMBER() OVER (PARTITION BY domain, (status = 'registered')
                            ORDER BY finished_at DESC NULLS LAST, cr_id DESC) AS newest_in_group
  FROM raw
),
summary AS (
  SELECT domain,
         SUM(status = 'registered') AS n_registered,
         SUM(status = 'not_supported') AS n_not_supported,
         SUM(status = 'unknown') AS n_unknown,
         SUM(status = 'error') AS n_error,
         SUM(status IS NULL
             OR status NOT IN ('registered', 'not_supported', 'unknown', 'error')) AS disqualifying,
         MAX(CASE WHEN newest = 1 THEN status END) AS latest_status,
         MAX(CASE WHEN newest_in_group = 1 AND status = 'registered'
                  THEN expires_on END) AS taken_expires_on
  FROM ranked GROUP BY domain
)
SELECT c.domain, s.latest_status, s.taken_expires_on, b.registrar, b.expiration_date,
       (n.domain IS NOT NULL) AS noted, (c.domain_pins > 0) AS pinned,
       (c.unfinished > 0) AS in_progress
FROM checks c
JOIN summary s ON s.domain = c.domain
LEFT JOIN backlog_domains b ON b.domain = c.domain
LEFT JOIN domain_notes n ON n.domain = c.domain AND n.note != ''
WHERE c.other_checks = 0
  AND s.disqualifying = 0
  AND (s.n_registered + s.n_not_supported + s.n_unknown + s.n_error) > 0
  AND (:not_supported = 1 OR s.n_not_supported = 0)
  AND (:unknown = 1 OR s.n_unknown = 0)
  AND (:error = 1 OR s.n_error = 0)
ORDER BY c.domain
""")


def _as_date(value) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def select_taken(db, *, include: tuple[str, ...] | list[str] = (),
                 protect_expiry_days: int) -> dict:
    """Run the selection. `include` names the OPTIONAL statuses that also
    count as taken. Returns `{"domains": [...rows to delete...],
    "kept": {reason: count}, "with_backlog_row": n}`; each domain row is
    `{domain, status, expires_on, source}`."""
    unknown_status = set(include) - set(OPTIONAL)
    if unknown_status:
        raise ValueError(f"not an optional status: {sorted(unknown_status)}")
    cutoff = (
        date.today() + timedelta(days=protect_expiry_days)
        if protect_expiry_days > 0 else None
    )
    kept = {"note": 0, "pinned": 0, "in_progress": 0, "expiring": 0}
    picked: list[dict] = []
    with_backlog = 0
    flags = {s: 1 if s in include else 0 for s in OPTIONAL}
    for row in db.execute(_TAKEN_SQL, flags):
        (domain, latest_status, taken_expires, registrar, backlog_exp,
         noted, pinned, in_progress) = row
        expires = _as_date(taken_expires)
        backlog_expires = _as_date(backlog_exp)
        expiring = cutoff is not None and any(
            d is not None and d <= cutoff for d in (expires, backlog_expires)
        )
        reasons = [name for name, hit in (
            ("note", noted), ("pinned", pinned),
            ("in_progress", in_progress), ("expiring", expiring),
        ) if hit]
        for name in reasons:
            kept[name] += 1
        if reasons:
            continue
        if registrar is not None:
            with_backlog += 1
        picked.append({
            "domain": domain,
            "status": latest_status or "",
            "expires_on": (expires or backlog_expires).isoformat()
            if (expires or backlog_expires) else None,
            "source": registrar or "",
        })
    return {"domains": picked, "kept": kept, "with_backlog_row": with_backlog}


def never_analyzed_count(db) -> int:
    """Backlog domains with no check at all — shown as 'not affected'."""
    return db.execute(text(
        "SELECT COUNT(*) FROM backlog_domains b WHERE NOT EXISTS "
        "(SELECT 1 FROM run_domains rd WHERE rd.domain = b.domain)"
    )).scalar() or 0


# ---- Orphans -------------------------------------------------------------------

# (key, count SQL, delete SQL). Each deletes only rows with a missing parent
# that nothing reads. Checks/runs that Linked Domains or SERP rows still
# point at are excluded, so those tables are never left with new orphans.
_ORPHANS: list[tuple[str, str, str]] = [
    ("share_links",
     "SELECT COUNT(*) FROM domain_shares s WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = s.run_domain_id)",
     "DELETE FROM domain_shares WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = domain_shares.run_domain_id)"),
    ("results_without_check",
     "SELECT COUNT(*) FROM criterion_results cr WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = cr.run_domain_id)",
     "DELETE FROM criterion_results WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = criterion_results.run_domain_id)"),
    ("checks_without_run",
     "SELECT COUNT(*) FROM run_domains rd WHERE NOT EXISTS "
     "(SELECT 1 FROM runs r WHERE r.id = rd.run_id) "
     "AND NOT EXISTS (SELECT 1 FROM linked_domain_rows l WHERE l.run_domain_id = rd.id) "
     "AND NOT EXISTS (SELECT 1 FROM serp_overview_rows s WHERE s.run_domain_id = rd.id)",
     None),   # deleted with their results — see _delete_checks_without_run
    ("runs_without_job",
     "SELECT COUNT(*) FROM runs r WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = r.job_id) "
     "AND NOT EXISTS (SELECT 1 FROM run_domains rd WHERE rd.run_id = r.id) "
     "AND NOT EXISTS (SELECT 1 FROM linked_domain_rows l WHERE l.run_id = r.id) "
     "AND NOT EXISTS (SELECT 1 FROM serp_overview_rows s WHERE s.run_id = r.id)",
     "DELETE FROM runs WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = runs.job_id) "
     "AND NOT EXISTS (SELECT 1 FROM run_domains rd WHERE rd.run_id = runs.id) "
     "AND NOT EXISTS (SELECT 1 FROM linked_domain_rows l WHERE l.run_id = runs.id) "
     "AND NOT EXISTS (SELECT 1 FROM serp_overview_rows s WHERE s.run_id = runs.id)"),
    ("pins_to_missing",
     "SELECT COUNT(*) FROM job_criterion_pins p WHERE "
     "NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = p.run_id) "
     "OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p.job_id)",
     "DELETE FROM job_criterion_pins WHERE "
     "NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = job_criterion_pins.run_id) "
     "OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_criterion_pins.job_id)"),
    ("sparkline_without_job",
     "SELECT COUNT(*) FROM wayback_sparkline_results w WHERE NOT EXISTS "
     "(SELECT 1 FROM wayback_sparkline_jobs j WHERE j.id = w.job_id)",
     "DELETE FROM wayback_sparkline_results WHERE NOT EXISTS "
     "(SELECT 1 FROM wayback_sparkline_jobs j WHERE j.id = wayback_sparkline_results.job_id)"),
]

# Shown for transparency, never deleted.
_EXCLUDED: list[tuple[str, str]] = [
    ("linked_rows",
     "SELECT COUNT(*) FROM linked_domain_rows l WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = l.run_domain_id)"),
    ("serp_rows",
     "SELECT COUNT(*) FROM serp_overview_rows s WHERE NOT EXISTS "
     "(SELECT 1 FROM run_domains rd WHERE rd.id = s.run_domain_id)"),
    ("notes",
     "SELECT COUNT(*) FROM domain_notes n WHERE n.note != '' "
     "AND NOT EXISTS (SELECT 1 FROM run_domains rd WHERE rd.domain = n.domain) "
     "AND NOT EXISTS (SELECT 1 FROM backlog_domains b WHERE b.domain = n.domain)"),
    ("empty_runs",
     "SELECT COUNT(*) FROM runs r WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id = r.job_id) "
     "AND NOT EXISTS (SELECT 1 FROM run_domains rd WHERE rd.run_id = r.id)"),
]


def orphan_counts(db) -> dict:
    return {
        "delete": {key: db.execute(text(count)).scalar() or 0 for key, count, _ in _ORPHANS},
        "kept": {key: db.execute(text(count)).scalar() or 0 for key, count in _EXCLUDED},
    }


def _delete_checks_without_run(db) -> int:
    ids = [i for (i,) in db.execute(text(
        "SELECT rd.id FROM run_domains rd WHERE NOT EXISTS "
        "(SELECT 1 FROM runs r WHERE r.id = rd.run_id) "
        "AND NOT EXISTS (SELECT 1 FROM linked_domain_rows l WHERE l.run_domain_id = rd.id) "
        "AND NOT EXISTS (SELECT 1 FROM serp_overview_rows s WHERE s.run_domain_id = rd.id)"
    ))]
    for i in range(0, len(ids), _CHUNK):
        chunk = ids[i:i + _CHUNK]
        params = {f"i{k}": v for k, v in enumerate(chunk)}
        holes = ", ".join(f":i{k}" for k in range(len(chunk)))
        db.execute(text(f"DELETE FROM domain_shares WHERE run_domain_id IN ({holes})"), params)
        db.execute(text(f"DELETE FROM criterion_results WHERE run_domain_id IN ({holes})"), params)
        db.execute(text(f"DELETE FROM run_domains WHERE id IN ({holes})"), params)
        db.commit()
    return len(ids)


# ---- Running a cleanup (one at a time, in a background thread) ---------------

_lock = threading.Lock()
_state: dict = {"running": False, "kind": None, "phase": None, "done": 0,
                "total": 0, "result": None, "error": None}


def status() -> dict:
    with _lock:
        return dict(_state)


class CleanupRefused(Exception):
    """A cleanup can't start (running checks, another cleanup, stale preview,
    or the backup failed). The message is shown to the user."""


def _checks_running() -> list[dict]:
    from .routers.database import active_heavy_checks
    return active_heavy_checks()


def _claim(kind: str, total: int) -> None:
    with _lock:
        if _state["running"]:
            raise CleanupRefused("another cleanup is already running")
        _state.update(running=True, kind=kind, phase="backup", done=0,
                      total=total, result=None, error=None)


def _set_phase(phase: str) -> None:
    with _lock:
        _state["phase"] = phase


def _progress(done: int) -> None:
    with _lock:
        _state["done"] = done


def _finish(result: dict | None, error: str | None) -> None:
    with _lock:
        _state.update(running=False, phase=None, result=result, error=error)


def _backup() -> str:
    from . import backups
    try:
        snap = backups.run_backup()
    except Exception as e:  # noqa: BLE001
        raise CleanupRefused(f"backup failed, nothing deleted: {e}") from e
    return str(snap.get("filename") or snap.get("name") or "")


def _after_delete() -> None:
    """Refresh what caches the deleted rows: the Database snapshot and the
    Backlog's count cache."""
    from .routers import backlog as backlog_router
    from .routers.database import _invalidate_rows_cache
    with backlog_router._count_cache_lock:
        backlog_router._count_cache.clear()
    _invalidate_rows_cache()


def _audit(message: str, context: dict) -> None:
    """One row on the Errors page (level info) — the cleanup's record."""
    from .error_capture import _persist
    _persist(source="cleanup", level="info", message=message, traceback="",
             context=context)


def start_taken_cleanup(*, include: tuple[str, ...] | list[str] = (),
                        protect_expiry_days: int, delete_backlog: bool, ban: bool,
                        expected_count: int) -> dict:
    """Validate, back up, then delete in a background thread. Raises
    CleanupRefused when it can't start."""
    running = _checks_running()
    if running:
        raise CleanupRefused("a Wayback / Availability check is running; try again when it finishes")
    db = SessionLocal()
    try:
        picked = select_taken(db, include=include,
                              protect_expiry_days=protect_expiry_days)["domains"]
    finally:
        db.close()
    domains = [p["domain"] for p in picked]
    if len(domains) != expected_count:
        raise CleanupRefused(
            f"the selection changed since the preview ({expected_count} -> "
            f"{len(domains)}); refresh the preview and confirm again")
    if not domains:
        raise CleanupRefused("nothing to delete")
    _claim("taken", len(domains))
    options = {"include": sorted(include), "protect_expiry_days": protect_expiry_days,
               "delete_backlog": delete_backlog, "ban": ban}

    def work() -> None:
        # The backup runs here, not in the request: on a large DB it takes
        # long enough to stall the request behind the proxy. A failed backup
        # still stops everything before a single row is deleted.
        try:
            backup = _backup()
        except CleanupRefused as e:
            _finish(None, str(e))
            return
        _set_phase("deleting")
        try:
            result = _delete_taken(domains, delete_backlog=delete_backlog, ban=ban)
            result.update(backup=backup, options=options)
            _after_delete()
            _audit(f"Cleanup: deleted {result['domains']} taken domains "
                   f"({result['checks']} checks, {result['history_rows']} history rows, "
                   f"{result['backlog_rows']} Backlog rows, {result['banned']} banned). "
                   f"Backup: {backup}", result)
            _finish(result, None)
        except Exception as e:  # noqa: BLE001
            log.exception("taken-domain cleanup failed")
            _finish(None, f"{type(e).__name__}: {e} (backup: {backup})")

    threading.Thread(target=work, name="cleanup-taken", daemon=True).start()
    return {"started": True, "total": len(domains)}


def _delete_taken(domains: list[str], *, delete_backlog: bool, ban: bool) -> dict:
    from .models import DomainBan
    from .routers.banlist import _snapshot_and_delete_backlog
    totals = {"domains": 0, "checks": 0, "history_rows": 0, "backlog_rows": 0,
              "banned": 0, "share_links": 0}
    stamp = date.today().isoformat()
    db = SessionLocal()
    try:
        for i in range(0, len(domains), _CHUNK):
            chunk = domains[i:i + _CHUNK]
            dp = {f"d{k}": v for k, v in enumerate(chunk)}
            dh = ", ".join(f":d{k}" for k in range(len(chunk)))
            rd_ids = [r for (r,) in db.execute(
                text(f"SELECT id FROM run_domains WHERE domain IN ({dh})"), dp)]
            if rd_ids:
                rp = {f"r{k}": v for k, v in enumerate(rd_ids)}
                rh = ", ".join(f":r{k}" for k in range(len(rd_ids)))
                totals["share_links"] += db.execute(
                    text(f"DELETE FROM domain_shares WHERE run_domain_id IN ({rh})"), rp).rowcount
                db.execute(text(f"DELETE FROM criterion_results WHERE run_domain_id IN ({rh})"), rp)
                totals["checks"] += db.execute(
                    text(f"DELETE FROM run_domains WHERE id IN ({rh})"), rp).rowcount
            totals["history_rows"] += db.execute(
                text(f"DELETE FROM availability_checks WHERE domain IN ({dh})"), dp).rowcount
            if ban:
                # Same as banning from the Ban List: the Backlog row is
                # snapshotted onto the ban and removed, so an unban restores
                # it. Already-banned domains keep their existing ban.
                already = {d for (d,) in db.execute(
                    text(f"SELECT domain FROM domain_bans WHERE domain IN ({dh})"), dp)}
                new_bans = {
                    d: DomainBan(domain=d, note=f"Cleanup: taken ({stamp})",
                                 created_at=datetime.utcnow())
                    for d in chunk if d not in already
                }
                db.add_all(new_bans.values())
                totals["backlog_rows"] += _snapshot_and_delete_backlog(db, new_bans)
                totals["banned"] += len(new_bans)
                db.flush()  # before the raw DELETE below touches the same rows
            if delete_backlog:
                totals["backlog_rows"] += db.execute(
                    text(f"DELETE FROM backlog_domains WHERE domain IN ({dh})"), dp).rowcount
            db.commit()
            totals["domains"] += len(chunk)
            _progress(totals["domains"])
            time.sleep(0)  # let other threads in between chunks
    finally:
        db.close()
    return totals


def start_orphan_cleanup(*, expected_count: int) -> dict:
    running = _checks_running()
    if running:
        raise CleanupRefused("a Wayback / Availability check is running; try again when it finishes")
    db = SessionLocal()
    try:
        counts = orphan_counts(db)["delete"]
    finally:
        db.close()
    total = sum(counts.values())
    if total != expected_count:
        raise CleanupRefused(
            f"the orphan count changed since the preview ({expected_count} -> {total}); "
            "refresh the preview and confirm again")
    if not total:
        raise CleanupRefused("nothing to delete")
    _claim("orphans", total)

    def work() -> None:
        try:
            backup = _backup()
        except CleanupRefused as e:
            _finish(None, str(e))
            return
        _set_phase("deleting")
        db2 = SessionLocal()
        try:
            deleted: dict[str, int] = {}
            done = 0
            for key, _count, delete_sql in _ORPHANS:
                if key == "checks_without_run":
                    n = _delete_checks_without_run(db2)
                else:
                    n = db2.execute(text(delete_sql)).rowcount
                    db2.commit()
                deleted[key] = n
                done += n
                _progress(done)
            result = {"deleted": deleted, "backup": backup}
            _after_delete()
            _audit(f"Cleanup: deleted {done} orphan rows {deleted}. Backup: {backup}", result)
            _finish(result, None)
        except Exception as e:  # noqa: BLE001
            log.exception("orphan cleanup failed")
            _finish(None, f"{type(e).__name__}: {e} (backup: {backup})")
        finally:
            db2.close()

    threading.Thread(target=work, name="cleanup-orphans", daemon=True).start()
    return {"started": True, "total": total}
