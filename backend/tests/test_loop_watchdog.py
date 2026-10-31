"""Coverage for the event-loop stall watchdog (added 2026-10-30).

The 524s during Wayback runs on the VPS survived two targeted fixes, so
the watchdog exists to name what actually holds the loop. These tests pin
that a stall report carries what is needed to tell the suspects apart:
the loop's own stack, busy threads, scheduled jobs that overlapped, and
gen-2 GC pauses — and that a healthy loop stays silent.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

import pytest


@pytest.fixture
def wd(caplog):
    from app import loop_watchdog
    caplog.set_level(logging.ERROR, logger="app.loop_watchdog")
    yield loop_watchdog
    loop_watchdog.stop()
    loop_watchdog._active.clear()
    loop_watchdog._finished.clear()
    loop_watchdog._gc_pauses.clear()


def _messages(caplog, word):
    return [
        r.getMessage() for r in caplog.records
        if r.name == "app.loop_watchdog" and word in r.getMessage()
    ]


def _blocking_culprit(seconds):
    """Stands in for a sync call that holds the loop."""
    time.sleep(seconds)


def _run(wd, body, stall_sec=0.3):
    async def main():
        wd.start(asyncio.get_running_loop(), stall_sec=stall_sec, interval=0.05)
        await asyncio.sleep(0.2)  # first ping lands
        await body()
        await asyncio.sleep(0.3)  # recovery is observed
        wd.stop()
    asyncio.run(main())


def test_stall_report_names_the_blocking_code(wd, caplog):
    async def body():
        _blocking_culprit(1.0)

    _run(wd, body)

    stalled = _messages(caplog, "stalled")
    assert len(stalled) == 1, stalled
    assert "_blocking_culprit" in stalled[0]
    assert "test_loop_watchdog.py" in stalled[0]
    recovered = _messages(caplog, "recovered")
    assert len(recovered) == 1, recovered
    dur = float(re.search(r"after a ([\d.]+)s stall", recovered[0]).group(1))
    assert 0.7 <= dur <= 1.6, dur


def test_report_reaches_stderr_even_if_error_log_write_fails(wd, capsys):
    """The stall most worth reporting — a held SQLite write lock — is the
    one where the error_log insert can fail; `docker logs` must still get
    it. The root logger has no stderr handler of its own."""
    async def body():
        _blocking_culprit(0.8)

    _run(wd, body)
    err = capsys.readouterr().err
    assert "event loop stalled" in err and "_blocking_culprit" in err
    assert "event loop recovered" in err


def test_healthy_loop_is_silent(wd, caplog):
    async def body():
        # Busy but cooperative: never holds the loop for long.
        for _ in range(20):
            _blocking_culprit(0.02)
            await asyncio.sleep(0.03)

    _run(wd, body)
    assert _messages(caplog, "") == []


def test_overlapping_scheduler_job_and_busy_thread_are_named(wd, caplog):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    def slow_scheduled_job():
        time.sleep(1.5)

    async def body():
        sched = AsyncIOScheduler(timezone="UTC")
        wd.watch_scheduler(sched)
        sched.start()
        sched.add_job(slow_scheduled_job, id="slow_job")
        await asyncio.sleep(0.3)  # submitted and running in its thread
        _blocking_culprit(0.8)
        await asyncio.sleep(1.0)  # job finishes, EXECUTED event lands
        sched.shutdown(wait=False)

    _run(wd, body)

    stalled = _messages(caplog, "stalled")
    assert len(stalled) == 1, stalled
    assert "job:slow_job (running" in stalled[0]
    assert "slow_scheduled_job" in stalled[0]  # listed under busy threads
    assert wd._active.get("job:slow_job") == []  # begin/end paired


def test_finished_job_is_named_in_the_recovery_line(wd, caplog):
    async def body():
        wd.begin("job:malloc_trim")
        _blocking_culprit(0.6)
        wd.end("job:malloc_trim")
        _blocking_culprit(0.4)

    _run(wd, body)

    assert "job:malloc_trim (running" in _messages(caplog, "stalled")[0]
    assert "job:malloc_trim (took" in _messages(caplog, "recovered")[0]


def test_gen2_gc_pause_is_reported(wd, caplog):
    async def body():
        # A real multi-second gen-2 collection can't be produced on demand;
        # drive the callback around a block the way the GC would.
        wd._gc_callback("start", {"generation": 2})
        _blocking_culprit(0.8)
        wd._gc_callback("stop", {"generation": 2})

    _run(wd, body)
    assert "longest gen2 GC during stall=" in _messages(caplog, "stalled")[0]
    assert "longest gen2 GC during stall=0.8" in _messages(caplog, "recovered")[0]


def test_young_generations_are_ignored(wd):
    wd._gc_callback("start", {"generation": 0})
    wd._gc_callback("stop", {"generation": 0})
    assert wd._gc_pauses == []


def test_reports_are_capped(wd, caplog, monkeypatch):
    monkeypatch.setattr(wd, "_MAX_REPORTS_PER_HOUR", 1)

    async def body():
        _blocking_culprit(0.6)
        await asyncio.sleep(0.3)
        _blocking_culprit(0.6)

    _run(wd, body)
    assert len(_messages(caplog, "stalled")) == 1
    assert len(_messages(caplog, "recovered")) == 1


def test_env_switch_disables_it(wd, monkeypatch):
    monkeypatch.setenv("LOOP_WATCHDOG", "0")

    async def main():
        return wd.start(asyncio.get_running_loop())

    assert asyncio.run(main()) is False
    assert wd._watchdog is None


def test_stop_ends_the_thread_and_unhooks_gc(wd):
    import gc

    async def main():
        wd.start(asyncio.get_running_loop(), stall_sec=5, interval=0.05)
        thread = wd._watchdog.thread
        assert wd.start(asyncio.get_running_loop()) is True  # idempotent
        assert wd._watchdog.thread is thread
        wd.stop()
        return thread

    thread = asyncio.run(main())
    assert not thread.is_alive()
    assert wd._gc_callback not in gc.callbacks
    assert not [h for h in wd.log.handlers if getattr(h, "_loop_watchdog", False)]


def test_memory_high_water_logs_each_new_step_once(wd, caplog, monkeypatch):
    """A 502 'Host: Error' means the process was down, and the prime suspect
    is an OOM kill at the 5 GB container limit. Each new 512 MB step above
    2 GB logs once, so the last row before a restart shows how close it got."""
    readings = iter([1500, 2100, 2200, 2500, 3700, 3800, 2000, 4100])
    monkeypatch.setattr(wd, "_rss_mb", lambda: next(readings))
    monkeypatch.setattr(wd, "_cgroup_limit_mb", lambda: 5120.0)
    w = wd._Watchdog(None, 0, stall_sec=5, interval=1)
    for _ in range(8):
        w._check_memory(time.monotonic())

    rows = _messages(caplog, "memory high-water")
    assert [re.search(r"rss=(\d+)MB", m).group(1) for m in rows] == [
        "2100", "3700", "4100",
    ]
    assert "of 5120MB container limit" in rows[0]


def test_memory_probe_is_silent_without_proc(wd, caplog, monkeypatch):
    monkeypatch.setattr(wd, "_rss_mb", lambda: None)
    wd._Watchdog(None, 0, stall_sec=5, interval=1)._check_memory(0.0)
    assert _messages(caplog, "memory") == []
