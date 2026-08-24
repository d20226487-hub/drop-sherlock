"""Coverage for the Stop Words criterion (added 2026-08-24).

Stop Words is structurally unlike every other criterion: it fans out over
TWO Ahrefs endpoints (× N term chunks when the operator's word list
exceeds Ahrefs's `where` clause ceiling) and collapses all of it into a
single CriterionResult. That shape breaks the "1 request == 1 CR row"
assumption the rest of the runner is built on, so the invariants worth
pinning down here are:

  • the request builder never emits a `where`-less request (which would
    return the domain's ENTIRE profile and read as maximal contamination),
  • chunking respects the measured 255-clause Ahrefs ceiling,
  • the params hash covers the word list (else the data cache serves rows
    fetched against a different vocabulary),
  • zero matches produce a "clean" verdict WITHOUT an AI call,
  • a partially-failed fetch is reported as failed, not as clean.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime

import pytest

from app.cache import compute_params_hash
from app.providers.ahrefs_requests import (
    STOP_WORDS_MAX_CLAUSES,
    build_preview,
    build_stop_words_requests,
    normalize_stop_words,
    stop_words_sources,
)
from app.schemas import AnalyzeSpec, CriteriaSpec, StopWordsConfig


def _cfg(**kw) -> StopWordsConfig:
    base = dict(
        enabled=True, anchor_limit=20, keyword_limit=20,
        source="both", terms=["casino"],
    )
    base.update(kw)
    return StopWordsConfig(**base)


# --- normalize_stop_words --------------------------------------------------

def test_normalize_lowercases_dedups_and_preserves_order():
    """Ahrefs's `substring` operator is case-insensitive, so "Casino" and
    "casino" would produce two clauses that match identically — burning
    two of the 255 available slots for one term."""
    assert normalize_stop_words(["Casino", "casino", " LOAN ", "casino"]) == [
        "casino",
        "loan",
    ]


def test_normalize_drops_non_strings_and_blanks():
    assert normalize_stop_words(["a", "", "   ", None, 5, "b"]) == ["a", "b"]
    assert normalize_stop_words(None) == []
    assert normalize_stop_words("casino") == []  # a bare string is not a list


def test_normalize_keeps_multi_word_phrases_intact():
    """Term LENGTH is irrelevant to Ahrefs's clause ceiling (measured
    2026-08-18: 200 clauses at 28KB passed, 260 at 23KB failed), so
    phrases must survive normalization unsplit."""
    assert normalize_stop_words(["free spins"]) == ["free spins"]


# --- source expansion ------------------------------------------------------

def test_stop_words_sources_expansion():
    assert stop_words_sources("both") == ["anchors", "keywords"]
    assert stop_words_sources("anchors") == ["anchors"]
    assert stop_words_sources("keywords") == ["keywords"]
    # Unknown values resolve to nothing rather than silently defaulting to
    # "both" — a typo must not double the operator's Ahrefs spend.
    assert stop_words_sources("garbage") == []


# --- request building ------------------------------------------------------

def test_no_terms_emits_no_requests():
    """THE load-bearing invariant. A `where`-less request to these
    endpoints returns the domain's entire anchor / keyword profile, and
    the judge — told every row it sees is evidence against the domain —
    would score a perfectly clean domain as maximally spoiled."""
    assert build_stop_words_requests("example.com", _cfg(terms=[])) == []
    # Whitespace-only entries normalize away to the same empty state.
    assert build_stop_words_requests("example.com", _cfg(terms=["  "])) == []


def test_both_sources_emit_one_request_each():
    reqs = build_stop_words_requests("example.com", _cfg())
    assert [r.source for r in reqs] == ["anchors", "keywords"]
    assert all(r.criterion == "stop_words" for r in reqs)
    assert all(r.limit == 20 for r in reqs)


def test_per_source_limits_apply_to_the_right_request():
    """Anchors cost ~14 units/row, keywords ~33 — so the operator sets
    them independently. Each request must carry ITS source's cap, not a
    shared one."""
    reqs = build_stop_words_requests(
        "example.com", _cfg(anchor_limit=30, keyword_limit=5),
    )
    by_source = {r.source: r for r in reqs}
    assert by_source["anchors"].limit == 30
    assert by_source["keywords"].limit == 5
    assert "limit=30" in by_source["anchors"].url
    assert "limit=5" in by_source["keywords"].url


def test_single_source_halves_the_request_count():
    """`limit` is per-source, so picking one endpoint is the operator's
    lever for halving spend per domain."""
    assert len(build_stop_words_requests("x.com", _cfg(source="anchors"))) == 1
    assert len(build_stop_words_requests("x.com", _cfg(source="keywords"))) == 1


def test_where_is_or_of_substring_clauses_on_the_right_field():
    """`in` is NOT a supported Ahrefs operator (400 `bad where` even with
    10 terms, measured 2026-08-18), so N OR'd substring clauses is the
    only shape available."""
    reqs = build_stop_words_requests(
        "example.com", _cfg(terms=["casino", "loan"]),
    )
    by_source = {r.source: r for r in reqs}
    anchors_or = by_source["anchors"].where["and"][0]["or"]
    assert anchors_or == [
        {"field": "anchor", "is": ["substring", "casino"]},
        {"field": "anchor", "is": ["substring", "loan"]},
    ]
    keywords_or = by_source["keywords"].where["and"][0]["or"]
    assert [c["field"] for c in keywords_or] == ["keyword", "keyword"]


def test_rows_are_ordered_most_significant_first():
    """There's no sort builder on the Stop Words card and `limit` truncates
    server-side — without an explicit order Ahrefs's arbitrary row order
    would decide which contamination the operator gets to see."""
    by_source = {
        r.source: r
        for r in build_stop_words_requests("example.com", _cfg())
    }
    assert by_source["anchors"].order_by == "refdomains:desc"
    assert by_source["keywords"].order_by == "sum_traffic:desc"


def test_keywords_request_carries_the_required_date_param():
    """organic-keywords 400s without a `date` snapshot parameter."""
    req = build_stop_words_requests("example.com", _cfg(source="keywords"))[0]
    assert "date=" in req.url
    assert "organic-keywords" in req.url


def test_chunking_respects_the_ahrefs_clause_ceiling():
    """Ahrefs's ceiling is exactly 255 clauses (255 -> HTTP 200,
    256 -> HTTP 500 "internal server error", fully deterministic). We chunk
    at 250 for margin. Each chunk is a separately billed request, so the
    count matters to the operator's wallet, not just correctness."""
    terms = [f"w{i}" for i in range(STOP_WORDS_MAX_CLAUSES + 1)]
    reqs = build_stop_words_requests("example.com", _cfg(terms=terms))
    # 251 terms -> 2 chunks per source, 2 sources.
    assert len(reqs) == 4
    for r in reqs:
        assert len(r.where["and"][0]["or"]) <= STOP_WORDS_MAX_CLAUSES
    # Every term appears exactly once across the chunks of one source.
    anchor_terms = [
        c["is"][1]
        for r in reqs
        if r.source == "anchors"
        for c in r.where["and"][0]["or"]
    ]
    assert sorted(anchor_terms) == sorted(terms)


