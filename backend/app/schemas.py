"""Pydantic schemas for the Analyze flow.

Kept deliberately narrow at step 4 — only what's needed to build a request
preview. Step 5 will reuse these for actual job execution; step 7 will add
AI-side schemas for verdicts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# --- Filters & sort ----------------------------------------------------------

# `link_type=text` is hardcoded on every backlinks request (per user
# decision 2026-05-06) — drops image / redirect / canonical / frame links.
# Not exposed as a toggle.
class BacklinksFilters(BaseModel):
    # Defaults (revised 2026-05-08): dofollow / non_spammy / noindex_exclude
    # / content_only flipped to True so the most common "give me clean,
    # indexable, in-content editorial links" intent doesn't require ticking
    # 5 boxes. Old saved specs in spec_json keep whatever the user
    # explicitly chose; these defaults only apply to fresh
    # BacklinksFilters() instances.
    dofollow: bool = True
    nofollow: bool = False
    non_spammy: bool = True  # is_spam=0 in the where clause
    # When True, exclude backlinks whose REFERRING page has a noindex meta
    # tag. Maps to `is_noindex_source=0`. Default-on.
    noindex_exclude: bool = True
    # When True, restrict to editorial in-content links only (sets
    # `is_content=1`). Without it the response includes footer / sidebar /
    # sitewide / comment / nav links too. Default-on.
    content_only: bool = True
    # When True, drop backlinks whose REFERRING URL lives on a subdomain
    # — keep only those whose referring URL is on a root domain. Maps to
    # `is_root_source=1` in the where clause (added 2026-05-18). Default-on:
    # subdomain backlinks are usually weaker editorial signal + much more
    # likely to be a self-network footprint (one root × dozens of
    # subdomains masquerading as diverse refdomains). User can disable
    # per-run when they specifically want to study subdomain link
    # patterns.
    root_only: bool = True
    # ISO 639-1 language codes (e.g. ["en", "ru"]). Empty = no filter.
    # Each row's `languages` field is an array; we OR-match per code.
    languages: list[str] = Field(default_factory=list)
    # Substrings to match against the referring root domain
    # (`root_name_source`). Multi-value, OR-matched — e.g. ["kz","uz","ru"]
    # gives "any of these in the domain name." Empty = no filter.
    domain_contains: list[str] = Field(default_factory=list)
    # Domain Rating bounds for the referring domain (`domain_rating_source`
    # field). Either / both can be set independently; null = unbounded.
    dr_min: int | None = Field(default=None, ge=0, le=100)
    dr_max: int | None = Field(default=None, ge=0, le=100)
    # URL Rating bounds for the referring URL (`url_rating_source` field).
    # 0–100 like DR. Either / both / neither.
    ur_min: int | None = Field(default=None, ge=0, le=100)
    ur_max: int | None = Field(default=None, ge=0, le=100)
    # Source-page organic traffic bounds (`traffic` field on the backlinks
    # endpoint — estimated monthly organic visits). Integer, no upper cap.
    traffic_min: int | None = Field(default=None, ge=0)
    traffic_max: int | None = Field(default=None, ge=0)
    # Number of organic keywords the source page ranks for (`positions`
    # field on the backlinks endpoint). Integer, no upper cap.
    positions_min: int | None = Field(default=None, ge=0)
    positions_max: int | None = Field(default=None, ge=0)


class RefdomainsFilters(BaseModel):
    dofollow: bool = False
    nofollow: bool = False
    non_spammy: bool = False
    # Substrings to match against the refdomain name (`domain` column).
    # Same semantics as the backlinks version. Empty = no filter.
    domain_contains: list[str] = Field(default_factory=list)
    # Domain Rating bounds for the refdomain itself (`domain_rating`
    # field — note: not `_source`; refdomains endpoint uses the bare name).
    dr_min: int | None = Field(default=None, ge=0, le=100)
    dr_max: int | None = Field(default=None, ge=0, le=100)


class AnchorsFilters(BaseModel):
    # Per user decision: anchors get no non-spammy filter.
    dofollow: bool = False
    nofollow: bool = False


class WaybackFilters(BaseModel):
    """CDX query filters. `from_year`/`to_year` clamp the snapshot range to
    a window — useful for domains with deep history where we only care
    about recent activity. Empty = unbounded."""
    from_year: int | None = Field(default=None, ge=1996, le=2100)
    to_year: int | None = Field(default=None, ge=1996, le=2100)
    # CDX `match_type`. "exact" = only the exact URL.
    # "prefix" = URL starts with the target.
    # "host" = entire single host (no subdomains) — DEFAULT, much faster
    # on CDX's slow free backend, gives the same dropped-domain triage
    # signal in 95% of cases.
    # "domain" = host + all subdomains. The heaviest CDX query shape;
    # opt-in for cases where subdomain history matters. Batch-running
    # 20+ domains with `domain` cascades into ConnectTimeouts (caught
    # 2026-05-07 in production: 31/35 failures on a 35-domain batch).
    match_type: Literal["exact", "prefix", "host", "domain"] = "host"
    # CDX `collapse=N` collapses consecutive snapshots that share the same
    # field value (default `timestamp:6` ≈ same month). Reduces noise from
    # densely-crawled sites without losing event-level signal. Empty = no
    # collapsing.
    collapse: str = "timestamp:6"


# Union of every sort field across all criteria. Per-criterion validity is
# enforced loosely (Ahrefs will reject mismatched fields with a 4xx); the UI
# only offers fields we know are valid for the chosen criterion.
SortField = Literal[
    # backlinks
    "domain_rating_source",
    "url_rating_source",
    "traffic_domain",
    "refdomains_source",
    "positions",
    "traffic",
    "first_seen_link",
    # refdomains / anchors share several
    "links_to_target",
    "new_links",
    "first_seen",
    # anchors
    "refdomains",
    # keywords
    "volume_mobile_pct",
    "sum_traffic",
    "is_best_position_set_top_11_50",
    # wayback (CDX) — sort happens server-side via the CDX API's natural
    # order, but we accept these for symmetry with the rest of the UI.
    "timestamp",
]


class SortRule(BaseModel):
    field: SortField
    direction: Literal["asc", "desc"] = "desc"


# --- Per-criterion configs ---------------------------------------------------

class CriterionBase(BaseModel):
    enabled: bool = True
    # Default lowered from 100 to 20 on 2026-05-08. With "1_per_domain"
    # aggregation on Backlinks and the comparable per-domain dedup the AI
    # judge applies on the other criteria, 20 rows is already strong
    # signal and keeps Ahrefs unit cost predictable. Cap stays at 1000
    # so users who want more can raise it in the UI.
    limit: int = Field(default=20, ge=1, le=1000)


# Backlinks aggregation mode. Ahrefs accepts:
#   - all            : no dedup; can include many near-duplicate pages
#   - similar_links  : Ahrefs default; collapses near-duplicates
#   - 1_per_domain   : one row per referring domain (max diversity per limit)
# Note: aggregation does NOT change the per-request unit cost (cost = limit),
# so this is about signal quality, not credit savings.
BacklinksAggregation = Literal["all", "similar_links", "1_per_domain"]


class BacklinksConfig(CriterionBase):
    # `limit` inherits from CriterionBase (default 20).
    filters: BacklinksFilters = Field(default_factory=BacklinksFilters)
    sort: list[SortRule] = Field(default_factory=list)
    # Default flipped to "1_per_domain" (was "similar_links") on
    # 2026-05-08 — the new Backlinks card surfaces a single "1 per domain"
    # checkbox instead of the 3-mode dropdown, and "1 per domain" is the
    # most useful aggregation for AI judging (one row per source domain
    # avoids the model double-counting site-wide links).
    aggregation: BacklinksAggregation = "1_per_domain"


class RefdomainsConfig(CriterionBase):
    filters: RefdomainsFilters = Field(default_factory=RefdomainsFilters)
    sort: list[SortRule] = Field(default_factory=list)


class AnchorsConfig(CriterionBase):
    filters: AnchorsFilters = Field(default_factory=AnchorsFilters)
    sort: list[SortRule] = Field(default_factory=list)


DateComparedChoice = Literal["off", "3m", "6m", "1y", "2y", "5y"]


class KeywordsConfig(CriterionBase):
    sort: list[SortRule] = Field(default_factory=list)
    # date_compared (2026-05-17) — Ahrefs organic-keywords parameter that
    # adds prior-period `_prev` fields to the response so the AI judge can
    # see trend (growing vs decaying keyword footprint). Predefined buckets
    # mirror Ahrefs's own UI choices; resolved to an absolute YYYY-MM-DD
    # at request build time relative to the request's `date` snapshot.
    # "off" = no comparison parameter sent (legacy behaviour).
    date_compared: DateComparedChoice = "off"


class WaybackConfig(BaseModel):
    """Wayback CDX criterion. Defaults to OFF — opt-in per user (added
    2026-05-07). Limit defaults to 100 (was 200) and is hard-capped at
    200 (was 5000) because CDX's free backend chokes on larger queries
    in batches: 100 rows already saturates the AI judge's confidence
    ceiling (~50 distinct snapshots is plenty signal), and tighter caps
    prevent the user from accidentally configuring a job that will
    cascade-timeout. Increase the cap manually only when triaging a
    single domain you actually care about deep history for.

    V2 page-content sampling (added 2026-05-07): when `sample_pages=True`
    the runner additionally fetches a handful of archived HTML pages
    (`web.archive.org/web/{ts}id_/{url}`) and extracts title + headings +
    body excerpt. Lets the AI judge spot year-over-year theme drift
    (e.g. "Pizza recipes 2018 → Casino bonuses 2024"). Slow + opt-in
    even within an opt-in criterion because it adds 1–3s per snapshot."""
    enabled: bool = False
    limit: int = Field(default=100, ge=1, le=200)
    filters: WaybackFilters = Field(default_factory=WaybackFilters)
    sort: list[SortRule] = Field(default_factory=list)
    sample_pages: bool = False
    sample_count: int = Field(default=6, ge=1, le=15)
    # "even" = quantile-spaced across the CDX timeline (filtered to 200/html).
    # "anchor" = pick around CDX anomaly events (status flips, mimetype
    # changes, big length jumps, long crawl gaps) — denser signal at
    # transition points, fewer wasted picks on uniform stretches.
    sample_strategy: Literal["even", "anchor"] = "even"
    # "mixed" = use the URL each chosen CDX row points at (`original`).
    # "root" = always fetch the snapshot of `/`. Mixed surfaces subpage
    # content; root keeps comparisons apples-to-apples but misses
    # subpage-only sites.
    sample_path_mode: Literal["mixed", "root"] = "mixed"
    # AI judge prompt variant (added 2026-06-07). "white" = default
    # white-niche prompt; "grey" = grey-niche prompt (adult / gambling
    # drops, where some signals carry inverted polarity — adult content
    # may be expected rather than a red flag). Routed at judge-time via
    # `get_ai_prompt(f"wayback_{variant}")` in `tasks._judge_one_
    # criterion`. The cache key bakes in the full system prompt text, so
    # a variant flip produces a fresh AI call (no stale-cache risk).
    # Scope: Wayback Quality ONLY — the other criteria (backlinks /
    # refdomains / anchors / keywords / wayback_classify / final) and
    # the other pillars (Whois / Availability / Ahrefs Batch) are
    # untouched in this wave.
    variant: Literal["white", "grey"] = "white"


class WaybackClassifyConfig(BaseModel):
    """Wayback-derived classification: language + theme + auto-chained
    category (added 2026-05-09). Reads the wayback criterion's V2 page
    samples — does NOT fetch on its own. When `enabled=True` the runner
    auto-flips Wayback's `enabled=True` and `sample_pages=True` if they
    aren't already (auto-enable design — see Analyze page card hint).

    `language_mode` controls how language is derived:
      • "ai"      = AI prompt asks for both language + theme in one call,
                    using `<html lang>` from sampled HTML as a hint when
                    present. ~2 AI calls per domain (combined + category).
      • "library" = `lingua-language-detector` runs on the V2 sample text
                    deterministically and aggregates a primary language.
                    AI prompt then asks for theme only. Same ~2 AI calls
                    per domain (theme-only + category) — library mode just
                    swaps deterministic language for AI-detected language.
    Both modes always chain a separate category-classify AI call after
    theme detection so the user can re-judge categories independently
    when their predefined category list changes."""
    enabled: bool = False
    language_mode: Literal["ai", "library"] = "ai"
    # AI judge prompt variant (added 2026-06-07). Mirrors
    # `WaybackConfig.variant`. "white" = default white-niche prompts;
    # "grey" = grey-niche prompts (adult / gambling). Applies to ALL
    # THREE chained classify prompts (combined / theme_only / category)
    # — flipping the toggle on the Check → Quality CLS card routes
    # every classify AI call to its `_grey` slot. The cache key bakes
    # in the full prompt text via `compute_wayback_classify_prompt_hash`
    # in `tasks.py`, so a variant flip naturally invalidates prior
    # verdicts (no stale-cache risk).
    variant: Literal["white", "grey"] = "white"


class WhoisHistoryConfig(BaseModel):
    """Whois History criterion config (added Wave 2, 2026-05-15).

    Intentionally minimal — the provider returns everything available,
    and all the user-tunable knobs (max records, gap threshold,
    confidence threshold) live in Settings rather than per-job. The
    `enabled` flag is the only per-job lever; Whois History jobs have
    it True and everything else False. Mixing whois_history with
    Quality criteria in one Job is NOT supported in Wave 2 — the
    runner dispatches per-Job by `job.kind`, not per-criterion."""

    enabled: bool = False


class AvailabilityConfig(BaseModel):
    """Availability criterion config (added Wave 3, 2026-05-15).

    Mirrors WhoisHistoryConfig — single `enabled` toggle. All
    cascade-level knobs (provider order, RPS/concurrency, per-provider
    enabled flags, cache TTL) live in Settings since they apply
    globally regardless of which Job invokes the cascade. The runner
    forces use_cache=False per the Wave 3 decision (a Job is an
    explicit ask — fresh data per Job)."""

    enabled: bool = False


class AhrefsBatchAnalysisConfig(BaseModel):
    """Ahrefs Batch Analysis criterion config (added 2026-06-02).

    Unlike WhoisHistory/Availability (single `enabled` toggle), this
    pillar carries per-job knobs because the cost + the result columns
    depend on which metrics the operator picked:

    - `metrics`: subset of providers.ahrefs_batch.BATCH_METRICS keys to
      fetch. Drives both the Ahrefs `select` and the run-page columns.
      Empty defaults to ["domain_rating"] at submit time (DR is the
      cheapest single field).
    - `country`: optional ISO alpha-2 country code scoping org_traffic /
      org_keywords. None = worldwide.

    Like the other pillars, the runner dispatches per-Job by `job.kind`,
    not per-criterion — mixing with Quality criteria isn't supported."""

    enabled: bool = False
    metrics: list[str] = Field(default_factory=list)
    country: str | None = None


