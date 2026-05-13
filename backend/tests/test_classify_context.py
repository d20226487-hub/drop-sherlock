"""Coverage for the classify-context → Ahrefs judge injection (added
2026-05-13). Validates:

- Settings storage roundtrips correctly + drops unknown criteria/fields.
- `_load_classify_context` respects master toggle, criterion scope, and
  field scope; projects only fields present in the verdict; canonical
  ordering matches Settings (not verdict iteration order).
- `_build_user_message_for_criterion` appends the context block only
  when given a non-empty dict.
- The cache-bust gotcha: when classify_context is added to a user
  message, `fields_sent` gains a sentinel so `compute_prompt_hash`
  produces a different hash from the no-context call.
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


# --- Settings storage --------------------------------------------------------


def test_default_classify_context_config(fresh_db):
    """Defaults: enabled, B/A/K (not refdomains), all 9 fields."""
    from app.app_settings import get_classify_context_config
    cfg = get_classify_context_config()
    assert cfg["enabled"] is True
    assert cfg["criteria"] == ["backlinks", "anchors", "keywords"]
    assert "refdomains" not in cfg["criteria"]
    assert len(cfg["fields"]) == 9
    assert "primary_theme" in cfg["fields"]
    assert "category" in cfg["fields"]


def test_classify_context_roundtrip_drops_unknown(fresh_db):
    """Unknown criteria/fields are silently dropped (forward-compat).
    Known ones survive in CANONICAL allowed-list order, not the order
    the user submitted — so two installs with the same set produce
    identical cache sentinels."""
    from app.app_settings import (
        get_classify_context_config,
        set_classify_context_config,
    )
    out = set_classify_context_config({
        # Reversed + unknown noise mixed in
        "criteria": ["keywords", "bogus_criterion", "backlinks"],
        "fields": ["category", "nonexistent_field", "primary_theme"],
        "enabled": False,
    })
    assert out["enabled"] is False
    # Canonical order: B/D/A/K → keywords last; refdomains excluded
    assert out["criteria"] == ["backlinks", "keywords"]
    # Canonical order from _CLASSIFY_CONTEXT_ALLOWED_FIELDS
    assert out["fields"] == ["primary_theme", "category"]
    # Re-read confirms persistence
    same = get_classify_context_config()
    assert same == out


def test_classify_context_partial_update(fresh_db):
    """Caller may pass only the keys they want to change; others stay."""
    from app.app_settings import (
        get_classify_context_config,
        set_classify_context_config,
    )
    set_classify_context_config({"enabled": False})
    cfg = get_classify_context_config()
    assert cfg["enabled"] is False
    # Criteria + fields should still be the defaults
    assert "backlinks" in cfg["criteria"]
    assert len(cfg["fields"]) == 9


def test_classify_context_reset_removes_override(fresh_db):
    from app.app_settings import (
        get_classify_context_config,
        reset_classify_context_config,
        set_classify_context_config,
    )
    set_classify_context_config({"enabled": False, "criteria": []})
    reset_classify_context_config()
    cfg = get_classify_context_config()
    assert cfg["enabled"] is True
    assert cfg["criteria"] == ["backlinks", "anchors", "keywords"]


# --- _load_classify_context --------------------------------------------------


def _verdict() -> dict:
    return {
        "primary_language": "en",
        "secondary_languages": ["fr"],
        "language_confidence": 0.9,
        "primary_theme": "pet care",
        "secondary_themes": ["dog food"],
        "theme_confidence": 0.85,
        "drift_detected": False,
        "category": "e-commerce",
        "category_confidence": 0.7,
        # category_was deliberately absent
        # category_reasoning deliberately absent
    }


def test_load_classify_context_respects_master_toggle(fresh_db):
    from app.tasks import _load_classify_context
    cfg = {"enabled": False, "criteria": ["backlinks"],
           "fields": ["primary_theme"]}
    out = _load_classify_context(
        run_domain_id=1, criterion="backlinks",
        sub_verdicts={"wayback_classify": _verdict()}, config=cfg,
    )
    assert out is None


def test_load_classify_context_respects_criterion_scope(fresh_db):
    from app.tasks import _load_classify_context
    cfg = {"enabled": True, "criteria": ["backlinks"],
           "fields": ["primary_theme"]}
    sub = {"wayback_classify": _verdict()}
    # In scope → returns context
    assert _load_classify_context(
        run_domain_id=1, criterion="backlinks",
        sub_verdicts=sub, config=cfg,
    ) is not None
    # Out of scope → None
    assert _load_classify_context(
        run_domain_id=1, criterion="refdomains",
        sub_verdicts=sub, config=cfg,
    ) is None
    assert _load_classify_context(
        run_domain_id=1, criterion="anchors",
        sub_verdicts=sub, config=cfg,
    ) is None


def test_load_classify_context_projects_only_configured_fields(fresh_db):
    """Verdict has 9 fields; config asks for 2. Output has exactly 2."""
    from app.tasks import _load_classify_context
    cfg = {"enabled": True, "criteria": ["backlinks"],
           "fields": ["primary_theme", "category"]}
    out = _load_classify_context(
        run_domain_id=1, criterion="backlinks",
        sub_verdicts={"wayback_classify": _verdict()}, config=cfg,
    )
    assert out == {"primary_theme": "pet care", "category": "e-commerce"}


def test_load_classify_context_skips_missing_fields(fresh_db):
    """Config asks for category_was but the verdict doesn't have it
    (no drift detected → category_was never written). Output skips it."""
    from app.tasks import _load_classify_context
    cfg = {"enabled": True, "criteria": ["backlinks"],
           "fields": ["primary_theme", "category_was", "category"]}
    out = _load_classify_context(
        run_domain_id=1, criterion="backlinks",
        sub_verdicts={"wayback_classify": _verdict()}, config=cfg,
    )
    assert out == {"primary_theme": "pet care", "category": "e-commerce"}
    assert "category_was" not in out


def test_load_classify_context_returns_none_when_classify_failed(fresh_db):
    """No wayback_classify entry in sub_verdicts AND no CR row in DB →
    None. B/A/K judges fall back to plain (no context block)."""
    from app.tasks import _load_classify_context
    cfg = {"enabled": True, "criteria": ["backlinks"],
           "fields": ["primary_theme"]}
    out = _load_classify_context(
        run_domain_id=999_999, criterion="backlinks",
        sub_verdicts={}, config=cfg,
    )
    assert out is None


def test_load_classify_context_falls_back_to_db(fresh_db):
    """When sub_verdicts is empty (e.g. AI preview path), the helper
    reads the classify CR's ai_verdict_json directly from the DB."""
    from app.models import CriterionResult, Job, Run, RunDomain
    from app.tasks import _load_classify_context
    from datetime import datetime
    job = Job(name="t", spec_json="{}")
    fresh_db.add(job)
    fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}",
              finished_at=datetime.utcnow())
    fresh_db.add(run)
    fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="a.com", status="done")
    fresh_db.add(rd)
    fresh_db.flush()
    fresh_db.add(CriterionResult(
        run_domain_id=rd.id, criterion="wayback_classify",
        status="done",
        ai_verdict_json=json.dumps(_verdict()),
    ))
    fresh_db.commit()

    cfg = {"enabled": True, "criteria": ["backlinks"],
           "fields": ["primary_theme", "category"]}
    out = _load_classify_context(
        run_domain_id=rd.id, criterion="backlinks",
        sub_verdicts={}, config=cfg,  # empty in-memory map
    )
    assert out == {"primary_theme": "pet care", "category": "e-commerce"}


