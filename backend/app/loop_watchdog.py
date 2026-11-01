"""Event-loop stall watchdog (added 2026-10-30).

Why this exists: the API is ONE uvicorn worker, and one asyncio loop
serves every HTTP request AND every in-process job. Anything that holds
the loop — a sync DB call waiting out a SQLite write lock, a CPU-heavy
parse, a long GC pause — freezes every request at once. Behind Cloudflare
that surfaces as a 524 once a request waits past the proxy read timeout,
and to the operator it looks like the tool "rebooted". The 524s during
Wayback runs survived two targeted fixes (the 2 MB download cap and the
off-loop HTML parse), so instead of guessing a third culprit this records
what the loop is actually doing when it stalls.

How: a daemon thread pings the loop every second with
`call_soon_threadsafe`. When the loop has not answered for `stall_sec`,
the thread grabs the loop thread's current Python stack from
`sys._current_frames()` and logs it at ERROR, so it lands in `error_log`
and the Errors page export (no SSH needed), plus stderr / `docker logs`.
When the loop answers again it logs one more ERROR with the stall's total
duration. Each report also carries the context needed to tell the usual
suspects apart: process RSS, the longest gen-2 GC pause during the stall,
other threads that are busy (not parked on a lock or queue), and any
scheduled job (malloc_trim, prunes, backup, VACUUM) that overlapped it.

Caveat: a C call that holds the GIL (rare in this codebase) also stops
this thread; the stall is still caught the moment the call returns, and
the stack then points at the Python frame that made it.

Cost: one no-op callback per second on the loop. Off switch:
LOOP_WATCHDOG=0. Threshold: LOOP_WATCHDOG_STALL_SEC (default 5)."""
from __future__ import annotations

import gc
import logging
import os
import sys
import threading
import time
import traceback
from contextlib import contextmanager

log = logging.getLogger(__name__)

# Bounds error_log growth if the loop stalls over and over.
_MAX_REPORTS_PER_HOUR = 30
# Memory high-water marks: one ERROR each time RSS first crosses another
# step above the floor, so the last row before an OOM-kill restart shows
# how close the process got and which jobs were running. Marks only rise,
# so this is a handful of rows per process lifetime.
_MEM_FLOOR_MB = 2048
_MEM_STEP_MB = 512
# Frames kept from the innermost end of each stack.
_STACK_DEPTH = 40
# Top frames of a thread parked in one of these is idle, not interesting.
_IDLE_FILES = ("threading.py", "queue.py", "selectors.py", "thread.py")

_lock = threading.Lock()
# name -> list of start times (monotonic) of runs still in progress
_active: dict[str, list[float]] = {}
# (name, start, end) of recently finished runs, newest last
_finished: list[tuple[str, float, float]] = []
# (start, end, generation) of recent gen-2 collections, newest last
_gc_pauses: list[tuple[float, float, int]] = []
_gc_started: float | None = None

_watchdog: "_Watchdog | None" = None


def begin(name: str) -> None:
    """Mark `name` as in progress so a stall report that overlaps it names
    it. Pair with `end(name)`; `track()` does both."""
    with _lock:
        _active.setdefault(name, []).append(time.monotonic())


def end(name: str) -> None:
    with _lock:
        runs = _active.get(name)
        if not runs:
            return
        start = runs.pop(0)
        _finished.append((name, start, time.monotonic()))
        del _finished[:-20]


@contextmanager
def track(name: str):
    begin(name)
    try:
        yield
    finally:
        end(name)


def watch_scheduler(sched) -> None:
    """Track every APScheduler job run (malloc_trim, the prunes, backup,
    VACUUM) so a stall report names whichever overlapped it. These run in
    executor threads, off the loop, yet can still stall it: a prune holds
    the SQLite write lock that a sync write on the loop then waits out,
    and malloc_trim holds glibc arena locks the loop's allocations need."""
    from apscheduler.events import (
        EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, EVENT_JOB_SUBMITTED,
    )

    def _listener(event) -> None:
        name = f"job:{event.job_id}"
        if event.code == EVENT_JOB_SUBMITTED:
            begin(name)
        else:
            end(name)

    sched.add_listener(
        _listener, EVENT_JOB_SUBMITTED | EVENT_JOB_EXECUTED | EVENT_JOB_ERROR,
    )