class CriteriaSpec(BaseModel):
    backlinks: BacklinksConfig = Field(default_factory=BacklinksConfig)
    refdomains: RefdomainsConfig = Field(default_factory=RefdomainsConfig)
    anchors: AnchorsConfig = Field(default_factory=AnchorsConfig)
    keywords: KeywordsConfig = Field(default_factory=KeywordsConfig)
    wayback: WaybackConfig = Field(default_factory=WaybackConfig)
    wayback_classify: WaybackClassifyConfig = Field(
        default_factory=WaybackClassifyConfig
    )
    whois_history: WhoisHistoryConfig = Field(
        default_factory=WhoisHistoryConfig
    )
    availability: AvailabilityConfig = Field(
        default_factory=AvailabilityConfig
    )
    ahrefs_batch_analysis: AhrefsBatchAnalysisConfig = Field(
        default_factory=AhrefsBatchAnalysisConfig
    )


# Pillar-only criteria — Quality runs' per-domain loop never dispatches
# these (their CRs come from `whois_history.runner.process_whois_history_run`
# / `availability_runner.process_availability_run` respectively). Used by
# `strip_pillar_criteria_from_quality_spec` to close the silent-skip
# footgun where a Quality spec arrives with one of them enabled
# (2026-05-24 — caused runs 124/126's whois "stuck running" cohort).
PILLAR_ONLY_CRITERIA: tuple[str, ...] = (
    "whois_history", "availability", "ahrefs_batch_analysis",
)


