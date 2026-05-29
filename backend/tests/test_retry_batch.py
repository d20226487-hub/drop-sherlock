"""Coverage for the scoped `retry_run_batch_now` helper (added
2026-05-12). Validates that the user's "retry only wayback on the
failed domains, leave classify alone" workflow actually gets through
to the dispatch step with the right criterion filter applied.

Test strategy: build a run + RDs + CRs by hand, monkeypatch the task
spawn so we can assert what would have been dispatched instead of
actually running async coroutines.
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


def _seed(session):
    """Build a 'done' run with two domains: dom-a has wayback failed +
    classify done; dom-b has both criteria done. Spec enables wayback
    + wayback_classify. Mirrors the user's reported run #79 shape."""
    from app.models import CriterionResult, Job, Run, RunDomain
    job = Job(name="t", spec_json="{}")
    session.add(job)
    session.flush()
    # B/D/A/K default to enabled=True in CriterionBase, so we must
    # explicitly disable them to model the user's wayback-only run.
    spec = {
        "criteria": {
            "backlinks": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "refdomains": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "anchors": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "keywords": {"enabled": False, "limit": 20, "sort": []},
            "wayback": {"enabled": True, "limit": 100, "filters": {}, "sort": []},
            "wayback_classify": {"enabled": True, "language_mode": "ai"},
        },
        "ai": {"provider": "gemini", "model": "test-model"},
    }
    run = Run(
        job_id=job.id,
        status="done",
        spec_json=json.dumps(spec),
        finished_at=datetime.utcnow(),
    )
    session.add(run)
    session.flush()
    rd_a = RunDomain(run_id=run.id, domain="a.com", status="failed")
    rd_b = RunDomain(run_id=run.id, domain="b.com", status="done")
    session.add_all([rd_a, rd_b])
    session.flush()
    session.add_all([
        # dom-a: wayback fetch failed → no data; classify also "done"
        # but with no real data (since it depends on wayback samples).
        # Either way wayback is the criterion that needs retrying.
        CriterionResult(
            run_domain_id=rd_a.id, criterion="wayback", status="failed",
            error="cdx 500",
        ),
        CriterionResult(
            run_domain_id=rd_a.id, criterion="wayback_classify",
            status="done", ai_verdict_json='{"primary_language":"en"}',
        ),
        # dom-b: both done.
        CriterionResult(
            run_domain_id=rd_b.id, criterion="wayback", status="done",
            data_json='{"samples":[]}',
            ai_verdict_json='{"assessment":"good","confidence":0.9}',
        ),
        CriterionResult(
            run_domain_id=rd_b.id, criterion="wayback_classify",
            status="done", ai_verdict_json='{"primary_language":"en"}',
        ),
    ])
    session.commit()
    return job, run, rd_a, rd_b


def _patch_dispatch(monkeypatch):
    """Replace the async coroutine spawn so we can inspect what would
    have been retried without actually running the retry worker."""
    spawned: list[tuple[int, list[str]]] = []
    import asyncio
    from app import tasks

    class FakeTask:
        def add_done_callback(self, *a, **k):
            pass

    def fake_create_task(coro):
        # The coroutine carries (rd_id, criteria, spec, track_set)
        # — peek at its frame locals to record what was requested.
        frame = coro.cr_frame
        if frame is not None:
            spawned.append(
                (frame.f_locals.get("run_domain_id"),
                 list(frame.f_locals.get("criteria", []) or [])),
            )
        coro.close()  # don't actually run
        return FakeTask()

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)
    # The runner also calls _track + _REANALYZING_RUN_DOMAINS.add_task.
    # No-op them for the test.
    monkeypatch.setattr(tasks, "_track", lambda t: None)

    class FakeMap:
        def is_active(self, _): return False
        def add_task(self, *a, **k): pass

    monkeypatch.setattr(tasks, "_REANALYZING_RUN_DOMAINS", FakeMap())
    monkeypatch.setattr(tasks, "_REANALYZING_RUNS", FakeMap())
    return spawned


