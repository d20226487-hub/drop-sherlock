"""Coverage for the Database snapshot-cache patching (2026-06-21).

The non-blocking rows cache patches a single domain's row in place after a
mutation instead of rebuilding the whole ~70k-row aggregation. Correctness
hinges on one invariant: `_build_all_rows(only_domains={d})` must produce a
row BYTE-IDENTICAL to what the full `_build_all_rows()` produces for `d` —
otherwise a patched row silently diverges from a rebuilt one. These tests
guard that, plus the patch's effect on the cached snapshot.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

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


def _seed(session, domains):
    """One job, two pinned runs (wayback + backlinks/refdomains), each
    carrying every domain. Pins wire criteria → runs so each domain
    synthesizes a non-trivial row."""
    from app.models import (
        CriterionResult, Job, JobCriterionPin, Run, RunDomain,
    )
    now = datetime.utcnow()
    job = Job(name="t", spec_json="{}")
    session.add(job)
    session.flush()
    run_wb = Run(job_id=job.id, status="done", spec_json="{}",
                 started_at=now - timedelta(hours=2),
                 finished_at=now - timedelta(hours=1), name="wb")
    run_ah = Run(job_id=job.id, status="done", spec_json="{}",
                 started_at=now - timedelta(hours=1), finished_at=now,
                 name="ah")
    session.add_all([run_wb, run_ah])
    session.flush()
    for d in domains:
        rd_wb = RunDomain(run_id=run_wb.id, domain=d, status="done",
                          started_at=now, finished_at=now)
        rd_ah = RunDomain(run_id=run_ah.id, domain=d, status="done",
                          started_at=now, finished_at=now)
        session.add_all([rd_wb, rd_ah])
        session.flush()
        session.add_all([
            CriterionResult(
                run_domain_id=rd_wb.id, criterion="wayback", status="done",
                data_json=json.dumps({"wayback": [{"ts": "20200101"}]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "good", "confidence": 0.9}),
            ),
            CriterionResult(
                run_domain_id=rd_ah.id, criterion="backlinks", status="done",
                data_json=json.dumps({"backlinks": [1, 2, 3]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "high_quality", "confidence": 0.8}),
            ),
            CriterionResult(
                run_domain_id=rd_ah.id, criterion="refdomains", status="done",
                data_json=json.dumps({"refdomains": [1, 2]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "mixed", "confidence": 0.7}),
            ),
        ])
    session.add_all([
        JobCriterionPin(job_id=job.id, criterion="wayback", run_id=run_wb.id),
        JobCriterionPin(job_id=job.id, criterion="backlinks", run_id=run_ah.id),
        JobCriterionPin(job_id=job.id, criterion="refdomains", run_id=run_ah.id),
    ])
    session.commit()
    return job


def test_single_domain_build_matches_full_build(fresh_db):
    """The crux: a row built with only_domains={d} is identical to that
    domain's row from a full build."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])

    full_rows, _opts, _hide = dbmod._build_all_rows(fresh_db)
    full_by_domain = {r.domain: r for r in full_rows}
    assert set(full_by_domain) == {"a.com", "b.com"}

    one_rows, _o2, _h2 = dbmod._build_all_rows(
        fresh_db, only_domains={"a.com"})
    assert [r.domain for r in one_rows] == ["a.com"]

    # Byte-identical synthesis (compare full pydantic dumps).
    assert one_rows[0].model_dump() == full_by_domain["a.com"].model_dump()
    # And the scored fields are actually populated (proves it's non-trivial).
    assert full_by_domain["a.com"].final_score is not None


def test_patch_updates_cached_row_in_place(fresh_db):
    from app.models import DomainNote
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])

    # Prime the snapshot cache (cold inline build).
    rows, _o, _h = dbmod._get_all_rows(fresh_db)
    assert {r.domain for r in rows} == {"a.com", "b.com"}
    assert next(r for r in rows if r.domain == "a.com").note == ""

    # Mutate: add a note for a.com, then patch just that domain.
    fresh_db.add(DomainNote(domain="a.com", note="hello"))
    fresh_db.commit()
    dbmod._patch_domains_in_cache(fresh_db, ["a.com"])

    snap = dbmod._peek_rows_cache()
    assert snap is not None
    by_domain = {r.domain: r for r in snap[0]}
    assert by_domain["a.com"].note == "hello"      # patched
    assert by_domain["b.com"].note == ""           # untouched
    assert set(by_domain) == {"a.com", "b.com"}     # no rows lost


