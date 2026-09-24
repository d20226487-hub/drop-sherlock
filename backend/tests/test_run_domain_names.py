"""Coverage for GET /runs/{id}/domain-names (added 2026-09-24).

Backs the availability Run page's one-click "copy unresolved domains"
button: not_supported + unknown + error in one request. The endpoint
shares `_run_domain_filter_q` with /domain-ids, so the two must always
agree — that lock-step is pinned here too.
"""
from __future__ import annotations

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


def _client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


AUTH = ("admin", "changeme")

# domain -> availability verdict status. `no-cr` gets no CriterionResult
# at all (the `no_verdict` bucket) and `broken-json` gets an unparseable
# data_json — both must stay OUT of the unresolved set.
FIXTURE = [
    ("free.kz", "available"),
    ("taken.kz", "registered"),
    ("double.us.com", "not_supported"),
    ("mystery.uz", "unknown"),
    ("boom.kz", "error"),
    ("no-cr.kz", None),
    ("broken-json.kz", "__invalid__"),
]


def _build_availability_run(session) -> int:
    """One availability run covering every verdict bucket. Returns run id."""
    from app.models import CriterionResult, Job, Run, RunDomain

    spec = {"criteria": {"availability": {"enabled": True}}}
    job = Job(name="avail", kind="availability", spec_json=json.dumps(spec))
    session.add(job)
    session.flush()
    run = Run(job_id=job.id, status="done", spec_json=json.dumps(spec))
    session.add(run)
    session.flush()
    for domain, status in FIXTURE:
        rd = RunDomain(run_id=run.id, domain=domain, status="done")
        session.add(rd)
        session.flush()
        if status is None:
            continue
        data_json = (
            "{not json"
            if status == "__invalid__"
            else json.dumps({"verdict": {"status": status}})
        )
        session.add(CriterionResult(
            run_domain_id=rd.id,
            criterion="availability",
            status="done",
            data_json=data_json,
        ))
    session.commit()
    return run.id


UNRESOLVED = ["not_supported", "unknown", "error"]


def _get_names(client, run_id: int, buckets: list[str] | None = None, **kw):
    params: list[tuple[str, str]] = [
        ("availability_status_filter", b) for b in (buckets or [])
    ]
    params += [(k, v) for k, v in kw.items()]
    r = client.get(f"/runs/{run_id}/domain-names", params=params, auth=AUTH)
    assert r.status_code == 200, r.text
    return r.json()


def test_unresolved_buckets_return_exactly_the_three_statuses(fresh_db):
    run_id = _build_availability_run(fresh_db)
    body = _get_names(_client(), run_id, UNRESOLVED)
    assert body["domains"] == ["double.us.com", "mystery.uz", "boom.kz"]
    assert body["count"] == 3


def test_resolved_and_verdictless_rows_are_excluded(fresh_db):
    run_id = _build_availability_run(fresh_db)
    names = set(_get_names(_client(), run_id, UNRESOLVED)["domains"])
    # available / registered are answers, not re-check candidates.
    assert "free.kz" not in names
    assert "taken.kz" not in names
    # A missing CR and an unparseable data_json both bucket to
    # `no_verdict`, which the copy button deliberately doesn't ask for.
    assert "no-cr.kz" not in names
    assert "broken-json.kz" not in names


def test_no_filter_returns_every_domain_in_table_order(fresh_db):
    run_id = _build_availability_run(fresh_db)
    body = _get_names(_client(), run_id, [])
    assert body["domains"] == [d for d, _ in FIXTURE]
    assert body["count"] == len(FIXTURE)


def test_names_stay_in_lock_step_with_domain_ids(fresh_db):
    """The copy list and "select all matching" must never disagree —
    both go through `_run_domain_filter_q`, so same filter, same rows."""
    run_id = _build_availability_run(fresh_db)
    client = _client()
    params = [("availability_status_filter", b) for b in UNRESOLVED]
    ids = client.get(
        f"/runs/{run_id}/domain-ids", params=params, auth=AUTH,
    ).json()
    names = _get_names(client, run_id, UNRESOLVED)
    assert names["count"] == ids["count"]

    from app.models import RunDomain
    expected = [
        fresh_db.get(RunDomain, rid).domain for rid in ids["ids"]
    ]
    assert names["domains"] == expected


def test_other_filters_still_apply(fresh_db):
    run_id = _build_availability_run(fresh_db)
    client = _client()
    # Substring search narrows the unresolved set.
    body = _get_names(client, run_id, UNRESOLVED, domain_filter="mystery")
    assert body["domains"] == ["mystery.uz"]
    # A status filter that matches nothing empties it.
    body = _get_names(client, run_id, UNRESOLVED, status_filter="failed")
    assert body["domains"] == []


def test_unknown_run_is_404(fresh_db):
    r = _client().get("/runs/999999/domain-names", auth=AUTH)
    assert r.status_code == 404
