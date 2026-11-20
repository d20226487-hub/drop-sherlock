"""Backlink languages — the Database page's "Язык ссылок" filter (2026-11-20).

Every backlinks row Ahrefs returns carries `languages`, the language(s) of
the donor page (`["en"]`, sometimes several). For each domain the Database
snapshot keeps how many of its fetched backlinks fall in each language set,
keyed by the set's sorted codes joined with "," ("en", "en,ru"). Keeping
sets rather than per-language totals lets the filter count a backlink that
is in BOTH selected languages once.

Counts cover the backlinks the check fetched (the Backlinks criterion's row
limit), not Ahrefs' full total.

Parsing a backlinks result is the costly part of the rebuild, so counts are
cached per CriterionResult and recomputed only when it was refetched."""
from __future__ import annotations

_cache: dict[int, tuple[tuple, dict[str, int]]] = {}


def language_sets(cr) -> dict[str, int]:
    """{"en": 15, "en,ru": 2, ...} for one backlinks CriterionResult."""
    import json
    key = (cr.fetched_at, len(cr.data_json or ""))
    hit = _cache.get(cr.id)
    if hit is not None and hit[0] == key:
        return hit[1]
    counts: dict[str, int] = {}
    try:
        body = json.loads(cr.data_json) if cr.data_json else None
    except json.JSONDecodeError:
        body = None
    rows = body.get("backlinks") if isinstance(body, dict) else None
    for row in rows if isinstance(rows, list) else []:
        langs = row.get("languages") if isinstance(row, dict) else None
        if isinstance(langs, str):
            langs = [langs]
        codes = sorted({str(x).strip().lower() for x in langs or [] if str(x).strip()})
        if codes:
            k = ",".join(codes)
            counts[k] = counts.get(k, 0) + 1
    _cache[cr.id] = (key, counts)
    return counts


def count_matching(sets: dict[str, int], selected: list[str]) -> int:
    """Backlinks whose donor page is in ANY of the selected languages."""
    wanted = {s.lower() for s in selected}
    return sum(n for k, n in sets.items() if wanted.intersection(k.split(",")))


def languages_in(sets: dict[str, int]) -> set[str]:
    return {code for k in sets for code in k.split(",")}
