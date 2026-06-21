"""Regression net for the quality runner's per-domain write path.

Guards the 2026-06-21 off-load (the runner's synchronous DB helpers now run
in worker threads via asyncio.to_thread so their commits don't block the
event loop during large >300-domain wayback runs). Drives `_process_domain`
for a wayback-only, no-AI domain with `_fetch_criterion` mocked, and asserts
the observable result: the domain finishes `done` and its wayback
CriterionResult is `done` with the fetched CDX rows persisted.

If an off-load edit drops an `await`, the wrapped helper returns a coroutine
instead of its value (e.g. `cr_id` becomes a coroutine) and this test fails
loudly — exactly the mechanical mistake the off-load risks.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile

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
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def test_process_domain_wayback_offloaded(fresh_db, monkeypatch):
    from app import tasks
    from app.models import CriterionResult, Run, RunDomain
    from app.schemas import AnalyzeSpec, CriteriaSpec, WaybackConfig

    session = fresh_db
    run = Run(job_id=0, status="running", spec_json="{}")
    session.add(run)
    session.flush()
    rd = RunDomain(run_id=run.id, domain="hist.example", status="pending")
    session.add(rd)
    session.commit()
    rd_id, run_id = rd.id, run.id

    cdx_rows = [
        {"timestamp": "20200101000000", "original": "http://hist.example/"},
        {"timestamp": "20210101000000", "original": "http://hist.example/a"},
    ]

    async def fake_fetch(url, criterion="backlinks"):
        return True, 200, {"rows": cdx_rows}, "", {}

    monkeypatch.setattr(tasks, "_fetch_criterion", fake_fetch)

    spec = AnalyzeSpec(
        domains=["hist.example"],
        criteria=CriteriaSpec(wayback=WaybackConfig(enabled=True)),
        use_cache=False,
    )

    asyncio.run(tasks._process_domain(rd_id, spec, run_id))

    session.expire_all()
    rd2 = session.get(RunDomain, rd_id)
    assert rd2.status == "done", f"rd status={rd2.status!r}"
    assert rd2.finished_at is not None

    crs = session.query(CriterionResult).filter_by(
        run_domain_id=rd_id, criterion="wayback",
    ).all()
    assert len(crs) == 1, f"expected 1 wayback CR, got {len(crs)}"
    cr = crs[0]
    assert cr.status == "done"
    assert cr.http_status == 200
    body = json.loads(cr.data_json)
    assert "rows" in body and len(body["rows"]) == 2
