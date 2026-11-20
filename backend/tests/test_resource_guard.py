"""Resource check before a Database snapshot rebuild (2026-11-01; enforced
since 2026-11-10).

Before a rebuild (never the first build) it asks whether the server is
already struggling — CPU, event-loop delay, container working set, kernel
memory pressure. Enforced ("on", the default): memory postpones the rebuild
outright; CPU / loop delay postpone it until the snapshot is 30 min old.
"log" only writes Errors-page rows; "off" skips the check.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

import pytest


@pytest.fixture
def guard(monkeypatch):
    from app import resource_guard as g
    monkeypatch.setattr(g, "_ticks", type(g._ticks)(maxlen=180))
    monkeypatch.setattr(g, "_last_report", 0.0)
    monkeypatch.delenv("REBUILD_GUARD", raising=False)
    for name in ("_rss_mb", "_cgroup_limit_mb", "_working_set_mb", "_memory_pressure"):
        monkeypatch.setattr(g, name, lambda: None)
    return g


def _feed(g, monkeypatch, *, cpu_per_sec, seconds=30, delays=None):
    """Ticks once per (fake) second with CPU time growing `cpu_per_sec`."""
    clock = {"cpu": 0.0}

    class _T:
        def __init__(self, c):
            self.user, self.system = c, 0.0
    monkeypatch.setattr(os, "times", lambda: _T(clock["cpu"]))
    base = time.monotonic() - seconds
    for i in range(seconds + 1):
        clock["cpu"] = i * cpu_per_sec
        g.note_tick(base + i, (delays or {}).get(i, 0.0))


def _rows(caplog):
    return [r.getMessage() for r in caplog.records
            if r.name == "app.resource_guard" and r.levelno == logging.ERROR]


def test_nothing_known_is_not_busy(guard):
    v = guard.assess()
    assert not v.busy
    assert "CPU unknown" in v.readings and "memory pressure unknown" in v.readings


def test_cpu_over_the_last_30_s(guard, monkeypatch):
    _feed(guard, monkeypatch, cpu_per_sec=0.9)
    v = guard.assess()
    assert v.busy and v.reasons == ["CPU 90% over the last 30 s"]
    guard._ticks.clear()
    _feed(guard, monkeypatch, cpu_per_sec=0.2)
    assert not guard.assess().busy


def test_loop_delay_inside_the_window_only(guard, monkeypatch):
    _feed(guard, monkeypatch, cpu_per_sec=0.1, delays={25: 1.6})
    v = guard.assess()
    assert v.busy and v.reasons == ["event loop answered 1.6 s late"]
    guard._ticks.clear()
    _feed(guard, monkeypatch, cpu_per_sec=0.1, seconds=90, delays={5: 9.0})  # 85 s ago
    assert not guard.assess().busy


def test_memory_working_set_and_pressure(guard, monkeypatch):
    monkeypatch.setattr(guard, "_cgroup_limit_mb", lambda: 5120.0)
    monkeypatch.setattr(guard, "_working_set_mb", lambda: 4700.0)        # 92%
    assert guard.assess().reasons == ["memory 4.6 / 5.0 GB in use"]
    monkeypatch.setattr(guard, "_working_set_mb", lambda: 3000.0)
    monkeypatch.setattr(guard, "_memory_pressure", lambda: 12.0)
    assert guard.assess().reasons == ["kernel stalled on memory 12% of the last 10 s"]


def test_working_set_excludes_reclaimable_file_cache(monkeypatch):
    """Raw cgroup usage sits near the limit harmlessly (SQLite file cache);
    the check uses usage minus inactive_file, as `docker stats` does."""
    from app import resource_guard as g
    files = {
        "/sys/fs/cgroup/memory.current": str(5000 * 2**20) + "\n",
        "/sys/fs/cgroup/memory.stat": f"anon 123\ninactive_file {1500 * 2**20}\nactive_file 9\n",
        "/sys/fs/cgroup/memory.pressure":
            "some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=1.00 avg60=0 avg300=0 total=1\n",
    }
    monkeypatch.setattr(g, "_read", lambda p: files.get(p))
    assert g._working_set_mb() == 3500.0
    assert g._memory_pressure() == 12.5


def test_log_mode_writes_a_row_but_never_blocks(guard, monkeypatch, caplog):
    caplog.set_level(logging.ERROR, logger="app.resource_guard")
    monkeypatch.setenv("REBUILD_GUARD", "log")
    monkeypatch.setattr(guard, "_cgroup_limit_mb", lambda: 5120.0)
    monkeypatch.setattr(guard, "_working_set_mb", lambda: 4900.0)      # even memory
    _feed(guard, monkeypatch, cpu_per_sec=0.95)
    go, token = guard.check_rebuild(60)
    assert go and token is not None
    rows = _rows(caplog)
    assert len(rows) == 1 and "would postpone" in rows[0] and "CPU 95%" in rows[0]
    guard.after_rebuild(token, ok=True)
    assert "flagged rebuild finished after" in _rows(caplog)[1]
    assert guard.check_rebuild(60) == (True, None)    # rate cap: one row per 5 min


def test_enforced_memory_is_a_hard_stop(guard, monkeypatch, caplog):
    """Nov 9 12:51: a rebuild started at 3.7 / 4.0 GB; the container was
    killed a minute later. Enforced, that rebuild waits — however stale."""
    caplog.set_level(logging.ERROR, logger="app.resource_guard")
    assert guard.mode() == "on"                       # the default now
    monkeypatch.setattr(guard, "_cgroup_limit_mb", lambda: 4096.0)
    monkeypatch.setattr(guard, "_working_set_mb", lambda: 3813.0)
    assert guard.check_rebuild(60) == (False, None)
    assert guard.check_rebuild(10 * 3600) == (False, None)
    (row,) = _rows(caplog)                            # one row, then rate-capped
    assert "postponed the Database snapshot rebuild - memory 3.7 / 4.0 GB" in row
    assert "data from 1 min ago" in row
    monkeypatch.setattr(guard, "_working_set_mb", lambda: 2000.0)
    monkeypatch.setattr(guard, "_memory_pressure", lambda: 15.0)
    assert guard.check_rebuild(60) == (False, None)   # pressure counts as memory
    monkeypatch.setattr(guard, "_memory_pressure", lambda: 0.0)
    assert guard.check_rebuild(60) == (True, None)    # recovered: no token, no row


def test_enforced_cpu_postpones_only_until_the_snapshot_is_old(guard, monkeypatch, caplog):
    caplog.set_level(logging.ERROR, logger="app.resource_guard")
    _feed(guard, monkeypatch, cpu_per_sec=0.95)
    assert guard.check_rebuild(10 * 60) == (False, None)          # 10 min old: wait
    monkeypatch.setattr(guard, "_last_report", 0.0)
    go, token = guard.check_rebuild(guard.MAX_POSTPONE_SEC + 1)   # 30 min: go
    assert go and token is not None
    assert "rebuilding the Database snapshot despite CPU 95%" in _rows(caplog)[-1]


def test_quiet_server_and_off_switch_write_nothing(guard, monkeypatch, caplog):
    caplog.set_level(logging.ERROR, logger="app.resource_guard")
    _feed(guard, monkeypatch, cpu_per_sec=0.1)
    assert guard.check_rebuild(60) == (True, None)
    _feed(guard, monkeypatch, cpu_per_sec=0.99)
    monkeypatch.setenv("REBUILD_GUARD", "off")
    assert guard.check_rebuild(60) == (True, None)
    assert _rows(caplog) == []


def test_first_build_is_not_assessed_and_a_postponed_rebuild_waits(guard, monkeypatch):
    from app.routers import database as dbr
    monkeypatch.setattr(dbr, "_rows_cache", {})
    monkeypatch.setattr(dbr, "_rebuild_pending", False)
    monkeypatch.setattr(dbr, "_deferred_rebuild", None)
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: [])
    builds, assessed = [], []
    monkeypatch.setattr(dbr, "_build_and_store_rows", lambda: builds.append(1))
    answer = {"go": True}

    def fake_check(age):
        assessed.append(1)
        return answer["go"], ({"t0": 0, "rss0": None} if answer["go"] else None)
    monkeypatch.setattr(guard, "check_rebuild", fake_check)
    monkeypatch.setattr(guard, "after_rebuild", lambda token, ok: assessed.append(("after", ok)))

    def settle():
        for _ in range(100):
            if not dbr._rebuild_pending:
                return
            time.sleep(0.01)

    dbr._trigger_background_rebuild()                # cold: first build
    settle()
    assert builds == [1] and assessed == [("after", True)]
    dbr._store_rows_cache([], {}, set())
    assessed.clear()
    dbr._trigger_background_rebuild()                # a REbuild: assessed, runs
    settle()
    assert builds == [1, 1] and assessed == [1, ("after", True)]
    assessed.clear()
    answer["go"] = False
    dbr._trigger_background_rebuild()                # postponed: no build, no thread
    assert builds == [1, 1] and assessed == [1] and not dbr._rebuild_pending
    answer["go"] = True
    dbr._trigger_background_rebuild()                # the next trigger asks again
    settle()
    assert builds == [1, 1, 1]


def test_watchdog_feeds_cpu_and_real_loop_delay(guard):
    from app import loop_watchdog as wd

    async def main():
        wd.start(asyncio.get_running_loop(), stall_sec=5, interval=0.05)
        await asyncio.sleep(0.3)
        time.sleep(0.4)                  # hold the loop: pings queue up
        await asyncio.sleep(0.3)
        wd.stop()
    asyncio.run(main())
    delays = [d for _, _, d in guard._ticks]
    assert len(delays) >= 8
    assert max(delays) >= 0.3            # the 0.4 s block was seen
    assert sorted(delays)[len(delays) // 2] < 0.05   # healthy ticks ~0
