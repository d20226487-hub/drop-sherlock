"""Regression net for the retry path's event-loop fixes (2026-10-31).

On the VPS, Wayback runs came with 524/502s. A synthetic 1,000-domain
Wayback auto-retry pass froze the event loop for 2.8 s with no other DB
writer and 40 s with a competing one, because:

1. every sync DB helper in the retry path (`_retry_failed_run_domain`,
   `_reanalyze_run_domain_criterion`) committed ON the loop;
2. the Wayback auto-retry started one task per failed domain at once, so
   the whole batch's setup commits ran back to back;
3. both auto-retry candidate scans walked the full run on the loop.

After the fix the same pass's longest freeze was 0.03-0.08 s. These tests
pin the mechanism deterministically (which thread opens each DB session,
how many retries run at once) rather than with flaky timings.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading

import pytest


@pytest.fixture
def fresh_db(monkeypatch):
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp.name}")
    for name in list(sys.modules):
        if name.startswith("app."):
            del sys.modules[name]
    if "app" in sys.modules:
        del sys.modules["app"]
    from app import db as db_mod
    from app import models  # noqa: F401
    from app.main import _migrate_sqlite_columns
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
    _migrate_sqlite_columns()
    session = db_mod.SessionLocal()
    try:
        yield session
    finally:
        session.close()
        db_mod.engine.dispose()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _wayback_spec(**ai):
    from app.schemas import AnalyzeSpec, CriteriaSpec
    crit = CriteriaSpec()
    for name in ("backlinks", "refdomains", "anchors", "keywords"):
        getattr(crit, name).enabled = False
    crit.wayback.enabled = True
    crit.wayback.sample_pages = True
    crit.wayback_classify.enabled = True
    return AnalyzeSpec(domains=["x.kz"], criteria=crit, use_cache=False)


def _make_failed_wayback_run(session, n, *, ok=0):
    """A finished run whose first `n` domains have a failed wayback CR
    (what the auto-retry picks up) and `ok` more that succeeded."""
    from app.models import CriterionResult, Run, RunDomain
    spec = _wayback_spec()
    run = Run(job_id=0, status="done", spec_json=spec.model_dump_json())
    session.add(run)
    session.flush()
    body = json.dumps({"wayback": [{"timestamp": "20180515123456",
                                    "original": "https://x.kz/"}] * 5})
    ids = []
    for i in range(n + ok):
        failed = i < n
        rd = RunDomain(run_id=run.id, domain=f"d{i}.kz",
                       status="failed" if failed else "done")
        session.add(rd)
        session.flush()
        session.add(CriterionResult(
            run_domain_id=rd.id, criterion="wayback",
            status="failed" if failed else "done",
            data_json="" if failed else body))
        session.add(CriterionResult(
            run_domain_id=rd.id, criterion="wayback_classify",
            status="failed" if failed else "done", data_json="{}"))
        ids.append(rd.id)
    session.commit()
    return run.id, spec, ids


_CFG = {"enabled": True, "max_attempts": 1, "initial_delay_sec": 0,
        "backoff_multiplier": 1}


def _fail_fast(tasks, monkeypatch, delay=0.005, track=None):
    """Fake CDX fetch that times out, optionally counting how many are in
    flight at once."""
    async def fetch(*_a, **_k):
        if track is not None:
            track["now"] += 1
            track["max"] = max(track["max"], track["now"])
        try:
            await asyncio.sleep(delay)
        finally:
            if track is not None:
                track["now"] -= 1
        return False, 0, None, "ReadTimeout (fake)", {}
    monkeypatch.setattr(tasks, "_fetch_criterion", fetch)


def test_auto_retry_pass_opens_no_db_session_on_the_event_loop(
    fresh_db, monkeypatch,
):
    """The core fix. Any session opened on the loop thread is a commit or
    query that can stall every HTTP request behind SQLite's write lock."""
    from app import tasks
    run_id, spec, _ids = _make_failed_wayback_run(fresh_db, 40, ok=10)
    _fail_fast(tasks, monkeypatch)

    real = tasks.SessionLocal
    opened_on: list[int] = []

    def recording_session():
        opened_on.append(threading.get_ident())
        return real()
    monkeypatch.setattr(tasks, "SessionLocal", recording_session)

    async def main():
        loop_thread = threading.get_ident()
        await tasks._wayback_auto_retry_loop(run_id, spec, dict(_CFG))
        return loop_thread

    loop_thread = asyncio.run(main())
    assert opened_on, "the retry pass did not touch the DB at all"
    on_loop = opened_on.count(loop_thread)
    assert on_loop == 0, (
        f"{on_loop} of {len(opened_on)} DB sessions opened on the event loop"
    )


