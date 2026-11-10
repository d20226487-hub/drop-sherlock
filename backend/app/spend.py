"""Spend log — app-wide cost tracking for paid APIs (added 2026-11-09).

Every billed call is appended to `usage_events` (see models.UsageEvent):
AI calls from `ai_judge.judge()` (all providers: Google AI Studio, Vertex
AI, OpenRouter, GitHub Models), Ahrefs requests from the two Ahrefs
clients, WhoisFreaks Whois History fetches, and the metered Availability
lookups (Domainr, live WhoisFreaks).

Recording never touches the database on the caller's thread: `record_*`
appends to an in-memory buffer and a daemon thread writes the buffer in
one short transaction every couple of seconds. The event loop never waits
on SQLite's write lock for this, and a buffered event lost to a crash
costs a few seconds of spend history, nothing else.

Context (which feature, run, domain) comes from `tag(...)`, a context
manager over a ContextVar: the call sites that know the run wrap their
work in it, and the provider-level recorders read it. ContextVars follow
asyncio tasks and `asyncio.to_thread`, so a tag set around an `await`
reaches the recorder inside it.

Pricing:
  - AI: the model_pricing table ($ per 1M tokens). A call's cost is taken
    from the price in force when it is written; a 0/0 price counts as
    "not set" and the row keeps cost NULL. The summary then estimates it
    at the CURRENT price (if one exists by then) and says how much of the
    total is estimated.
  - Ahrefs: a monthly allowance of units, then $ per 1M units above it.
    Dollars only make sense per month, so they are computed per calendar
    month from the units.
  - WhoisFreaks ($ per credit; Whois History uses `units_per_request`
    credits per request, a live Availability lookup one credit) and Domainr
    ($ per lookup), priced at read time.
"""
from __future__ import annotations

import contextvars
import functools
import inspect
import json
import logging
import re
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from urllib.parse import urlparse

from sqlalchemy import insert, text

from .db import SessionLocal

log = logging.getLogger(__name__)

# ---- Context -------------------------------------------------------------------

_TAG: contextvars.ContextVar[dict] = contextvars.ContextVar("spend_tag", default={})


@contextmanager
def tag(**fields):
    """Attach context (feature, run_id, run_domain_id, domain) to every
    event recorded inside the block. Nested tags merge; None is ignored."""
    merged = {**_TAG.get(), **{k: v for k, v in fields.items() if v is not None}}
    token = _TAG.set(merged)
    try:
        yield
    finally:
        _TAG.reset(token)


def tagged(*, feature: str | None = None, feature_from: str | None = None):
    """Decorator for an async function: tag its events with the call's own
    `run_id`, `run_domain_id` (or `rd_id`) and `domain` arguments, plus a
    fixed `feature` or the value of the argument named `feature_from`."""
    def deco(fn):
        sig = inspect.signature(fn)

        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                a = sig.bind_partial(*args, **kwargs).arguments
            except TypeError:
                a = {}
            with tag(run_id=a.get("run_id"),
                     run_domain_id=a.get("run_domain_id", a.get("rd_id")),
                     domain=a.get("domain"),
                     feature=a.get(feature_from) if feature_from else feature):
                return await fn(*args, **kwargs)
        return wrapper
    return deco


# ---- Recording -----------------------------------------------------------------

_buf: list[dict] = []
_lock = threading.Lock()
_wake = threading.Event()
_stop = threading.Event()
_thread: threading.Thread | None = None
_FLUSH_EVERY_SEC = 2.0
_FLUSH_AT = 500          # wake the writer early on a burst
_MAX_BUFFERED = 200_000  # if the writer is stuck, stop growing memory

# Kinds whose events carry nothing per-domain worth a row each; identical
# ones in a flush are merged into one row with `calls` = N.
_MERGE_KINDS = {"availability"}


def _push(event: dict) -> None:
    try:
        ctx = _TAG.get()
        row = {
            "created_at": datetime.utcnow(),
            "feature": str(ctx.get("feature") or "")[:48],
            "run_id": ctx.get("run_id"),
            "run_domain_id": ctx.get("run_domain_id"),
            "domain": str(ctx.get("domain") or "")[:255],
            **event,
        }
        with _lock:
            if len(_buf) >= _MAX_BUFFERED:
                return
            _buf.append(row)
            if len(_buf) >= _FLUSH_AT:
                _wake.set()
    except Exception:  # noqa: BLE001 — accounting must never break a call
        log.exception("spend: could not record an event")


def record_ai(provider: str, model: str, usage: dict | None, *, ok: bool = True) -> None:
    """One AI call. `usage` is the dict `ai_judge` builds from the provider
    response: input_tokens, output_tokens (incl. thinking), thinking_tokens."""
    u = usage or {}
    _push({
        "kind": "ai", "provider": provider or "", "model": (model or "")[:128],
        "input_tokens": int(u.get("input_tokens") or 0),
        "output_tokens": int(u.get("output_tokens") or 0),
        "thinking_tokens": int(u.get("thinking_tokens") or 0),
        "ok": ok,
    })


