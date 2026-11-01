"""Slow-request log (2026-11-01): SLOW_REQUEST_LOG_SEC=N writes one
error_log row per request slower than N seconds, naming the endpoint, its
duration and what it loaded from the database."""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import tempfile
import time

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
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
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


def _app(monkeypatch, threshold="0.15"):
    """A small app with the switch on and routes shaped like the real
    offenders: a sync (threadpool) endpoint that loads rows, an async one
    that offloads, a fast one and an SSE-style stream."""
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from app import slow_requests
    from app.db import Base, SessionLocal, engine
    from app.models import RunDomain

    monkeypatch.setenv("SLOW_REQUEST_LOG_SEC", threshold)
    monkeypatch.setattr(slow_requests, "_window_rows", 0)
    monkeypatch.setattr(slow_requests, "_suppressed", 0)
    app = FastAPI()

    def load_rows(n: int):
        s = SessionLocal()
        try:
            return len(s.query(RunDomain).limit(n).all())
        finally:
            s.close()

    @app.get("/runs/{run_id}/heavy")
    def heavy(run_id: int):
        n = load_rows(5)
        time.sleep(0.2)
        return {"n": n}

    @app.get("/offloaded")
    async def offloaded():
        n = await asyncio.to_thread(load_rows, 3)
        await asyncio.sleep(0.2)
        return {"n": n}

    @app.get("/fast")
    def fast():
        return {"ok": True}

    @app.get("/runs/{run_id}/events")
    def events(run_id: int):
        def gen():
            time.sleep(0.3)
            yield b"data: x\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    assert slow_requests.install(app, engine, Base) is True
    return app


def _seed(db, n=6):
    from app.models import Run, RunDomain
    run = Run(job_id=0, status="done", spec_json="{}", error="")
    db.add(run)
    db.flush()
    for i in range(n):
        db.add(RunDomain(run_id=run.id, domain=f"d{i}.kz", status="done",
                         error="", final_summary="s" * 100))
    db.commit()


def _rows(caplog):
    return [r for r in caplog.records
            if r.name == "app.slow_requests" and r.levelno == logging.ERROR]


def _get(app, *urls):
    from fastapi.testclient import TestClient
    with TestClient(app) as client:
        for u in urls:
            assert client.get(u).status_code == 200
        time.sleep(0.3)  # the row is written from an executor thread


def test_off_by_default(monkeypatch):
    from fastapi import FastAPI
    from app import slow_requests
    from app.db import Base, engine
    monkeypatch.delenv("SLOW_REQUEST_LOG_SEC", raising=False)
    assert slow_requests.install(FastAPI(), engine, Base) is False
    monkeypatch.setenv("SLOW_REQUEST_LOG_SEC", "0")
    assert slow_requests.threshold_sec() is None
    monkeypatch.setenv("SLOW_REQUEST_LOG_SEC", "junk")
    assert slow_requests.threshold_sec() is None


def test_slow_request_row_names_endpoint_duration_and_rows(
    fresh_db, monkeypatch, caplog,
):
    caplog.set_level(logging.ERROR, logger="app.slow_requests")
    _seed(fresh_db)
    app = _app(monkeypatch)
    _get(app, "/runs/7/heavy?limit=0", "/fast")

    rows = _rows(caplog)
    assert len(rows) == 1, [r.getMessage() for r in rows]
    msg = rows[0].getMessage()
    assert "GET /runs/{run_id}/heavy took" in msg          # route template
    assert "URL: /runs/7/heavy?limit=0" in msg              # actual request
    assert "(status 200)" in msg
    assert "loaded 5 rows (RunDomain 5)" in msg             # threadpool endpoint counted
    assert "SQL statements" in msg
    took = float(msg.split(" took ")[1].split(" s ")[0])
    assert took >= 0.2


def test_offloaded_work_is_counted(fresh_db, monkeypatch, caplog):
    """asyncio.to_thread runs on a copy of the context; the counter object
    is shared, so those loads still land on the request."""
    caplog.set_level(logging.ERROR, logger="app.slow_requests")
    _seed(fresh_db)
    _get(_app(monkeypatch), "/offloaded")
    msg = _rows(caplog)[0].getMessage()
    assert "loaded 3 rows (RunDomain 3)" in msg


def test_row_is_written_off_the_event_loop(fresh_db, monkeypatch, caplog):
    """error_log persistence is a sync SQLite write; it must not run on
    the loop it is reporting on."""
    caplog.set_level(logging.ERROR, logger="app.slow_requests")
    _seed(fresh_db)
    _get(_app(monkeypatch), "/runs/1/heavy")
    rec = _rows(caplog)[0]
    assert rec.threadName.startswith("asyncio_"), rec.threadName


def test_event_streams_are_skipped(fresh_db, monkeypatch, caplog):
    caplog.set_level(logging.ERROR, logger="app.slow_requests")
    _get(_app(monkeypatch), "/runs/1/events")
    assert _rows(caplog) == []


def test_rows_are_rate_capped(fresh_db, monkeypatch, caplog):
    from app import slow_requests
    caplog.set_level(logging.ERROR, logger="app.slow_requests")
    _seed(fresh_db)
    app = _app(monkeypatch)
    monkeypatch.setattr(slow_requests, "_MAX_ROWS_PER_WINDOW", 1)
    monkeypatch.setattr(slow_requests, "_window_start", time.monotonic())
    _get(app, "/runs/1/heavy", "/runs/2/heavy", "/runs/3/heavy")
    assert len(_rows(caplog)) == 1
    assert slow_requests._suppressed == 2