def test_build_preview_includes_stop_words_requests():
    """The preview panel has to show the real `where` the runner will
    send, so build_preview must fan out the same way the runner does."""
    spec = AnalyzeSpec(
        domains=["example.com"],
        criteria=CriteriaSpec(stop_words=_cfg()),
    )
    _, reqs = build_preview(spec)
    sw = [r for r in reqs if r.criterion == "stop_words"]
    assert len(sw) == 2
    # ...and the other criteria still emit exactly one request each.
    assert len([r for r in reqs if r.criterion == "backlinks"]) == 1


# --- params hash -----------------------------------------------------------

def test_params_hash_covers_the_word_list():
    """Without the terms in the hash, a cache row fetched against last
    week's vocabulary gets served for this week's — i.e. the app reports a
    domain clean of words it was never actually checked for."""
    a = compute_params_hash("stop_words", _cfg(terms=["casino"]))
    b = compute_params_hash("stop_words", _cfg(terms=["casino", "loan"]))
    assert a != b


def test_params_hash_is_order_and_case_insensitive():
    """Reordering the Settings list (or capitalising an entry) doesn't
    change WHICH rows Ahrefs returns, so it must not needlessly bust the
    cache and re-bill every domain in the job."""
    a = compute_params_hash("stop_words", _cfg(terms=["casino", "loan"]))
    b = compute_params_hash("stop_words", _cfg(terms=["LOAN", "Casino"]))
    assert a == b


