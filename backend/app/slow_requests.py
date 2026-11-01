"""Slow-request log (added 2026-11-01). Off unless SLOW_REQUEST_LOG_SEC is
set to a threshold in seconds (e.g. `SLOW_REQUEST_LOG_SEC=1`).

Why: the API is one uvicorn worker, so a few heavy requests that the UI
repeats (run-page polls every 2 s, Database snapshot reads) starve every
other request and grow the heap. Measured locally, /runs/{id}/cost loaded
every row of an 18k-domain run on each poll. This puts the same kind of
measurement on the real server: every request slower than the threshold
writes one Errors-page row naming the endpoint, its duration, and what it
pulled from the database —

  slow request: GET /runs/{run_id}/cost took 2.31 s (status 200) -
  loaded 120,034 rows (RunDomain 60,017, CriterionResult 60,017),
  5.2 MB of text; 3 SQL statements, 1.92 s in the database.
  URL: /runs/191/cost

How: a pure-ASGI middleware times the request and puts a per-request
Counter in a ContextVar. ORM "load" events and engine cursor events add to
it; the counter object is shared by reference, so work done in threadpool
endpoints and asyncio.to_thread offloads (which run on a copy of the
context) is counted too. The row is written from an executor thread —
error_log persistence is a synchronous SQLite write, and doing it on the
event loop would add the very stall being reported. Long-lived streams
(`/events`) are skipped; rows are capped per 10 minutes so a freeze, when
every poll is slow, can't flood error_log.

Cost while on: one counter bump per ORM row loaded and per SQL statement."""
from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import os
import threading
import time
from collections import Counter

log = logging.getLogger(__name__)

_MAX_ROWS_PER_WINDOW = 60
_WINDOW_SEC = 600

_current: contextvars.ContextVar[Counter | None] = contextvars.ContextVar(
    "slow_request_counter", default=None,
)
_rate_lock = threading.Lock()
_window_start = 0.0
_window_rows = 0
_suppressed = 0


def threshold_sec() -> float | None:
    """The configured threshold, or None when the switch is off."""
    raw = os.environ.get("SLOW_REQUEST_LOG_SEC", "").strip()
    try:
        value = float(raw) if raw else 0.0
    except ValueError:
        return None
    return value if value > 0 else None


def _on_load(target, _ctx) -> None:
    c = _current.get()
    if c is None:
        return
    c["rows:" + type(target).__name__] += 1
    c["text"] += sum(len(v) for v in target.__dict__.values() if type(v) is str)


def _before_cursor(conn, _cursor, _stmt, _params, _context, _many) -> None:
    if _current.get() is not None:
        conn.info.setdefault("_slow_req_t0", []).append(time.perf_counter())


def _after_cursor(conn, _cursor, _stmt, _params, _context, _many) -> None:
    c = _current.get()
    stack = conn.info.get("_slow_req_t0")
    if c is None or not stack:
        return
    c["sql"] += 1
    c["sql_sec"] += time.perf_counter() - stack.pop()


def _take_slot() -> int | None:
    """Rate cap. Returns how many rows were suppressed since the last one
    written (to mention in this row), or None if this one is suppressed."""
    global _window_start, _window_rows, _suppressed
    now = time.monotonic()
    with _rate_lock:
        if now - _window_start >= _WINDOW_SEC:
            _window_start, _window_rows = now, 0
        if _window_rows >= _MAX_ROWS_PER_WINDOW:
            _suppressed += 1
            return None
        _window_rows += 1
        skipped, _suppressed = _suppressed, 0
        return skipped


def _format(scope, status: int, elapsed: float, c: Counter, skipped: int) -> str:
    route = scope.get("route")
    template = getattr(route, "path", None) or scope.get("path", "?")
    url = scope.get("path", "")
    qs = scope.get("query_string", b"").decode("latin-1")
    if qs:
        url += "?" + qs
    by_model = sorted(
        ((k[5:], v) for k, v in c.items() if k.startswith("rows:")),
        key=lambda kv: -kv[1],
    )
    total_rows = sum(v for _, v in by_model)
    models = ", ".join(f"{name} {n:,}" for name, n in by_model[:4])
    msg = (
        f"slow request: {scope.get('method', '?')} {template} took "
        f"{elapsed:.2f} s (status {status}) - loaded {total_rows:,} rows"
        + (f" ({models})" if models else "")
        + f", {c['text'] / 1_048_576:.1f} MB of text; {int(c['sql'])} SQL "
        f"statements, {c['sql_sec']:.2f} s in the database. URL: {url}"
    )
    if skipped:
        msg += f" ({skipped} earlier slow requests not logged: rate cap)"
    return msg


class SlowRequestMiddleware:
    def __init__(self, app, threshold: float):
        self.app = app
        self.threshold = threshold

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path", "").endswith("/events"):
            await self.app(scope, receive, send)
            return
        counter: Counter = Counter()
        token = _current.set(counter)
        status = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        start = time.perf_counter()
        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            _current.reset(token)
            elapsed = time.perf_counter() - start
            if elapsed >= self.threshold:
                skipped = _take_slot()
                if skipped is not None:
                    msg = _format(scope, status["code"], elapsed, counter, skipped)
                    # Fire-and-forget off the loop (see module docstring).
                    asyncio.get_running_loop().run_in_executor(
                        None, functools.partial(log.error, msg),
                    )


def install(app, engine, base) -> bool:
    """Wire the middleware and the DB counters when the switch is on.
    Returns whether it was installed."""
    threshold = threshold_sec()
    if threshold is None:
        return False
    from sqlalchemy import event

    for mapper in base.registry.mappers:
        event.listen(mapper.class_, "load", _on_load)
    event.listen(engine, "before_cursor_execute", _before_cursor)
    event.listen(engine, "after_cursor_execute", _after_cursor)
    app.add_middleware(SlowRequestMiddleware, threshold=threshold)
    log.warning("slow-request log on: requests over %.2f s go to error_log", threshold)
    return True
