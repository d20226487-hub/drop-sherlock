"""Per-Run orchestrator for the whois_history pillar.

Much simpler than the Quality `tasks.process_run`:
  1. Mark Run running
  2. For each RunDomain (concurrently, bounded by a semaphore):
       a. Fetch WHOIS history via the configured provider
       b. Compute diff signals
       c. Run the AI judge
       d. Persist as one CriterionResult row (criterion='whois_history')
  3. Mark Run done/failed

No per-criterion cache, no augmentation chains, no auto-pipelining —
this pillar has one criterion and one verdict per domain. Cache will
land in Wave 2b if needed; today every domain triggers a fresh fetch.

Lives in its own module rather than wedging into tasks.py so the
Quality runner stays untouched and easier to reason about.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from .. import ai_judge
from ..ai_prompts import localize_prompt
from ..app_settings import (
    SessionLocal,
    get_ai_prompt,
    get_model_price,
    get_provider_creds,
)
from ..models import CriterionResult, Run, RunDomain
from ..providers.base import ProviderConfigError, ProviderError
from .base import WhoisProviderError
from .fetcher import fetch_history

log = logging.getLogger(__name__)

# Outer cap so a thousand-domain run doesn't schedule a thousand
# concurrent provider calls. WhoisFreaks's free tier rate-limits hard;
# even paid plans don't appreciate bursts. 8 is generous but safe.
_OUTER_CONCURRENCY = 8

# AI judge timeout — WHOIS history payloads can be sizeable (100 records
# × verbose contact blocks), so give the model a bit more rope than the
# Quality criterion judges (30s default).
_AI_TIMEOUT_SECONDS = 90.0


def _verdict_skeleton(reason: str) -> dict[str, Any]:
    """Pre-canned verdict used when the AI couldn't run (no history,
    provider failure, missing API key, etc.). Same shape as the real
    AI output so the frontend's verdict-rendering code has nothing to
    special-case."""
    return {
        "dropped_confidence": 0.0,
        "transferred_confidence": 0.0,
        "summary": reason,
        "key_signals": [],
        "recommendation": "insufficient history",
    }


# Soft cap on raw records bundled into the AI prompt. Hard signals +
# diff summary already encode "what changed"; raw records are for the
# model to cross-check borderline cases. 30 keeps prompts bounded on
# domains with hundreds of snapshots. Module-level constant so the
# `build_ai_preview` route + this runner build IDENTICAL prompts.
MAX_RECORDS_IN_PROMPT = 30


def build_user_message(
    domain: str, records: list[dict[str, Any]], diff: dict[str, Any]
) -> str:
    """Prompt body — structured diff first (easy reading for the
    model), raw records second. The runner + the AI-preview route
    both call this so what the operator sees in the preview is
    BYTE-IDENTICAL to what the runner sends.

    Records are passed in newest-first up to MAX_RECORDS_IN_PROMPT.
    Callers should pass the canonical record list (chronological,
    oldest-first); we reverse here so the prompt always shows
    newest-first which is what the model prioritizes."""
    snapshot_count = len(records)
    raw_records_for_prompt = list(records)
    raw_records_for_prompt.reverse()
    if len(raw_records_for_prompt) > MAX_RECORDS_IN_PROMPT:
        raw_records_for_prompt = raw_records_for_prompt[:MAX_RECORDS_IN_PROMPT]
    parts = [
        f"Domain: {domain}",
        f"Snapshot count: {snapshot_count}",
        "",
        "Structured diff (signals classified by strength):",
        json.dumps(diff, indent=2, ensure_ascii=False),
        "",
        f"Raw historical records (newest first, up to "
        f"{MAX_RECORDS_IN_PROMPT} shown):",
        json.dumps(raw_records_for_prompt, indent=2, ensure_ascii=False),
    ]
    return "\n".join(parts)


def _build_user_message(domain: str, fetch_result: dict[str, Any]) -> str:
    """Internal alias used by `_process_whois_domain`. Kept thin so
    the public `build_user_message` (above) stays the single source
    of truth."""
    return build_user_message(
        domain,
        fetch_result.get("records", []) or [],
        fetch_result.get("diff", {}) or {},
    )


def _resolve_effective_model(provider: str, override: str | None) -> str:
    """Resolve the concrete model name a `judge()` call will use:
    explicit override wins, else the provider's `default_model` from
    Settings. Returns "" if neither is set (judge will then error out
    on its own; we stamp an empty model on the CR and the cost just
    falls through to 0).

    Distinct from `ai_judge._resolve_model` which RAISES on missing
    default — we want a best-effort name for cost stamping, not a
    hard failure inside the runner's "after the call succeeded" path.
    """
    if override and override.strip():
        return override.strip()
    try:
        creds = get_provider_creds(provider)
    except Exception:  # noqa: BLE001
        return ""
    return (creds.get("default_model") or "").strip()


def _record_ai_cost(
    cr: CriterionResult, usage: dict[str, int], provider: str, model: str
) -> None:
    """Stamp tokens + USD cost onto the CR. Same pattern as Quality
    judges — pricing comes from the model_pricing table, cost stays
    0 with a 'missing pricing' surface in the UI when a row is
    missing for the model.

    Caller MUST pass the resolved model name (use
    `_resolve_effective_model` if the spec carries an empty override).
    Passing "" here lands an empty model_name on the CR and pricing
    lookup fails — making the Cost pill show $0 + ⚠ even when there
    IS a pricing row for the model that actually ran. That bug bit
    once already (run 85 of job 47 stamped ai_model="") — fix is in
    the call site, not here."""
    cr.ai_input_tokens = int(usage.get("input_tokens") or 0)
    cr.ai_output_tokens = int(usage.get("output_tokens") or 0)
    cr.ai_provider = provider
    cr.ai_model = model
    pricing = get_model_price(provider, model)
    if pricing is not None:
        in_per_m, out_per_m = pricing
        cost = (
            (cr.ai_input_tokens / 1_000_000.0) * in_per_m
            + (cr.ai_output_tokens / 1_000_000.0) * out_per_m
        )
        cr.ai_cost_usd = round(cost, 6)


async def _process_whois_domain(rd_id: int, run_id: int) -> None:
    """Fetch + judge one domain's WHOIS history. Each step writes its
    own short transaction so an error in the AI judge step doesn't
    cost us the (already-paid-for) provider fetch."""
    db: Session = SessionLocal()
    try:
        rd = db.get(RunDomain, rd_id)
        if rd is None:
            log.warning("whois_history runner: rd_id=%s missing", rd_id)
            return
        rd.status = "running"
        rd.started_at = datetime.utcnow()
        db.commit()

        # --- 1. Fetch + diff
        provider_name = ""
        records_json: list[dict[str, Any]] = []
        diff_json: dict[str, Any] = {}
        fetch_error: str = ""
        try:
            result = await fetch_history(rd.domain)
            provider_name = result.provider
            records_json = result.records
            diff_json = result.diff
        except WhoisProviderError as e:
            fetch_error = str(e)
            log.warning(
                "whois_history fetch failed for rd=%s domain=%s: %s",
                rd_id, rd.domain, e,
            )

        # --- 2. Persist data + create CR row
        cr = CriterionResult(
            run_domain_id=rd.id,
            criterion="whois_history",
            status="running",
            fetched_at=datetime.utcnow(),
            data_json=json.dumps({
                "records": records_json,
                "diff": diff_json,
                "provider": provider_name,
            }),
            request_url="",
            error=fetch_error,
        )
        db.add(cr)
        db.commit()
        db.refresh(cr)

        # --- 3. AI judge
        # Load spec each iteration — it's tiny, the per-CR isolation is
        # not worth dragging spec across awaits.
        run = db.get(Run, run_id)
        spec_dict = json.loads(run.spec_json or "{}") if run else {}
        ai_block = (spec_dict.get("ai") or {})
        ai_provider = (ai_block.get("provider") or "").strip()
        ai_model = (ai_block.get("model") or "").strip() or None
        lang = (spec_dict.get("lang") or "en").strip().lower()

        if not ai_provider:
            cr.status = "done" if not fetch_error else "failed"
            cr.ai_verdict_json = json.dumps(
                _verdict_skeleton(
                    "No AI provider configured for this run — "
                    "showing raw history without verdict."
                )
            )
            cr.ai_verdict_error = ""
            db.commit()
            rd.status = cr.status
            rd.finished_at = datetime.utcnow()
            rd.last_analyzed_at = datetime.utcnow()
            db.commit()
            return

        if fetch_error:
            # Skip AI when we have no data to feed it — save tokens.
            cr.status = "failed"
            cr.ai_verdict_json = json.dumps(
                _verdict_skeleton(
                    f"Provider fetch failed: {fetch_error}"
                )
            )
            cr.ai_verdict_error = ""
            db.commit()
            rd.status = "failed"
            rd.error = fetch_error
            rd.finished_at = datetime.utcnow()
            rd.last_analyzed_at = datetime.utcnow()
            db.commit()
            return

        if not records_json:
            # No history available — provider responded but with empty
            # records (very new domain or unsupported TLD). Skip AI,
            # write a "no history" verdict.
            cr.status = "done"
            cr.ai_verdict_json = json.dumps(
                _verdict_skeleton("No historical WHOIS records available.")
            )
            cr.ai_verdict_error = ""
            db.commit()
            rd.status = "done"
            rd.finished_at = datetime.utcnow()
            rd.last_analyzed_at = datetime.utcnow()
            db.commit()
            return

        # Real AI judge call. Resolve the concrete model name here
        # (vs inside `judge()`) so we have it for both the call AND
        # the post-call cost stamping — empty override on the spec
        # otherwise stamped ai_model="" on the CR and broke pricing
        # lookup (run 85 of job 47, fixed 2026-05-15).
        effective_model = _resolve_effective_model(ai_provider, ai_model)
        system_prompt = localize_prompt(
            get_ai_prompt("whois_history_judge"), lang,
        )
        user_message = _build_user_message(
            rd.domain,
            {
                "records": records_json,
                "diff": diff_json,
                "snapshot_count": len(records_json),
            },
        )
        try:
            verdict_dict, _raw, usage = await ai_judge.judge(
                provider=ai_provider,
                system_prompt=system_prompt,
                user_message=user_message,
                model_override=effective_model or None,
                timeout=_AI_TIMEOUT_SECONDS,
            )
            cr.ai_verdict_json = json.dumps(verdict_dict)
            cr.ai_verdict_error = ""
            cr.status = "done"
            _record_ai_cost(cr, usage, ai_provider, effective_model)
            db.commit()
            rd.status = "done"
            rd.finished_at = datetime.utcnow()
            rd.last_analyzed_at = datetime.utcnow()
            db.commit()
        except (
            ProviderConfigError, ProviderError, ValueError,
        ) as e:
            log.warning(
                "whois_history AI judge failed for rd=%s domain=%s: %s",
                rd_id, rd.domain, e,
            )
            cr.status = "failed"
            cr.ai_verdict_error = f"{type(e).__name__}: {e}"
            db.commit()
            rd.status = "failed"
            rd.error = str(e)
            rd.finished_at = datetime.utcnow()
            rd.last_analyzed_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()


async def process_whois_history_run(run_id: int) -> None:
    """Top-level orchestrator for a whois_history-kind Run. Dispatched
    by `tasks.dispatch_run` based on the parent Job's kind."""
    # 1. Mark running.
    db: Session = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.status != "pending":
            return
        run.status = "running"
        run.started_at = datetime.utcnow()
        run.error = ""
        db.commit()
        rd_ids = [
            r.id for r in
            db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
        ]
    finally:
        db.close()

    # 2. Fan out, bounded.
    outer_sem = asyncio.Semaphore(_OUTER_CONCURRENCY)

    async def _one(rd_id: int) -> None:
        async with outer_sem:
            await _process_whois_domain(rd_id, run_id)

    try:
        await asyncio.gather(
            *(_one(r) for r in rd_ids), return_exceptions=False,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("whois_history run %s failed", run_id)
        db = SessionLocal()
        try:
            run = db.get(Run, run_id)
            if run is not None and run.status == "running":
                run.status = "failed"
                run.error = f"{type(e).__name__}: {e}"
                run.finished_at = datetime.utcnow()
                db.commit()
        finally:
            db.close()
        return

    # 3. Mark done.
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None and run.status == "running":
            run.status = "done"
            run.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
