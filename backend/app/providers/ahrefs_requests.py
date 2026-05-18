"""Canonical Ahrefs request builder for the Analyze flow.

Produces the exact GET URL — including `where`, `order_by`, `select`, `limit`,
`target` — that step 5 will fetch. Used by `/analyze/preview` so the UI can
show the user what will hit Ahrefs *before* they submit.

User-locked decisions reflected here:
- `history` parameter is NOT included → Ahrefs returns live data.
- `where` JSON shape: `{"and": [{"field": ..., "is": ["eq", N]}, ...]}`.
- Sort fields locked: domain_rating_source, url_rating_source, traffic_domain,
  refdomains_source, positions.
- "Non-spammy" = `is_spam=0` only; not layered with DR/traffic thresholds.
- Anchors does not expose `is_spam` — UI omits the filter, builder skips it.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urlencode

from ..schemas import (
    AnalyzeSpec,
    AnchorsConfig,
    BacklinksConfig,
    KeywordsConfig,
    PreviewedRequest,
    RefdomainsConfig,
    SortRule,
    WaybackConfig,
)

API_BASE = "https://api.ahrefs.com/v3/site-explorer"

# `select` field lists per criterion — copied from the user's working curl
# examples for backlinks/refdomains, plus sensible defaults for anchors and
# organic keywords. Keep them comprehensive: AI verdicts are stronger when
# the model has more signal, and the field set is cheap to send.
SELECT_FIELDS: dict[str, list[str]] = {
    # Trimmed 2026-05-10 from 24 → 15 columns to lower Ahrefs unit cost.
    # Dropped: link_type, is_dofollow, is_nofollow, is_ugc, is_sponsored,
    # is_content, is_spam, http_code, powered_by — the four
    # dofollow/nofollow/ugc/sponsored flags are made redundant by the
    # default fetch-side filters (dofollow=true, non_spammy=true,
    # content_only=true), and is_spam / link_type / is_content are
    # therefore implicit on every returned row. The AI now reads the
    # snippet_left / snippet_right context directly to judge whether a
    # link is editorial in-body vs boilerplate.
    "backlinks": [
        "url_from",
        "title",
        "languages",
        "first_seen_link",
        "last_seen",
        "domain_rating_source",
        "url_rating_source",
        # 2026-05-18: dropped `traffic_domain` and `traffic` for cost
        # reduction. The AI verdict now weights DR / UR / refdomains_source
        # / anchor + snippets / positions; raw traffic numbers were the
        # most-expensive column group on this endpoint. Sort by these
        # fields still works (Ahrefs allows ordering on non-selected
        # columns), so the existing sort dropdown is unaffected.
        "positions",
        "refdomains_source",
        "anchor",
        "snippet_left",
        "snippet_right",
        "url_to",
    ],
    # Trimmed 2026-05-10: dropped is_spam — already filtered out at fetch
    # time via the default non_spammy=true filter, so every returned row
    # has is_spam=0. The prompt no longer references it.
    "refdomains": [
        "domain",
        "links_to_target",
        "first_seen",
        "last_seen",
        "domain_rating",
        "dofollow_refdomains",
        "dofollow_linked_domains",
        "traffic_domain",
        # 2026-05-18: dropped `positions_source_domain` for cost
        # reduction. `traffic_domain` is kept because the AI uses it
        # as the primary signal of "real traffic on this source vs
        # zero-traffic high-DR shell"; ranking-keyword count was a
        # redundant secondary signal.
        "new_links",
        "lost_links",
        "dofollow_links",
    ],
    # Verified against Ahrefs's "available columns" error reply on 2026-05-05.
    # Trimmed 2026-05-10: dropped is_spam — Ahrefs's per-anchor spam flag
    # is unreliable enough on the anchors endpoint that we skip it
    # rather than mislead the verdict; spam-link detection lives on the
    # backlinks criterion + fetch-side filters.
    "anchors": [
        "anchor",
        "refdomains",
        "refpages",
        "dofollow_links",
        "links_to_target",
        "top_domain_rating",
        "new_links",
        "lost_links",
        "first_seen",
        "last_seen",
    ],
    # Trimmed 2026-05-10 from 11 → 6 columns to lower Ahrefs unit cost
    # on the organic-keywords endpoint (was ~38 units/row, expected ~25
    # after this trim — re-measured on the next run). Dropped:
    #   - keyword_country / keyword_language: AI prompt didn't materially
    #     use them; geographic concentration was nice-to-have signal.
    #   - cpc: soft "commercial value" hint; is_branded + keyword_difficulty
    #     cover intent well enough.
    #   - best_position_url / best_position_kind: never referenced by the
    #     keywords prompt; URL/SERP-feature lookup is among the more
    #     expensive column groups Ahrefs charges for.
    # Keep: keyword (context), sum_traffic + volume (real demand),
    # best_position (rank quality), keyword_difficulty (signal strength),
    # is_branded (intent mix).
    "keywords": [
        "keyword",
        "sum_traffic",
        "volume",
        "best_position",
        "keyword_difficulty",
        "is_branded",
    ],
}

# Map our criterion key → Ahrefs path segment.
CRITERION_PATH = {
    "backlinks": "all-backlinks",
    "refdomains": "refdomains",
    "anchors": "anchors",
    "keywords": "organic-keywords",
}


def _normalize_target(domain: str) -> str:
    """Ahrefs accepts `example.com/` for a root-domain target. Strip schemes
    and trailing extras so a user pasting `https://example.com` Just Works."""
    d = domain.strip()
    if not d:
        return d
    for prefix in ("https://", "http://"):
        if d.startswith(prefix):
            d = d[len(prefix) :]
    d = d.split("/", 1)[0]
    return f"{d}/"


def _build_where(filters: object, criterion: str) -> dict | None:
    """Convert filter toggles → Ahrefs `where` JSON. Returns None when no
    clauses are active (so we don't send an empty `and: []`).

    Top-level shape is always `{"and": [...]}`. Multi-value filters
    (languages, domain_contains) are emitted as nested `{"or": [...]}`
    clauses so "any of these" semantics works inside the AND.
    """
    clauses: list[dict] = []
    f = filters
    if getattr(f, "dofollow", False) and getattr(f, "nofollow", False):
        # Both checked = no constraint (matches what the user expects from a
        # "select all" UI). Skip emitting either clause.
        pass
    elif getattr(f, "dofollow", False):
        clauses.append({"field": "is_dofollow", "is": ["eq", 1]})
    elif getattr(f, "nofollow", False):
        clauses.append({"field": "is_nofollow", "is": ["eq", 1]})
    if criterion != "anchors" and getattr(f, "non_spammy", False):
        clauses.append({"field": "is_spam", "is": ["eq", 0]})

    # Backlinks-only: hardcode link_type=text (locked 2026-05-06). Drops
    # image / redirect / canonical / frame backlinks from every query — the
    # user's workflow is text-link discovery and they never want the noise.
    # Cache invariant: `compute_params_hash` includes "link_type=text" for
    # backlinks so existing cache rows correctly miss after this change.
    if criterion == "backlinks":
        clauses.append({"field": "link_type", "is": ["eq", "text"]})

    # Backlinks-only: optional "exclude noindex referring pages" toggle.
    # Ahrefs's column is bare `noindex` (boolean), NOT `is_noindex_source`.
    # Probed live on 2026-05-07 — Ahrefs returned 400 "column 'is_noindex_source'
    # not found"; row payload shows `"noindex": true` confirming the bare name.
    if criterion == "backlinks" and getattr(f, "noindex_exclude", False):
        clauses.append({"field": "noindex", "is": ["eq", 0]})

    # Backlinks-only: optional "editorial in-content links only" toggle.
    # Currently we send no is_content filter, which means every placement
    # comes back (footer / sidebar / nav / comments / in-content). Setting
    # this restricts to the highest-signal editorial body links.
    if criterion == "backlinks" and getattr(f, "content_only", False):
        clauses.append({"field": "is_content", "is": ["eq", 1]})

    # Languages (backlinks only — `languages` is a per-row array). One eq
    # clause per code, OR'd. Ahrefs's eq on an array column tests
    # membership, so this matches "row's languages array contains the code."
    if criterion == "backlinks":
        langs = [str(x).strip() for x in (getattr(f, "languages", None) or [])]
        langs = [x for x in langs if x]
        if langs:
            clauses.append({
                "or": [
                    {"field": "languages", "is": ["eq", l]} for l in langs
                ]
            })

    # Domain-contains (backlinks + refdomains). OR of substring clauses on
    # the appropriate field name. For backlinks the referring root domain
    # is `root_name_source`; for refdomains the row's `domain` column.
    domain_terms = [
        str(x).strip()
        for x in (getattr(f, "domain_contains", None) or [])
    ]
    domain_terms = [x for x in domain_terms if x]
    if domain_terms and criterion in ("backlinks", "refdomains"):
        field = "root_name_source" if criterion == "backlinks" else "domain"
        clauses.append({
            "or": [
                {"field": field, "is": ["substring", t]} for t in domain_terms
            ]
        })

    # DR bounds (backlinks + refdomains). Two clauses (gte and lte) emitted
    # independently — set one, both, or neither. Field name differs:
    # backlinks endpoint uses `domain_rating_source` (DR of the referring
    # domain); refdomains endpoint uses the bare `domain_rating`.
    if criterion in ("backlinks", "refdomains"):
        dr_field = (
            "domain_rating_source" if criterion == "backlinks" else "domain_rating"
        )
        dr_min = getattr(f, "dr_min", None)
        if isinstance(dr_min, int):
            clauses.append({"field": dr_field, "is": ["gte", dr_min]})
        dr_max = getattr(f, "dr_max", None)
        if isinstance(dr_max, int):
            clauses.append({"field": dr_field, "is": ["lte", dr_max]})

    # Backlinks-only range filters (added 2026-05-08). All three are
    # source-page metrics on the referring URL — UR (`url_rating_source`),
    # estimated organic traffic (`traffic`), and # of ranking keywords
    # (`positions`). Same gte/lte pattern as DR.
    if criterion == "backlinks":
        for attr_min, attr_max, field in (
            ("ur_min", "ur_max", "url_rating_source"),
            ("traffic_min", "traffic_max", "traffic"),
            ("positions_min", "positions_max", "positions"),
        ):
            v_min = getattr(f, attr_min, None)
            if isinstance(v_min, int):
                clauses.append({"field": field, "is": ["gte", v_min]})
            v_max = getattr(f, attr_max, None)
            if isinstance(v_max, int):
                clauses.append({"field": field, "is": ["lte", v_max]})

    if not clauses:
        return None
    return {"and": clauses}


def _build_order_by(sort: list[SortRule] | None) -> str | None:
    if not sort:
        return None
    return ",".join(f"{r.field}:{r.direction}" for r in sort)


def _today_iso() -> str:
    """Today's UTC date in YYYY-MM-DD. Used for endpoints that require a
    `date` snapshot parameter (currently organic-keywords)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# Predefined "date_compared" buckets for the Ahrefs organic-keywords
# endpoint (2026-05-17). Maps the user-facing dropdown choice to a
# relative offset that gets subtracted from today's UTC date at request
# build time. "off" is omitted — the caller skips the parameter
# entirely so the URL stays comparison-free (legacy behaviour).
#
# Months are approximated as 30/31 days via dateutil-free arithmetic
# (chose stdlib over adding a dep). Off-by-a-day at month boundaries is
# fine — Ahrefs snaps date_compared to the nearest snapshot it has.
_DATE_COMPARED_DELTAS_DAYS: dict[str, int] = {
    "3m": 30 * 3,
    "6m": 30 * 6,
    "1y": 365,
    "2y": 365 * 2,
    "5y": 365 * 5,
}


def _resolve_date_compared(choice: str) -> str | None:
    """Translate a `KeywordsConfig.date_compared` enum value into the
    YYYY-MM-DD string Ahrefs expects. Returns None when the user picked
    'off' (or any unknown sentinel) so the caller can skip the param."""
    days = _DATE_COMPARED_DELTAS_DAYS.get(choice)
    if days is None:
        return None
    from datetime import timedelta
    return (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).strftime("%Y-%m-%d")


def _build_url(
    *,
    criterion: str,
    target: str,
    select: Iterable[str],
    limit: int,
    where: dict | None,
    order_by: str | None,
    extra: dict[str, str] | None = None,
) -> str:
    """Compose the GET URL exactly as Ahrefs expects it. urllib's urlencode
    handles % and , and {} encoding — that's what produces the same output
    your curl examples do."""
    params: list[tuple[str, str]] = [
        ("limit", str(limit)),
        ("select", ",".join(select)),
        ("target", target),
    ]
    if extra:
        for k, v in extra.items():
            params.append((k, v))
    if order_by:
        params.append(("order_by", order_by))
    if where is not None:
        # JSON with no spaces — matches Ahrefs's expected format and keeps
        # the URL short enough to skim.
        params.append(("where", json.dumps(where, separators=(",", ":"))))
    # Default urlencode encodes reserved chars (`/`, `:`, `,`, `{`, `"`,
    # etc.) — matches the encoding of the curl examples in Ahrefs's docs and
    # the URL httpx will put on the wire in step 5.
    qs = urlencode(params)
    path = CRITERION_PATH[criterion]
    return f"{API_BASE}/{path}?{qs}"


# --- Per-criterion adapters --------------------------------------------------

def _preview_backlinks(domain: str, cfg: BacklinksConfig) -> PreviewedRequest:
    where = _build_where(cfg.filters, "backlinks")
    order_by = _build_order_by(cfg.sort)
    url = _build_url(
        criterion="backlinks",
        target=_normalize_target(domain),
        select=SELECT_FIELDS["backlinks"],
        limit=cfg.limit,
        where=where,
        order_by=order_by,
        extra={"aggregation": cfg.aggregation},
    )
    return PreviewedRequest(
        criterion="backlinks",
        enabled=cfg.enabled,
        url=url,
        where=where,
        order_by=order_by,
        limit=cfg.limit,
    )


def _preview_refdomains(domain: str, cfg: RefdomainsConfig) -> PreviewedRequest:
    where = _build_where(cfg.filters, "refdomains")
    order_by = _build_order_by(cfg.sort)
    url = _build_url(
        criterion="refdomains",
        target=_normalize_target(domain),
        select=SELECT_FIELDS["refdomains"],
        limit=cfg.limit,
        where=where,
        order_by=order_by,
    )
    return PreviewedRequest(
        criterion="refdomains",
        enabled=cfg.enabled,
        url=url,
        where=where,
        order_by=order_by,
        limit=cfg.limit,
    )


def _preview_anchors(domain: str, cfg: AnchorsConfig) -> PreviewedRequest:
    where = _build_where(cfg.filters, "anchors")
    order_by = _build_order_by(cfg.sort)
    url = _build_url(
        criterion="anchors",
        target=_normalize_target(domain),
        select=SELECT_FIELDS["anchors"],
        limit=cfg.limit,
        where=where,
        order_by=order_by,
    )
    return PreviewedRequest(
        criterion="anchors",
        enabled=cfg.enabled,
        url=url,
        where=where,
        order_by=order_by,
        limit=cfg.limit,
    )


# Wayback CDX request builder. Different base URL from Ahrefs (CDX is a
# free, separate service) — we keep it in this module anyway for symmetry
# with the rest of the per-criterion request builders.
WAYBACK_CDX_BASE = "https://web.archive.org/cdx/search/cdx"

# Columns we ask CDX to return. The full schema includes urlkey, original,
# robotflags, etc. — we keep what informs the AI verdict and drop the rest
# to keep payloads small.
WAYBACK_FIELDS = [
    "timestamp",
    "original",
    "statuscode",
    "mimetype",
    "length",
    "digest",
]


def _preview_wayback(domain: str, cfg: WaybackConfig) -> PreviewedRequest:
    """Build a CDX URL for `domain`. Defaults to `match_type=domain` so we
    catch subdomains too (typical for dropped-domain triage). Collapsing
    on `timestamp:6` (~month) reduces noise from densely-crawled sites
    without losing event-level signal."""
    target_url = domain.strip()
    for prefix in ("https://", "http://"):
        if target_url.startswith(prefix):
            target_url = target_url[len(prefix):]
    target_url = target_url.split("/", 1)[0]

    params: list[tuple[str, str]] = [
        ("url", target_url),
        ("output", "json"),
        ("fl", ",".join(WAYBACK_FIELDS)),
        ("limit", str(cfg.limit)),
    ]
    f = cfg.filters
    if f.from_year:
        params.append(("from", f"{f.from_year}0101"))
    if f.to_year:
        params.append(("to", f"{f.to_year}1231"))
    if f.match_type and f.match_type != "exact":
        params.append(("matchType", f.match_type))
    if f.collapse:
        params.append(("collapse", f.collapse))
    qs = urlencode(params)
    url = f"{WAYBACK_CDX_BASE}?{qs}"
    return PreviewedRequest(
        criterion="wayback",
        enabled=cfg.enabled,
        url=url,
        where=None,
        order_by=None,
        limit=cfg.limit,
    )


def _preview_keywords(domain: str, cfg: KeywordsConfig) -> PreviewedRequest:
    # organic-keywords requires a `date` snapshot parameter. For our locked
    # "live" mode we send today's UTC date — matches what the Ahrefs UI uses
    # when no explicit date filter is set.
    order_by = _build_order_by(cfg.sort)
    extra: dict[str, str] = {"date": _today_iso()}
    # Optional `date_compared` (2026-05-17) — Ahrefs returns one row per
    # "keyword event" (gained / lost / changed); rows for keywords that
    # exist at one date but not the other carry null base fields, and
    # the historical values land on `_prev` mirrors. Originally we sent
    # only base SELECT fields and got back all-null rows (verified live
    # on kotopes.kz: 165 units billed, every base field null). Fix:
    # augment SELECT with `_prev` mirrors of the columns that have
    # historical analogs so the AI judge sees both periods.
    select = list(SELECT_FIELDS["keywords"])
    dc = _resolve_date_compared(cfg.date_compared)
    if dc is not None:
        extra["date_compared"] = dc
        # `is_branded` doesn't have a `_prev` mirror — Ahrefs returns
        # the current-period value only. The rest do.
        for f in (
            "keyword",
            "sum_traffic",
            "volume",
            "best_position",
            "keyword_difficulty",
        ):
            prev = f"{f}_prev"
            if prev not in select:
                select.append(prev)
    url = _build_url(
        criterion="keywords",
        target=_normalize_target(domain),
        select=select,
        limit=cfg.limit,
        where=None,
        order_by=order_by,
        extra=extra,
    )
    return PreviewedRequest(
        criterion="keywords",
        enabled=cfg.enabled,
        url=url,
        where=None,
        order_by=order_by,
        limit=cfg.limit,
    )


def build_preview(spec: AnalyzeSpec) -> tuple[str | None, list[PreviewedRequest]]:
    """Returns (example_domain, requests). Example domain is the first
    non-empty entry in `spec.domains`, or a placeholder if the list is empty
    (so the user always sees a working URL preview while typing)."""
    cleaned = [d.strip() for d in spec.domains if d.strip()]
    domain = cleaned[0] if cleaned else "example.com"
    requests = [
        _preview_backlinks(domain, spec.criteria.backlinks),
        _preview_refdomains(domain, spec.criteria.refdomains),
        _preview_anchors(domain, spec.criteria.anchors),
        _preview_keywords(domain, spec.criteria.keywords),
        _preview_wayback(domain, spec.criteria.wayback),
    ]
    return (domain if cleaned else None), requests