def test_retry_batch_only_wayback_on_failed_rd(fresh_db, monkeypatch):
    """User picks only wayback in the criterion picker. The 2026-05-13
    auto-cascade forces wayback_classify in alongside it (since classify
    is enabled in the spec and reads V2 samples off the wayback CR) — so
    the dispatched list is [wayback, wayback_classify] even though the
    user only checked one box."""
    from app.tasks import retry_run_batch_now
    job, run, rd_a, rd_b = _seed(fresh_db)
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=["wayback"],
    )
    assert result["status"] == "started"
    assert result["domains"] == 1  # only rd_a has a wayback failure
    assert result["criteria"] == 2  # wayback + auto-cascaded classify
    assert spawned == [(rd_a.id, ["wayback", "wayback_classify"])]


def test_retry_batch_respects_rd_scope(fresh_db, monkeypatch):
    """Passing only rd_b (which has nothing failed) yields no dispatch
    even with no criterion filter — the rd-id scope alone trims
    everything out."""
    from app.tasks import retry_run_batch_now
    job, run, rd_a, rd_b = _seed(fresh_db)
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_b.id],
        criteria=None,
    )
    assert "error" in result
    assert "no failed criteria" in result["error"]
    assert spawned == []


def test_retry_batch_unscoped_criteria_retries_everything_failed(
    fresh_db, monkeypatch,
):
    """criteria=None means 'every enabled criterion that needs retry'
    — same as the legacy retry-failed but scoped to the picked rds."""
    from app.tasks import retry_run_batch_now
    job, run, rd_a, rd_b = _seed(fresh_db)
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=None,
    )
    # rd_a has wayback failed; classify is in 'done' state so it's NOT
    # picked up by _collect_failed_criteria — BUT the 2026-05-13
    # auto-cascade adds it back because wayback is being retried and
    # classify's input (V2 samples) is about to change. rd_b is fully
    # done — nothing failed there.
    assert result["status"] == "started"
    assert result["domains"] == 1
    assert spawned == [(rd_a.id, ["wayback", "wayback_classify"])]


def test_retry_batch_cascade_skipped_when_classify_disabled(
    fresh_db, monkeypatch,
):
    """If wayback_classify is disabled in the spec, the auto-cascade
    MUST NOT add it — there's no classify CR to refresh and dispatching
    it would create a spurious row."""
    from app.tasks import retry_run_batch_now
    from app.models import Run
    job, run, rd_a, rd_b = _seed(fresh_db)
    # Flip classify off in the spec.
    spec = json.loads(run.spec_json)
    spec["criteria"]["wayback_classify"]["enabled"] = False
    run.spec_json = json.dumps(spec)
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=["wayback"],
    )
    assert result["status"] == "started"
    assert result["criteria"] == 1
    assert spawned == [(rd_a.id, ["wayback"])]


def test_retry_batch_cascade_idempotent_when_classify_already_failed(
    fresh_db, monkeypatch,
):
    """When classify also failed independently, _collect_failed_criteria
    already returns it — the cascade must not double-add."""
    from app.tasks import retry_run_batch_now
    from app.models import CriterionResult
    job, run, rd_a, rd_b = _seed(fresh_db)
    # Flip rd_a's classify CR from done → failed (independent failure).
    classify_cr = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_a.id,
            CriterionResult.criterion == "wayback_classify",
        )
        .one()
    )
    classify_cr.status = "failed"
    classify_cr.ai_verdict_json = ""
    classify_cr.ai_verdict_error = "needs Wayback V2 page samples"
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=None,
    )
    assert result["status"] == "started"
    # Exactly one entry per criterion — cascade did not duplicate.
    assert spawned == [(rd_a.id, ["wayback", "wayback_classify"])]


def test_retry_batch_classify_only_does_not_trigger_cascade(
    fresh_db, monkeypatch,
):
    """User picks ONLY wayback_classify (no wayback). The cascade should
    not fire — there's no wayback retry to invalidate classify's input,
    so re-judging classify on its existing samples is what the user
    asked for."""
    from app.tasks import retry_run_batch_now
    from app.models import CriterionResult
    job, run, rd_a, rd_b = _seed(fresh_db)
    classify_cr = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_a.id,
            CriterionResult.criterion == "wayback_classify",
        )
        .one()
    )
    classify_cr.status = "failed"
    classify_cr.ai_verdict_json = ""
    classify_cr.ai_verdict_error = "judge timed out"
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id],
        criteria=["wayback_classify"],
    )
    assert result["status"] == "started"
    # Only classify — wayback wasn't picked, so no cascade.
    assert spawned == [(rd_a.id, ["wayback_classify"])]


