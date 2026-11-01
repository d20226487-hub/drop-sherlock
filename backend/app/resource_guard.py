"""Resource check before a Database snapshot rebuild (added 2026-11-01).

The rebuild is the heaviest thing the API does (~2 GB extra at ~100k
domains, measured on a production-shaped DB) and it runs in the same single
Python process that serves every request and every check. This asks, just
before a rebuild starts, whether the server is already struggling:

  - CPU: the process's CPU use over the last 30 s (≥ 85% = saturated —
    one process, so ~100% is the ceiling);
  - event loop: the worst ping delay over the last 30 s (≥ 1 s = requests
    are already queueing);
  - memory: the container's working set (usage minus reclaimable file
    cache, as `docker stats` reports it — raw usage sits near the limit
    harmlessly because the kernel fills spare RAM with SQLite's file
    cache) at ≥ 90% of its limit, or the kernel's memory-pressure average
    (`memory.pressure` "some avg10") at ≥ 10%.

Deliberately NOT "RSS + rebuild estimate > limit": Python keeps freed
memory and reuses it for the next build, so after one big rebuild RSS
stays near its peak and that rule would block every rebuild after it.

Cost: CPU time and loop delay are noted on the loop watchdog's existing
1 Hz tick (`os.times()` ≈ 0.3 µs). Memory files are read only when a
rebuild is about to start (a few times an hour, ~0.3 ms). With the
watchdog off (LOOP_WATCHDOG=0) CPU and loop readings are unknown and only
memory is checked.

Mode — REBUILD_GUARD: "log" (default) never blocks; when a rebuild WOULD
be postponed it writes an Errors-page row with the readings, then a second
row with what that rebuild actually cost, so the thresholds can be tuned
on real runs before anything is enforced. "off" disables the check."""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from .loop_watchdog import _cgroup_limit_mb, _rss_mb

log = logging.getLogger(__name__)

CPU_BUSY_PCT = 85.0
LOOP_DELAY_SEC = 1.0
MEM_WORKING_SET_FRAC = 0.90
MEM_PRESSURE_AVG10 = 10.0
WINDOW_SEC = 30.0
# Rows the guard may write, at most one per this many seconds.
_REPORT_EVERY_SEC = 300.0

_lock = threading.Lock()
# (monotonic, process CPU seconds, loop delay seconds), one per watchdog tick.
_ticks: deque[tuple[float, float, float]] = deque(maxlen=180)
_last_report = 0.0


def mode() -> str:
    value = os.environ.get("REBUILD_GUARD", "log").strip().lower()
    return value if value in ("log", "off") else "log"


def note_tick(now: float, loop_delay: float) -> None:
    """Called by the loop watchdog once per tick."""
    t = os.times()
    with _lock:
        _ticks.append((now, t.user + t.system, max(0.0, loop_delay)))


def _cpu_and_delay(now: float) -> tuple[float | None, float | None]:
    """(process CPU % over ~WINDOW_SEC, worst loop delay in it); None when
    there's no tick history (watchdog off, or just started)."""
    with _lock:
        ticks = [t for t in _ticks if now - t[0] <= WINDOW_SEC + 2]
    if len(ticks) < 2:
        return None, None
    (t0, c0, _), (t1, c1, _) = ticks[0], ticks[-1]
    cpu = (c1 - c0) / (t1 - t0) * 100 if t1 > t0 else None
    return cpu, max(d for _, _, d in ticks)


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as f:
            return f.read()
    except OSError:
        return None


def _working_set_mb() -> float | None:
    """Container memory in use minus reclaimable file cache (cgroup v2,
    then v1) — the figure `docker stats` shows."""
    for usage_path, stat_path, key in (
        ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.stat",
         "inactive_file"),
        ("/sys/fs/cgroup/memory/memory.usage_in_bytes",
         "/sys/fs/cgroup/memory/memory.stat", "total_inactive_file"),
    ):
        usage = _read(usage_path)
        if usage is None or not usage.strip().isdigit():
            continue
        inactive = 0
        for line in (_read(stat_path) or "").splitlines():
            name, _, value = line.partition(" ")
            if name == key and value.strip().isdigit():
                inactive = int(value)
                break
        return max(0, int(usage) - inactive) / (1024 * 1024)
    return None