def _ahrefs_endpoint(url: str) -> str:
    path = urlparse(url).path if "://" in url else url
    if path.startswith("/v3/"):
        path = path[4:]
    return path.strip("/")[:128]


def record_ahrefs(url: str, *, billed: int | None, listed: int | None = None) -> None:
    """One Ahrefs request. `billed` is x-api-units-cost-total-actual (what
    Ahrefs charged), falling back to the list price when absent."""
    units = billed if billed is not None else listed
    if not units and not listed:
        return
    _push({
        "kind": "ahrefs", "provider": "ahrefs", "model": _ahrefs_endpoint(url),
        "units": int(units or 0), "units_list": int(listed or 0),
    })


def record_units(kind: str, provider: str, units: int = 1) -> None:
    """A metered non-AI call: a Whois History fetch (credits) or a paid
    Availability lookup."""
    _push({"kind": kind, "provider": provider, "units": int(units)})


# ---- Writer --------------------------------------------------------------------

def _price_set(price: tuple[float, float] | None) -> bool:
    return price is not None and (price[0] > 0 or price[1] > 0)


def _ai_cost(price: tuple[float, float] | None, tokens_in: int, tokens_out: int) -> float | None:
    if not _price_set(price):
        return None
    return round((tokens_in * price[0] + tokens_out * price[1]) / 1_000_000.0, 8)


def _merge(batch: list[dict]) -> list[dict]:
    out: list[dict] = []
    merged: dict[tuple, dict] = {}
    for r in batch:
        if r["kind"] not in _MERGE_KINDS:
            out.append(r)
            continue
        key = (r["kind"], r["provider"], r["feature"], r["run_id"])
        m = merged.get(key)
        if m is None:
            merged[key] = {**r, "calls": 1, "run_domain_id": None, "domain": ""}
        else:
            m["calls"] += 1
            m["units"] += r.get("units", 0)
    return out + list(merged.values())


_COLUMNS = ("created_at", "kind", "provider", "model", "feature", "calls",
            "input_tokens", "output_tokens", "thinking_tokens", "units",
            "units_list", "cost_usd", "ok", "job_id", "run_id",
            "run_domain_id", "domain", "source", "project_id")
_DEFAULTS = {"model": "", "calls": 1, "input_tokens": 0, "output_tokens": 0,
             "thinking_tokens": 0, "units": 0, "units_list": 0, "cost_usd": None,
             "ok": True, "job_id": None, "source": "live", "project_id": None}


def _lookup(db, sql: str, ids: set) -> dict:
    out: dict = {}
    ids_sorted = sorted(ids)
    for i in range(0, len(ids_sorted), 500):
        part = ids_sorted[i:i + 500]
        holes = ", ".join(f":i{k}" for k in range(len(part)))
        out.update(db.execute(text(sql.format(holes)),
                              {f"i{k}": v for k, v in enumerate(part)}).all())
    return out


def _write(batch: list[dict]) -> None:
    from .models import UsageEvent
    db = SessionLocal()
    try:
        prices = {
            (p, m): (float(i or 0), float(o or 0))
            for p, m, i, o in db.execute(text(
                "SELECT provider, model, input_per_million, output_per_million "
                "FROM model_pricing"))
        }
        # Fill what the tag didn't carry: a re-analysis only knows the
        # run-domain, and nothing carries the job.
        rd_runs = _lookup(db, "SELECT id, run_id FROM run_domains WHERE id IN ({})",
                          {r["run_domain_id"] for r in batch
                           if r.get("run_domain_id") and not r.get("run_id")})
        for r in batch:
            if not r.get("run_id") and r.get("run_domain_id"):
                r["run_id"] = rd_runs.get(r["run_domain_id"])
        jobs = _lookup(db, "SELECT id, job_id FROM runs WHERE id IN ({})",
                       {r["run_id"] for r in batch if r.get("run_id")})
        projects = _lookup(db, "SELECT id, project_id FROM jobs WHERE id IN ({})",
                           {j for j in jobs.values() if j})
        rows = []
        for r in _merge(batch):
            row = {c: r.get(c, _DEFAULTS.get(c)) for c in _COLUMNS}
            row["job_id"] = jobs.get(r.get("run_id"))
            row["project_id"] = projects.get(row["job_id"])
            if row["kind"] == "ai":
                row["cost_usd"] = _ai_cost(prices.get((row["provider"], row["model"])),
                                           row["input_tokens"], row["output_tokens"])
            rows.append(row)
        db.execute(insert(UsageEvent), rows)
        db.commit()
    finally:
        db.close()


def flush() -> int:
    """Write everything buffered so far. Returns the number of events."""
    with _lock:
        batch = _buf[:]
        _buf.clear()
    if not batch:
        return 0
    try:
        _write(batch)
    except Exception:  # noqa: BLE001
        log.exception("spend: writing %d event(s) failed; keeping them for the next try",
                      len(batch))
        with _lock:
            if len(_buf) + len(batch) <= _MAX_BUFFERED:
                _buf[:0] = batch
        return 0
    return len(batch)