def test_resample_only_targets_done_wayback_with_rows_missing_samples(
    fresh_db, monkeypatch,
):
    """Run 79 reproducer — wayback CR is status=done with V1 rows but no
    V2 samples; classify failed with "no samples" error. The normal
    retry path skips wayback (it's not "failed"). Resample-only mode
    must select wayback for these rows AND cascade classify in."""
    from app.tasks import retry_run_batch_now
    from app.models import CriterionResult
    job, run, rd_a, rd_b = _seed(fresh_db)

    # Seed spec doesn't set sample_pages (defaults False). Real run-79
    # specs have it True (otherwise V2 would never run originally).
    spec = json.loads(run.spec_json)
    spec["criteria"]["wayback"]["sample_pages"] = True
    run.spec_json = json.dumps(spec)

    # Reshape rd_b to match the run-79 "V1 done, V2 missing" pattern.
    # rd_b's wayback CR already exists from _seed — promote it to the
    # target state (rows present, no samples). Also flip classify into
    # the matching "no samples" failed state.
    wb_b = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_b.id,
            CriterionResult.criterion == "wayback",
        )
        .one()
    )
    wb_b.status = "done"
    wb_b.data_json = json.dumps({
        "wayback": [
            {"timestamp": "20200101000000", "original": "https://b.com/",
             "statuscode": "200"},
            {"timestamp": "20210101000000", "original": "https://b.com/",
             "statuscode": "200"},
        ],
        "samples": [],
    })
    wb_b.ai_verdict_json = '{"assessment":"good","confidence":0.7}'
    classify_b = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_b.id,
            CriterionResult.criterion == "wayback_classify",
        )
        .one()
    )
    classify_b.status = "failed"
    classify_b.ai_verdict_json = ""
    classify_b.ai_verdict_error = "needs Wayback V2 page samples"
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=["wayback"],
        wayback_resample_only=True,
    )
    assert result["status"] == "started"
    # rd_a's wayback is `status=failed` with no data_json → no V1 rows →
    # _collect_resample_candidates returns []. Only rd_b qualifies.
    assert result["domains"] == 1
    # rd_b → wayback (selected) + wayback_classify (cascaded).
    assert spawned == [(rd_b.id, ["wayback", "wayback_classify"])]


def test_resample_only_skips_when_v1_rows_empty(fresh_db, monkeypatch):
    """A wayback CR with 0 V1 rows can't be resampled — V2 needs
    timestamp/url tuples from CDX. _collect_resample_candidates must
    return [] so we don't dispatch a pointless re-judge."""
    from app.tasks import retry_run_batch_now
    from app.models import CriterionResult
    job, run, rd_a, rd_b = _seed(fresh_db)
    spec = json.loads(run.spec_json)
    spec["criteria"]["wayback"]["sample_pages"] = True
    run.spec_json = json.dumps(spec)

    wb_b = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_b.id,
            CriterionResult.criterion == "wayback",
        )
        .one()
    )
    wb_b.status = "done"
    wb_b.data_json = json.dumps({"wayback": [], "samples": []})
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=["wayback"],
        wayback_resample_only=True,
    )
    assert "error" in result
    assert spawned == []


def test_resample_only_requires_wayback_in_criteria(fresh_db, monkeypatch):
    """If the user excluded wayback from the criteria allow-list, the
    flag has no target — error out so the request isn't silently a
    no-op."""
    from app.tasks import retry_run_batch_now
    job, run, rd_a, rd_b = _seed(fresh_db)
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_a.id, rd_b.id],
        criteria=["wayback_classify"],
        wayback_resample_only=True,
    )
    assert "error" in result
    assert "wayback" in result["error"].lower()
    assert spawned == []


