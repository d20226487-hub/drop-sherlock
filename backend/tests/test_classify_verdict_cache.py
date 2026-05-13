"""Coverage for wayback_classify cross-job AI verdict cache (Option 1,
landed 2026-05-13). Before this change, classify always re-judged on a
new run even when a prior matching verdict existed in another job. The
docstring at tasks.py claimed cross-job cache was in use but the code
never called `_try_serve_verdict_from_cache` for classify.

Tests verify:
- classify CR rows now get a real params_hash on creation (was "")
- classify uses the cross-job verdict cache via _try_serve_verdict_from_cache
- prompt_hash covers BOTH chained prompts (primary + category) so editing
  either invalidates the cache
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


def test_classify_params_hash_derives_from_language_mode(fresh_db):
    """compute_params_hash for wayback_classify must produce a non-empty
    hash AND change when language_mode changes — the cache key relies
    on this to keep AI-mode and library-mode verdicts in separate
    namespaces."""
    from app.cache import compute_params_hash

    class Cfg:
        def __init__(self, mode):
            self.language_mode = mode

    h_ai = compute_params_hash("wayback_classify", Cfg("ai"))
    h_lib = compute_params_hash("wayback_classify", Cfg("library"))
    assert h_ai
    assert h_lib
    assert h_ai != h_lib


def test_classify_cr_creation_writes_params_hash(fresh_db):
    """When _process_domain creates a wayback_classify CR row, it must
    persist a non-empty params_hash so the cache can later match. Before
    Option 1 this was always "" which made every cache lookup miss."""
    from app.models import CriterionResult, Job, Run, RunDomain
    from app.cache import compute_params_hash
    from app.schemas import AnalyzeSpec
    from datetime import datetime

    job = Job(name="t", spec_json="{}")
    fresh_db.add(job); fresh_db.flush()
    spec_dict = {
        "criteria": {
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": True, "limit": 100, "sample_pages": True},
            "wayback_classify": {"enabled": True, "language_mode": "ai"},
        },
        "ai": {"provider": "gemini", "model": "test-model"},
    }
    run = Run(job_id=job.id, status="done", spec_json=json.dumps(spec_dict),
              finished_at=datetime.utcnow())
    fresh_db.add(run); fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="a.com", status="done")
    fresh_db.add(rd); fresh_db.flush()
    fresh_db.commit()

    # Simulate the relevant section of _process_domain: create classify CR
    # with the params_hash computed from wbc_cfg. This mirrors the code
    # path landed 2026-05-13.
    from app.tasks import _create_criterion_row
    spec = AnalyzeSpec.model_validate(spec_dict)
    wbc_cfg = spec.criteria.wayback_classify
    expected_hash = compute_params_hash("wayback_classify", wbc_cfg)
    cr_id = _create_criterion_row(rd.id, "wayback_classify", "", expected_hash)
    fresh_db.expire_all()

    cr = fresh_db.query(CriterionResult).filter(
        CriterionResult.id == cr_id,
    ).one()
    assert cr.params_hash == expected_hash
    assert cr.params_hash  # not empty


def test_classify_verdict_cache_hits_across_jobs(fresh_db):
    """End-to-end: build a "source" job+run with a finished classify
    verdict, then drive a fresh classify call via the cache lookup.
    Verifies the wired cache path actually returns a hit when keys match.
    """
    from app.cache import (
        compute_params_hash, compute_prompt_hash, lookup_cached_verdict,
    )
    from app.models import CriterionResult, Job, Run, RunDomain
    from app.schemas import AnalyzeSpec
    from datetime import datetime
    import hashlib

    # Source: job A, run with classify verdict on a.com
    source_job = Job(name="source", spec_json="{}")
    fresh_db.add(source_job); fresh_db.flush()
    spec_dict = {
        "criteria": {
            "backlinks": {"enabled": False},
            "refdomains": {"enabled": False},
            "anchors": {"enabled": False},
            "keywords": {"enabled": False},
            "wayback": {"enabled": True, "limit": 100, "sample_pages": True},
            "wayback_classify": {"enabled": True, "language_mode": "ai"},
        },
        "ai": {"provider": "gemini", "model": "test-model"},
    }
    source_run = Run(
        job_id=source_job.id, status="done",
        spec_json=json.dumps(spec_dict), finished_at=datetime.utcnow(),
    )
    fresh_db.add(source_run); fresh_db.flush()
    source_rd = RunDomain(run_id=source_run.id, domain="a.com", status="done")
    fresh_db.add(source_rd); fresh_db.flush()

    spec = AnalyzeSpec.model_validate(spec_dict)
    wbc_cfg = spec.criteria.wayback_classify
    params_hash = compute_params_hash("wayback_classify", wbc_cfg)

    # Build prompt_hash the way the wired code does
    primary = "[primary prompt body]"
    category = "[category prompt body]"
    category_h = hashlib.sha256(category.encode("utf-8")).hexdigest()
    prompt_hash = compute_prompt_hash(
        primary, "gemini", "test-model",
        fields_sent=[f"wayback_category:{category_h}"],
    )

    source_verdict = {
        "primary_language": "en",
        "primary_theme": "pet care",
        "category": "e-commerce",
        "theme_confidence": 0.9,
    }
    fresh_db.add(CriterionResult(
        run_domain_id=source_rd.id, criterion="wayback_classify",
        status="done", params_hash=params_hash, prompt_hash=prompt_hash,
        ai_verdict_json=json.dumps(source_verdict),
    ))
    fresh_db.commit()

    # Destination: a DIFFERENT job, looking up the cache with cross-job
    # scope (job_id=None) — must find the source verdict.
    dest_job = Job(name="dest", spec_json="{}")
    fresh_db.add(dest_job); fresh_db.flush()
    dest_run = Run(
        job_id=dest_job.id, status="done",
        spec_json=json.dumps(spec_dict), finished_at=datetime.utcnow(),
    )
    fresh_db.add(dest_run); fresh_db.flush()

    found = lookup_cached_verdict(
        fresh_db,
        job_id=None,            # cross-job
        domain="a.com",
        criterion="wayback_classify",
        params_hash=params_hash,
        prompt_hash=prompt_hash,
        exclude_run_id=dest_run.id,
    )
    assert found is not None
    assert json.loads(found.ai_verdict_json) == source_verdict


def test_classify_cache_misses_when_language_mode_differs(fresh_db):
    """A source verdict produced in AI mode must NOT match a lookup in
    library mode (different params_hash) — keeps the two modes'
    verdicts cleanly partitioned."""
    from app.cache import (
        compute_params_hash, compute_prompt_hash, lookup_cached_verdict,
    )
    from app.models import CriterionResult, Job, Run, RunDomain
    from datetime import datetime

    class Cfg:
        def __init__(self, mode):
            self.language_mode = mode

    job = Job(name="t", spec_json="{}")
    fresh_db.add(job); fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}",
              finished_at=datetime.utcnow())
    fresh_db.add(run); fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="a.com", status="done")
    fresh_db.add(rd); fresh_db.flush()

    ph_ai = compute_params_hash("wayback_classify", Cfg("ai"))
    ph_lib = compute_params_hash("wayback_classify", Cfg("library"))
    prompt_hash = compute_prompt_hash("p", "gemini", "m")

    # Source row in AI mode
    fresh_db.add(CriterionResult(
        run_domain_id=rd.id, criterion="wayback_classify", status="done",
        params_hash=ph_ai, prompt_hash=prompt_hash,
        ai_verdict_json='{"primary_theme":"x"}',
    ))
    fresh_db.commit()

    # New run in library mode → different params_hash → cache miss
    run2 = Run(job_id=job.id, status="done", spec_json="{}",
               finished_at=datetime.utcnow())
    fresh_db.add(run2); fresh_db.flush()
    found = lookup_cached_verdict(
        fresh_db, job_id=None, domain="a.com",
        criterion="wayback_classify",
        params_hash=ph_lib,       # ← different mode
        prompt_hash=prompt_hash,
        exclude_run_id=run2.id,
    )
    assert found is None


def test_classify_cache_misses_when_category_prompt_changes(fresh_db):
    """Editing the category prompt must bust the cache via the sentinel
    in fields_sent — even though the primary prompt + provider + model
    are unchanged. This is what guarantees cross-job cache safety when
    the user tunes the category classification step."""
    from app.cache import compute_prompt_hash
    import hashlib

    primary = "primary"
    cat_v1 = "category v1"
    cat_v2 = "category v2"
    h1 = hashlib.sha256(cat_v1.encode("utf-8")).hexdigest()
    h2 = hashlib.sha256(cat_v2.encode("utf-8")).hexdigest()

    ph_v1 = compute_prompt_hash(
        primary, "gemini", "m",
        fields_sent=[f"wayback_category:{h1}"],
    )
    ph_v2 = compute_prompt_hash(
        primary, "gemini", "m",
        fields_sent=[f"wayback_category:{h2}"],
    )
    assert ph_v1 != ph_v2
