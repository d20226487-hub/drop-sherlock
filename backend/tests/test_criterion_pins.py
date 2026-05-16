"""Integration coverage for the per-(job, criterion) pin model added
2026-05-12. Spins up a fresh in-memory-ish SQLite (tempfile, since some
of our migrations use ALTER which is awkward over :memory:) and walks
through the canonical scenarios:

  1. Setting / clearing pins via the endpoints.
  2. The Database-page rollup sources each criterion from its pin, with
     no fallback when a criterion has no pin.
  3. Two pinned runs in one job (Wayback in Run A, Ahrefs in Run B)
     correctly stitch into one Database row with `final_partial=True`
     and `pinned_criteria=[…]`.
  4. Legacy Run.is_pinned auto-expands into per-criterion pins on the
     migration helper.

Tests bypass the actual FastAPI lifespan + tasks scheduler — we call the
SQLAlchemy models + the route functions directly, which is the seam these
invariants live behind.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timedelta

import pytest


@pytest.fixture
def fresh_db(monkeypatch):
    """One-shot SQLite file, fresh schema, fresh engine. We import the
    app package AFTER setting DATABASE_URL so the engine binds to our
    temp file rather than the production /data path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    url = f"sqlite:///{tmp.name}"
    monkeypatch.setenv("DATABASE_URL", url)

    # Drop any cached imports — pydantic-settings caches the Settings()
    # instance at module load, and our DB engine binds at module load,
    # so a cold import is the cleanest reset.
    import importlib
    import sys
    for name in list(sys.modules):
        if name.startswith("app."):
            del sys.modules[name]
    if "app" in sys.modules:
        del sys.modules["app"]

    from app import db as db_mod
    from app import models  # noqa: F401  (registers tables)
    from app.main import _migrate_sqlite_columns
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
    _migrate_sqlite_columns()

    session = db_mod.SessionLocal()
    try:
        yield session, db_mod
    finally:
        session.close()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _seed_job_with_runs(session):
    """Create a Job with two Runs, each carrying RunDomains and CRs for
    the same domain "example.com" but different criteria sets:

      Run A (id=1): wayback criterion only (status=done, has data_json)
      Run B (id=2): backlinks + refdomains (status=done, has data_json)

    Returns (job, run_a, run_b).
    """
    from app.models import CriterionResult, Job, Run, RunDomain
    now = datetime.utcnow()
    job = Job(name="t", spec_json="{}")
    session.add(job)
    session.flush()

    run_a = Run(
        job_id=job.id, status="done", spec_json="{}",
        started_at=now - timedelta(hours=2),
        finished_at=now - timedelta(hours=1),
        name="wayback-pass",
    )
    run_b = Run(
        job_id=job.id, status="done", spec_json="{}",
        started_at=now - timedelta(hours=1),
        finished_at=now,
        name="ahrefs-pass",
    )
    session.add_all([run_a, run_b])
    session.flush()

    rd_a = RunDomain(
        run_id=run_a.id, domain="example.com", status="done",
        started_at=now, finished_at=now,
    )
    rd_b = RunDomain(
        run_id=run_b.id, domain="example.com", status="done",
        started_at=now, finished_at=now,
    )
    session.add_all([rd_a, rd_b])
    session.flush()

    session.add_all([
        CriterionResult(
            run_domain_id=rd_a.id, criterion="wayback", status="done",
            data_json=json.dumps({"samples": [{"ts": "20200101"}]}),
            ai_verdict_json=json.dumps(
                {"assessment": "good", "confidence": 0.9},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_b.id, criterion="backlinks", status="done",
            data_json=json.dumps({"backlinks": [1, 2, 3]}),
            ai_verdict_json=json.dumps(
                {"assessment": "high_quality", "confidence": 0.8},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_b.id, criterion="refdomains", status="done",
            data_json=json.dumps({"refdomains": [1, 2]}),
            ai_verdict_json=json.dumps(
                {"assessment": "mixed", "confidence": 0.7},
            ),
        ),
    ])
    session.commit()
    return job, run_a, run_b


def test_set_and_clear_criterion_pin(fresh_db):
    session, _ = fresh_db
    from app.models import JobCriterionPin
    from app.routers.jobs import (
        CriterionPinIn,
        clear_criterion_pin,
        set_criterion_pin,
    )
    job, run_a, _ = _seed_job_with_runs(session)

    set_criterion_pin(
        job.id,
        CriterionPinIn(criterion="wayback", run_id=run_a.id),
        db=session,
    )
    pin = session.query(JobCriterionPin).one()
    assert pin.job_id == job.id
    assert pin.criterion == "wayback"
    assert pin.run_id == run_a.id

    clear_criterion_pin(job.id, "wayback", db=session)
    assert session.query(JobCriterionPin).count() == 0


def test_set_criterion_pin_rejects_other_jobs_run(fresh_db):
    """A pin can only point at a Run that belongs to its own Job."""
    from fastapi import HTTPException
    session, _ = fresh_db
    from app.models import Job, Run
    from app.routers.jobs import CriterionPinIn, set_criterion_pin

    job, _, _ = _seed_job_with_runs(session)
    other_job = Job(name="other", spec_json="{}")
    session.add(other_job)
    session.flush()
    other_run = Run(job_id=other_job.id, status="done", spec_json="{}")
    session.add(other_run)
    session.commit()

    with pytest.raises(HTTPException) as exc:
        set_criterion_pin(
            job.id,
            CriterionPinIn(criterion="wayback", run_id=other_run.id),
            db=session,
        )
    assert exc.value.status_code == 400


def test_database_rollup_stitches_two_runs_partial_final(fresh_db):
    """The canonical scenario the feature was built for: Wayback verdict
    from Run A, Backlinks/Refdomains from Run B, both pinned within one
    Job. The Database row carries both sets and is marked partial."""
    session, _ = fresh_db
    from app.models import JobCriterionPin
    from app.routers.database import list_domains
    job, run_a, run_b = _seed_job_with_runs(session)

    session.add_all([
        JobCriterionPin(
            job_id=job.id, criterion="wayback", run_id=run_a.id,
        ),
        JobCriterionPin(
            job_id=job.id, criterion="backlinks", run_id=run_b.id,
        ),
        JobCriterionPin(
            job_id=job.id, criterion="refdomains", run_id=run_b.id,
        ),
    ])
    session.commit()

    resp = list_domains(db=session)
    rows = [r for r in resp.rows if r.domain == "example.com"]
    assert len(rows) == 1
    row = rows[0]
    assert row.is_pinned is True
    assert set(row.pinned_criteria) == {"wayback", "backlinks", "refdomains"}
    # Partial fires because anchors + keywords (both weight > 0 in
    # default scoring config) are NOT pinned. Multi-source by itself
    # does NOT imply partial (decision 2026-05-12 second pass).
    assert row.final_partial is True
    # Score is still synthesized from what IS pinned: backlinks
    # (high_quality, 85) @ weight 0.4 + refdomains (mixed, 50) @
    # weight 0.2 → (0.4·85 + 0.2·50) / 0.6 = 73.33. wayback w=0 by
    # default so doesn't contribute.
    assert row.final_score is not None
    assert 70.0 < row.final_score < 76.0
    assert row.final_bucket == "mixed"
    # Per-criterion source attribution surfaces in CriterionSummary
    assert row.criteria["wayback"].source_run_id == run_a.id
    assert row.criteria["backlinks"].source_run_id == run_b.id
    assert row.criteria["refdomains"].source_run_id == run_b.id
    # Wayback assessment piped through from the wayback-source run's CR
    assert row.wayback_assessment == "good"


def test_database_rollup_no_pin_empty_row(fresh_db):
    """Domain with NO criterion pinned should still appear, with every
    criterion column empty — supports the 'curatorial' invariant."""
    session, _ = fresh_db
    from app.routers.database import list_domains
    _seed_job_with_runs(session)
    # No JobCriterionPin rows inserted

    resp = list_domains(db=session)
    rows = [r for r in resp.rows if r.domain == "example.com"]
    assert len(rows) == 1
    row = rows[0]
    assert row.is_pinned is False
    assert row.pinned_criteria == []
    for cs in row.criteria.values():
        assert cs.enabled is False
        assert cs.rows == 0
        assert cs.source_run_id is None


def test_legacy_run_pinned_expands_into_criterion_pins(fresh_db):
    """The startup migration helper expands Run.is_pinned=True into one
    JobCriterionPin per criterion that run has data for."""
    session, _ = fresh_db
    from app.main import _migrate_legacy_pins_to_criterion_pins
    from app.models import JobCriterionPin
    job, _, run_b = _seed_job_with_runs(session)
    run_b.is_pinned = True
    session.commit()

    _migrate_legacy_pins_to_criterion_pins()
    session.expire_all()

    pins = session.query(JobCriterionPin).all()
    by_crit = {p.criterion: p.run_id for p in pins}
    assert by_crit == {"backlinks": run_b.id, "refdomains": run_b.id}


def test_partial_false_when_all_weighted_pinned(fresh_db):
    """Canonical user workflow: pin all 4 Ahrefs criteria (the only
    weighted ones in default scoring config). Score must display and
    partial must be False, even though Wayback is also pinned from a
    different run."""
    session, _ = fresh_db
    from app.models import (
        CriterionResult,
        JobCriterionPin,
        Job,
        Run,
        RunDomain,
    )
    from app.routers.database import list_domains
    now = datetime.utcnow()
    job = Job(name="full-cascade", spec_json="{}")
    session.add(job)
    session.flush()
    run_wb = Run(
        job_id=job.id, status="done", spec_json="{}",
        finished_at=now - timedelta(hours=2),
    )
    run_ah = Run(
        job_id=job.id, status="done", spec_json="{}",
        finished_at=now - timedelta(hours=1),
    )
    session.add_all([run_wb, run_ah])
    session.flush()
    rd_wb = RunDomain(
        run_id=run_wb.id, domain="x.com", status="done", finished_at=now,
    )
    rd_ah = RunDomain(
        run_id=run_ah.id, domain="x.com", status="done", finished_at=now,
    )
    session.add_all([rd_wb, rd_ah])
    session.flush()
    session.add_all([
        CriterionResult(
            run_domain_id=rd_wb.id, criterion="wayback", status="done",
            data_json="{}",
            ai_verdict_json=json.dumps(
                {"assessment": "high_quality", "confidence": 0.9},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_ah.id, criterion="backlinks", status="done",
            data_json="{}",
            ai_verdict_json=json.dumps(
                {"assessment": "high_quality", "confidence": 0.8},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_ah.id, criterion="refdomains", status="done",
            data_json="{}",
            ai_verdict_json=json.dumps(
                {"assessment": "high_quality", "confidence": 0.8},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_ah.id, criterion="anchors", status="done",
            data_json="{}",
            ai_verdict_json=json.dumps(
                {"assessment": "mixed", "confidence": 0.7},
            ),
        ),
        CriterionResult(
            run_domain_id=rd_ah.id, criterion="keywords", status="done",
            data_json="{}",
            ai_verdict_json=json.dumps(
                {"assessment": "mixed", "confidence": 0.6},
            ),
        ),
    ])
    for crit, run in (
        ("wayback", run_wb),
        ("backlinks", run_ah),
        ("refdomains", run_ah),
        ("anchors", run_ah),
        ("keywords", run_ah),
    ):
        session.add(JobCriterionPin(
            job_id=job.id, criterion=crit, run_id=run.id,
        ))
    session.commit()

    resp = list_domains(db=session)
    row = next(r for r in resp.rows if r.domain == "x.com")
    # All weighted criteria (B/D/A/K) pinned → NOT partial even though
    # criteria came from two different runs.
    assert row.final_partial is False
    assert row.final_score is not None
    # Two HQ @ 0.4+0.2 and two mixed @ 0.3+0.1 →
    # (0.4·85 + 0.2·85 + 0.3·50 + 0.1·50) / 1.0 = 71.0
    assert 70.0 < row.final_score < 72.0
    assert row.final_bucket == "mixed"


def test_pin_run_all_criteria_endpoint(fresh_db):
    """POST /runs/{id}/pin-all-criteria pins every criterion the run has
    populated CRs for, replacing any pre-existing pin on the same
    (job, criterion) pair."""
    session, _ = fresh_db
    from app.models import JobCriterionPin
    from app.routers.jobs import pin_run_all_criteria
    job, run_a, run_b = _seed_job_with_runs(session)

    # Pre-existing pin on a different run for one of run_b's criteria
    session.add(JobCriterionPin(
        job_id=job.id, criterion="backlinks", run_id=run_a.id,
    ))
    session.commit()

    out = pin_run_all_criteria(run_b.id, db=session)
    assert set(out.pinned_criteria) == {"backlinks", "refdomains"}
    assert out.replaced == 1  # the pre-existing backlinks pin was overwritten

    by_crit = {
        p.criterion: p.run_id
        for p in session.query(JobCriterionPin).all()
    }
    assert by_crit == {"backlinks": run_b.id, "refdomains": run_b.id}


def test_aux_pillar_rd_does_not_steal_primary_run(fresh_db):
    """Regression for 2026-05-16: a more-recent whois_history rd was
    becoming `primary_run`, which silently dropped the Quality run's
    `scoring_override_json` off the synth and re-scored already-scored
    Quality rows under global weights.

    Scenario: Quality job pins B/D/A/K on a run with an override that
    differs sharply from global weights. A separate whois_history job
    runs LATER and creates a whois CR for the same domain (not pinned).
    Expectation: the Database row still synthesizes under the Quality
    run's override weights, not the whois run's (absent) override —
    so the score must match what the Quality run alone would have
    produced.
    """
    session, _ = fresh_db
    from app.models import (
        CriterionResult,
        Job,
        JobCriterionPin,
        Run,
        RunDomain,
    )
    from app.routers.database import list_domains
    now = datetime.utcnow()

    # Quality job — finishes EARLIER. Override weights skew toward
    # backlinks/anchors; deliberately differ from default global weights
    # (B:0.3, D:0.1, A:0.2, K:0.4) so the score differs depending on
    # which weights win.
    qjob = Job(name="quality", kind="quality", spec_json="{}")
    session.add(qjob)
    session.flush()
    override = {
        "weights": {
            "backlinks": 0.4, "refdomains": 0.2,
            "anchors": 0.3, "keywords": 0.1,
            "wayback": 0.0, "wayback_classify": 0.0,
        },
    }
    qrun = Run(
        job_id=qjob.id, status="done", spec_json="{}",
        finished_at=now - timedelta(days=1),
        scoring_override_json=json.dumps(override),
        name="quality-pass",
    )
    session.add(qrun)
    session.flush()
    qrd = RunDomain(
        run_id=qrun.id, domain="ex.com", status="done",
        finished_at=now - timedelta(days=1),
    )
    session.add(qrd)
    session.flush()
    # B/D/A/K verdicts. Score under override (B:0.4 D:0.2 A:0.3 K:0.1):
    # 0.4·85 + 0.2·85 + 0.3·50 + 0.1·50 = 71.0. Score under global
    # weights (B:0.3 D:0.1 A:0.2 K:0.4): 0.3·85 + 0.1·85 + 0.2·50 +
    # 0.4·50 = 64.0. 7 points apart, well outside floating-point noise.
    session.add_all([
        CriterionResult(
            run_domain_id=qrd.id, criterion=c, status="done",
            data_json="{}",
            ai_verdict_json=json.dumps({
                "assessment": a, "confidence": 0.85,
            }),
        )
        for c, a in (
            ("backlinks", "high_quality"),
            ("refdomains", "high_quality"),
            ("anchors", "mixed"),
            ("keywords", "mixed"),
        )
    ])
    for crit in ("backlinks", "refdomains", "anchors", "keywords"):
        session.add(JobCriterionPin(
            job_id=qjob.id, criterion=crit, run_id=qrun.id,
        ))

    # Whois-history job — finishes AFTER the Quality run. No
    # scoring_override. Domain is the same.
    wjob = Job(name="whois", kind="whois_history", spec_json="{}")
    session.add(wjob)
    session.flush()
    wrun = Run(
        job_id=wjob.id, status="done", spec_json="{}",
        finished_at=now,
        name="whois-pass",
    )
    session.add(wrun)
    session.flush()
    wrd = RunDomain(
        run_id=wrun.id, domain="ex.com", status="done", finished_at=now,
    )
    session.add(wrd)
    session.flush()
    session.add(CriterionResult(
        run_domain_id=wrd.id, criterion="whois_history", status="done",
        data_json="{}",
        ai_verdict_json=json.dumps({
            "dropped_confidence": 0.1, "summary": "stable",
        }),
    ))
    # Whois became pin-only 2026-05-17. Add an explicit pin so the
    # whois column populates — without it the column would correctly
    # render blank (which would no longer exercise the "aux source can
    # contaminate primary_run" path this test guards).
    session.add(JobCriterionPin(
        job_id=wjob.id, criterion="whois_history", run_id=wrun.id,
    ))
    session.commit()

    resp = list_domains(db=session)
    row = next(r for r in resp.rows if r.domain == "ex.com")

    # The score must reflect the Quality run's override weights, not
    # the global fallback. Pre-fix this came out as 64.0 (global
    # weights via the whois rd's primary_run promotion) instead of
    # 71.0.
    assert row.final_score is not None
    assert 70.5 < row.final_score < 71.5, (
        f"Expected ~71.0 from override weights; got {row.final_score}. "
        "Whois rd likely contaminated primary_run."
    )
    # Whois column populated from the explicit pin (aux_sources entry).
    assert row.whois_dropped_confidence == 0.1
    assert row.whois_band == "stable"
    # `pinned_criteria` reports Quality criteria only — whois is an aux
    # pillar, not part of the scoring math.
    assert "whois_history" not in row.pinned_criteria
    assert set(row.pinned_criteria) == {
        "backlinks", "refdomains", "anchors", "keywords",
    }


def test_whois_history_is_pin_only_on_database(fresh_db):
    """2026-05-17: whois_history became pin-only on the Database page,
    same contract as every Quality criterion. A whois CR with a populated
    verdict must NOT auto-surface on the Database row until the operator
    explicitly pins the whois run.

    Asserts both halves:
      1. CR present, no pin → whois column stays blank.
      2. Same data + a pin → whois column populates.
    """
    from app.models import (
        CriterionResult,
        Job,
        JobCriterionPin,
        Run,
        RunDomain,
    )
    from app.routers.database import list_domains
    session, _ = fresh_db
    now = datetime.utcnow()

    job = Job(name="whois-only", kind="whois_history", spec_json="{}")
    session.add(job)
    session.flush()
    run = Run(
        job_id=job.id, status="done", spec_json="{}", finished_at=now,
    )
    session.add(run)
    session.flush()
    rd = RunDomain(run_id=run.id, domain="pin-test.example",
                   status="done", finished_at=now)
    session.add(rd)
    session.flush()
    session.add(CriterionResult(
        run_domain_id=rd.id, criterion="whois_history", status="done",
        data_json="{}",
        ai_verdict_json=json.dumps(
            {"dropped_confidence": 0.85, "summary": "drop signals"},
        ),
    ))
    session.commit()

    # Phase 1 — no pin yet: column must be blank.
    resp = list_domains(db=session)
    row = next(r for r in resp.rows if r.domain == "pin-test.example")
    assert row.whois_dropped_confidence is None, (
        "whois column auto-surfaced without a pin — pin-only contract "
        "is broken (the fallback is back)"
    )
    assert row.whois_band == ""
    assert row.whois_summary == ""
    assert "whois_history" not in (row.pinned_criteria or [])

    # Phase 2 — explicit pin: column populates.
    session.add(JobCriterionPin(
        job_id=job.id, criterion="whois_history", run_id=run.id,
    ))
    session.commit()
    resp = list_domains(db=session)
    row = next(r for r in resp.rows if r.domain == "pin-test.example")
    assert row.whois_dropped_confidence == 0.85
    assert row.whois_band == "dropped"  # > 0.80 → 'dropped' band
