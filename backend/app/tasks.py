"""Background job execution.

`process_run(run_id)` is the entry point: it loads the run + spec from DB,
fetches every (domain × enabled-criterion) Ahrefs request via the rate
limiter, persists results, and updates statuses as it goes. It's a single
top-level coroutine — APScheduler is not involved (Drop Sherlock has no
cron; one-shot async tasks are simpler).

`mark_orphaned_runs_paused()` is called on lifespan startup: any Run still
flagged `running` after a uvicorn restart is now stale (the asyncio task
that owned it is gone). Mark such runs `paused` so the UI doesn't lie about
their state — and crucially so the user can hit Resume to pick up where
they left off via the existing pause/resume idempotency. (Pre-2026-05-07
this was `mark_orphaned_runs_failed` and the run was unrecoverable.)"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from .ai_judge import AI_PROVIDERS, _resolve_model, judge
from .ai_prompts import localize_prompt
from .app_settings import get_ai_prompt
from .cache import (
    compute_params_hash,
    compute_prompt_hash,
    lookup_cached_data,
    lookup_cached_verdict,
)
from .db import SessionLocal
from .limits import limit
from .models import CriterionResult, Job, Run, RunDomain
from .providers import get_provider
from .providers.ahrefs_requests import build_preview
from .providers.base import ProviderConfigError, ProviderError
from .schemas import AnalyzeSpec
from .scoring import compute_final

log = logging.getLogger(__name__)


# Per-criterion field-trim list passed to the AI. Order matters for
# prompt readability. Each list is kept in lockstep with the matching
# SELECT_FIELDS entry in providers/ahrefs_requests.py — fetching a
# column we don't send to the AI just costs Ahrefs units for nothing,
# and sending a field we didn't fetch produces empty values that the
# model has to skip.
AI_FIELD_TRIM: dict[str, list[str]] = {
    # Backlinks (trimmed 2026-05-10): snippet_left + snippet_right + url_to
    # are now sent to the AI so it can judge editorial-vs-boilerplate
    # placement directly from the surrounding text (the per-row
    # is_dofollow / is_content / link_type flags that used to drive that
    # judgment were dropped from SELECT — see ahrefs_requests.py).
    "backlinks": [
        # 2026-05-18: dropped traffic_domain + traffic (cost trim — see
        # SELECT_FIELDS["backlinks"] in providers/ahrefs_requests.py).
        "url_from", "anchor", "snippet_left", "snippet_right", "url_to",
        "domain_rating_source", "url_rating_source",
        "positions", "refdomains_source", "first_seen_link",
        "last_seen", "title", "languages",
    ],
    # Refdomains: dropped is_spam (every returned row has is_spam=0 by
    # default non_spammy filter; sending the field added noise without
    # signal).
    "refdomains": [
        # 2026-05-18: dropped positions_source_domain (cost trim — see
        # SELECT_FIELDS["refdomains"] in providers/ahrefs_requests.py).
        "domain", "domain_rating", "dofollow_refdomains",
        "dofollow_linked_domains", "dofollow_links", "links_to_target",
        "traffic_domain", "new_links",
        "lost_links", "first_seen", "last_seen",
    ],
    # Anchors: `is_spam` deliberately omitted (2026-05-07). Ahrefs's per-row
    # spam flag on the anchors endpoint is unreliable enough to mislead the
    # AI; spam detection lives on the backlinks criterion. (As of
    # 2026-05-10 it's also dropped from SELECT_FIELDS so we no longer
    # pay to fetch it.)
    "anchors": [
        "anchor", "refdomains", "refpages", "dofollow_links",
        "links_to_target", "top_domain_rating", "new_links",
        "lost_links", "first_seen", "last_seen",
    ],
    # Kept in sync with SELECT_FIELDS["keywords"] in ahrefs_requests.py.
    # Trimmed 2026-05-10 to lower Ahrefs unit cost; see the comment on
    # SELECT_FIELDS for the full rationale on each dropped column.
    "keywords": [
        "keyword", "sum_traffic", "volume", "best_position",
        "keyword_difficulty", "is_branded",
    ],
    # Wayback CDX rows. The AI sees the timestamp + statuscode + path
    # signal it needs to detect 301 patterns, theme drift via URL paths,
    # and overall site-health-over-time. `digest` would just be hash noise
    # so we drop it from the AI input even though it's in the table.
    "wayback": [
        "timestamp", "original", "statuscode", "mimetype", "length",
    ],
}


def _trim_rows_for_ai(criterion: str, rows: list[dict]) -> list[dict]:
    """Drop high-volume low-signal fields before sending to the AI."""
    fields = AI_FIELD_TRIM.get(criterion)
    if not fields:
        return rows
    return [{k: r.get(k) for k in fields if k in r} for r in rows]


def build_ai_preview(run_domain_id: int, criterion: str) -> dict:
    """Return EXACTLY what would be sent to the AI for this criterion on
    this domain. Same trim list, same system prompt, same user message
    format the runner uses. Pure inspection — runs no AI, mutates nothing.

    Used by the UI's "Preview AI input" link so users can see the data
    behind a verdict (e.g. is_spam / first_seen / last_seen fields that
    aren't in the default raw-data table)."""
    if criterion not in (
        "backlinks", "refdomains", "anchors", "keywords",
        "wayback", "wayback_classify",
        # Wave 2b (2026-05-15): whois_history pillar criterion. Has its
        # own dedicated branch below (single-shot prompt, no row-trim,
        # no classify-context).
        "whois_history",
    ):
        raise ValueError(f"invalid criterion: {criterion}")

    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            raise LookupError("run domain not found")
        domain = rd.domain
        cr = next(
            (c for c in rd.results if c.criterion == criterion), None
        )
        rows: list[dict] = []
        wayback_samples_raw: list[dict] = []
        if cr is not None and cr.data_json:
            try:
                body = json.loads(cr.data_json)
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict):
                for v in body.values():
                    if isinstance(v, list):
                        rows = v
                        break
                # Wayback V2 samples sit alongside the CDX rows under
                # "samples". Pull them out so the AI preview matches what
                # the judge actually receives.
                if criterion == "wayback":
                    samples_val = body.get("samples")
                    if isinstance(samples_val, list):
                        wayback_samples_raw = samples_val
        # wayback_classify reads samples from the SIBLING wayback CR
        # (not its own — its own CR has no data_json). Look up the
        # wayback CR on the same rd here.
        if criterion == "wayback_classify":
            wb_cr = next(
                (c for c in rd.results if c.criterion == "wayback"), None
            )
            if wb_cr is not None and wb_cr.data_json:
                try:
                    wb_body = json.loads(wb_cr.data_json)
                except json.JSONDecodeError:
                    wb_body = None
                if isinstance(wb_body, dict):
                    samples_val = wb_body.get("samples")
                    if isinstance(samples_val, list):
                        wayback_samples_raw = samples_val
        run = db.get(Run, rd.run_id)
        spec_provider = ""
        spec_model = ""
        spec_language_mode = "ai"
        spec_lang = "en"
        if run is not None:
            try:
                sj = json.loads(run.spec_json or "{}")
                ai = sj.get("ai") or {}
                spec_provider = ai.get("provider") or ""
                spec_model = ai.get("model") or ""
                wbc_cfg = (sj.get("criteria") or {}).get("wayback_classify") or {}
                spec_language_mode = wbc_cfg.get("language_mode") or "ai"
                # Output-language directive carried on the run's spec; the
                # preview should show the EXACT system prompt the runner
                # would use (RU directive included on RU runs).
                if sj.get("lang") == "ru":
                    spec_lang = "ru"
            except json.JSONDecodeError:
                pass
        # Verdict-level provenance: who ACTUALLY produced the current
        # verdict on this CR (set by the runner / reanalyze; may differ
        # from the run's original spec.ai after a reanalyze with an
        # override). Preferred over spec.ai for the "next reanalyze
        # default" pill since hitting Re-judge again without picking a
        # provider keeps you on whatever produced the row you're looking
        # at — matches the VerdictBox provenance chip's behavior.
        cr_provider = (cr.ai_provider or "") if cr is not None else ""
        cr_model = (cr.ai_model or "") if cr is not None else ""
    finally:
        db.close()

    # Whois History uses its own prompt + user-message builder
    # (whois_history.runner.build_user_message). The standard Ahrefs/
    # Wayback row-trimming logic doesn't apply — the prompt body is
    # the structured diff + raw historical records.
    if criterion == "whois_history":
        from .whois_history.runner import (
            MAX_RECORDS_IN_PROMPT,
            build_user_message,
        )
        records: list[dict] = []
        diff_dict: dict = {}
        provider_name = ""
        if cr is not None and cr.data_json:
            try:
                body = json.loads(cr.data_json)
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict):
                rec_val = body.get("records")
                if isinstance(rec_val, list):
                    records = [r for r in rec_val if isinstance(r, dict)]
                diff_val = body.get("diff")
                if isinstance(diff_val, dict):
                    diff_dict = diff_val
                provider_val = body.get("provider")
                if isinstance(provider_val, str):
                    provider_name = provider_val
        system_prompt = localize_prompt(
            get_ai_prompt("whois_history_judge"), spec_lang,
        )
        user_message = build_user_message(domain, records, diff_dict)
        effective_provider = cr_provider or spec_provider
        effective_model = cr_model or spec_model
        if not cr_model and effective_provider:
            try:
                effective_model = _resolve_model(effective_provider, spec_model)
            except Exception:  # noqa: BLE001
                effective_model = spec_model
        return {
            "domain": domain,
            "criterion": criterion,
            "provider": effective_provider,
            "model": effective_model,
            # No row-trim metadata for whois_history (the prompt body
            # is structured diff + raw records, not a column-trimmed
            # table). Frontend treats empty `fields_sent` as "no
            # field-trim chip row" and falls through to the system-
            # prompt + user-message preview.
            "fields_sent": [],
            # `row_count` here = how many records made it into the
            # prompt (capped at MAX_RECORDS_IN_PROMPT). Frontend
            # surfaces it as "N records" chip.
            "row_count": min(len(records), MAX_RECORDS_IN_PROMPT),
            "system_prompt": system_prompt,
            "user_message": user_message,
            # `rows` for the whois_history preview is the same record
            # set the prompt embeds — same shape (dict), same field
            # names (query_time, creation_date, registrar_name, etc.).
            # Newest-first to match the prompt order.
            "rows": list(reversed(records))[:MAX_RECORDS_IN_PROMPT],
            # Surface the WhoisFreaks/etc provider name for the UI's
            # provenance chip — distinct from the AI provider above.
            "whois_provider": provider_name,
            # Snapshot count BEFORE the cap so the user can see how
            # much history exists vs. how much actually reached the AI.
            "snapshot_count_total": len(records),
        }

    # wayback_classify uses its own prompt + user-message builder. The
    # standard fields_sent / row-trimming logic doesn't apply (it doesn't
    # consume row dicts; it consumes V2 samples). Render a multi-step
    # preview so the user can see BOTH the language+theme prompt AND the
    # chained category prompt that would run after.
    if criterion == "wayback_classify":
        from .wayback_classify import build_classify_user_message
        from .app_settings import get_categories
        # Pick the right prompt based on the run's stored language_mode.
        prompt_key = (
            "wayback_classify_theme_only"
            if spec_language_mode == "library"
            else "wayback_classify_combined"
        )
        system_prompt = localize_prompt(get_ai_prompt(prompt_key), spec_lang)
        # The combined / theme-only prompts read full V2 samples — pass
        # them through the same trim function the runner uses so the
        # preview matches the wire payload exactly.
        trimmed_samples = _trim_samples_for_ai(wayback_samples_raw)
        user_message = build_classify_user_message(
            domain=domain, samples=trimmed_samples, lingua_hint=None,
        )
        category_prompt = localize_prompt(
            get_ai_prompt("wayback_category"), spec_lang
        )
        # If a verdict already landed, render the EXACT category user-msg
        # the runner would have built. Otherwise render a placeholder so
        # the user can see the prompt + categories at minimum.
        category_user_message = ""
        if cr is not None and cr.ai_verdict_json:
            try:
                from .wayback_classify import build_category_user_message
                verdict = json.loads(cr.ai_verdict_json)
                if isinstance(verdict, dict):
                    category_user_message = build_category_user_message(
                        theme_verdict=verdict, categories=get_categories(),
                    )
            except json.JSONDecodeError:
                pass
        # Provider/model: prefer what actually produced this CR's verdict
        # (cr.ai_provider/cr.ai_model). If there's no verdict yet, fall
        # back to the run's spec.ai resolved through Settings defaults.
        effective_provider = cr_provider or spec_provider
        effective_model = cr_model or spec_model
        if not cr_model and effective_provider:
            try:
                effective_model = _resolve_model(effective_provider, spec_model)
            except Exception:  # noqa: BLE001
                effective_model = spec_model
        return {
            "domain": domain,
            "criterion": criterion,
            "provider": effective_provider,
            "model": effective_model,
            "fields_sent": [],
            "row_count": len(trimmed_samples),
            "system_prompt": system_prompt,
            "user_message": user_message,
            "rows": trimmed_samples,
            # wayback_classify-specific fields surfaced for the UI to
            # render a 2-step preview. `language_mode` tells the user
            # which combined-vs-theme-only prompt was picked. The
            # category step's user_message is empty when no verdict
            # exists yet (since theme-detection's output feeds it).
            "language_mode": spec_language_mode,
            "category_system_prompt": category_prompt,
            "category_user_message": category_user_message,
        }

    trimmed = _trim_rows_for_ai(criterion, rows)
    fields_sent = AI_FIELD_TRIM.get(criterion, [])
    system_prompt = localize_prompt(get_ai_prompt(criterion), spec_lang)
    wayback_samples_for_ai: list[dict] | None = None
    if criterion == "wayback" and wayback_samples_raw:
        wayback_samples_for_ai = _trim_samples_for_ai(wayback_samples_raw)
    # Mirror the runner's classify-context injection so the preview shows
    # exactly what the AI would see if you re-judged this criterion right
    # now. Preview path passes an empty sub_verdicts dict — _load_classify_
    # context falls back to reading the classify CR row from the DB in
    # that case, which is correct for a preview of an already-judged rd.
    classify_context_for_ai: dict | None = None
    if criterion in _CLASSIFY_CONTEXT_ELIGIBLE_CRITERIA:
        from .app_settings import get_classify_context_config
        classify_context_for_ai = _load_classify_context(
            run_domain_id, criterion, {}, get_classify_context_config(),
        )
        if classify_context_for_ai is not None:
            fields_sent = list(fields_sent) + [
                "classify_context:" + ",".join(
                    sorted(classify_context_for_ai.keys())
                )
            ]
    user_message = _build_user_message_for_criterion(
        criterion=criterion,
        domain=domain,
        rows=trimmed,
        wayback_samples=wayback_samples_for_ai,
        classify_context=classify_context_for_ai,
    )
    # Provider/model — same provenance preference as the wayback_classify
    # branch above: actual verdict producer wins, falling back to the
    # run's spec.ai resolved through Settings.
    effective_provider = cr_provider or spec_provider
    effective_model = cr_model or spec_model
    if not cr_model and effective_provider:
        try:
            effective_model = _resolve_model(effective_provider, spec_model)
        except Exception:  # noqa: BLE001
            effective_model = spec_model

    return {
        "domain": domain,
        "criterion": criterion,
        "provider": effective_provider,
        "model": effective_model,
        "fields_sent": fields_sent,
        "row_count": len(trimmed),
        "system_prompt": system_prompt,
        "user_message": user_message,
        # Same trimmed rows the AI sees, exposed as structured data so the
        # UI can render them as a table without re-parsing the JSON out of
        # `user_message`. Identical content; redundant by design.
        "rows": trimmed,
        # Classify context that's folded into the user message (added
        # 2026-05-13). Exposed structured so the UI can render a small
        # key-value table — saves the user from scrolling to the bottom
        # of the JSON view to verify what theme/category values were sent.
        # None when the criterion isn't B/D/A/K, classify isn't enabled in
        # Settings, this criterion isn't in the configured scope, or no
        # classify verdict exists for this rd.
        "classify_context": classify_context_for_ai,
    }


# --- Public entry points ----------------------------------------------------

def mark_orphaned_runs_paused(db: Session) -> int:
    """Convert any `running` runs to `paused` so the user can resume them
    via the existing Resume button. Called once at lifespan startup —
    after a uvicorn restart there's no asyncio task left owning the run,
    so leaving status=`running` would lie to the UI. Marking them
    `paused` (rather than `failed`, the pre-2026-05-07 behavior) preserves
    the user's option to pick up where they left off: `resume_run_now`
    already handles cleanup of half-written CriterionResult rows + reset
    of non-terminal domains. Returns the number of runs touched.

    Domain/CriterionResult statuses are left alone here. `resume_run_now`
    is the single place that decides what to keep vs reset, so there's no
    point pre-mutating them on the way in."""
    rows = db.query(Run).filter(Run.status == "running").all()
    n = 0
    for r in rows:
        r.status = "paused"
        r.error = (
            "Process restarted while this run was in progress; auto-paused. "
            "Resume to continue (already-fetched criteria + AI verdicts will "
            "be reused)."
        )
        n += 1
    if n:
        db.commit()
    return n


def dispatch_run(run_id: int) -> asyncio.Task:
    """Schedule a runner for `run_id` based on the parent Job's `kind`.
    Returns the Task handle so callers can keep a reference (asyncio
    GC's task objects that aren't referenced anywhere).

    Kind dispatch (Wave 1+2+3, 2026-05-15):
      • quality       → tasks.process_run (Wayback + Ahrefs pipeline)
      • whois_history → whois_history.runner.process_whois_history_run
      • availability  → availability_runner.process_availability_run
                        (Wave 3) — runs the existing cascade with
                        use_cache=False and writes one CR per domain.

    Cheap DB peek (one PK lookup) to read the kind. Done synchronously
    here because the runner functions don't take spec via argument —
    they re-load via SessionLocal inside their first transaction.

    Clears any stale `_PAUSED_RUNS` / `_CANCELED_RUNS` entry for
    `run_id` before dispatching. SQLite reuses rowids after DELETE
    (no AUTOINCREMENT here), so a newly-created Run can collide with
    an in-memory flag left over from a previously paused/canceled run
    whose row got deleted (`POST /jobs/bulk-delete` and
    `DELETE /jobs/{id}` don't clear these flags — only the per-run
    delete endpoint does). Without this guard, the fresh worker
    short-circuits at the first pause/cancel check for every domain
    and the run marks itself failed in milliseconds with zero
    progress."""
    _clear_pause(run_id)
    _clear_cancel(run_id)
    db = SessionLocal()
    kind = "quality"
    try:
        run = db.get(Run, run_id)
        if run is not None and run.job is not None and run.job.kind:
            kind = run.job.kind
    finally:
        db.close()
    if kind == "whois_history":
        from .whois_history.runner import process_whois_history_run
        return asyncio.create_task(process_whois_history_run(run_id))
    if kind == "availability":
        from .availability_runner import process_availability_run
        return asyncio.create_task(process_availability_run(run_id))
    return asyncio.create_task(process_run(run_id))


# Module-level set keeps task references alive across `dispatch_run` returns.
# Without this, asyncio's GC can drop a task mid-flight if no one stores the
# Task object.
_BG_TASKS: set[asyncio.Task] = set()


def _track(task: asyncio.Task) -> None:
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


# --- Cancellation -----------------------------------------------------------

# Process-level set of run ids the user has asked to cancel. The worker
# checks `is_canceled(run_id)` before each new fetch / AI call. In-flight
# requests are NOT killed; they finish and persist normally. This is a
# deliberate trade — interrupting httpx mid-request leaves the upstream
# bill in place anyway, so just letting it complete keeps the data we
# already paid for.
_CANCELED_RUNS: set[int] = set()


def is_canceled(run_id: int) -> bool:
    return run_id in _CANCELED_RUNS


def request_cancel(run_id: int) -> None:
    _CANCELED_RUNS.add(run_id)


def _clear_cancel(run_id: int) -> None:
    _CANCELED_RUNS.discard(run_id)


# --- Pause / resume ---------------------------------------------------------

# Distinct from cancel: pause is reversible. The flag stops workers at the
# same hook-points; resume restarts a fresh worker that picks up where the
# old one stopped (skipping criteria that already finished). Resume preserves
# completed Ahrefs fetches AND completed AI verdicts so the user doesn't pay
# twice for the same work after a pause.
_PAUSED_RUNS: set[int] = set()


def is_paused(run_id: int) -> bool:
    return run_id in _PAUSED_RUNS


def _clear_pause(run_id: int) -> None:
    _PAUSED_RUNS.discard(run_id)