def _loop() -> None:
    while not _stop.is_set():
        _wake.wait(_FLUSH_EVERY_SEC)
        _wake.clear()
        flush()
    flush()


def start() -> None:
    """Start the writer thread (app startup) and, once, import past jobs."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    cutoff = datetime.utcnow()
    _thread = threading.Thread(target=_loop, name="spend-writer", daemon=True)
    _thread.start()
    threading.Thread(target=_backfill_safely, args=(cutoff, _BACKFILL_DELAY_SEC),
                     name="spend-backfill", daemon=True).start()


def stop() -> None:
    _stop.set()
    _wake.set()
    if _thread is not None:
        _thread.join(timeout=10)


def _reset_for_tests() -> None:
    with _lock:
        _buf.clear()
    _groups.update(max_id=0, by_key={})
    _sources_cache.clear()


# ---- Prices for the non-AI providers -------------------------------------------

_PRICING_KEY = "spend_pricing"
DEFAULT_PRICING = {
    # The operator's Ahrefs plan (2026-11-09): 4M units a month included,
    # then $50 per 1M units.
    "ahrefs_included_units": 4_000_000,
    "ahrefs_usd_per_million": 50.0,
    # 0 = not set: the panel shows credits / lookups without dollars.
    "whoisfreaks_usd_per_credit": 0.0,
    "domainr_usd_per_request": 0.0,
}


def get_pricing() -> dict:
    from .app_settings import _get
    db = SessionLocal()
    try:
        raw = _get(db, _PRICING_KEY) or ""
    finally:
        db.close()
    out = dict(DEFAULT_PRICING)
    try:
        saved = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        saved = {}
    if isinstance(saved, dict):
        for k, default in DEFAULT_PRICING.items():
            v = saved.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                out[k] = type(default)(v)
    return out


def set_pricing(cfg: dict) -> dict:
    from .app_settings import _set
    current = get_pricing()
    for k, v in (cfg or {}).items():
        if k not in DEFAULT_PRICING:
            raise ValueError(f"unknown price field: {k}")
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
            raise ValueError(f"{k} must be a non-negative number")
        current[k] = type(DEFAULT_PRICING[k])(v)
    db = SessionLocal()
    try:
        _set(db, _PRICING_KEY, json.dumps(current))
        db.commit()
    finally:
        db.close()
    return current


def ahrefs_overage_usd(units: int, pricing: dict) -> float:
    over = max(0, units - int(pricing["ahrefs_included_units"]))
    return over / 1_000_000.0 * float(pricing["ahrefs_usd_per_million"])


# ---- One-time import of past jobs -----------------------------------------------

_BACKFILL_KEY = "spend_backfill_v1"

# Each SELECT reads the per-check columns that existed before this log, in
# _COLUMNS order.
# Only fresh calls (cache copies cost nothing), only rows older than the
# moment this process started (anything later is recorded live). AI costs
# recorded at the time are kept; $0 ones become NULL, i.e. "estimate at the
# current price".
_BACKFILL_SQL = {
    "ai_checks": """
SELECT COALESCE(rd.last_analyzed_at, cr.fetched_at, rd.finished_at, r.finished_at,
                r.started_at),
       'ai', cr.ai_provider, COALESCE(cr.ai_model, ''), cr.criterion, 1,
       COALESCE(cr.ai_input_tokens, 0), COALESCE(cr.ai_output_tokens, 0), 0, 0, 0,
       CASE WHEN cr.ai_cost_usd > 0 THEN cr.ai_cost_usd END, 1,
       r.job_id, rd.run_id, rd.id, rd.domain, 'backfill', j.project_id
FROM criterion_results cr
JOIN run_domains rd ON rd.id = cr.run_domain_id
LEFT JOIN runs r ON r.id = rd.run_id
LEFT JOIN jobs j ON j.id = r.job_id
WHERE cr.ai_provider != '' AND cr.ai_cached_from_run_id IS NULL
  AND (COALESCE(cr.ai_input_tokens, 0) > 0 OR COALESCE(cr.ai_output_tokens, 0) > 0)
  AND COALESCE(rd.last_analyzed_at, cr.fetched_at, rd.finished_at, r.finished_at,
               r.started_at) < :cutoff
""",
    "ai_final": """
SELECT ts, 'ai', prov, mdl, 'final', 1,
       COALESCE(final_input_tokens, 0), COALESCE(final_output_tokens, 0), 0, 0, 0,
       CASE WHEN final_cost_usd > 0 THEN final_cost_usd END, 1,
       job_id, run_id, id, domain, 'backfill', proj