def _gc_callback(phase: str, info: dict) -> None:
    global _gc_started
    if info.get("generation") != 2:
        return
    if phase == "start":
        _gc_started = time.monotonic()
    elif _gc_started is not None:
        _gc_pauses.append((_gc_started, time.monotonic(), 2))
        del _gc_pauses[:-20]
        _gc_started = None


def _rss_mb() -> float | None:
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except (OSError, ValueError):
        pass
    return None


def _short_path(path: str) -> str:
    path = path.replace("\\", "/")
    for marker in ("site-packages/", "/app/"):
        i = path.rfind(marker)
        if i >= 0:
            return path[i + 1:] if marker == "/app/" else path[i + len(marker):]
    return os.path.basename(path)


def _cgroup_limit_mb() -> float | None:
    for path in ("/sys/fs/cgroup/memory.max",                     # v2
                 "/sys/fs/cgroup/memory/memory.limit_in_bytes"):  # v1
        try:
            with open(path, encoding="ascii") as f:
                raw = f.read().strip()
        except OSError:
            continue
        if raw.isdigit() and int(raw) < 1 << 60:  # v1 "unlimited" is huge
            return int(raw) / (1024 * 1024)
        return None
    return None


def _format_frame(frame) -> str:
    """Innermost frame FIRST, short paths: error_log truncates messages at
    8 KB, and the culprit must be what survives, not the asyncio/anyio
    bootstrap frames at the outer end."""
    out = []
    for fs in reversed(traceback.extract_stack(frame)[-_STACK_DEPTH:]):
        out.append(f"  {_short_path(fs.filename)}:{fs.lineno} in {fs.name}\n")
        if fs.line:
            out.append(f"      {fs.line.strip()}\n")
    return "".join(out)


def _busy_threads(skip: set[int]) -> list[str]:
    """One short entry per non-idle thread other than `skip`."""
    names = {t.ident: t.name for t in threading.enumerate()}
    out = []
    for ident, frame in sys._current_frames().items():
        if ident in skip:
            continue
        top = traceback.extract_stack(frame)
        if not top or os.path.basename(top[-1].filename) in _IDLE_FILES:
            continue
        where = " <- ".join(
            f"{os.path.basename(fs.filename)}:{fs.lineno} {fs.name}"
            for fs in reversed(top[-3:])
        )
        out.append(f"  [{names.get(ident, ident)}] {where}")
    return out


def _context(since: float, now: float, *, with_rss: bool = True) -> str:
    parts = []
    rss = _rss_mb() if with_rss else None
    if rss is not None:
        parts.append(f"rss={rss:.0f}MB")
    gc_hits = [e - s for s, e, _g in list(_gc_pauses) if e >= since]
    if _gc_started is not None:
        gc_hits.append(now - _gc_started)
    if gc_hits:
        parts.append(f"longest gen2 GC during stall={max(gc_hits):.2f}s")
    with _lock:
        running = [
            f"{n} (running {now - s:.1f}s)"
            for n, starts in _active.items() for s in starts
        ]
        overlapped = [
            f"{n} (took {e - s:.1f}s)" for n, s, e in _finished if e >= since
        ]
    if running or overlapped:
        parts.append("tracked: " + ", ".join(running + overlapped))
    return "; ".join(parts) or "no extra context"