def pause_run_now(run_id: int) -> dict:
    """Mark the run paused and signal workers to exit. Domains/criteria
    keep their current state — they'll be reset to pending when resumed."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status in ("done", "failed", "canceled"):
            return {
                "id": run_id,
                "found": True,
                "already_terminal": True,
                "status": run.status,
            }
        if run.status == "paused":
            return {"id": run_id, "found": True, "status": "paused"}
        _PAUSED_RUNS.add(run_id)
        run.status = "paused"
        db.commit()
        return {"id": run_id, "found": True, "status": "paused"}
    finally:
        db.close()


def resume_run_now(run_id: int) -> dict:
    """Clear the pause flag, reset non-terminal rows to pending (deleting
    half-written CriterionResult rows so the worker doesn't double-write),
    flip run.status to pending, and dispatch a fresh worker.

    Also clears any stale `_CANCELED_RUNS` entry. Without this, a Cancel
    issued earlier in the same process (which sets the in-memory flag
    but leaves it in place after the canceled worker exits) would short-
    circuit every domain in the freshly-dispatched resume worker, marking
    the run "done" in milliseconds with zero progress (real bug observed
    on run 41, 2026-05-07: 96ms duration, 0 CriterionResults, 35 rds
    stuck at pending). Defense-in-depth — process_run's `_clear_cancel`
    in the finally clause SHOULD have caught it eventually, but the
    sequencing made the flag still active when the resume worker checked."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status != "paused":
            return {
                "id": run_id,
                "found": True,
                "status": run.status,
                "error": "not in paused state",
            }
        _clear_pause(run_id)
        _clear_cancel(run_id)
        # Reset domains that didn't reach a terminal state.
        for d in run.domains:
            if d.status in ("running", "pending"):
                d.status = "pending"
                d.started_at = None
                d.finished_at = None
                # Drop any partial CriterionResult rows (status != done) —
                # they may have been mid-write when the pause hit. The
                # worker will recreate them. Done rows are preserved.
                still_done = [cr for cr in d.results if cr.status == "done"]
                to_delete = [cr for cr in d.results if cr.status != "done"]
                for cr in to_delete:
                    db.delete(cr)
                # SQLAlchemy needs a flush here to actually remove them
                # before we add new rows in the same session.
                d.results = still_done
        run.status = "pending"
        run.started_at = None
        run.finished_at = None
        run.error = ""
        db.commit()
    finally:
        db.close()
    # Dispatch a fresh worker outside the session.
    dispatch_run(run_id)
    return {"id": run_id, "found": True, "status": "pending"}


# --- Reanalyze (re-run AI step over existing Ahrefs data) ------------------

# Process-level dicts mapping id → in-flight asyncio.Task so the UI can
# poll the `reanalyzing` flag and disable the Reanalyze button while a
# reanalyze is in flight. Each task's `finally` clause discards its entry
# from the appropriate dict, but the readers below also self-heal by
# checking `task.done()` — if a finally clause somehow misses (e.g. task
# was abruptly cancelled mid-await with no chance to release), the next
# poll sweeps the stale entry out so the UI doesn't get permanently
# stuck on `reanalyzing: True`.
#
# We keep the original `_REANALYZING_RUNS` / `_REANALYZING_RUN_DOMAINS`
# names for `.discard()` API compatibility — only the value-type changed.
class _TaskMap(dict):
    """Dict-of-tasks with the same `discard` API as a plain set so the
    existing `_REANALYZING_*.discard(id)` callsites in `finally` blocks
    don't need to change. `add(id)` records the calling task so readers
    can detect `done()` tasks and self-heal. `__contains__` also self-
    heals — that's what powers the `is_reanalyzing_*` checks below."""
    def add_task(self, key: int, task: "asyncio.Task") -> None:
        self[key] = task

    def discard(self, key: int) -> None:
        self.pop(key, None)

    def is_active(self, key: int) -> bool:
        task = self.get(key)
        if task is None:
            return False
        if task.done():
            # Task finished without its `finally` clearing this entry —
            # treat as not-running and clean up so the next caller doesn't
            # see a phantom flag.
            self.pop(key, None)
            return False
        return True


_REANALYZING_RUNS: _TaskMap = _TaskMap()
_REANALYZING_RUN_DOMAINS: _TaskMap = _TaskMap()


def is_reanalyzing_run(run_id: int) -> bool:
    return _REANALYZING_RUNS.is_active(run_id)


def is_reanalyzing_run_domain(run_domain_id: int) -> bool:
    return _REANALYZING_RUN_DOMAINS.is_active(run_domain_id)


def reanalyze_run_now(
    run_id: int, ai_override: dict | None = None
) -> dict:
    """Schedule an AI-only re-judge of every domain in a terminal run.
    Bypasses the AI cache. Caller can pass `ai_override` (dict with
    provider/model) to override the run's stored AI spec — useful when the
    original run had `ai.provider=null`."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status in ("pending", "running", "paused"):
            return {
                "id": run_id, "found": True,
                "error": f"run is {run.status} — wait for it to finish",
            }
        if _REANALYZING_RUNS.is_active(run_id):
            return {
                "id": run_id, "found": True,
                "error": "reanalysis already in progress",
            }
        try:
            spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        except Exception as e:  # noqa: BLE001
            return {"id": run_id, "found": True, "error": f"bad spec: {e}"}
    finally:
        db.close()

    if ai_override:
        spec.ai.provider = ai_override.get("provider") or spec.ai.provider
        spec.ai.model = ai_override.get("model") or spec.ai.model
    if not spec.ai or not spec.ai.provider:
        return {
            "id": run_id, "found": True,
            "error": "no AI provider configured for this run",
        }
    # Critical: bypass the AI cache for this action.
    spec.use_cache = False

    task = asyncio.create_task(_reanalyze_run(run_id, spec))
    _REANALYZING_RUNS.add_task(run_id, task)
    _track(task)
    return {"id": run_id, "found": True, "status": "started"}


def reanalyze_run_domain_criterion_now(
    run_domain_id: int,
    criterion: str,
    ai_override: dict | None = None,
) -> dict:
    """Schedule an AI-only re-judge of a SINGLE criterion on one domain.
    Same guards as reanalyze_run_domain_now; uses the same in-flight set so
    the existing per-domain `reanalyzing` polling state covers it without
    UI plumbing changes. The other criteria's existing verdicts are kept;
    the final assessment is recomputed because it aggregates all four."""
    if criterion not in ("backlinks", "refdomains", "anchors", "keywords", "wayback", "wayback_classify"):
        return {
            "id": run_domain_id, "found": True,
            "error": f"invalid criterion: {criterion}",
        }
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return {"id": run_domain_id, "found": False}
        run = db.get(Run, rd.run_id)
        if run is None:
            return {"id": run_domain_id, "found": False}
        if run.status in ("pending", "running", "paused"):
            return {
                "id": run_domain_id, "found": True,
                "error": f"run is {run.status} — wait for it to finish",
            }
        if _REANALYZING_RUN_DOMAINS.is_active(run_domain_id):
            return {
                "id": run_domain_id, "found": True,
                "error": "reanalysis already in progress",
            }
        try:
            spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        except Exception as e:  # noqa: BLE001
            return {
                "id": run_domain_id, "found": True, "error": f"bad spec: {e}",
            }
    finally:
        db.close()

    if ai_override:
        spec.ai.provider = ai_override.get("provider") or spec.ai.provider
        spec.ai.model = ai_override.get("model") or spec.ai.model
    if not spec.ai or not spec.ai.provider:
        return {
            "id": run_domain_id, "found": True,
            "error": "no AI provider configured for this run",
        }
    spec.use_cache = False

    task = asyncio.create_task(
        _reanalyze_run_domain_criterion(
            run_domain_id, criterion, spec, track_set=True
        )
    )
    _REANALYZING_RUN_DOMAINS.add_task(run_domain_id, task)
    _track(task)
    return {"id": run_domain_id, "found": True, "status": "started"}


_ALL_CRITERIA = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify",
    # Pillar criteria (Wave 2+). Included so the retry/reanalyze path
    # picks them up; quality jobs leave these `.enabled=False` so they
    # get skipped, whois-kind/availability-kind jobs flip exactly one
    # of them on. `_reanalyze_run_domain_criterion` special-cases
    # whois_history below the way it does wayback_classify.
    "whois_history",
    # availability (2026-05-16, retry path) — same shape as
    # whois_history: pillar runner owns the per-domain cascade, retry
    # path deletes the failed CR + dispatches to the pillar runner.
    # Distinguished from whois in that NO AI is ever involved — the
    # retry-time AI-provider gate is skipped for availability-kind runs.
    "availability",
)

# Criteria that CAN consume the wayback_classify "Site context" block
# (added 2026-05-13). Whether a given criterion ACTUALLY receives it on a
# specific judge call depends on the user's Settings config — see
# `_load_classify_context`. wayback and wayback_classify never appear here
# (wayback already sees V2 samples; classify is the source, not a consumer).
_CLASSIFY_CONTEXT_ELIGIBLE_CRITERIA = frozenset(
    ("backlinks", "refdomains", "anchors", "keywords")
)


def _collect_failed_criteria(
    rd: RunDomain, spec: AnalyzeSpec
) -> list[str]:
    """Return enabled criteria on this RD that need a retry. A criterion
    counts as failed when any of these holds:
      • CR row missing entirely (e.g. run aborted before this criterion
        started — `_reanalyze_run_domain_criterion` will create + fetch),
      • CR.status == "failed" (fetch failed → refetch + re-judge),
      • CR.status in ("running", "pending") — orphaned mid-pipeline. The
        caller (`retry_failed_run_now`) only invokes this when the parent
        Run is in a terminal state (done/failed/canceled), so any CR
        still in a non-terminal status is by definition not being worked
        on (its task died, e.g. uvicorn restart mid-retry). Without this
        branch the user is stuck — the per-RD page shows "running" but
        no work is happening and the retry button silently skips it.
      • CR.ai_verdict_error != "" (fetch OK, AI judge failed → re-judge).
    Disabled criteria in the spec are never retried."""
    by_name = {cr.criterion: cr for cr in rd.results}
    failed: list[str] = []
    for c in _ALL_CRITERIA:
        cfg = _cfg_for_criterion(spec, c)
        if cfg is None or not getattr(cfg, "enabled", False):
            continue
        cr = by_name.get(c)
        if cr is None:
            failed.append(c)
            continue
        if cr.status in ("failed", "running", "pending"):
            failed.append(c)
            continue
        if cr.ai_verdict_error:
            failed.append(c)
            continue
        # Availability special case (2026-05-16): cascade may complete
        # cleanly (cr.status='done') but EVERY provider errored, leaving
        # `data_json.verdict.status='error'`. Those rows are retryable —
        # network/rate-limit problems often clear on a second pass — but
        # neither cr.status nor ai_verdict_error catches them since the
        # runner stamps 'done' once the cascade returned at all (verdict
        # 'error' is still a verdict). Look inside data_json to pick
        # them up. Verdict 'unknown' is NOT included — it's a final
        # "cascade said: can't tell" answer, retrying won't change it.
        if c == "availability" and cr.data_json:
            try:
                av_body = json.loads(cr.data_json)
            except json.JSONDecodeError:
                av_body = None
            if isinstance(av_body, dict):
                verdict = av_body.get("verdict")
                if isinstance(verdict, dict) and verdict.get("status") == "error":
                    failed.append(c)
    return failed


def _collect_resample_candidates(
    rd: RunDomain, spec: AnalyzeSpec
) -> list[str]:
    """Return `["wayback"]` if this rd's wayback CR has ≥1 V1 row (so V2
    re-sampling against the existing CDX is possible), else `[]`.

    Powers the "Re-sample V2 only" workflow added 2026-05-13. Distinct
    from `_collect_failed_criteria` — it ignores CR status entirely
    because the dominant target is a wayback CR that's `status=done`
    with rows but missing/incomplete samples (a state where the user
    needs to force V2 collection without re-paying the CDX cost). Gates
    on `wb_cfg.sample_pages` because re-sampling with that flag off
    would be a no-op that still bills an AI re-judge."""
    wb_cfg = _cfg_for_criterion(spec, "wayback")
    if wb_cfg is None or not getattr(wb_cfg, "enabled", False):
        return []
    if not getattr(wb_cfg, "sample_pages", False):
        return []
    wb_cr = next(
        (cr for cr in rd.results if cr.criterion == "wayback"), None,
    )
    if wb_cr is None or not wb_cr.data_json:
        return []
    try:
        body = json.loads(wb_cr.data_json)
    except json.JSONDecodeError:
        return []
    if not isinstance(body, dict):
        return []
    rows = body.get("wayback")
    if not isinstance(rows, list) or len(rows) == 0:
        return []
    return ["wayback"]


def _cascade_wayback_classify(
    failed_per_rd: dict[int, list[str]], spec: AnalyzeSpec
) -> None:
    """Force `wayback_classify` into the retry set on every RD where
    `wayback` is being retried, IF classify is enabled in the spec.

    Why: a wayback retry refetches CDX + (with the 2026-05-13 fix)
    re-collects V2 samples. That invalidates whatever verdict
    wayback_classify produced last time, since classify reads its input
    straight off the wayback CR's `data_json["samples"]`. Without this
    cascade, the user has to remember to check the classify box
    themselves — or worse, classify gets left with a stale verdict that
    silently no longer reflects the data on the wayback CR.

    The cascade overrides the user's allow-list on purpose: it's the
    "you can't get this wrong" safety net. The bulk-retry frontend
    surfaces this as a small note when the user has unchecked classify
    so the auto-add is visible, not a surprise.

    Idempotent — if classify is already in the list (e.g. it also
    failed independently) we leave it alone."""
    wbc_cfg = _cfg_for_criterion(spec, "wayback_classify")
    if wbc_cfg is None or not getattr(wbc_cfg, "enabled", False):
        return
    for crits in failed_per_rd.values():
        if "wayback" in crits and "wayback_classify" not in crits:
            crits.append("wayback_classify")


def retry_run_batch_now(
    run_id: int,
    run_domain_ids: list[int],
    criteria: list[str] | None = None,
    ai_override: dict | None = None,
    wayback_resample_only: bool = False,
) -> dict:
    """Retry failed criteria on a subset of RDs, optionally narrowed to
    a criterion allow-list. Sibling of `retry_failed_run_now` — same
    guards, same per-RD plumbing, narrower scope.

    `criteria=None` → every enabled criterion on the run (= same as
    retry_failed_run_now's behavior, just scoped to the picked RDs).
    `criteria=["wayback"]` → only retry wayback, even if classify also
    failed on a given RD (drives the "refetch wayback without
    re-running classify" use case).

    `wayback_resample_only=True` → instead of selecting "failed"
    criteria, target wayback CRs that have V1 rows and need V2
    re-sampling (samples missing, stale, or partial). Skips the CDX
    refetch entirely — re-samples V2 against the existing rows, then
    re-judges the wayback verdict. The classify cascade still applies,
    so classify gets re-judged off the fresh samples. Use case: the
    cohort identified by the Wayback CDX ≥1 filter + classify failed.
    Caller MUST include `"wayback"` in `criteria` (or pass `None` for
    all) — otherwise this flag has nothing to act on and we error.

    Returns the same envelope shape as retry_failed_run_now."""
    if _REANALYZING_RUNS.is_active(run_id):
        return {
            "id": run_id, "found": True,
            "error": "a run-level reanalysis is already in progress",
        }
    rd_id_set: set[int] = {int(i) for i in run_domain_ids if isinstance(i, int)}
    if not rd_id_set:
        return {"id": run_id, "found": True, "error": "no run_domain_ids"}
    criteria_set = set(criteria) if criteria else None
    if wayback_resample_only and criteria_set is not None and (
        "wayback" not in criteria_set
    ):
        return {
            "id": run_id, "found": True,
            "error": (
                "resample-only requires 'wayback' in the criteria "
                "allow-list — nothing to resample otherwise"
            ),
        }

    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status in ("pending", "running", "paused"):
            return {
                "id": run_id, "found": True,
                "error": f"run is {run.status} — wait for it to finish",
            }
        try:
            spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        except Exception as e:  # noqa: BLE001
            return {"id": run_id, "found": True, "error": f"bad spec: {e}"}
        if ai_override:
            spec.ai.provider = ai_override.get("provider") or spec.ai.provider
            spec.ai.model = ai_override.get("model") or spec.ai.model
        # Availability-pillar runs never use AI — see retry_failed_run_now
        # for the rationale and the original bug report.
        job = db.get(Job, run.job_id)
        job_kind = job.kind if job is not None else "quality"
        if job_kind != "availability" and (
            not spec.ai or not spec.ai.provider
        ):
            return {
                "id": run_id, "found": True,
                "error": "no AI provider configured for this run",
            }
        spec.use_cache = False

        # Per-RD retry list. Resample-only and the normal failed-retry
        # path use different selection criteria — see the helpers'
        # docstrings for the rationale.
        failed_per_rd: dict[int, list[str]] = {}
        for rd in run.domains:
            if rd.id not in rd_id_set:
                continue
            if wayback_resample_only:
                failed = _collect_resample_candidates(rd, spec)
            else:
                failed = _collect_failed_criteria(rd, spec)
            if criteria_set is not None:
                failed = [c for c in failed if c in criteria_set]
            if failed:
                failed_per_rd[rd.id] = failed
        _cascade_wayback_classify(failed_per_rd, spec)
    finally:
        db.close()

    if not failed_per_rd:
        return {
            "id": run_id, "found": True,
            "error": (
                "no failed criteria match the scope "
                "(selected rds × allowed criteria)"
            ),
        }
    busy = [
        rd_id for rd_id in failed_per_rd
        if _REANALYZING_RUN_DOMAINS.is_active(rd_id)
    ]
    if busy:
        return {
            "id": run_id, "found": True,
            "error": (
                f"reanalysis already in progress on {len(busy)} domain(s) — "
                "wait for it to finish"
            ),
        }
    for rd_id, crits in failed_per_rd.items():
        task = asyncio.create_task(
            _retry_failed_run_domain(
                rd_id, crits, spec, track_set=True,
                resample_only=wayback_resample_only,
            )
        )
        _REANALYZING_RUN_DOMAINS.add_task(rd_id, task)
        _track(task)
    return {
        "id": run_id, "found": True, "status": "started",
        "domains": len(failed_per_rd),
        "criteria": sum(len(v) for v in failed_per_rd.values()),
    }


def retry_failed_run_now(
    run_id: int, ai_override: dict | None = None
) -> dict:
    """Retry every failed criterion across every domain in a terminal run.
    A "failed criterion" means a fetch that errored, an AI verdict that
    errored, or a never-created CR row for an enabled criterion. Each RD
    runs its retries sequentially under one `_REANALYZING_RUN_DOMAINS`
    lock so the existing per-domain `reanalyzing` polling state covers
    progress without UI plumbing changes."""
    if _REANALYZING_RUNS.is_active(run_id):
        return {
            "id": run_id, "found": True,
            "error": "a run-level reanalysis is already in progress",
        }
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status in ("pending", "running", "paused"):
            return {
                "id": run_id, "found": True,
                "error": f"run is {run.status} — wait for it to finish",
            }
        try:
            spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        except Exception as e:  # noqa: BLE001
            return {"id": run_id, "found": True, "error": f"bad spec: {e}"}

        if ai_override:
            spec.ai.provider = ai_override.get("provider") or spec.ai.provider
            spec.ai.model = ai_override.get("model") or spec.ai.model
        # Availability-pillar runs never use AI (cascade output IS the
        # verdict). Skip the AI-provider gate for them — without this
        # branch the user's "Retry failed" on /jobs/X/runs/Y for an
        # availability job 400s with "no AI provider configured for this
        # run" even though no AI would ever be called.
        job = db.get(Job, run.job_id)
        job_kind = job.kind if job is not None else "quality"
        if job_kind != "availability" and (
            not spec.ai or not spec.ai.provider
        ):
            return {
                "id": run_id, "found": True,
                "error": "no AI provider configured for this run",
            }
        spec.use_cache = False

        # Snapshot the per-RD failed-criteria map BEFORE leaving the DB
        # session — we'll close it before scheduling tasks so the workers
        # get fresh sessions of their own.
        failed_per_rd: dict[int, list[str]] = {}
        for rd in run.domains:
            failed = _collect_failed_criteria(rd, spec)
            if failed:
                failed_per_rd[rd.id] = failed
        _cascade_wayback_classify(failed_per_rd, spec)
    finally:
        db.close()

    if not failed_per_rd:
        return {
            "id": run_id, "found": True,
            "error": "no failed criteria to retry",
        }

    # Refuse if any candidate RD is already in flight — partial dispatch
    # would leave the user wondering which domains were skipped.
    busy = [
        rd_id for rd_id in failed_per_rd
        if _REANALYZING_RUN_DOMAINS.is_active(rd_id)
    ]
    if busy:
        return {
            "id": run_id, "found": True,
            "error": (
                f"reanalysis already in progress on {len(busy)} domain(s) — "
                "wait for it to finish"
            ),
        }

    for rd_id, criteria in failed_per_rd.items():
        task = asyncio.create_task(
            _retry_failed_run_domain(rd_id, criteria, spec, track_set=True)
        )
        _REANALYZING_RUN_DOMAINS.add_task(rd_id, task)
        _track(task)

    total_criteria = sum(len(v) for v in failed_per_rd.values())
    return {
        "id": run_id, "found": True, "status": "started",
        "domains": len(failed_per_rd), "criteria": total_criteria,
    }


async def _retry_failed_run_domain(
    run_domain_id: int,
    criteria: list[str],
    spec: AnalyzeSpec,
    *,
    track_set: bool,
    resample_only: bool = False,
) -> None:
    """Run `_reanalyze_run_domain_criterion` sequentially for each failed
    criterion on this RD, holding the rd-level reanalyzing lock for the
    full duration. Sequential (not parallel) because these calls share
    the same RD's CR rows and share the rd-level lock; parallelizing
    would race the per-criterion writes and the final-assessment
    recompute.

    `resample_only` propagates to the wayback branch only (other
    criteria ignore it). The cascade ensures wayback_classify gets
    re-judged after wayback's samples land, so we don't need to pass
    the flag to the classify branch — its read of the wayback CR's
    samples picks up the fresh data automatically.

    Cancel-aware between criteria (2026-05-24): when `cancel_retry_failed_now`
    sets the cancel flag, the next iteration of this loop bails — defense
    in depth alongside the `task.cancel()` that the cancel orchestrator
    fires (task.cancel() raises CancelledError at the next await, which
    is also what bails out of `_reanalyze_run_domain_criterion`)."""
    # Resolve the parent run_id once so the cancel check below doesn't
    # need an extra DB hit per iteration.
    parent_run_id: int | None = None
    try:
        db_lookup = SessionLocal()
        try:
            rd = db_lookup.get(RunDomain, run_domain_id)
            if rd is not None:
                parent_run_id = rd.run_id
        finally:
            db_lookup.close()
    except Exception:  # noqa: BLE001
        # Don't fail the whole retry just because the cancel check
        # couldn't initialize. Workers will still respect task.cancel().
        parent_run_id = None
    try:
        for c in criteria:
            if parent_run_id is not None and is_canceled(parent_run_id):
                break
            await _reanalyze_run_domain_criterion(
                run_domain_id, c, spec, track_set=False,
                resample_only=resample_only,
            )
    except asyncio.CancelledError:
        # task.cancel() from cancel_retry_failed_now reached us. Let the
        # exception propagate AFTER we've cleaned up our reanalyzing
        # tracker entry (handled by the `finally` below).
        raise
    except Exception:  # noqa: BLE001
        log.exception(
            "retry-failed for run_domain %s failed", run_domain_id,
        )
    finally:
        if track_set:
            _REANALYZING_RUN_DOMAINS.discard(run_domain_id)


def cancel_retry_failed_now(run_id: int) -> dict:
    """Force-cancel an in-flight Retry-failed dispatch for `run_id`.

    Three-step orchestration (each step independently useful, but the
    whole sequence is what gives the user a clean "stopped" state):

    1. `request_cancel(run_id)` — sets the in-process flag so any
       cancel-aware code paths (including `_retry_failed_run_domain`'s
       between-criteria check, all the `is_canceled(...)` sites in
       `_process_domain`, and the wayback/availability auto-retry
       watchers) bail at the next checkpoint.
    2. `task.cancel()` on every tracked retry task that belongs to a
       run-domain of this run. This is what actually interrupts mid-
       await coroutines (`_reanalyze_run_domain_criterion` doesn't
       check `is_canceled` itself — historical oversight — so without
       this step a stuck HTTP fetch would keep running).
    3. Reset RDs stuck in `status='running'` to a sane terminal state
       (mirrors the manual cleanup logic used for runs 124/126 on
       2026-05-24). For each affected rd, derive the new status from
       its CR statuses: any failed → failed; all done → done; mixed →
       done as the most conservative "not running anymore" landing.

    Returns `{run_id, found, canceled_tasks, flipped_rds, status}`.
    `found=False` only when the run row itself doesn't exist; ALL other
    outcomes (no in-flight tasks, no stuck rds, …) come back with
    `found=True` and zeroed counts so the FE can render the same
    success banner regardless.
    """
    from datetime import datetime as _dt

    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}

        # Step 1: flag.
        request_cancel(run_id)

        # Step 2: cancel tracked tasks. The set may contain entries from
        # ANY run; we only cancel those whose rd belongs to this run.
        # Walk a snapshot of the items so concurrent .discard()s from
        # task `finally` blocks don't mutate during iteration.
        rd_ids_in_run = {
            rd_id for (rd_id,) in db.query(RunDomain.id)
            .filter(RunDomain.run_id == run_id)
            .all()
        }
        canceled_tasks = 0
        for rd_id, task in list(_REANALYZING_RUN_DOMAINS.items()):
            if rd_id not in rd_ids_in_run:
                continue
            if task is None or task.done():
                continue
            task.cancel()
            canceled_tasks += 1
        # The run-level reanalyze tracker may also be active (separate
        # entry point, but same cancel intent here).
        run_level_task = _REANALYZING_RUNS.get(run_id)
        if run_level_task is not None and not run_level_task.done():
            run_level_task.cancel()
            canceled_tasks += 1

        # Step 3: reset stuck-running RDs. We do this even when
        # canceled_tasks is 0 because the most common operator complaint
        # is "the page shows N running but nothing is happening" — the
        # tasks died (e.g. uvicorn restart) and we still need to clean
        # up the visible state.
        stuck = (
            db.query(RunDomain)
            .filter(RunDomain.run_id == run_id)
            .filter(RunDomain.status == "running")
            .all()
        )
        flipped = 0
        for rd in stuck:
            cr_statuses = {cr.status for cr in rd.results}
            if "failed" in cr_statuses:
                rd.status = "failed"
            elif cr_statuses and all(s == "done" for s in cr_statuses):
                rd.status = "done"
            else:
                # Mixed / nothing — most conservative landing so the row
                # doesn't show "running" indefinitely. The user can
                # re-retry later; `_collect_failed_criteria` will pick
                # up the genuine gaps correctly.
                rd.status = "done"
            if rd.finished_at is None:
                rd.finished_at = _dt.utcnow()
            flipped += 1
        if flipped:
            db.commit()
        return {
            "id": run_id,
            "found": True,
            "canceled_tasks": canceled_tasks,
            "flipped_rds": flipped,
            "status": "canceled",
        }
    finally:
        db.close()


# --- Wayback auto-retry watcher (added 2026-05-17) --------------------------
#
# Lives between process_run finalize and the manual /retry-failed endpoint.
# When a Quality run with `wayback` enabled finishes, this loop wakes up
# after a configurable delay, asks "are there any wayback-criterion
# failures worth retrying?", fires the existing per-RD retry machinery
# for them, waits for the pass to complete, and repeats until either no
# failures remain or the attempt budget is exhausted.
#
# Strictly scoped to wayback + chained wayback_classify (NOT Ahrefs /
# whois / availability) per the 2026-05-17 design call — silently
# burning Ahrefs units in the background would violate user expectations.
#
# Skip rules (locked 2026-05-17):
#   - wayback CR.status='failed'                → retry wayback (cascade
#                                                  pulls classify in)
#   - classify CR.status='failed' AND wayback
#     CR has ≥1 row                            → retry classify only
#   - classify CR.status='failed' AND wayback
#     CR has 0 rows                            → SKIP (the empty archive
#                                                  is the answer; the
#                                                  classify "no samples"
#                                                  failure is not flake)


def _wayback_cr_has_rows(cr: "CriterionResult") -> bool:
    """True iff the wayback CR completed cleanly with at least one CDX
    row. Used by the auto-retry's skip-empty-CDX rule so we don't waste
    a retry pass on a wayback_classify failure whose only fix is "the
    domain has no Wayback history" — retrying would re-emit the same
    'no samples' verdict every time."""
    if cr.status != "done":
        return False
    if not cr.data_json:
        return False
    try:
        body = json.loads(cr.data_json)
    except json.JSONDecodeError:
        return False
    if not isinstance(body, dict):
        return False
    rows = body.get("wayback")
    return isinstance(rows, list) and len(rows) > 0


def _collect_wayback_retry_candidates(
    run_id: int, spec: AnalyzeSpec,
) -> dict[int, list[str]]:
    """Stricter cousin of `_collect_failed_criteria`. Returns only
    wayback-criterion failures worth retrying — never Ahrefs / Whois /
    Availability — and skips classify failures rooted in an empty CDX
    response (see module docstring for the rule)."""
    out: dict[int, list[str]] = {}
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return out
        wb_cfg = getattr(spec.criteria, "wayback", None)
        wb_enabled = wb_cfg is not None and getattr(wb_cfg, "enabled", False)
        if not wb_enabled:
            return out
        cls_cfg = getattr(spec.criteria, "wayback_classify", None)
        cls_enabled = (
            cls_cfg is not None and getattr(cls_cfg, "enabled", False)
        )
        for rd in run.domains:
            if rd.status == "canceled":
                continue
            crs = {cr.criterion: cr for cr in rd.results}
            wb_cr = crs.get("wayback")
            cls_cr = crs.get("wayback_classify")

            retry: list[str] = []
            # Wayback fetch failure → retry; cascade handles classify.
            if wb_cr is None or wb_cr.status == "failed":
                retry.append("wayback")
                if cls_enabled:
                    retry.append("wayback_classify")
            elif cls_enabled and cls_cr is not None and cls_cr.status == "failed":
                # Classify failed but the wayback fetch is fine. Only
                # worth retrying if the wayback CR actually has rows —
                # otherwise the failure mode is "no archive history",
                # which a re-judge can't fix.
                if _wayback_cr_has_rows(wb_cr):
                    retry.append("wayback_classify")
            if retry:
                out[rd.id] = retry
        return out
    finally:
        db.close()


# Process-level set of run ids currently being auto-retried, so we don't
# double-schedule. Cleared in the loop's finally clause; lost on uvicorn
# restart (acceptable — manual retry is always available, and the next
# run kicks off its own auto-retry loop).
_AUTO_RETRY_RUNS: set[int] = set()


def is_auto_retry_active(run_id: int) -> bool:
    return run_id in _AUTO_RETRY_RUNS


def schedule_wayback_auto_retry(run_id: int) -> None:
    """Spawn the auto-retry watcher for `run_id` if Settings allow it
    and the run's spec has wayback enabled. Idempotent — does nothing
    when an auto-retry loop is already in flight for this run. Called
    from `process_run` right after `_finish_run(success=True)`."""
    if run_id in _AUTO_RETRY_RUNS:
        return
    try:
        from .app_settings import get_wayback_auto_retry_config
        cfg = get_wayback_auto_retry_config()
    except Exception:  # noqa: BLE001
        log.exception("could not read wayback_auto_retry config")
        return
    if not cfg.get("enabled") or int(cfg.get("max_attempts", 0)) <= 0:
        return

    # Read the spec ONCE here so the watcher doesn't have to (cheap, and
    # lets us bail before spawning the task when the run isn't a
    # wayback-bearing Quality run).
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return
        try:
            spec = AnalyzeSpec.model_validate(
                json.loads(run.spec_json or "{}"),
            )
        except Exception:  # noqa: BLE001
            return
    finally:
        db.close()
    wb_cfg = getattr(spec.criteria, "wayback", None)
    if wb_cfg is None or not getattr(wb_cfg, "enabled", False):
        return

    _AUTO_RETRY_RUNS.add(run_id)
    task = asyncio.create_task(
        _wayback_auto_retry_loop(run_id, spec, dict(cfg)),
    )
    _track(task)


async def _wayback_auto_retry_loop(
    run_id: int, spec: AnalyzeSpec, cfg: dict,
) -> None:
    """Sleep / scan / retry / repeat until budget is hit or no failures
    remain. Caller guarantees:
      - the run's spec has wayback enabled
      - the auto-retry Settings toggle is on
      - max_attempts > 0
      - this run is not already being auto-retried"""
    try:
        delay = float(cfg.get("initial_delay_sec", 60))
        multiplier = float(cfg.get("backoff_multiplier", 2.0))
        max_attempts = int(cfg.get("max_attempts", 3))
        for _attempt in range(max_attempts):
            await asyncio.sleep(max(0.0, delay))
            delay *= multiplier

            # Bail if the user re-ran / canceled / paused this run while
            # we were sleeping — they're driving now, get out of the way.
            if _read_run_status(run_id) not in ("done", "failed"):
                return
            # Bail if a manual run-level retry is in flight; that path
            # owns the retries from here.
            if _REANALYZING_RUNS.is_active(run_id):
                continue

            candidates = _collect_wayback_retry_candidates(run_id, spec)
            if not candidates:
                return  # nothing left to fix

            # Skip RDs already being worked on by a manual retry — partial
            # dispatch confuses both the in-flight workers and the UI.
            candidates = {
                rd_id: criteria
                for rd_id, criteria in candidates.items()
                if not _REANALYZING_RUN_DOMAINS.is_active(rd_id)
            }
            if not candidates:
                continue

            # Force use_cache=False so a flaky wayback fetch's cached row
            # doesn't get served back to us instead of re-querying CDX.
            retry_spec = spec.model_copy(deep=True)
            retry_spec.use_cache = False

            tasks: list[asyncio.Task] = []
            for rd_id, criteria in candidates.items():
                t = asyncio.create_task(
                    _retry_failed_run_domain(
                        rd_id, criteria, retry_spec, track_set=True,
                    ),
                )
                _REANALYZING_RUN_DOMAINS.add_task(rd_id, t)
                _track(t)
                tasks.append(t)
            await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:  # noqa: BLE001
        log.exception("wayback auto-retry loop crashed for run %s", run_id)
    finally:
        _AUTO_RETRY_RUNS.discard(run_id)


def reanalyze_run_domain_now(
    run_domain_id: int, ai_override: dict | None = None
) -> dict:
    """Schedule an AI-only re-judge of a single domain. Same semantics as
    reanalyze_run_now but scoped to one RunDomain."""
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return {"id": run_domain_id, "found": False}
        run = db.get(Run, rd.run_id)
        if run is None:
            return {"id": run_domain_id, "found": False}
        if run.status in ("pending", "running", "paused"):
            return {
                "id": run_domain_id, "found": True,
                "error": f"run is {run.status} — wait for it to finish",
            }
        if _REANALYZING_RUN_DOMAINS.is_active(run_domain_id):
            return {
                "id": run_domain_id, "found": True,
                "error": "reanalysis already in progress",
            }
        try:
            spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        except Exception as e:  # noqa: BLE001
            return {
                "id": run_domain_id, "found": True, "error": f"bad spec: {e}",
            }
    finally:
        db.close()

    if ai_override:
        spec.ai.provider = ai_override.get("provider") or spec.ai.provider
        spec.ai.model = ai_override.get("model") or spec.ai.model
    if not spec.ai or not spec.ai.provider:
        return {
            "id": run_domain_id, "found": True,
            "error": "no AI provider configured for this run",
        }
    spec.use_cache = False

    task = asyncio.create_task(
        _reanalyze_run_domain(run_domain_id, spec, track_set=True)
    )
    _REANALYZING_RUN_DOMAINS.add_task(run_domain_id, task)
    _track(task)
    return {"id": run_domain_id, "found": True, "status": "started"}


async def _reanalyze_run(run_id: int, spec: AnalyzeSpec) -> None:
    try:
        db = SessionLocal()
        try:
            domain_ids = [
                rd.id
                for rd in db.query(RunDomain)
                .filter(RunDomain.run_id == run_id)
                .all()
            ]
        finally:
            db.close()
        await asyncio.gather(*(
            _reanalyze_run_domain(rd_id, spec, track_set=False)
            for rd_id in domain_ids
        ))
    except Exception:  # noqa: BLE001
        log.exception("reanalyze run %s failed", run_id)
    finally:
        _REANALYZING_RUNS.discard(run_id)


async def _reanalyze_run_domain_criterion(
    run_domain_id: int,
    criterion: str,
    spec: AnalyzeSpec,
    *,
    track_set: bool,
    resample_only: bool = False,
) -> None:
    """Wipe a SINGLE criterion's AI verdict on this domain (and the final
    assessment, which aggregates all criteria), then re-judge that one
    criterion. Existing verdicts on the other criteria are reused by
    `_run_ai_for_domain` via `_existing_ai_verdicts`, so the final gets
    recomputed from new+reused sub-verdicts without paying for the others.

    If the criterion has no usable data (fetch failed previously, or the
    row was never created), this also REFETCHES from Ahrefs so the user can
    recover from a broken where-clause / API change without rerunning the
    whole job.

    Special-cased criteria: `wayback_classify` doesn't fetch — it derives
    its result from the wayback CR's V2 samples. We skip the refetch path
    entirely and call `_run_wayback_classify_for_domain` after wiping the
    targeted verdict; the function handles the rest (sample loading,
    AI calls, status flipping)."""
    try:
        db = SessionLocal()
        try:
            rd = db.get(RunDomain, run_domain_id)
            if rd is None:
                return
            domain = rd.domain
            run_id = rd.run_id
            for cr in rd.results:
                if cr.criterion != criterion:
                    continue
                cr.ai_verdict_json = ""
                cr.ai_verdict_error = ""
                cr.ai_cached_from_run_id = None
                cr.prompt_hash = ""
            # Final aggregates all criteria — must be recomputed.
            rd.final_assessment_json = ""
            rd.final_summary = ""
            db.commit()

            fetched_rows: dict[str, list[dict]] = {}
            for cr in rd.results:
                if cr.status != "done" or not cr.data_json:
                    continue
                try:
                    body = json.loads(cr.data_json)
                except json.JSONDecodeError:
                    continue
                if isinstance(body, dict):
                    for v in body.values():
                        if isinstance(v, list):
                            fetched_rows[cr.criterion] = v
                            break
        finally:
            db.close()

        # Special case: whois_history lives in the whois_history pillar
        # runner, not the Quality runner. The pillar's `_process_whois_domain`
        # does fetch + diff + AI judge in one shot. The retry path here
        # wipes the existing failed CR row first (the pillar runner
        # always creates fresh — there's no unique constraint on
        # (run_domain_id, criterion), so duplicates would otherwise
        # accumulate), then dispatches to the pillar runner with the
        # retry-time `spec` so the user's ai_override (if any) takes
        # effect without rewriting the original Run.spec_json.
        if criterion == "whois_history":
            wh_cfg = _cfg_for_criterion(spec, "whois_history")
            if wh_cfg is None or not getattr(wh_cfg, "enabled", False):
                return
            db2 = SessionLocal()
            try:
                rd2 = db2.get(RunDomain, run_domain_id)
                if rd2 is None:
                    return
                for cr in list(rd2.results):
                    if cr.criterion == "whois_history":
                        db2.delete(cr)
                # Reset rd to a pristine state so the pillar runner
                # flips it correctly. Don't touch other criteria — none
                # exist on a whois-kind run, but be defensive anyway.
                rd2.status = "pending"
                rd2.error = ""
                rd2.finished_at = None
                rd2.started_at = None
                rd2.last_analyzed_at = None
                rd2.final_assessment_json = ""
                rd2.final_summary = ""
                db2.commit()
            finally:
                db2.close()
            # Import inline to keep tasks.py decoupled from the pillar
            # module at import time (the pillar module already imports
            # from app_settings/models/ai_judge — adding a top-level
            # back-import would risk a cycle if anything in tasks.py
            # ever needed importing into the pillar runner).
            from .whois_history.runner import (
                _process_whois_domain as _process_whois_domain_retry,
            )
            spec_dict_for_retry = spec.model_dump()
            await _process_whois_domain_retry(
                run_domain_id, run_id,
                spec_override=spec_dict_for_retry,
            )
            # Roll run.status forward if every rd is now done. Same
            # bookkeeping the wayback_classify branch does — the pillar
            # runner sets rd.status itself, but the parent Run's status
            # is owned by this re-evaluator.
            _reevaluate_domain_and_run_status(run_domain_id)
            return

        # Special case: availability (2026-05-16). Mirrors whois_history
        # — pillar runner owns the cascade; retry deletes the failed CR
        # and re-runs `_process_availability_domain`. Targets both the
        # cr.status='failed' rows (cascade crashed) AND the
        # cr.status='done' + verdict='error' rows that _collect_failed_
        # criteria now picks up (cascade completed, every provider
        # errored — retrying often clears transient rate-limit /
        # network failures).
        if criterion == "availability":
            av_cfg = _cfg_for_criterion(spec, "availability")
            if av_cfg is None or not getattr(av_cfg, "enabled", False):
                return
            db_av = SessionLocal()
            try:
                rd_av = db_av.get(RunDomain, run_domain_id)
                if rd_av is None:
                    return
                for cr in list(rd_av.results):
                    if cr.criterion == "availability":
                        db_av.delete(cr)
                # Reset rd to pristine — the pillar runner stamps these
                # itself but we clear them first so the in-flight state
                # is visible immediately and a partial cascade can't
                # leave stale 'done' timestamps.
                rd_av.status = "pending"
                rd_av.error = ""
                rd_av.finished_at = None
                rd_av.started_at = None
                rd_av.last_analyzed_at = None
                db_av.commit()
            finally:
                db_av.close()
            # Inline import (avoids a top-level cycle with
            # availability_runner, which imports from .models /
            # .app_settings — same pattern as the whois_history retry).
            import httpx as _httpx
            from .availability_runner import _process_availability_domain
            async with _httpx.AsyncClient(timeout=15.0) as client:
                await _process_availability_domain(
                    run_domain_id, run_id, client,
                )
            _reevaluate_domain_and_run_status(run_domain_id)
            return

        # Special case: wayback_classify has no fetch step. Drive it
        # directly via _run_wayback_classify_for_domain (which the main
        # AI path also uses). Reuses the same provider/model + cache
        # logic as the regular flow.
        if criterion == "wayback_classify":
            wbc_cfg = _cfg_for_criterion(spec, "wayback_classify")
            if wbc_cfg is None or not getattr(wbc_cfg, "enabled", False):
                return
            if not spec.ai or not spec.ai.provider:
                return
            try:
                resolved_model = _resolve_model(
                    spec.ai.provider, spec.ai.model
                )
            except ProviderConfigError:
                return
            sub_verdicts: dict[str, dict] = {}
            await _run_wayback_classify_for_domain(
                run_domain_id=run_domain_id,
                domain=domain,
                spec=spec,
                wbc_cfg=wbc_cfg,
                provider=spec.ai.provider,
                resolved_model=resolved_model,
                cached_verdicts={},
                sub_verdicts=sub_verdicts,
                run_id=run_id,
            )
            _reevaluate_domain_and_run_status(run_domain_id)
            return

        # Refetch path: criterion had no usable data (fetch had failed, or
        # row never existed). Build the URL using the criterion's current
        # spec config and run a fresh Ahrefs request. The existing failed
        # CriterionResult row is reset in place; if there isn't one we
        # create a fresh row.
        if criterion not in fetched_rows:
            cfg = _cfg_for_criterion(spec, criterion)
            if cfg is None or not getattr(cfg, "enabled", False):
                return  # criterion not enabled in spec — nothing to fetch
            single_spec = AnalyzeSpec(
                domains=[domain], criteria=spec.criteria, ai=spec.ai
            )
            _, requests = build_preview(single_spec)
            target_req = next(
                (r for r in requests if r.criterion == criterion and r.enabled),
                None,
            )
            if target_req is None:
                return
            params_hash = compute_params_hash(criterion, cfg)
            cr_id = _reset_or_create_criterion_row(
                run_domain_id=run_domain_id,
                criterion=criterion,
                url=target_req.url,
                params_hash=params_hash,
            )
            ok, http_status, body, err, units = await _fetch_criterion(
                target_req.url, criterion=criterion,
            )
            _finish_criterion_row(cr_id, ok, http_status, body, err, units)
            if ok and isinstance(body, dict):
                for v in body.values():
                    if isinstance(v, list):
                        fetched_rows[criterion] = v
                        break
            if criterion not in fetched_rows:
                return  # fetch still failed; finish_criterion_row stored err

            # Wayback V2 sample collection on retry (added 2026-05-13).
            # Without this, a refetched wayback CR has rows but no samples —
            # the wayback verdict re-judges V1-only, AND wayback_classify
            # subsequently fails with "no samples available". Mirrors the
            # runner block at process_run_for_domain (search for "Wayback
            # V2: page-content sampling"). Guarded on ≥1 CDX row because
            # V2 has nothing to sample otherwise (see _pick_wayback_samples).
            if criterion == "wayback":
                wb_cfg = getattr(spec.criteria, "wayback", None)
                if (
                    wb_cfg is not None
                    and getattr(wb_cfg, "sample_pages", False)
                    and fetched_rows["wayback"]
                ):
                    picks = _pick_wayback_samples(
                        fetched_rows["wayback"],
                        count=wb_cfg.sample_count,
                        strategy=wb_cfg.sample_strategy,
                        path_mode=wb_cfg.sample_path_mode,
                        domain=domain,
                    )
                    if picks:
                        samples = await _fetch_wayback_samples(samples=picks)
                        _attach_wayback_samples(cr_id, samples)

        # Resample-only branch (added 2026-05-13). The refetch path above
        # didn't run because wayback's CR was already `status=done` with
        # rows in fetched_rows. The user explicitly asked us to re-collect
        # V2 anyway — the dominant trigger is a wayback CR with V1 rows
        # but missing samples that left wayback_classify failing. Skips
        # the CDX call entirely (free) and runs V2 sampling against the
        # existing rows. The cascade adds wayback_classify after this
        # criterion finishes, so classify reads the fresh samples on its
        # own re-judge pass.
        elif resample_only and criterion == "wayback":
            wb_cfg = getattr(spec.criteria, "wayback", None)
            cr_id = _criterion_row_ids(run_domain_id).get("wayback")
            if (
                cr_id is not None
                and wb_cfg is not None
                and getattr(wb_cfg, "sample_pages", False)
                and fetched_rows.get("wayback")
            ):
                picks = _pick_wayback_samples(
                    fetched_rows["wayback"],
                    count=wb_cfg.sample_count,
                    strategy=wb_cfg.sample_strategy,
                    path_mode=wb_cfg.sample_path_mode,
                    domain=domain,
                )
                if picks:
                    samples = await _fetch_wayback_samples(samples=picks)
                    _attach_wayback_samples(cr_id, samples)

        await _run_ai_for_domain(
            run_domain_id=run_domain_id,
            domain=domain,
            spec=spec,
            fetched_rows=fetched_rows,
            run_id=run_id,
        )
        # Refresh rd.status / run.status — refetch may have flipped a
        # previously-failed criterion to done, so the stale "failed" pill
        # would otherwise stick around until the next full rerun.
        _reevaluate_domain_and_run_status(run_domain_id)
    except Exception:  # noqa: BLE001
        log.exception(
            "reanalyze criterion %s for run_domain %s failed",
            criterion, run_domain_id,
        )
    finally:
        if track_set:
            _REANALYZING_RUN_DOMAINS.discard(run_domain_id)


async def _reanalyze_run_domain(
    run_domain_id: int, spec: AnalyzeSpec, *, track_set: bool
) -> None:
    """Wipe a domain's existing AI verdicts + final assessment, then re-judge
    each criterion using the (cache-disabled) spec. Loads the Ahrefs rows
    from the existing CriterionResult.data_json — no new fetches."""
    try:
        db = SessionLocal()
        try:
            rd = db.get(RunDomain, run_domain_id)
            if rd is None:
                return
            domain = rd.domain
            run_id = rd.run_id
            for cr in rd.results:
                cr.ai_verdict_json = ""
                cr.ai_verdict_error = ""
                cr.ai_cached_from_run_id = None
                # Clear prompt_hash so subsequent cache lookups won't false-
                # match against this row's stale (now-empty) verdict.
                cr.prompt_hash = ""
            rd.final_assessment_json = ""
            rd.final_summary = ""
            db.commit()

            # Reload Ahrefs rows from existing data_json — no refetch.
            fetched_rows: dict[str, list[dict]] = {}
            for cr in rd.results:
                if cr.status != "done" or not cr.data_json:
                    continue
                try:
                    body = json.loads(cr.data_json)
                except json.JSONDecodeError:
                    continue
                if isinstance(body, dict):
                    for v in body.values():
                        if isinstance(v, list):
                            fetched_rows[cr.criterion] = v
                            break
        finally:
            db.close()

        if not fetched_rows:
            return  # nothing to judge

        await _run_ai_for_domain(
            run_domain_id=run_domain_id,
            domain=domain,
            spec=spec,
            fetched_rows=fetched_rows,
            run_id=run_id,
        )
        # Same status-refresh as the per-criterion path. Reanalyze itself
        # doesn't refetch, but other reanalyze invocations on the same
        # domain may have raced — keep the pill consistent regardless.
        _reevaluate_domain_and_run_status(run_domain_id)
    except Exception:  # noqa: BLE001
        log.exception("reanalyze run_domain %s failed", run_domain_id)
    finally:
        if track_set:
            _REANALYZING_RUN_DOMAINS.discard(run_domain_id)


def cancel_run_now(run_id: int) -> dict:
    """Mark the run + all its pending domains/criteria as canceled in DB,
    and set the process-level flag so any in-progress worker exits early.

    Also clears any stale `_PAUSED_RUNS` entry for this run id — if the
    user paused then immediately canceled, the pause flag would otherwise
    persist and could short-circuit a future fresh dispatch (e.g. a
    rerun that happens to reuse the run id behavior). Defense-in-depth;
    cheap to clear.

    Critical ordering: only call `request_cancel` AFTER confirming the run
    is non-terminal. Otherwise canceling an already-terminal run leaves a
    stale flag in `_CANCELED_RUNS` (no worker will ever clear it via the
    `finally` block — the worker exited long ago). SQLite reuses deleted
    primary keys, so a stale flag for an old run id can short-circuit a
    fresh future run that gets assigned the same id (real bug observed
    2026-05-07: run 46 inherited a flag from a previous canceled-then-
    deleted run with the same id, all 35 domains short-circuited)."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"id": run_id, "found": False}
        if run.status in ("done", "failed", "canceled"):
            return {
                "id": run_id,
                "found": True,
                "already_terminal": True,
                "status": run.status,
            }
        request_cancel(run_id)
        _clear_pause(run_id)
        run.status = "canceled"
        run.finished_at = datetime.utcnow()
        if not run.error:
            run.error = "Canceled by user."
        for d in run.domains:
            if d.status in ("pending", "running"):
                d.status = "canceled"
                d.finished_at = datetime.utcnow()
                if not d.error:
                    d.error = "Canceled by user."
            for cr in d.results:
                if cr.status in ("pending", "running"):
                    cr.status = "canceled"
                    if not cr.error:
                        cr.error = "Canceled by user."
        db.commit()
        return {"id": run_id, "found": True, "status": "canceled"}
    finally:
        db.close()


# --- The worker -------------------------------------------------------------

async def process_run(run_id: int) -> None:
    """Top-level coroutine for a Run. Each step in its own DB session — no
    long-held transactions across awaits."""
    _track(asyncio.current_task())  # type: ignore[arg-type]

    # 1. Mark the run as running, load the spec.
    begun = _begin_run(run_id)
    if begun is None:
        return  # Already terminal, or row gone.
    spec, ownership_token = begun

    # 2. Fan out per-domain workers. Per-provider semaphores inside
    #    `limit("...")` bound HTTP concurrency to each upstream, but we
    #    ALSO need an outer cap on how many `_process_domain` coroutines
    #    are concurrently active — otherwise a 352-domain run schedules
    #    352 tasks on the event loop at once. Each task does small sync
    #    SQLAlchemy ops between awaits (briefly blocking the loop), holds
    #    open per-task state, and competes for the threadpool slots that
    #    serve other endpoints (Settings, Database, /health). The loop
    #    stays "live" but becomes laggy enough that Docker's healthcheck
    #    times out and the UI feels frozen (regression observed
    #    2026-05-12 on a 352-domain Wayback-only run).
    #
    #    32 is a conservative cap — for runs ≤ 32 domains it's a no-op,
    #    and at hundreds of domains it keeps the loop responsive while
    #    still saturating the per-provider rate limits (Wayback default
    #    max_concurrent=1; Ahrefs ~4; Gemini RPM 60). Each completed
    #    domain releases a slot for the next.
    OUTER_CAP = 32
    outer_sem = asyncio.Semaphore(OUTER_CAP)

    async def _run_one(rd_id: int) -> None:
        async with outer_sem:
            await _process_domain(rd_id, spec, run_id)

    domain_ids = _get_domain_ids(run_id)
    try:
        await asyncio.gather(
            *(_run_one(rd_id) for rd_id in domain_ids),
            return_exceptions=False,
        )
        # Ownership re-check (2026-05-17): status alone isn't enough.
        # SQLite reuses rowids after DELETE, so a freshly-submitted Run
        # can land on the same id as a just-deleted Run whose worker is
        # still draining. Without the started_at token compare, that
        # old worker would finalize the fresh Run — observed as Job 61
        # short-circuiting with "no work" the moment the user re-
        # submitted after a pause+delete. Status="running" passes for
        # both the stale and the fresh worker; the token doesn't.
        if not _still_owns_run(run_id, ownership_token):
            return
        # Sanity: did any domain actually start? If every `_process_domain`
        # short-circuited at the cancel/pause guard (real bug observed
        # 2026-05-07: stale cancel flag → 96ms run with 0 CriterionResults
        # incorrectly marked "done"), don't lie about success. Mark the
        # run failed with a clear, actionable error so the user knows to
        # submit a rerun rather than think this run completed normally.
        if not _any_domain_made_progress(run_id):
            _finish_run(
                run_id,
                success=False,
                error=(
                    "Run produced no work — every domain short-circuited "
                    "before starting. Most common cause is a stale Cancel "
                    "or Pause flag from an earlier run-action that wasn't "
                    "cleared. Submit a fresh rerun; if this repeats, "
                    "restart the API process to clear all in-memory flags."
                ),
            )
            return
        _finish_run(run_id, success=True, error="")
        # Wayback auto-retry — opt-in via Settings, fires only when the
        # spec has wayback enabled. The helper is a no-op when disabled
        # or when no auto-retry budget remains, so calling it
        # unconditionally is safe (and keeps the wiring tight).
        schedule_wayback_auto_retry(run_id)
    except Exception as e:  # noqa: BLE001
        log.exception("run %s failed", run_id)
        # Same race protection — only flip to failed if we still own the run.
        if _still_owns_run(run_id, ownership_token):
            _finish_run(run_id, success=False, error=f"{type(e).__name__}: {e}")
    finally:
        _clear_cancel(run_id)


# --- Step helpers, each self-contained around a session --------------------

def _begin_run(run_id: int) -> tuple[AnalyzeSpec, datetime] | None:
    """Mark the run running + return its spec AND the timestamp we just
    wrote into `started_at`. The timestamp acts as an ownership token —
    callers re-check it before finalizing so a stale worker (e.g. one
    whose run was deleted and whose run_id got reused by SQLite for a
    fresh Run) cannot clobber the new worker's status."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.status not in ("pending",):
            return None
        token = datetime.utcnow()
        run.status = "running"
        run.started_at = token
        run.error = ""
        db.commit()
        spec = AnalyzeSpec.model_validate(json.loads(run.spec_json or "{}"))
        return spec, token
    finally:
        db.close()


def _still_owns_run(run_id: int, token: datetime) -> bool:
    """True iff this worker still owns `run_id`. False once the Run row
    is gone or its `started_at` has been overwritten by a fresh
    `_begin_run` (rowid-reuse scenario). Used at every finalize point to
    refuse writes that would belong to someone else's run."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run is not None and run.started_at == token
    finally:
        db.close()


def _get_domain_ids(run_id: int) -> list[int]:
    db = SessionLocal()
    try:
        return [
            r.id
            for r in db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
        ]
    finally:
        db.close()


def _any_domain_made_progress(run_id: int) -> bool:
    """Sanity check at end of `process_run`. Returns True if at least one
    RunDomain has `started_at` set OR has any CriterionResult rows. Used
    to refuse marking a run "done" when every per-domain coroutine
    short-circuited at the cancel/pause guard — that's not success, it's
    a stuck flag, and the run should be marked failed so the user can
    submit a clean rerun."""
    db = SessionLocal()
    try:
        rds = (
            db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
        )
        for rd in rds:
            if rd.started_at is not None:
                return True
            if rd.results:
                return True
        return False
    finally:
        db.close()


def _finish_run(run_id: int, success: bool, error: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return
        # Don't trample a user-intent state (2026-05-18 fix). Sequence:
        # user clicks Pause → pause_run_now flips run.status='paused'
        # and adds run_id to _PAUSED_RUNS. The in-flight per-domain
        # workers exit at their next pause checkpoint, then
        # process_run's asyncio.gather resolves and unconditionally
        # called _finish_run(success=True) — which trample-wrote
        # status='done' over the paused state. Subsequent
        # /runs/{id}/resume then 409'd because it requires status=
        # 'paused'. Symptom on run 109: 7 done + 32 still-running + 204
        # pending RDs, yet run.status='done'. Same race applies to
        # canceled (cancel_run_now flips to 'canceled'; if the worker
        # finishes draining after that, we musn't reopen it).
        if run.status in ("paused", "canceled"):
            return
        run.status = "done" if success else "failed"
        run.finished_at = datetime.utcnow()
        if error:
            run.error = error
        db.commit()

        # Coverage audit (2026-05-24) — see _audit_missing_cr_coverage's
        # docstring. Only runs on success=True finalizations; failure
        # paths already surface RD-level failure via the workers' own
        # error stamping. Wrapped in try/except so an audit bug can
        # never block the run finalization itself.
        if success:
            try:
                _audit_missing_cr_coverage(run_id, db)
            except Exception:  # noqa: BLE001
                log.exception(
                    "coverage audit failed for run %s — finalization "
                    "succeeded but rd.status may not reflect missing CRs",
                    run_id,
                )
    finally:
        db.close()


def _audit_missing_cr_coverage(run_id: int, db: Session) -> None:
    """Detect "silently incomplete" RDs and flip them done → failed.

    A Quality run can legitimately complete with `run.status='done'`
    while individual RDs are missing CR rows for criteria the spec
    enabled — historically because a pillar-only criterion
    (whois_history / availability) slipped into the Quality spec
    (the runner's per-domain loop never dispatched them), more rarely
    because an exception inside `_process_domain` aborted the per-
    criterion loop before reaching the missing one.

    Without this audit the run page reads "8 done · 1 failed" even
    when 75 RDs are silently missing whois — operator hits Retry-
    failed thinking 1 RD needs work, gets 80+ RDs dispatched. Surfacing
    the gap as `rd.status='failed'` makes the run page count match
    reality so the operator's mental model lines up with what Retry-
    failed will actually do.

    Expected criteria by job kind:
      quality       → enabled criteria from the Quality runner's
                      universe (backlinks/refdomains/anchors/keywords/
                      wayback/wayback_classify). whois_history +
                      availability are EXCLUDED even when present in the
                      spec — fix B at submit blocks new ones, and old
                      Quality specs with them on shouldn't get blanket-
                      failed retroactively (they're a spec bug, not an
                      execution bug).
      whois_history → {"whois_history"} only.
      availability  → {"availability"} only.

    Audit complexity: O(num_rds) DB query for RDs + O(num_crs) for CRs +
    O(num_rds × |expected|) check. For 100k RD runs this is ~1s. We do
    one bulk RunDomain query + one bulk CriterionResult query rather
    than walking the lazy `rd.results` relationship per row (would be
    N+1).
    """
    run = db.get(Run, run_id)
    if run is None or not run.spec_json:
        return
    try:
        spec = AnalyzeSpec.model_validate(json.loads(run.spec_json))
    except Exception:  # noqa: BLE001
        return

    job = db.get(Job, run.job_id) if run.job_id else None
    job_kind = (job.kind if job is not None else None) or "quality"

    if job_kind == "quality":
        # Limit to the criteria the Quality runner actually dispatches.
        # Pillar-only ones (whois_history/availability) are intentionally
        # excluded — see docstring.
        quality_universe = (
            "backlinks", "refdomains", "anchors", "keywords",
            "wayback", "wayback_classify",
        )
        expected = {
            c for c in quality_universe
            if (getattr(spec.criteria, c, None) is not None)
            and getattr(getattr(spec.criteria, c), "enabled", False)
        }
    elif job_kind == "whois_history":
        wh = getattr(spec.criteria, "whois_history", None)
        expected = {"whois_history"} if (wh and wh.enabled) else set()
    elif job_kind == "availability":
        av = getattr(spec.criteria, "availability", None)
        expected = {"availability"} if (av and av.enabled) else set()
    else:
        expected = set()

    if not expected:
        return

    rds = (
        db.query(RunDomain)
        .filter(RunDomain.run_id == run_id)
        .all()
    )
    rd_ids = [rd.id for rd in rds]
    if not rd_ids:
        return

    # Pull CR (rd_id, criterion) pairs in one shot rather than touching
    # rd.results per row. Only criterion + rd_id needed for the audit.
    cr_pairs = (
        db.query(CriterionResult.run_domain_id, CriterionResult.criterion)
        .filter(CriterionResult.run_domain_id.in_(rd_ids))
        .all()
    )
    present_by_rd: dict[int, set[str]] = {rd_id: set() for rd_id in rd_ids}
    for rd_id_, criterion_ in cr_pairs:
        present_by_rd.setdefault(rd_id_, set()).add(criterion_)

    flipped = 0
    for rd in rds:
        if rd.status != "done":
            # Don't touch pending/running/failed/canceled — they have
            # other invariants and the user might be acting on them.
            continue
        missing = expected - present_by_rd.get(rd.id, set())
        if not missing:
            continue
        rd.status = "failed"
        marker = (
            "coverage audit: missing CR rows for enabled criteria: "
            + ", ".join(sorted(missing))
        )
        rd.error = (
            f"{rd.error}; {marker}" if rd.error else marker
        )
        flipped += 1
    if flipped:
        db.commit()
        log.info(
            "coverage audit on run %s flipped %d done→failed RDs "
            "(expected criteria: %s)",
            run_id, flipped, sorted(expected),
        )


# --- Per-domain worker ------------------------------------------------------

def _cfg_for_criterion(spec: AnalyzeSpec, criterion: str):
    """Return the per-criterion config object out of `spec.criteria` so we
    can hash it for the cache."""
    return getattr(spec.criteria, criterion, None)


def _resolve_job_id(run_id: int) -> int | None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.job_id if run else None
    finally:
        db.close()


def _try_serve_data_from_cache(
    *,
    run_domain_id: int,
    domain: str,
    criterion: str,
    params_hash: str,
    job_id: int | None,
    run_id: int,
) -> tuple[int, int | None, list[dict]] | None:
    """Hand back data from a prior matching run if the params hash matches.
    Returns (cr_id, source_run_id, rows) on hit, None on miss.

    `job_id`: int → only this job; None → cross-job (any prior run)."""
    db = SessionLocal()
    try:
        src = lookup_cached_data(
            db,
            job_id=job_id,
            domain=domain,
            criterion=criterion,
            params_hash=params_hash,
            exclude_run_id=run_id,
        )
        if src is None:
            return None
        src_id = src.id
    finally:
        db.close()
    return _create_cached_criterion_row(
        run_domain_id=run_domain_id,
        criterion=criterion,
        params_hash=params_hash,
        source_cr_id=src_id,
    )


def _create_cached_criterion_row(
    *,
    run_domain_id: int,
    criterion: str,
    params_hash: str,
    source_cr_id: int,
) -> tuple[int, int | None, list[dict]] | None:
    """Copy a prior `done` CriterionResult into a fresh row on the new run.
    Returns (cr_id, source_run_id, rows_for_ai). The new row is marked as
    served from cache via `cached_from_run_id`. Caller has already verified
    `spec.use_cache` is on. Returns None if the source row vanished between
    lookup and copy (race-safe)."""
    db = SessionLocal()
    try:
        src = db.get(CriterionResult, source_cr_id)
        if src is None:
            return None
        src_rd = db.get(RunDomain, src.run_domain_id)
        source_run_id = src_rd.run_id if src_rd else None
        cr = CriterionResult(
            run_domain_id=run_domain_id,
            criterion=criterion,
            request_url=src.request_url,
            status="done",
            http_status=src.http_status,
            fetched_at=src.fetched_at,
            data_json=src.data_json,
            params_hash=params_hash,
            cached_from_run_id=source_run_id,
        )
        db.add(cr)
        db.commit()
        rows: list[dict] = []
        if cr.data_json:
            try:
                body = json.loads(cr.data_json)
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict):
                for v in body.values():
                    if isinstance(v, list):
                        rows = v
                        break
        return cr.id, source_run_id, rows
    finally:
        db.close()


async def _run_availability_for_domain(
    run_domain_id: int, domain: str, run_id: int,
) -> None:
    """Run the availability cascade for one domain, persist history
    rows, apply the skip-registered policy + auto-upsert the
    BacklogDomain row (approach-2 → approach-1 bridge).

    Idempotent: safe to call after pause/resume; the cascade's own
    cache TTL prevents double-fetching the same domain.
    """
    from datetime import date as _date
    from .availability import check_availability_async
    from .availability.common import STATUS_REGISTERED
    from .app_settings import get_skip_registered_policy
    from .models import RunDomain

    result = await check_availability_async(domain, run_id=run_id)

    # Approach-1↔approach-2 bridge — write expiration/registrar back to
    # the BacklogDomain row. Helper extracted 2026-05-17 so the
    # standalone Availability pillar runner shares the same code path.
    from .availability.backlog_upsert import upsert_backlog_expiration
    upsert_backlog_expiration(domain, result.expires_on, result.registrar)

    # Skip policy: registered + expires beyond horizon → no Ahrefs.
    policy = get_skip_registered_policy()
    if (
        policy["enabled"]
        and result.status == STATUS_REGISTERED
        and result.expires_on is not None
    ):
        horizon = _date.today() + timedelta(days=policy["horizon_days"])
        if result.expires_on > horizon:
            db = SessionLocal()
            try:
                rd = db.get(RunDomain, run_domain_id)
                if rd is not None:
                    rd.status = "done"
                    rd.finished_at = datetime.utcnow()
                    rd.skip_reason = (
                        f"registered, expires {result.expires_on.isoformat()}"
                    )
                    db.commit()
            finally:
                db.close()


async def _process_domain(
    run_domain_id: int, spec: AnalyzeSpec, run_id: int
) -> None:
    """Mark domain running, build per-criterion request URLs, fetch each,
    persist results, then (if AI is enabled) judge each criterion + a final
    assessment. A failure in one criterion does not abort the others.

    Cancellation: checked between each fetch and before the AI step. If the
    run was canceled mid-flight, the worker stops cleanly and `cancel_run_now`
    will have already marked the remaining domains/criteria as canceled.

    AI failures are recorded in `ai_verdict_error` but do NOT fail the run —
    the user still has the raw Ahrefs data, and they can rerun later with
    fixed credentials. This matters because AI provider outages shouldn't
    invalidate a costly Ahrefs fetch."""
    if is_canceled(run_id) or is_paused(run_id):
        return
    # Already finished in a previous worker iteration (e.g. pause+resume) —
    # nothing to redo.
    domain_status = _get_domain_status(run_domain_id)
    if domain_status in ("done", "failed", "canceled"):
        return
    domain = _begin_domain(run_domain_id)
    if domain is None:
        return

    # Availability cascade (added 2026-05-12). Runs BEFORE Ahrefs/Wayback
    # so the skip-registered policy can short-circuit expensive fetches
    # for domains that don't drop within the user's horizon. Only fires
    # when `spec.check_availability` is true — opt-in per-run via the
    # Analyze page checkbox.
    if getattr(spec, "check_availability", False):
        try:
            await _run_availability_for_domain(
                run_domain_id=run_domain_id,
                domain=domain,
                run_id=run_id,
            )
            # _run_availability_for_domain may set RunDomain.skip_reason
            # + status='done'. Re-check status to bail out cleanly.
            post_status = _get_domain_status(run_domain_id)
            if post_status in ("done", "failed", "canceled"):
                return
        except Exception as e:  # noqa: BLE001
            # Availability cascade must not block analysis on errors —
            # mark + log, then continue with Ahrefs/Wayback as if it
            # had run. The Errors page picks up the exception via the
            # log handler.
            import logging
            logging.getLogger(__name__).exception(
                "availability cascade failed for %s in run %s: %s",
                domain, run_id, e,
            )

    # Map of already-completed criteria for this domain — used to skip
    # refetching after a resume. Key = criterion name, value = (cr_id, rows).
    already_done = _completed_criteria(run_domain_id)

    # Build the URLs for THIS specific domain (build_preview only emits the
    # first one; reuse the same builder by calling it with a one-element list).
    single_spec = AnalyzeSpec(
        domains=[domain], criteria=spec.criteria, ai=spec.ai
    )
    _, requests = build_preview(single_spec)

    any_failed = False
    # Track the rows per criterion in memory so the AI step doesn't need a
    # round-trip back to the DB.
    fetched_rows: dict[str, list[dict]] = {}

    # Cache scope:
    #   • `cache_enabled` gates whether we look up at all (`use_cache` flag).
    #   • `cache_job_scope` controls what we look up:
    #       - int  → only this job (default, per-job cache locked 2026-05-06)
    #       - None → cross-job cache, ANY prior run with matching params
    #         (opt-in via `cross_job_cache` — Database-page entry point).
    cache_enabled = spec.use_cache
    if spec.cross_job_cache:
        cache_job_scope: int | None = None
    else:
        cache_job_scope = _resolve_job_id(run_id) if cache_enabled else None

    for req in requests:
        if not req.enabled:
            continue
        if is_canceled(run_id) or is_paused(run_id):
            return
        # Resume idempotency: if this criterion already completed in a
        # previous (paused) worker, reuse those rows for the AI step and
        # skip the Ahrefs fetch entirely.
        if req.criterion in already_done:
            cached_rows = already_done[req.criterion]
            fetched_rows[req.criterion] = cached_rows
            # V2 sample-resume: if the user paused/canceled in the narrow
            # window between CDX-done and sampling-done, the existing
            # CriterionResult row has rows but no `samples` key. Re-run the
            # snapshot picker on resume so the run actually finishes with
            # the configured sampling. Cheap to detect; sampling itself
            # has its own pause/cancel checks.
            if req.criterion == "wayback":
                wb_cfg = getattr(spec.criteria, "wayback", None)
                if (
                    wb_cfg is not None
                    and getattr(wb_cfg, "sample_pages", False)
                    and not is_canceled(run_id)
                    and not is_paused(run_id)
                ):
                    cr_id_existing = _criterion_row_ids(
                        run_domain_id
                    ).get("wayback")
                    if cr_id_existing is not None and not _load_wayback_samples(
                        cr_id_existing
                    ):
                        picks = _pick_wayback_samples(
                            cached_rows,
                            count=wb_cfg.sample_count,
                            strategy=wb_cfg.sample_strategy,
                            path_mode=wb_cfg.sample_path_mode,
                            domain=domain,
                        )
                        if picks:
                            samples = await _fetch_wayback_samples(
                                samples=picks
                            )
                            _attach_wayback_samples(cr_id_existing, samples)
            continue
        # Per-job cache: when the spec hash matches a prior run's row, copy
        # data forward without hitting Ahrefs. The user opted into this via
        # `spec.use_cache` (default on) — they can disable it from the
        # rerun banner to force a fresh fetch.
        cfg = _cfg_for_criterion(spec, req.criterion)
        params_hash = (
            compute_params_hash(req.criterion, cfg) if cfg is not None else ""
        )
        if cache_enabled and params_hash and (
            cache_job_scope is not None or spec.cross_job_cache
        ):
            cached = _try_serve_data_from_cache(
                run_domain_id=run_domain_id,
                domain=domain,
                criterion=req.criterion,
                params_hash=params_hash,
                job_id=cache_job_scope,
                run_id=run_id,
            )
            if cached is not None:
                _, _, rows = cached
                fetched_rows[req.criterion] = rows
                continue
        cr_id = _create_criterion_row(
            run_domain_id, req.criterion, req.url, params_hash
        )
        ok, http_status, body, err, units = await _fetch_criterion(
            req.url, criterion=req.criterion,
        )
        _finish_criterion_row(cr_id, ok, http_status, body, err, units)
        if ok and isinstance(body, dict):
            for v in body.values():
                if isinstance(v, list):
                    fetched_rows[req.criterion] = v
                    break
        if not ok:
            any_failed = True
            continue
        # Wayback V2: page-content sampling. Runs only on a fresh CDX fetch
        # (cache hits already carry samples from the source row's data_json,
        # since `_create_cached_criterion_row` copies data_json wholesale).
        # Slow — adds 1–3s per pick under the `wayback` rate limit — so we
        # check cancel/pause before and during. Sampling failures don't fail
        # the criterion: the CDX rows are already persisted and the AI step
        # gets whatever samples we did manage to pull.
        if req.criterion == "wayback":
            wb_cfg = getattr(spec.criteria, "wayback", None)
            if (
                wb_cfg is not None
                and getattr(wb_cfg, "sample_pages", False)
                and not is_canceled(run_id)
                and not is_paused(run_id)
            ):
                cdx_rows = fetched_rows.get("wayback", [])
                picks = _pick_wayback_samples(
                    cdx_rows,
                    count=wb_cfg.sample_count,
                    strategy=wb_cfg.sample_strategy,
                    path_mode=wb_cfg.sample_path_mode,
                    domain=domain,
                )
                if picks:
                    samples = await _fetch_wayback_samples(samples=picks)
                    _attach_wayback_samples(cr_id, samples)

    # wayback_classify is enabled — make sure its CR row exists before the
    # AI step. The row is non-fetching (no URL); it just acts as a slot to
    # persist the classify verdict + propagate status to the criteria pill.
    # Status starts "pending" — the AI step flips it to done/failed.
    wbc_cfg = getattr(spec.criteria, "wayback_classify", None)
    if wbc_cfg is not None and wbc_cfg.enabled:
        existing_ids = _criterion_row_ids(run_domain_id)
        if "wayback_classify" not in existing_ids:
            # params_hash must be the real classify-config hash (added
            # 2026-05-13 with Option 1) so the cross-job verdict cache can
            # match prior classify CRs that share the same language_mode.
            # Previously stored as "" which made every cache lookup miss.
            wbc_params_hash = compute_params_hash(
                "wayback_classify", wbc_cfg,
            )
            cr_id_wbc = _create_criterion_row(
                run_domain_id, "wayback_classify", "", wbc_params_hash,
            )
            # _create_criterion_row defaults status to "running" — flip
            # back to pending until the AI step actually starts on it.
            _set_criterion_status(cr_id_wbc, "pending")

    # AI step — skip if no provider selected or if Ahrefs failed for everything.
    ai_provider = (spec.ai.provider if spec.ai else None) if spec.ai else None
    if (
        ai_provider
        and ai_provider in AI_PROVIDERS
        and (fetched_rows or (wbc_cfg is not None and wbc_cfg.enabled))
        and not is_canceled(run_id)
        and not is_paused(run_id)
    ):
        await _run_ai_for_domain(
            run_domain_id=run_domain_id,
            domain=domain,
            spec=spec,
            fetched_rows=fetched_rows,
            run_id=run_id,
        )

    if is_canceled(run_id) or is_paused(run_id):
        return
    _finish_domain(run_domain_id, success=not any_failed)


async def _judge_one_criterion(
    *,
    criterion: str,
    rows: list[dict],
    run_domain_id: int,
    domain: str,
    spec: AnalyzeSpec,
    provider: str,
    model_override: str | None,
    resolved_model_for_hash: str,
    cr_id_by_criterion: dict[str, int],
    cached_verdicts: dict[str, dict],
    sub_verdicts: dict[str, dict],
    cache_enabled: bool,
    cache_job_scope: int | None,
    classify_ctx_config: dict,
    run_id: int,
) -> None:
    """Judge a single criterion (wayback or one of B/D/A/K) and write
    the verdict into both `sub_verdicts` (in-memory, for downstream
    phases) and the CR row (persistent).

    Idempotent: returns early when the CR row is missing, in a `failed`
    state from the fetch step, already has a verdict in `cached_verdicts`
    (resume idempotency), or is served by the cross-job AI verdict cache.
    Each early-return path still populates `sub_verdicts[criterion]` from
    the cached source so downstream phases see the verdict regardless.

    Reads classify_context from `sub_verdicts.get("wayback_classify")`
    when `criterion` is in `_CLASSIFY_CONTEXT_ELIGIBLE_CRITERIA` AND the
    user's classify-context Settings include this criterion. Caller is
    responsible for ensuring Phase 2 has run before invoking this for
    a context-eligible criterion."""
    cr_id = cr_id_by_criterion.get(criterion)
    if cr_id is None:
        return
    # Defensive: skip AI judge when the criterion's CR row is in a failed
    # state. The fetch loop excludes failed criteria from `fetched_rows`
    # (they're never added when ok=False), so this is normally unreachable
    # — it's a guard for future restructures (e.g. someone changes the
    # resume/refetch path to populate fetched_rows pre-validation). If a
    # wayback fetch errored we explicitly do NOT want to send the wayback
    # judge prompt to the AI; same goes for any criterion.
    if _criterion_status(cr_id) == "failed":
        return

    # Build classify_context BEFORE the cache-key check so the
    # fields_sent sentinel correctly diverges from no-context hashes.
    # See drop_sherlock_ai_pipeline.md (memory) for why: prompt_hash
    # doesn't include the user_message, so we MUST also mutate the
    # fields_sent list when the user_message gains a new block —
    # otherwise the cache will serve stale verdicts judged without
    # the context. Wayback + classify-itself never receive context;
    # only the configured Ahrefs criteria do.
    classify_context_for_ai: dict | None = None
    if criterion in _CLASSIFY_CONTEXT_ELIGIBLE_CRITERIA:
        classify_context_for_ai = _load_classify_context(
            run_domain_id, criterion, sub_verdicts, classify_ctx_config,
        )
    fields_sent = AI_FIELD_TRIM.get(criterion, [])
    if classify_context_for_ai is not None:
        # Sentinel encodes the sorted set of context field NAMES so
        # changing the Settings field-set in any way invalidates the
        # cache. Field VALUES don't go into the sentinel — that would
        # bust the cache per-domain (the whole point is per-criterion
        # cache namespaces, not per-domain).
        sentinel = "classify_context:" + ",".join(
            sorted(classify_context_for_ai.keys())
        )
        fields_sent = list(fields_sent) + [sentinel]

    # Already judged in a prior worker — reuse and skip the API call.
    if criterion in cached_verdicts:
        sub_verdicts[criterion] = cached_verdicts[criterion]
        return

    system_prompt = localize_prompt(get_ai_prompt(criterion), spec.lang)
    prompt_hash = compute_prompt_hash(
        system_prompt,
        provider,
        resolved_model_for_hash,
        fields_sent=fields_sent,
    )
    # Per-job AI cache: identical Ahrefs params + identical prompt +
    # identical provider/model → reuse the prior verdict. Editing the
    # prompt in Settings or switching provider/model busts this cache.
    if cache_enabled and (
        cache_job_scope is not None or spec.cross_job_cache
    ):
        params_hash = _get_criterion_params_hash(cr_id)
        verdict = _try_serve_verdict_from_cache(
            cr_id=cr_id,
            domain=domain,
            criterion=criterion,
            params_hash=params_hash,
            prompt_hash=prompt_hash,
            job_id=cache_job_scope,
            run_id=run_id,
        )
        if verdict is not None:
            sub_verdicts[criterion] = verdict
            return

    trimmed = _trim_rows_for_ai(criterion, rows)
    # Wayback V2: fold in any page-content samples that the fetch step
    # (or a cache copy from a prior run) attached to data_json. The AI
    # judge sees them alongside the CDX rows and can reason about
    # title-over-time drift. Non-wayback criteria pass None and the
    # builder skips the samples block entirely.
    wayback_samples_for_ai: list[dict] | None = None
    if criterion == "wayback":
        raw_samples = _load_wayback_samples(cr_id)
        if raw_samples:
            wayback_samples_for_ai = _trim_samples_for_ai(raw_samples)
    user_msg = _build_user_message_for_criterion(
        criterion=criterion,
        domain=domain,
        rows=trimmed,
        wayback_samples=wayback_samples_for_ai,
        classify_context=classify_context_for_ai,
    )
    # Resolve the model up-front so we can persist it on the row no
    # matter which branch wins below. If the provider has no usable
    # model, judge() would raise ProviderConfigError anyway — we do
    # the same here, just earlier, and record the empty model on the
    # failure row.
    try:
        resolved_model = _resolve_model(provider, model_override)
    except ProviderConfigError as e:
        log.warning("AI verdict failed for run_domain=%s criterion=%s: %s",
                    run_domain_id, criterion, e)
        _store_ai_verdict(
            cr_id, None, error=f"{type(e).__name__}: {e}",
            prompt_hash=prompt_hash,
            provider=provider, model=model_override or "",
        )
        return
    try:
        async with limit(provider):
            parsed, _raw, usage = await judge(
                provider=provider,
                system_prompt=system_prompt,
                user_message=user_msg,
                model_override=resolved_model,
            )
        sub_verdicts[criterion] = parsed
        _store_ai_verdict(
            cr_id, parsed, error="",
            prompt_hash=prompt_hash,
            provider=provider, model=resolved_model,
            usage=usage,
        )
    except (ProviderConfigError, ProviderError, ValueError) as e:
        log.warning("AI verdict failed for run_domain=%s criterion=%s: %s",
                    run_domain_id, criterion, e)
        _store_ai_verdict(
            cr_id, None, error=f"{type(e).__name__}: {e}",
            prompt_hash=prompt_hash,
            provider=provider, model=resolved_model,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("AI verdict crashed for run_domain=%s criterion=%s",
                      run_domain_id, criterion)
        _store_ai_verdict(
            cr_id, None, error=f"unexpected: {e!r}",
            prompt_hash=prompt_hash,
            provider=provider, model=resolved_model,
        )


async def _run_ai_for_domain(
    *,
    run_domain_id: int,
    domain: str,
    spec: AnalyzeSpec,
    fetched_rows: dict[str, list[dict]],
    run_id: int,
) -> None:
    """For each successfully-fetched criterion, judge it; then combine the
    sub-verdicts into a final assessment and persist on the RunDomain.

    Ordering (v2, 2026-05-13): three explicit phases, no flags, no
    duplicate call sites.

      Phase 1 — wayback judge (if wayback was fetched).
      Phase 2 — wayback_classify (if enabled in spec).
      Phase 3 — Ahrefs B/D/A/K judges, each reading classify_context
                from sub_verdicts (populated by Phase 2).

    The earlier v1 design tried to do the same with a single for-loop
    over (wayback, B, D, A, K) plus an inline classify call at the
    bottom of the wayback iteration + a fallback after the loop. That
    broke whenever wayback's AI verdict was cache-hit: the iteration
    `continue`d past the inline classify call, B/A/K then judged
    without context, and the fallback block fired classify too late.
    Splitting into phases makes each phase's cache short-circuit only
    affect that phase's judge call — it cannot skip the next phase."""
    assert spec.ai and spec.ai.provider
    provider = spec.ai.provider
    model_override = spec.ai.model
    # CRITICAL: hash the RESOLVED model, not the raw override. When the
    # user leaves the model field blank, spec.ai.model is None and the
    # runner resolves it to the provider's Settings default at call time.
    # If we hash with the raw None we get false cache hits across runs
    # whose actual API call used different models because Settings changed
    # in between (real bug observed 2026-05-06: runs 26 and 27 of job 18
    # had spec.ai.model=None on both, but the actual judge calls used
    # gemini-2.5-flash and gemma-4-26b-a4b-it respectively — and the
    # per-criterion cache wrongly hit).
    resolved_model_for_hash = _resolve_model(provider, model_override)
    sub_verdicts: dict[str, dict] = {}

    # Per-criterion judges. CriterionResult rows already exist (created in
    # the fetch loop); we look them up by run_domain_id + criterion so we
    # can write the verdict into the same row.
    cr_id_by_criterion = _criterion_row_ids(run_domain_id)
    # Resume idempotency: reuse any AI verdicts that were saved in a prior
    # (paused) worker. Saves tokens + time.
    cached_verdicts = _existing_ai_verdicts(run_domain_id)

    # Same scope semantics as the data cache (see `_process_domain` for
    # the full comment). cross_job_cache=True → look anywhere; default →
    # this job only.
    cache_enabled = spec.use_cache
    if spec.cross_job_cache:
        cache_job_scope: int | None = None
    else:
        cache_job_scope = _resolve_job_id(run_id) if cache_enabled else None

    # Classify-context config: loaded once per domain. Drives whether the
    # B/A/K (and optionally refdomains) judges receive a "Site context"
    # block built from wayback_classify's verdict. Default ON in Settings,
    # default criteria scope = B/A/K (refdomains off by default).
    from .app_settings import get_classify_context_config
    classify_ctx_config = get_classify_context_config()

    judge_kwargs = dict(
        run_domain_id=run_domain_id,
        domain=domain,
        spec=spec,
        provider=provider,
        model_override=model_override,
        resolved_model_for_hash=resolved_model_for_hash,
        cr_id_by_criterion=cr_id_by_criterion,
        cached_verdicts=cached_verdicts,
        sub_verdicts=sub_verdicts,
        cache_enabled=cache_enabled,
        cache_job_scope=cache_job_scope,
        classify_ctx_config=classify_ctx_config,
        run_id=run_id,
    )

    # Phase 1 — wayback judge. Self-contained: any cache hit only
    # short-circuits this judge, never Phase 2 or 3.
    if "wayback" in fetched_rows and not is_canceled(run_id) and not is_paused(run_id):
        await _judge_one_criterion(
            criterion="wayback", rows=fetched_rows["wayback"], **judge_kwargs,
        )

    if is_canceled(run_id) or is_paused(run_id):
        if cr_id_by_criterion:
            _stamp_last_analyzed(run_domain_id)
        return

    # Phase 2 — wayback_classify. Fires unconditionally when configured
    # in the spec, regardless of how Phase 1 resolved (fresh judge,
    # cache-hit, resume-cached, or skipped because wayback wasn't
    # fetched). When wayback wasn't fetched / produced no samples,
    # classify still runs and reports its "no samples" failure rather
    # than silently being skipped — preserves the v1 fallback behavior.
    wbc_cfg = getattr(spec.criteria, "wayback_classify", None)
    if wbc_cfg is not None and wbc_cfg.enabled:
        await _run_wayback_classify_for_domain(
            run_domain_id=run_domain_id,
            domain=domain,
            spec=spec,
            wbc_cfg=wbc_cfg,
            provider=provider,
            resolved_model=resolved_model_for_hash,
            cached_verdicts=cached_verdicts,
            sub_verdicts=sub_verdicts,
            run_id=run_id,
        )

    if is_canceled(run_id) or is_paused(run_id):
        if cr_id_by_criterion:
            _stamp_last_analyzed(run_domain_id)
        return

    # Phase 3 — Ahrefs B/D/A/K judges. Each reads classify_context from
    # sub_verdicts (populated by Phase 2). Cache hits inside this loop
    # are safe — there's nothing left that depends on inter-phase
    # ordering.
    for criterion in ("backlinks", "refdomains", "anchors", "keywords"):
        if criterion not in fetched_rows:
            continue
        if is_canceled(run_id) or is_paused(run_id):
            if cr_id_by_criterion:
                _stamp_last_analyzed(run_domain_id)
            return
        await _judge_one_criterion(
            criterion=criterion, rows=fetched_rows[criterion], **judge_kwargs,
        )

    # Partial-result detection (added 2026-05-06): if ANY enabled criterion
    # didn't produce an AI verdict (judge failed, JSON parse failed, data
    # fetch failed earlier), do NOT compute the final score and do NOT call
    # the synth AI — both would be based on incomplete data and silently
    # mislead the user (compute_final renormalizes weights over only the
    # criteria that succeeded). Instead persist a stub the UI can render
    # as a clear "Partial — N of M succeeded · Reanalyze to retry."
    enabled_criteria = [
        c
        for c in (
            "backlinks", "refdomains", "anchors", "keywords",
            "wayback", "wayback_classify",
        )
        if getattr(getattr(spec.criteria, c, None), "enabled", False)
    ]
    failed_in_ai = [c for c in enabled_criteria if c not in sub_verdicts]
    succeeded_in_ai = [c for c in enabled_criteria if c in sub_verdicts]
    if failed_in_ai:
        if not _existing_final_assessment(run_domain_id):
            partial_stub = {
                "partial": True,
                "succeeded": succeeded_in_ai,
                "failed": failed_in_ai,
                "provider": provider,
                # No model recorded — synth never ran. Reanalyze writes a
                # fresh model/provider when it succeeds.
                "model": "",
                "summary": "",
                "recommendation": "",
            }
            _store_final_assessment(run_domain_id, partial_stub, "")
        if cr_id_by_criterion:
            _stamp_last_analyzed(run_domain_id)
        return

    if not sub_verdicts:
        # Defensive: no enabled criteria at all (shouldn't happen — the
        # submit endpoint rejects this — but don't crash if it does).
        if cr_id_by_criterion:
            _stamp_last_analyzed(run_domain_id)
        return
    # Resume idempotency: if a final was already produced, don't redo it.
    if _existing_final_assessment(run_domain_id):
        return
    final_prompt = localize_prompt(get_ai_prompt("final"), spec.lang)
    user_msg = _build_user_message_for_final(
        domain=domain, sub_verdicts=sub_verdicts
    )
    # Defaults for the early-error / judge-raised paths so the args we pass
    # to _store_final_assessment are always defined.
    final_usage: dict[str, int] | None = None
    try:
        final_resolved_model = _resolve_model(provider, model_override)
    except ProviderConfigError as e:
        log.warning("Final AI assessment failed for run_domain=%s: %s",
                    run_domain_id, e)
        final_resolved_model = ""
        parsed = {}
    else:
        try:
            async with limit(provider):
                parsed, _raw, final_usage = await judge(
                    provider=provider,
                    system_prompt=final_prompt,
                    user_message=user_msg,
                    model_override=final_resolved_model,
                )
        except Exception as e:  # noqa: BLE001
            log.warning("Final AI assessment failed for run_domain=%s: %s",
                        run_domain_id, e)
            parsed = {}
    # Override the AI's `final` field with our deterministic computation
    # (LLMs are bad at arithmetic — the user's prompt explicitly asks them
    # to compute a weighted average and they routinely get it wrong). Keep
    # the AI's `summary` and `recommendation` prose; replace the math.
    if not isinstance(parsed, dict):
        parsed = {}
    from .app_settings import get_scoring_config
    score, mean_conf = compute_final(
        sub_verdicts, weights=get_scoring_config()["weights"]
    )
    if score is not None:
        parsed["final"] = round(score, 1)
    if mean_conf is not None:
        parsed["confidence"] = round(mean_conf, 3)
    # Stamp provenance inline so the per-domain page + Database can show
    # "judged by github_models / gpt-4o-mini" without joining tables.
    if provider:
        parsed["provider"] = provider
    if final_resolved_model:
        parsed["model"] = final_resolved_model
    final_label = str(parsed.get("final") or "").strip()
    if score is not None or parsed:
        _store_final_assessment(
            run_domain_id, parsed, final_label,
            usage=final_usage,
            provider=provider,
            model=final_resolved_model,
        )


def _build_user_message_for_criterion(
    *,
    criterion: str,
    domain: str,
    rows: list[dict],
    wayback_samples: list[dict] | None = None,
    classify_context: dict | None = None,
) -> str:
    """Compact JSON payload sent to the model. The system prompt does the
    heavy explanation; the user message stays short to save tokens.

    `wayback_samples` is V2 page-content data (title + headings + body
    excerpt per archived snapshot). When present + non-empty + criterion
    is wayback, an extra "Page samples (JSON)" section is appended so
    the AI can reason about year-over-year theme drift on top of the
    CDX activity rows. Other criteria ignore the parameter.

    `classify_context` is the projected wayback_classify verdict (theme,
    category, language, ...) — see `_load_classify_context`. When non-None,
    a "Site context (Wayback classify)" block is appended so the judge
    can detect PBN-style theme mismatches (e.g. backlinks from gambling
    domains pointing at a pet-care site). Caller is responsible for
    deciding whether this criterion should receive context per the
    Settings config — this builder just renders what it's given."""
    parts = [
        f"Domain: {domain}",
        f"Criterion: {criterion}",
        f"Row count: {len(rows)}",
        f"Rows (JSON):\n{json.dumps(rows, ensure_ascii=False)}",
    ]
    if criterion == "wayback" and wayback_samples:
        parts.append(
            f"Page samples (JSON, chronological):"
            f"\n{json.dumps(wayback_samples, ensure_ascii=False)}"
        )
    if classify_context:
        parts.append(
            f"Site context (Wayback classify, JSON):"
            f"\n{json.dumps(classify_context, ensure_ascii=False)}"
        )
    return "\n".join(parts) + "\n"


def _build_user_message_for_final(
    *, domain: str, sub_verdicts: dict[str, dict]
) -> str:
    return (
        f"Domain: {domain}\n"
        f"Sub-verdicts (JSON):\n{json.dumps(sub_verdicts, ensure_ascii=False)}\n"
    )


async def _run_wayback_classify_for_domain(
    *,
    run_domain_id: int,
    domain: str,
    spec: AnalyzeSpec,
    wbc_cfg,
    provider: str,
    resolved_model: str,
    cached_verdicts: dict[str, dict],
    sub_verdicts: dict[str, dict],
    run_id: int,
) -> None:
    """Drive the wayback_classify pipeline for one domain.

    Reads V2 page samples from the wayback CR row, calls the classify
    helpers in `wayback_classify.py`, persists the merged verdict on the
    wayback_classify CR row, and pushes the result into `sub_verdicts`
    so the partial-result detection (and any future final-synth caller)
    sees it like every other criterion.

    Resume idempotency: if `cached_verdicts` already has a
    `wayback_classify` entry (the runner reuses verdicts saved in a prior
    paused worker), we skip the AI calls and just propagate the cached
    verdict into `sub_verdicts`.

    Cross-job AI verdict cache (wired 2026-05-13 — was a no-op until then):
    when `spec.use_cache` is on and a prior classify CR exists for this
    domain with matching `params_hash + prompt_hash` (per-job by default,
    cross-job when `spec.cross_job_cache=True`), the verdict is copied
    forward via `_try_serve_verdict_from_cache` — no AI calls. Same
    machinery the regular per-criterion loop uses for B/D/A/K/wayback.

    `params_hash` for classify is derived from `language_mode` only —
    no fetch-side params to hash. `prompt_hash` covers BOTH chained
    prompts (combined/theme + category) so editing either invalidates.
    """
    # Find / create the CR row for wayback_classify on this rd. Pass the
    # real params_hash so cache lookups can match — see comment in
    # _process_domain's classify CR creation site (added 2026-05-13).
    rd_crs = _criterion_row_ids(run_domain_id)
    cr_id = rd_crs.get("wayback_classify")
    wbc_params_hash = compute_params_hash("wayback_classify", wbc_cfg)
    if cr_id is None:
        cr_id = _create_criterion_row(
            run_domain_id, "wayback_classify", "", wbc_params_hash,
        )

    # Resume: reuse a verdict saved in a prior paused worker.
    if "wayback_classify" in cached_verdicts:
        sub_verdicts["wayback_classify"] = cached_verdicts["wayback_classify"]
        _set_criterion_status(cr_id, "done")
        return

    # Cross-job AI verdict cache lookup (added 2026-05-13). Brings classify
    # to parity with B/D/A/K/wayback — when the user re-runs analysis on
    # domains that already have a classify verdict in another job (e.g.
    # "Analyze selected" from the Database page with `cross_cache=1`),
    # the prior verdict is copied forward without re-paying for the 2 AI
    # calls. The cache key includes BOTH chained prompts (primary +
    # category) hashed together, so editing either prompt invalidates.
    language_mode = getattr(wbc_cfg, "language_mode", "ai")
    primary_prompt_key = (
        "wayback_classify_theme_only"
        if language_mode == "library"
        else "wayback_classify_combined"
    )
    primary_prompt = localize_prompt(
        get_ai_prompt(primary_prompt_key), spec.lang,
    )
    category_prompt = localize_prompt(
        get_ai_prompt("wayback_category"), spec.lang,
    )
    # Encode the category prompt's hash into `fields_sent` as a sentinel
    # so changing it busts the cache without needing to extend
    # compute_prompt_hash's signature.
    import hashlib as _hashlib
    category_prompt_hash = _hashlib.sha256(
        category_prompt.encode("utf-8"),
    ).hexdigest()
    wbc_prompt_hash = compute_prompt_hash(
        primary_prompt,
        provider,
        resolved_model,
        fields_sent=[f"wayback_category:{category_prompt_hash}"],
    )
    cache_enabled = bool(spec.use_cache)
    if cache_enabled:
        if spec.cross_job_cache:
            cache_job_scope: int | None = None
        else:
            cache_job_scope = _resolve_job_id(run_id)
        verdict_from_cache = _try_serve_verdict_from_cache(
            cr_id=cr_id,
            domain=domain,
            criterion="wayback_classify",
            params_hash=wbc_params_hash,
            prompt_hash=wbc_prompt_hash,
            job_id=cache_job_scope,
            run_id=run_id,
        )
        if verdict_from_cache is not None:
            sub_verdicts["wayback_classify"] = verdict_from_cache
            _set_criterion_status(cr_id, "done")
            return

    # Find the wayback CR row + its samples. Failing here surfaces a
    # readable error so the user knows to enable Wayback or wait for it
    # to finish (auto-enable should have handled this at submit, but we
    # check defensively).
    wb_cr_id = rd_crs.get("wayback")
    if wb_cr_id is None:
        _store_ai_verdict(
            cr_id, None,
            error=(
                "wayback_classify needs the wayback criterion enabled — "
                "no wayback CR row exists for this domain"
            ),
            provider=provider, model=resolved_model,
        )
        _set_criterion_status(cr_id, "failed")
        return
    samples = _load_wayback_samples(wb_cr_id)
    if not samples:
        _store_ai_verdict(
            cr_id, None,
            error=(
                "wayback_classify needs Wayback V2 page samples — none on "
                "the wayback CR row. Enable Wayback page sampling and "
                "rerun (Settings → Wayback config), or wait for an "
                "in-flight wayback fetch to finish."
            ),
            provider=provider, model=resolved_model,
        )
        _set_criterion_status(cr_id, "failed")
        return

    _set_criterion_status(cr_id, "running")
    from .wayback_classify import classify_wayback_for_domain
    try:
        verdict, usages = await classify_wayback_for_domain(
            domain=domain,
            samples=samples,
            language_mode=getattr(wbc_cfg, "language_mode", "ai"),
            provider=provider,
            resolved_model=resolved_model,
            judge_limit_ctx=limit,
            lang=spec.lang,
        )
    except (ProviderConfigError, ProviderError, ValueError) as e:
        log.warning(
            "wayback_classify failed for run_domain=%s: %s",
            run_domain_id, e,
        )
        _store_ai_verdict(
            cr_id, None, error=f"{type(e).__name__}: {e}",
            provider=provider, model=resolved_model,
        )
        _set_criterion_status(cr_id, "failed")
        return
    except Exception as e:  # noqa: BLE001
        log.exception(
            "wayback_classify crashed for run_domain=%s", run_domain_id,
        )
        _store_ai_verdict(
            cr_id, None, error=f"unexpected: {e!r}",
            provider=provider, model=resolved_model,
        )
        _set_criterion_status(cr_id, "failed")
        return

    # Aggregate token usage from the chained calls (combined/theme +
    # category) into one usage dict so the cost columns reflect the
    # whole pipeline.
    total_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0}
    for u in usages:
        total_usage["input_tokens"] += int(u.get("input_tokens") or 0)
        total_usage["output_tokens"] += int(u.get("output_tokens") or 0)

    _store_ai_verdict(
        cr_id, verdict, error="",
        prompt_hash=wbc_prompt_hash,
        provider=provider, model=resolved_model,
        usage=total_usage,
    )
    _set_criterion_status(cr_id, "done")
    sub_verdicts["wayback_classify"] = verdict


def _criterion_row_ids(run_domain_id: int) -> dict[str, int]:
    db = SessionLocal()
    try:
        rows = (
            db.query(CriterionResult)
            .filter(CriterionResult.run_domain_id == run_domain_id)
            .all()
        )
        return {r.criterion: r.id for r in rows}
    finally:
        db.close()


def _load_classify_context(
    run_domain_id: int,
    criterion: str,
    sub_verdicts: dict[str, dict],
    config: dict,
) -> dict | None:
    """Build the classify-context dict that should be appended to a
    criterion's user message. Returns None when:

    - The classify-context feature is disabled in Settings.
    - This criterion is not in the configured criterion scope (e.g.
      refdomains is OFF by default — judge stays plain for refdomains).
    - wayback_classify hasn't produced a verdict on this rd yet (failed,
      pending, or not enabled in spec). We deliberately read from
      `sub_verdicts` (the in-memory map built by _run_ai_for_domain)
      rather than the CR row so the v1 sequencing (wayback → classify
      → B/D/A/K) sees the just-judged classify verdict without an extra
      DB hit. A future caller (e.g. preview) can pass `sub_verdicts={}`
      and fall back to the DB read path below.
    - The verdict has none of the configured fields (e.g. classify
      didn't produce a primary_theme).

    The dict is keyed by the SETTINGS-configured fields, in the
    Settings-canonical order. Fields not present in the verdict are
    skipped. Empty strings / empty lists are preserved so the AI can
    see "language was detected as und" vs "no language info"."""
    if not config.get("enabled"):
        return None
    if criterion not in (config.get("criteria") or ()):
        return None
    fields = config.get("fields") or ()
    if not fields:
        return None

    verdict: dict | None = sub_verdicts.get("wayback_classify")
    if not isinstance(verdict, dict):
        # Fallback: read directly from the classify CR row. Used by the
        # AI preview path (not the runner) — the runner always has the
        # in-memory sub_verdicts populated by the time B/A/K judge.
        db = SessionLocal()
        try:
            cr = (
                db.query(CriterionResult)
                .filter(
                    CriterionResult.run_domain_id == run_domain_id,
                    CriterionResult.criterion == "wayback_classify",
                )
                .one_or_none()
            )
            if cr is None or not cr.ai_verdict_json:
                return None
            try:
                verdict = json.loads(cr.ai_verdict_json)
            except json.JSONDecodeError:
                return None
        finally:
            db.close()
    if not isinstance(verdict, dict):
        return None

    projected: dict = {}
    for f in fields:
        if f in verdict:
            projected[f] = verdict[f]
    return projected if projected else None


def _get_domain_status(run_domain_id: int) -> str:
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        return rd.status if rd else "missing"
    finally:
        db.close()


def _read_run_status(run_id: int) -> str:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.status if run else "missing"
    finally:
        db.close()


def _completed_criteria(run_domain_id: int) -> dict[str, list[dict]]:
    """For resume: returns {criterion: rows} for criteria already fetched
    successfully in a prior (paused) run. Empty for first-time runs."""
    db = SessionLocal()
    try:
        rows = (
            db.query(CriterionResult)
            .filter(
                CriterionResult.run_domain_id == run_domain_id,
                CriterionResult.status == "done",
            )
            .all()
        )
        out: dict[str, list[dict]] = {}
        for r in rows:
            if not r.data_json:
                continue
            try:
                body = json.loads(r.data_json)
            except json.JSONDecodeError:
                continue
            if isinstance(body, dict):
                for v in body.values():
                    if isinstance(v, list):
                        out[r.criterion] = v
                        break
        return out
    finally:
        db.close()


def _existing_ai_verdicts(run_domain_id: int) -> dict[str, dict]:
    """For resume: returns {criterion: parsed_verdict} for criteria that
    already have a saved AI verdict. Empty for first-time runs."""
    db = SessionLocal()
    try:
        rows = (
            db.query(CriterionResult)
            .filter(CriterionResult.run_domain_id == run_domain_id)
            .all()
        )
        out: dict[str, dict] = {}
        for r in rows:
            if not r.ai_verdict_json:
                continue
            try:
                out[r.criterion] = json.loads(r.ai_verdict_json)
            except json.JSONDecodeError:
                pass
        return out
    finally:
        db.close()


def _existing_final_assessment(run_domain_id: int) -> dict | None:
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None or not rd.final_assessment_json:
            return None
        try:
            return json.loads(rd.final_assessment_json)
        except json.JSONDecodeError:
            return None
    finally:
        db.close()


def _reevaluate_domain_and_run_status(run_domain_id: int) -> None:
    """After a reanalyze (per-criterion or full-domain), re-derive rd.status
    from its CriterionResult rows so the UI's status pill reflects reality.
    Same logic as the original `_finish_domain`: any failed criterion → rd
    failed; otherwise → rd done. If flipping rd to "done" makes EVERY rd in
    the run also "done", flip run.status too (only ever forward, never
    backward — we don't reopen a "done" run as "failed" here)."""
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return
        # Don't touch domains in non-terminal states — the runner owns them.
        if rd.status not in ("done", "failed"):
            return
        any_failed = any(cr.status == "failed" for cr in rd.results)
        new_status = "failed" if any_failed else "done"
        if new_status != rd.status:
            rd.status = new_status
            if new_status == "done":
                rd.error = ""
            db.commit()

        run = db.get(Run, rd.run_id)
        if run is None:
            return
        if run.status != "failed":
            return  # only ever flip failed → done
        all_done = all(d.status == "done" for d in run.domains)
        if all_done:
            run.status = "done"
            run.error = ""
            db.commit()
    finally:
        db.close()


def _stamp_last_analyzed(run_domain_id: int) -> None:
    """Update RunDomain.last_analyzed_at to now. Called after any AI write
    (fresh judge, reanalyze, or cache-hit copy). Distinct from finished_at,
    which represents the original run completion."""
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return
        rd.last_analyzed_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def _compute_ai_cost_usd(
    provider: str, model: str, input_tokens: int, output_tokens: int
) -> float:
    """Look up the (provider, model) pricing row and return $ cost for one
    call. Returns 0.0 when no row exists — the run's `missing_pricing`
    list will surface the gap so the user knows their total is incomplete.

    Locked-in semantics: caller stores the returned value on the row
    immediately; later edits to the price table do NOT recompute it."""
    if not provider or not model or (input_tokens <= 0 and output_tokens <= 0):
        return 0.0
    from .app_settings import get_model_price
    price = get_model_price(provider, model)
    if price is None:
        return 0.0
    in_rate, out_rate = price
    return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000.0


def _store_ai_verdict(
    cr_id: int,
    parsed: dict | None,
    error: str,
    *,
    prompt_hash: str = "",
    provider: str = "",
    model: str = "",
    usage: dict[str, int] | None = None,
) -> None:
    """Write AI verdict + token/cost accounting in one transaction. `usage`
    is the dict returned by `ai_judge.judge()` (`{input_tokens,
    output_tokens}`); caller already swallowed exceptions so this just
    persists what's known. `usage=None` (judge failed before returning,
    or pre-feature callsite) leaves the token columns at their existing
    values — fail-soft, no zeroing."""
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        if cr is None:
            return
        if parsed is not None:
            cr.ai_verdict_json = json.dumps(parsed, ensure_ascii=False)
            cr.ai_verdict_error = ""
        else:
            cr.ai_verdict_json = ""
            cr.ai_verdict_error = error
        if prompt_hash:
            cr.prompt_hash = prompt_hash
        # Always overwrite — even on failure we want to know which provider
        # we tried; clearing only happens when caller passes empty strings.
        cr.ai_provider = provider or ""
        cr.ai_model = model or ""
        if usage is not None:
            in_tok = int(usage.get("input_tokens") or 0)
            out_tok = int(usage.get("output_tokens") or 0)
            cr.ai_input_tokens = in_tok
            cr.ai_output_tokens = out_tok
            cr.ai_cost_usd = _compute_ai_cost_usd(
                provider or "", model or "", in_tok, out_tok
            )
        db.commit()
    finally:
        db.close()


def _get_criterion_params_hash(cr_id: int) -> str:
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        return (cr.params_hash or "") if cr else ""
    finally:
        db.close()


def _set_criterion_status(cr_id: int, status: str) -> None:
    """Mutate CriterionResult.status — used by wayback_classify which has
    no fetch step, so we manage status transitions explicitly."""
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        if cr is None:
            return
        cr.status = status
        if status == "done" and cr.fetched_at is None:
            cr.fetched_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


def _criterion_status(cr_id: int) -> str:
    """Read CriterionResult.status by id. Used by the AI judge loop to
    skip rows whose fetch errored (defensive — `fetched_rows` already
    excludes failed criteria upstream)."""
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        return (cr.status or "") if cr else ""
    finally:
        db.close()


def _try_serve_verdict_from_cache(
    *,
    cr_id: int,
    domain: str,
    criterion: str,
    params_hash: str,
    prompt_hash: str,
    job_id: int | None,
    run_id: int,
) -> dict | None:
    """Copy a prior matching AI verdict into the current CriterionResult row.
    Returns the parsed verdict on hit, None on miss.

    `job_id`: int → only this job; None → cross-job lookup."""
    if not params_hash or not prompt_hash:
        return None
    db = SessionLocal()
    try:
        src = lookup_cached_verdict(
            db,
            job_id=job_id,
            domain=domain,
            criterion=criterion,
            params_hash=params_hash,
            prompt_hash=prompt_hash,
            exclude_run_id=run_id,
        )
        if src is None:
            return None
        try:
            parsed = json.loads(src.ai_verdict_json)
        except json.JSONDecodeError:
            return None
        src_rd = db.get(RunDomain, src.run_domain_id)
        source_run_id = src_rd.run_id if src_rd else None
        cur = db.get(CriterionResult, cr_id)
        if cur is None:
            return None
        cur.ai_verdict_json = src.ai_verdict_json
        cur.ai_verdict_error = ""
        cur.prompt_hash = prompt_hash
        cur.ai_cached_from_run_id = source_run_id
        # Carry over provenance from the source row so the UI shows which
        # provider/model originally produced this verdict, not the one
        # that just looked it up.
        cur.ai_provider = src.ai_provider or ""
        # Carry over token counts (visibility into "tokens reused") but
        # set $ cost to 0 — we didn't actually pay for this verdict on
        # this run. Run-level cost totals reflect only fresh-call spend.
        cur.ai_input_tokens = src.ai_input_tokens
        cur.ai_output_tokens = src.ai_output_tokens
        cur.ai_cost_usd = 0.0
        cur.ai_model = src.ai_model or ""
        # Mark the host run-domain as analyzed-now: from the user's POV
        # this row just got an AI verdict. The original timestamp is still
        # recoverable via ai_cached_from_run_id → source row.
        rd_for_cur = db.get(RunDomain, cur.run_domain_id)
        if rd_for_cur is not None:
            rd_for_cur.last_analyzed_at = datetime.utcnow()
        db.commit()
        return parsed
    finally:
        db.close()


def _store_final_assessment(
    run_domain_id: int, parsed: dict, final_label: str,
    *,
    usage: dict[str, int] | None = None,
    provider: str = "",
    model: str = "",
) -> None:
    """Persist the final synth output + (optionally) its token/cost. Pass
    `usage` as the dict from `ai_judge.judge()`; pass `provider`/`model`
    so we can resolve pricing. Skip those args (or `usage=None`) for
    partial-run stubs and resume idempotency paths — the row's existing
    final_*_tokens / final_cost_usd values are left alone."""
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return
        rd.final_assessment_json = json.dumps(parsed, ensure_ascii=False)
        # `final_summary` is a denormalized short label so the summary table
        # query can read it directly without parsing JSON per row.
        if final_label in ("quality", "mixed", "low_quality"):
            rd.final_summary = final_label
        else:
            rd.final_summary = ""
        if usage is not None:
            in_tok = int(usage.get("input_tokens") or 0)
            out_tok = int(usage.get("output_tokens") or 0)
            rd.final_input_tokens = in_tok
            rd.final_output_tokens = out_tok
            rd.final_cost_usd = _compute_ai_cost_usd(
                provider, model, in_tok, out_tok
            )
        # Stamp the AI-completion time. `finished_at` stays put (it's the
        # original run-completion); `last_analyzed_at` is the answer to
        # "when did AI most recently touch this domain?".
        rd.last_analyzed_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


# --- Per-run scoring-weights override (added 2026-05-13 wave J) -------------
#
# These helpers power `POST /runs/{id}/preview-final` (pure recompute, no
# writes), `POST /runs/{id}/recompute-final` (persist override + rewrite
# every rd's final_assessment_json), and the DELETE form (clear override +
# recompute with current global weights). Sub-verdicts are read once per
# rd from the CR table — those rows are NEVER touched by the override
# logic, only the rd-level final-assessment columns are.

SCORING_CRITERIA: tuple[str, ...] = (
    "backlinks", "refdomains", "anchors", "keywords",
    "wayback", "wayback_classify",
)


def _collect_sub_verdicts_for_rd(rd_id: int) -> dict[str, dict]:
    """Read the per-criterion AI verdicts saved on a RunDomain so we can
    re-feed them into `compute_final` with different weights. Skips rows
    whose `ai_verdict_json` is empty or unparseable — those criteria
    simply won't contribute to the recomputed score, exactly like the
    original synth path."""
    out: dict[str, dict] = {}
    db = SessionLocal()
    try:
        rows = (
            db.query(CriterionResult)
            .filter(CriterionResult.run_domain_id == rd_id)
            .all()
        )
        for r in rows:
            if not r.ai_verdict_json:
                continue
            try:
                parsed = json.loads(r.ai_verdict_json)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                out[r.criterion] = parsed
        return out
    finally:
        db.close()


def _bucket_for_score(
    score: float | None, good_threshold: float, mixed_threshold: float,
) -> str:
    """Mirror of the Database router's `_bucket_for` — kept local so the
    recompute path doesn't have to import from a routers module."""
    if score is None:
        return ""
    if score >= good_threshold:
        return "quality"
    if score >= mixed_threshold:
        return "mixed"
    return "low_quality"


def recompute_run_finals(
    run_id: int,
    weights: dict[str, float] | None,
    *,
    preview: bool,
) -> dict:
    """Recompute final scores for every non-partial RunDomain in `run_id`
    using the supplied `weights` (or current global Settings if None).
    When `preview=False`, also persists the result: each rd's
    `final_assessment_json.final`/`confidence` and `final_summary` are
    rewritten, and the Run's `scoring_override_json` is set to the
    supplied weights (or cleared when `weights is None`).

    Partial rds (whose existing `final_assessment_json` is the
    `{"partial": true, ...}` stub from a failed AI pipeline) are left
    untouched — recomputing them would invent a score from incomplete
    data. They appear in the returned table with `partial=true` so the
    UI can render an em-dash.

    Returns a summary dict with the per-domain old→new score table and
    the effective weights actually applied (so the caller has a single
    authoritative copy to render)."""
    from .app_settings import get_scoring_config

    scoring = get_scoring_config()
    effective_weights = (
        dict(weights) if weights is not None
        else dict(scoring.get("weights") or {})
    )
    good_t = float(scoring.get("good_threshold") or 70.0)
    mixed_t = float(scoring.get("mixed_threshold") or 40.0)

    rows_out: list[dict] = []
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            raise LookupError(f"run {run_id} not found")
        rds = (
            db.query(RunDomain)
            .filter(RunDomain.run_id == run_id)
            .order_by(RunDomain.id)
            .all()
        )
        for rd in rds:
            old_parsed: dict | None = None
            if rd.final_assessment_json:
                try:
                    old_parsed = json.loads(rd.final_assessment_json)
                except json.JSONDecodeError:
                    old_parsed = None
            old_score = None
            if isinstance(old_parsed, dict):
                ov = old_parsed.get("final")
                if isinstance(ov, (int, float)) and not isinstance(ov, bool):
                    old_score = float(ov)

            is_partial = bool(
                isinstance(old_parsed, dict) and old_parsed.get("partial")
            )
            if is_partial:
                rows_out.append({
                    "run_domain_id": rd.id,
                    "domain": rd.domain,
                    "score_old": old_score,
                    "score_new": None,
                    "confidence_new": None,
                    "bucket_new": "",
                    "partial": True,
                })
                continue

            sub_verdicts = _collect_sub_verdicts_for_rd(rd.id)
            new_score, new_conf = compute_final(
                sub_verdicts, weights=effective_weights or None,
            )
            new_score_rounded = (
                round(new_score, 1) if new_score is not None else None
            )
            new_conf_rounded = (
                round(new_conf, 3) if new_conf is not None else None
            )
            new_bucket = _bucket_for_score(new_score, good_t, mixed_t)
            rows_out.append({
                "run_domain_id": rd.id,
                "domain": rd.domain,
                "score_old": old_score,
                "score_new": new_score_rounded,
                "confidence_new": new_conf_rounded,
                "bucket_new": new_bucket,
                "partial": False,
            })

            if not preview and isinstance(old_parsed, dict):
                # Mutate in place — keep the AI's prose (summary,
                # recommendation, provider, model) and replace just the
                # numeric fields. compute_final's renormalization makes
                # missing-criterion behavior identical to weight=0.
                if new_score_rounded is not None:
                    old_parsed["final"] = new_score_rounded
                else:
                    old_parsed.pop("final", None)
                if new_conf_rounded is not None:
                    old_parsed["confidence"] = new_conf_rounded
                else:
                    old_parsed.pop("confidence", None)
                rd.final_assessment_json = json.dumps(
                    old_parsed, ensure_ascii=False,
                )
                rd.final_summary = (
                    new_bucket if new_bucket in (
                        "quality", "mixed", "low_quality"
                    ) else ""
                )

        if not preview:
            if weights is None:
                run.scoring_override_json = ""
            else:
                run.scoring_override_json = json.dumps(
                    {"weights": effective_weights}, ensure_ascii=False,
                )
            db.commit()
        return {
            "run_id": run_id,
            "preview": preview,
            "weights_applied": effective_weights,
            "override_active": (
                not preview and weights is not None
            ) or (
                preview and weights is not None
            ),
            "rows": rows_out,
        }
    finally:
        db.close()


# --- Russian translation of final-assessment prose (2026-05-13 wave K) -----
#
# One-shot bulk translation triggered from the Database page. Translates
# ONLY `summary` and `recommendation` (the long prose) — per-criterion
# `key_findings` / `red_flags` arrays are intentionally left in English
# per the user's scope. Idempotent: skips rds that already have a
# `final_assessment_ru_json` populated, or whose prose is already in
# Russian (Cyrillic-ratio heuristic).

_TRANSLATE_SYSTEM_PROMPT = (
    "You are a professional translator. Translate the given English "
    "text fields to Russian, preserving SEO and link-building "
    "terminology naturally (e.g. \"backlinks\" → \"бэклинки\", "
    "\"anchor text\" → \"анкорный текст\", \"domain rating\" → "
    "\"рейтинг домена\"). Keep the same tone and length. If a field's "
    "text is already in Russian, return it unchanged. Output a single "
    "JSON object with EXACTLY two string keys: \"summary\" and "
    "\"recommendation\". Do not add commentary, markdown, or any other "
    "keys."
)


def _cyrillic_ratio(s: str) -> float:
    """Fraction of alphabetic chars in `s` that are Cyrillic. Used to
    short-circuit translation when the prose is already in Russian (or
    mostly so — covers the mixed Russian/English case from prompt drift
    where the AI sometimes leaks an English phrase into a RU verdict)."""
    if not s:
        return 0.0
    letters = sum(1 for c in s if c.isalpha())
    if letters == 0:
        return 0.0
    cyr = sum(1 for c in s if "Ѐ" <= c <= "ӿ")
    return cyr / letters


async def translate_final_for_rd(rd_id: int) -> dict:
    """Translate one rd's `final_assessment_json.summary` and
    `.recommendation` to Russian and persist in `final_assessment_ru_json`.
    Idempotent.

    Returns `{status, error}` where status is one of:
      - "translated" — wrote a fresh translation
      - "skipped"    — already translated / already Russian / nothing to
                       translate (no JSON, partial stub, empty prose)
      - "failed"     — provider error, parse error, etc.
    """
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, rd_id)
        if rd is None:
            return {"status": "failed", "error": "rd not found"}
        if rd.final_assessment_ru_json:
            return {"status": "skipped", "error": None}
        if not rd.final_assessment_json:
            return {"status": "skipped", "error": None}
        try:
            parsed = json.loads(rd.final_assessment_json)
        except json.JSONDecodeError:
            return {"status": "failed", "error": "final_assessment_json parse"}
        if not isinstance(parsed, dict):
            return {"status": "failed", "error": "final not a dict"}
        if parsed.get("partial"):
            # Partial stubs have no prose to translate.
            return {"status": "skipped", "error": None}

        summary = str(parsed.get("summary") or "")
        recommendation = str(parsed.get("recommendation") or "")
        if not summary.strip() and not recommendation.strip():
            return {"status": "skipped", "error": None}

        # Already Russian? Mirror the original into the _ru slot so future
        # reads short-circuit; no API call needed.
        if _cyrillic_ratio(summary + recommendation) >= 0.5:
            rd.final_assessment_ru_json = rd.final_assessment_json
            db.commit()
            return {"status": "skipped", "error": None}

        # Provider + model: prefer the rd's own verdict provenance so we
        # translate with the same model that originally synthesized the
        # prose (consistent terminology and tone). Fall back to the run's
        # spec.ai if the rd doesn't carry provider info.
        provider = str(parsed.get("provider") or "")
        model = str(parsed.get("model") or "")
        if not provider:
            run = db.get(Run, rd.run_id)
            if run is not None and run.spec_json:
                try:
                    spec_dict = json.loads(run.spec_json)
                    ai_cfg = (spec_dict or {}).get("ai") or {}
                    provider = ai_cfg.get("provider") or ""
                    model = ai_cfg.get("model") or ""
                except json.JSONDecodeError:
                    pass
        if not provider:
            return {"status": "failed", "error": "no AI provider on rd"}

        user_message = json.dumps(
            {"summary": summary, "recommendation": recommendation},
            ensure_ascii=False,
        )
        try:
            async with limit(provider):
                translated, _raw, _usage = await judge(
                    provider=provider,
                    system_prompt=_TRANSLATE_SYSTEM_PROMPT,
                    user_message=user_message,
                    model_override=model or None,
                )
        except (ProviderConfigError, ProviderError, ValueError) as e:
            return {"status": "failed", "error": f"{type(e).__name__}: {e}"}
        except Exception as e:  # noqa: BLE001
            log.exception(
                "translate failed for rd=%s", rd_id,
            )
            return {"status": "failed", "error": f"unexpected: {e!r}"}

        if not isinstance(translated, dict):
            return {"status": "failed", "error": "translation not a dict"}

        # Re-read rd in case the DB session was refreshed between the
        # async judge call and now. Persist the original-shape dict with
        # overlaid translated prose — keeps numeric fields (final,
        # confidence, provider, model) consistent with the source.
        rd = db.get(RunDomain, rd_id)
        if rd is None:
            return {"status": "failed", "error": "rd disappeared mid-translate"}
        ru_parsed = dict(parsed)
        if isinstance(translated.get("summary"), str):
            ru_parsed["summary"] = translated["summary"]
        if isinstance(translated.get("recommendation"), str):
            ru_parsed["recommendation"] = translated["recommendation"]
        rd.final_assessment_ru_json = json.dumps(
            ru_parsed, ensure_ascii=False,
        )
        db.commit()
        return {"status": "translated", "error": None}
    finally:
        db.close()