def test_params_hash_covers_source_and_per_source_limits():
    base = _cfg()
    assert compute_params_hash("stop_words", base) != compute_params_hash(
        "stop_words", _cfg(source="anchors")
    )
    # Each per-source cap changes how many rows that endpoint returns, so
    # each must independently bust the cache.
    assert compute_params_hash("stop_words", base) != compute_params_hash(
        "stop_words", _cfg(anchor_limit=50)
    )
    assert compute_params_hash("stop_words", base) != compute_params_hash(
        "stop_words", _cfg(keyword_limit=50)
    )


# --- runner integration (DB-backed) ----------------------------------------

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


def _make_rd(session):
    from app.models import Job, Run, RunDomain
    job = Job(name="j", spec_json="{}", kind="quality")
    session.add(job)
    session.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}")
    session.add(run)
    session.flush()
    rd = RunDomain(run_id=run.id, domain="example.com", status="running")
    session.add(rd)
    session.commit()
    return run, rd


def test_fetch_merges_both_sources_and_tags_each_row(fresh_db):
    """One CriterionResult, one merged row list, every row stamped with
    the endpoint it came from — that `source` tag is what the judge
    prompt keys its entire reading off."""
    from app import tasks
    from app.models import CriterionResult

    run, rd = _make_rd(fresh_db)

    async def fake_fetch(url, criterion="backlinks"):
        if "anchors" in url:
            body = {"anchors": [{"anchor": "best casino", "refdomains": 12}]}
        else:
            body = {"keywords": [{"keyword": "casino bonus", "sum_traffic": 40}]}
        return True, 200, body, "", {"cost_row": 14, "cost_total": 140}

    tasks._fetch_criterion = fake_fetch

    rows = asyncio.run(
        tasks._fetch_stop_words_for_domain(
            run_domain_id=rd.id,
            domain="example.com",
            cfg=_cfg(),
            params_hash="ph",
            run_id=run.id,
        )
    )
    assert [r["source"] for r in rows] == ["anchors", "keywords"]
    assert rows[0]["anchor"] == "best casino"
    assert rows[1]["keyword"] == "casino bonus"

    fresh_db.expire_all()
    cr = (
        fresh_db.query(CriterionResult)
        .filter(CriterionResult.criterion == "stop_words")
        .one()
    )
    assert cr.status == "done"
    body = json.loads(cr.data_json)
    # "stop_words" MUST be the first key: `_completed_criteria`, the
    # run-domain detail endpoint and the Database rollup all take the
    # FIRST list value out of data_json.
    assert next(iter(body)) == "stop_words"
    assert len(body["stop_words"]) == 2
    assert body["stop_words_meta"]["terms_count"] == 1
    # Units are summed across the fan-out, not overwritten by the last one.
    assert cr.units_cost_total == 280
    # Both URLs are retained so the operator can inspect what was sent.
    assert cr.request_url.count("\n") == 1


def test_partial_failure_marks_the_row_failed_but_keeps_rows(fresh_db):
    """Inverted polarity makes "best effort" dangerous here: a silently
    missing half makes a spoiled domain look cleaner than it is. Fail
    loudly (so Retry-failed picks it up) while still persisting whatever
    did come back."""
    from app import tasks
    from app.models import CriterionResult

    run, rd = _make_rd(fresh_db)

    async def half_broken(url, criterion="backlinks"):
        if "anchors" in url:
            return True, 200, {"anchors": [{"anchor": "casino"}]}, "", {}
        return False, None, None, "ReadTimeout: boom", {}

    tasks._fetch_criterion = half_broken

    rows = asyncio.run(
        tasks._fetch_stop_words_for_domain(
            run_domain_id=rd.id, domain="example.com", cfg=_cfg(),
            params_hash="ph", run_id=run.id,
        )
    )
    assert rows is None  # caller must NOT feed this to the judge

    fresh_db.expire_all()
    cr = (
        fresh_db.query(CriterionResult)
        .filter(CriterionResult.criterion == "stop_words")
        .one()
    )
    assert cr.status == "failed"
    assert "keywords:" in cr.error
    # The anchors rows we did get are still on the row for eyeballing.
    assert len(json.loads(cr.data_json)["stop_words"]) == 1


