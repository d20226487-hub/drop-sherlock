"""Coverage for the v2 three-phase ordering inside `_run_ai_for_domain`
(landed 2026-05-13 after the cached-wayback-verdict bug was identified
in run 82 of job 44).

The v1 design wove the classify post-step into the bottom of the wayback
iteration of a single for-loop. Any `continue` above that point — most
commonly when the wayback AI verdict was served from the cross-job cache
— silently skipped classify, and the B/A/K judges then ran without
classify_context. The fallback block after the loop fired classify, but
too late to be useful.

The v2 design (Phase 1 wayback → Phase 2 classify → Phase 3 B/D/A/K)
removes the flag, removes the inline call site, and removes the fallback.
Each phase is a separate top-level call; a cache short-circuit inside
one phase can never skip the next phase. These tests pin that property.
"""
from __future__ import annotations

import asyncio
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


def _build_run(fresh_db, *, with_wayback=True, with_classify=True):
    """Create a Job + Run + RunDomain + CR rows for backlinks, keywords,
    and (optionally) wayback + wayback_classify. Returns (rd_id, spec)."""
    from datetime import datetime
    from app.cache import compute_params_hash
    from app.models import CriterionResult, Job, Run, RunDomain
    from app.schemas import AnalyzeSpec

    spec_dict = {
        "criteria": {
            "backlinks":  {"enabled": True, "limit": 50, "mode": "live"},
            "refdomains": {"enabled": False},
            "anchors":    {"enabled": False},
            "keywords":   {"enabled": True, "limit": 50, "country": "us"},
            "wayback":    {
                "enabled": with_wayback, "limit": 100,
                "sample_pages": False,
            },
            "wayback_classify": {
                "enabled": with_classify, "language_mode": "ai",
            },
        },
        "ai": {"provider": "gemini", "model": "test-model"},
    }
    spec = AnalyzeSpec.model_validate(spec_dict)
    job = Job(name="t", spec_json=json.dumps(spec_dict))
    fresh_db.add(job); fresh_db.flush()
    run = Run(
        job_id=job.id, status="running", spec_json=json.dumps(spec_dict),
    )
    fresh_db.add(run); fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="example.com", status="running")
    fresh_db.add(rd); fresh_db.flush()
    # CR rows mimicking a successful fetch step — all in `done` state,
    # which is what `_finish_criterion_row` produces post-fetch.
    for crit, cfg_obj in (
        ("backlinks", spec.criteria.backlinks),
        ("keywords",  spec.criteria.keywords),
    ):
        fresh_db.add(CriterionResult(
            run_domain_id=rd.id, criterion=crit, status="done",
            params_hash=compute_params_hash(crit, cfg_obj),
            fetched_at=datetime.utcnow(),
        ))
    if with_wayback:
        fresh_db.add(CriterionResult(
            run_domain_id=rd.id, criterion="wayback", status="done",
            params_hash=compute_params_hash(
                "wayback", spec.criteria.wayback
            ),
            fetched_at=datetime.utcnow(),
        ))
    if with_classify:
        fresh_db.add(CriterionResult(
            run_domain_id=rd.id, criterion="wayback_classify",
            status="pending",
            params_hash=compute_params_hash(
                "wayback_classify", spec.criteria.wayback_classify,
            ),
        ))
    fresh_db.commit()
    return rd.id, run.id, spec


def _wire_mocks(monkeypatch, *, wayback_cache_hit: bool, calls: list):
    """Install judge / classify mocks that record their call order into
    `calls` (so tests can assert ordering)."""
    from app import tasks as t

    # judge() is the per-criterion AI call. We record (criterion, has_ctx).
    # The criterion is parsed from the user_message which starts with
    # `Criterion: <name>` — deterministic, doesn't depend on prompt content.
    async def fake_judge(*, provider, system_prompt, user_message, model_override):
        crit = "unknown"
        for line in (user_message or "").splitlines():
            if line.startswith("Criterion: "):
                crit = line[len("Criterion: "):].strip()
                break
        has_ctx = "Site context (Wayback classify" in (user_message or "")
        calls.append(("judge", crit, has_ctx))
        return ({"recommendation": "ok", "confidence": 0.5}, "{}",
                {"input_tokens": 1, "output_tokens": 1})

    monkeypatch.setattr(t, "judge", fake_judge)
    monkeypatch.setattr(
        t, "_resolve_model", lambda provider, model_override: "test-model",
    )

    async def fake_classify(**kwargs):
        calls.append(("classify_run", None, None))
        # Populate sub_verdicts so Phase 3's _load_classify_context can
        # project fields.
        kwargs["sub_verdicts"]["wayback_classify"] = {
            "primary_theme": "pet care",
            "category": "e-commerce",
            "primary_language": "en",
        }

    monkeypatch.setattr(
        t, "_run_wayback_classify_for_domain", fake_classify,
    )

    # The wayback cache-hit path is what triggered the original bug. We
    # simulate it by stubbing the cache lookup to return a verdict for
    # wayback only.
    def fake_cache_lookup(*, cr_id, domain, criterion, params_hash,
                         prompt_hash, job_id, run_id):
        if criterion == "wayback" and wayback_cache_hit:
            calls.append(("wayback_cache_served", None, None))
            return {"recommendation": "ok", "confidence": 0.4}
        return None

    monkeypatch.setattr(
        t, "_try_serve_verdict_from_cache", fake_cache_lookup,
    )


def _run(spec, rd_id, run_id, fetched_rows):
    """Drive `_run_ai_for_domain` synchronously from tests."""
    from app.tasks import _run_ai_for_domain
    asyncio.run(_run_ai_for_domain(
        run_domain_id=rd_id, domain="example.com", spec=spec,
        fetched_rows=fetched_rows, run_id=run_id,
    ))