def test_resample_only_skips_when_sample_pages_disabled(
    fresh_db, monkeypatch,
):
    """Spec has sample_pages=False → resample would be a no-op. Don't
    dispatch."""
    from app.tasks import retry_run_batch_now
    from app.models import CriterionResult
    job, run, rd_a, rd_b = _seed(fresh_db)
    spec = json.loads(run.spec_json)
    spec["criteria"]["wayback"]["sample_pages"] = False
    run.spec_json = json.dumps(spec)
    wb_b = (
        fresh_db.query(CriterionResult)
        .filter(
            CriterionResult.run_domain_id == rd_b.id,
            CriterionResult.criterion == "wayback",
        )
        .one()
    )
    wb_b.status = "done"
    wb_b.data_json = json.dumps({
        "wayback": [{"timestamp": "20200101000000",
                     "original": "https://b.com/"}],
        "samples": [],
    })
    fresh_db.commit()
    spawned = _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id,
        run_domain_ids=[rd_b.id],
        criteria=["wayback"],
        wayback_resample_only=True,
    )
    assert "error" in result
    assert spawned == []


def test_retry_batch_refuses_non_terminal_run(fresh_db, monkeypatch):
    from app.tasks import retry_run_batch_now
    from app.models import Run
    job, run, rd_a, rd_b = _seed(fresh_db)
    run.status = "running"
    fresh_db.commit()
    _patch_dispatch(monkeypatch)

    result = retry_run_batch_now(
        run_id=run.id, run_domain_ids=[rd_a.id], criteria=["wayback"],
    )
    assert "error" in result
    assert "wait" in result["error"]


def _seed_availability_run(session):
    """Seed an Availability-kind Job + Run with three RDs:
      - rd_ok: cascade succeeded (cr.status='done', verdict='registered') — NOT a retry candidate
      - rd_err: cascade completed but every provider errored (cr.status='done',
                verdict='error') — IS a retry candidate per the 2026-05-16 split
      - rd_orphan: cascade died mid-flight (cr.status='running') — IS a candidate"""
    from app.models import CriterionResult, Job, Run, RunDomain
    job = Job(
        name="avail-retry", kind="availability",
        spec_json=json.dumps({
            "criteria": {
                "backlinks": {"enabled": False},
                "refdomains": {"enabled": False},
                "anchors": {"enabled": False},
                "keywords": {"enabled": False},
                "wayback": {"enabled": False},
                "wayback_classify": {"enabled": False},
                "whois_history": {"enabled": False},
                "availability": {"enabled": True},
            },
            # No AI on availability — provider is None. This is the exact
            # shape /analyze/availability writes.
            "ai": {"provider": None, "model": None},
            "use_cache": False,
        }),
    )
    session.add(job)
    session.flush()
    run = Run(
        job_id=job.id, status="done", spec_json=job.spec_json,
        finished_at=datetime.utcnow(),
    )
    session.add(run)
    session.flush()
    rd_ok = RunDomain(run_id=run.id, domain="ok.example", status="done",
                      finished_at=datetime.utcnow())
    rd_err = RunDomain(run_id=run.id, domain="err.example", status="done",
                       finished_at=datetime.utcnow())
    rd_orphan = RunDomain(run_id=run.id, domain="orphan.example",
                          status="running")
    session.add_all([rd_ok, rd_err, rd_orphan])
    session.flush()
    session.add_all([
        CriterionResult(
            run_domain_id=rd_ok.id, criterion="availability", status="done",
            data_json=json.dumps({
                "verdict": {"status": "registered", "provider": "rdap",
                            "registrar": "Foo Inc.", "expires_on": "2028-01-01"},
                "trace": [],
            }),
        ),
        CriterionResult(
            run_domain_id=rd_err.id, criterion="availability", status="done",
            data_json=json.dumps({
                "verdict": {"status": "error", "provider": "", "registrar": "",
                            "expires_on": None},
                "trace": [{"provider": "rdap", "status": "error",
                           "error_message": "429"}],
            }),
        ),
        CriterionResult(
            run_domain_id=rd_orphan.id, criterion="availability",
            status="running", data_json="",
        ),
    ])
    session.commit()
    return job, run, rd_ok, rd_err, rd_orphan


