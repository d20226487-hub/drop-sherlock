"""Wayback classify: the country the site targets (added 2026-11-20).

The classify prompts ask for an ISO country code when a city / region is
named in the snapshots or the domain name (a ccTLD only supports it), and
the Database row carries it into the Theme cell — only when it's a
well-formed two-letter code."""
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
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
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


def test_both_classify_prompts_ask_for_the_country():
    from app import ai_prompts as p
    for prompt in (p.WAYBACK_CLASSIFY_COMBINED_PROMPT_WHITE,
                   p.WAYBACK_CLASSIFY_COMBINED_PROMPT_GREY,
                   p.WAYBACK_CLASSIFY_THEME_ONLY_PROMPT_WHITE,
                   p.WAYBACK_CLASSIFY_THEME_ONLY_PROMPT_GREY):
        assert "- country:" in prompt and '"country":' in prompt
        assert '"country_confidence":' in prompt and '"country_evidence":' in prompt
        assert "domain name itself" in prompt          # cities in the name count
        assert "only SUPPORTS" in prompt               # a ccTLD alone is weak
        assert "language alone" in prompt              # language never decides


def test_database_row_carries_a_valid_country_only(fresh_db):
    from app.models import CriterionResult, Job, JobCriterionPin, Run, RunDomain
    from app.routers.database import _build_all_rows
    job = Job(name="q", notes="", spec_json="{}", kind="quality")
    fresh_db.add(job)
    fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}", error="",
              started_at=datetime(2026, 11, 1), finished_at=datetime(2026, 11, 1))
    fresh_db.add(run)
    fresh_db.flush()
    # The Database page reads each criterion from the job's pinned run
    # (finished runs get these pins automatically).
    fresh_db.add(JobCriterionPin(job_id=job.id, criterion="wayback_classify", run_id=run.id))

    def classified(domain, **verdict):
        rd = RunDomain(run_id=run.id, domain=domain, status="done", error="",
                       finished_at=run.finished_at)
        fresh_db.add(rd)
        fresh_db.flush()
        fresh_db.add(CriterionResult(
            run_domain_id=rd.id, criterion="wayback_classify", status="done",
            request_url="", error="", data_json="{}",
            ai_verdict_json=json.dumps({"primary_theme": "dental clinic", **verdict})))

    classified("almaty-dental.com", country="kz", country_confidence=0.9,
               country_evidence="'almaty' in the domain name")
    classified("named.com", country="Kazakhstan", country_confidence=0.9)   # not a code
    classified("nowhere.com", country="", country_confidence=0)
    classified("legacy.com")                                               # older verdict
    fresh_db.commit()

    rows = {r.domain: r for r in _build_all_rows(fresh_db)[0]}
    almaty = rows["almaty-dental.com"]
    assert (almaty.country, almaty.country_confidence, almaty.country_evidence) == (
        "KZ", 0.9, "'almaty' in the domain name")
    for d in ("named.com", "nowhere.com", "legacy.com"):
        assert (rows[d].country, rows[d].country_confidence, rows[d].country_evidence) == (
            "", None, ""), d
