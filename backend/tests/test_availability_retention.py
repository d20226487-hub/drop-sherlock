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


def _add_check(session, domain: str, days_ago: float, status: str = "registered",
               raw: str = "") -> int:
    """Insert one AvailabilityCheck with `checked_at` shifted by N days
    into the past. Returns the row id so tests can assert on specific
    rows surviving / being deleted."""
    from app.models import AvailabilityCheck
    row = AvailabilityCheck(
        domain=domain,
        provider="rdap",
        status=status,
        checked_at=datetime.utcnow() - timedelta(days=days_ago),
        latency_ms=10,
        registrar="",
        expires_on=None,
        error_message="",
        error_category="",
        raw_response=raw,
        run_id=None,
    )
    session.add(row)
    session.commit()
    return int(row.id)


def test_age_prune_deletes_older_rows(fresh_db):
    """Rows older than `retention_days` are deleted; younger rows stay —
    except a domain's latest answer (2026-11-01: old.kz's newer 45-day
    check is its only remaining answer, so it survives)."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    older_id = _add_check(fresh_db, "old.kz", days_ago=60)
    old_id = _add_check(fresh_db, "old.kz", days_ago=45)
    middle_id = _add_check(fresh_db, "middle.kz", days_ago=20)
    fresh_id = _add_check(fresh_db, "fresh.kz", days_ago=1)

    result = prune_availability_checks(
        fresh_db, retention_days=30, per_domain_keep=0,
    )
    fresh_db.commit()
    assert result["deleted_by_age"] == 1
    assert result["deleted_by_per_domain"] == 0
    assert result["total_after"] == 3

    survivors = {
        r.id for r in fresh_db.query(AvailabilityCheck).all()
    }
    assert older_id not in survivors
    assert old_id in survivors
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


# --- Latest answer is never pruned (2026-11-01) -----------------------------
#
# The Backlog's Availability column and filter read this table. Before this,
# a domain whose last check was older than the window lost its status and
# read as "never checked".


def test_age_prune_keeps_a_lone_old_answer_and_strips_its_payload(fresh_db):
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    lone = _add_check(fresh_db, "lone.kz", days_ago=200, raw="x" * 8000)
    recent = _add_check(fresh_db, "recent.kz", days_ago=1, raw="y" * 500)
    prune_availability_checks(fresh_db, retention_days=30, per_domain_keep=0)
    fresh_db.commit()

    kept = {r.id: r for r in fresh_db.query(AvailabilityCheck).all()}
    assert set(kept) == {lone, recent}
    assert kept[lone].status == "registered" and kept[lone].raw_response == ""
    assert kept[recent].raw_response == "y" * 500     # inside the window: untouched


def test_latest_definitive_survives_newer_inconclusive_checks(fresh_db):
    """registered 40 days ago, then two unknown checks (35 and 33 days):
    the registered answer is what the Backlog shows, so it stays, and so
    does the latest check of any status."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    answer = _add_check(fresh_db, "flaky.kz", days_ago=40, status="registered")
    _add_check(fresh_db, "flaky.kz", days_ago=35, status="unknown")
    latest = _add_check(fresh_db, "flaky.kz", days_ago=33, status="unknown")
    prune_availability_checks(fresh_db, retention_days=30, per_domain_keep=0)
    fresh_db.commit()
    assert {r.id for r in fresh_db.query(AvailabilityCheck)} == {answer, latest}


def test_per_domain_cap_never_drops_the_latest_answer(fresh_db):
    """Five newer error checks would push the only definitive answer past
    per_domain_keep=3; it's kept anyway (one row over the cap)."""
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    answer = _add_check(fresh_db, "noisy.kz", days_ago=10, status="available")
    errors = [_add_check(fresh_db, "noisy.kz", days_ago=9 - i, status="error")
              for i in range(5)]
    result = prune_availability_checks(fresh_db, retention_days=0, per_domain_keep=3)
    fresh_db.commit()
    survivors = {r.id for r in fresh_db.query(AvailabilityCheck)}
    assert survivors == {answer, *errors[-3:]}
    assert result["deleted_by_per_domain"] == 2


def test_domain_without_a_definitive_answer_keeps_its_latest_check(fresh_db):
    from app.availability.retention import prune_availability_checks
    from app.models import AvailabilityCheck

    _add_check(fresh_db, "never-sure.kz", days_ago=90, status="error")
    latest = _add_check(fresh_db, "never-sure.kz", days_ago=80, status="unknown")
    prune_availability_checks(fresh_db, retention_days=30, per_domain_keep=0)
    fresh_db.commit()
    assert [r.id for r in fresh_db.query(AvailabilityCheck)] == [latest]
