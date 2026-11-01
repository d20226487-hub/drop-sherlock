"""GET /runs/{id}/cost (2026-11-01).

The run page polls /cost every 2 s. It used to load every RunDomain and
every CriterionResult of the run (data_json included) just to add up a few
numeric columns: on a 18k-domain availability run, 0.56 s and 36k ORM
objects per tick; on a 1k-domain Wayback run, 35 MB of JSON per tick. It
now aggregates in SQL. The golden test pins the exact output across every
branch, and passed against the old implementation before the rewrite.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime

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


PRICED = {("gemini", "gemini-2.5-flash")}


@pytest.fixture
def priced(monkeypatch):
    import app.app_settings as s
    monkeypatch.setattr(
        s, "get_model_price",
        lambda p, m: (0.3, 2.5) if (p, m) in PRICED else None)
    monkeypatch.setattr(s, "get_whois_history_units_per_request", lambda: 3)


def _seed(db):
    from app.models import CriterionResult, Run, RunDomain
    run = Run(job_id=0, status="done", spec_json="{}", error="")
    other = Run(job_id=0, status="done", spec_json="{}", error="")
    db.add_all([run, other])
    db.flush()
    now = datetime(2026, 11, 1)

    def rd(run_id, **kw):
        r = RunDomain(run_id=run_id, domain=f"d{id(kw)}.kz", status="done",
                      error="", **kw)
        db.add(r)
        db.flush()
        return r.id

    def cr(rd_id, criterion, **kw):
        db.add(CriterionResult(run_domain_id=rd_id, criterion=criterion,
                               status=kw.pop("status", "done"),
                               data_json=kw.pop("data_json", "{}"), **kw))

    fa = lambda p, m: json.dumps({"provider": p, "model": m, "verdict": "x"})  # noqa: E731
    a = rd(run.id, final_input_tokens=100, final_output_tokens=50,
           final_cost_usd=0.25, final_assessment_json=fa("gemini", "gemini-2.5-flash"))
    b = rd(run.id, final_input_tokens=10, final_output_tokens=None,
           final_cost_usd=0.0, final_assessment_json=fa("openrouter", "mystery-model"))
    c = rd(run.id, final_cost_usd=None, final_input_tokens=7,       # not counted as fresh
           final_assessment_json="{not json")
    d = rd(run.id, final_cost_usd=0.0)                              # cost 0, no tokens: not fresh
    # AI on criteria
    cr(a, "wayback", ai_input_tokens=1000, ai_output_tokens=200, ai_cost_usd=0.5,
       ai_verdict_json='{"v":1}', ai_provider="gemini", ai_model="gemini-2.5-flash",
       units_cost_actual=999, units_cost_total=999)                 # wayback: never Ahrefs units
    cr(b, "wayback_classify", ai_input_tokens=300, ai_output_tokens=30, ai_cost_usd=0.125,
       ai_verdict_json='{"v":1}', ai_cached_from_run_id=42,          # cache hit
       ai_provider="gemini", ai_model="gemini-2.5-pro")             # unpriced
    cr(c, "keywords", ai_verdict_json="", ai_input_tokens=0, ai_cost_usd=None,
       ai_provider="gemini", ai_model="")                           # no model -> not "seen"
    # Ahrefs criteria
    cr(a, "backlinks", units_cost_actual=120, units_cost_total=150)
    cr(b, "refdomains", units_cost_actual=None, units_cost_total=80, cached_from_run_id=7)
    cr(c, "stop_words", units_cost_actual=40, units_cost_total=None)
    cr(d, "anchors")                                                # neither fresh nor cached
    # WhoisFreaks
    cr(a, "whois_history", fetched_at=now)                          # fresh
    cr(b, "whois_history", fetched_at=now, cached_from_run_id=3)    # cached
    cr(c, "whois_history", fetched_at=now, error="boom")            # failed: not billed
    cr(d, "whois_history", fetched_at=None)                         # never reached provider
    # Another run: must not leak in.
    z = rd(other.id, final_cost_usd=9.0, final_input_tokens=9)
    cr(z, "backlinks", units_cost_actual=5000, ai_cost_usd=9.0, ai_input_tokens=9,
       ai_verdict_json='{"v":1}', ai_provider="x", ai_model="y")
    db.commit()
    return run.id


EXPECTED = {
    "total_cost_usd": 0.875,          # 0.5 + 0.125 (CRs) + 0.25 + 0.0 + 0.0 (RDs)
    "total_input_tokens": 1417,       # 1000 + 300 + 100 + 10 + 7
    "total_output_tokens": 280,       # 200 + 30 + 50
    "fresh_calls": 3,                 # wayback AI + RD a + RD b (tokens, cost 0)
    "cache_hits": 1,
    "missing_pricing": [
        {"provider": "gemini", "model": "gemini-2.5-pro"},
        {"provider": "openrouter", "model": "mystery-model"},
    ],
    "ahrefs_units_billed": 160,       # 120 + 40
    "ahrefs_units_list": 230,         # 150 + 80
    "ahrefs_fresh_calls": 2,
    "ahrefs_cached_calls": 1,
    "whois_fresh_calls": 1,
    "whois_cached_calls": 1,
    "whois_units_per_request": 3,
    "whois_units_billed": 3,
}


def test_cost_totals_are_unchanged(fresh_db, priced):
    from app.routers.jobs import get_run_cost
    run_id = _seed(fresh_db)
    assert get_run_cost(run_id, fresh_db) == EXPECTED


def test_cost_of_a_run_without_domains(fresh_db, priced):
    from app.models import Run
    from app.routers.jobs import get_run_cost
    run = Run(job_id=0, status="done", spec_json="{}", error="")
    fresh_db.add(run)
    fresh_db.commit()
    out = get_run_cost(run.id, fresh_db)
    assert out["total_cost_usd"] == 0.0 and out["fresh_calls"] == 0
    assert out["missing_pricing"] == []


def test_cost_unknown_run_is_404(fresh_db, priced):
    from fastapi import HTTPException
    from app.routers.jobs import get_run_cost
    with pytest.raises(HTTPException) as e:
        get_run_cost(999, fresh_db)
    assert e.value.status_code == 404


def test_cost_loads_no_domain_or_result_objects(fresh_db, priced):
    """The point of the rewrite: no ORM hydration of the run's rows (each
    tick used to pull the whole run, data_json and all)."""
    from sqlalchemy import event
    from app.models import CriterionResult, RunDomain
    from app.routers.jobs import get_run_cost
    run_id = _seed(fresh_db)
    fresh_db.expunge_all()
    loaded = []

    def on_load(target, _ctx):
        loaded.append(type(target).__name__)

    for cls in (RunDomain, CriterionResult):
        event.listen(cls, "load", on_load)
    try:
        assert get_run_cost(run_id, fresh_db) == EXPECTED
    finally:
        for cls in (RunDomain, CriterionResult):
            event.remove(cls, "load", on_load)
    assert loaded == [], f"loaded {len(loaded)} ORM rows"
