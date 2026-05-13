"""Coverage for per-run scoring-weights override (2026-05-13 wave J).

Tests the three sibling endpoints' contracts via the helper
`recompute_run_finals`: preview (no writes), apply (override + rewrite),
reset (clear override + recompute with global weights). Also pins the
'partials are skipped' invariant + the prose preservation guarantee.
"""
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


def _verdict(assessment: str, confidence: float = 0.8) -> dict:
    return {"assessment": assessment, "confidence": confidence}


def _build_rd(
    session,
    *,
    domain: str = "ex.com",
    sub_verdicts: dict[str, dict] | None = None,
    final_parsed: dict | None = None,
) -> tuple[int, int]:
    """Create a Job/Run/RunDomain with per-criterion AI verdicts + an
    optional preset final_assessment_json. Returns (run_id, rd_id)."""
    from app.models import CriterionResult, Job, Run, RunDomain

    spec_dict = {
        "criteria": {
            "backlinks":  {"enabled": True, "limit": 50, "mode": "live"},
            "refdomains": {"enabled": True, "limit": 50, "mode": "live"},
            "anchors":    {"enabled": True, "limit": 50, "mode": "live"},
            "keywords":   {"enabled": True, "limit": 50, "country": "us"},
            "wayback":    {"enabled": False},
            "wayback_classify": {"enabled": False},
        },
        "ai": {"provider": "gemini", "model": "test"},
    }
    job = Job(name="t", spec_json=json.dumps(spec_dict))
    session.add(job); session.flush()
    run = Run(
        job_id=job.id, status="done", spec_json=json.dumps(spec_dict),
        finished_at=datetime.utcnow(),
    )
    session.add(run); session.flush()
    rd = RunDomain(
        run_id=run.id, domain=domain, status="done",
        finished_at=datetime.utcnow(),
        final_assessment_json=(
            json.dumps(final_parsed, ensure_ascii=False)
            if final_parsed is not None else ""
        ),
        final_summary=(
            (final_parsed or {}).get("final_label", "")
            if final_parsed else ""
        ),
    )
    session.add(rd); session.flush()
    for crit, verdict in (sub_verdicts or {}).items():
        session.add(CriterionResult(
            run_domain_id=rd.id, criterion=crit, status="done",
            ai_verdict_json=json.dumps(verdict, ensure_ascii=False),
        ))
    session.commit()
    return run.id, rd.id


def test_preview_returns_recomputed_scores_without_writing(fresh_db):
    """Pure preview: no Run.scoring_override_json change, no rd
    final_assessment_json change. Returned rows reflect the new weights."""
    from app.models import Run, RunDomain
    from app.tasks import recompute_run_finals

    sub_verdicts = {
        "backlinks":  _verdict("high_quality", 0.9),  # 85
        "refdomains": _verdict("high_quality", 0.9),  # 85
        "anchors":    _verdict("low_quality", 0.5),   # 15
        "keywords":   _verdict("low_quality", 0.5),   # 15
    }
    # Original AI synth would use global weights B=0.4 D=0.2 A=0.3 K=0.1:
    # = 85*0.4 + 85*0.2 + 15*0.3 + 15*0.1 = 34+17+4.5+1.5 = 57
    original = {
        "final": 57.0, "confidence": 0.7,
        "summary": "mixed bag",
        "recommendation": "review B/D",
        "provider": "gemini", "model": "test",
    }
    run_id, rd_id = _build_rd(
        fresh_db, sub_verdicts=sub_verdicts, final_parsed=original,
    )

    # Reweight heavily toward backlinks (B=0.9, others tiny):
    # = 85*0.9 + 85*0.025 + 15*0.025 + 15*0.05 ≈ 76.5 + 2.125 + 0.375 + 0.75 ≈ 79.75
    new_weights = {
        "backlinks": 0.9, "refdomains": 0.025,
        "anchors": 0.025, "keywords": 0.05,
        "wayback": 0.0, "wayback_classify": 0.0,
    }
    result = recompute_run_finals(run_id, new_weights, preview=True)

    assert result["preview"] is True
    assert result["weights_applied"] == new_weights
    assert len(result["rows"]) == 1
    row = result["rows"][0]
    assert row["run_domain_id"] == rd_id
    assert row["score_old"] == 57.0
    assert row["score_new"] is not None and 75 <= row["score_new"] <= 82
    assert row["partial"] is False

    # No DB writes happened.
    fresh_db.expire_all()
    run = fresh_db.get(Run, run_id)
    rd = fresh_db.get(RunDomain, rd_id)
    assert run.scoring_override_json == ""
    persisted = json.loads(rd.final_assessment_json)
    assert persisted["final"] == 57.0
    assert persisted["summary"] == "mixed bag"