def _memory_pressure() -> float | None:
    """Kernel PSI "some avg10" for this container (else the host): the %
    of the last 10 s in which some task stalled waiting for memory."""
    for path in ("/sys/fs/cgroup/memory.pressure", "/proc/pressure/memory"):
        text = _read(path)
        if not text:
            continue
        for line in text.splitlines():
            if line.startswith("some "):
                for part in line.split():
                    if part.startswith("avg10="):
                        try:
                            return float(part[6:])
                        except ValueError:
                            return None
    return None


@dataclass
class Verdict:
    busy: bool
    reasons: list[str] = field(default_factory=list)
    readings: str = ""


def assess() -> Verdict:
    """Is the server too busy for a rebuild right now?"""
    now = time.monotonic()
    cpu, delay = _cpu_and_delay(now)
    rss, limit = _rss_mb(), _cgroup_limit_mb()
    working, pressure = _working_set_mb(), _memory_pressure()
    reasons: list[str] = []
    if cpu is not None and cpu >= CPU_BUSY_PCT:
        reasons.append(f"CPU {cpu:.0f}% over the last {WINDOW_SEC:.0f} s")
    if delay is not None and delay >= LOOP_DELAY_SEC:
        reasons.append(f"event loop answered {delay:.1f} s late")
    if working is not None and limit and working >= MEM_WORKING_SET_FRAC * limit:
        reasons.append(f"memory {working / 1024:.1f} / {limit / 1024:.1f} GB in use")
    if pressure is not None and pressure >= MEM_PRESSURE_AVG10:
        reasons.append(f"kernel stalled on memory {pressure:.0f}% of the last 10 s")

    def fmt(v, unit, spec=".0f"):
        return "unknown" if v is None else f"{v:{spec}}{unit}"
    readings = (
        f"CPU {fmt(cpu, '%')}, worst loop delay {fmt(delay, ' s', '.2f')}, "
        f"process {fmt(rss, ' MB')}, container working set {fmt(working, ' MB')}"
        f" of {fmt(limit, ' MB')}, memory pressure {fmt(pressure, '%', '.1f')}"
    )
    return Verdict(busy=bool(reasons), reasons=reasons, readings=readings)


def _may_report() -> bool:
    global _last_report
    now = time.monotonic()
    with _lock:
        if _last_report and now - _last_report < _REPORT_EVERY_SEC:
            return False
        _last_report = now
        return True


def before_rebuild() -> dict | None:
    """Hook for the snapshot rebuild trigger. In log mode, when the server
    looks busy, write one Errors-page row and return a token for
    `after_rebuild`; the rebuild always goes ahead. None otherwise."""
    if mode() == "off":
        return None
    verdict = assess()
    if not verdict.busy or not _may_report():
        return None
    log.error(
        "rebuild guard (log-only): would postpone the Database snapshot "
        "rebuild - %s. Readings: %s. Rebuilding anyway; set thresholds "
        "from these rows before enforcing.",
        "; ".join(verdict.reasons), verdict.readings,
    )
    return {"t0": time.monotonic(), "rss0": _rss_mb()}


def after_rebuild(token: dict | None, ok: bool) -> None:
    """Second row for a flagged rebuild: what it actually cost."""
    if token is None:
        return
    now = time.monotonic()
    with _lock:
        delays = [d for t, _, d in _ticks if t >= token["t0"]]
    rss1 = _rss_mb()
    mem = (
        f"process memory {token['rss0']:.0f} -> {rss1:.0f} MB"
        if token["rss0"] is not None and rss1 is not None
        else "process memory unknown"
    )
    log.error(
        "rebuild guard (log-only): the flagged rebuild %s after %.1f s; %s; "
        "worst event-loop delay while it ran %s.",
        "finished" if ok else "FAILED", now - token["t0"], mem,
        f"{max(delays):.1f} s" if delays else "unknown",
    )