_TRANSLATE_CRITERIA_SYSTEM_PROMPT = (
    "You are a professional translator. The input is a JSON object "
    "keyed by criterion name; each value is an object with "
    "\"key_findings\" and/or \"red_flags\" arrays of short English "
    "sentences. Translate each array element to Russian, preserving "
    "SEO and link-building terminology naturally (e.g. \"backlinks\" "
    "→ \"бэклинки\", \"anchor text\" → \"анкорный текст\", \"domain "
    "rating\" → \"рейтинг домена\", \"referring domains\" → "
    "\"ссылающиеся домены\"). Keep array shape and order intact. If a "
    "string is already in Russian, return it unchanged. Return a JSON "
    "object with the SAME criterion keys and the same array structure, "
    "with translated string values. Do not add other keys, do not "
    "rewrite into prose, do not add commentary."
)

_TRANSLATABLE_CRITERION_FIELDS = ("key_findings", "red_flags")


async def translate_criterion_verdicts_for_rd(rd_id: int) -> dict:
    """Translate per-criterion `key_findings` and `red_flags` arrays
    on every CR row of an rd. One LLM call per rd packages all six
    criteria; the response is split back out and persisted on each CR's
    `ai_verdict_ru_json`. Idempotent — skips CRs whose `ai_verdict_ru_json`
    is already populated.

    Other per-criterion fields (assessment enum, confidence, primary_theme,
    category, category_reasoning, history, etc.) are mirrored from the
    original verdict so the translated payload has the same shape — only
    the arrays are translated.

    Returns the same {status, error} contract as
    `translate_final_for_rd` — at the rd level. Per-CR detail is rolled
    up: any failure on the call → "failed" overall; nothing-to-do →
    "skipped"; at least one CR translated → "translated"."""
    db = SessionLocal()
    try:
        crs = (
            db.query(CriterionResult)
            .filter(CriterionResult.run_domain_id == rd_id)
            .all()
        )
        if not crs:
            return {"status": "skipped", "error": None}

        # Build the payload: only CRs that (a) have a parseable verdict,
        # (b) lack an existing translation, (c) contain at least one
        # translatable array.
        per_crit_payload: dict[str, dict[str, list[str]]] = {}
        per_crit_parsed: dict[str, dict] = {}
        crs_to_persist: dict[str, CriterionResult] = {}
        for cr in crs:
            if cr.ai_verdict_ru_json:
                continue
            if not cr.ai_verdict_json:
                continue
            try:
                parsed = json.loads(cr.ai_verdict_json)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            arrays: dict[str, list[str]] = {}
            for f in _TRANSLATABLE_CRITERION_FIELDS:
                v = parsed.get(f)
                if isinstance(v, list) and any(
                    isinstance(s, str) and s.strip() for s in v
                ):
                    arrays[f] = [
                        s if isinstance(s, str) else str(s) for s in v
                    ]
            if not arrays:
                # Nothing to translate on this CR — but still mirror the
                # original into _ru_json so future reads short-circuit.
                cr.ai_verdict_ru_json = cr.ai_verdict_json
                continue
            # Cyrillic short-circuit: if every translatable string is
            # already mostly Russian, skip the API call for this CR.
            combined = " ".join(
                s for vals in arrays.values() for s in vals
            )
            if _cyrillic_ratio(combined) >= 0.5:
                cr.ai_verdict_ru_json = cr.ai_verdict_json
                continue
            per_crit_payload[cr.criterion] = arrays
            per_crit_parsed[cr.criterion] = parsed
            crs_to_persist[cr.criterion] = cr

        if not per_crit_payload:
            db.commit()  # commit cyrillic-mirror writes (if any)
            return {"status": "skipped", "error": None}

        # Resolve provider/model from one of the CRs' AI provenance,
        # falling back to the rd's run.spec.ai.
        provider = ""
        model = ""
        for cr in crs:
            if cr.ai_provider:
                provider = cr.ai_provider
                model = cr.ai_model or ""
                break
        if not provider:
            rd = db.get(RunDomain, rd_id)
            if rd is not None:
                run = db.get(Run, rd.run_id)
                if run is not None and run.spec_json:
                    try:
                        spec_dict = json.loads(run.spec_json)
                        ai_cfg = (spec_dict or {}).get("ai") or {}
                        provider = ai_cfg.get("provider") or ""
                        model = ai_cfg.get("model") or ""
                    except json.JSONDecodeError:
                        pass
        if not provider:
            return {"status": "failed", "error": "no AI provider on rd"}

        user_message = json.dumps(per_crit_payload, ensure_ascii=False)
        try:
            async with limit(provider):
                translated, _raw, _usage = await judge(
                    provider=provider,
                    system_prompt=_TRANSLATE_CRITERIA_SYSTEM_PROMPT,
                    user_message=user_message,
                    model_override=model or None,
                )
        except (ProviderConfigError, ProviderError, ValueError) as e:
            return {"status": "failed", "error": f"{type(e).__name__}: {e}"}
        except Exception as e:  # noqa: BLE001
            log.exception(
                "criterion translate failed for rd=%s", rd_id,
            )
            return {"status": "failed", "error": f"unexpected: {e!r}"}

        if not isinstance(translated, dict):
            return {"status": "failed", "error": "translation not a dict"}

        # Persist translations onto each CR's _ru_json. Re-read the rows
        # in case the session was refreshed mid-await.
        any_persisted = False
        for criterion_name, payload in per_crit_payload.items():
            tr = translated.get(criterion_name)
            if not isinstance(tr, dict):
                continue
            ru_parsed = dict(per_crit_parsed[criterion_name])
            for f in _TRANSLATABLE_CRITERION_FIELDS:
                if f not in payload:
                    continue
                tr_arr = tr.get(f)
                if isinstance(tr_arr, list):
                    # Replace strings element-wise; preserve length so the
                    # UI's index-based rendering stays stable.
                    new_arr = [
                        s if isinstance(s, str) else str(s) for s in tr_arr
                    ]
                    # Pad/truncate defensively to match the original len.
                    orig_len = len(payload[f])
                    if len(new_arr) < orig_len:
                        new_arr = new_arr + payload[f][len(new_arr):]
                    elif len(new_arr) > orig_len:
                        new_arr = new_arr[:orig_len]
                    ru_parsed[f] = new_arr
            cr_row = crs_to_persist[criterion_name]
            cr_row = db.get(CriterionResult, cr_row.id) or cr_row
            cr_row.ai_verdict_ru_json = json.dumps(
                ru_parsed, ensure_ascii=False,
            )
            any_persisted = True

        db.commit()
        return {
            "status": "translated" if any_persisted else "skipped",
            "error": None,
        }
    finally:
        db.close()


