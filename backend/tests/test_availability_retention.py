"""Tests for the availability_checks retention prune.

Pins the two compounding caps (age + per-domain) and the no-op cases.
Uses the same fresh-DB fixture pattern as test_availability.py — fresh
SQLite file per test, app modules reimported so the engine targets it.
"""
from __future__ import annotations

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


def _add_check(session, domain: str, days_ago: float) -> int:
    """Insert one AvailabilityCheck with `checked_at` shifted by N days
    into the past. Returns the row id so tests can assert on specific
    rows surviving / being deleted."""
    from app.models import AvailabilityCheck
    row = AvailabilityCheck(
        domain=domain,
        provider="rdap",
        status="registered",
        checked_at=datetime.utcnow() - timedelta(days=days_ago),
        latency_ms=10,
        registrar="",
        expires_on=None,
        error_message="",
        error_category="",
        run_id=None,
    )
    session.add(row)
    session.commit()
    return int(row.id)


def test_age_prune_deletes_older_rows(fresh_db):
    """Rows older than `retention_days` are deleted; younger rows stay."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    old_id = _add_check(fresh_db, "old.kz", days_ago=45)
    middle_id = _add_check(fresh_db, "middle.kz", days_ago=20)
    fresh_id = _add_check(fresh_db, "fresh.kz", days_ago=1)

    result = prune_availability_checks(
        fresh_db, retention_days=30, per_domain_keep=0,
    )
    fresh_db.commit()
    assert result["deleted_by_age"] == 1
    assert result["deleted_by_per_domain"] == 0
    assert result["total_after"] == 2

    survivors = {
        r.id for r in fresh_db.query(AvailabilityCheck).all()
    }
    assert old_id not in survivors
    assert middle_id in survivors
    assert fresh_id in survivors


def test_age_prune_disabled_when_zero_days(fresh_db):
    """retention_days=0 → no age-based deletion (even ancient rows survive)."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    _add_check(fresh_db, "ancient.kz", days_ago=365 * 5)
    _add_check(fresh_db, "fresh.kz", days_ago=1)

    result = prune_availability_checks(
        fresh_db, retention_days=0, per_domain_keep=0,
    )
    fresh_db.commit()
    assert result["deleted_by_age"] == 0
    assert result["total_after"] == 2
    assert fresh_db.query(AvailabilityCheck).count() == 2


def test_per_domain_cap_keeps_most_recent(fresh_db):
    """For a domain with >M rows, the oldest get deleted; newest M stay."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    # Insert in oldest→newest order so id ascending = chronological.
    ids = [_add_check(fresh_db, "hot.kz", days_ago=10 - i) for i in range(8)]
    # ids[0] is oldest (10 days ago), ids[7] is newest (3 days ago).

    result = prune_availability_checks(
        fresh_db, retention_days=0, per_domain_keep=3,
    )
    fresh_db.commit()
    assert result["deleted_by_age"] == 0
    assert result["deleted_by_per_domain"] == 5
    assert result["total_after"] == 3

    survivors = sorted(
        r.id for r in fresh_db.query(AvailabilityCheck).all()
    )
    # The three highest ids (most recent) should survive.
    assert survivors == sorted(ids[-3:])


def test_per_domain_cap_disabled_when_zero(fresh_db):
    """per_domain_keep=0 → no per-domain trimming."""
    from app.availability.retention import prune_availability_checks

    for i in range(10):
        _add_check(fresh_db, "noisy.kz", days_ago=10 - i)
    result = prune_availability_checks(
        fresh_db, retention_days=0, per_domain_keep=0,
    )
    fresh_db.commit()
    assert result["deleted_by_per_domain"] == 0
    assert result["total_after"] == 10


def test_both_caps_compound(fresh_db):
    """Age prune fires first, then the per-domain cap applies to what
    remains. Verifies the two phases compose without double-counting."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    # noisy.kz: 5 ancient (deleted by age) + 5 recent (one survives
    # per_domain cap=1).
    ancient_ids = [
        _add_check(fresh_db, "noisy.kz", days_ago=40 + i) for i in range(5)
    ]
    recent_ids = [
        _add_check(fresh_db, "noisy.kz", days_ago=5 - i) for i in range(5)
    ]
    # other.kz: one recent row, well under both caps — should survive.
    other_id = _add_check(fresh_db, "other.kz", days_ago=2)

    result = prune_availability_checks(
        fresh_db, retention_days=30, per_domain_keep=1,
    )
    fresh_db.commit()
    assert result["deleted_by_age"] == 5
    assert result["deleted_by_per_domain"] == 4
    assert result["total_after"] == 2  # 1 from noisy.kz + 1 from other.kz

    survivors = {r.id for r in fresh_db.query(AvailabilityCheck).all()}
    # No ancient row survives the age sweep.
    for old in ancient_ids:
        assert old not in survivors
    # Only the single most-recent noisy row survives the per-domain cap.
    assert recent_ids[-1] in survivors
    assert other_id in survivors


def test_settings_clamp_negative_values(fresh_db):
    """Misconfigured non-numeric or negative values fall back to defaults
    (defensive — the validated setter should already prevent these, but
    the read-side clamp belts-and-suspenders)."""
    from app.app_settings import (
        AVAILABILITY_DEFAULTS,
        _set,
        get_availability_per_domain_keep,
        get_availability_retention_days,
    )

    # Default reads = the AVAILABILITY_DEFAULTS values.
    assert get_availability_retention_days() == int(
        AVAILABILITY_DEFAULTS["availability__retention_days"]
    )
    assert get_availability_per_domain_keep() == int(
        AVAILABILITY_DEFAULTS["availability__per_domain_keep"]
    )

    # Negative via direct DB write — bypasses validated setter.
    _set(fresh_db, "availability__retention_days", "-5")
    _set(fresh_db, "availability__per_domain_keep", "-100")
    fresh_db.commit()
    assert get_availability_retention_days() == 0
    assert get_availability_per_domain_keep() == 0
