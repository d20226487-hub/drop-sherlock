"""Per-job cache for Ahrefs responses and AI verdicts.

The runner consults this module before each Ahrefs fetch and each AI judge
call. When a prior run of the SAME job has a CriterionResult with matching
hashes, we copy the row's data (or verdict) instead of hitting the upstream
API again. This protects the user's Ahrefs unit budget when they iterate
on AI prompts/providers without changing the request shape.

Cache keys
----------
- params_hash = sha256(criterion + filters + sort + limit) — covers every
  knob that affects the Ahrefs URL. If two specs produce identical Ahrefs
  requests, they share params_hash.
- prompt_hash = sha256(system_prompt + provider + model) — covers every
  knob that affects the AI judge call. Editing the prompt in Settings or
  switching provider/model busts only the AI cache.

Lookups happen against `criterion_results` rows joined to `run_domains` and
`runs` so we can scope to a single Job.id. We never read across jobs.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy.orm import Session

from .models import CriterionResult, Run, RunDomain
from .schemas import (
    AnchorsConfig,
    BacklinksConfig,
    KeywordsConfig,
    RefdomainsConfig,
    WaybackConfig,
)

CriterionConfig = (
    BacklinksConfig
    | RefdomainsConfig
    | AnchorsConfig
    | KeywordsConfig
    | WaybackConfig
)


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def compute_params_hash(criterion: str, cfg: CriterionConfig) -> str:
    """Deterministic hash of every knob that changes the Ahrefs request.

    Excludes `enabled` because a disabled criterion isn't fetched at all,
    so it can't conflict with an enabled identical criterion in another run.
    """
    # wayback_classify has no `limit` (no fetch); it's an AI-only criterion
    # whose verdict cache is keyed by its derivation knobs. Hash includes
    # `language_mode` because library vs ai changes which prompt is used
    # AND whether language is overwritten by lingua afterward.
    if criterion == "wayback_classify":
        return hashlib.sha256(
            _stable_json({
                "c": criterion,
                "language_mode": getattr(cfg, "language_mode", "ai"),
            }).encode("utf-8")
        ).hexdigest()
    payload: dict[str, Any] = {
        "c": criterion,
        "limit": cfg.limit,
    }
    filters = getattr(cfg, "filters", None)
    if filters is not None:
        fdump = filters.model_dump()
        # Drop empty-list and None-valued fields so newly-added optional
        # filters (languages, domain_contains, dr_min, dr_max) don't bust
        # pre-existing cache rows where the user hasn't used them yet.
        fdump = {k: v for k, v in fdump.items() if v != [] and v is not None}
        # Newly-added boolean toggles (noindex_exclude, content_only) default
        # to False — drop them when they're at default so existing cache
        # rows (hashed before these fields existed) keep matching. Same
        # pattern as `aggregation` below. Other booleans (dofollow,
        # nofollow, non_spammy) are NOT dropped — those have always been in
        # the hash, so changing them must continue to bust the cache.
        for off_default_key in ("noindex_exclude", "content_only"):
            if fdump.get(off_default_key) is False:
                fdump.pop(off_default_key, None)
        payload["filters"] = fdump
    sort = getattr(cfg, "sort", None)
    if sort is not None:
        payload["sort"] = [
            {"field": r.field, "direction": r.direction} for r in sort
        ]
    aggregation = getattr(cfg, "aggregation", None)
    # Only include aggregation in the payload when it differs from the
    # default. Pre-feature rows hashed without this key at all; defaulting to
    # "similar_links" matches Ahrefs's implicit default, so omitting it from
    # the hash for that value preserves cache hits on existing rows.
    if aggregation is not None and aggregation != "similar_links":
        payload["aggregation"] = aggregation
    # Backlinks now hardcode `link_type=text` on every request (locked
    # 2026-05-06). Including it in the hash forces existing cache rows
    # (fetched without this filter) to correctly miss after this change.
    if criterion == "backlinks":
        payload["link_type"] = "text"
    # Wayback V2 page-content sampling fields. Only included when sampling
    # is on — pre-V2 cache rows were hashed without these keys, so a job
    # whose Wayback config has `sample_pages=False` (default) keeps hitting
    # those existing rows. Flipping sampling on (or changing strategy /
    # path mode / count) correctly busts the cache so the new run actually
    # fetches snapshot pages.
    if criterion == "wayback" and getattr(cfg, "sample_pages", False):
        payload["sample_pages"] = True
        payload["sample_count"] = getattr(cfg, "sample_count", 6)
        payload["sample_strategy"] = getattr(cfg, "sample_strategy", "even")
        payload["sample_path_mode"] = getattr(cfg, "sample_path_mode", "mixed")
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


def compute_prompt_hash(
    system_prompt: str,
    provider: str,
    model: str | None,
    *,
    fields_sent: list[str] | None = None,
) -> str:
    """Hash every knob that changes the AI judge call.

    `fields_sent` is the per-criterion field-trim list (`AI_FIELD_TRIM[c]`)
    — folded in so editing the trim list (e.g. dropping `is_spam` from
    anchors, adding a new field for V2) correctly busts the AI cache. Old
    callers that don't pass it default to None, which keeps the hash
    backward-compatible: pre-existing cache rows hashed without this key
    still match when the new lookup also passes None. Callers that DO pass
    a non-None list will get a fresh hash, busting any cache row that was
    written before this argument existed (acceptable: re-judge once, then
    the new cache stabilizes)."""
    payload: dict[str, Any] = {
        "p": system_prompt,
        "provider": provider,
        "model": model or "",
    }
    if fields_sent is not None:
        # Order matters in the user message (it's a dict; Python preserves
        # insertion order in JSON), so include the order in the hash too.
        payload["fields"] = list(fields_sent)
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


def lookup_cached_data(
    db: Session,
    *,
    job_id: int | None,
    domain: str,
    criterion: str,
    params_hash: str,
    exclude_run_id: int,
) -> CriterionResult | None:
    """Find a `done` CriterionResult with matching params for this domain.

    Scope:
      • `job_id` is an int → look only inside that job (default per-job
        cache, locked 2026-05-06).
      • `job_id` is None → look across ALL jobs (cross-job cache, used by
        the Database-page "Analyze selected" entry point — added
        2026-05-09 — when the user explicitly opts into reusing data
        produced anywhere in the workspace, not just by the current job).

    Returns the most recent matching row by id (descending). The caller
    copies the relevant fields into the new row."""
    if not params_hash:
        return None
    q = (
        db.query(CriterionResult)
        .join(RunDomain, CriterionResult.run_domain_id == RunDomain.id)
        .join(Run, RunDomain.run_id == Run.id)
        .filter(
            Run.id != exclude_run_id,
            RunDomain.domain == domain,
            CriterionResult.criterion == criterion,
            CriterionResult.status == "done",
            CriterionResult.params_hash == params_hash,
        )
    )
    if job_id is not None:
        q = q.filter(Run.job_id == job_id)
    return q.order_by(CriterionResult.id.desc()).first()


def lookup_cached_verdict(
    db: Session,
    *,
    job_id: int | None,
    domain: str,
    criterion: str,
    params_hash: str,
    prompt_hash: str,
    exclude_run_id: int,
) -> CriterionResult | None:
    """Find a CriterionResult whose Ahrefs request shape AND AI prompt/
    provider/model both match — and which actually has an AI verdict
    saved. Used to short-circuit the AI judge call.

    Scoping rule matches `lookup_cached_data`: `job_id` int = per-job
    only; `job_id` None = cross-job (used by Database-page entry)."""
    if not params_hash or not prompt_hash:
        return None
    q = (
        db.query(CriterionResult)
        .join(RunDomain, CriterionResult.run_domain_id == RunDomain.id)
        .join(Run, RunDomain.run_id == Run.id)
        .filter(
            Run.id != exclude_run_id,
            RunDomain.domain == domain,
            CriterionResult.criterion == criterion,
            CriterionResult.params_hash == params_hash,
            CriterionResult.prompt_hash == prompt_hash,
            CriterionResult.ai_verdict_json != "",
        )
    )
    if job_id is not None:
        q = q.filter(Run.job_id == job_id)
    return q.order_by(CriterionResult.id.desc()).first()


def get_run_id_for_criterion(
    db: Session, criterion_result_id: int
) -> int | None:
    """Resolve the Run.id that owns a given CriterionResult — used so the
    UI can display 'served from cache · Run #N'."""
    cr = db.get(CriterionResult, criterion_result_id)
    if cr is None:
        return None
    rd = db.get(RunDomain, cr.run_domain_id)
    if rd is None:
        return None
    return rd.run_id