async def translate_database_view_verdicts(
    rd_ids: list[int], *, concurrency: int = 8,
) -> dict:
    """Fan-out translator for the bulk endpoint. Translates every rd in
    `rd_ids` (deduped). Concurrency-capped so we don't overwhelm the
    provider's per-key rate limit — each rd costs TWO API calls (final
    + per-criterion arrays), so 8-wide × 2 = ~16 concurrent in-flight,
    well below the typical 60 rpm ceiling for Gemini Flash.
    """
    seen: set[int] = set()
    unique_ids: list[int] = []
    for r in rd_ids:
        if r not in seen:
            seen.add(r)
            unique_ids.append(r)
    sem = asyncio.Semaphore(max(1, int(concurrency)))

    async def _one(rd_id: int) -> dict:
        async with sem:
            final_result = await translate_final_for_rd(rd_id)
            crit_result = await translate_criterion_verdicts_for_rd(rd_id)
            # Roll up: failure on either step ⇒ failed; translated on
            # either ⇒ translated; otherwise skipped.
            if (
                final_result["status"] == "failed"
                or crit_result["status"] == "failed"
            ):
                return {
                    "status": "failed",
                    "error": (
                        final_result.get("error")
                        or crit_result.get("error")
                    ),
                }
            if (
                final_result["status"] == "translated"
                or crit_result["status"] == "translated"
            ):
                return {"status": "translated", "error": None}
            return {"status": "skipped", "error": None}

    results = await asyncio.gather(
        *[_one(r) for r in unique_ids], return_exceptions=False,
    )
    counts = {"translated": 0, "skipped": 0, "failed": 0}
    errors: list[str] = []
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r["status"] == "failed" and r.get("error") and len(errors) < 10:
            errors.append(r["error"])
    return {
        "total": len(unique_ids),
        **counts,
        "errors": errors,
    }