# --- AI selection ------------------------------------------------------------

# `provider` values match the keys in `app.ai_judge.AI_PROVIDERS` plus None,
# which means "skip AI; only fetch Ahrefs data". `model` is an optional
# override for the provider's default_model from Settings.
AIProvider = Literal["gemini", "github_models", "openrouter", "vertex_ai"]


class AISpec(BaseModel):
    provider: AIProvider | None = None
    model: str | None = None


# --- Top-level analyze spec --------------------------------------------------

class AnalyzeSpec(BaseModel):
    domains: list[str] = Field(default_factory=list)
    criteria: CriteriaSpec = Field(default_factory=CriteriaSpec)
    ai: AISpec = Field(default_factory=AISpec)
    # Per-job cache: when True (default), reuse Ahrefs data and AI verdicts
    # from earlier runs of the same job whose request shape matches. The
    # rerun banner exposes a checkbox to flip this off when the user wants
    # truly fresh data.
    use_cache: bool = True
    # Cross-job cache (added 2026-05-09): expand the cache lookup to ANY
    # prior run across ANY job whose params_hash matches, not just runs
    # of the SAME job. Default off (preserves the per-job-only semantics
    # locked 2026-05-06 — a fresh job from /analyze actually fetches fresh
    # by default). Turned on automatically by the Database-page "Analyze
    # selected" entry point: when the user picks domains they ALREADY
    # analyzed before, expanding the lookup is what they want. Has no
    # effect when `use_cache=False`.
    cross_job_cache: bool = False
    # UI language at submit time (added 2026-05-09). Carried on the spec
    # so reruns + per-domain reanalyze inherit the same language without
    # the frontend having to re-send it. The runner appends a Russian-
    # output directive to every AI system prompt when this is "ru" (see
    # `ai_prompts.localize_prompt`); "en" leaves prompts untouched.
    # Unknown values are treated as "en" by the localizer.
    lang: Literal["en", "ru"] = "en"
    # Availability cascade toggle (added 2026-05-12). When True, the
    # runner calls the cascade before fetching Ahrefs/Wayback and
    # applies the Settings → Domain availability skip policy. When
    # False (default), the cascade is not invoked — analysis runs
    # exactly as before. Per-domain results land in the
    # availability_checks history table either way.
    check_availability: bool = False