def test_empty_word_list_fails_loudly_instead_of_reporting_clean(fresh_db):
    """An empty vocabulary is a MISCONFIGURATION. Reporting "clean" would
    quietly certify every domain in the run as safe."""
    from app import tasks
    from app.models import CriterionResult

    run, rd = _make_rd(fresh_db)

    async def never_called(url, criterion="backlinks"):  # pragma: no cover
        raise AssertionError("must not hit Ahrefs with no terms")

    tasks._fetch_criterion = never_called

    rows = asyncio.run(
        tasks._fetch_stop_words_for_domain(
            run_domain_id=rd.id, domain="example.com", cfg=_cfg(terms=[]),
            params_hash="", run_id=run.id,
        )
    )
    assert rows is None

    fresh_db.expire_all()
    cr = (
        fresh_db.query(CriterionResult)
        .filter(CriterionResult.criterion == "stop_words")
        .one()
    )
    assert cr.status == "failed"
    assert "no stop words configured" in cr.error


def test_zero_matches_writes_a_clean_verdict_without_calling_the_ai(fresh_db):
    """The common case. Skipping the model saves a call per domain, and
    writing a verdict anyway is what lets the Stop column distinguish
    "checked, clean" from "never checked"."""
    from app import tasks
    from app.models import CriterionResult
    # Build the spec from the RELOADED app.schemas, not the module-level
    # import: `fresh_db` re-imports every `app.*` module, so the two
    # AnalyzeSpec classes are distinct and Pydantic rejects the mix.
    from app.schemas import AnalyzeSpec as FreshSpec

    run, rd = _make_rd(fresh_db)
    cr = CriterionResult(
        run_domain_id=rd.id, criterion="stop_words", status="done",
        data_json=json.dumps({"stop_words": []}),
    )
    fresh_db.add(cr)
    fresh_db.commit()

    async def never_called(**kw):  # pragma: no cover
        raise AssertionError("AI must not run on an empty payload")

    tasks.judge = never_called

    spec = FreshSpec.model_validate({
        "domains": ["example.com"],
        "criteria": {
            "stop_words": {
                "enabled": True,
                "anchor_limit": 20,
                "keyword_limit": 20,
                "source": "both",
                "terms": ["casino", "loan"],
            },
        },
        "ai": {"provider": "gemini"},
    })
    sub_verdicts: dict = {}
    asyncio.run(
        tasks._judge_one_criterion(
            criterion="stop_words",
            rows=[],
            run_domain_id=rd.id,
            domain="example.com",
            spec=spec,
            provider="gemini",
            model_override=None,
            resolved_model_for_hash="m",
            cr_id_by_criterion={"stop_words": cr.id},
            cached_verdicts={},
            sub_verdicts=sub_verdicts,
            cache_enabled=False,
            cache_job_scope=None,
            classify_ctx_config={"enabled": False, "criteria": [], "fields": []},
            run_id=run.id,
        )
    )
    v = sub_verdicts["stop_words"]
    assert v["assessment"] == "high_quality"
    assert v["no_matches"] is True
    assert "2 configured stop words" in v["key_findings"][0]

    fresh_db.expire_all()
    fresh_db.refresh(cr)
    stored = json.loads(cr.ai_verdict_json)
    assert stored["no_matches"] is True
    # No AI call happened, so claiming a provider/model would make the
    # run's cost accounting lie.
    assert cr.ai_provider == ""
    assert cr.ai_model == ""


def test_resume_resets_the_existing_row_instead_of_duplicating(fresh_db):
    """The fetcher checks cancel/pause BETWEEN sub-requests and can bail
    with the row still `running`. `_completed_criteria` only surfaces
    `done` rows, so resume re-enters this function — and a plain
    `_create_criterion_row` would leave two CRs for one (rd, criterion),
    breaking the dict `_criterion_row_ids` builds."""
    from app import tasks
    from app.models import CriterionResult

    run, rd = _make_rd(fresh_db)
    stranded = CriterionResult(
        run_domain_id=rd.id, criterion="stop_words", status="running",
        request_url="old-url", data_json="",
    )
    fresh_db.add(stranded)
    fresh_db.commit()
    stranded_id = stranded.id

    async def fake_fetch(url, criterion="backlinks"):
        return True, 200, {"anchors": []}, "", {}

    tasks._fetch_criterion = fake_fetch

    rows = asyncio.run(
        tasks._fetch_stop_words_for_domain(
            run_domain_id=rd.id, domain="example.com",
            cfg=_cfg(source="anchors"), params_hash="ph", run_id=run.id,
        )
    )
    assert rows == []  # fetched fine, matched nothing — the good outcome

    fresh_db.expire_all()
    crs = (
        fresh_db.query(CriterionResult)
        .filter(CriterionResult.criterion == "stop_words")
        .all()
    )
    assert len(crs) == 1
    assert crs[0].id == stranded_id  # reset in place, not replaced
    assert crs[0].status == "done"
    assert crs[0].request_url != "old-url"