def get_run_scoring_override(run_id: int) -> dict | None:
    """Return the parsed `{weights: {...}}` override for a run, or None
    when the run uses global Settings weights. Used by the Run-detail
    endpoint so the UI can pre-populate the override panel."""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or not run.scoring_override_json:
            return None
        try:
            parsed = json.loads(run.scoring_override_json)
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed, dict):
            return None
        w = parsed.get("weights")
        if not isinstance(w, dict):
            return None
        return {"weights": {
            c: float(w[c]) for c in SCORING_CRITERIA
            if isinstance(w.get(c), (int, float)) and not isinstance(w.get(c), bool)
        }}
    finally:
        db.close()


def _begin_domain(run_domain_id: int) -> str | None:
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return None
        rd.status = "running"
        rd.started_at = datetime.utcnow()
        rd.error = ""
        db.commit()
        return rd.domain
    finally:
        db.close()


def _create_criterion_row(
    run_domain_id: int, criterion: str, url: str, params_hash: str = ""
) -> int:
    db = SessionLocal()
    try:
        cr = CriterionResult(
            run_domain_id=run_domain_id,
            criterion=criterion,
            request_url=url,
            status="running",
            params_hash=params_hash,
        )
        db.add(cr)
        db.commit()
        return cr.id
    finally:
        db.close()