def test_patch_drops_domain_with_no_rows(fresh_db):
    """A domain whose rds all vanish (delete) is removed from the snapshot
    by the patch."""
    from app.models import RunDomain
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])
    dbmod._get_all_rows(fresh_db)  # prime

    # Delete every rd for a.com, then patch it.
    for rd in fresh_db.query(RunDomain).filter(RunDomain.domain == "a.com").all():
        fresh_db.delete(rd)
    fresh_db.commit()
    dbmod._patch_domains_in_cache(fresh_db, ["a.com"])

    snap = dbmod._peek_rows_cache()
    assert {r.domain for r in snap[0]} == {"b.com"}


def test_cold_start_serves_empty_while_already_building(fresh_db):
    """Page route on a cold cache WHEN a build is already in flight (the
    real-app boot case — the startup pre-warm sets the flag before the
    server accepts requests) serves empty immediately instead of blocking
    on the ~tens-of-seconds first build."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    dbmod._rebuild_pending = True  # simulate the startup pre-warm in flight
    try:
        rows, opts, hide = dbmod._get_all_rows(
            fresh_db, allow_building_empty=True)
    finally:
        dbmod._rebuild_pending = False
    assert rows == []                 # served empty — did NOT block on build
    assert "verdicts" in opts and opts["verdicts"] == []  # options shape intact


def test_cold_start_route_builds_inline_when_nothing_building(fresh_db):
    """Page route on a cold cache with NO build in flight (e.g. a direct
    call before any pre-warm) still returns real data — never a spurious
    empty."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    assert dbmod._rebuild_pending is False
    rows, _o, _h = dbmod._get_all_rows(fresh_db, allow_building_empty=True)
    assert {r.domain for r in rows} == {"a.com"}


def test_cold_start_builds_inline_for_internal_caller(fresh_db):
    """Internal callers (default allow_building_empty=False) always get a
    real, fully-built result — they need the data."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    rows, _o, _h = dbmod._get_all_rows(fresh_db)
    assert {r.domain for r in rows} == {"a.com"}


def test_fresh_get_all_rows_serves_snapshot_without_blocking(fresh_db):
    """fresh=True returns the existing snapshot immediately (non-blocking)
    rather than rebuilding inline."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    dbmod._get_all_rows(fresh_db)  # prime snapshot

    # Force the would-be rebuild to explode; fresh=True must NOT call it
    # inline (it serves the snapshot + schedules a background rebuild).
    import app.routers.database as d2
    orig = d2._trigger_background_rebuild
    d2._trigger_background_rebuild = lambda: None
    try:
        rows, _o, _h = dbmod._get_all_rows(fresh_db, fresh=True)
    finally:
        d2._trigger_background_rebuild = orig
    assert {r.domain for r in rows} == {"a.com"}