def test_retry_failed_on_availability_run_skips_ai_gate(
    fresh_db, monkeypatch,
):
    """Regression for 2026-05-16: retrying failed criteria on an
    Availability-kind run used to 400 with "no AI provider configured
    for this run" because the AI-provider gate fired regardless of
    pillar. Availability cascades never use AI, so the gate must be
    skipped for `Job.kind == 'availability'`.

    Also verifies the failed-criteria collector picks up BOTH the
    cr.status='done' + verdict='error' rows AND the orphaned 'running'
    rows, without retrying the cleanly-resolved 'registered' row."""
    from app.tasks import retry_failed_run_now
    session = fresh_db
    _job, run, rd_ok, rd_err, rd_orphan = _seed_availability_run(session)
    spawned = _patch_dispatch(monkeypatch)

    result = retry_failed_run_now(run.id)

    # No AI-gate error. Two RDs retried (the cleanly-resolved one is
    # skipped). Both pulled in `availability` as the failed criterion.
    assert "error" not in result, result
    assert result["status"] == "started"
    assert result["domains"] == 2
    retried_rd_ids = {rd_id for (rd_id, _) in spawned}
    assert retried_rd_ids == {rd_err.id, rd_orphan.id}
    for _rd_id, crits in spawned:
        assert crits == ["availability"]


# --- Wayback auto-retry watcher candidate logic (added 2026-05-29) --------


def _seed_wayback_watcher_run(session):
    """Build a Quality-kind run with four distinct RDs that exercise each
    branch of `_collect_wayback_retry_candidates`:

      rd_resample: wayback CR done with 200 V1 rows but ZERO V2 samples
                   (Wayback's /web/<ts>/<url> sample endpoint silently
                   failed during the original fetch — the run 128
                   reproducer). classify CR failed.
                   Expected: (["wayback", "wayback_classify"], True)
      rd_stale:    wayback CR done with V1 rows AND 10 V2 samples;
                   classify CR failed (stale verdict from before V2
                   samples landed — the run 128 #18099 / #18200 / #18220
                   cohort that needed manual classify re-judge).
                   Expected: (["wayback_classify"], False)
      rd_empty:    wayback CR done with 0 V1 rows (domain has no
                   archive history); classify failed because there's
                   nothing to judge.
                   Expected: skipped entirely (re-judge can't fix it)
      rd_wb_failed: wayback CR status='failed' (CDX fetch errored).
                   Expected: (["wayback", "wayback_classify"], False)
                   — regular retry, cascade pulls classify in
    """
    from app.models import CriterionResult, Job, Run, RunDomain
    job = Job(name="t-watcher", spec_json="{}", kind="quality")
    session.add(job)
    session.flush()
    # Quality spec with wayback + sample_pages on (the resample-only
    # branch requires sample_pages=True) and wayback_classify enabled.
    # B/D/A/K disabled to match the Wincraft "Wayback" run shape that
    # bit us on runs 124/126/128.
    spec = {
        "criteria": {
            "backlinks": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "refdomains": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "anchors": {"enabled": False, "limit": 20, "filters": {}, "sort": []},
            "keywords": {"enabled": False, "limit": 20, "sort": []},
            "wayback": {
                "enabled": True, "limit": 200,
                "sample_pages": True, "sample_count": 10,
                "filters": {}, "sort": [],
            },
            "wayback_classify": {"enabled": True, "language_mode": "library"},
        },
        "ai": {"provider": "gemini", "model": "test-model"},
    }
    run = Run(
        job_id=job.id, status="done",
        spec_json=json.dumps(spec),
        finished_at=datetime.utcnow(),
    )
    session.add(run)
    session.flush()
    rd_resample = RunDomain(run_id=run.id, domain="resample.com", status="failed")
    rd_stale = RunDomain(run_id=run.id, domain="stale.com", status="failed")
    rd_empty = RunDomain(run_id=run.id, domain="empty.com", status="failed")
    rd_wb_failed = RunDomain(run_id=run.id, domain="wb-failed.com", status="failed")
    session.add_all([rd_resample, rd_stale, rd_empty, rd_wb_failed])
    session.flush()
    # rd_resample: wayback done with V1 rows but NO V2 samples.
    session.add_all([
        CriterionResult(
            run_domain_id=rd_resample.id, criterion="wayback",
            status="done",
            data_json=json.dumps({
                "wayback": [{"timestamp": f"2020010100000{i}", "original": "x"}
                            for i in range(5)],
                "samples": [],  # ← the silent-V2-fail signature
            }),
        ),
        CriterionResult(
            run_domain_id=rd_resample.id, criterion="wayback_classify",
            status="failed",
            ai_verdict_error="wayback_classify needs Wayback V2 page samples — none on the wayback CR row.",
        ),
    ])
    # rd_stale: wayback done with V1 AND V2; classify still failed.
    session.add_all([
        CriterionResult(
            run_domain_id=rd_stale.id, criterion="wayback",
            status="done",
            data_json=json.dumps({
                "wayback": [{"timestamp": f"2020010100000{i}", "original": "x"}
                            for i in range(5)],
                "samples": [{"timestamp": "20200101000000", "body": "..."}
                            for _ in range(10)],
            }),
        ),
        CriterionResult(
            run_domain_id=rd_stale.id, criterion="wayback_classify",
            status="failed",
            ai_verdict_error="stale verdict from before V2 samples landed",
        ),
    ])
    # rd_empty: wayback done but 0 V1 rows.
    session.add_all([
        CriterionResult(
            run_domain_id=rd_empty.id, criterion="wayback",
            status="done",
            data_json=json.dumps({"wayback": [], "samples": []}),
        ),
        CriterionResult(
            run_domain_id=rd_empty.id, criterion="wayback_classify",
            status="failed",
            ai_verdict_error="no Wayback rows to sample",
        ),
    ])
    # rd_wb_failed: wayback CDX fetch errored.
    session.add_all([
        CriterionResult(
            run_domain_id=rd_wb_failed.id, criterion="wayback",
            status="failed", error="cdx 500",
        ),
        # No classify CR — fetch never ran.
    ])
    session.commit()
    return run, rd_resample, rd_stale, rd_empty, rd_wb_failed