def _reset_or_create_criterion_row(
    *,
    run_domain_id: int,
    criterion: str,
    url: str,
    params_hash: str,
) -> int:
    """For per-criterion refetch: if a CriterionResult already exists for
    this (rd, criterion), reset its fetch-side fields (status, data, error,
    units, cache pointers, request URL) so the new fetch overwrites cleanly.
    Otherwise create a fresh row. Returns the row id either way."""
    db = SessionLocal()
    try:
        existing = (
            db.query(CriterionResult)
            .filter(
                CriterionResult.run_domain_id == run_domain_id,
                CriterionResult.criterion == criterion,
            )
            .first()
        )
        if existing is not None:
            existing.request_url = url
            existing.status = "running"
            existing.http_status = None
            existing.fetched_at = None
            existing.data_json = ""
            existing.error = ""
            existing.units_cost_row = None
            existing.units_cost_total = None
            existing.units_cost_actual = None
            existing.params_hash = params_hash
            existing.cached_from_run_id = None
            db.commit()
            return existing.id
        cr = CriterionResult(
            run_domain_id=run_domain_id,
            criterion=criterion,
            request_url=url,
            status="running",
            params_hash=params_hash,
        )
        db.add(cr)
        db.commit()
        return cr.id
    finally:
        db.close()