def strip_pillar_criteria_from_quality_spec(spec: "AnalyzeSpec") -> "AnalyzeSpec":
    """Return a copy of `spec` with all `PILLAR_ONLY_CRITERIA` flipped to
    `enabled=False`. No-op when none were enabled.

    Background: the Quality runner's per-domain loop (`tasks._process_domain`)
    iterates `build_preview`'s request list, which only emits Ahrefs +
    Wayback fetches. `whois_history` and `availability` have their own
    pillar runners (`whois_history.runner.process_whois_history_run`,
    `availability_runner.process_availability_run`) — Quality runs do NOT
    dispatch them. Leaving them enabled creates a silent-skip footgun:
    the run finalizes `status=done` with the CR rows missing, then any
    later Retry-failed click correctly picks them up and dispatches per-
    domain whois/availability work the user didn't ask for.

    Concrete reproducer (2026-05-24, runs 124+126 of the Wincraft jobs):
    Quality spec arrived with `whois_history.enabled=True` (likely
    inherited from a prior Whois-pillar run via spec prefill). Original
    run finalized done with only 14/89 whois CRs (silent skip on 75 RDs).
    User hit Retry-failed thinking they had 1 failed criterion; retry
    correctly identified 80 RDs as needing whois work, dispatched per-RD
    whois pillar calls, then worker death (uvicorn restart) left 80 RDs
    stranded in `status='running'`. Stripping at submit eliminates the
    silent-skip class of bug at the source.

    Callers: `analyze.submit_job` (always quality), `jobs.rerun_job`
    (only when `job.kind == 'quality'`)."""
    needs_change = any(
        getattr(spec.criteria, name).enabled
        for name in PILLAR_ONLY_CRITERIA
    )
    if not needs_change:
        return spec
    new_criteria_updates: dict[str, object] = {}
    for name in PILLAR_ONLY_CRITERIA:
        cfg = getattr(spec.criteria, name)
        if cfg.enabled:
            new_criteria_updates[name] = cfg.model_copy(update={"enabled": False})
    updated_criteria = spec.criteria.model_copy(update=new_criteria_updates)
    return spec.model_copy(update={"criteria": updated_criteria})


# --- Preview response --------------------------------------------------------

class PreviewedRequest(BaseModel):
    criterion: Literal["backlinks", "refdomains", "anchors", "keywords", "wayback"]
    enabled: bool
    method: Literal["GET"] = "GET"
    url: str
    # Echoed back so the UI can show "this is the where JSON" in a separate
    # block without re-parsing the URL.
    where: dict | None = None
    order_by: str | None = None
    limit: int


class PreviewResponse(BaseModel):
    domain: str | None  # None when no domains supplied; preview uses placeholder
    requests: list[PreviewedRequest]
    note: str | None = None  # human-readable hint, e.g. "Showing first domain"