def test_rebuild_does_not_clobber_concurrent_patch(fresh_db):
    """Regression for the "discard applies, then goes off" race (2026-06-22).

    A full rebuild reads the DB at its start and stores ~tens of seconds
    later, overwriting the whole snapshot. A backlog-status patch that lands
    DURING that build must NOT be reverted when the (older) build stores. The
    guard records domains patched mid-build and re-applies them after the
    store. Without it, this test sees 'order' (clobbered); with it, 'discarded'.
    """
    from datetime import datetime as _dt

    from app.models import BacklogDomain
    from app.routers import database as dbmod

    _seed(fresh_db, ["a.com", "b.com"])
    fresh_db.add(BacklogDomain(
        domain="a.com", status="order",
        created_at=_dt.utcnow(), updated_at=_dt.utcnow(),
    ))
    fresh_db.commit()

    # Warm the snapshot — a.com shows 'order'.
    dbmod._build_and_store_rows()
    by = {r.domain: r for r in dbmod._peek_rows_cache()[0]}
    assert by["a.com"].backlog_status == "order"

    # Wrap _build_all_rows so the FULL build reads stale rows first, then a
    # backlog patch commits + patches the cache mid-build (exactly what
    # set_backlog_status does), then the stale rows are returned for storing.
    real_build = dbmod._build_all_rows

    def racing_build(db, *, only_domains=None):
        rows = real_build(db, only_domains=only_domains)  # read BEFORE the commit
        if only_domains is None:
            bl = (
                db.query(BacklogDomain)
                .filter(BacklogDomain.domain == "a.com")
                .one()
            )
            bl.status = "discarded"
            db.commit()
            dbmod._patch_domains_in_cache(db, ["a.com"])
        return rows

    dbmod._build_all_rows = racing_build
    try:
        dbmod._build_and_store_rows()  # stores stale rows, then re-applies
    finally:
        dbmod._build_all_rows = real_build

    by = {r.domain: r for r in dbmod._peek_rows_cache()[0]}
    assert by["a.com"].backlog_status == "discarded"  # patch survived
    assert by["b.com"].backlog_status is None         # untouched


# --- External-mutation cache invalidation (the "pinned/checked it but the
# Database doesn't show it for minutes" bug) --------------------------------
# The rows snapshot has a 5-min TTL. Before this fix, only the in-router
# /database/* mutations invalidated it; pins made on the Jobs/Runs router and
# the batch-analysis autopin did NOT, so their effect stayed invisible until
# the TTL lapsed. These guard that each of those paths now invalidates.