def test_auto_retry_still_retries_every_failed_domain(fresh_db, monkeypatch):
    """Behaviour is unchanged by the off-load: each failed domain gets a
    fresh CDX attempt whose failure is recorded on its CR row."""
    from app import tasks
    from app.models import CriterionResult
    run_id, spec, ids = _make_failed_wayback_run(fresh_db, 12, ok=3)
    calls = {"now": 0, "max": 0}
    _fail_fast(tasks, monkeypatch, track=calls)
    seen: list[int] = []
    real_retry = tasks._retry_failed_run_domain

    async def recording_retry(rd_id, *a, **k):
        seen.append(rd_id)
        return await real_retry(rd_id, *a, **k)
    monkeypatch.setattr(tasks, "_retry_failed_run_domain", recording_retry)

    asyncio.run(tasks._wayback_auto_retry_loop(run_id, spec, dict(_CFG)))

    assert sorted(seen) == sorted(ids[:12])
    fresh_db.expire_all()
    errs = {
        cr.run_domain_id: cr.error for cr in fresh_db.query(CriterionResult)
        .filter(CriterionResult.criterion == "wayback")
        .filter(CriterionResult.run_domain_id.in_(ids[:12]))
    }
    assert all("ReadTimeout (fake)" in (e or "") for e in errs.values()), errs


def test_auto_retry_runs_a_bounded_number_at_once(fresh_db, monkeypatch):
    """It used to start every failed domain at once; now at most
    QUALITY_OUTER_CAP, like the main runner."""
    from app import tasks
    cap = 32  # tasks.QUALITY_OUTER_CAP; literal so the test runs on old code
    run_id, spec, _ids = _make_failed_wayback_run(fresh_db, cap + 20)
    calls = {"now": 0, "max": 0}
    _fail_fast(tasks, monkeypatch, delay=0.05, track=calls)

    asyncio.run(tasks._wayback_auto_retry_loop(run_id, spec, dict(_CFG)))

    assert getattr(tasks, "QUALITY_OUTER_CAP", cap) == cap
    assert calls["max"] <= cap, calls
    assert calls["max"] > 8, (
        "pool fell back to the availability knob (default 8), which would "
        "starve raised wayback rate limits", calls,
    )


def test_resample_flag_is_kept_per_domain(fresh_db, monkeypatch):
    from app import tasks
    run_id, spec, _ids = _make_failed_wayback_run(fresh_db, 1)
    monkeypatch.setattr(
        tasks, "_collect_wayback_retry_candidates",
        lambda _rid, _spec: {
            101: (["wayback", "wayback_classify"], False),
            102: (["wayback", "wayback_classify"], True),
        },
    )
    got: dict[int, bool] = {}

    async def fake_retry(rd_id, _crits, _spec, *, track_set, resample_only=False):
        got[rd_id] = resample_only
    monkeypatch.setattr(tasks, "_retry_failed_run_domain", fake_retry)

    asyncio.run(tasks._wayback_auto_retry_loop(run_id, spec, dict(_CFG)))
    assert got == {101: False, 102: True}


def test_cancel_retry_stops_the_auto_retry_watcher(fresh_db, monkeypatch):
    """The pool registers the watcher under _REANALYZING_RUNS, so the run
    shows as retrying (Cancel retry button) and "Cancel retry" ends the
    watcher outright — no later attempts."""
    from app import tasks
    run_id, spec, _ids = _make_failed_wayback_run(fresh_db, 50)
    _fail_fast(tasks, monkeypatch, delay=30)  # parked mid-fetch
    attempts = {"n": 0}
    real_collect = tasks._collect_wayback_retry_candidates

    def counting_collect(rid, sp):
        attempts["n"] += 1
        return real_collect(rid, sp)
    monkeypatch.setattr(tasks, "_collect_wayback_retry_candidates", counting_collect)

    async def main():
        cfg = dict(_CFG, max_attempts=3)
        tasks._AUTO_RETRY_RUNS.add(run_id)
        watcher = asyncio.create_task(
            tasks._wayback_auto_retry_loop(run_id, spec, cfg))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if tasks.is_reanalyzing_run(run_id):
                break
        assert tasks.is_reanalyzing_run(run_id), "retry not visible to the UI"
        result = tasks.cancel_retry_failed_now(run_id)
        await asyncio.wait_for(asyncio.gather(watcher, return_exceptions=True), 5)
        return result, watcher

    result, watcher = asyncio.run(main())
    assert result["canceled_tasks"] >= 1
    assert watcher.cancelled()
    assert attempts["n"] == 1
    assert run_id not in tasks._AUTO_RETRY_RUNS
    assert not tasks.is_reanalyzing_run(run_id)