def test_classify_fires_before_bak_when_wayback_cache_hit(fresh_db, monkeypatch):
    """The regression test for the bug observed in run 82: when the
    wayback AI verdict is cache-served, classify must still fire before
    the B/A/K judges, and those judges must see classify_context in
    their user message."""
    rd_id, run_id, spec = _build_run(fresh_db)
    calls: list = []
    _wire_mocks(monkeypatch, wayback_cache_hit=True, calls=calls)

    _run(spec, rd_id, run_id, fetched_rows={
        "wayback":   [{"url": "x"}],
        "backlinks": [{"url_to": "a"}],
        "keywords":  [{"keyword": "k"}],
    })

    # Filter to the events that establish ordering.
    kinds = [c[0] for c in calls]
    assert "wayback_cache_served" in kinds, calls
    assert "classify_run" in kinds, calls
    # Phase 2 (classify) runs after Phase 1 (wayback served from cache)
    # and before Phase 3 (B/A/K judges).
    assert kinds.index("wayback_cache_served") < kinds.index("classify_run")

    # The final-assessment judge call also lands in `calls` (criterion
    # "unknown" because it uses a different user_message shape). Filter
    # to per-criterion judges only — those are what this test pins.
    judge_events = [c for c in calls if c[0] == "judge"
                    and c[1] in ("backlinks", "refdomains", "anchors",
                                 "keywords", "wayback")]
    judge_criteria = [c[1] for c in judge_events]
    # Wayback was cache-served, so it shouldn't appear in judge() events.
    assert "wayback" not in judge_criteria, judge_events
    # B/A/K iterations did fire judge().
    assert "backlinks" in judge_criteria
    assert "keywords" in judge_criteria
    # All B/A/K judge calls received classify_context (has_ctx=True).
    for kind, crit, has_ctx in judge_events:
        assert has_ctx is True, (
            f"{crit} judged WITHOUT classify_context — Phase 2 didn't "
            f"populate sub_verdicts before Phase 3 ran. calls={calls}"
        )


def test_classify_fires_before_bak_when_wayback_judges_fresh(fresh_db, monkeypatch):
    """Mirror test for the no-cache path: wayback judges fresh, then
    classify, then B/A/K with context. Ensures the refactor didn't
    regress the previously-working ordering."""
    rd_id, run_id, spec = _build_run(fresh_db)
    calls: list = []
    _wire_mocks(monkeypatch, wayback_cache_hit=False, calls=calls)

    _run(spec, rd_id, run_id, fetched_rows={
        "wayback":   [{"url": "x"}],
        "backlinks": [{"url_to": "a"}],
        "keywords":  [{"keyword": "k"}],
    })

    kinds = [c[0] for c in calls]
    # Phase 1 wayback judge → Phase 2 classify → Phase 3 B/A/K judges.
    idx_wb = next(i for i, c in enumerate(calls)
                  if c[0] == "judge" and c[1] == "wayback")
    idx_cl = kinds.index("classify_run")
    idx_bl = next(i for i, c in enumerate(calls)
                  if c[0] == "judge" and c[1] == "backlinks")
    assert idx_wb < idx_cl < idx_bl

    # B/A/K saw context (the final-assessment judge is filtered out by
    # the criterion whitelist).
    judge_events = [c for c in calls if c[0] == "judge"
                    and c[1] in ("backlinks", "keywords")]
    assert judge_events, calls
    for kind, crit, has_ctx in judge_events:
        assert has_ctx is True, calls


def test_classify_fires_when_wayback_not_fetched(fresh_db, monkeypatch):
    """Wayback disabled in spec, classify still enabled: Phase 1 skips,
    Phase 2 still fires classify (preserving the v1 fallback behavior
    that reports the "no samples" failure rather than silently skipping
    classify). B/A/K then judge with whatever classify produced."""
    rd_id, run_id, spec = _build_run(fresh_db, with_wayback=False)
    calls: list = []
    _wire_mocks(monkeypatch, wayback_cache_hit=False, calls=calls)

    _run(spec, rd_id, run_id, fetched_rows={
        "backlinks": [{"url_to": "a"}],
        "keywords":  [{"keyword": "k"}],
    })

    kinds = [c[0] for c in calls]
    assert "classify_run" in kinds, calls
    # No wayback judge call recorded.
    assert not any(c[0] == "judge" and c[1] == "wayback" for c in calls)
    # Classify ran before the first B/A/K judge (ignore final assessment).
    first_bak_idx = next(
        i for i, c in enumerate(calls)
        if c[0] == "judge" and c[1] in (
            "backlinks", "refdomains", "anchors", "keywords",
        )
    )
    assert kinds.index("classify_run") < first_bak_idx


def test_classify_skipped_when_disabled_in_spec(fresh_db, monkeypatch):
    """Classify disabled: Phase 2 is a no-op. B/A/K judges fire without
    classify_context. No regression vs. v1 behavior."""
    rd_id, run_id, spec = _build_run(fresh_db, with_classify=False)
    calls: list = []
    _wire_mocks(monkeypatch, wayback_cache_hit=False, calls=calls)

    _run(spec, rd_id, run_id, fetched_rows={
        "wayback":   [{"url": "x"}],
        "backlinks": [{"url_to": "a"}],
        "keywords":  [{"keyword": "k"}],
    })

    assert not any(c[0] == "classify_run" for c in calls), calls
    # B/A/K judged without classify_context (has_ctx=False). Final-
    # assessment judge ("unknown" criterion) is filtered out — its
    # user_message has a different shape and never gets the context block.
    bak_events = [c for c in calls if c[0] == "judge"
                  and c[1] in ("backlinks", "keywords")]
    assert bak_events, calls
    for kind, crit, has_ctx in bak_events:
        assert has_ctx is False, calls
