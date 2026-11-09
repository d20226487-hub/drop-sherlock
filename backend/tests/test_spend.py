"""Spend log (added 2026-11-09): what gets recorded, how it is priced, the
Dashboard summary math, and the one-time import of past jobs."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import date, datetime

import pytest
from sqlalchemy import text


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


@pytest.fixture
def sp(fresh_db):
    from app import spend
    spend._reset_for_tests()
    return spend


def _events(db):
    from app.models import UsageEvent
    db.expire_all()
    return db.query(UsageEvent).order_by(UsageEvent.id).all()


def _price(db, provider, model, rate_in, rate_out):
    from app.models import ModelPricing
    db.merge(ModelPricing(provider=provider, model=model, input_per_million=rate_in,
                          output_per_million=rate_out, updated_at=datetime.utcnow()))
    db.commit()


def _run(db, kind="quality"):
    from app.models import Job, Run, RunDomain
    job = Job(name="j", notes="", spec_json="{}", kind=kind)
    db.add(job)
    db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}", error="")
    db.add(run)
    db.flush()
    rd = RunDomain(run_id=run.id, domain="a.kz", status="done", error="")
    db.add(rd)
    db.commit()
    return job, run, rd


# ---- Recording -------------------------------------------------------------------

def test_gemini_usage_counts_thinking_as_output(fresh_db):
    from app.ai_judge import gemini_usage
    u = gemini_usage({"promptTokenCount": 1000, "candidatesTokenCount": 3,
                      "thoughtsTokenCount": 346, "totalTokenCount": 1349})
    assert u == {"input_tokens": 1000, "output_tokens": 349, "thinking_tokens": 346}
    # A bucket this code doesn't know yet: trust the total over the parts.
    u = gemini_usage({"promptTokenCount": 10, "candidatesTokenCount": 5,
                      "totalTokenCount": 40})
    assert u["output_tokens"] == 30
    assert gemini_usage({})["output_tokens"] == 0


def test_every_ai_call_is_logged_with_its_context_and_price(fresh_db, sp, monkeypatch):
    from app import ai_judge
    job, run, rd = _run(fresh_db)
    _price(fresh_db, "gemini", "flash", 0.5, 2.0)
    _price(fresh_db, "gemini", "unpriced", 0.0, 0.0)   # auto-seeded 0/0 = not set
    replies = iter([('{"ok": 1}', 100), ("not json at all", 200), ('{"ok": 2}', 300)])

    async def fake_gemini(**_kw):
        body, out = next(replies)
        return body, {"input_tokens": 1_000_000, "output_tokens": out, "thinking_tokens": 7}
    monkeypatch.setattr(ai_judge, "_judge_gemini", fake_gemini)

    async def go():
        with sp.tag(feature="backlinks", run_domain_id=rd.id, domain="a.kz"):
            await ai_judge.judge(provider="gemini", system_prompt="s", user_message="u",
                                 model_override="flash")
            with pytest.raises(ValueError):
                await ai_judge.judge(provider="gemini", system_prompt="s",
                                     user_message="u", model_override="flash")
        await ai_judge.judge(provider="gemini", system_prompt="s", user_message="u",
                             model_override="unpriced")
    asyncio.run(go())
    assert sp.flush() == 3
    first, bad, untagged = _events(fresh_db)
    assert (first.kind, first.provider, first.model, first.feature) == ("ai", "gemini", "flash", "backlinks")
    # run and job are filled from the run-domain the tag carried
    assert (first.run_domain_id, first.run_id, first.job_id) == (rd.id, run.id, job.id)
    assert first.cost_usd == pytest.approx(0.5 + 100 * 2.0 / 1e6)
    assert first.thinking_tokens == 7 and first.ok
    assert not bad.ok and bad.cost_usd == pytest.approx(0.5 + 200 * 2.0 / 1e6)  # billed anyway
    assert untagged.feature == "" and untagged.cost_usd is None   # 0/0 isn't a price


def test_tagged_decorator_reads_the_call_arguments(sp):
    @sp.tagged(feature_from="criterion")
    async def work(run_domain_id, *, criterion, domain):
        sp.record_ahrefs("https://api.ahrefs.com/v3/site-explorer/backlinks?x=1",
                         billed=40, listed=50)

    asyncio.run(work(9, criterion="anchors", domain="b.kz"))
    (ev,) = sp._buf
    assert (ev["feature"], ev["run_domain_id"], ev["domain"]) == ("anchors", 9, "b.kz")
    assert (ev["model"], ev["units"], ev["units_list"]) == ("site-explorer/backlinks", 40, 50)


def test_ahrefs_batch_chunk_logs_billed_units(fresh_db, sp):
    import httpx
    from app.providers.ahrefs_batch import fetch_batch_chunk

    def handler(_req):
        return httpx.Response(200, json={"targets": [{"domain_rating": 10}]},
                              headers={"x-api-units-cost-total": "120",
                                       "x-api-units-cost-total-actual": "100"})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            with sp.tag(feature="batch_analysis"):
                await fetch_batch_chunk(c, "key", ["a.kz"], ["domain_rating"])
    asyncio.run(go())
    sp.flush()
    (ev,) = _events(fresh_db)
    assert (ev.kind, ev.model, ev.feature, ev.units, ev.units_list) == (
        "ahrefs", "batch-analysis/batch-analysis", "batch_analysis", 100, 120)


def test_paid_availability_lookups_are_merged_and_errors_skipped(fresh_db, sp):
    from app.availability.cascade import _metered
    from app.availability.common import ProviderResult
    job, run, _rd = _run(fresh_db, kind="availability")
    with sp.tag(feature="availability", run_id=run.id):
        _metered(ProviderResult(provider="domainr", status="registered"))
        _metered(ProviderResult(provider="domainr", status="available"))
        _metered(ProviderResult(provider="domainr", status="error"))
        _metered(ProviderResult(provider="whoisfreaks", status="unknown"))
    sp.flush()
    rows = {(e.provider, e.calls, e.units, e.job_id) for e in _events(fresh_db)}
    assert rows == {("domainr", 2, 2, job.id), ("whoisfreaks", 1, 1, job.id)}


def test_a_failed_write_keeps_the_events(fresh_db, sp, monkeypatch):
    sp.record_units("whois_history", "whoisfreaks", 1)

    def boom(_batch):
        raise RuntimeError("database is locked")
    monkeypatch.setattr(sp, "_write", boom)
    assert sp.flush() == 0 and len(sp._buf) == 1
    monkeypatch.undo()
    assert sp.flush() == 1


# ---- Summary --------------------------------------------------------------------

TODAY = date(2026, 11, 9)


def _ev(db, day, kind, provider="", model="", **kw):
    from app.models import UsageEvent
    db.add(UsageEvent(created_at=datetime.fromisoformat(day + " 12:00"), kind=kind,
                      provider=provider, model=model, feature=kw.pop("feature", kind), **kw))


def _seed_summary(db, sp):
    _price(db, "gemini", "flash", 0.3, 2.5)
    _price(db, "vertex_ai", "pro", 1.25, 10.0)           # set AFTER its calls
    _ev(db, "2026-11-05", "ai", "gemini", "flash", input_tokens=1_000_000,
        output_tokens=1_000_000, cost_usd=2.8)
    _ev(db, "2026-11-06", "ai", "vertex_ai", "pro", input_tokens=1_000_000, cost_usd=None)
    _ev(db, "2026-11-07", "ai", "openrouter", "x", input_tokens=5, cost_usd=None)
    _ev(db, "2026-10-15", "ai", "gemini", "flash", input_tokens=10, cost_usd=1.0)
    _ev(db, "2026-11-02", "ahrefs", "ahrefs", feature="backlinks", units=3_000_000)
    _ev(db, "2026-11-08", "ahrefs", "ahrefs", feature="linked_domains", units=2_500_000)
    _ev(db, "2026-10-20", "ahrefs", "ahrefs", feature="backlinks", units=1_000_000)
    _ev(db, "2026-11-03", "whois_history", "whoisfreaks", units=10)
    _ev(db, "2026-11-04", "availability", "domainr", calls=100, units=100)
    db.commit()
    sp.set_pricing({"whoisfreaks_usd_per_credit": 0.01})


def test_summary_this_month(fresh_db, sp):
    _seed_summary(fresh_db, sp)
    s = sp.summary("this_month", today=TODAY)
    assert s["ai"]["usd"] == pytest.approx(2.8 + 1.25)      # vertex estimated now
    assert s["ai"]["estimated_usd"] == pytest.approx(1.25)
    assert s["ai"]["unpriced_calls"] == 1
    assert s["unpriced_models"] == [{"provider": "openrouter", "model": "x", "calls": 1}]
    # 5.5M Ahrefs units this month, 4M included, $50 per 1M above
    assert s["ahrefs"]["units"] == 5_500_000 and s["ahrefs"]["usd"] == pytest.approx(75.0)
    assert s["whois_history"]["usd"] == pytest.approx(0.1) and s["whois_history"]["priced"]
    assert s["availability"]["calls"] == 100 and not s["availability"]["priced"]
    assert s["total_usd"] == pytest.approx(4.05 + 75 + 0.1)
    by_model = {(r["provider"], r["model"]): r for r in s["ai_models"]}
    assert by_model[("vertex_ai", "pro")]["estimated_usd"] == pytest.approx(1.25)
    feats = {(f["kind"], f["feature"]): f for f in s["features"]}
    assert feats[("ahrefs", "linked_domains")]["units"] == 2_500_000


def test_summary_other_periods_and_months(fresh_db, sp):
    _seed_summary(fresh_db, sp)
    last = sp.summary("last_month", today=TODAY)
    assert last["ai"]["usd"] == pytest.approx(1.0)
    assert last["ahrefs"]["units"] == 1_000_000 and last["ahrefs"]["usd"] == 0
    week = sp.summary("last_7_days", today=TODAY)          # Nov 3 – Nov 9
    assert week["ahrefs"]["units"] == 2_500_000
    assert week["ahrefs"]["usd"] is None                   # Ahrefs $ only per month
    assert week["total_usd"] == pytest.approx(4.05 + 0.1)
    every = sp.summary("all_time", today=TODAY)
    assert every["total_usd"] == pytest.approx(5.05 + 75 + 0.1)
    months = {m["month"]: m for m in every["months"]}
    assert months["2026-11"]["total_usd"] == pytest.approx(79.15)
    assert months["2026-10"]["ahrefs_usd"] == 0 and months["2026-10"]["ai_usd"] == 1.0
    with pytest.raises(ValueError):
        sp.summary("forever", today=TODAY)


def test_by_job_and_a_specific_month(fresh_db, sp):
    from app.models import Job
    big = Job(name="Big quality run", notes="", spec_json="{}", kind="quality")
    linked = Job(name="", notes="", spec_json="{}", kind="linked_domains")
    fresh_db.add_all([big, linked])
    fresh_db.flush()
    _ev(fresh_db, "2026-11-02", "ahrefs", "ahrefs", units=3_000_000, job_id=big.id)
    _ev(fresh_db, "2026-11-08", "ahrefs", "ahrefs", units=2_500_000, job_id=linked.id)
    _ev(fresh_db, "2026-11-04", "ahrefs", "ahrefs", units=500_000)          # Tools page
    _ev(fresh_db, "2026-11-05", "ai", "gemini", "flash", cost_usd=2.8, job_id=big.id)
    _ev(fresh_db, "2026-11-06", "ai", "gemini", "flash", cost_usd=1.0, job_id=999)  # deleted
    _ev(fresh_db, "2026-10-06", "ai", "gemini", "flash", cost_usd=7.0, job_id=big.id)
    fresh_db.commit()

    s = sp.summary("2026-11", today=TODAY)
    assert s["start"] == "2026-11-01" and s["end"] == "2026-12-01"
    # 6M units in November: 2M over the 4M allowance = $100, split by share
    assert s["ahrefs"]["usd"] == pytest.approx(100.0)
    jobs = {r["job_id"]: r for r in s["jobs"]}
    assert jobs[big.id]["ahrefs_usd"] == pytest.approx(50.0)
    assert jobs[big.id]["total_usd"] == pytest.approx(52.8)            # Oct not included
    assert (jobs[big.id]["name"], jobs[big.id]["job_kind"]) == ("Big quality run", "quality")
    assert jobs[linked.id]["ahrefs_usd"] == pytest.approx(100 * 2.5 / 6)
    assert jobs[None]["ahrefs_usd"] == pytest.approx(100 * 0.5 / 6) and not jobs[None]["deleted"]
    assert jobs[999]["deleted"] and jobs[999]["ai_usd"] == pytest.approx(1.0)
    assert s["jobs"][0]["job_id"] == big.id                             # biggest first
    assert sp.summary("all_time", today=TODAY)["months_available"] == ["2026-11", "2026-10"]
    week = sp.summary("last_7_days", today=TODAY)
    assert all(r["ahrefs_usd"] is None for r in week["jobs"])
    with pytest.raises(ValueError):
        sp.summary("2026-13", today=TODAY)


def test_summary_folds_in_new_events_and_survives_a_restore(fresh_db, sp):
    _seed_summary(fresh_db, sp)
    assert sp.summary("all_time", today=TODAY)["ai"]["calls"] == 4
    _ev(fresh_db, "2026-11-09", "ai", "gemini", "flash", input_tokens=1, cost_usd=0.5)
    fresh_db.commit()
    s = sp.summary("all_time", today=TODAY)                # only the new row is read
    assert s["ai"]["calls"] == 5 and s["ai"]["usd"] == pytest.approx(5.55)
    fresh_db.execute(text("DELETE FROM usage_events WHERE id > 3"))   # e.g. a backup restore
    fresh_db.commit()
    assert sp.summary("all_time", today=TODAY)["ai"]["calls"] == 3


# ---- Import of past jobs ------------------------------------------------------------

def test_backfill_imports_past_spend_once(fresh_db, sp):
    from app.models import AvailabilityCheck, CriterionResult
    job, run, rd = _run(fresh_db)
    rd.final_input_tokens, rd.final_output_tokens, rd.final_cost_usd = 300, 100, 0.0
    rd.last_analyzed_at = datetime(2026, 10, 2)
    _, run2, rd2 = _run(fresh_db)
    rd2.last_analyzed_at = datetime(2026, 10, 3)

    def cr(rd_id, criterion, **kw):
        fresh_db.add(CriterionResult(run_domain_id=rd_id, criterion=criterion, status="done",
                                     request_url="", error="", data_json="{}",
                                     fetched_at=kw.pop("fetched_at", datetime(2026, 10, 1)),
                                     **kw))
    cr(rd.id, "backlinks", units_cost_actual=500, units_cost_total=600, ai_provider="gemini",
       ai_model="flash", ai_input_tokens=1000, ai_output_tokens=200, ai_cost_usd=0.0)
    cr(rd.id, "wayback", ai_provider="gemini", ai_model="flash", ai_input_tokens=100,
       ai_output_tokens=50, ai_cost_usd=0.5)
    cr(rd.id, "whois_history")
    # cache copies cost nothing; rows after the cutoff are recorded live
    cr(rd2.id, "backlinks", units_cost_actual=900, cached_from_run_id=run.id,
       ai_provider="gemini", ai_model="flash", ai_input_tokens=9, ai_output_tokens=9,
       ai_cached_from_run_id=run.id)
    cr(rd2.id, "anchors", units_cost_actual=70, fetched_at=datetime(2026, 11, 5))
    for status, provider in (("registered", "domainr"), ("available", "domainr"),
                             ("registered", "domainr"), ("error", "domainr"),
                             ("registered", "rdap")):
        fresh_db.add(AvailabilityCheck(domain="a.kz", provider=provider, status=status,
                                       checked_at=datetime(2026, 10, 5), run_id=run.id,
                                       registrar="", error_message="", error_category="",
                                       raw_response=""))
    fresh_db.commit()

    counts = sp.backfill(datetime(2026, 11, 1))
    assert counts == {"ai_checks": 2, "ai_final": 1, "ahrefs": 1,
                      "whois_history": 1, "availability": 1}
    assert sp.backfill(datetime(2026, 11, 1)) is None            # once only
    ev = {(e.kind, e.feature): e for e in _events(fresh_db)}
    assert all(e.source == "backfill" for e in ev.values())
    assert ev[("ai", "backlinks")].cost_usd is None              # $0 then = estimate now
    assert ev[("ai", "wayback")].cost_usd == 0.5                 # recorded price kept
    assert (ev[("ai", "final")].provider, ev[("ai", "final")].model) == ("gemini", "flash")
    assert (ev[("ahrefs", "backlinks")].units, ev[("ahrefs", "backlinks")].units_list) == (500, 600)
    assert ev[("ahrefs", "backlinks")].job_id == job.id
    assert ev[("whois_history", "whois_history")].units == 1
    assert ev[("availability", "availability")].calls == 3      # paid answers only
    assert sp.backfill_info()["ai_checks"] == 2


def test_an_interrupted_import_is_redone_with_the_first_cutoff(fresh_db, sp):
    import json
    from app.app_settings import _set
    from app.models import CriterionResult
    _job, _run_, rd = _run(fresh_db)
    for day in (5, 20):    # before / after the first start (Nov 10)
        fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion=f"c{day}", status="done",
                                     request_url="", error="", data_json="{}",
                                     fetched_at=datetime(2026, 11, day), units_cost_actual=10))
    _set(fresh_db, "spend_backfill_v1",
         json.dumps({"cutoff": "2026-11-10T00:00:00", "done": False}))
    _ev(fresh_db, "2026-11-05", "ahrefs", "ahrefs", units=10, source="backfill")  # half-done
    fresh_db.commit()
    assert sp.backfill_info() is None
    counts = sp.backfill(datetime(2026, 11, 30))       # a later start
    assert counts["ahrefs"] == 1                       # Nov 20 was logged live
    assert len(_events(fresh_db)) == 1                 # the half-done row is gone
    assert sp.backfill_info()["cutoff"] == "2026-11-10T00:00:00"


# ---- Projects ------------------------------------------------------------------------

QUALITY_SPEC = {
    "domains": ["good.kz"],
    "criteria": {"backlinks": {"enabled": True, "limit": 10, "mode": "live"},
                 "refdomains": {"enabled": False}, "anchors": {"enabled": False},
                 "keywords": {"enabled": False}, "wayback": {"enabled": False},
                 "wayback_classify": {"enabled": False}},
    "ai": {"provider": "gemini", "model": "test"},
    "lang": "en",
}


def _project(db, name):
    from app.models import Project
    p = Project(name=name, created_at=datetime.utcnow())
    db.add(p)
    db.commit()
    return p


def test_quality_jobs_require_a_project(fresh_db, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models import Job
    from app.routers import analyze, jobs
    for mod in (analyze, jobs):           # create the runs, don't run them
        monkeypatch.setattr(mod, "dispatch_run", lambda _run_id: None)
    alpha, beta = _project(fresh_db, "Alpha"), _project(fresh_db, "Beta")
    gone = _project(fresh_db, "Gone")
    gone.deleted_at = datetime.utcnow()
    fresh_db.commit()
    c = TestClient(app)
    for bad in ({}, {"project_id": 9999}, {"project_id": gone.id}):
        r = c.post("/analyze/jobs", json={"spec": QUALITY_SPEC, **bad})
        assert r.status_code == 400 and "project" in r.json()["detail"], bad
    r = c.post("/analyze/jobs", json={"spec": QUALITY_SPEC, "project_id": alpha.id})
    assert r.status_code == 200, r.text
    assert fresh_db.get(Job, r.json()["job_id"]).project_id == alpha.id
    assert c.get(f"/jobs/{r.json()['job_id']}/spec").json()["project_id"] == alpha.id
    # a job from before projects must get one on its next Quality rerun
    old = Job(name="old", notes="", spec_json="{}", kind="quality")
    fresh_db.add(old)
    fresh_db.commit()
    assert c.post(f"/jobs/{old.id}/rerun", json={"spec": QUALITY_SPEC}).status_code == 400
    assert c.post(f"/jobs/{old.id}/rerun",
                  json={"spec": QUALITY_SPEC, "project_id": beta.id}).status_code == 200
    fresh_db.expire_all()
    assert fresh_db.get(Job, old.id).project_id == beta.id


def test_projects_crud_and_pages(fresh_db):
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    assert c.post("/projects", json={"name": "   "}).status_code == 422
    made = [c.post("/projects", json={"name": f"Проект {i:02d}"}).json() for i in range(25)]
    assert c.post("/projects", json={"name": "  проект   07 "}).status_code == 409  # case, spaces
    page1 = c.get("/projects").json()
    assert (page1["total"], len(page1["rows"]), page1["rows"][0]["name"]) == (25, 20, "Проект 00")
    page2 = c.get("/projects?page=2").json()
    assert [r["name"] for r in page2["rows"]] == [f"Проект {i}" for i in range(20, 25)]
    found = c.get("/projects?search=проект 1").json()              # Cyrillic, any case
    assert found["filtered_total"] == 10 and found["total"] == 25
    pid = made[3]["id"]
    assert c.patch(f"/projects/{pid}", json={"name": "Проект 04"}).status_code == 409
    assert c.patch(f"/projects/{pid}", json={"name": "Casino KZ"}).json()["name"] == "Casino KZ"
    assert c.delete(f"/projects/{pid}").json() == {"deleted": True}
    assert c.delete(f"/projects/{pid}").status_code == 404
    assert c.patch(f"/projects/{pid}", json={"name": "x"}).status_code == 404
    names = [p["name"] for p in c.get("/projects/all").json()]
    assert "Casino KZ" not in names and len(names) == 24
    # a deleted project's name is free again
    assert c.post("/projects", json={"name": "Casino KZ"}).status_code == 201


def test_projects_bulk_paste(fresh_db):
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    c.post("/projects", json={"name": "Alpha"})
    r = c.post("/projects/bulk", json={"names": [
        "Beta", "", "  ", "alpha", "Gamma  Ray", "beta", "Дельта", "  gamma ray "]})
    assert r.status_code == 200
    assert r.json() == {"added": 3, "skipped": ["alpha", "beta", "gamma ray"]}
    assert [p["name"] for p in c.get("/projects/all").json()] == [
        "Alpha", "Beta", "Gamma Ray", "Дельта"]
    assert c.post("/projects/bulk", json={"names": ["x"] * 5001}).status_code == 422


def test_spend_by_project(fresh_db, sp):
    from app.models import Job
    alpha, beta = _project(fresh_db, "Alpha"), _project(fresh_db, "Beta")
    job_a, run_a, _ = _run(fresh_db)
    job_b, run_b, _ = _run(fresh_db)
    job_a.project_id, job_b.project_id = alpha.id, beta.id
    fresh_db.commit()
    with sp.tag(run_id=run_a.id):
        sp.record_ai("gemini", "flash", {"input_tokens": 1})
    with sp.tag(run_id=run_b.id):
        sp.record_ahrefs("site-explorer/backlinks", billed=4_500_000)
    sp.record_ahrefs("site-explorer/backlinks", billed=500_000)    # Tools, no job
    sp.flush()
    assert {(e.job_id, e.project_id) for e in _events(fresh_db)} == {
        (job_a.id, alpha.id), (job_b.id, beta.id), (None, None)}
    alpha.name = "Alpha 2"                        # renamed in Settings
    beta.deleted_at = datetime.utcnow()           # deleted in Settings
    fresh_db.delete(fresh_db.get(Job, job_b.id))  # and its job too
    fresh_db.commit()
    s = sp.summary("this_month")
    jobs = {r["job_id"]: r for r in s["jobs"]}
    assert jobs[job_a.id]["project"] == "Alpha 2"
    assert jobs[job_b.id]["deleted"] and jobs[job_b.id]["project"] == "Beta"
    assert jobs[job_b.id]["project_deleted"]
    projects = {p["project"]: p for p in s["projects"]}
    assert set(projects) == {"Alpha 2", "Beta", ""}
    assert projects["Beta"]["deleted"] and projects["Beta"]["ahrefs_units"] == 4_500_000
    # 5M units this month, 1M over: $50, 90% of it Beta's
    assert projects["Beta"]["ahrefs_usd"] == pytest.approx(45.0)
    assert s["projects"][-1]["project_id"] is None       # "no project" last


def test_jobs_show_their_sources(fresh_db, sp):
    from app.models import BacklogDomain, RunDomain
    job, run, _rd = _run(fresh_db)                       # a.kz
    for d in ("b.kz", "c.kz", "d.kz", "e.kz"):
        fresh_db.add(RunDomain(run_id=run.id, domain=d, status="done", error=""))
    for d, src in (("a.kz", "adult-blogs"), ("b.kz", "adult-blogs"), ("c.kz", "ru-big"),
                   ("d.kz", "")):                        # e.kz: not in the Backlog
        fresh_db.add(BacklogDomain(domain=d, registrar=src))
    fresh_db.commit()
    with sp.tag(run_id=run.id):
        sp.record_ai("gemini", "flash", {"input_tokens": 1})
    sp.flush()
    (row,) = sp.summary("this_month")["jobs"]
    assert row["sources"] == [{"source": "adult-blogs", "domains": 2},
                              {"source": "ru-big", "domains": 1}]


# ---- API ------------------------------------------------------------------------------

def test_api(fresh_db, sp, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routers import dashboard
    c = TestClient(app)
    assert c.get("/spend/summary?period=forever").status_code == 422
    assert c.get("/spend/summary?period=2026-10").status_code == 200
    body = c.get("/spend/summary").json()
    assert body["period"] == "this_month" and body["total_usd"] == 0
    assert c.get("/spend/pricing").json()["ahrefs_included_units"] == 4_000_000
    r = c.put("/spend/pricing", json={"ahrefs_usd_per_million": 60, "domainr_usd_per_request": 0.002})
    assert r.status_code == 200 and r.json()["ahrefs_usd_per_million"] == 60
    assert c.put("/spend/pricing", json={"ahrefs_usd_per_million": -1}).status_code == 422

    async def fake_units():
        return {"state": "ok", "units_used": 5_000_000, "units_limit": 10_000_000}
    monkeypatch.setattr(dashboard, "_fetch_ahrefs_units", fake_units)
    u = c.get("/dashboard/ahrefs-units?force=true").json()
    assert u["overage_units"] == 1_000_000 and u["overage_usd"] == pytest.approx(60.0)