def test_auto_retry_respects_an_earlier_cancel(fresh_db, monkeypatch):
    """"Cancel retry" leaves the cancel flag set; the next auto-retry
    attempt must not clear it and start retrying again."""
    from app import tasks
    run_id, spec, _ids = _make_failed_wayback_run(fresh_db, 5)
    dispatched: list[int] = []

    async def fake_retry(rd_id, *_a, **_k):
        dispatched.append(rd_id)
    monkeypatch.setattr(tasks, "_retry_failed_run_domain", fake_retry)

    tasks.request_cancel(run_id)
    asyncio.run(tasks._wayback_auto_retry_loop(run_id, spec, dict(_CFG)))
    assert dispatched == []
    assert tasks.is_canceled(run_id)


def test_availability_candidate_scan_runs_off_the_loop(fresh_db, monkeypatch):
    from app import availability_runner as ar
    from app.models import Run
    run = Run(job_id=0, status="done", spec_json="{}")
    fresh_db.add(run)
    fresh_db.commit()
    scanned_on: list[int] = []

    def fake_collect(_rid, _providers):
        scanned_on.append(threading.get_ident())
        return []
    monkeypatch.setattr(ar, "_collect_availability_retry_candidates", fake_collect)

    async def main():
        await ar._availability_auto_retry_loop(
            run.id, {"initial_delay_sec": 0, "max_attempts": 1})
        return threading.get_ident()

    loop_thread = asyncio.run(main())
    assert scanned_on and loop_thread not in scanned_on


@pytest.mark.parametrize("criterion,clear_final", [
    ("availability", False), ("whois_history", True),
])
def test_pillar_retry_reset(fresh_db, criterion, clear_final):
    """The whois/availability retry resets, now one shared helper, keep
    their old per-branch behaviour (only whois clears the final verdict)."""
    from app import tasks
    from app.models import CriterionResult, Run, RunDomain
    run = Run(job_id=0, status="done", spec_json="{}")
    fresh_db.add(run)
    fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="p.kz", status="failed",
                   error="boom", final_assessment_json='{"v": 1}',
                   final_summary="old")
    fresh_db.add(rd)
    fresh_db.flush()
    fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion=criterion,
                                 status="failed"))
    fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion="other",
                                 status="done"))
    fresh_db.commit()

    assert tasks._reset_run_domain_for_pillar_retry(
        rd.id, criterion, clear_final=clear_final) is True
    assert tasks._reset_run_domain_for_pillar_retry(
        999_999, criterion, clear_final=clear_final) is False

    fresh_db.expire_all()
    rd = fresh_db.get(RunDomain, rd.id)
    assert rd.status == "pending" and rd.error == ""
    assert [cr.criterion for cr in rd.results] == ["other"]
    assert (rd.final_assessment_json == "") is clear_final


def test_busy_timeout_is_short_on_the_loop_and_long_in_threads(fresh_db):
    """Off-loop writers may queue for SQLite's single write lock without
    freezing anything, so they get 30 s before "database is locked"; the
    event-loop thread keeps 5 s because its wait freezes every request."""
    from sqlalchemy import text
    from app.db import SessionLocal

    def busy_ms() -> int:
        s = SessionLocal()
        try:
            return s.execute(text("PRAGMA busy_timeout")).scalar()
        finally:
            s.close()

    async def on_loop_and_in_thread():
        return busy_ms(), await asyncio.to_thread(busy_ms)

    loop_ms, thread_ms = asyncio.run(on_loop_and_in_thread())
    assert loop_ms == 5_000
    assert thread_ms == 30_000
    assert busy_ms() == 30_000  # plain thread, no loop (threadpool endpoints)


# --- Retry failed / Retry selected clicks (2026-10-31) ----------------------
#
# Both routes used to run their whole DB phase — the scan of every RD (60k on
# a big availability run) — on the event loop before starting the pool.

_AVAIL_SPEC = json.dumps({
    "criteria": {
        "backlinks": {"enabled": False}, "refdomains": {"enabled": False},
        "anchors": {"enabled": False}, "keywords": {"enabled": False},
        "wayback": {"enabled": False}, "wayback_classify": {"enabled": False},
        "whois_history": {"enabled": False},
        "availability": {"enabled": True},
    },
    "ai": {"provider": None, "model": None},
    "use_cache": False,
})


def _availability_run(session, n_failed, n_ok=0, kind="availability"):
    from app.models import CriterionResult, Job, Run, RunDomain
    job = Job(name="avail", kind=kind, spec_json=_AVAIL_SPEC)
    session.add(job)
    session.flush()
    run = Run(job_id=job.id, status="done", spec_json=_AVAIL_SPEC)
    session.add(run)
    session.flush()
    ids = []
    for i in range(n_failed + n_ok):
        failed = i < n_failed
        rd = RunDomain(run_id=run.id, domain=f"a{i}.kz",
                       status="failed" if failed else "done")
        session.add(rd)
        session.flush()
        session.add(CriterionResult(
            run_domain_id=rd.id, criterion="availability",
            status="failed" if failed else "done",
            data_json="" if failed else json.dumps(
                {"verdict": {"status": "registered", "provider": "rdap"}})))
        ids.append(rd.id)
    session.commit()
    return run.id, ids