class _Watchdog:
    def __init__(self, loop, loop_thread_id: int, stall_sec: float,
                 interval: float):
        self.loop = loop
        self.loop_thread_id = loop_thread_id
        self.stall_sec = stall_sec
        self.interval = interval
        self.last_beat = time.monotonic()
        # One ping in flight at most, so a long stall doesn't queue
        # a callback per second on the loop.
        self.pending = False
        # When the in-flight ping was sent and how late the last one ran:
        # the loop's actual queueing delay, fed to resource_guard.
        self.ping_sent = time.monotonic()
        self.last_delay = 0.0
        self.stop_event = threading.Event()
        self.report_times: list[float] = []
        self.next_mem_mark = float(_MEM_FLOOR_MB)
        self.thread = threading.Thread(
            target=self._run, name="loop-watchdog", daemon=True,
        )

    def _beat(self) -> None:
        self.last_beat = time.monotonic()
        self.last_delay = self.last_beat - self.ping_sent
        self.pending = False

    def _check_memory(self, now: float) -> None:
        rss = _rss_mb()
        if rss is None or rss < self.next_mem_mark:
            return
        steps = int((rss - _MEM_FLOOR_MB) // _MEM_STEP_MB) + 1
        self.next_mem_mark = _MEM_FLOOR_MB + steps * _MEM_STEP_MB
        limit = _cgroup_limit_mb()
        log.error(
            "memory high-water: rss=%.0fMB of %s container limit (%s)",
            rss, f"{limit:.0f}MB" if limit else "no",
            _context(now, now, with_rss=False),
        )

    def _may_report(self, now: float) -> bool:
        self.report_times = [t for t in self.report_times if now - t < 3600]
        if len(self.report_times) >= _MAX_REPORTS_PER_HOUR:
            return False
        self.report_times.append(now)
        return True

    def _run(self) -> None:
        from . import resource_guard  # here, not at import: it imports us

        stall_start: float | None = None  # last beat before the stall
        reported = False
        while not self.stop_event.is_set():
            if not self.pending:
                self.pending = True
                self.ping_sent = time.monotonic()
                try:
                    self.loop.call_soon_threadsafe(self._beat)
                except RuntimeError:  # loop closed
                    return
            if self.stop_event.wait(self.interval):
                return
            now = time.monotonic()
            self._check_memory(now)
            resource_guard.note_tick(
                now, now - self.ping_sent if self.pending else self.last_delay,
            )
            lag = now - self.last_beat
            if lag >= self.stall_sec:
                if stall_start is None:
                    stall_start = self.last_beat
                    reported = self._may_report(now)
                    if reported:
                        self._report_stall(lag, stall_start, now)
            elif stall_start is not None:
                if reported:
                    log.error(
                        "event loop recovered after a %.1fs stall (%s)",
                        self.last_beat - stall_start,
                        _context(stall_start, now),
                    )
                stall_start = None

    def _report_stall(self, lag: float, since: float, now: float) -> None:
        frame = sys._current_frames().get(self.loop_thread_id)
        stack = _format_frame(frame) if frame is not None else "(no frame)\n"
        busy = _busy_threads({self.loop_thread_id, threading.get_ident()})
        log.error(
            "event loop stalled for %.1fs - HTTP requests are not being "
            "served (%s). Loop thread stack, innermost first:\n%s%s",
            lag, _context(since, now), stack,
            ("Busy threads:\n" + "\n".join(busy)) if busy else "No busy threads.",
        )


def start(loop, *, stall_sec: float | None = None,
          interval: float = 1.0) -> bool:
    """Start watching `loop`. Must be called FROM the loop's thread (it
    records that thread's id). Idempotent. Returns whether it is running."""
    global _watchdog
    if os.environ.get("LOOP_WATCHDOG", "1").strip() == "0":
        return False
    if _watchdog is not None and _watchdog.thread.is_alive():
        return True
    if stall_sec is None:
        try:
            stall_sec = float(os.environ.get("LOOP_WATCHDOG_STALL_SEC", "5"))
        except ValueError:
            stall_sec = 5.0
    if _gc_callback not in gc.callbacks:
        gc.callbacks.append(_gc_callback)
    # The root logger has only the error_log DB handler, and that write can
    # fail during exactly the stall worth reporting (a held SQLite lock).
    # A direct stderr copy keeps every report in `docker logs`.
    if not any(getattr(h, "_loop_watchdog", False) for h in log.handlers):
        h = logging.StreamHandler(sys.stderr)
        h._loop_watchdog = True
        h.setFormatter(logging.Formatter("%(asctime)s %(name)s: %(message)s"))
        log.addHandler(h)
    _watchdog = _Watchdog(loop, threading.get_ident(), stall_sec, interval)
    _watchdog.thread.start()
    return True


def stop() -> None:
    global _watchdog
    if _watchdog is not None:
        _watchdog.stop_event.set()
        _watchdog.thread.join(timeout=2)
        _watchdog = None
    if _gc_callback in gc.callbacks:
        gc.callbacks.remove(_gc_callback)
    for h in [h for h in log.handlers if getattr(h, "_loop_watchdog", False)]:
        log.removeHandler(h)