FROM (SELECT rd.*, r.job_id AS job_id, j.project_id AS proj,
             COALESCE(rd.last_analyzed_at, rd.finished_at, r.finished_at, r.started_at) AS ts,
             -- The final call used the run's AI: take it from a judged
             -- criterion of the same domain, else from the run's spec (a
             -- domain whose criteria were all cache copies has neither on
             -- its rows), else "" (an unpriced call, not a failed import).
             COALESCE((SELECT c.ai_provider FROM criterion_results c
                       WHERE c.run_domain_id = rd.id AND c.ai_provider != '' LIMIT 1),
                      CASE WHEN json_valid(r.spec_json)
                           THEN json_extract(r.spec_json, '$.ai.provider') END, '') AS prov,
             COALESCE((SELECT c.ai_model FROM criterion_results c
                       WHERE c.run_domain_id = rd.id AND c.ai_provider != '' LIMIT 1),
                      CASE WHEN json_valid(r.spec_json)
                           THEN json_extract(r.spec_json, '$.ai.model') END, '') AS mdl
      FROM run_domains rd LEFT JOIN runs r ON r.id = rd.run_id
      LEFT JOIN jobs j ON j.id = r.job_id
      WHERE COALESCE(rd.final_input_tokens, 0) > 0 OR COALESCE(rd.final_output_tokens, 0) > 0)
WHERE ts IS NOT NULL AND ts < :cutoff
""",
    "ahrefs": """
SELECT cr.fetched_at, 'ahrefs', 'ahrefs', '', cr.criterion, 1, 0, 0, 0,
       COALESCE(cr.units_cost_actual, cr.units_cost_total, 0),
       COALESCE(cr.units_cost_total, 0), NULL, 1,
       r.job_id, rd.run_id, rd.id, rd.domain, 'backfill', j.project_id
FROM criterion_results cr
JOIN run_domains rd ON rd.id = cr.run_domain_id
LEFT JOIN runs r ON r.id = rd.run_id
LEFT JOIN jobs j ON j.id = r.job_id
WHERE cr.cached_from_run_id IS NULL
  AND COALESCE(cr.units_cost_actual, cr.units_cost_total, 0) > 0
  AND cr.fetched_at IS NOT NULL AND cr.fetched_at < :cutoff
""",
    "whois_history": """
SELECT cr.fetched_at, 'whois_history', 'whoisfreaks', '', 'whois_history', 1, 0, 0, 0,
       :credits, 0, NULL, 1, r.job_id, rd.run_id, rd.id, rd.domain, 'backfill',
       j.project_id
FROM criterion_results cr
JOIN run_domains rd ON rd.id = cr.run_domain_id
LEFT JOIN runs r ON r.id = rd.run_id
LEFT JOIN jobs j ON j.id = r.job_id
WHERE cr.criterion = 'whois_history' AND cr.status = 'done'
  AND cr.cached_from_run_id IS NULL
  AND cr.fetched_at IS NOT NULL AND cr.fetched_at < :cutoff
""",
    "availability": """
SELECT MIN(a.checked_at), 'availability', a.provider, '', 'availability', COUNT(*),
       0, 0, 0, COUNT(*), 0, NULL, 1, r.job_id, a.run_id, NULL, '', 'backfill',
       MAX(j.project_id)
FROM availability_checks a
LEFT JOIN runs r ON r.id = a.run_id
LEFT JOIN jobs j ON j.id = r.job_id
WHERE a.provider IN ('domainr', 'whoisfreaks') AND a.status != 'error'
  AND a.checked_at < :cutoff
GROUP BY a.provider, a.run_id, date(a.checked_at)
""",
}


_BACKFILL_BATCH = 2000


def _copy_rows(select_sql: str, params: dict, write_db) -> int:
    """Run one import SELECT on its own read connection and insert what it
    returns in small batches, each its own short transaction. The scan of
    the check tables (slow on a large DB, and very slow on Docker's Windows
    bind mount) then never holds SQLite's write lock: a single INSERT ...
    SELECT did, and stalled the loop's own startup writes behind it."""
    # Plain INSERT: the SELECT hands back timestamps as the stored text, which
    # goes in unchanged (the ORM DateTime type would insist on datetimes).
    ins = text(f"INSERT INTO usage_events ({', '.join(_COLUMNS)}) "
               f"VALUES ({', '.join(':' + c for c in _COLUMNS)})")
    read_db = SessionLocal()
    n = 0
    try:
        result = read_db.execute(text(select_sql), params)
        while True:
            chunk = result.fetchmany(_BACKFILL_BATCH)
            if not chunk:
                break
            write_db.execute(ins, [dict(zip(_COLUMNS, r)) for r in chunk])
            write_db.commit()
            n += len(chunk)
    finally:
        read_db.close()
    return n


