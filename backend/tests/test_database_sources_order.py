"""The Database page's Source filter lists sources newest import first
(2026-10-31; was A→Z)."""
from __future__ import annotations

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


def test_sources_are_ordered_by_latest_import(fresh_db):
    from app.models import BacklogDomain
    from app.routers.database import _sources_newest_first

    def add(domain, source, when):
        fresh_db.add(BacklogDomain(domain=domain, registrar=source,
                                   created_at=datetime.fromisoformat(when)))

    add("a1.kz", "alpha", "2026-01-10")
    add("b1.kz", "beta", "2026-03-01")
    add("c1.kz", "gamma", "2026-02-01")
    # alpha got a second, newer import: its latest import is what counts.
    add("a2.kz", "alpha", "2026-04-15")
    add("n1.kz", "", "2026-05-01")  # no source: never listed
    # Newest, but alphabetically in the middle: tells the order from A→Z.
    add("d1.kz", "delta", "2026-05-20")
    fresh_db.commit()

    assert _sources_newest_first(fresh_db, set()) == ["delta", "alpha", "beta", "gamma"]


def test_names_only_seen_on_rows_follow_alphabetically(fresh_db):
    """`sources_seen` names already in the table keep their date position;
    any that aren't (defensive) are appended A→Z, never dropped."""
    from app.models import BacklogDomain
    from app.routers.database import _sources_newest_first

    fresh_db.add(BacklogDomain(domain="x.kz", registrar="old",
                               created_at=datetime(2026, 1, 1)))
    fresh_db.add(BacklogDomain(domain="y.kz", registrar="new",
                               created_at=datetime(2026, 6, 1)))
    fresh_db.commit()

    got = _sources_newest_first(fresh_db, {"old", "zeta", "", "eta"})
    assert got == ["new", "old", "eta", "zeta"]


def test_backlog_source_filter_uses_the_same_order(fresh_db):
    """The Backlog page's Source filter lists sources like the Database
    page's: newest import first (2026-11-01; was A→Z)."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models import BacklogDomain

    for domain, source, when in (
        ("a1.kz", "alpha", "2026-01-10"), ("b1.kz", "beta", "2026-03-01"),
        ("c1.kz", "gamma", "2026-02-01"), ("a2.kz", "alpha", "2026-04-15"),
        ("n1.kz", "", "2026-05-01"), ("d1.kz", "delta", "2026-05-20"),
    ):
        fresh_db.add(BacklogDomain(domain=domain, registrar=source,
                                   created_at=datetime.fromisoformat(when)))
    fresh_db.commit()

    body = TestClient(app).get("/backlog?per_page=10").json()
    assert body["registrars"] == ["delta", "alpha", "beta", "gamma"]


def test_source_order_index_exists(fresh_db):
    """Startup migration adds the (registrar, created_at) index that lets
    MAX(created_at) per source come from the index alone."""
    from sqlalchemy import text
    cols = [r[2] for r in fresh_db.execute(text(
        "PRAGMA index_info(ix_backlog_domains_registrar_created_at)"))]
    assert cols == ["registrar", "created_at"]