# --- _build_user_message_for_criterion --------------------------------------


def test_build_user_message_omits_classify_block_when_none(fresh_db):
    from app.tasks import _build_user_message_for_criterion
    msg = _build_user_message_for_criterion(
        criterion="backlinks", domain="a.com", rows=[{"x": 1}],
        classify_context=None,
    )
    assert "Site context" not in msg
    assert "wayback" not in msg.lower() or "criterion" in msg.lower()


def test_build_user_message_appends_classify_block_when_present(fresh_db):
    from app.tasks import _build_user_message_for_criterion
    ctx = {"primary_theme": "pet care", "category": "e-commerce"}
    msg = _build_user_message_for_criterion(
        criterion="backlinks", domain="a.com", rows=[{"x": 1}],
        classify_context=ctx,
    )
    assert "Site context (Wayback classify" in msg
    assert "pet care" in msg
    assert "e-commerce" in msg


# --- Cache-bust contract -----------------------------------------------------


def test_prompt_hash_differs_with_and_without_classify_context(fresh_db):
    """The whole point of the fields_sent sentinel: cache hashes split
    cleanly between context-aware and context-less calls so the cache
    doesn't silently serve stale verdicts."""
    from app.cache import compute_prompt_hash
    sys_prompt = "system"
    provider = "gemini"
    model = "gemini-2.5-flash"
    base_fields = ["url_from", "ahrefs_rank"]

    h_plain = compute_prompt_hash(
        sys_prompt, provider, model, fields_sent=base_fields,
    )
    h_with_ctx = compute_prompt_hash(
        sys_prompt, provider, model,
        fields_sent=base_fields + [
            "classify_context:category,primary_theme",
        ],
    )
    assert h_plain != h_with_ctx


def test_prompt_hash_differs_across_field_sets(fresh_db):
    """Changing the Settings field list (e.g. user drops 'drift_detected')
    must produce a different hash so old verdicts judged with drift in
    the context don't accidentally hit cache."""
    from app.cache import compute_prompt_hash
    sys_prompt = "system"
    provider = "gemini"
    model = "gemini-2.5-flash"
    h_2 = compute_prompt_hash(
        sys_prompt, provider, model,
        fields_sent=[
            "url_from",
            "classify_context:category,primary_theme",
        ],
    )
    h_3 = compute_prompt_hash(
        sys_prompt, provider, model,
        fields_sent=[
            "url_from",
            "classify_context:category,drift_detected,primary_theme",
        ],
    )
    assert h_2 != h_3