def backfill(cutoff: datetime) -> dict | None:
    """Import spend recorded on past checks, once. Returns the counts, or
    None when it already ran."""
    from .app_settings import _get, _set, get_whois_history_units_per_request
    db = SessionLocal()
    try:
        state = _parse(_get(db, _BACKFILL_KEY))
        if state.get("done", "done_at" in state):
            return None
        # The cutoff is the FIRST start's: calls after it are logged live,
        # so an import redone on a later start must not count them again.
        if "cutoff" in state:
            cutoff = datetime.fromisoformat(state["cutoff"])
        else:
            _set(db, _BACKFILL_KEY, json.dumps({"cutoff": cutoff.isoformat(), "done": False}))
            db.commit()
        # An import cut short is redone from scratch on the next start.
        db.execute(text("DELETE FROM usage_events WHERE source = 'backfill'"))
        db.commit()
        counts: dict[str, int] = {}
        # Bound as text in the format SQLAlchemy stores DateTime in SQLite,
        # so the comparison is a plain string compare like the columns'.
        params = {"cutoff": cutoff.strftime("%Y-%m-%d %H:%M:%S.%f"),
                  "credits": get_whois_history_units_per_request()}
        for name, sql in _BACKFILL_SQL.items():
            counts[name] = _copy_rows(sql, params, db)
        _set(db, _BACKFILL_KEY, json.dumps({"cutoff": cutoff.isoformat(), "done": True,
                                            "done_at": cutoff.isoformat(), **counts}))
        db.commit()
        _groups.update(max_id=0, by_key={})   # the import added old-dated rows
        return counts
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# Let startup's own database work (migrations, the availability prune, the
# Database snapshot) finish before the import reads the check tables.
_BACKFILL_DELAY_SEC = 60.0


def _backfill_safely(cutoff: datetime, delay: float = 0.0) -> None:
    if delay and _stop.wait(delay):
        return
    try:
        counts = backfill(cutoff)
        if counts is not None:
            log.info("spend: imported past jobs into the spend log: %s", counts)
    except Exception:  # noqa: BLE001
        log.exception("spend: importing past jobs failed (will retry next start)")
    try:
        # Build the per-day totals now, so the first Dashboard visit after
        # a restart doesn't pay the one full scan (~2 s at 900k events).
        _daily_groups()
    except Exception:  # noqa: BLE001
        log.exception("spend: warming the summary failed")


def _parse(raw: str | None) -> dict:
    try:
        out = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}
    return out if isinstance(out, dict) else {}


def backfill_info() -> dict | None:
    """The finished import's cutoff and counts, or None until it is done."""
    from .app_settings import _get
    db = SessionLocal()
    try:
        state = _parse(_get(db, _BACKFILL_KEY))
    finally:
        db.close()
    return state if state.get("done", "done_at" in state) else None


# ---- Summary for the Dashboard -----------------------------------------------------

PERIODS = ("this_month", "last_month", "last_7_days", "today", "all_time")
_KIND_ORDER = {"ai": 0, "ahrefs": 1, "whois_history": 2, "availability": 3}
_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")   # a specific month, "2026-10"


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _period_bounds(period: str, today: date) -> tuple[date | None, date | None]:
    """[start, end) as UTC dates; None = unbounded."""
    if period == "this_month":
        return _month_start(today), None
    if period == "last_month":
        end = _month_start(today)
        return _month_start(end - timedelta(days=1)), end
    if period == "last_7_days":
        return today - timedelta(days=6), None
    if period == "today":
        return today, None
    if _MONTH_RE.match(period):
        start = date.fromisoformat(period + "-01")
        return start, (start + timedelta(days=32)).replace(day=1)
    return None, None


_GROUP_KEYS = ("day", "kind", "provider", "model", "feature", "job_id", "project_id")
_SUM_KEYS = ("calls", "input_tokens", "output_tokens", "thinking_tokens", "units",
             "units_list", "cost_known", "unpriced_calls", "unpriced_in", "unpriced_out",
             "failed", "backfill_calls")
# The log is append-only, so its per-day totals are kept here and each read
# folds in only the rows added since (by id). A full GROUP BY over a year
# of heavy use (~600k events) takes ~1.5 s; the delta takes milliseconds.
_groups: dict = {"max_id": 0, "by_key": {}}
_groups_lock = threading.Lock()


def _daily_groups() -> list[dict]:
    """Every event folded per (day, kind, provider, model, feature, job).
    Small even for a large log (a job spans a few days and features), so
    every view below is computed from it in Python."""
    with _groups_lock:
        db = SessionLocal()
        try:
            newest = db.execute(text("SELECT COALESCE(MAX(id), 0) FROM usage_events")).scalar()
            if newest < _groups["max_id"]:      # the log shrank: DB restored
                _groups.update(max_id=0, by_key={})
            rows = db.execute(text("""
                SELECT date(created_at) AS day, kind, provider, model, feature, job_id,
                       project_id, SUM(calls), SUM(input_tokens), SUM(output_tokens),
                       SUM(thinking_tokens), SUM(units), SUM(units_list),
                       SUM(COALESCE(cost_usd, 0)),
                       SUM(CASE WHEN kind = 'ai' AND cost_usd IS NULL THEN calls ELSE 0 END),
                       SUM(CASE WHEN kind = 'ai' AND cost_usd IS NULL THEN input_tokens ELSE 0 END),
                       SUM(CASE WHEN kind = 'ai' AND cost_usd IS NULL THEN output_tokens ELSE 0 END),
                       SUM(CASE WHEN ok THEN 0 ELSE calls END),
                       SUM(CASE WHEN source = 'backfill' THEN calls ELSE 0 END)
                FROM usage_events
                WHERE id > :after AND id <= :upto
                GROUP BY day, kind, provider, model, feature, job_id, project_id
            """), {"after": _groups["max_id"], "upto": newest}).all()
        finally:
            db.close()
        by_key = _groups["by_key"]
        for r in rows:
            key, sums = tuple(r[:7]), list(r[7:])
            have = by_key.get(key)
            by_key[key] = sums if have is None else [a + (b or 0) for a, b in zip(have, sums)]
        _groups["max_id"] = newest
        return [dict(zip(_GROUP_KEYS, k), **dict(zip(_SUM_KEYS, v)))
                for k, v in by_key.items()]