def _finish_criterion_row(
    cr_id: int,
    ok: bool,
    http_status: int | None,
    body: dict | None,
    err: str,
    units: dict | None = None,
) -> None:
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        if cr is None:
            return
        cr.status = "done" if ok else "failed"
        cr.http_status = http_status
        cr.fetched_at = datetime.utcnow()
        if body is not None:
            cr.data_json = json.dumps(body, ensure_ascii=False)
        if err:
            cr.error = err
        if units:
            cr.units_cost_row = units.get("cost_row")
            cr.units_cost_total = units.get("cost_total")
            cr.units_cost_actual = units.get("cost_actual")
        db.commit()
    finally:
        db.close()


def _load_wayback_samples(cr_id: int) -> list[dict]:
    """Read the V2 page-content samples persisted under data_json["samples"]
    on a wayback CriterionResult row. Returns [] if the row is missing,
    has no data_json yet, or the row was fetched before V2 sampling
    existed (older shape: data_json = {"wayback": [...]} with no
    "samples" key — that's how cache rows from before this feature look)."""
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        if cr is None or not cr.data_json:
            return []
        try:
            body = json.loads(cr.data_json)
        except json.JSONDecodeError:
            return []
        if isinstance(body, dict):
            samples = body.get("samples")
            if isinstance(samples, list):
                return samples
        return []
    finally:
        db.close()