def _record_sessions_on_loop(tasks, monkeypatch):
    """Count DB sessions opened on a thread that is running an event loop
    (the same test db.py uses to pick the busy timeout)."""
    real = tasks.SessionLocal
    seen = {"on_loop": 0, "off_loop": 0}

    def recording_session():
        try:
            asyncio.get_running_loop()
            seen["on_loop"] += 1
        except RuntimeError:
            seen["off_loop"] += 1
        return real()
    monkeypatch.setattr(tasks, "SessionLocal", recording_session)
    return seen


def _fake_pool(tasks, monkeypatch):
    started: dict[int, list[str]] = {}

    async def fake_pool(_run_id, failed_per_rd, _spec, **_kw):
        started.update(failed_per_rd)
    monkeypatch.setattr(tasks, "_run_retry_pool", fake_pool)
    return started


def _client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def test_retry_failed_click_scans_the_run_off_the_loop(fresh_db, monkeypatch):
    from app import tasks
    run_id, ids = _availability_run(fresh_db, 30, n_ok=10)
    seen = _record_sessions_on_loop(tasks, monkeypatch)
    started = _fake_pool(tasks, monkeypatch)

    r = _client().post(f"/runs/{run_id}/retry-failed")

    assert r.status_code == 200, r.text
    assert r.json()["domains"] == 30
    assert seen["off_loop"] >= 1
    assert seen["on_loop"] == 0, seen
    assert sorted(started) == sorted(ids[:30])


def test_retry_selected_click_scans_off_the_loop(fresh_db, monkeypatch):
    from app import tasks
    run_id, ids = _availability_run(fresh_db, 20, n_ok=5)
    seen = _record_sessions_on_loop(tasks, monkeypatch)
    started = _fake_pool(tasks, monkeypatch)
    picked = ids[:5] + ids[20:]  # 5 failed + 5 healthy

    r = _client().post(f"/runs/{run_id}/retry-batch",
                       json={"run_domain_ids": picked})

    assert r.status_code == 200, r.text
    assert r.json()["domains"] == 5
    assert seen["on_loop"] == 0, seen
    assert sorted(started) == sorted(ids[:5])


def test_ahrefs_batch_retry_resets_off_the_loop_and_dispatches_on_it(
    fresh_db, monkeypatch,
):
    """The batch-analysis branch bulk-UPDATEs up to 100k RDs (now in the
    worker thread) but must start its runner on the loop."""
    from app import tasks
    from app.models import RunDomain
    run_id, ids = _availability_run(
        fresh_db, 4, n_ok=2, kind="ahrefs_batch_analysis")
    seen = _record_sessions_on_loop(tasks, monkeypatch)
    dispatched = []

    def fake_dispatch(rid):
        asyncio.get_running_loop()  # raises off the loop
        dispatched.append(rid)
    monkeypatch.setattr(tasks, "dispatch_run", fake_dispatch)

    r = _client().post(f"/runs/{run_id}/retry-failed")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "started" and body["domains"] == 4
    assert "_dispatch_run" not in body
    assert dispatched == [run_id]
    assert seen["on_loop"] == 0, seen
    fresh_db.expire_all()
    assert {fresh_db.get(RunDomain, i).status for i in ids[:4]} == {"pending"}
    assert {fresh_db.get(RunDomain, i).status for i in ids[4:]} == {"done"}


def test_dispatch_rechecks_for_a_retry_started_during_the_scan(
    fresh_db, monkeypatch,
):
    """With the scan in a worker thread, another retry can start before
    the pool does; the loop phase must refuse rather than double-dispatch."""
    from app import tasks
    run_id, _ids = _availability_run(fresh_db, 3)
    started = _fake_pool(tasks, monkeypatch)
    real_plan = tasks._plan_retry_failed

    async def main():
        other = asyncio.create_task(asyncio.sleep(30))

        def plan_then_race(rid, override):
            plan = real_plan(rid, override)
            tasks._REANALYZING_RUNS.add_task(rid, other)  # the racing retry
            return plan
        monkeypatch.setattr(tasks, "_plan_retry_failed", plan_then_race)
        try:
            return await tasks.retry_failed_run(run_id)
        finally:
            other.cancel()
            tasks._REANALYZING_RUNS.discard(run_id)

    result = asyncio.run(main())
    assert result.get("error") == "a run-level reanalysis is already in progress"
    assert started == {}