def _current_ai_prices() -> dict[tuple[str, str], tuple[float, float]]:
    db = SessionLocal()
    try:
        return {
            (p, m): (float(i or 0), float(o or 0))
            for p, m, i, o in db.execute(text(
                "SELECT provider, model, input_per_million, output_per_million "
                "FROM model_pricing"))
        }
    finally:
        db.close()


def summary(period: str = "this_month", *, today: date | None = None) -> dict:
    if period not in PERIODS and not _MONTH_RE.match(period):
        raise ValueError(f"unknown period: {period}")
    today = today or datetime.utcnow().date()
    result = _summarize(_daily_groups(), _current_ai_prices(), get_pricing(),
                        period, today)
    result["backfill"] = backfill_info()
    _name_jobs(result["jobs"])
    result["projects"] = _by_project(result["jobs"])
    return result


# A job's Sources (Источник: the Backlog source label, BacklogDomain.registrar,
# of its domains). Read live, so a "move to source" shows here too, but
# cached per job: the lookup walks every run-domain of the jobs (~0.8 s for
# 113k at server scale).
_sources_cache: dict[int, tuple[float, list[dict]]] = {}
_SOURCES_TTL_SEC = 600.0


def _job_sources(db, job_ids: list[int]) -> dict[int, list[dict]]:
    """job_id → [{source, domains}], the biggest source first."""
    now = time.monotonic()
    out = {j: hit[1] for j in job_ids
           if (hit := _sources_cache.get(j)) and now - hit[0] < _SOURCES_TTL_SEC}
    missing = [j for j in job_ids if j not in out]
    if missing:
        found: dict[int, list[dict]] = {j: [] for j in missing}
        for job_id, source, n in db.execute(text(f"""
            SELECT r.job_id, b.registrar, COUNT(DISTINCT rd.domain)
            FROM run_domains rd
            JOIN runs r ON r.id = rd.run_id
            JOIN backlog_domains b ON b.domain = rd.domain
            WHERE r.job_id IN ({', '.join(map(str, missing))}) AND b.registrar != ''
            GROUP BY r.job_id, b.registrar""")):
            found[job_id].append({"source": source, "domains": n})
        for job_id, rows in found.items():
            rows.sort(key=lambda s: (-s["domains"], s["source"]))
            _sources_cache[job_id] = (now, rows)
            out[job_id] = rows
    return out


def _by_project(job_rows: list[dict]) -> list[dict]:
    """Fold the per-job rows into one row per project (id None = none)."""
    out: dict = {}
    for j in job_rows:
        p = out.setdefault(j["project_id"], {
            "project_id": j["project_id"], "project": j["project"],
            "deleted": j["project_deleted"], "jobs": 0, "ai_usd": 0.0, "ahrefs_units": 0,
            "ahrefs_usd": 0.0 if j["ahrefs_usd"] is not None else None,
            "whois_history_credits": 0, "whois_history_usd": 0.0,
            "availability_calls": 0, "availability_usd": 0.0, "total_usd": 0.0})
        p["jobs"] += 1 if j["job_id"] else 0
        for k in ("ai_usd", "ahrefs_units", "whois_history_credits", "whois_history_usd",
                  "availability_calls", "availability_usd", "total_usd"):
            p[k] += j[k]
        if p["ahrefs_usd"] is not None:
            p["ahrefs_usd"] += j["ahrefs_usd"] or 0.0
    return sorted(out.values(), key=lambda r: (r["project_id"] is None, -r["total_usd"]))


def _name_jobs(rows: list[dict]) -> None:
    """Attach each job's name, type and project; a deleted job keeps its id
    and the project its events recorded."""
    ids = {r["job_id"] for r in rows if r["job_id"]}
    db = SessionLocal()
    try:
        meta = {jid: (name, kind, pid) for jid, name, kind, pid in db.execute(text(
            f"SELECT id, name, kind, project_id FROM jobs WHERE id IN ({', '.join(map(str, ids))})"
        ))} if ids else {}
        for r in rows:
            if r["job_id"] in meta:
                # A live job's CURRENT project (a rerun can set it); a deleted
                # job keeps the one its events recorded.
                name, kind, pid = meta[r["job_id"]]
                r.update(name=name, job_kind=kind, deleted=False, project_id=pid)
            else:
                r.update(name=None, job_kind=None, deleted=bool(r["job_id"]))
        sources = _job_sources(db, [r["job_id"] for r in rows if r["job_id"] in meta])
        for r in rows:
            r["sources"] = sources.get(r["job_id"], [])
        pids = {r["project_id"] for r in rows if r["project_id"]}
        projects = {pid: (name, deleted_at is not None) for pid, name, deleted_at in db.execute(text(
            f"SELECT id, name, deleted_at FROM projects WHERE id IN ({', '.join(map(str, pids))})"
        ))} if pids else {}
    finally:
        db.close()
    for r in rows:
        name, gone = projects.get(r["project_id"], ("", False))
        r.update(project=name, project_deleted=gone)


