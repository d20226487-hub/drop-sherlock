"""Import-time domain filter — stop keywords + allowed-TLD whitelist.

Reshaped 2026-08-24 from the old ccTLD-blacklist-only filter into a
combined gate modeled on the "Spam Filter" (`allowed_tlds`):

  1. STOP KEYWORDS — a domain whose name contains any keyword (substring,
     anywhere, case-insensitive) is filtered out.
  2. ALLOWED-TLD WHITELIST — a domain whose TLD is NOT in the operator's
     `allowed_tlds` list is filtered out. The whitelist REUSES the
     existing Spam Filter list (one source of truth, shared with Linked
     Domains + SERP exports); this module never stores its own TLD list.

Performance is the whole point — this runs at `/backlog/import` over up to
the 10M-row import cap. The matcher is COMPILED ONCE (the caller builds it
outside the per-row loop) and every per-row check is O(len(domain)):

  - keywords via an Aho-Corasick automaton — one linear pass finds "any of
    N keywords" regardless of N. Benchmarked 2026-08-24: 500K domains ×
    250 keywords = 657ms, vs 3610ms for a single compiled-regex
    alternation (5.5× faster), identical hits. Pure-Python AC wins because
    it's one pass vs the regex NFA trying each alternative.
  - TLD via `allowed_tlds.make_tld_matcher` — a set lookup on the last
    label (plus endswith for the handful of multi-label suffixes).

The per-row result is a REASON string ("keyword" | "tld") or None, so the
import UI can report "skipped X by keyword / Y by TLD" separately.
"""
from __future__ import annotations

from collections import deque
from typing import Callable

from .allowed_tlds import make_tld_matcher, normalize_tld  # noqa: F401

# Caps — defensive against a pasted blob / runaway list. Keywords are
# short tokens; anything longer is almost certainly a mistake.
_KEYWORD_MAX_LEN = 64
_KEYWORDS_MAX_COUNT = 20_000


def normalize_keyword(raw: object) -> str | None:
    """Canonical stored form for one stop keyword: trimmed + lower-cased.

    Case-insensitive because domains are matched lower-cased. Returns None
    for anything unusable (non-string, empty, over-long) so callers can
    drop it. Whitespace is collapsed but NOT used as a separator — a
    keyword can legitimately be a multi-token substring."""
    if not isinstance(raw, str):
        return None
    v = " ".join(raw.strip().lower().split())
    if not v or len(v) > _KEYWORD_MAX_LEN:
        return None
    return v


def normalize_keywords(raw_list: object) -> list[str]:
    """Validate + dedup (first-seen order) + cap. Sorted for stable
    storage / display."""
    if not isinstance(raw_list, (list, tuple)):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw_list:
        v = normalize_keyword(item)
        if v is None or v in seen:
            continue
        seen.add(v)
        out.append(v)
        if len(out) >= _KEYWORDS_MAX_COUNT:
            break
    out.sort()
    return out


class AhoCorasick:
    """Minimal Aho-Corasick automaton for "does text contain any pattern".

    Built once from the keyword list; `contains()` is a single O(len(text))
    pass. Only answers the boolean membership question (the import filter
    needs the REASON category, not which specific keyword hit), which keeps
    the hot loop free of output-list bookkeeping.
    """

    __slots__ = ("_goto", "_fail", "_hit")

    def __init__(self, patterns: list[str]):
        # Node 0 is the root. Parallel arrays keyed by node id.
        goto: list[dict[str, int]] = [{}]
        # `hit[n]` = True if any pattern ends at node n OR at a node
        # reachable via fail links (folded in during the BFS below), so
        # `contains` never has to walk fail links at match time.
        hit: list[bool] = [False]

        def new_node() -> int:
            goto.append({})
            hit.append(False)
            return len(goto) - 1

        for pat in patterns:
            node = 0
            for ch in pat:
                nxt = goto[node].get(ch)
                if nxt is None:
                    nxt = new_node()
                    goto[node][ch] = nxt
                node = nxt
            if pat:
                hit[node] = True

        fail = [0] * len(goto)
        q: deque[int] = deque()
        for nxt in goto[0].values():
            fail[nxt] = 0
            q.append(nxt)
        while q:
            r = q.popleft()
            for ch, nxt in goto[r].items():
                q.append(nxt)
                f = fail[r]
                while f and ch not in goto[f]:
                    f = fail[f]
                fail[nxt] = goto[f].get(ch, 0) if (f or ch in goto[0]) else 0
                if hit[fail[nxt]]:
                    hit[nxt] = True
        self._goto = goto
        self._fail = fail
        self._hit = hit

    def contains(self, text: str) -> bool:
        goto = self._goto
        fail = self._fail
        hit = self._hit
        node = 0
        for ch in text:
            while node and ch not in goto[node]:
                node = fail[node]
            node = goto[node].get(ch, 0)
            if hit[node]:
                return True
        return False


def build_matcher(
    *,
    keywords: list[str],
    allowed_tlds: list[str] | None,
    tld_whitelist_enabled: bool,
) -> Callable[[str], str | None]:
    """Compile the filter ONCE and return `match(domain) -> reason|None`.

    reason is "keyword" or "tld"; None means the domain passes. The
    returned closure does NO DB access and NO recompilation — call it in
    the hot per-row loop.

    Check order is cheap-first: the TLD test is a set lookup, the keyword
    test is an automaton pass, so testing TLD first lets a non-allowed-TLD
    domain short-circuit before the (costlier) keyword scan. When the TLD
    whitelist is disabled, only keywords run.
    """
    kws = normalize_keywords(keywords)
    ac = AhoCorasick(kws) if kws else None

    tld_match = None
    if tld_whitelist_enabled and allowed_tlds:
        tld_match = make_tld_matcher(allowed_tlds)

    def match(domain: str) -> str | None:
        if not domain:
            return None
        d = domain.strip().lower()
        if d.startswith("www."):
            d = d[4:]
        if not d:
            return None
        # Cheap reject first: TLD not in the whitelist.
        if tld_match is not None and not tld_match(d):
            return "tld"
        if ac is not None and ac.contains(d):
            return "keyword"
        return None

    return match