def test_watcher_collects_resample_only_when_v2_missing(fresh_db):
    """Locks in the 2026-05-29 fix: when classify failed because V2
    samples are empty (Wayback throttled /web/<ts>/<url> mid-fetch),
    the watcher returns `resample_only=True` and includes both wayback
    + wayback_classify in the criteria list. Without this fix the
    watcher would just re-judge classify, which can't possibly succeed
    without samples — burning AI tokens and never recovering."""
    from app.tasks import _collect_wayback_retry_candidates
    from app.schemas import AnalyzeSpec
    run, rd_resample, rd_stale, rd_empty, rd_wb_failed = (
        _seed_wayback_watcher_run(fresh_db)
    )
    spec = AnalyzeSpec.model_validate(json.loads(run.spec_json))
    out = _collect_wayback_retry_candidates(run.id, spec)

    # rd_empty is intentionally skipped — re-judging can't fix "no
    # archive history".
    assert rd_empty.id not in out, (
        f"empty-archive RD should be skipped, got {out[rd_empty.id]!r}"
    )

    # rd_resample: V2 silent-fail → resample-only on both criteria.
    assert rd_resample.id in out
    criteria, resample_only = out[rd_resample.id]
    assert resample_only is True
    assert criteria == ["wayback", "wayback_classify"]

    # rd_stale: V2 samples present → plain classify re-judge.
    assert rd_stale.id in out
    criteria, resample_only = out[rd_stale.id]
    assert resample_only is False
    assert criteria == ["wayback_classify"]

    # rd_wb_failed: wayback CDX fetch failed → regular retry, cascade.
    assert rd_wb_failed.id in out
    criteria, resample_only = out[rd_wb_failed.id]
    assert resample_only is False
    assert criteria == ["wayback", "wayback_classify"]