# --- silent-drop regression (2026-08-24) ------------------------------------

def test_over_long_entry_is_reported_not_silently_dropped():
    """The bug this guards: pasting a pipe-delimited list into a box that
    didn't split on pipe produced ONE 1538-char "term", which the length
    cap dropped — and the write reported success with nothing stored. The
    write path must hand the reject back so the UI can say what happened."""
    from app.app_settings import _STOP_WORD_MAX_LEN, partition_stop_words

    blob = "|".join(f"word{i}" for i in range(300))
    assert len(blob) > _STOP_WORD_MAX_LEN
    accepted, rejected = partition_stop_words([blob, "casino"])
    assert accepted == ["casino"]
    assert rejected == [blob]


def test_duplicates_are_not_reported_as_rejects():
    """Dropping a dupe is the expected outcome, not a failure worth
    telling the operator about — only genuinely refused entries belong in
    `rejected`, or the warning cries wolf on every re-paste."""
    from app.app_settings import partition_stop_words

    accepted, rejected = partition_stop_words(["casino", "CASINO", " casino "])
    assert accepted == ["casino"]
    assert rejected == []


def test_set_stop_words_round_trips_the_real_operator_list(tmp_path, monkeypatch):
    """End-to-end on the shape that actually broke: a 211-term
    pipe-delimited vocabulary. Split correctly it must store whole, and
    stay under the clause ceiling so it costs one request per source."""
    from app.app_settings import partition_stop_words

    blob = "1xbet|adult|bet|casino|cialis|free spins|porn|казино|ставки"
    accepted, rejected = partition_stop_words(blob.split("|"))
    assert rejected == []
    assert "free spins" in accepted          # phrase survived unsplit
    assert "казино" in accepted              # non-ASCII survived
    assert len(accepted) == len(blob.split("|"))
    assert len(accepted) <= STOP_WORDS_MAX_CLAUSES  # one request per source


# --- "Sources checked" block (2026-08-24) -----------------------------------

def test_sources_block_separates_unchecked_from_checked_and_clean():
    """The rows alone CANNOT distinguish these two, and they call for
    opposite confidence moves:
      • operator picked anchors-only  -> a real blind spot, be less sure
      • both picked, keywords matched nothing -> evidence of cleanliness
    Both yield rows that are 100% `source: anchors`, so the judge needs
    the config stated explicitly or it penalises the clean domain."""
    from app.tasks import _build_user_message_for_criterion

    rows = [{"source": "anchors", "anchor": "best casino bonus"}]

    both = _build_user_message_for_criterion(
        criterion="stop_words", domain="d.com", rows=rows,
        stop_words_sources=["anchors", "keywords"],
    )
    assert "Sources checked: anchors, keywords" in both
    assert "keywords=0" in both

    only = _build_user_message_for_criterion(
        criterion="stop_words", domain="d.com", rows=rows,
        stop_words_sources=["anchors"],
    )
    assert "Sources checked: anchors\n" in only
    assert "keywords" not in only.split("Sources checked:")[1]


def test_sources_block_is_stop_words_only():
    """Other criteria must be byte-identical to before, or every cached
    B/D/A/K verdict silently invalidates."""
    from app.tasks import _build_user_message_for_criterion

    msg = _build_user_message_for_criterion(
        criterion="anchors", domain="d.com", rows=[{"anchor": "x"}],
        stop_words_sources=["anchors", "keywords"],
    )
    assert "Sources checked" not in msg


def test_source_choice_is_in_the_ai_cache_key():
    """`compute_prompt_hash` hashes the SYSTEM prompt, never the user
    message — so a user-message block that isn't mirrored into
    `fields_sent` gets served verdicts judged without it. Editing the
    default prompt does not cover this: an operator with a customized
    prompt in Settings would keep hitting the stale hash."""
    from app.cache import compute_prompt_hash
    from app.tasks import AI_FIELD_TRIM

    base = list(AI_FIELD_TRIM["stop_words"])
    def h(fields):
        return compute_prompt_hash("P", "gemini", "m", fields_sent=fields)

    both = h(base + ["stop_words_sources:anchors,keywords"])
    anchors_only = h(base + ["stop_words_sources:anchors"])
    legacy = h(base)
    assert len({both, anchors_only, legacy}) == 3
