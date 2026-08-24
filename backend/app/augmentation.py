"""Augmentation chain logic for RunDomain rows.

A RunDomain is an "augmenter" of a prior RunDomain X for the same domain
when this run's enabled-criteria set is a STRICT SUBSET of X's criteria
set. Common case: user reruns wayback-only on a domain that previously
had a full {backlinks, refdomains, anchors, keywords, wayback} run. The
new wayback-only run shouldn't shadow the Ahrefs data on the Database
page — instead it AUGMENTS the prior canonical run with fresher wayback
data.

Implementation notes:
- Detection runs once at RunDomain creation. We resolve the FK, set it,
  and never touch it again on that row. Pause/resume/reanalyze don't
  affect augmentation status.
- Display logic in `routers/database.py` does per-criterion-latest as
  the primary truth — the FK is also informational, surfacing the
  "augments Run #N" chip in the UI. The two are kept consistent because
  per-criterion-latest naturally produces the same result the chain
  walk would.
- "Strict subset" means: every criterion enabled in the new run is also
  enabled in the prior run, AND the prior run has at least one extra
  enabled criterion. Equal sets → not an augmenter (becomes a fresh
  canonical, latest-wins refresh). Disjoint or partially-overlapping
  sets → not an augmenter (becomes a fresh canonical; per-criterion
  display will still surface the prior data via fallback).
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from .models import Run, RunDomain
from .schemas import AnalyzeSpec

# Criteria the runner knows about. Order matters only for hashing/printing,
# not semantics — augmentation is set-based.
_CRITERIA = (
    "backlinks", "refdomains", "anchors", "keywords", "stop_words",
    "wayback",
)


def _enabled_set_from_spec(spec: AnalyzeSpec) -> frozenset[str]:
    return frozenset(
        c for c in _CRITERIA
        if getattr(getattr(spec.criteria, c, None), "enabled", False)
    )


def _enabled_set_from_run(db: Session, run_id: int) -> frozenset[str]:
    """Read a Run's spec_json and return the enabled-criteria set. Empty
    set on a malformed/missing spec — the caller treats this as "can't
    establish an augmentation relationship," which is the safe default."""
    run = db.get(Run, run_id)
    if run is None or not run.spec_json:
        return frozenset()
    try:
        spec = AnalyzeSpec.model_validate(json.loads(run.spec_json))
    except (json.JSONDecodeError, ValueError):
        return frozenset()
    return _enabled_set_from_spec(spec)


def link_augmenters_for_run(db: Session, *, run_id: int) -> int:
    """Set `augments_rd_id` on every RunDomain in `run_id` whose criteria
    set is a strict subset of the latest prior RunDomain (any run, same
    domain). Returns the number of rows linked.

    Called once at run-creation time (after the RunDomains are inserted
    + committed). Idempotent: re-running for the same run_id does the
    same work and produces the same answer."""
    new_set = _enabled_set_from_run(db, run_id)
    if not new_set:
        # No criteria enabled (shouldn't happen — analyze rejects empty
        # specs) or spec couldn't be parsed; nothing to do.
        return 0

    new_rds = (
        db.query(RunDomain).filter(RunDomain.run_id == run_id).all()
    )
    if not new_rds:
        return 0

    # Cache enabled-set lookups per prior run so we don't re-parse spec_json
    # for every domain. At single-user scale this is plenty fast.
    set_cache: dict[int, frozenset[str]] = {run_id: new_set}

    def get_set(rid: int) -> frozenset[str]:
        if rid not in set_cache:
            set_cache[rid] = _enabled_set_from_run(db, rid)
        return set_cache[rid]

    n = 0
    # Hard cap on how deep we walk the prior-RD list per domain. The
    # loop almost always terminates on the first 1-2 iterations (the
    # most-recent prior usually IS a strict superset for an
    # augmentation-style smaller rerun), so 50 is generous overhead
    # rather than a real ceiling. Going deeper than this on a single
    # domain means dozens of consecutive non-matching prior runs, which
    # is pathological — accept a broken augmentation link rather than
    # eat an unbounded scan on a busy domain.
    PRIOR_SEARCH_CAP = 50
    for rd in new_rds:
        # Find the latest prior RunDomain for this domain (any job/run)
        # whose Run's enabled-criteria set is a STRICT SUPERSET. Ordering
        # by id desc reflects chronological order since RunDomain rows are
        # insertion-ordered. We iterate the query lazily (no .all() to
        # avoid materializing the full prior-RD list — most domains
        # find a match in the first 1-2 iterations) and cap depth.
        priors_query = (
            db.query(RunDomain)
            .filter(
                RunDomain.domain == rd.domain,
                RunDomain.id < rd.id,
            )
            .order_by(RunDomain.id.desc())
            .limit(PRIOR_SEARCH_CAP)
        )
        for prior in priors_query:
            prior_set = get_set(prior.run_id)
            if not prior_set:
                continue
            if new_set < prior_set:  # strict subset
                rd.augments_rd_id = prior.id
                n += 1
                break
    if n:
        db.commit()
    return n


def backfill_augmentation_for_existing_rows(db: Session) -> int:
    """Retroactive pass: walk every RunDomain (in id order) and link any
    that should have been marked as augmenters. Skips rows that already
    have a non-null `augments_rd_id`. Run once at startup; cheap at
    single-user scale.

    Returns the number of rows newly linked. Idempotent — running twice
    only links rows that were missed the first time."""
    set_cache: dict[int, frozenset[str]] = {}

    def get_set(rid: int) -> frozenset[str]:
        if rid not in set_cache:
            set_cache[rid] = _enabled_set_from_run(db, rid)
        return set_cache[rid]

    rds = (
        db.query(RunDomain)
        .order_by(RunDomain.id.asc())
        .all()
    )
    # Index priors by domain so we don't re-query the table per row.
    priors_by_domain: dict[str, list[RunDomain]] = {}
    n = 0
    for rd in rds:
        priors = priors_by_domain.setdefault(rd.domain, [])
        if rd.augments_rd_id is None:
            new_set = get_set(rd.run_id)
            if new_set:
                # Walk priors newest-first.
                for prior in reversed(priors):
                    prior_set = get_set(prior.run_id)
                    if not prior_set:
                        continue
                    if new_set < prior_set:
                        rd.augments_rd_id = prior.id
                        n += 1
                        break
        priors.append(rd)
    if n:
        db.commit()
    return n