def test_pin_run_domain_route_patches_cache(fresh_db, monkeypatch):
    """Pinning an rd via the Jobs router patches that domain into the
    snapshot immediately (instant per-row freshness)."""
    from app.models import RunDomain
    from app.routers import database as dbmod
    from app.routers import jobs as jobsmod
    _seed(fresh_db, ["a.com", "b.com"])
    rd = (
        fresh_db.query(RunDomain).filter(RunDomain.domain == "a.com").first()
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(
        dbmod, "_patch_domains_in_cache",
        lambda db, domains: calls.append(list(domains)),
    )
    jobsmod.pin_run_domain_route(rd.id, db=fresh_db)
    assert calls == [["a.com"]]


def test_unpin_run_domain_route_patches_cache(fresh_db, monkeypatch):
    from app.models import RunDomain
    from app.routers import database as dbmod
    from app.routers import jobs as jobsmod
    _seed(fresh_db, ["a.com", "b.com"])
    rd = (
        fresh_db.query(RunDomain).filter(RunDomain.domain == "a.com").first()
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(
        dbmod, "_patch_domains_in_cache",
        lambda db, domains: calls.append(list(domains)),
    )
    jobsmod.unpin_run_domain_route(rd.id, db=fresh_db)
    assert calls == [["a.com"]]


def test_pin_run_route_invalidates_cache(fresh_db, monkeypatch):
    """Pinning a run re-points the job's pins across a potentially large set,
    on a USER REQUEST — so it kicks the NON-BLOCKING background rebuild, never
    a synchronous inline patch (which would block the request ~20s at the
    ~20-30K checked-domain scale). Guards against re-introducing that."""
    from app.models import Run
    from app.routers import database as dbmod
    from app.routers import jobs as jobsmod
    _seed(fresh_db, ["a.com", "b.com"])
    run = fresh_db.query(Run).first()  # _seed makes 'done' runs
    invalidated: list[bool] = []
    patched: list[object] = []
    monkeypatch.setattr(
        dbmod, "_invalidate_rows_cache", lambda: invalidated.append(True),
    )
    monkeypatch.setattr(
        dbmod, "_patch_domains_in_cache",
        lambda db, domains: patched.append(domains),
    )
    jobsmod.pin_run_route(run.id, db=fresh_db)
    assert invalidated == [True]  # background rebuild kicked
    assert patched == []          # NOT a synchronous inline patch


def test_unpin_run_route_invalidates_cache(fresh_db, monkeypatch):
    from app.models import Run
    from app.routers import database as dbmod
    from app.routers import jobs as jobsmod
    _seed(fresh_db, ["a.com", "b.com"])
    run = fresh_db.query(Run).first()
    invalidated: list[bool] = []
    monkeypatch.setattr(
        dbmod, "_invalidate_rows_cache", lambda: invalidated.append(True),
    )
    jobsmod.unpin_run_route(run.id, db=fresh_db)
    assert invalidated == [True]


# --- Move-to-source bulk action (2026-08-05) -------------------------------
# bulk_set_source re-tags the "Source" (BacklogDomain.registrar) of selected
# Database domains so several small check-batches merge under one source.

def test_bulk_set_source_updates_and_creates(fresh_db, monkeypatch):
    """Existing backlog rows get their registrar re-tagged; a domain with no
    backlog row gets one created (status defaults to 'backlog'). Source is
    trimmed; counts reflect the split."""
    from app.models import BacklogDomain
    from app.routers import database as dbmod
    # The endpoint kicks a real background rebuild — stub it out in the test.
    monkeypatch.setattr(dbmod, "_invalidate_rows_cache", lambda: None)
    fresh_db.add(BacklogDomain(
        domain="a.com", registrar="old-src", status="backlog",
    ))
    fresh_db.commit()

    out = dbmod.bulk_set_source(
        dbmod.BulkSetSourceIn(domains=["a.com", "b.com"], source="  RU  "),
        db=fresh_db,
    )
    assert out.source == "RU"          # trimmed
    assert out.updated == 1            # a.com (existing row re-tagged)
    assert out.created == 1            # b.com (new backlog row)
    by = {b.domain: b for b in fresh_db.query(BacklogDomain).all()}
    assert by["a.com"].registrar == "RU"
    assert by["b.com"].registrar == "RU"
    assert by["b.com"].status == "backlog"


def test_bulk_set_source_rejects_empty_name(fresh_db):
    """An empty/whitespace source name is a 400 — the UI disables submit, but
    the endpoint guards it too (an empty registrar is meaningless)."""
    import pytest as _pytest
    from fastapi import HTTPException
    from app.routers import database as dbmod
    with _pytest.raises(HTTPException):
        dbmod.bulk_set_source(
            dbmod.BulkSetSourceIn(domains=["a.com"], source="   "),
            db=fresh_db,
        )


def test_bulk_set_source_filtered_scopes_to_filter(fresh_db, monkeypatch):
    """The all-filtered variant resolves the matching set via `list_domains`
    (same server-side filtering the page uses) and re-tags only those. Here
    the Source filter picks one of two checked domains."""
    from app.models import BacklogDomain
    from app.routers import database as dbmod
    monkeypatch.setattr(dbmod, "_invalidate_rows_cache", lambda: None)
    _seed(fresh_db, ["a.com", "b.com"])
    fresh_db.add_all([
        BacklogDomain(domain="a.com", registrar="src-a", status="backlog"),
        BacklogDomain(domain="b.com", registrar="src-b", status="backlog"),
    ])
    fresh_db.commit()
    # Filter to Source='src-a' → only a.com should be re-tagged to 'RU'.
    out = dbmod.bulk_set_source_filtered(
        dbmod.BulkSetSourceFilteredIn(source="RU", source_filter=["src-a"]),
        db=fresh_db,
    )
    assert out.source == "RU" and out.updated == 1
    by = {b.domain: b for b in fresh_db.query(BacklogDomain).all()}
    assert by["a.com"].registrar == "RU"      # matched the filter
    assert by["b.com"].registrar == "src-b"   # didn't match, untouched


def test_bulk_set_source_preserves_all_metrics(fresh_db, monkeypatch):
    """Moving a domain to another Source re-tags ONLY the registrar — every
    other datum is untouched: the import-time backlog fields (DR / age / rank /
    refdomains / prices / expiry / status / project / comments) AND the
    analysed metrics (verdict, score, DR/RD/backlinks) which live on
    RunDomain / CriterionResult, not the backlog row. Verified by comparing
    the WHOLE synthesized Database row before vs after — identical but for the
    source."""
    from datetime import date
    from app.models import BacklogDomain
    from app.routers import database as dbmod
    monkeypatch.setattr(dbmod, "_invalidate_rows_cache", lambda: None)
    # _seed gives a.com pinned wayback + backlinks + refdomains verdicts (a
    # non-trivial scored row); add a backlog row carrying every import field.
    _seed(fresh_db, ["a.com"])
    fresh_db.add(BacklogDomain(
        domain="a.com", registrar="old-src", status="order",
        ahrefs_dr=42.0, domain_age_years=5.5, ahrefs_rank=1234,
        dofollow_refdomains=99, desired_price=100.0, max_price=250.0,
        expiration_date=date(2027, 1, 1), project="proj-x", comments="note",
    ))
    fresh_db.commit()

    before = {r.domain: r for r in dbmod._build_all_rows(fresh_db)[0]}["a.com"]
    before_dump = before.model_dump()
    assert before_dump["final_score"] is not None  # proves it's non-trivial

    dbmod.bulk_set_source(
        dbmod.BulkSetSourceIn(domains=["a.com"], source="new-src"), db=fresh_db,
    )

    # BacklogDomain row: only registrar changed; everything else preserved.
    b = fresh_db.query(BacklogDomain).filter_by(domain="a.com").one()
    assert b.registrar == "new-src"
    assert (
        b.status, b.ahrefs_dr, b.domain_age_years, b.ahrefs_rank,
        b.dofollow_refdomains, b.desired_price, b.max_price,
        b.expiration_date, b.project, b.comments,
    ) == (
        "order", 42.0, 5.5, 1234, 99, 100.0, 250.0,
        date(2027, 1, 1), "proj-x", "note",
    )

    # The whole synthesized Database row is identical EXCEPT the source.
    after = {r.domain: r for r in dbmod._build_all_rows(fresh_db)[0]}["a.com"]
    after_dump = after.model_dump()
    assert after_dump["backlog_registrar"] == "new-src"
    before_dump.pop("backlog_registrar")
    after_dump.pop("backlog_registrar")
    assert before_dump == after_dump  # verdict, score, DR, RD, criteria — all intact


# --- Backlog-page move-to-source (2026-08-05) ------------------------------
# The Backlog side re-tags registrar directly on backlog rows (by id, or
# across the whole filtered set) — works on ANY rows regardless of status,
# for sweeping un-checked leftovers into one source.

def test_backlog_bulk_set_registrar_by_ids(fresh_db):
    from app.models import BacklogDomain
    from app.routers import backlog as blmod
    a = BacklogDomain(domain="a.com", registrar="old", status="backlog")
    b = BacklogDomain(domain="b.com", registrar="old", status="backlog")
    fresh_db.add_all([a, b])
    fresh_db.commit()
    out = blmod.bulk_set_registrar(
        blmod.BulkSetRegistrarIn(ids=[a.id], source="  RU  "), db=fresh_db,
    )
    assert out["updated"] == 1 and out["source"] == "RU"  # trimmed
    fresh_db.refresh(a)
    fresh_db.refresh(b)
    assert a.registrar == "RU"     # re-tagged
    assert b.registrar == "old"    # untouched (not in ids)


def test_backlog_bulk_set_registrar_filtered_scopes_to_filter(fresh_db):
    from app.models import BacklogDomain
    from app.routers import backlog as blmod
    keep = BacklogDomain(domain="k.com", registrar="old", status="backlog")
    disc = BacklogDomain(domain="d.com", registrar="old", status="discarded")
    fresh_db.add_all([keep, disc])
    fresh_db.commit()
    # Only status='backlog' rows should be re-tagged (chunked-update path).
    out = blmod.bulk_set_registrar_filtered(
        blmod.BulkSetRegistrarFilteredIn(source="RU", status_filter="backlog"),
        db=fresh_db,
    )
    assert out["updated"] == 1
    fresh_db.refresh(keep)
    fresh_db.refresh(disc)
    assert keep.registrar == "RU"
    assert disc.registrar == "old"


def test_backlog_bulk_set_registrar_rejects_empty(fresh_db):
    import pytest as _pytest
    from fastapi import HTTPException
    from app.routers import backlog as blmod
    with _pytest.raises(HTTPException):
        blmod.bulk_set_registrar(
            blmod.BulkSetRegistrarIn(ids=[1], source="  "), db=fresh_db,
        )