def test_apply_persists_override_and_rewrites_finals(fresh_db):
    """Apply: sets Run.scoring_override_json, rewrites
    rd.final_assessment_json's `final` field, preserves prose."""
    from app.models import Run, RunDomain
    from app.tasks import recompute_run_finals

    sub_verdicts = {
        "backlinks":  _verdict("high_quality", 0.9),
        "refdomains": _verdict("high_quality", 0.9),
        "anchors":    _verdict("low_quality", 0.5),
        "keywords":   _verdict("low_quality", 0.5),
    }
    original = {
        "final": 57.0, "confidence": 0.7,
        "summary": "PROSE STAYS THE SAME",
        "recommendation": "RECO STAYS THE SAME",
        "provider": "gemini", "model": "test",
    }
    run_id, rd_id = _build_rd(
        fresh_db, sub_verdicts=sub_verdicts, final_parsed=original,
    )

    new_weights = {
        "backlinks": 0.9, "refdomains": 0.025,
        "anchors": 0.025, "keywords": 0.05,
        "wayback": 0.0, "wayback_classify": 0.0,
    }
    result = recompute_run_finals(run_id, new_weights, preview=False)
    assert result["preview"] is False
    assert result["override_active"] is True

    fresh_db.expire_all()
    run = fresh_db.get(Run, run_id)
    rd = fresh_db.get(RunDomain, rd_id)
    assert run.scoring_override_json
    parsed_override = json.loads(run.scoring_override_json)
    assert parsed_override["weights"] == new_weights

    # Final score rewritten; prose preserved untouched.
    parsed = json.loads(rd.final_assessment_json)
    assert parsed["final"] != 57.0
    assert 75 <= parsed["final"] <= 82
    assert parsed["summary"] == "PROSE STAYS THE SAME"
    assert parsed["recommendation"] == "RECO STAYS THE SAME"
    assert parsed["provider"] == "gemini"


def test_reset_clears_override_and_recomputes_with_global(fresh_db):
    """Reset path: weights=None. Clears Run.scoring_override_json and
    rewrites finals using current global Settings weights."""
    from app.app_settings import get_scoring_config
    from app.models import Run, RunDomain
    from app.tasks import recompute_run_finals

    sub_verdicts = {
        "backlinks":  _verdict("high_quality", 0.9),
        "refdomains": _verdict("high_quality", 0.9),
        "anchors":    _verdict("low_quality", 0.5),
        "keywords":   _verdict("low_quality", 0.5),
    }
    original = {
        "final": 57.0, "confidence": 0.7,
        "summary": "stays",
        "provider": "gemini", "model": "test",
    }
    run_id, rd_id = _build_rd(
        fresh_db, sub_verdicts=sub_verdicts, final_parsed=original,
    )

    # First: apply a custom override so we have something to clear.
    custom = {
        "backlinks": 0.9, "refdomains": 0.025,
        "anchors": 0.025, "keywords": 0.05,
        "wayback": 0.0, "wayback_classify": 0.0,
    }
    recompute_run_finals(run_id, custom, preview=False)

    fresh_db.expire_all()
    rd = fresh_db.get(RunDomain, rd_id)
    custom_score = json.loads(rd.final_assessment_json)["final"]

    # Now reset.
    result = recompute_run_finals(run_id, None, preview=False)
    assert result["preview"] is False
    assert result["override_active"] is False
    # weights_applied should equal current global Settings weights.
    expected = dict(get_scoring_config()["weights"])
    assert result["weights_applied"] == expected

    fresh_db.expire_all()
    run = fresh_db.get(Run, run_id)
    rd = fresh_db.get(RunDomain, rd_id)
    assert run.scoring_override_json == ""
    new_score = json.loads(rd.final_assessment_json)["final"]
    # With default weights (B=0.4 D=0.2 A=0.3 K=0.1) result should differ
    # from the custom-weighted score we set above.
    assert new_score != custom_score


