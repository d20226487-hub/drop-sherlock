"""Database filter "Язык ссылок" (2026-11-20): languages of the pages a
domain's backlinks come from (Ahrefs `languages` per backlinks row), with
a minimum number of fetched backlinks in the chosen language(s)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime
from types import SimpleNamespace

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


def _body(*langs):
    return json.dumps({"backlinks": [{"url_from": f"https://x{i}.com", "languages": l}
                                     for i, l in enumerate(langs)]})


def test_language_sets_count_each_backlink_once():
    from app import backlink_langs as bl
    cr = SimpleNamespace(id=1, fetched_at=datetime(2026, 11, 1),
                         data_json=_body(["en"], ["en"], ["RU", "en"], "de", [], None))
    sets = bl.language_sets(cr)
    assert sets == {"en": 2, "en,ru": 1, "de": 1}
    assert bl.count_matching(sets, ["ru"]) == 1
    assert bl.count_matching(sets, ["en", "ru"]) == 3         # the en+ru page once
    assert bl.count_matching(sets, ["fr"]) == 0
    assert bl.languages_in(sets) == {"en", "ru", "de"}
    assert bl.language_sets(cr) is sets                       # cached
    cr.fetched_at = datetime(2026, 11, 2)                     # refetched
    cr.data_json = _body(["fr"])
    assert bl.language_sets(cr) == {"fr": 1}
    bad = SimpleNamespace(id=2, fetched_at=None, data_json="{not json")
    assert bl.language_sets(bad) == {}


def test_database_filter_and_options(fresh_db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models import CriterionResult, Job, JobCriterionPin, Run, RunDomain
    from app.routers.database import list_domains
    job = Job(name="q", notes="", spec_json="{}", kind="quality")
    fresh_db.add(job)
    fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}", error="",
              started_at=datetime(2026, 11, 1), finished_at=datetime(2026, 11, 1))
    fresh_db.add(run)
    fresh_db.flush()
    fresh_db.add(JobCriterionPin(job_id=job.id, criterion="backlinks", run_id=run.id))

    def checked(domain, body):
        rd = RunDomain(run_id=run.id, domain=domain, status="done", error="",
                       finished_at=run.finished_at)
        fresh_db.add(rd)
        fresh_db.flush()
        fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion="backlinks", status="done",
                                     request_url="", error="", data_json=body,
                                     fetched_at=datetime(2026, 11, 1)))

    checked("ru-heavy.com", _body(["ru"], ["ru"], ["ru"], ["en"]))
    checked("ru-one.com", _body(["ru"], ["en"], ["en"]))
    checked("bilingual.com", _body(["ru", "kk"], ["kk"]))
    checked("english.com", _body(["en"], ["en"]))
    fresh_db.commit()

    def domains(**kw):
        resp = list_domains(db=fresh_db, offset=0, limit=None, **kw)
        return sorted(r.domain for r in resp.rows), resp

    every, resp = domains()
    assert every == ["bilingual.com", "english.com", "ru-heavy.com", "ru-one.com"]
    assert resp.filter_options["backlink_languages"] == ["en", "ru", "kk"]  # by domain count
    assert domains(backlink_langs=["ru"])[0] == ["bilingual.com", "ru-heavy.com", "ru-one.com"]
    assert domains(backlink_langs=["ru"], backlink_lang_min=2)[0] == ["ru-heavy.com"]
    # a page in both ru and kk counts once: bilingual has 2 backlinks, not 3
    assert domains(backlink_langs=["ru", "kk"], backlink_lang_min=2)[0] == [
        "bilingual.com", "ru-heavy.com"]
    assert domains(backlink_langs=["ru", "kk"], backlink_lang_min=3)[0] == ["ru-heavy.com"]

    c = TestClient(app)
    r = c.get("/database/domains?backlink_lang=ru&backlink_lang_min=2&per_page=50")
    assert r.status_code == 200
    assert [row["domain"] for row in r.json()["rows"]] == ["ru-heavy.com"]
    assert c.get("/database/domains?backlink_lang=ru&backlink_lang_min=0").status_code == 422
