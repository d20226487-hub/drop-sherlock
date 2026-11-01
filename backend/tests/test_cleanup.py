"""Database ▸ Чистка (Cleanup), added 2026-11-01.

Pins what each category may delete and — above all — what it can never
touch: domains on the Database page, in Linked Domains or SERP Overview,
Backlog domains never analyzed, notes, empty runs, Linked/SERP rows.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from datetime import date, datetime, timedelta

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
def cl(fresh_db, monkeypatch):
    """The cleanup module with the side effects recorded, not performed."""
    from app import backups, cleanup
    from app.routers import database as dbr
    calls = {"backup": 0, "invalidate": 0}

    def fake_backup(**_kw):
        calls["backup"] += 1
        return {"filename": "drop_sherlock-test.db.gz"}

    monkeypatch.setattr(backups, "run_backup", fake_backup)
    monkeypatch.setattr(dbr, "_invalidate_rows_cache",
                        lambda: calls.__setitem__("invalidate", calls["invalidate"] + 1))
    monkeypatch.setattr(cleanup, "_checks_running", lambda: [])
    monkeypatch.setattr(cleanup, "_state", {"running": False, "kind": None, "done": 0,
                                            "total": 0, "result": None, "error": None})
    cleanup.calls = calls
    return cleanup


SOON = (date.today() + timedelta(days=10)).isoformat()
FAR = "2030-01-01"


def _seed(db):
    """Every kind of domain the design distinguishes."""
    from app.models import (AvailabilityCheck, BacklogDomain, CriterionResult,
                            DomainNote, DomainShare, Job, JobCriterionPin,
                            LinkedDomainRow, Run, RunDomain)
    t0 = datetime(2026, 10, 1)
    runs: dict[str, Run] = {}

    def run(key, kind, status="done", day=1):
        job = Job(name=key, notes="", spec_json="{}", kind=kind)
        db.add(job)
        db.flush()
        r = Run(job_id=job.id, status=status, spec_json="{}", error="")
        db.add(r)
        db.flush()
        runs[key] = r
        return r

    run("av1", "availability", day=1)
    run("av2", "availability", day=2)
    run("av_pinned", "availability")
    run("av_running", "availability", status="running")
    run("quality", "quality")
    run("linked", "linked_domains")
    run("serp", "serp_overview")
    db.add(JobCriterionPin(job_id=runs["av_pinned"].job_id, criterion="availability",
                           run_id=runs["av_pinned"].id))

    def check(run_key, domain, status=None, expires=None, raw=None, crit="availability",
              day=1, pinned=False):
        rd = RunDomain(run_id=runs[run_key].id, domain=domain, status="done", error="",
                       finished_at=t0 + timedelta(days=day), is_pinned=pinned)
        db.add(rd)
        db.flush()
        if crit == "availability":
            data = raw if raw is not None else json.dumps(
                {"verdict": {"status": status, "provider": "rdap", "expires_on": expires}})
        else:
            data = json.dumps({"rows": []})
        db.add(CriterionResult(run_domain_id=rd.id, criterion=crit, status="done",
                               request_url="", error="", data_json=data))
        return rd

    rd_taken = check("av1", "taken.kz", "registered", FAR)
    check("av1", "notsup.kz", "not_supported")
    check("av1", "free.kz", "available")
    check("av1", "mixed.kz", "registered")
    check("av2", "mixed.kz", "available", day=2)
    check("av1", "unsure.kz", "unknown")
    check("av1", "taken-unsure.kz", "registered")
    check("av2", "taken-unsure.kz", "error", day=2)
    check("av1", "noted.kz", "registered")
    db.add(DomainNote(domain="noted.kz", note="watch"))
    check("av1", "dpin.kz", "registered", pinned=True)
    check("av_pinned", "runpin.kz", "registered")
    check("av_running", "running.kz", "registered")
    check("av1", "quality.kz", "registered")
    check("quality", "quality.kz", crit="wayback")
    check("av1", "linked.kz", "registered")
    rd_linked = check("linked", "linked.kz", crit="linked_domains")
    db.add(LinkedDomainRow(run_domain_id=rd_linked.id, run_id=runs["linked"].id,
                           job_id=runs["linked"].job_id, linked_domain="out.kz"))
    check("av1", "serp.kz", "registered")
    check("serp", "serp.kz", crit="serp_overview")
    check("av1", "soon.kz", "registered", SOON)
    check("av1", "expired.kz", "registered", "2020-01-01")
    check("av1", "backlogsoon.kz", "registered", FAR)
    check("av1", "far.kz", "registered", FAR)
    check("av1", "noexp.kz", "registered")
    check("av1", "badjson.kz", raw="{not json")
    check("av1", "rereg.kz", "registered", "2020-01-01", day=1)   # old expiry...
    check("av2", "rereg.kz", "registered", FAR, day=2)           # ...renewed since
    db.add(DomainShare(token="tok-taken", run_domain_id=rd_taken.id, note="",
                       created_at=t0, view_count=0, created_ip=""))
    db.add(AvailabilityCheck(domain="taken.kz", provider="rdap", status="registered",
                             checked_at=t0, registrar="", error_message="",
                             error_category="", raw_response="x"))
    for d in ("taken.kz", "notsup.kz", "free.kz", "far.kz", "runpin.kz", "backlog-only.kz"):
        db.add(BacklogDomain(domain=d, registrar="src"))
    db.add(BacklogDomain(domain="backlogsoon.kz", registrar="src",
                         expiration_date=date.today() + timedelta(days=5)))
    db.commit()
    return runs


DELETABLE = {"taken.kz", "runpin.kz", "far.kz", "noexp.kz", "rereg.kz"}


def _domains(sel):
    return {d["domain"] for d in sel["domains"]}


def test_taken_selection_and_protections(fresh_db, cl):
    _seed(fresh_db)
    sel = cl.select_taken(fresh_db, protect_expiry_days=30)
    assert _domains(sel) == DELETABLE
    assert sel["kept"] == {"note": 1, "pinned": 1, "in_progress": 1, "expiring": 3}
    # never eligible at all: available verdicts, other analysis, Linked/SERP
    # targets, malformed verdicts, never-analyzed Backlog domains
    for d in ("free.kz", "mixed.kz", "quality.kz", "linked.kz", "serp.kz",
              "badjson.kz", "backlog-only.kz"):
        assert d not in _domains(sel)
    # registered only by default: not supported / unknown / error are opt-ins
    for d in ("notsup.kz", "unsure.kz", "taken-unsure.kz"):
        assert d not in _domains(sel)
    assert cl.never_analyzed_count(fresh_db) == 1


def test_other_statuses_only_with_their_own_opt_in(fresh_db, cl):
    _seed(fresh_db)

    def pick(*include):
        return _domains(cl.select_taken(fresh_db, include=include, protect_expiry_days=30))
    assert pick("not_supported") == DELETABLE | {"notsup.kz"}
    assert pick("unknown") == DELETABLE | {"unsure.kz"}
    assert pick("error") == DELETABLE | {"taken-unsure.kz"}   # registered + error
    assert pick("not_supported", "unknown", "error") == (
        DELETABLE | {"notsup.kz", "unsure.kz", "taken-unsure.kz"})
    # an available verdict can never be opted in
    with pytest.raises(ValueError):
        pick("available")


def test_expiry_window_is_adjustable_and_can_be_off(fresh_db, cl):
    _seed(fresh_db)
    off = cl.select_taken(fresh_db, protect_expiry_days=0)
    assert _domains(off) == DELETABLE | {"soon.kz", "expired.kz", "backlogsoon.kz"}
    narrow = cl.select_taken(fresh_db, protect_expiry_days=7)
    assert "soon.kz" in _domains(narrow)              # 10 days out > 7
    assert "backlogsoon.kz" not in _domains(narrow)   # Backlog expiry in 5 days


def _wait(cl):
    for _ in range(300):
        st = cl.status()
        if not st["running"]:
            return st
        time.sleep(0.02)
    raise AssertionError("cleanup did not finish")


def test_running_the_taken_cleanup(fresh_db, cl):
    from app.models import (AvailabilityCheck, BacklogDomain, DomainBan,
                            DomainShare, LinkedDomainRow, Run, RunDomain)
    runs = _seed(fresh_db)
    n = len(DELETABLE)
    out = cl.start_taken_cleanup(protect_expiry_days=30,
                                 delete_backlog=True, ban=True, expected_count=n)
    assert out["started"]
    st = _wait(cl)
    assert st["error"] is None, st
    assert st["result"]["backup"] == "drop_sherlock-test.db.gz"
    assert st["result"]["domains"] == n and cl.calls == {"backup": 1, "invalidate": 1}
    fresh_db.expire_all()
    left = {d for (d,) in fresh_db.query(RunDomain.domain)}
    assert not (left & DELETABLE)
    for d in ("free.kz", "noted.kz", "dpin.kz", "running.kz", "quality.kz",
              "linked.kz", "serp.kz", "soon.kz", "unsure.kz", "notsup.kz"):
        assert d in left, d
    assert fresh_db.query(DomainShare).count() == 0             # its share link went too
    assert fresh_db.query(AvailabilityCheck).count() == 0       # and its history
    backlog = {d for (d,) in fresh_db.query(BacklogDomain.domain)}
    assert backlog == {"free.kz", "notsup.kz", "backlog-only.kz", "backlogsoon.kz"}
    bans = {b.domain: b for b in fresh_db.query(DomainBan)}
    assert set(bans) == DELETABLE
    assert json.loads(bans["taken.kz"].backlog_snapshot_json)["registrar"] == "src"  # unban restores it
    assert bans["noexp.kz"].backlog_snapshot_json == ""     # had no Backlog row
    assert fresh_db.query(LinkedDomainRow).count() == 1         # Linked Domains untouched
    assert fresh_db.get(Run, runs["av_pinned"].id) is not None  # emptied run kept
    rows = fresh_db.execute(text("SELECT source, level, message FROM error_log")).all()
    assert any(r[0] == "cleanup" and f"deleted {n} taken domains" in r[2] for r in rows)


def test_backlog_and_ban_options_respected(fresh_db, cl):
    from app.models import BacklogDomain, DomainBan
    _seed(fresh_db)
    cl.start_taken_cleanup(protect_expiry_days=30,
                           delete_backlog=False, ban=False, expected_count=len(DELETABLE))
    _wait(cl)
    fresh_db.expire_all()
    assert fresh_db.query(BacklogDomain).count() == 7  # all kept
    assert fresh_db.query(DomainBan).count() == 0


def test_refusals_delete_nothing(fresh_db, cl, monkeypatch):
    from app.models import RunDomain
    _seed(fresh_db)
    before = fresh_db.query(RunDomain).count()
    with pytest.raises(cl.CleanupRefused, match="changed since the preview"):
        cl.start_taken_cleanup(protect_expiry_days=30,
                               delete_backlog=True, ban=False, expected_count=99)
    monkeypatch.setattr(cl, "_checks_running", lambda: [{"run_id": 1, "kind": "wayback"}])
    with pytest.raises(cl.CleanupRefused, match="check is running"):
        cl.start_taken_cleanup(protect_expiry_days=30,
                               delete_backlog=True, ban=False, expected_count=len(DELETABLE))
    monkeypatch.setattr(cl, "_checks_running", lambda: [])
    from app import backups

    def broken_backup(**_kw):
        raise RuntimeError("disk full")
    monkeypatch.setattr(backups, "run_backup", broken_backup)
    # The backup runs in the background job; a failure ends it there,
    # before any row is deleted, and the page shows the error.
    cl.start_taken_cleanup(protect_expiry_days=30,
                           delete_backlog=True, ban=False, expected_count=len(DELETABLE))
    st = _wait(cl)
    assert st["running"] is False and st["result"] is None
    assert "backup failed, nothing deleted" in st["error"]
    fresh_db.expire_all()
    assert fresh_db.query(RunDomain).count() == before


def _seed_orphans(db):
    from app.models import Job, Run
    t0 = datetime(2026, 10, 1)
    job = Job(name="j", notes="", spec_json="{}", kind="availability")
    db.add(job)
    db.flush()
    empty_run = Run(job_id=job.id, status="done", spec_json="{}", error="")
    db.add(empty_run)
    db.flush()
    stmts = [
        ("INSERT INTO domain_shares (token, run_domain_id, note, created_at, view_count, created_ip) "
         "VALUES ('dead', 9001, '', :t, 0, '')"),
        ("INSERT INTO criterion_results (run_domain_id, criterion, request_url, status, data_json, error, ai_verdict_json, ai_verdict_error, ai_verdict_ru_json, params_hash, prompt_hash, ai_provider, ai_model) "
         "VALUES (9002, 'availability', '', 'done', '{}', '', '', '', '', '', '', '', '')"),
        # check without a run, nothing else pointing at it -> delete
        "INSERT INTO run_domains (id, run_id, domain, status, error, final_assessment_json, final_assessment_ru_json, final_summary, is_pinned, skip_reason) VALUES (9003, 8001, 'gone.kz', 'done', '', '', '', '', 0, '')",
        # check without a run that Linked rows still point at -> keep
        "INSERT INTO run_domains (id, run_id, domain, status, error, final_assessment_json, final_assessment_ru_json, final_summary, is_pinned, skip_reason) VALUES (9004, 8002, 'kept.kz', 'done', '', '', '', '', 0, '')",
        ("INSERT INTO linked_domain_rows (run_domain_id, run_id, job_id, linked_domain) "
         "VALUES (9004, 8002, 7001, 'x.kz')"),
        # run without a job, empty -> delete; one with Linked rows -> keep
        "INSERT INTO runs (id, job_id, status, spec_json, error, name, is_pinned, scoring_override_json) VALUES (8101, 7101, 'done', '{}', '', '', 0, '')",
        "INSERT INTO runs (id, job_id, status, spec_json, error, name, is_pinned, scoring_override_json) VALUES (8102, 7102, 'done', '{}', '', '', 0, '')",
        ("INSERT INTO linked_domain_rows (run_domain_id, run_id, job_id, linked_domain) "
         "VALUES (9999, 8102, 7102, 'y.kz')"),
        ("INSERT INTO job_criterion_pins (job_id, criterion, run_id, created_at, updated_at) "
         "VALUES (:job, 'availability', 8999, :t, :t)"),
        ("INSERT INTO wayback_sparkline_results (job_id, domain, status, error_msg) "
         "VALUES (6001, 'w.kz', 'done', '')"),
        ("INSERT INTO serp_overview_rows (run_domain_id, run_id, job_id, keyword, url, domain) "
         "VALUES (9998, 8103, 7103, 'k', 'https://s.kz', 's.kz')"),
        "INSERT INTO domain_notes (domain, note, updated_at) VALUES ('vanished.kz', 'mine', :t)",
    ]
    for s in stmts:
        db.execute(text(s), {"t": t0, "job": job.id})
    db.commit()
    return empty_run.id


def test_orphan_preview_and_cleanup(fresh_db, cl):
    from app.models import DomainNote, Run
    empty_run = _seed_orphans(fresh_db)
    counts = cl.orphan_counts(fresh_db)
    assert counts["delete"] == {"share_links": 1, "results_without_check": 1,
                                "checks_without_run": 1, "runs_without_job": 1,
                                "pins_to_missing": 1, "sparkline_without_job": 1}
    assert counts["kept"] == {"linked_rows": 1, "serp_rows": 1, "notes": 1, "empty_runs": 1}
    cl.start_orphan_cleanup(expected_count=6)
    st = _wait(cl)
    assert st["error"] is None and sum(st["result"]["deleted"].values()) == 6
    fresh_db.expire_all()
    after = cl.orphan_counts(fresh_db)
    assert sum(after["delete"].values()) == 0
    assert after["kept"] == counts["kept"]                      # Linked/SERP/notes/empty runs kept
    ids = {i for (i,) in fresh_db.execute(text("SELECT id FROM run_domains"))}
    assert ids == {9004}                                        # the Linked-referenced check stays
    assert fresh_db.get(Run, 8102) is not None and fresh_db.get(Run, empty_run) is not None
    assert fresh_db.query(DomainNote).count() == 1


def test_api_preview_and_conflict(fresh_db, cl):
    from fastapi.testclient import TestClient
    from app.main import app
    _seed(fresh_db)
    c = TestClient(app)
    p = c.get("/cleanup/taken").json()
    assert p["count"] == len(DELETABLE) and p["never_analyzed"] == 1
    assert {s["domain"] for s in p["sample"]} == DELETABLE
    csv_text = c.get("/cleanup/taken.csv").text
    assert csv_text.splitlines()[0] == "domain,status,expires_on,source"
    assert len(csv_text.strip().splitlines()) == len(DELETABLE) + 1
    opted = c.get("/cleanup/taken?include=not_supported&include=unknown").json()
    assert {s["domain"] for s in opted["sample"]} == DELETABLE | {"notsup.kz", "unsure.kz"}
    assert c.get("/cleanup/taken?include=available").status_code == 422
    assert c.post("/cleanup/taken", json={"include": ["available"],
                                          "expected_count": 1}).status_code == 422
    r = c.post("/cleanup/taken", json={"expected_count": 1})
    assert r.status_code == 409 and "changed since the preview" in r.json()["detail"]
    assert c.get("/cleanup/orphans").json()["total"] == 0