def test_partial_rds_are_skipped(fresh_db):
    """Partial rds (final_assessment_json == {"partial": true, ...})
    should remain untouched and appear with partial=True in the result."""
    from app.models import RunDomain
    from app.tasks import recompute_run_finals

    # Only 2 of 4 criteria succeeded — final is a partial stub.
    sub_verdicts = {
        "backlinks": _verdict("high_quality", 0.9),
        "anchors":   _verdict("low_quality", 0.5),
    }
    partial_stub = {
        "partial": True,
        "succeeded": ["backlinks", "anchors"],
        "failed": ["refdomains", "keywords"],
        "summary": "", "recommendation": "",
        "provider": "gemini", "model": "",
    }
    run_id, rd_id = _build_rd(
        fresh_db, sub_verdicts=sub_verdicts, final_parsed=partial_stub,
    )

    new_weights = {
        "backlinks": 0.5, "refdomains": 0.0, "anchors": 0.5,
        "keywords": 0.0, "wayback": 0.0, "wayback_classify": 0.0,
    }
    result = recompute_run_finals(run_id, new_weights, preview=False)
    assert len(result["rows"]) == 1
    row = result["rows"][0]
    assert row["partial"] is True
    assert row["score_new"] is None

    fresh_db.expire_all()
    rd = fresh_db.get(RunDomain, rd_id)
    parsed = json.loads(rd.final_assessment_json)
    # Partial stub untouched — no `final` key got injected.
    assert parsed.get("partial") is True
    assert "final" not in parsed


def test_excluding_a_criterion_via_weight_zero_renormalizes(fresh_db):
    """Setting one criterion's weight to 0 should produce the same
    result as omitting it entirely — `compute_final` renormalizes."""
    from app.tasks import recompute_run_finals

    sub_verdicts = {
        "backlinks": _verdict("high_quality"),  # 85
        "keywords":  _verdict("low_quality"),   # 15
    }
    original = {"final": 0.0, "summary": "x", "recommendation": "y"}
    run_id, _ = _build_rd(
        fresh_db, sub_verdicts=sub_verdicts, final_parsed=original,
    )

    # Weights: B=1, K=0 → compute_final renormalizes to {B: 1.0}, score = 85.
    result = recompute_run_finals(
        run_id,
        {"backlinks": 1.0, "refdomains": 0.0, "anchors": 0.0,
         "keywords": 0.0, "wayback": 0.0, "wayback_classify": 0.0},
        preview=True,
    )
    assert result["rows"][0]["score_new"] == 85.0


def test_get_run_scoring_override_roundtrip(fresh_db):
    """`get_run_scoring_override` returns the parsed weights dict when
    the override is set, None when cleared."""
    from app.tasks import get_run_scoring_override, recompute_run_finals

    run_id, _ = _build_rd(
        fresh_db,
        sub_verdicts={"backlinks": _verdict("high_quality")},
        final_parsed={"final": 85, "summary": ""},
    )
    assert get_run_scoring_override(run_id) is None

    weights = {
        "backlinks": 0.5, "refdomains": 0.5,
        "anchors": 0.0, "keywords": 0.0,
        "wayback": 0.0, "wayback_classify": 0.0,
    }
    recompute_run_finals(run_id, weights, preview=False)
    got = get_run_scoring_override(run_id)
    assert got is not None
    assert got["weights"]["backlinks"] == 0.5
    assert got["weights"]["refdomains"] == 0.5

    recompute_run_finals(run_id, None, preview=False)
    assert get_run_scoring_override(run_id) is None