def _ai_row_cost(g: dict, prices: dict) -> tuple[float, float, int]:
    """(cost incl. estimates, estimated part, calls still unpriced)."""
    price = prices.get((g["provider"], g["model"]))
    estimated = 0.0
    unpriced = 0
    if g["unpriced_calls"]:
        est = _ai_cost(price, g["unpriced_in"], g["unpriced_out"])
        if est is None:
            unpriced = g["unpriced_calls"]
        else:
            estimated = est
    return g["cost_known"] + estimated, estimated, unpriced


def _summarize(groups: list[dict], prices: dict, pricing: dict,
               period: str, today: date) -> dict:
    start, end = _period_bounds(period, today)

    def in_period(day: date) -> bool:
        return (start is None or day >= start) and (end is None or day < end)

    wf_price = pricing["whoisfreaks_usd_per_credit"]
    domainr_price = pricing["domainr_usd_per_request"]

    def unit_cost(kind: str, provider: str, units: int) -> float | None:
        if kind == "whois_history" or (kind == "availability" and provider == "whoisfreaks"):
            return units * wf_price if wf_price > 0 else None
        if kind == "availability" and provider == "domainr":
            return units * domainr_price if domainr_price > 0 else None
        return None

    ai_models: dict[tuple, dict] = {}
    features: dict[tuple, dict] = {}
    months: dict[str, dict] = {}
    totals = {k: {"calls": 0, "units": 0, "usd": 0.0} for k in
              ("ai", "ahrefs", "whois_history", "availability")}
    ai_extra = {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
                "estimated_usd": 0.0, "unpriced_calls": 0, "failed_calls": 0}
    # "priced" = a price is set for every provider actually used (and for at
    # least one, so an unconfigured API never reads as a real $0).
    unit_priced = {"whois_history": wf_price > 0,
                   "availability": wf_price > 0 or domainr_price > 0}
    unpriced_models: dict[tuple, int] = {}
    ahrefs_by_month: dict[str, int] = {}
    jobs: dict = {}
    ahrefs_job_month: dict[tuple, int] = {}
    backfill_calls = 0
    first_day: date | None = None

    for g in groups:
        day = date.fromisoformat(g["day"]) if isinstance(g["day"], str) else g["day"]
        if day is None:
            continue
        first_day = day if first_day is None or day < first_day else first_day
        kind = g["kind"]
        month = day.strftime("%Y-%m")
        m = months.setdefault(month, {"month": month, "ai_usd": 0.0, "ahrefs_units": 0,
                                      "whois_history_credits": 0, "whois_history_usd": 0.0,
                                      "availability_calls": 0, "availability_usd": 0.0})
        if kind == "ai":
            cost, est, unp = _ai_row_cost(g, prices)
            m["ai_usd"] += cost
        elif kind == "ahrefs":
            m["ahrefs_units"] += g["units"]
            ahrefs_by_month[month] = ahrefs_by_month.get(month, 0) + g["units"]
            jm = (g["job_id"], month)
            ahrefs_job_month[jm] = ahrefs_job_month.get(jm, 0) + g["units"]
            cost = est = 0.0
            unp = 0
        else:
            uc = unit_cost(kind, g["provider"], g["units"])
            cost, est, unp = (uc or 0.0), 0.0, 0
            if kind == "whois_history":
                m["whois_history_credits"] += g["units"]
                m["whois_history_usd"] += uc or 0.0
            else:
                m["availability_calls"] += g["calls"]
                m["availability_usd"] += uc or 0.0
        if not in_period(day):
            continue

        backfill_calls += g["backfill_calls"]
        j = jobs.setdefault(g["job_id"], {
            "job_id": g["job_id"], "ai_usd": 0.0, "ai_calls": 0, "ai_estimated": False,
            "ahrefs_units": 0, "ahrefs_usd": 0.0, "whois_history_credits": 0,
            "whois_history_usd": 0.0, "availability_calls": 0, "availability_usd": 0.0,
            "project_id": None, "first_day": day.isoformat(), "last_day": day.isoformat()})
        j["project_id"] = j["project_id"] or g.get("project_id")
        j["first_day"] = min(j["first_day"], day.isoformat())
        j["last_day"] = max(j["last_day"], day.isoformat())
        if kind == "ai":
            j["ai_usd"] += cost
            j["ai_calls"] += g["calls"]
            j["ai_estimated"] = j["ai_estimated"] or est > 0
        elif kind == "ahrefs":
            j["ahrefs_units"] += g["units"]
        elif kind == "whois_history":
            j["whois_history_credits"] += g["units"]
            j["whois_history_usd"] += cost
        else:
            j["availability_calls"] += g["calls"]
            j["availability_usd"] += cost
        t = totals[kind]
        t["calls"] += g["calls"]
        t["units"] += g["units"]
        if kind in unit_priced and unit_cost(kind, g["provider"], 1) is None and g["units"]:
            unit_priced[kind] = False
        if kind != "ahrefs":
            t["usd"] += cost
        if kind == "ai":
            ai_extra["input_tokens"] += g["input_tokens"]
            ai_extra["output_tokens"] += g["output_tokens"]
            ai_extra["thinking_tokens"] += g["thinking_tokens"]
            ai_extra["estimated_usd"] += est
            ai_extra["unpriced_calls"] += unp
            ai_extra["failed_calls"] += g["failed"]
            mk = (g["provider"], g["model"])
            row = ai_models.setdefault(mk, {"provider": g["provider"], "model": g["model"],
                                            "calls": 0, "input_tokens": 0, "output_tokens": 0,
                                            "thinking_tokens": 0, "usd": 0.0,
                                            "estimated_usd": 0.0, "unpriced_calls": 0})
            for k in ("calls", "input_tokens", "output_tokens", "thinking_tokens"):
                row[k] += g[k]
            row["usd"] += cost
            row["estimated_usd"] += est
            row["unpriced_calls"] += unp
            if unp:
                unpriced_models[mk] = unpriced_models.get(mk, 0) + unp
        fk = (kind, g["feature"])
        f = features.setdefault(fk, {"kind": kind, "feature": g["feature"], "calls": 0,
                                     "tokens": 0, "units": 0, "usd": 0.0,
                                     "estimated_usd": 0.0, "unpriced_calls": 0})
        f["calls"] += g["calls"]
        f["tokens"] += g["input_tokens"] + g["output_tokens"]
        f["units"] += g["units"]
        if kind != "ahrefs":
            f["usd"] += cost
        f["estimated_usd"] += est
        f["unpriced_calls"] += unp

    # Ahrefs dollars: per calendar month, units above the allowance.
    for month, units in ahrefs_by_month.items():
        months[month]["ahrefs_usd"] = ahrefs_overage_usd(units, pricing)
    month_aligned = (period in ("this_month", "last_month", "all_time")
                     or bool(_MONTH_RE.match(period)))
    if month_aligned:
        for month in ahrefs_by_month:
            if in_period(date.fromisoformat(month + "-01")):
                totals["ahrefs"]["usd"] += months[month]["ahrefs_usd"]
    ahrefs_usd = totals["ahrefs"]["usd"] if month_aligned else None
    if month_aligned:
        for (job_id, month), units in ahrefs_job_month.items():
            month_units = ahrefs_by_month[month]
            if (job_id in jobs and month_units
                    and in_period(date.fromisoformat(month + "-01"))):
                jobs[job_id]["ahrefs_usd"] += months[month]["ahrefs_usd"] * units / month_units
    job_rows = []
    for j in jobs.values():
        j["total_usd"] = (j["ai_usd"] + (j["ahrefs_usd"] if month_aligned else 0.0)
                          + j["whois_history_usd"] + j["availability_usd"])
        if not month_aligned:
            j["ahrefs_usd"] = None
        job_rows.append(j)
    job_rows.sort(key=lambda r: (-r["total_usd"], -r["ahrefs_units"], -r["ai_calls"]))

    month_rows = []
    for month in sorted(months, reverse=True)[:12]:
        r = months[month]
        r.setdefault("ahrefs_usd", 0.0)
        r["total_usd"] = (r["ai_usd"] + r["ahrefs_usd"] + r["whois_history_usd"]
                          + r["availability_usd"])
        month_rows.append(r)

    this_month = today.strftime("%Y-%m")
    total_usd = (totals["ai"]["usd"] + (ahrefs_usd or 0.0)
                 + totals["whois_history"]["usd"] + totals["availability"]["usd"])
    return {
        "period": period,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "total_usd": total_usd,
        "ai": {**totals["ai"], **ai_extra},
        "ahrefs": {
            **totals["ahrefs"], "usd": ahrefs_usd,
            "included_units": pricing["ahrefs_included_units"],
            "usd_per_million": pricing["ahrefs_usd_per_million"],
            "this_month_units": ahrefs_by_month.get(this_month, 0),
        },
        "whois_history": {**totals["whois_history"], "priced": unit_priced["whois_history"]},
        "availability": {**totals["availability"], "priced": unit_priced["availability"]},
        "ai_models": sorted(ai_models.values(), key=lambda r: (-r["usd"], -r["calls"])),
        "features": sorted(features.values(),
                           key=lambda r: (_KIND_ORDER.get(r["kind"], 9), -r["usd"],
                                          -r["units"], -r["calls"])),
        "months": month_rows,
        "jobs": job_rows,
        "months_available": sorted(months, reverse=True),
        "unpriced_models": [{"provider": p, "model": mdl, "calls": n}
                            for (p, mdl), n in sorted(unpriced_models.items())],
        "backfill_calls": backfill_calls,
        "first_day": first_day.isoformat() if first_day else None,
        "pricing": pricing,
    }