def _trim_samples_for_ai(samples: list[dict]) -> list[dict]:
    """Compact a sample list before sending to the AI: drops the long
    `snapshot_url`, normalizes empty fields, and only includes
    `http_status` when non-2xx (else it's noise). Keeps the timeline +
    title/headings/body which is what the model actually uses.

    Redirect snapshots (3xx) carry their `Location` header in
    `redirect_to` instead of useless Apache-stub body text, so the AI
    sees a clean structured signal like
    `redirect_to: "https://www.petsmart.com"`."""
    out: list[dict] = []
    for s in samples:
        trimmed: dict = {
            "timestamp": s.get("timestamp"),
            "url": s.get("url"),
            "title": s.get("title", ""),
            "h1s": s.get("h1s", []),
            "h2s": s.get("h2s", []),
            "h3s": s.get("h3s", []),
            "body_excerpt": s.get("body_excerpt", ""),
        }
        err = s.get("error")
        if err:
            trimmed["error"] = err
        http_status = s.get("http_status")
        if http_status and http_status != 200:
            trimmed["http_status"] = http_status
        redirect_to = s.get("redirect_to")
        if redirect_to:
            trimmed["redirect_to"] = redirect_to
        # `lang_attr` is the <html lang="..."> value extracted by the V2
        # parser. Only emit when present — saves tokens for samples that
        # didn't have the attribute. wayback_classify (added 2026-05-09)
        # uses it as a hint in AI-mode language detection.
        lang_attr = s.get("lang_attr")
        if lang_attr:
            trimmed["lang_attr"] = lang_attr
        out.append(trimmed)
    return out


def _attach_wayback_samples(cr_id: int, samples: list[dict]) -> None:
    """Append `samples` to a wayback CriterionResult's `data_json` shape.

    Result shape becomes `{"wayback": [...cdx rows], "samples": [...]}`.
    The "wayback" key stays first so existing helpers that grab the first
    list value (e.g. _completed_criteria, build_ai_preview, cache copy)
    continue to read the CDX rows — samples are read separately by the
    AI judge + UI via the explicit "samples" key.

    No-op if `samples` is empty so we don't re-write data_json on a domain
    that returned no usable snapshot picks."""
    if not samples:
        return
    db = SessionLocal()
    try:
        cr = db.get(CriterionResult, cr_id)
        if cr is None or not cr.data_json:
            return
        try:
            body = json.loads(cr.data_json)
        except json.JSONDecodeError:
            return
        if not isinstance(body, dict):
            return
        body["samples"] = samples
        cr.data_json = json.dumps(body, ensure_ascii=False)
        db.commit()
    finally:
        db.close()


def _ts_to_year(ts: str) -> int | None:
    """Wayback timestamps are `YYYYMMDDHHMMSS`. Return year as int."""
    if not isinstance(ts, str) or len(ts) < 4 or not ts[:4].isdigit():
        return None
    return int(ts[:4])


def _pick_even_wayback_rows(
    rows: list[dict], *, count: int
) -> list[dict]:
    """Quantile-spaced picks across the CDX timeline. Prefers status=200
    + html mimetype rows because non-200/non-html samples carry weak title
    signal. Falls back to the full row set if the filtered candidate pool
    is too small (e.g. domain that 301'd for most of its history)."""
    if not rows or count <= 0:
        return []
    candidates = [
        r for r in rows
        if str(r.get("statuscode") or "") == "200"
        and "html" in str(r.get("mimetype") or "").lower()
    ]
    # If the filtered pool is meaningfully smaller than the budget, the
    # filter is hurting more than helping — fall back to all rows. This
    # surfaces parking-page domains too (where the AI's job is to spot a
    # consistent 301/parking pattern, not theme drift).
    if len(candidates) < max(2, count):
        candidates = rows
    if len(candidates) <= count:
        return list(candidates)
    n = len(candidates)
    # Quantile-spaced indices: 0, ..., n-1 split into `count` points.
    raw_indices = [
        int(round(i * (n - 1) / (count - 1))) for i in range(count)
    ]
    # Dedupe while preserving order (ties at sparse populations).
    seen: dict[int, None] = {}
    for idx in raw_indices:
        if 0 <= idx < n:
            seen.setdefault(idx, None)
    return [candidates[i] for i in seen]


def _pick_anchor_wayback_rows(
    rows: list[dict], *, count: int
) -> list[dict]:
    """Pick rows around CDX anomaly events: status flips, mimetype flips,
    big content-length jumps, multi-year crawl gaps. Always includes the
    chronological first + last rows so the AI sees the bookends. Fills
    remaining budget with even-spaced rows from the unsampled set so we
    use the full count even on uniform domains with no anomalies.

    Priority order when more anchors than budget exist (lower wins):
      0 = first/last bookend
      1 = status code change
      2 = mimetype change
      3 = length jump (>5x)
      4 = time gap (>365 days)
    """
    if not rows or count <= 0:
        return []
    sorted_rows = sorted(
        rows, key=lambda r: str(r.get("timestamp") or "")
    )
    n = len(sorted_rows)
    if n <= count:
        return sorted_rows

    # (priority, index) candidates — duplicates allowed; resolved below.
    candidates: list[tuple[int, int]] = [(0, 0), (0, n - 1)]
    for i in range(1, n):
        prev_row = sorted_rows[i - 1]
        curr_row = sorted_rows[i]
        if (
            str(prev_row.get("statuscode") or "")
            != str(curr_row.get("statuscode") or "")
        ):
            candidates.append((1, i - 1))
            candidates.append((1, i))
        if (
            str(prev_row.get("mimetype") or "").lower()
            != str(curr_row.get("mimetype") or "").lower()
        ):
            candidates.append((2, i - 1))
            candidates.append((2, i))
        try:
            lp = int(prev_row.get("length") or 0)
            lc = int(curr_row.get("length") or 0)
            if lp > 0 and lc > 0 and (lc / lp > 5 or lp / lc > 5):
                candidates.append((3, i - 1))
                candidates.append((3, i))
        except (TypeError, ValueError):
            pass
        yp = _ts_to_year(str(prev_row.get("timestamp") or ""))
        yc = _ts_to_year(str(curr_row.get("timestamp") or ""))
        if yp is not None and yc is not None and (yc - yp) >= 2:
            candidates.append((4, i - 1))
            candidates.append((4, i))

    # Best (lowest) priority wins per index.
    best_priority: dict[int, int] = {}
    for prio, idx in candidates:
        if idx not in best_priority or prio < best_priority[idx]:
            best_priority[idx] = prio

    # Sort by priority asc, then by index asc, then take top `count`.
    ranked = sorted(best_priority.items(), key=lambda x: (x[1], x[0]))
    if len(ranked) >= count:
        picked = sorted({idx for idx, _ in ranked[:count]})
    else:
        picked_set = {idx for idx, _ in ranked}
        deficit = count - len(picked_set)
        # Fill from unsampled rows with quantile spacing.
        unsampled = [i for i in range(n) if i not in picked_set]
        if unsampled and deficit > 0:
            m = len(unsampled)
            for k in range(deficit):
                if deficit == 1:
                    pos = m // 2
                else:
                    pos = int(round(k * (m - 1) / (deficit - 1)))
                if 0 <= pos < m:
                    picked_set.add(unsampled[pos])
        picked = sorted(picked_set)[:count]
    return [sorted_rows[i] for i in picked]


def _pick_wayback_samples(
    rows: list[dict],
    *,
    count: int,
    strategy: str,
    path_mode: str,
    domain: str,
) -> list[tuple[str, str]]:
    """Returns a list of (timestamp, url) pairs to fetch via
    `WaybackClient.fetch_snapshot_page`. Empty list = nothing to sample
    (no rows, count=0, or no usable timestamps).

    `path_mode="root"` always samples `https://{domain}/`. `mixed` uses
    the `original` URL recorded in each chosen CDX row (falling back to
    the root if `original` is missing — old CDX rows have spotty data)."""
    if not rows or count <= 0:
        return []
    picker = (
        _pick_anchor_wayback_rows
        if strategy == "anchor"
        else _pick_even_wayback_rows
    )
    picked_rows = picker(rows, count=count)
    root_url = f"https://{domain}/"
    out: list[tuple[str, str]] = []
    for row in picked_rows:
        ts = str(row.get("timestamp") or "").strip()
        if not ts:
            continue
        if path_mode == "root":
            url = root_url
        else:
            url = str(row.get("original") or "").strip() or root_url
        out.append((ts, url))
    return out


async def _fetch_wayback_samples(
    *, samples: list[tuple[str, str]]
) -> list[dict]:
    """Fetch each `(ts, url)` snapshot page through the `wayback` rate
    limit, in parallel up to whatever max_concurrent is set on the
    wayback rate-limit row. Returns the list of sample dicts (one per
    pick) in the SAME ORDER as the input — failed fetches are still
    returned so the AI can see "we tried, archive.org didn't have a
    usable snapshot here".

    Was sequential prior to 2026-05-10 (a single 6-sample fetch took
    6-18 seconds wall-clock). The `limit("wayback")` async context
    already gates concurrency at the user-configured ceiling, so
    `asyncio.gather` cannot exceed that ceiling — at max_concurrent=1
    behavior is byte-identical to the old sequential loop; at higher
    concurrency settings the wall-clock drops proportionally."""
    async def fetch_one(ts: str, url: str) -> dict:
        try:
            async with limit("wayback"):
                async with get_provider("wayback") as wb:
                    return await wb.fetch_snapshot_page(
                        timestamp=ts, url=url
                    )
        except Exception as e:  # noqa: BLE001
            log.warning(
                "wayback snapshot fetch crashed ts=%s url=%s: %s",
                ts, url, e,
            )
            return {
                "timestamp": ts,
                "url": url,
                "snapshot_url": "",
                "http_status": 0,
                "title": "",
                "h1s": [],
                "h2s": [],
                "h3s": [],
                "body_excerpt": "",
                "error": f"crashed: {type(e).__name__}: {e}",
            }

    if not samples:
        return []
    return list(await asyncio.gather(*(fetch_one(ts, url) for ts, url in samples)))


def _finish_domain(run_domain_id: int, success: bool) -> None:
    db = SessionLocal()
    try:
        rd = db.get(RunDomain, run_domain_id)
        if rd is None:
            return
        rd.status = "done" if success else "failed"
        rd.finished_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()


# Map criterion → provider name. Wayback is its own service; the four
# Ahrefs criteria all go through the same client.
_CRITERION_PROVIDER = {
    "backlinks": "ahrefs",
    "refdomains": "ahrefs",
    "anchors": "ahrefs",
    "keywords": "ahrefs",
    "wayback": "wayback",
}


async def _fetch_criterion(
    url: str,
    criterion: str = "backlinks",
) -> tuple[bool, int | None, dict | None, str, dict]:
    """Single fetch with rate limiter + retry. Routes to the provider
    that owns the criterion (ahrefs vs wayback). Returns
    (ok, http_status, body, err_msg, units). `units` is empty for
    Wayback (no metered quota); Ahrefs populates it from response headers.
    Never raises — failures are reported to the caller so one criterion's
    failure doesn't kill the whole domain."""
    provider = _CRITERION_PROVIDER.get(criterion, "ahrefs")
    try:
        async with limit(provider):
            async with get_provider(provider) as p:
                http_status, body, units = await p.fetch_url(url)
        return True, http_status, body, "", units
    except Exception as e:  # noqa: BLE001
        return False, None, None, f"{type(e).__name__}: {e}", {}
