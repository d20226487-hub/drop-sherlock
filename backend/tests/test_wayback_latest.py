"""Latest Wayback snapshot on the Database page (2026-11-20).

The CDX query returns the OLDEST `limit` captures, so a full result can't
say when the domain was last archived: the fetch then asks for the
homepage's newest capture (exact URL, limit=-1, fastLatest). The Database
row shows the date — as a lower bound for older capped results — and the
Wayback filter can keep a from/to range of years."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime
from urllib.parse import parse_qsl, urlsplit

import pytest

CDX = "https://web.archive.org/cdx/search/cdx?url=example.com&output=json&matchType=domain"


def _rows(*stamps):
    return [{"timestamp": s, "original": "http://example.com/"} for s in stamps]


class _FakeClient:
    def __init__(self, answer=None, fail=False):
        self.calls, self.answer, self.fail = [], answer, fail

    async def fetch_url(self, url, *, phase="v1"):
        from app.providers.base import ProviderError
        self.calls.append(url)
        if self.fail:
            raise ProviderError("Wayback returned 503")
        return 200, {"wayback": self.answer or []}, {}


def _latest(fake, url, rows):
    from app.providers.wayback import WaybackClient
    return asyncio.run(WaybackClient._latest_capture(fake, url, rows, "v1"))


def test_complete_history_needs_no_extra_request():
    fake = _FakeClient()
    assert _latest(fake, CDX + "&limit=200", _rows("20180101000000", "20240505000000")) == "20240505000000"
    assert fake.calls == []


def test_full_result_asks_for_the_homepage_newest_capture():
    fake = _FakeClient(answer=_rows("20261120031623"))
    got = _latest(fake, CDX + "&limit=2", _rows("20020120142510", "20020328012821"))
    assert got == "20261120031623"
    (call,) = fake.calls
    q = dict(parse_qsl(urlsplit(call).query))
    assert q == {"url": "example.com", "output": "json", "fl": "timestamp",
                 "fastLatest": "true", "limit": "-1"}          # no matchType
    # a `to` year cuts the history short too
    fake = _FakeClient(answer=_rows("20250101000000"))
    assert _latest(fake, CDX + "&limit=200&to=20151231", _rows("20150101000000")) == "20250101000000"
    fake = _FakeClient()                    # a future `to` cuts nothing: no request
    assert _latest(fake, CDX + "&limit=200&to=21001231", _rows("20150101000000")) == "20150101000000"
    assert fake.calls == []
    # the stored newest wins if the homepage's is older
    fake = _FakeClient(answer=_rows("20100101000000"))
    assert _latest(fake, CDX + "&limit=1", _rows("20120101000000")) == "20120101000000"


def test_failed_extra_request_leaves_it_unknown():
    assert _latest(_FakeClient(fail=True), CDX + "&limit=1", _rows("20020120142510")) is None


def test_reading_the_date_from_a_stored_result():
    from app.routers.database import _wayback_latest
    url = CDX + "&limit=3"
    assert _wayback_latest({"wayback": _rows("2002"), "latest_capture": "20261120031623"}, url) == (
        "2026-11-20", True)
    assert _wayback_latest({"wayback": _rows("20180101000000", "20200202000000")}, url) == (
        "2020-02-02", True)                                     # 2 < limit: complete
    assert _wayback_latest({"wayback": _rows("20180101000000", "20190101000000",
                                             "20200202000000")}, url) == ("2020-02-02", False)
    assert _wayback_latest({"wayback": _rows("20200202000000")}, url + "&to=20201231") == (
        "2020-02-02", False)
    # the usual `to` = end of the current year cuts nothing
    assert _wayback_latest({"wayback": _rows("20200202000000")}, url + "&to=21001231") == (
        "2020-02-02", True)
    assert _wayback_latest({"wayback": []}, url) == ("", True)


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


def test_database_row_and_year_filter(fresh_db):
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
    fresh_db.add(JobCriterionPin(job_id=job.id, criterion="wayback", run_id=run.id))

    def wb(domain, body, limit=200):
        rd = RunDomain(run_id=run.id, domain=domain, status="done", error="",
                       finished_at=run.finished_at)
        fresh_db.add(rd)
        fresh_db.flush()
        fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion="wayback", status="done",
                                     request_url=f"{CDX}&limit={limit}", error="",
                                     data_json=json.dumps(body)))

    wb("alive.com", {"wayback": _rows("20100101000000"), "latest_capture": "20250601000000"})
    wb("dead.com", {"wayback": _rows("20120101000000", "20150301000000")})
    wb("capped.com", {"wayback": _rows("20050101000000", "20190101000000")}, limit=2)
    wb("none.com", {"wayback": []})
    fresh_db.commit()

    def domains(**kw):
        return {r.domain: (r.wayback_latest, r.wayback_latest_exact)
                for r in list_domains(db=fresh_db, offset=0, limit=None, **kw).rows}

    every = domains()
    assert every["alive.com"] == ("2025-06-01", True)
    assert every["dead.com"] == ("2015-03-01", True)
    assert every["capped.com"] == ("2019-01-01", False)          # lower bound
    assert every["none.com"] == ("", True)
    assert set(domains(wayback_latest_from=2018)) == {"alive.com", "capped.com"}
    assert set(domains(wayback_latest_from=2020)) == {"alive.com"}
    # "to": a lower bound can't prove the archive stopped by then
    assert set(domains(wayback_latest_to=2020)) == {"dead.com"}
    assert set(domains(wayback_latest_from=2014, wayback_latest_to=2016)) == {"dead.com"}

    c = TestClient(app)
    r = c.get("/database/domains?wayback_latest_from=2020&per_page=50")
    assert [row["domain"] for row in r.json()["rows"]] == ["alive.com"]
    assert c.get("/database/domains?wayback_latest_from=-1").status_code == 422
