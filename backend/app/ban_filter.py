"""Central ban-list filter — single source of truth for "is this domain
banned?" checks. Called from every domain ingestion path so the ban list
can't be leaky:

  - backlog.py CSV/paste import
  - database.py per-row + bulk Order/Discard upserts
  - tasks.py availability cascade auto-upsert
  - analyze submit endpoint

The lookup is a single IN-list query; for the typical caller list of
≤1000 domains the round-trip is sub-millisecond. We deliberately don't
cache the ban set in memory — it's not on the hot path and stale-cache
risk (banning a domain then having an in-flight upload still let it
through) outweighs the negligible query cost.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from .models import DomainBan

# SQLite caps the number of bound parameters in a single statement
# (SQLITE_MAX_VARIABLE_NUMBER — 999 on old builds, 32766 on 3.32+). A
# bulk backlog import can pass hundreds of thousands / millions of
# domains, so the IN-list below MUST be chunked or it raises
# "too many SQL variables" and 500s the whole import. 900 is safe on
# every SQLite version; the extra round-trips are negligible next to the
# rest of a large import.
_IN_CHUNK = 900


def filter_banned(
    db: Session, domains: list[str],
) -> tuple[list[str], set[str]]:
    """Split `domains` into (allowed, banned_set). Inputs MUST already be
    normalized (lowercase, scheme/path stripped) — callers do their own
    normalization since they often need it for other reasons (dedupe,
    DB lookup keys, etc.). Returns:

      - allowed: list of domains NOT on the ban list, in the original
        input order. Duplicates preserved (caller's responsibility).
      - banned_set: set of domains that WERE on the ban list. Useful
        for "X domains skipped (banned)" toast messages.

    Empty input → ([], set()). Empty ban table → (domains, set()).
    """
    if not domains:
        return [], set()
    # IN-list against the (small) subset relevant to this call, chunked so
    # a million-domain import doesn't overflow SQLite's bound-parameter
    # limit. For the common ≤900-domain caller this is a single query —
    # identical to the pre-chunking behavior.
    unique = list({d for d in domains if d})
    if not unique:
        return [], set()
    banned: set[str] = set()
    for i in range(0, len(unique), _IN_CHUNK):
        chunk = unique[i : i + _IN_CHUNK]
        banned.update(
            b.domain
            for b in db.query(DomainBan.domain)
            .filter(DomainBan.domain.in_(chunk))
            .all()
        )
    if not banned:
        return list(domains), set()
    allowed = [d for d in domains if d and d not in banned]
    return allowed, banned


def is_banned(db: Session, domain: str) -> bool:
    """Single-domain convenience for hot paths that already hold a `db`
    session and only need a yes/no answer. Returns False on empty
    input."""
    if not domain:
        return False
    return db.get(DomainBan, domain) is not None
