// Centralised fetch wrapper. All API requests go through Caddy at /api/*
// (set via NEXT_PUBLIC_API_BASE — defaults to /api so the same image works
// in dev and prod without rebuilds).

const BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

export type ProviderFieldStatus =
  | { configured: false }
  | { configured: true; last4: string; length: number }
  | { configured: true; value: string };

export type ProviderStatus = {
  provider: string;
  fields: Record<string, ProviderFieldStatus>;
};

export type RateLimits = {
  rpm: number;
  max_concurrent: number;
  retry_max: number;
};

export type SettingsPayload = {
  providers: ProviderStatus[];
  rate_limits: Record<string, RateLimits>;
  // Per-provider list of known model IDs. Powers the model dropdowns in
  // Settings, the Analyze AI selector, and every Reanalyze picker. Ahrefs
  // is excluded — only AI providers (gemini / github_models / openrouter).
  known_models: Record<string, string[]>;
  // Final-score scoring knobs: per-criterion weights + bucket thresholds
  // + low-confidence threshold. Frontend mirrors these into a module-level
  // cache (lib/score.ts) so bucket / grey-out helpers stay in sync.
  scoring: ScoringConfig;
  // wayback_classify settings — language detection mode + the user's
  // predefined site categories used by the chained category pass.
  wayback_classify?: {
    language_mode: "ai" | "library";
    categories: WaybackClassifyCategory[];
  };
  // Classify-context → Ahrefs judges (added 2026-05-13).
  classify_context?: ClassifyContextEnvelope;
};

export type ClassifyContextConfig = {
  enabled: boolean;
  // Subset of allowed_criteria — the criteria that receive the "Site
  // context" block in their user message.
  criteria: string[];
  // Subset of allowed_fields — the classify verdict fields projected
  // into the context block.
  fields: string[];
};

export type ClassifyContextEnvelope = {
  config: ClassifyContextConfig;
  defaults: ClassifyContextConfig;
  allowed_criteria: string[];
  allowed_fields: string[];
};

export type WaybackClassifyCategory = {
  name: string;
  description: string;
};

export type ScoringConfig = {
  weights: {
    backlinks: number;
    refdomains: number;
    anchors: number;
    keywords: number;
    // Defaults to 0 — wayback is informational-only until the user dials
    // it up. Optional in the type so older settings payloads (pre-wayback)
    // don't trip TypeScript while migrating.
    wayback?: number;
    // Also defaults to 0 (2026-08-24). Same optional-for-migration
    // reasoning as wayback.
    stop_words?: number;
  };
  good_threshold: number;
  mixed_threshold: number;
  low_confidence_threshold: number;
};

export type ScoringConfigEnvelope = {
  config: ScoringConfig;
  defaults: ScoringConfig;
};

// Availability cascade (added 2026-05-12). Values match the backend's
// `availability.common.STATUS_*` constants.
export type AvailabilityStatus =
  | "available"
  | "registered"
  | "unknown"
  | "error"
  // "Double domain" under a private multi-label suffix (e.g. jcg.us.com)
  // the cascade can't authoritatively check — never treat as available.
  | "not_supported";

// Flat key→string config map for the Domain-availability Settings tab.
// Mirrors `app_settings.AVAILABILITY_DEFAULTS`. The masked api-key
// pattern follows the rest of the codebase: the GET payload sets
// `availability__domainr__api_key` to "" and surfaces
// `availability__domainr__api_key__set: true/false` so the UI can
// render "set / not set" without ever receiving the key.
export type AvailabilitySettings = {
  availability__dns__enabled: string;
  availability__rdap__enabled: string;
  availability__domainr__enabled: string;
  availability__whois__enabled: string;
  availability__whoisfreaks__enabled: string;
  availability__cascade_order: string;
  // How many domains the runner processes concurrently (2026-06-15). The
  // hard ceiling on throughput; raise it once RDAP egress is spread over
  // a proxy pool. Read at run dispatch.
  availability__outer_concurrency: string;
  availability__dns__rps: string;
  availability__dns__max_concurrent: string;
  availability__rdap__rps: string;
  availability__rdap__max_concurrent: string;
  // Newline/comma-separated RDAP egress proxy list (2026-06-15). Empty =
  // direct. RDAP-only — WhoisFreaks always runs direct.
  availability__rdap__proxies: string;
  availability__domainr__rps: string;
  availability__domainr__max_concurrent: string;
  availability__whois__rps: string;
  availability__whois__max_concurrent: string;
  availability__whoisfreaks__rps: string;
  availability__whoisfreaks__max_concurrent: string;
  availability__domainr__api_key: string;
  availability__domainr__api_key__set: boolean;
  availability__cache_ttl_hours: string;
  availability__skip_registered: string;
  availability__skip_horizon_days: string;
  // Retention prune (added 2026-05-14). Strings to match the rest of
  // the settings shape; 0 in either field disables that cap.
  availability__retention_days: string;
  availability__per_domain_keep: string;
};

export type IntegrationStatus = {
  provider: string;
  // `configured` is optional now (Wave 2b, 2026-05-15) — backend
  // attaches it for providers in PROVIDER_FIELDS but skips for
  // WhoisFreaks (which encodes config state via the `state` field
  // directly). Frontend checks before reading.
  configured?: ProviderStatus;
} & (
  | {
      state: "ok";
      // `elapsed_ms` is optional — the config-only mode + WhoisFreaks
      // probe omit it because no IO happened.
      elapsed_ms?: number;
      details: Record<string, unknown>;
    }
  | { state: "unconfigured"; error: string }
  | { state: "error"; error: string }
);

export type DashboardStatus = {
  checked_at: string;
  // `mode` (Wave 2b) — "config" or "live". UI uses this to label
  // whether the user is looking at a passive check or a fresh
  // upstream probe.
  mode?: "config" | "live";
  integrations: IntegrationStatus[];
};

// Ahrefs API unit balance for the Dashboard (2026-07-27). `state` mirrors
// the integration states so the card can degrade quietly when Ahrefs isn't
// configured or the probe fails.
export type AhrefsUnits = {
  state: "ok" | "unconfigured" | "error";
  error?: string;
  subscription?: string | null;
  units_limit?: number | null;
  units_used?: number | null;
  units_remaining?: number | null;
  usage_reset_date?: string | null;
  api_key_expiration_date?: string | null;
};

// ---- Analyze flow -----------------------------------------------------------

export type Criterion =
  | "backlinks"
  | "refdomains"
  | "anchors"
  | "keywords"
  // stop_words (2026-08-24) — the anchors + organic keywords that matched
  // the operator's stop-word list, merged into one CR. Rows carry a
  // `source` tag naming which endpoint each came from.
  | "stop_words"
  | "wayback"
  // wayback_classify is a derived AI-only criterion — no fetch URL, no
  // raw rows. Result lives in the CR's ai_verdict_json with shape
  // {primary_language, primary_theme, drift_detected, history?, category,
  // category_confidence, category_was?, ...}.
  | "wayback_classify"
  // whois_history (Wave 2b) — single criterion for the whois_history
  // pillar. Stored on the same CR table as Quality criteria; the
  // AI-preview endpoint accepts it too.
  | "whois_history";

export type SortField =
  // backlinks
  | "domain_rating_source"
  | "url_rating_source"
  | "traffic_domain"
  | "refdomains_source"
  | "positions"
  | "traffic"
  | "first_seen_link"
  // refdomains / anchors share several
  | "links_to_target"
  | "new_links"
  | "first_seen"
  // anchors
  | "refdomains"
  // keywords
  | "volume_mobile_pct"
  | "sum_traffic"
  | "is_best_position_set_top_11_50";

export type SortRule = { field: SortField; direction: "asc" | "desc" };

export type BacklinksFilters = {
  dofollow: boolean;
  nofollow: boolean;
  non_spammy: boolean;
  // When true, exclude backlinks whose referring page has a noindex meta
  // tag (`is_noindex_source=0`).
  noindex_exclude: boolean;
  // When true, restrict to editorial in-content links only (`is_content=1`).
  // Without this, footer/sidebar/sitewide/comment placements come back too.
  content_only: boolean;
  // When true, drop backlinks whose REFERRING URL is on a subdomain
  // (`is_root_source=1`). Default-on at the schema level — see
  // BacklinksFilters.root_only on the backend for the rationale.
  // NOT to be confused with `domain_contains`, which filters the
  // `root_name_source` string field for substring matches.
  root_only: boolean;
  // ISO 639-1 language codes — empty = no filter, multi-value OR-matched.
  // `link_type=text` is hardcoded on every backlinks query (no UI toggle).
  languages: string[];
  // Substrings to match against the referring root domain (multi-value,
  // OR-matched). Frontend parses comma- or pipe-separated user input.
  domain_contains: string[];
  // Domain Rating bounds for the referring domain (`domain_rating_source`).
  // null = unbounded. 0..100.
  dr_min: number | null;
  dr_max: number | null;
  // URL Rating bounds for the referring URL (`url_rating_source`). 0..100.
  ur_min: number | null;
  ur_max: number | null;
  // Source-page estimated organic traffic (`traffic`). Integer, ≥ 0.
  traffic_min: number | null;
  traffic_max: number | null;
  // # of organic keywords the source page ranks for (`positions`). ≥ 0.
  positions_min: number | null;
  positions_max: number | null;
};
export type RefdomainsFilters = {
  dofollow: boolean;
  nofollow: boolean;
  non_spammy: boolean;
  // Substrings to match against the refdomain `domain` field.
  domain_contains: string[];
  // Domain Rating bounds for the refdomain itself (`domain_rating`).
  dr_min: number | null;
  dr_max: number | null;
};
export type AnchorsFilters = { dofollow: boolean; nofollow: boolean };

export type WaybackMatchType = "exact" | "prefix" | "host" | "domain";

export type WaybackFilters = {
  // ISO year range. null = unbounded. CDX accepts 1996..present.
  from_year: number | null;
  to_year: number | null;
  // CDX matchType: "domain" catches subdomains too — usually right for
  // dropped-domain triage.
  match_type: WaybackMatchType;
  // CDX `collapse` value (e.g. "timestamp:6" ≈ same month). Empty = no
  // collapsing — useful when you want every snapshot, lossy when you don't.
  collapse: string;
};

export type BacklinksAggregation = "all" | "similar_links" | "1_per_domain";

export type CriteriaSpec = {
  backlinks: {
    enabled: boolean;
    limit: number;
    filters: BacklinksFilters;
    sort: SortRule[];
    aggregation: BacklinksAggregation;
  };
  refdomains: {
    enabled: boolean;
    limit: number;
    filters: RefdomainsFilters;
    sort: SortRule[];
  };
  anchors: {
    enabled: boolean;
    limit: number;
    filters: AnchorsFilters;
    sort: SortRule[];
  };
  keywords: {
    enabled: boolean;
    limit: number;
    sort: SortRule[];
    // Ahrefs organic-keywords `date_compared` (2026-05-17). When set
    // away from "off", the request adds the corresponding YYYY-MM-DD
    // and the response includes `_prev` trend fields. Predefined
    // buckets mirror Ahrefs's own UI; backend resolves the enum to a
    // date string at build time.
    date_compared: "off" | "3m" | "6m" | "1y" | "2y" | "5y";
  };
  // stop_words (added 2026-08-24): asks Ahrefs for ONLY the anchors /
  // organic keywords that CONTAIN one of the operator's stop words, then
  // has the AI judge how spoiled the domain is. Opt-in.
  //
  // `source` picks which endpoint(s) to query — each is a separately
  // billed request, so "both" costs roughly double. `limit` applies PER
  // SOURCE and is the hard ceiling on spend.
  //
  // `terms` is NOT edited here: the word list lives in Settings → Brain
  // and the backend snapshots it onto the spec at preview/submit time.
  // The field exists on the type only because it round-trips on saved
  // specs (rerun prefill, "last spec" prefill); never populate it from
  // the client.
  stop_words: {
    enabled: boolean;
    source: "anchors" | "keywords" | "both";
    // Per-source row caps (split from a single `limit` 2026-08-24, because
    // anchors cost ~2.4x less per row than organic keywords). Each is the
    // hard spend ceiling for its endpoint.
    anchor_limit: number;
    keyword_limit: number;
    terms?: string[];
    // Legacy shared cap. Still emitted by the backend (inherited from
    // CriterionBase) but no longer used by the request builder; kept
    // optional so old saved specs round-trip.
    limit?: number;
  };
  // Opt-in by default. Hits Wayback Machine CDX — free, unauthenticated,
  // separate rate-limit row in Settings (RPM 30 / max concurrent 2 default).
  // V2 page-content sampling fields (`sample_*`) are deeper opt-in within
  // the criterion: when on, the runner additionally fetches a handful of
  // archived snapshot pages and extracts title + headings + body excerpt
  // so the AI judge can spot year-over-year theme drift.
  wayback: {
    enabled: boolean;
    limit: number;
    filters: WaybackFilters;
    sort: SortRule[];
    sample_pages: boolean;
    sample_count: number;
    sample_strategy: "even" | "anchor";
    sample_path_mode: "mixed" | "root";
    // AI judge prompt variant (added 2026-06-07). "white" = default
    // white-niche prompt; "grey" = grey-niche prompt (adult/gambling).
    // Mirrors WaybackConfig.variant on the backend (schemas.py); the
    // backend Literal defaults to "white" for legacy specs missing the
    // field, so older saved specs round-trip cleanly.
    variant?: "white" | "grey";
  };
  // wayback_classify (added 2026-05-09): combined language + theme + auto-
  // chained category classification, derived from the wayback CR's V2
  // page samples. Auto-enables wayback + sample_pages on submit/preview.
  // language_mode "ai" = combined language+theme prompt with `<html lang>`
  // hint; "library" = lingua-language-detector for language + theme-only
  // AI prompt.
  wayback_classify: {
    enabled: boolean;
    language_mode: "ai" | "library";
    // Prompt variant (added 2026-06-07). Same shape as
    // WaybackConfig.variant — backend Pydantic defaults to "white" for
    // legacy specs missing the field, so older saved specs round-trip
    // cleanly. Routes all three chained classify prompts (combined /
    // theme_only / category) to the matching _white or _grey slot at
    // judge time.
    variant?: "white" | "grey";
  };
  // Ahrefs Batch Analysis pillar (2026-06-02). Optional — only present
  // on ahrefs_batch_analysis-kind specs. Carries the metric selection +
  // optional country scoping.
  ahrefs_batch_analysis?: {
    enabled: boolean;
    metrics: string[];
    country: string | null;
  };
};

export type AIProvider =
  | "gemini"
  | "github_models"
  | "openrouter"
  | "vertex_ai";

export type AISpec = {
  provider: AIProvider | null;
  model: string | null;
};

export type AnalyzeSpec = {
  domains: string[];
  criteria: CriteriaSpec;
  ai?: AISpec;
  // When true (default), reruns of the same job reuse Ahrefs data and AI
  // verdicts whose request shape + prompt match a prior run. Flip this off
  // from the rerun banner to force a fresh fetch.
  use_cache?: boolean;
  // Cross-job cache (added 2026-05-09): when true, the cache lookup
  // expands beyond the current job to ANY prior run across ANY job whose
  // params_hash matches. Default false. Set automatically by the
  // Database-page "Analyze selected" entry point (where the user picks
  // domains they already have data for and intends to reuse it). Has no
  // effect when use_cache is false.
  cross_job_cache?: boolean;
  // UI language at submit time (added 2026-05-09). Backend appends a
  // Russian-output directive to every AI system prompt when this is "ru";
  // "en" leaves prompts untouched. Carried on the spec so reruns +
  // reanalyze inherit the same language.
  lang?: "en" | "ru";
  // Availability cascade toggle (added 2026-05-12). When true, the
  // runner calls RDAP/DNS/etc. before Ahrefs/Wayback and applies the
  // Settings → Domain availability skip-registered policy. Default
  // off — old runs keep their existing behavior.
  check_availability?: boolean;
};

export type CriterionVerdict = {
  // Standard 4 + wayback shape: each criterion judge returns these fields
  // (assessment + confidence drive the UI pill + scoring). All optional
  // because wayback_classify has a different shape (see fields below).
  assessment?: "high_quality" | "mixed" | "low_quality";
  confidence?: number;
  key_findings?: string[];
  red_flags?: string[];
  // wayback_classify shape (added 2026-05-09): no assessment/confidence,
  // instead carries language + theme + chained category. The VerdictBox
  // detects this shape via the presence of `primary_theme` and renders
  // a different layout. All optional so the type stays one union.
  primary_language?: string;
  secondary_languages?: string[];
  language_confidence?: number;
  language_source?: "ai" | "library";
  primary_theme?: string;
  secondary_themes?: string[];
  theme_confidence?: number;
  drift_detected?: boolean;
  history?: Array<{ from_year?: number; to_year?: number; language?: string; theme?: string }>;
  category?: string;
  category_confidence?: number;
  category_was?: string;
  category_was_confidence?: number;
  category_reasoning?: string;
  category_skipped_reason?: string;
  category_error?: string;
};

export type FinalAssessment = {
  // The runner now computes `final` deterministically (see backend
  // scoring.py); legacy runs may carry a "quality" / "mixed" / "low_quality"
  // string. lib/score.ts normalizes both shapes.
  // Absent / null when `partial: true` — the runner deliberately skips the
  // synth + score on partial results to avoid misleading numbers.
  final?: number | string | null;
  // Mean of per-criterion AI confidences (0..1). Drives the
  // grey-on-low-confidence rule. Optional for legacy runs.
  confidence?: number;
  // Provider + model that actually produced the final summary +
  // recommendation prose. Stamped by the runner; absent for legacy runs.
  provider?: string;
  model?: string;
  summary: string;
  recommendation: string;
  // True when at least one enabled criterion didn't produce an AI verdict.
  // Score + summary are intentionally suppressed; UI shows a "partial"
  // banner with the succeeded/failed lists and prompts the user to
  // Reanalyze.
  partial?: boolean;
  succeeded?: string[];
  failed?: string[];
};

export type AIPrompt = {
  key: string;
  value: string;
  default: string;
  is_custom: boolean;
};

export type AiPreview = {
  domain: string;
  criterion: Criterion;
  provider: string;
  model: string;
  // Field names included in the trim list — same as the keys in each row
  // of the user_message JSON. Surface as a chip row in the UI.
  fields_sent: string[];
  row_count: number;
  system_prompt: string;
  // Full text of the user message — includes the rows JSON. Can be large
  // (up to limit × ~150 chars/row); the UI shows it inside a scrollable
  // <pre> block.
  user_message: string;
  // Same rows the AI sees, in structured form so the UI can render a
  // readable table view without re-parsing user_message.
  rows: Record<string, unknown>[];
  // wayback_classify-only fields (added 2026-05-09). The criterion runs
  // a 2-call pipeline — the main system_prompt + user_message above show
  // the language+theme step (combined or theme-only depending on
  // language_mode); these expose the chained category step. Empty for
  // every other criterion. `category_user_message` is empty when no
  // verdict has landed yet (the runner builds it from theme output).
  language_mode?: "ai" | "library";
  category_system_prompt?: string;
  category_user_message?: string;
  // Wayback classify → Ahrefs judge context (added 2026-05-13). The
  // projected key-value dict that the user message's "Site context
  // (Wayback classify, JSON)" block carries. Null when this criterion
  // isn't receiving classify context (feature disabled, refdomains by
  // default, no classify verdict for this rd, etc.). Render as a
  // small key-value table so the user can verify actual values
  // without parsing the JSON view.
  classify_context?: Record<string, unknown> | null;
  // whois_history-only fields (Wave 2b, 2026-05-15). `whois_provider`
  // surfaces which historical-WHOIS vendor (whoisfreaks today) the
  // records came from — distinct from the AI `provider` field above
  // (which is the model vendor). `snapshot_count_total` is how many
  // records exist on the CR; `row_count` is how many actually reach
  // the AI prompt (capped at MAX_RECORDS_IN_PROMPT = 30).
  whois_provider?: string;
  snapshot_count_total?: number;
};

export type RunSummaryDomain = {
  id: number;
  domain: string;
  status: string;
  criteria: Record<
    string,
    {
      fetch_status: string;
      ai_assessment: string | null;
      ai_confidence: number | null;
      ai_error: string | null;
      ai_provider: string;
      ai_model: string;
      // wayback_classify-only fields. Backend populates these only for the
      // `wayback_classify` criterion entry; absent for the quality pillar
      // criteria. Empty strings (not null) when the field exists but the
      // AI returned blank — that lets FE rely on truthy checks.
      theme?: string;
      language?: string;
      category?: string;
      drift_detected?: boolean;
      // whois_history-only fields. Backend populates these only for the
      // `whois_history` criterion entry. `band` is "" when no
      // dropped_confidence was parseable; one of dropped / mixed /
      // insufficient / stable otherwise — same vocabulary as the
      // Database page.
      dropped_confidence?: number | null;
      transferred_confidence?: number | null;
      band?: string;
      ownership_cycles?: number | null;
      summary?: string;
    }
  >;
  final_summary: string | null;
  final_partial: boolean;
  final_score: number | null;
  final_confidence: number | null;
  final_bucket: string;
  // Provider + model that actually produced the final assessment. Empty
  // string when no AI verdict has landed yet.
  final_provider: string;
  final_model: string;
};

export type RunSummaryResponse = {
  run_id: number;
  name: string;
  job_id: number;
  job_name: string;
  status: string;
  domains: RunSummaryDomain[];
};

export type PreviewedRequest = {
  criterion: Criterion;
  enabled: boolean;
  method: "GET";
  url: string;
  where: Record<string, unknown> | null;
  order_by: string | null;
  limit: number;
};

export type PreviewResponse = {
  domain: string | null;
  requests: PreviewedRequest[];
  note: string | null;
};

export type SubmitJobResponse = { job_id: number; run_id: number };

export type RunStatus = {
  id: number;
  status: "pending" | "running" | "done" | "failed" | "canceled" | "paused";
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  reanalyzing: boolean;
};

// Slim per-tick poll companion to RunDetail (added 2026-05-14). Carries
// only the live fields — status pills, criteria/ai_status enums,
// reanalyzing flag, last_analyzed_at. The Run page overlays this onto
// the last full snapshot and auto-fires a full reload whenever a status
// transition is detected so the expensive columns (language / theme /
// category / final score) stay current without per-tick recomputation.
export type RunDomainProgressSlim = {
  id: number;
  status: string;
  criteria: Record<string, string>;
  ai_status: Record<string, string>;
  reanalyzing: boolean;
  last_analyzed_at: string | null;
  // Mirror of RunDomainProgress.availability_status (2026-05-16) so the
  // slim polling tick keeps the Availability filter source field
  // populated.
  availability_status?: string;
};

export type RunProgress = {
  run_id: number;
  status: "pending" | "running" | "done" | "failed" | "canceled" | "paused";
  started_at: string | null;
  finished_at: string | null;
  error: string;
  // Run-wide counts — always reflects every domain in the run,
  // independent of the requested page.
  counts: {
    total: number;
    done: number;
    failed: number;
    running: number;
    pending: number;
  };
  // Slice of domains for the requested page (added 2026-05-16).
  domains: RunDomainProgressSlim[];
  total_count?: number;
  filtered_count?: number;
  // Backend-reported run-level reanalyze flag (added 2026-05-16).
  // Pre-pagination the FE OR'd per-domain `reanalyzing` flags; with
  // paginated payloads the FE no longer sees every domain so the
  // backend now exposes this directly.
  reanalyzing?: boolean;
};

export type JobsListItem = {
  id: number;
  name: string;
  notes: string;
  // Pillar discriminator (added Wave 1, 2026-05-15). Backend always
  // emits one of 'quality'|'availability'|'whois_history'; pre-wave
  // rows backfilled to 'quality'.
  kind: JobKind;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  run_count: number;
};

export type JobsArchivedFilter = "active" | "archived" | "all";

// Pillar discriminator (added Wave 1, 2026-05-15). Backfilled to
// 'quality' on every pre-wave row. Drives /check/<pillar> and
// /jobs/<pillar> route segmentation.
export type JobKind =
  | "quality"
  | "availability"
  | "whois_history"
  | "ahrefs_batch_analysis";

export type RunSummary = {
  id: number;
  name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  total_domains: number;
  done_domains: number;
  failed_domains: number;
  // True when this Run is pinned as the canonical run for its Job
  // (drives the Job-page L/M/H rollup pills' source). At most one run
  // per job can be pinned. Pin/unpin from the run-row Pin button.
  is_pinned?: boolean;
};

export type JobDetail = {
  id: number;
  name: string;
  notes: string;
  // Pillar discriminator (added Wave 1, 2026-05-15).
  kind: JobKind;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  runs: RunSummary[];
  // Verdict roll-up. Source-of-truth rule (added 2026-05-10):
  // - Pinned run if `pinned_run_id` is set.
  // - Otherwise the latest run.
  // Keys: good / mixed / low_quality / partial / no_verdict. Empty when
  // the job has no runs.
  latest_run_verdict_counts: Record<string, number>;
  // The run id the rollup counts actually came from. Equals pinned_run_id
  // when a run is pinned; equals max(run.id) otherwise. Surfaced so the
  // UI can render "from Run #N" alongside the pills.
  latest_run_id: number | null;
  // The pinned run for this job (or null when no pin is set). When
  // non-null, the rollup counts above came from this run. Used by the
  // UI to render "Pinned: Run #N" instead of "Latest: Run #N".
  pinned_run_id?: number | null;
};

export type PinRunResponse = {
  run_id: number;
  job_id: number;
  is_pinned: boolean;
  previously_pinned_run_id?: number | null;
};

export type RunDomainProgress = {
  id: number;
  domain: string;
  status: string;
  error: string;
  started_at: string | null;
  finished_at: string | null;
  // Updated whenever AI completes for this domain (fresh, reanalyze, or
  // cache hit). `finished_at` stays put — it's the original run completion.
  last_analyzed_at: string | null;
  criteria: Record<string, string>;
  // Per-criterion AI verdict status: "done" | "failed" | "pending". A
  // criterion can have its FETCH succeed (criteria[c]==="done") and still
  // have its AI step fail here (e.g. provider rate-limit).
  ai_status: Record<string, string>;
  // Verdict-level AI provenance — who actually produced this domain's final
  // assessment. May differ from the run's spec.ai after a reanalyze.
  ai_provider: string;
  ai_model: string;
  final_score: number | null;
  final_confidence: number | null;
  final_bucket: string;
  final_partial: boolean;
  // True when this RunDomain is the currently-pinned definitive source
  // for its domain on the Database page.
  is_pinned: boolean;
  // True while ANY in-flight reanalyze is touching this RD (per-domain,
  // per-criterion, or batched retry-failed). The run page uses this to
  // show a per-row pill + drive the "Retrying X of Y" progress label on
  // the Retry button + keep the button disabled until the batch drains.
  reanalyzing?: boolean;
  // wayback_classify outputs (added 2026-05-09) — same fields as the
  // Database row's classify columns. Empty when the criterion is
  // disabled / hasn't run / failed for THIS rd. The run page is run-
  // isolated: no cross-run stitching here.
  primary_language?: string;
  secondary_languages?: string[];
  language_confidence?: number | null;
  primary_theme?: string;
  secondary_themes?: string[];
  theme_confidence?: number | null;
  classify_drift_detected?: boolean;
  category?: string;
  category_confidence?: number | null;
  category_was?: string;
  // Wayback CDX row count for this rd. Null = wayback didn't run on this
  // rd or hasn't reached status=done yet; 0 = wayback returned cleanly
  // with no snapshots (the "structurally nothing to classify" signal the
  // Run-page Wayback CDX filter targets); >=1 = real CDX rows present.
  wayback_rows?: number | null;
  // Per-rd availability verdict (2026-05-16). One of "available" /
  // "registered" / "unknown" / "error" or empty when no availability CR
  // for this rd. Drives the Availability-pillar Run-page filter
  // dropdown and the per-row verdict pill.
  availability_status?: string;
  // Per-rd Ahrefs batch-analysis metrics (2026-06-02). {field_id:
  // value|null} from the latest ahrefs_batch_analysis CR. Empty for
  // other kinds. Drives the Run-page metric columns.
  batch_metrics?: Record<string, number | null>;
};

// AI cost accounting for one run, returned by /runs/{id}/cost. Cache hits
// contribute 0 to total_cost_usd but their tokens still appear in the
// total_*_tokens fields (visibility into "tokens reused"). missing_pricing
// lists (provider, model) pairs that judged something but lack a price row;
// their cost contribution is 0 and totals are incomplete by that amount.
export type RunCost = {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  fresh_calls: number;
  cache_hits: number;
  missing_pricing: { provider: string; model: string }[];
  // Ahrefs unit accounting (added 2026-05-13). Sums across B/D/A/K
  // criteria only — wayback's CDX endpoint is free and contributes 0.
  // `billed` is what Ahrefs actually charged (their server-side cache
  // may zero some requests); `list` is the would-have-been list price.
  // Difference between the two = Ahrefs-side cache savings.
  ahrefs_units_billed: number;
  ahrefs_units_list: number;
  ahrefs_fresh_calls: number;
  ahrefs_cached_calls: number;
  // WhoisFreaks request count (Wave 2b, 2026-05-15). One whois_history
  // CR = one provider request. `units_per_request` is the plan-tier
  // multiplier (free=1, paid tiers can be 2+); `units_billed =
  // fresh_calls * units_per_request` matches what the operator's
  // WhoisFreaks dashboard reflects. `cached_calls` is 0 today —
  // reserved for a future cache-pre-check.
  whois_fresh_calls: number;
  whois_cached_calls: number;
  whois_units_per_request: number;
  whois_units_billed: number;
};

export type ModelPriceRow = {
  provider: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  updated_at: string | null;
};

export type RunDetail = {
  id: number;
  name: string;
  job_id: number;
  job_name: string;
  // Pillar discriminator (Wave 2b, 2026-05-15). Drives kind-aware
  // hiding of Quality-only controls (Score Weights panel, Wayback
  // CDX filter) on whois_history / availability runs.
  job_kind?: JobKind;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  spec_json: string;
  // Slice of domains for the current page (added 2026-05-16: server-
  // side pagination). `total_count` is the run-wide total;
  // `filtered_count` is the post-status-filter count. Use both to
  // drive the page footer + page count.
  domains: RunDomainProgress[];
  total_count?: number;
  filtered_count?: number;
  // Run-wide aggregates (added 2026-06-14) for the server-paginated Run
  // page (availability / ahrefs_batch_analysis). In server mode the page
  // only holds the current page of domains, so it reads these instead of
  // scanning the full set. All run-wide (ignore the page/filter window).
  last_analyzed_at_max?: string | null;
  failed_domains?: number;
  failed_criteria?: number;
  // archive.org upstream-error breakdown (2026-08-11):
  // archive_offline / http_503 / http_429 / network / total / domains.
  wayback_upstream?: Record<string, number>;
  // Per-run scoring override (added 2026-05-13 wave J). null = run uses
  // global Settings weights; non-null = the override last applied via
  // the /recompute-final endpoints. The Run-page "Score weights" panel
  // pre-fills from this so reopening the page after an apply shows the
  // active weights, not the global defaults.
  scoring_override?: { weights: Record<string, number> } | null;
};

export type RecomputeFinalRow = {
  run_domain_id: number;
  domain: string;
  score_old: number | null;
  score_new: number | null;
  confidence_new: number | null;
  bucket_new: string;
  partial: boolean;
};

export type RecomputeFinalResult = {
  run_id: number;
  preview: boolean;
  weights_applied: Record<string, number>;
  override_active: boolean;
  rows: RecomputeFinalRow[];
};

export type CriterionDetail = {
  status: string;
  http_status: number | null;
  fetched_at: string | null;
  request_url: string;
  error: string;
  rows: Record<string, unknown>[];
  raw: unknown;
  ai_verdict: CriterionVerdict | null;
  ai_verdict_error: string;
  // Provider + model that actually produced ai_verdict (or attempted it
  // and recorded an error). Empty when the row has never been judged.
  ai_provider: string;
  ai_model: string;
  // Field names the user chose to sort by at submit time. Surfaced as extra
  // columns in the per-domain table so the user can verify the ordering.
  sort_columns: string[];
  // Cache provenance: when non-null, the row's data (or AI verdict) was
  // copied from a prior run on the same job; the value is that run's id.
  cached_from_run_id: number | null;
  ai_cached_from_run_id: number | null;
  // Ahrefs unit accounting from response headers. Null on cache hits or
  // pre-feature rows. `cost_total` is list price; `cost_actual` is what
  // Ahrefs actually billed (often 0 — Ahrefs has its own server-side cache).
  units_cost_row: number | null;
  units_cost_total: number | null;
  units_cost_actual: number | null;
  // Augmentation chain provenance: when this criterion's data came from
  // a prior RunDomain (not the one in the URL), `source_run_id` is that
  // prior run's id, and `source_run_domain_id` + `source_job_id` complete
  // the link target (`/jobs/{job}/runs/{run}/domains/{rd}`). All null
  // together when the cell is from the current rd.
  source_run_id?: number | null;
  source_run_domain_id?: number | null;
  source_job_id?: number | null;
};

export type RunDomainDetail = {
  id: number;
  run_id: number;
  job_id: number;
  job_name: string;
  // Pillar discriminator (Wave 2b, 2026-05-15). Drives the per-domain
  // page's view selection. Always populated; empty fallback maps to
  // 'quality' on the renderer side.
  job_kind?: JobKind;
  domain: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  criteria: Record<string, CriterionDetail>;
  final_assessment: FinalAssessment | null;
  final_summary: string | null;
  reanalyzing: boolean;
  // Per-domain AI spend on THIS run only — sum of own CRs + final synth.
  // Same shape as the run-level /runs/{id}/cost endpoint. Cache hits and
  // augmentation-stitched parent CRs do NOT count here (parent CRs were
  // paid for on the parent run; cache hits write cost=0 by design).
  cost?: RunCost;
  // Spec-level AI choice from the run's spec_json — used to default the
  // reanalyze picker so the user starts from the original selection.
  spec_ai_provider: string;
  spec_ai_model: string;
  // Set whenever AI completed for this domain (fresh judge, reanalyze, or
  // cache hit). Distinct from finished_at, which is the original run-
  // completion time and stays put across reanalyzes.
  last_analyzed_at: string | null;
  // Domain-keyed user note (cross-run). Empty string when no note exists.
  note: string;
  note_updated_at: string | null;
  // Augmentation chain provenance. `*_run_id` plus the matching
  // `*_run_domain_id` + `*_job_id` companions let the UI link chips to
  // the source rd's domain page (`/jobs/{job}/runs/{run}/domains/{rd}`).
  // `final_source_*` is non-null when the final assessment shown was
  // sourced from a prior rd (because this rd's final was missing/partial/
  // no-score). `augments_*` is set when this rd was explicitly created
  // as an augmenter (criteria-set is a strict subset of a prior
  // comprehensive run).
  final_source_run_id?: number | null;
  final_source_run_domain_id?: number | null;
  final_source_job_id?: number | null;
  augments_run_id?: number | null;
  augments_run_domain_id?: number | null;
  augments_job_id?: number | null;
  // True when this RunDomain is the currently-pinned definitive source
  // for its domain on the Database page. Drives the Pin / Unpin button
  // label in the per-domain page header.
  is_pinned?: boolean;
};

export type JobSpec = {
  job_id: number;
  name: string;
  notes: string;
  spec: AnalyzeSpec;
};

export type TestResult =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error: string; status?: number };

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  // Drop the default application/json content-type when the body is a
  // FormData — multipart uploads need the browser-set boundary param in
  // the header, and forcing application/json corrupts the wire format
  // so multer/python-multipart can't parse it. JSON requests still get
  // the default. Callers can always override via init.headers.
  const isMultipart =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const defaultHeaders: Record<string, string> = isMultipart
    ? {}
    : { "Content-Type": "application/json" };
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...defaultHeaders,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(body || `HTTP ${res.status}`),
      { status: res.status, body },
    );
  }
  // 204 etc.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- Database (cross-job domain view) -------------------------------------

export type DatabaseCriterionSummary = {
  enabled: boolean;
  rows: number;
  cached_from_run_id: number | null;
  ai_cached_from_run_id: number | null;
  sort_fields: string[];
  // Per-criterion source attribution (added 2026-05-12). Populated when
  // this criterion was sourced from a (job, criterion) pin — null when
  // the criterion is not pinned.
  source_run_id?: number | null;
  source_run_name?: string;
  source_job_id?: number | null;
  source_job_name?: string;
  source_run_domain_id?: number | null;
  // Per-criterion AI verdict (added for confidence-aware Criteria pills).
  // ai_assessment ∈ {high_quality, mixed, low_quality} for Ahrefs +
  // Wayback. whois_history reports ai_dropped_confidence on a different
  // axis. All null when no AI verdict exists for that criterion yet.
  ai_assessment?: string | null;
  ai_confidence?: number | null;
  ai_dropped_confidence?: number | null;
};

export type PinOption = {
  run_domain_id: number;
  run_id: number;
  run_name: string;
  job_id: number;
  job_name: string;
  status: string;
  finished_at: string | null;
};

// One Database row per unique domain. Cells are sourced exclusively from
// the manually-pinned RunDomain (`is_pinned=true`). Domains with no pin
// still appear so the user can pin one — every cell below is empty for
// those rows. Notes remain domain-keyed and unaffected by the pin.
export type DatabaseDomainRow = {
  domain: string;
  is_pinned: boolean;
  pinned_run_domain_id: number | null;
  pinned_run_id: number | null;
  pinned_job_id: number | null;
  pinned_job_name: string;
  pinned_run_name: string;
  pinned_finished_at: string | null;
  pinned_started_at: string | null;
  final_summary: string;
  final_score: number | null;
  final_confidence: number | null;
  final_bucket: string;
  final_partial: boolean;
  // 2026-05-14 split. `final_failed` = an enabled criterion failed at
  // AI synth time (red badge). `final_underweight` = weight>0 criterion
  // is missing from the pinned set (amber subset badge). `final_partial`
  // remains as the OR for back-compat. Server-side default is false on
  // both so a missing field reads as "not failed/underweight".
  final_failed?: boolean;
  final_underweight?: boolean;
  // Weighted criteria NOT in pinned_criteria — populated when
  // final_underweight is true so the UI tooltip can say "missing: D, A".
  missing_weighted_criteria?: string[];
  // Sorted list of criterion names contributing to this row's view
  // (added 2026-05-12). Empty when no criterion is pinned. The UI
  // surfaces it as a "Partial — based on W, B" hint on the FinalBanner.
  pinned_criteria?: string[];
  ai_provider: string;
  ai_model: string;
  spec_ai_provider: string;
  spec_ai_model: string;
  criteria: Record<string, DatabaseCriterionSummary>;
  // Wayback per-criterion AI assessment for the pinned rd only — surfaced
  // separately from the aggregated final score so the UI can render a
  // dedicated column + filter without folding wayback into the main verdict.
  wayback_assessment: string;
  wayback_confidence: number | null;
  wayback_samples_count: number;
  // Stop Words per-criterion AI assessment (added 2026-08-24). Same
  // sourcing rule as wayback — from whichever rd supplies the
  // `stop_words` criterion. `stop_words_matches` is the raw number of
  // contaminated anchors/keywords Ahrefs returned;
  // `stop_words_no_matches` is true when the verdict came from a
  // ZERO-row fetch (no AI call), which is what lets the Stop column
  // say "clean" rather than showing a model-authored "high".
  stop_words_assessment: string;
  stop_words_confidence: number | null;
  stop_words_matches: number;
  stop_words_no_matches: boolean;
  // wayback_classify outputs (added 2026-05-09): language + theme + auto-
  // chained category. All sourced from the pinned RunDomain's
  // wayback_classify CR row only. Empty when the criterion isn't enabled
  // / hasn't run / failed for the pinned rd.
  primary_language: string;
  secondary_languages: string[];
  language_confidence: number | null;
  primary_theme: string;
  secondary_themes: string[];
  theme_confidence: number | null;
  classify_drift_detected: boolean;
  category: string;
  category_confidence: number | null;
  // Historical category — only populated when classify_drift_detected.
  category_was: string;
  // Whois-history verdict (added 2026-05-15) — surfaced separately like
  // wayback. `whois_dropped_confidence` is 0..1; `whois_band` is the
  // server-computed bucket (one of "dropped"/"mixed"/"insufficient"/
  // "stable"/""). Empty when no whois_history pin exists for this domain.
  whois_dropped_confidence: number | null;
  whois_transferred_confidence: number | null;
  whois_summary: string;
  whois_band: string;
  // Deterministic count of distinct registration cycles (added
  // 2026-05-21). 1 = original owner / insufficient history; 2 = one
  // confirmed drop; 3+ = passed through multiple hands ("the domain
  // was already grabbed by an earlier drop hunter and re-listed").
  // Computed conservatively from creation_date_changes (primary) or
  // coverage_gaps_days (fallback). See whois_history/diff.py:
  // _estimate_ownership_cycles. Capped at 10. Null when there's no
  // whois CR or its data_json is empty.
  whois_ownership_cycles: number | null;
  // Domain-availability verdict (added 2026-05-16) — sourced from the
  // aux availability CR (same data the Job-page chip math reads).
  // Replaces the prior `/availability/latest` cache hydration so the
  // column matches the chip row-for-row. Empty status when no
  // availability CR is pinned/in fallback for this domain.
  availability_status: string;
  availability_provider: string;
  availability_registrar: string;
  availability_expires_on: string | null;
  availability_checked_at: string | null;
  // Ahrefs batch-analysis metrics (2026-06-02) from the pinned
  // ahrefs_batch_analysis CR. {field_id: value|null}; empty when no
  // batch criterion is pinned. Drives the DR/RD(f)/B chips + filters.
  batch_metrics?: Record<string, number | null>;
  total_runs: number;
  any_cached: boolean;
  // User-authored note attached to this domain. Empty string when no note.
  // Survives reruns + pinning changes — keyed on the domain string.
  note: string;
  note_updated_at: string | null;
  // Lazy-loaded — the list response only sends the count to keep the
  // /database/domains payload small. Full options are fetched on-demand
  // via `getDomainPinOptions(domain)` when the user opens the dropdown.
  pin_options_count: number;
  // Backlog cross-link (added 2026-05-10). Lets the Database page show
  // the current backlog status and surface inline Order/Discard
  // actions without bouncing back to the Backlog page.
  backlog_id: number | null;
  backlog_status: BacklogStatus | null;
  // Registrar string from the matching BacklogDomain row (2026-05-17).
  // Same data shown as the "Source" column on the Backlog page. Empty
  // when the domain has no backlog row or no registrar was captured.
  backlog_registrar?: string;
  // Ahrefs DR + domain age (years) captured at backlog-import time
  // (added 2026-05-20). Rendered as small chips under the domain name
  // on the Database page. Either field independently null when the
  // backlog row has no value for it; both null when the domain has no
  // backlog row at all.
  backlog_ahrefs_dr?: number | null;
  backlog_domain_age_years?: number | null;
  // Expiration date from the BacklogDomain row (added 2026-05-20).
  // Surfaced so the Apruv-export CSV column-picker can include it
  // without an extra fetch. ISO YYYY-MM-DD, null when no backlog row.
  backlog_expiration_date?: string | null;
  // Procurement price bracket from the BacklogDomain row (added
  // 2026-05-20, Apruv export). `desired_price` = low-end / ideal bid;
  // `max_price` = absolute ceiling. Null when the import didn't
  // populate a value.
  backlog_desired_price?: number | null;
  backlog_max_price?: number | null;
  // Ban-list flag (added 2026-05-13 wave L). True when the domain is
  // on the ban list. The row stays visible per design call (i) — the
  // UI renders a small "banned" badge in the domain cell.
  is_banned?: boolean;
};

// Cross-link to a per-domain analysis page from a ban row. Lets the
// Ban List surface "Ahrefs / Wayback / Whois" buttons so operators can
// review the analysis that led them to ban without leaving the page.
// All three are null when the banned domain has no rd of that type.
export type BanAnalysisLink = {
  kind: "ahrefs" | "wayback" | "whois";
  job_id: number;
  run_id: number;
  run_domain_id: number;
};

export type BanRow = {
  domain: string;
  note: string;
  created_at: string;
  ahrefs_link: BanAnalysisLink | null;
  wayback_link: BanAnalysisLink | null;
  whois_link: BanAnalysisLink | null;
};

export type BanListResponse = {
  // Server-paginated since 2026-05-14. `total` = unfiltered ban count;
  // `filtered_total` = count after `search` is applied. `page`/
  // `per_page` echo the inputs.
  total: number;
  filtered_total: number;
  page: number;
  per_page: number;
  rows: BanRow[];
};

export type BanAddBulkResult = {
  added: number;
  already_banned: number;
  invalid: number;
  rows_added: string[];
};

export type DomainNote = {
  domain: string;
  note: string;
  updated_at: string;
};

export type DatabaseDomainList = {
  rows: DatabaseDomainRow[];
  filter_options: {
    ai_providers: string[];
    ai_models: string[];
    verdicts: string[];
    // Wayback assessment values seen on pinned runs ("high_quality" /
    // "mixed" / "low_quality"). Used to populate the second verdict filter
    // dropdown on the Database page.
    wayback_verdicts: string[];
    // Stop Words assessment values seen on pinned runs (2026-08-24).
    // Same three-value space as wayback_verdicts.
    stop_words_verdicts?: string[];
    // wayback_classify universes (added 2026-05-09). languages = ISO 639-1
    // codes seen on pinned rds; categories = the user-defined category
    // names actually assigned by the AI.
    languages: string[];
    categories: string[];
    // Whois drop-confidence bands seen across pinned rds (added
    // 2026-05-15). Subset of {dropped, mixed, insufficient, stable}.
    // Drives the Whois filter dropdown's enabled state.
    whois_bands: string[];
    // Availability verdict values (2026-05-16). Subset of
    // {available, registered, unknown, error}.
    availability_statuses?: string[];
    // BacklogDomain.registrar values for the Source filter (2026-05-17).
    // Empty when no backlog row carries a registrar yet; frontend
    // disables the dropdown in that case.
    sources?: string[];
  };
  // Total domain count across the full set (no filters). Only populated
  // when include_options=true (it rides along with the heavy options
  // computation); 0 on the page-flip path — the frontend caches it.
  total: number;
  // Count after filters but before pagination — drives the pagination bar
  // + "X / Y" hint. Added 2026-06-02 with server-side pagination.
  filtered_total: number;
  page: number;
  per_page: number;
  // Count of availability-only-taken domains hidden by default (only
  // populated when include_options=true). Drives the "show taken" toggle
  // label + prevents a misleading empty screen.
  hidden_total: number;
};

// Server-side filter/sort/pagination params for listDatabaseDomains
// (2026-06-02). Mirrors the Database page's former client-side filter
// state; every field is optional and omitted when empty. Multi-selects
// whose values can contain commas (source = registrar, AI-authored
// language/category) ride as repeated query params.
export type DatabaseListOpts = {
  page?: number;
  per_page?: number; // 0 / omitted = return every filtered row
  include_options?: boolean;
  fresh?: boolean;
  verdict?: string[];
  wayback_verdict?: string[];
  stop_words_verdict?: string[];
  whois_band?: string[];
  availability?: string[];
  language?: string[];
  // How the language multi-select matches: "primary" (default) matches
  // the dominant language only; "any" also matches secondary/tertiary
  // languages from wayback_classify.
  language_match?: "primary" | "any";
  category?: string[];
  criterion?: string[];
  notes?: "any" | "with" | "without";
  source?: string[];
  status?: string[];
  wayback_conf_min?: number;
  ahrefs_conf_min?: number;
  dr_min?: number;
  ref_domains_min?: number;
  whois_cycles_max?: number;
  max_price_min?: number;
  max_price_max?: number;
  search?: string;
  sort?: "verdict" | "whois" | "max_price";
  direction?: "asc" | "desc";
  // Reveal availability-only domains whose Availability-JOB verdict isn't
  // `available` (hidden by default to keep big availability runs from
  // burying the Database page).
  show_taken?: boolean;
};

export type RunDomainProgressLite = {
  is_pinned?: boolean;
};

export interface WebshareStatus {
  configured: boolean;
  count: number;
  last_fetch_at: string | null;
  last_error: string | null;
  refresh_day_of_month: number;
}

// Wayback residential-proxy pool (2026-08-11). Separate source from Webshare:
// archive.org tarpits datacenter IPs, so this one must point at a residential
// plan. `available` / `cooling_down` split `count` by per-IP cooldown state.
export interface WaybackProxiesStatus {
  configured: boolean;
  enabled: boolean;
  use_v1: boolean;
  use_v2: boolean;
  use_retry: boolean;
  count: number;
  available: number;
  cooling_down: number;
  last_fetch_at: string | null;
  last_error: string | null;
  refresh_day_of_month: number;
}

export const api = {
  getSettings: () => request<SettingsPayload>("/settings/"),

  listDatabaseDomains: (opts: DatabaseListOpts = {}) => {
    const p = new URLSearchParams();
    if (opts.page) p.set("page", String(opts.page));
    if (opts.per_page) p.set("per_page", String(opts.per_page));
    if (opts.include_options === false) p.set("include_options", "false");
    if (opts.fresh) p.set("fresh", "true");
    // Repeated query params for the multi-selects (comma-safe).
    const repeated: [string, string[] | undefined][] = [
      ["verdict", opts.verdict],
      ["wayback_verdict", opts.wayback_verdict],
      ["stop_words_verdict", opts.stop_words_verdict],
      ["whois_band", opts.whois_band],
      ["availability", opts.availability],
      ["language", opts.language],
      ["category", opts.category],
      ["criterion", opts.criterion],
      ["source", opts.source],
      ["status", opts.status],
    ];
    for (const [key, arr] of repeated) {
      if (arr && arr.length) for (const v of arr) p.append(key, v);
    }
    if (opts.notes && opts.notes !== "any") p.set("notes", opts.notes);
    if (opts.language_match === "any") p.set("language_match", "any");
    // Numeric thresholds — only sent when active (> 0) so an idle filter
    // never narrows the set.
    const nums: [string, number | undefined][] = [
      ["wayback_conf_min", opts.wayback_conf_min],
      ["ahrefs_conf_min", opts.ahrefs_conf_min],
      ["dr_min", opts.dr_min],
      ["ref_domains_min", opts.ref_domains_min],
      ["whois_cycles_max", opts.whois_cycles_max],
      ["max_price_min", opts.max_price_min],
      ["max_price_max", opts.max_price_max],
    ];
    for (const [key, val] of nums) {
      if (typeof val === "number" && val > 0) p.set(key, String(val));
    }
    if (opts.search && opts.search.trim()) p.set("search", opts.search.trim());
    if (opts.sort) {
      p.set("sort", opts.sort);
      if (opts.direction) p.set("direction", opts.direction);
    }
    if (opts.show_taken) p.set("show_taken", "true");
    const qs = p.toString();
    return request<DatabaseDomainList>(
      `/database/domains${qs ? "?" + qs : ""}`,
    );
  },

  deleteDatabaseDomains: (domains: string[]) =>
    request<{
      deleted_run_domains: number;
      deleted_runs: number;
      deleted_jobs: number;
      domains: string[];
    }>("/database/domains/delete", {
      method: "POST",
      body: JSON.stringify({ domains }),
    }),

  // Apruv export — batch-resolve share tokens for a set of selected
  // Database-page domains. The backend resolves each domain's target
  // RunDomain (pinned wins, else most-recent finished), reuses any
  // existing active share for that rd, and only mints a fresh token
  // when no active share exists. `expires_in_days=0` means never
  // expires. Returned items align with the request order; rows that
  // couldn't resolve (pure backlog rows) come back with token=null
  // and a populated `error` string.
  approveShareLinks: (
    domains: string[],
    expiresInDays: number,
  ) =>
    request<{
      items: {
        domain: string;
        run_domain_id: number | null;
        token: string | null;
        share_url: string | null;
        expires_at: string | null;
        reused: boolean;
        error: string;
      }[];
    }>("/database/approve-share-links", {
      method: "POST",
      body: JSON.stringify({
        items: domains.map((d) => ({ domain: d })),
        expires_in_days: expiresInDays,
      }),
    }),

  putDomainNote: (domain: string, note: string) =>
    request<DomainNote>(
      `/database/notes/${encodeURIComponent(domain)}`,
      { method: "PUT", body: JSON.stringify({ note }) },
    ),

  deleteDomainNote: (domain: string) =>
    request<{ deleted: string }>(
      `/database/notes/${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    ),

  pinDomain: (domain: string, runDomainId: number) =>
    request<{ domain: string; pinned_run_domain_id: number }>(
      `/database/domains/${encodeURIComponent(domain)}/pin`,
      { method: "POST", body: JSON.stringify({ run_domain_id: runDomainId }) },
    ),

  unpinDomain: (domain: string) =>
    request<{ unpinned: string; count: number }>(
      `/database/domains/${encodeURIComponent(domain)}/pin`,
      { method: "DELETE" },
    ),

  pinRunDomain: (runDomainId: number) =>
    request<{ run_domain_id: number; domain: string; is_pinned: boolean }>(
      `/run-domains/${runDomainId}/pin`,
      { method: "POST" },
    ),

  unpinRunDomain: (runDomainId: number) =>
    request<{ run_domain_id: number; domain: string; is_pinned: boolean }>(
      `/run-domains/${runDomainId}/pin`,
      { method: "DELETE" },
    ),

  // Per-job Run pin (added 2026-05-10) — distinct from pinRunDomain
  // (single-domain). Toggles `Run.is_pinned` so the Job-page rollup
  // pills count from it.
  pinRun: (runId: number) =>
    request<PinRunResponse>(`/runs/${runId}/pin`, { method: "POST" }),

  unpinRun: (runId: number) =>
    request<PinRunResponse>(`/runs/${runId}/pin`, { method: "DELETE" }),

  // Per-(job, criterion) pins (added 2026-05-12) — supersede the older
  // per-domain / per-run pins for the Database page rollup. Each pin
  // says "for this Job, criterion C is sourced from Run R."
  listJobCriterionPins: (jobId: number) =>
    request<{
      job_id: number;
      pins: {
        criterion: string;
        run_id: number;
        run_name: string;
        run_finished_at: string | null;
      }[];
    }>(`/jobs/${jobId}/criterion-pins`),

  setJobCriterionPin: (jobId: number, criterion: string, runId: number) =>
    request<{
      job_id: number;
      criterion: string;
      run_id: number;
      pinned: boolean;
    }>(`/jobs/${jobId}/criterion-pins`, {
      method: "POST",
      body: JSON.stringify({ criterion, run_id: runId }),
    }),

  clearJobCriterionPin: (jobId: number, criterion: string) =>
    request<{
      job_id: number;
      criterion: string;
      run_id: number;
      pinned: boolean;
    }>(
      `/jobs/${jobId}/criterion-pins/${encodeURIComponent(criterion)}`,
      { method: "DELETE" },
    ),

  pinRunAllCriteria: (runId: number) =>
    request<{
      run_id: number;
      job_id: number;
      pinned_criteria: string[];
      replaced: number;
    }>(`/runs/${runId}/pin-all-criteria`, { method: "POST" }),

  // Availability cascade (added 2026-05-12) — RDAP/Domainr/WHOIS/DNS
  // cascade results for the domain-availability column + Settings tab.
  checkAvailability: (domain: string, useCache: boolean = true) =>
    request<{
      domain: string;
      status: AvailabilityStatus;
      provider: string;
      registrar: string;
      expires_on: string | null;
      from_cache: boolean;
      checked_at: string | null;
    }>("/availability/check", {
      method: "POST",
      body: JSON.stringify({ domain, use_cache: useCache }),
    }),

  bulkCheckAvailability: (domains: string[], useCache: boolean = true) =>
    request<{
      checked: number;
      items: {
        domain: string;
        status: AvailabilityStatus;
        provider: string;
        registrar: string;
        expires_on: string | null;
        from_cache: boolean;
      }[];
    }>("/availability/bulk-check", {
      method: "POST",
      body: JSON.stringify({ domains, use_cache: useCache }),
    }),

  latestAvailability: (domains: string[]) =>
    request<
      {
        domain: string;
        status: AvailabilityStatus;
        provider: string;
        registrar: string;
        expires_on: string | null;
        checked_at: string | null;
      }[]
    >("/availability/latest", {
      method: "POST",
      // The endpoint shares the BulkCheckIn shape with bulkCheck —
      // `use_cache` is ignored for reads.
      body: JSON.stringify({ domains, use_cache: true }),
    }),

  availabilityStats: () =>
    request<{
      period_start: string;
      providers: {
        provider: string;
        sent: number;
        succeeded: number;
        failed: number;
      }[];
    }>("/availability/stats"),

  availabilityRecent: (limit: number = 100, runId?: number) =>
    request<
      {
        id: number;
        domain: string;
        provider: string;
        status: AvailabilityStatus;
        checked_at: string;
        latency_ms: number | null;
        registrar: string;
        expires_on: string | null;
        error_message: string;
        error_category: string;
        run_id: number | null;
      }[]
    >(
      `/availability/recent?limit=${limit}${runId != null ? `&run_id=${runId}` : ""}`,
    ),

  getAvailabilitySettings: () =>
    request<AvailabilitySettings>("/settings/availability"),

  setAvailabilitySetting: (key: string, value: string) =>
    request<{ updated: string }>("/settings/availability", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),

  // Webshare rotating-proxy source (2026-07-27). Status is write-only —
  // never returns the URL, only whether it's configured + pool health.
  getWebshareStatus: () => request<WebshareStatus>("/settings/webshare"),
  setWebshareConfig: (body: {
    proxy_list_url?: string | null;
    refresh_day_of_month?: number;
  }) =>
    request<WebshareStatus>("/settings/webshare", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  refreshWebshareProxies: () =>
    request<WebshareStatus>("/settings/webshare/refresh", { method: "POST" }),

  // Wayback residential-proxy pool (2026-08-11). Same write-only URL contract
  // as Webshare; every field is optional so a single toggle can be PATCHed
  // without round-tripping the secret URL.
  getWaybackProxiesStatus: () =>
    request<WaybackProxiesStatus>("/settings/wayback-proxies"),
  setWaybackProxiesConfig: (body: {
    enabled?: boolean;
    proxy_list_url?: string | null;
    use_v1?: boolean;
    use_v2?: boolean;
    use_retry?: boolean;
    refresh_day_of_month?: number;
  }) =>
    request<WaybackProxiesStatus>("/settings/wayback-proxies", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  refreshWaybackProxies: () =>
    request<WaybackProxiesStatus>("/settings/wayback-proxies/refresh", {
      method: "POST",
    }),

  bulkReanalyzeDomains: (
    runDomainIds: number[],
    ai?: { provider?: string; model?: string },
  ) =>
    request<{
      started: number;
      skipped: number;
      items: { run_domain_id: number; started: boolean; error: string }[];
    }>("/database/domains/bulk-reanalyze", {
      method: "POST",
      body: JSON.stringify({
        run_domain_ids: runDomainIds,
        provider: ai?.provider,
        model: ai?.model,
      }),
    }),

  getDashboardStatus: (opts?: { live?: boolean }) =>
    request<DashboardStatus>(
      `/dashboard/status${opts?.live ? "?live=true" : ""}`,
    ),

  getAhrefsUnits: (opts?: { force?: boolean }) =>
    request<AhrefsUnits>(
      `/dashboard/ahrefs-units${opts?.force ? "?force=true" : ""}`,
    ),

  previewAnalyze: (spec: AnalyzeSpec) =>
    request<PreviewResponse>("/analyze/preview", {
      method: "POST",
      body: JSON.stringify(spec),
    }),

  submitJob: (spec: AnalyzeSpec, name?: string, notes?: string) =>
    request<SubmitJobResponse>("/analyze/jobs", {
      method: "POST",
      body: JSON.stringify({ spec, name, notes }),
    }),

  getRunStatus: (runId: number) =>
    request<RunStatus>(`/runs/${runId}/status`),

  // Slim per-tick poll companion to getRun (added 2026-05-14). Returns
  // only the live fields — status pills, criteria/ai_status enums,
  // reanalyzing flag, last_analyzed_at. The expensive parsed columns
  // (language / theme / category / final score) still come from the
  // full /runs/{id} payload; the polling loop overlays slim updates
  // on top of the last full snapshot and auto-fires a full reload
  // whenever a status transition is detected.
  //
  // Pagination (added 2026-05-16). Sends the visible-page offset/limit
  // so 100k-domain runs poll a fixed-size window per tick instead of
  // the full list. `counts` in the response is still run-wide so the
  // header progress bar shows the aggregate state.
  getRunProgress: (
    runId: number,
    opts?: {
      limit?: number;
      offset?: number;
      status?: string;
      // Multi-valued (2026-05-16). Empty/missing = no filter. Each value
      // becomes its own `?availability_status_filter=` query param so
      // FastAPI parses them as a list.
      availabilityStatuses?: string[];
      // Server-side domain substring search (2026-06-14) — keeps the
      // polled window aligned with an active search on the page.
      domainFilter?: string;
    },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status_filter", opts.status);
    for (const s of opts?.availabilityStatuses ?? []) {
      qs.append("availability_status_filter", s);
    }
    if (opts?.domainFilter) qs.set("domain_filter", opts.domainFilter);
    const suffix = qs.toString();
    return request<RunProgress>(
      `/runs/${runId}/progress${suffix ? `?${suffix}` : ""}`,
    );
  },

  // SSE URL for live run status — frontend can subscribe via:
  //   const es = new EventSource(api.runEventsUrl(123));
  //   es.onmessage = (e) => setStatus(JSON.parse(e.data));
  // Stream auto-closes when the run reaches a terminal state. Falls back
  // gracefully: any consumer that can't use EventSource keeps polling
  // `getRunStatus` on a 1-2s cadence as before — the SSE endpoint is
  // additive, not a replacement.
  runEventsUrl: (runId: number) => `${BASE}/runs/${runId}/events`,

  // `kind` filter added Wave 1 (2026-05-15) for the 3-pillar restructure.
  // Defaults to "quality" so the legacy /jobs list page (and any older
  // callers) behave the same. New /jobs/whois-history and /jobs/availability
  // pages pass their own kind.
  listJobs: (
    archived: JobsArchivedFilter = "active",
    kind: JobKind = "quality",
  ) =>
    request<{ jobs: JobsListItem[] }>(
      `/jobs/?archived=${archived}&kind=${kind}`,
    ),

  getJob: (jobId: number) => request<JobDetail>(`/jobs/${jobId}`),

  getJobSpec: (jobId: number) => request<JobSpec>(`/jobs/${jobId}/spec`),

  // Most-recent job's spec — used to pre-fill the Analyze form when the
  // user arrives from the Backlog → Analyze flow. `spec` may be null when
  // no jobs exist yet.
  getLastSpec: () =>
    request<{ spec: AnalyzeSpec | null; job_id?: number; name?: string }>(
      `/analyze/last-spec`,
    ),

  patchJob: (jobId: number, fields: { name?: string; notes?: string }) =>
    request<{ id: number; name: string; notes: string; updated_at: string }>(
      `/jobs/${jobId}`,
      { method: "PATCH", body: JSON.stringify(fields) },
    ),

  deleteJob: (jobId: number) =>
    request<{ deleted: number }>(`/jobs/${jobId}`, { method: "DELETE" }),

  bulkDeleteJobs: (ids: number[]) =>
    request<{ deleted: number[]; missing: number[] }>(`/jobs/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  archiveJob: (jobId: number) =>
    request<{ id: number; archived_at: string }>(
      `/jobs/${jobId}/archive`,
      { method: "POST" },
    ),

  unarchiveJob: (jobId: number) =>
    request<{ id: number; archived_at: null }>(
      `/jobs/${jobId}/unarchive`,
      { method: "POST" },
    ),

  // Post-run Wayback auto-retry config — toggle + budget. See
  // backend/app_settings.get_wayback_auto_retry_config for the
  // field semantics (and the safety caps).
  getWaybackAutoRetry: () =>
    request<{
      config: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
      };
      defaults: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
      };
    }>(`/settings/wayback-auto-retry`),

  updateWaybackAutoRetry: (
    patch: Partial<{
      enabled: boolean;
      max_attempts: number;
      initial_delay_sec: number;
      backoff_multiplier: number;
    }>,
  ) =>
    request<{
      config: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
      };
      defaults: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
      };
    }>(`/settings/wayback-auto-retry`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // Post-run Availability auto-retry config (added 2026-05-18). Sibling
  // of the Wayback toggle above, with an extra `retry_providers` list
  // — only RDs whose terminal failing provider is in this set get
  // auto-retried. Default ["rdap"] keeps RDAP-only (free) retries on
  // and paid Domainr / slow WHOIS retries opt-in.
  getAvailabilityAutoRetry: () =>
    request<{
      config: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
        retry_providers: string[];
      };
      defaults: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
        retry_providers: string[];
      };
      // Whitelist the UI uses to render the checkbox set. Server-
      // side validation enforces the same list; UI just mirrors it
      // so a stale frontend can't request a value the backend will
      // 400 on.
      allowed_providers: string[];
    }>(`/settings/availability-auto-retry`),

  updateAvailabilityAutoRetry: (
    patch: Partial<{
      enabled: boolean;
      max_attempts: number;
      initial_delay_sec: number;
      backoff_multiplier: number;
      retry_providers: string[];
    }>,
  ) =>
    request<{
      config: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
        retry_providers: string[];
      };
      defaults: {
        enabled: boolean;
        max_attempts: number;
        initial_delay_sec: number;
        backoff_multiplier: number;
        retry_providers: string[];
      };
      allowed_providers: string[];
    }>(`/settings/availability-auto-retry`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // Per-Job export bundle download URL. Native `<a download>` consumes
  // this — the response is a gzipped JSON tree (Job + Run + RunDomain
  // + CriterionResult + JobCriterionPin) the user can import on
  // another server via importJob. Auth comes from the browser's cached
  // basic-auth header for /api/*, same as every other API call.
  exportJobUrl: (jobId: number) => `${BASE}/jobs/${jobId}/export`,

  // Multipart upload of a bundle produced by exportJobUrl. Returns the
  // import summary. `dupe_skipped: true` means the bundle's UUID is
  // already present on this server — no rows were inserted, the
  // existing Job's id is returned for convenience.
  importJob: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{
      job_id: number;
      kind: string;
      runs: number;
      run_domains: number;
      criterion_results: number;
      job_criterion_pins: number;
      dupe_skipped: boolean;
    }>(`/jobs/import`, { method: "POST", body: form });
  },

  cancelRun: (runId: number) =>
    request<{ id: number; status?: string; already_terminal?: boolean }>(
      `/runs/${runId}/cancel`,
      { method: "POST" },
    ),

  pauseRun: (runId: number) =>
    request<{ id: number; status?: string }>(`/runs/${runId}/pause`, {
      method: "POST",
    }),

  resumeRun: (runId: number) =>
    request<{ id: number; status?: string }>(`/runs/${runId}/resume`, {
      method: "POST",
    }),

  deleteRun: (runId: number) =>
    request<{ deleted: number }>(`/runs/${runId}`, { method: "DELETE" }),

  patchRun: (runId: number, body: { name?: string }) =>
    request<{ id: number; name: string }>(`/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  getRunCost: (runId: number) =>
    request<RunCost>(`/runs/${runId}/cost`),

  // Per-run scoring override (added 2026-05-13 wave J). preview = no
  // writes, returns the proposed table; recompute = persist override +
  // rewrite finals; reset = clear override + recompute with global.
  previewRunFinal: (runId: number, weights: Record<string, number>) =>
    request<RecomputeFinalResult>(`/runs/${runId}/preview-final`, {
      method: "POST",
      body: JSON.stringify({ weights }),
    }),

  recomputeRunFinal: (runId: number, weights: Record<string, number>) =>
    request<RecomputeFinalResult>(`/runs/${runId}/recompute-final`, {
      method: "POST",
      body: JSON.stringify({ weights }),
    }),

  resetRunFinal: (runId: number) =>
    request<RecomputeFinalResult>(`/runs/${runId}/recompute-final`, {
      method: "DELETE",
    }),

  // Ban list (added 2026-05-13 wave L). All endpoints share the
  // `/banlist` prefix; the bulk-ban-from-Database action lives under
  // `/database/domains/bulk-ban` because that endpoint composes pin
  // resolution from the Database side.
  listBans: (params?: { page?: number; per_page?: number; search?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", String(params.page));
    if (params?.per_page) q.set("per_page", String(params.per_page));
    if (params?.search) q.set("search", params.search);
    const qs = q.toString();
    return request<BanListResponse>(`/banlist${qs ? `?${qs}` : ""}`);
  },

  addBans: (rows: { domain: string; note?: string }[]) =>
    request<BanAddBulkResult>(`/banlist`, {
      method: "POST",
      body: JSON.stringify({
        rows: rows.map((r) => ({ domain: r.domain, note: r.note ?? "" })),
      }),
    }),

  deleteBan: (domain: string) =>
    request<{ deleted: boolean; domain: string }>(
      `/banlist/${encodeURIComponent(domain)}`,
      { method: "DELETE" },
    ),

  bulkDeleteBans: (domains: string[]) =>
    request<{ deleted: number }>(`/banlist/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ domains }),
    }),

  bulkBanFromDatabase: (domains: string[], note: string = "") =>
    request<{ added: number; already_banned: number; invalid: number }>(
      `/database/domains/bulk-ban`,
      {
        method: "POST",
        body: JSON.stringify({ domains, note }),
      },
    ),

  listPricing: () =>
    request<{ rows: ModelPriceRow[]; seeded: number }>(`/settings/pricing`),

  upsertPricing: (
    provider: string,
    model: string,
    body: { input_per_million: number; output_per_million: number },
  ) =>
    request<{
      provider: string;
      model: string;
      input_per_million: number;
      output_per_million: number;
    }>(`/settings/pricing/${provider}/${encodeURIComponent(model)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  deletePricing: (provider: string, model: string) =>
    request<{ deleted: { provider: string; model: string } }>(
      `/settings/pricing/${provider}/${encodeURIComponent(model)}`,
      { method: "DELETE" },
    ),

  rerunJob: (jobId: number, spec: AnalyzeSpec) =>
    request<SubmitJobResponse>(`/jobs/${jobId}/rerun`, {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),

  reanalyzeRun: (runId: number, ai?: { provider?: string; model?: string }) =>
    request<{ id: number; status?: string }>(
      `/runs/${runId}/reanalyze`,
      { method: "POST", body: JSON.stringify(ai || {}) },
    ),

  // Note: every RunDomainProgress now carries `reanalyzing: bool` so the
  // run page can reflect per-RD retry/reanalyze progress without a
  // separate per-domain poll. See backend RunDomainProgress.
  // --- wayback_classify Settings (added 2026-05-09) ---
  getLanguageMode: () =>
    request<{ mode: "ai" | "library" }>(
      "/settings/wayback-classify/language-mode",
    ),

  setLanguageMode: (mode: "ai" | "library") =>
    request<{ mode: "ai" | "library" }>(
      "/settings/wayback-classify/language-mode",
      { method: "PUT", body: JSON.stringify({ mode }) },
    ),

  listCategories: () =>
    request<{ categories: WaybackClassifyCategory[] }>(
      "/settings/wayback-classify/categories",
    ),

  replaceCategories: (items: WaybackClassifyCategory[]) =>
    request<{ categories: WaybackClassifyCategory[] }>(
      "/settings/wayback-classify/categories",
      { method: "PUT", body: JSON.stringify({ items }) },
    ),

  addCategories: (items: WaybackClassifyCategory[]) =>
    request<{ categories: WaybackClassifyCategory[] }>(
      "/settings/wayback-classify/categories",
      { method: "POST", body: JSON.stringify({ items }) },
    ),

  // --- Domain Filter (added 2026-06-07; reshaped 2026-08-24) ---
  // Import-time filter: stop keywords (substring) + an allowed-TLD
  // whitelist toggle. The TLD list itself is the shared Spam Filter
  // (allowed-tlds), so the payload only carries its count for display.
  getDomainFilter: () =>
    request<DomainFilterPayload>("/settings/domain-filter"),

  // Whole-config replace. Keywords are normalised (lower / dedup / sort)
  // server-side; reconcile local state from the response.
  putDomainFilter: (config: DomainFilterConfig) =>
    request<DomainFilterPayload>("/settings/domain-filter", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  // Allowed-TLDs "Spam Filter" — the shared whitelist used by the Domain
  // Filter (import gate), Linked Domains fetch, and SERP exports. `reset`
  // clears the override back to the shipped default; note the server
  // treats an empty list as "reset", so there's no way to allow zero TLDs.
  getAllowedTlds: () => request<AllowedTldsPayload>("/settings/allowed-tlds"),

  putAllowedTlds: (body: { tlds?: string[]; reset?: boolean }) =>
    request<AllowedTldsPayload>("/settings/allowed-tlds", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // --- Stop words (Settings → Brain, added 2026-08-24) ---
  // The spoiled-niche vocabulary consumed by the Stop Words quality
  // criterion. Whole-list replace on PUT; the server trims, lower-cases,
  // dedups and sorts, so the caller MUST reconcile from the response
  // rather than trusting its optimistic local order.
  getStopWords: () => request<StopWordsPayload>("/settings/stop-words"),

  putStopWords: (terms: string[]) =>
    request<StopWordsPayload>("/settings/stop-words", {
      method: "PUT",
      body: JSON.stringify({ terms }),
    }),

  retryFailedRun: (
    runId: number,
    ai?: { provider?: string; model?: string },
  ) =>
    request<{
      id: number;
      status?: string;
      domains?: number;
      criteria?: number;
    }>(
      `/runs/${runId}/retry-failed`,
      { method: "POST", body: JSON.stringify(ai || {}) },
    ),

  // Force-cancel an in-flight Retry-failed dispatch (added 2026-05-24).
  // The standard cancel endpoint short-circuits on terminal runs (which
  // retry-failed always runs against), so this is the only path to stop
  // a runaway retry. Returns counts of cancelled tasks + flipped RDs.
  cancelRetryFailedRun: (runId: number) =>
    request<{
      id: number;
      found: boolean;
      canceled_tasks: number;
      flipped_rds: number;
      status: string;
    }>(
      `/runs/${runId}/cancel-retry-failed`,
      { method: "POST" },
    ),

  // Scoped retry — pick exact RDs + (optional) criterion allow-list.
  // Drives the Run-page filter + multi-select + bulk-retry flow
  // (added 2026-05-12).
  retryRunBatch: (
    runId: number,
    runDomainIds: number[],
    opts?: {
      criteria?: string[] | null;
      provider?: string;
      model?: string;
      // 2026-05-13: re-collect V2 page samples against the existing
      // wayback CR's CDX rows instead of refetching CDX. Only meaningful
      // when "wayback" is in the criteria allow-list (or criteria=null).
      // Backend cascades wayback_classify so it picks up fresh samples.
      waybackResampleOnly?: boolean;
    },
  ) =>
    request<{
      id: number;
      status?: string;
      domains?: number;
      criteria?: number;
    }>(
      `/runs/${runId}/retry-batch`,
      {
        method: "POST",
        body: JSON.stringify({
          run_domain_ids: runDomainIds,
          criteria: opts?.criteria ?? null,
          provider: opts?.provider,
          model: opts?.model,
          wayback_resample_only: opts?.waybackResampleOnly ?? false,
        }),
      },
    ),

  reanalyzeRunDomain: (
    runDomainId: number,
    ai?: { provider?: string; model?: string },
  ) =>
    request<{ id: number; status?: string }>(
      `/run-domains/${runDomainId}/reanalyze`,
      { method: "POST", body: JSON.stringify(ai || {}) },
    ),

  reanalyzeRunDomainCriterion: (
    runDomainId: number,
    criterion: Criterion,
    ai?: { provider?: string; model?: string },
  ) =>
    request<{ id: number; status?: string }>(
      `/run-domains/${runDomainId}/reanalyze-criterion`,
      {
        method: "POST",
        body: JSON.stringify({
          criterion,
          provider: ai?.provider,
          model: ai?.model,
        }),
      },
    ),

  getAiPreview: (runDomainId: number, criterion: Criterion) =>
    request<AiPreview>(
      `/run-domains/${runDomainId}/ai-preview/${criterion}`,
    ),

  // Full run detail (added 2026-05-16: paginated). `opts` lets the
  // caller request a slice of domains by offset/limit + an optional
  // status filter. Defaults (200 / 0 / no filter) preserve pre-
  // pagination behavior for callers that don't pass opts. `total_count`
  // + `filtered_count` on the response drive the page footer.
  getRun: (
    runId: number,
    opts?: {
      limit?: number;
      offset?: number;
      status?: string;
      availabilityStatuses?: string[];
      // Server-side domain substring search (2026-06-14). Used by the
      // server-paginated Run page so search spans the whole run.
      domainFilter?: string;
    },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status_filter", opts.status);
    for (const s of opts?.availabilityStatuses ?? []) {
      qs.append("availability_status_filter", s);
    }
    if (opts?.domainFilter) qs.set("domain_filter", opts.domainFilter);
    const suffix = qs.toString();
    return request<RunDetail>(`/runs/${runId}${suffix ? `?${suffix}` : ""}`);
  },

  // All RunDomain ids matching the given filters (2026-06-14). Powers
  // "select all matching" on the server-paginated Run page — the page no
  // longer has the full set in memory, so it asks the server for the ids.
  getRunDomainIds: (
    runId: number,
    opts?: {
      status?: string;
      availabilityStatuses?: string[];
      domainFilter?: string;
    },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set("status_filter", opts.status);
    for (const s of opts?.availabilityStatuses ?? []) {
      qs.append("availability_status_filter", s);
    }
    if (opts?.domainFilter) qs.set("domain_filter", opts.domainFilter);
    const suffix = qs.toString();
    return request<{ ids: number[]; count: number }>(
      `/runs/${runId}/domain-ids${suffix ? `?${suffix}` : ""}`,
    );
  },

  getRunDomain: (runDomainId: number) =>
    request<RunDomainDetail>(`/run-domains/${runDomainId}`),

  getRunSummary: (runId: number) =>
    request<RunSummaryResponse>(`/runs/${runId}/summary`),

  // AI prompts
  listPrompts: () => request<AIPrompt[]>("/settings/prompts"),
  updatePrompt: (key: string, value: string) =>
    request<{ key: string; value: string; is_custom: boolean }>(
      `/settings/prompts/${key}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    ),
  resetPrompt: (key: string) =>
    request<{ key: string; value: string; is_custom: boolean }>(
      `/settings/prompts/${key}`,
      { method: "DELETE" },
    ),

  updateProviderCreds: (provider: string, fields: Record<string, string>) =>
    request<ProviderStatus>(`/settings/providers/${provider}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),

  listKnownModels: (provider: string) =>
    request<{ provider: string; models: string[] }>(
      `/settings/providers/${provider}/models`,
    ),

  // Replace the entire list. Used after star (default change), delete, or
  // explicit "Save list" actions. Returns the cleaned, deduped persisted list.
  replaceKnownModels: (provider: string, models: string[]) =>
    request<{ provider: string; models: string[] }>(
      `/settings/providers/${provider}/models`,
      { method: "PUT", body: JSON.stringify({ models }) },
    ),

  // Merge entries into the existing list (dedup, preserve order). Used for
  // both bulk paste (one model per line) and the "+ Add model" button.
  addKnownModels: (provider: string, models: string[]) =>
    request<{ provider: string; models: string[] }>(
      `/settings/providers/${provider}/models`,
      { method: "POST", body: JSON.stringify({ models }) },
    ),

  clearProvider: (provider: string) =>
    request<ProviderStatus>(`/settings/providers/${provider}`, {
      method: "DELETE",
    }),

  testProvider: async (provider: string): Promise<TestResult> => {
    try {
      const data = await request<Record<string, unknown>>(
        `/settings/providers/${provider}/test`,
        { method: "POST" },
      );
      return { ok: true, ...data };
    } catch (e: unknown) {
      const err = e as { status?: number; body?: string; message?: string };
      let detail: string = err.body || err.message || "request failed";
      try {
        const parsed = JSON.parse(err.body || "");
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {}
      return { ok: false, error: detail, status: err.status };
    }
  },

  updateRateLimits: (provider: string, values: Partial<RateLimits>) =>
    request<RateLimits>(`/settings/rate-limits/${provider}`, {
      method: "PUT",
      body: JSON.stringify(values),
    }),

  getScoringConfig: () =>
    request<ScoringConfigEnvelope>("/settings/scoring"),

  updateScoringConfig: (cfg: Partial<ScoringConfig>) =>
    request<ScoringConfigEnvelope>("/settings/scoring", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  resetScoringConfig: () =>
    request<ScoringConfigEnvelope>("/settings/scoring", { method: "DELETE" }),

  getClassifyContext: () =>
    request<ClassifyContextEnvelope>("/settings/classify-context"),

  updateClassifyContext: (cfg: Partial<ClassifyContextConfig>) =>
    request<ClassifyContextEnvelope>("/settings/classify-context", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  resetClassifyContext: () =>
    request<ClassifyContextEnvelope>("/settings/classify-context", {
      method: "DELETE",
    }),

  listErrors: (opts: {
    category?: ErrorCategory | "all";
    status?: ErrorStatus;
    search?: string;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.category) q.set("category", opts.category);
    if (opts.status) q.set("status", opts.status);
    if (opts.search) q.set("search", opts.search);
    if (opts.limit) q.set("limit", String(opts.limit));
    return request<ErrorListResponse>(`/errors?${q.toString()}`);
  },

  dismissError: (
    sourceKind: ErrorSourceKind,
    sourceId: number,
    messageHash: string,
  ) =>
    request<{ dismissed_at: string }>(`/errors/dismiss`, {
      method: "POST",
      body: JSON.stringify({
        source_kind: sourceKind,
        source_id: sourceId,
        message_hash: messageHash,
      }),
    }),

  restoreError: (
    sourceKind: ErrorSourceKind,
    sourceId: number,
    messageHash: string,
  ) =>
    request<{ restored: true }>(`/errors/restore`, {
      method: "POST",
      body: JSON.stringify({
        source_kind: sourceKind,
        source_id: sourceId,
        message_hash: messageHash,
      }),
    }),

  dismissAllErrors: (opts: {
    category?: ErrorCategory;
    search?: string;
  } = {}) =>
    request<{ dismissed: number }>(`/errors/dismiss-all`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  dismissManyErrors: (
    items: {
      source_kind: ErrorSourceKind;
      source_id: number;
      message_hash: string;
    }[],
  ) =>
    request<{ dismissed: number; touched: number }>(
      `/errors/dismiss-many`,
      { method: "POST", body: JSON.stringify({ items }) },
    ),

  deleteLogError: (errorLogId: number) =>
    request<{ deleted: number }>(`/errors/log/${errorLogId}`, {
      method: "DELETE",
    }),

  // Error retention. `days` of null means "Never auto-prune".
  getErrorRetention: () =>
    request<{ days: number | null; options: number[] }>(`/errors/retention`),

  setErrorRetention: (days: number | null) =>
    request<{ days: number | null }>(`/errors/retention`, {
      method: "PUT",
      body: JSON.stringify({ days }),
    }),

  // ---- Backlog --------------------------------------------------------------
  listBacklog: (opts: BacklogListOpts = {}) => {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.per_page) params.set("per_page", String(opts.per_page));
    if (opts.search) params.set("search", opts.search);
    if (opts.status && opts.status.length)
      params.set("status", opts.status.join(","));
    // Registrar is sent as repeated query params (not comma-joined) so
    // values that legitimately contain commas — e.g. "seo.domains: DR
    // >=10, en, ru, it, pt" — survive the trip. status / availability
    // are short well-known enums, no commas inside, so they stay CSV.
    if (opts.registrar && opts.registrar.length)
      for (const r of opts.registrar) params.append("registrar", r);
    if (opts.expiry_from) params.set("expiry_from", opts.expiry_from);
    if (opts.expiry_to) params.set("expiry_to", opts.expiry_to);
    if (opts.availability && opts.availability.length)
      params.set("availability", opts.availability.join(","));
    if (opts.max_price_min && opts.max_price_min > 0)
      params.set("max_price_min", String(opts.max_price_min));
    if (opts.max_price_max && opts.max_price_max > 0)
      params.set("max_price_max", String(opts.max_price_max));
    if (opts.notes && opts.notes !== "any")
      params.set("notes", opts.notes);
    if (opts.sort) {
      params.set("sort", opts.sort);
      if (opts.direction) params.set("direction", opts.direction);
    }
    if (opts.include_options === false) {
      params.set("include_options", "false");
    }
    const qs = params.toString();
    return request<BacklogListResponse>(`/backlog${qs ? "?" + qs : ""}`);
  },

  bulkBacklogStatus: (ids: number[], status: BacklogStatus) =>
    request<{ updated: number }>(`/backlog/bulk-status`, {
      method: "POST",
      body: JSON.stringify({ ids, status }),
    }),

  bulkBacklogDelete: (ids: number[]) =>
    request<{ deleted: number }>(`/backlog/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  // Delete every row matching the given filters (no pagination — works
  // across the entire filtered set). Mirrors bulkBacklogStatusFiltered.
  bulkBacklogDeleteFiltered: (filters: {
    search?: string;
    status?: BacklogStatus[];
    registrar?: string[];
    expiry_from?: string;
    expiry_to?: string;
    availability?: string[];
    max_price_min?: number;
    max_price_max?: number;
    notes?: string;
  }) =>
    request<{ deleted: number }>(`/backlog/bulk-delete-filtered`, {
      method: "POST",
      body: JSON.stringify({
        search: filters.search || "",
        status_filter: filters.status?.length
          ? filters.status.join(",")
          : null,
        // Registrar is now an explicit list (commas inside a name no
        // longer break the filter).
        registrar: filters.registrar?.length ? filters.registrar : null,
        expiry_from: filters.expiry_from || null,
        expiry_to: filters.expiry_to || null,
        availability: filters.availability?.length
          ? filters.availability.join(",")
          : null,
        max_price_min: filters.max_price_min || 0,
        max_price_max: filters.max_price_max || 0,
        notes: filters.notes || "any",
      }),
    }),

  // Move-to-source (2026-08-05): bulk re-tag the "Source" (registrar) of
  // selected backlog rows (by id) so small check-batches merge under one
  // source. Mirrors bulkBacklogStatus.
  bulkBacklogSetRegistrar: (ids: number[], source: string) =>
    request<{ updated: number; source: string }>(
      `/backlog/bulk-set-registrar`,
      { method: "POST", body: JSON.stringify({ ids, source }) },
    ),

  // Set "Source" (registrar) on every row matching the filters — the "move
  // all filtered to one source" sweep (e.g. all un-checked leftovers → one
  // list). Mirrors bulkBacklogSetRegistrar / bulkBacklogStatusFiltered.
  bulkBacklogSetRegistrarFiltered: (
    source: string,
    filters: {
      search?: string;
      status?: BacklogStatus[];
      registrar?: string[];
      expiry_from?: string;
      expiry_to?: string;
      availability?: string[];
      max_price_min?: number;
      max_price_max?: number;
      notes?: string;
    },
  ) =>
    request<{ updated: number; source: string }>(
      `/backlog/bulk-set-registrar-filtered`,
      {
        method: "POST",
        body: JSON.stringify({
          source,
          search: filters.search || "",
          status_filter: filters.status?.length
            ? filters.status.join(",")
            : null,
          registrar: filters.registrar?.length ? filters.registrar : null,
          expiry_from: filters.expiry_from || null,
          expiry_to: filters.expiry_to || null,
          availability: filters.availability?.length
            ? filters.availability.join(",")
            : null,
          max_price_min: filters.max_price_min || 0,
          max_price_max: filters.max_price_max || 0,
          notes: filters.notes || "any",
        }),
      },
    ),

  // Backlog rows whose domain has been analyzed elsewhere but the
  // backlog status hasn't been moved to 'analyzed'/'discarded' yet.
  // Returns count + the row ids so the UI can hand them straight to
  // bulkBacklogStatus without re-querying.
  getBacklogAnalyzedPending: () =>
    request<{ count: number; ids: number[] }>(`/backlog/analyzed-pending`),

  // Send a backlog batch to Analyze: returns the resolved domain list
  // and flips those rows' status to 'in_progress' as a side effect (the
  // locked exception to manual-only status changes).
  sendBacklogToAnalyze: (
    payload:
      | { scope: "ids"; ids: number[] }
      | {
          scope: "filtered";
          search?: string;
          status?: BacklogStatus[];
          registrar?: string[];
          expiry_from?: string;
          expiry_to?: string;
          availability?: string[];
          max_price_min?: number;
          max_price_max?: number;
          notes?: string;
        },
  ) => {
    if (payload.scope === "ids") {
      return request<{
        domains: string[];
        count: number;
        status_changed: number;
      }>(`/backlog/send-to-analyze`, {
        method: "POST",
        body: JSON.stringify({ scope: "ids", ids: payload.ids }),
      });
    }
    return request<{
      domains: string[];
      count: number;
      status_changed: number;
    }>(`/backlog/send-to-analyze`, {
      method: "POST",
      body: JSON.stringify({
        scope: "filtered",
        search: payload.search || "",
        status_filter: payload.status?.length
          ? payload.status.join(",")
          : null,
        registrar: payload.registrar?.length ? payload.registrar : null,
        expiry_from: payload.expiry_from || null,
        expiry_to: payload.expiry_to || null,
        availability: payload.availability?.length
          ? payload.availability.join(",")
          : null,
        max_price_min: payload.max_price_min || 0,
        max_price_max: payload.max_price_max || 0,
        notes: payload.notes || "any",
      }),
    });
  },

  // Apply a status to every row matching the given filters (no
  // pagination — works across the entire filtered set).
  bulkBacklogStatusFiltered: (
    status: BacklogStatus,
    filters: {
      search?: string;
      status?: BacklogStatus[];
      registrar?: string[];
      expiry_from?: string;
      expiry_to?: string;
      availability?: string[];
      max_price_min?: number;
      max_price_max?: number;
      notes?: string;
    },
  ) =>
    request<{ updated: number }>(`/backlog/bulk-status-filtered`, {
      method: "POST",
      body: JSON.stringify({
        status,
        search: filters.search || "",
        // Note the rename: `status` in the body is the *new* value;
        // `status_filter` carries the filter selection so they don't
        // collide.
        status_filter: filters.status?.length ? filters.status.join(",") : null,
        registrar: filters.registrar?.length ? filters.registrar : null,
        expiry_from: filters.expiry_from || null,
        expiry_to: filters.expiry_to || null,
        availability: filters.availability?.length
          ? filters.availability.join(",")
          : null,
        max_price_min: filters.max_price_min || 0,
        max_price_max: filters.max_price_max || 0,
        notes: filters.notes || "any",
      }),
    }),

  importBacklog: (rows: BacklogImportRow[]) =>
    request<BacklogImportResult>(`/backlog/import`, {
      method: "POST",
      body: JSON.stringify({ rows }),
    }),

  // User-configurable cap on rows the CSV import wizard will accept.
  // Default 50000; bounds (min/max) come from the backend so the UI
  // doesn't have to hard-code them.
  getBacklogImportLimit: () =>
    request<{ rows: number; min: number; max: number }>(
      `/backlog/import-limit`,
    ),

  setBacklogImportLimit: (rows: number) =>
    request<{ rows: number }>(`/backlog/import-limit`, {
      method: "PUT",
      body: JSON.stringify({ rows }),
    }),

  updateBacklogRow: (id: number, patch: BacklogRowPatch) =>
    request<BacklogRow>(`/backlog/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // --- Backlog status from Database (added 2026-05-10) ---
  // Upsert: PATCHes the matching backlog row, or creates one if the
  // domain isn't in Backlog yet (ad-hoc analyzed). Returns the row's
  // post-update state plus a `created` flag so the UI can hint at it.
  // Lazy pin options — full PinOption list for one domain. Loaded
  // on-demand when the user opens the pin dropdown on the Database
  // page so the list response stays small.
  getDomainPinOptions: (domain: string) =>
    request<{ domain: string; options: PinOption[] }>(
      `/database/domains/${encodeURIComponent(domain)}/pin-options`,
    ),

  setDomainBacklogStatus: (domain: string, status: BacklogStatus) =>
    request<{
      domain: string;
      backlog_id: number;
      status: BacklogStatus;
      created: boolean;
    }>(`/database/domains/${encodeURIComponent(domain)}/backlog-status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  bulkSetDomainBacklogStatus: (
    domains: string[],
    status: BacklogStatus,
  ) =>
    request<{
      updated: number;
      created: number;
      skipped: number;
      status: BacklogStatus;
    }>("/database/domains/bulk-backlog-status", {
      method: "POST",
      body: JSON.stringify({ domains, status }),
    }),

  // Bulk re-tag the "Source" (BacklogDomain.registrar) of selected Database
  // domains — the "move to source" action used to merge small check-batches
  // under one source name. Upserts a backlog row for any domain not in the
  // backlog yet.
  bulkSetDomainSource: (domains: string[], source: string) =>
    request<{
      updated: number;
      created: number;
      skipped: number;
      skipped_banned: number;
      source: string;
    }>("/database/domains/bulk-set-source", {
      method: "POST",
      body: JSON.stringify({ domains, source }),
    }),

  // Move-to-source across the WHOLE filtered set (every page, not just the
  // selection) — mirrors listDatabaseDomains's filter shape so the backend
  // resolves exactly the rows the page shows, server-side (no giant
  // fetch-all-rows round-trip). `opts.source` is the Source FILTER; the first
  // arg is the source to SET.
  bulkSetDomainSourceFiltered: (source: string, opts: DatabaseListOpts = {}) =>
    request<{
      updated: number;
      created: number;
      skipped: number;
      skipped_banned: number;
      source: string;
    }>("/database/domains/bulk-set-source-filtered", {
      method: "POST",
      body: JSON.stringify({
        source,
        verdict: opts.verdict ?? null,
        wayback_verdict: opts.wayback_verdict ?? null,
        stop_words_verdict: opts.stop_words_verdict ?? null,
        whois_band: opts.whois_band ?? null,
        availability: opts.availability ?? null,
        language: opts.language ?? null,
        language_match: opts.language_match ?? "primary",
        category: opts.category ?? null,
        criterion: opts.criterion ?? null,
        source_filter: opts.source ?? null,
        status: opts.status ?? null,
        notes: opts.notes ?? "any",
        wayback_conf_min: opts.wayback_conf_min ?? 0,
        ahrefs_conf_min: opts.ahrefs_conf_min ?? 0,
        dr_min: opts.dr_min ?? 0,
        ref_domains_min: opts.ref_domains_min ?? 0,
        whois_cycles_max: opts.whois_cycles_max ?? 0,
        max_price_min: opts.max_price_min ?? 0,
        max_price_max: opts.max_price_max ?? 0,
        search: opts.search ?? "",
        show_taken: opts.show_taken ?? false,
      }),
    }),

  // --- DB backups (added 2026-05-10) ---
  getBackupStatus: () => request<BackupStatus>("/backups/"),
  runBackupNow: () =>
    request<BackupRunResult>("/backups/run", { method: "POST" }),
  getRemoteBackup: () =>
    request<RemoteBackupConfig>("/backups/remote"),
  setRemoteBackup: (patch: Partial<RemoteBackupSetPayload>) =>
    request<RemoteBackupConfig>("/backups/remote", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  testRemoteBackup: () =>
    request<{ ok: boolean; bucket: string; region: string }>(
      "/backups/remote/test",
      { method: "POST" },
    ),

  restoreBackup: (filename: string) =>
    request<{
      restored_from: string;
      prerestore_snapshot: string;
      prerestore_size_bytes: number;
    }>("/backups/restore", {
      method: "POST",
      body: JSON.stringify({ filename }),
    }),

  // Download URL for a snapshot (added 2026-05-27). Returns the
  // absolute path the browser should navigate to — we don't fetch
  // here because triggering a multi-MB download through XHR forces a
  // full in-memory blob; a direct `<a href=...>` lets the browser
  // stream it to disk like any other download.
  backupDownloadUrl: (filename: string) =>
    `${BASE}/backups/${encodeURIComponent(filename)}/download`,

  // Manual delete (added 2026-05-27). Used by the per-row trash icon
  // in the Backups settings table to free space on demand without
  // waiting for natural rotation. Both regular and prerestore
  // snapshots are deletable; the backend sanitizes the filename so
  // path traversal can't escape BACKUP_DIR.
  deleteBackup: (filename: string) =>
    request<{
      filename: string;
      size_bytes: number;
      prerestore: boolean;
    }>(`/backups/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    }),

  // Upload a local .db.gz and immediately restore from it. Bypasses
  // the JSON `request()` wrapper because file uploads need multipart
  // and the browser must set the Content-Type with the boundary.
  uploadAndRestoreBackup: async (file: File): Promise<{
    imported_filename: string;
    imported_size_bytes: number;
    restored_from: string;
    prerestore_snapshot: string;
    prerestore_size_bytes: number;
  }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/backups/upload-restore`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw Object.assign(new Error(body || `HTTP ${res.status}`), {
        status: res.status,
        body,
      });
    }
    return res.json();
  },

  // --- View-only share links (added 2026-05-15) ---
  createShare: (payload: {
    run_domain_id: number;
    note?: string;
    expires_in_days?: number | null;
  }) =>
    request<ShareRecord>("/shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listShares: (params: {
    page?: number;
    per_page?: number;
    status?: "all" | "active" | "revoked" | "expired";
    search?: string;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.page != null) qs.set("page", String(params.page));
    if (params.per_page != null) qs.set("per_page", String(params.per_page));
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<{
      total: number;
      page: number;
      per_page: number;
      items: ShareRecord[];
    }>(`/shares${q ? `?${q}` : ""}`);
  },
  updateShare: (
    token: string,
    patch: { note?: string; expires_at?: string | "clear" | null },
  ) =>
    request<ShareRecord>(`/shares/${encodeURIComponent(token)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  revokeShare: (token: string) =>
    request<ShareRecord>(`/shares/${encodeURIComponent(token)}`, {
      method: "DELETE",
    }),
  bulkRevokeShares: (tokens: string[]) =>
    request<{ revoked: number; requested: number }>("/shares/bulk-revoke", {
      method: "POST",
      body: JSON.stringify({ tokens }),
    }),
  revokeAllActiveShares: () =>
    request<{ revoked: number }>("/shares", { method: "DELETE" }),

  // --- Activate + hard-delete (added 2026-05-24) ---
  activateShare: (token: string) =>
    request<ShareRecord>(
      `/shares/${encodeURIComponent(token)}/activate`,
      { method: "POST" },
    ),
  hardDeleteShare: (token: string) =>
    request<{ deleted: number; token: string }>(
      `/shares/${encodeURIComponent(token)}/hard`,
      { method: "DELETE" },
    ),
  // Empty `tokens` → delete every currently-revoked row (nuclear).
  // Non-empty `tokens` → only delete those tokens IF revoked.
  deleteRevokedShares: (tokens: string[] = []) =>
    request<{ deleted: number }>("/shares/delete-revoked", {
      method: "POST",
      body: JSON.stringify({ tokens }),
    }),

  // --- Share defaults (added 2026-05-24) ---
  getShareSettings: () =>
    request<ShareSettings>("/shares/settings"),
  updateShareSettings: (patch: { default_expires_in_days?: number }) =>
    request<ShareSettings>("/shares/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  resetShareSettings: () =>
    request<ShareSettings>("/shares/settings", { method: "DELETE" }),

  // --- Database 1-click quick-share (added 2026-05-24) ---
  // Returns an error string in the response body when the domain has
  // no analyzed RunDomain yet — callers should check `error` before
  // composing the share URL.
  databaseQuickShare: (domain: string) =>
    request<QuickShareResult>("/database/quick-share", {
      method: "POST",
      body: JSON.stringify({ domain }),
    }),

  // --- Domain-page 1-click quick-share (added 2026-05-24) ---
  // Sibling of databaseQuickShare keyed by run_domain_id (the Domain
  // page already knows EXACTLY which rd it's looking at — no
  // domain → pinned-rd resolution needed). Same reuse-or-mint
  // semantics; same response shape.
  quickShareForRd: (runDomainId: number) =>
    request<QuickShareResult>("/shares/quick", {
      method: "POST",
      body: JSON.stringify({ run_domain_id: runDomainId }),
    }),

  // Public-view fetch — used by the /share/[token] page. Bypasses the
  // basic-auth gate because Caddy whitelists /api/public/* for the
  // token-only access path. We still go through the standard `request`
  // wrapper because the auth shape is identical (browser uses its
  // cached basic-auth credentials for `/api/*` even on the share page,
  // but the Caddy bypass means a viewer who DOESN'T have them will
  // still get through).
  getPublicShare: (token: string) =>
    request<PublicShareDetail>(
      `/public/share/${encodeURIComponent(token)}`,
    ),

  // --- Whois History pillar (Wave 2, 2026-05-15) ---
  getWhoisHistorySettings: () =>
    request<WhoisHistorySettings>("/settings/whois-history"),
  setWhoisHistorySetting: (key: string, value: string) =>
    request<{ updated: string }>("/settings/whois-history", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),
  setWhoisHistoryApiKey: (apiKey: string) =>
    request<{ ok: boolean; api_key_set: boolean }>(
      "/settings/whois-history/api-key",
      {
        method: "PUT",
        body: JSON.stringify({ api_key: apiKey }),
      },
    ),
  testWhoisHistory: (domain?: string) =>
    request<WhoisHistoryTestResult>("/settings/whois-history/test", {
      method: "POST",
      body: JSON.stringify(
        domain && domain.trim() ? { domain: domain.trim() } : {},
      ),
    }),
  setWhoisHistoryRateLimits: (values: {
    rpm?: number;
    max_concurrent?: number;
  }) =>
    request<{ updated: string[] }>("/settings/whois-history/rate-limits", {
      method: "PUT",
      body: JSON.stringify(values),
    }),
  submitWhoisHistoryJob: (payload: {
    domains: string[];
    ai_provider: string;
    ai_model?: string;
    name?: string;
    notes?: string;
    lang?: string;
  }) =>
    request<{
      job_id: number;
      run_id: number;
      skipped_banned: string[];
    }>("/analyze/whois-history", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // Availability pillar submit (Wave 3, 2026-05-15). No AI fields —
  // the cascade gives a deterministic verdict. Forces fresh state per
  // Job server-side (use_cache=False on the canonical spec).
  submitAvailabilityJob: (payload: {
    domains: string[];
    name?: string;
    notes?: string;
    lang?: string;
  }) =>
    request<{
      job_id: number;
      run_id: number;
      skipped_banned: string[];
    }>("/analyze/availability", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  submitAhrefsBatchAnalysisJob: (payload: {
    domains: string[];
    metrics: string[];
    country?: string | null;
    name?: string;
    notes?: string;
  }) =>
    request<{
      job_id: number;
      run_id: number;
      skipped_banned: string[];
    }>("/analyze/ahrefs-batch-analysis", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

// Canonical Ahrefs batch-analysis metric ids + labels — mirror of the
// backend providers/ahrefs_batch.BATCH_METRICS (same ids + order). Drives
// the setup-page checkboxes and the run-page metric columns.
export const AHREFS_BATCH_METRICS: { id: string; label: string }[] = [
  { id: "domain_rating", label: "DR" },
  { id: "refdomains_dofollow", label: "Ref domains (follow)" },
  { id: "refdomains_nofollow", label: "Ref domains (nofollow)" },
  { id: "backlinks_dofollow", label: "Backlinks (follow)" },
  { id: "refips_subnets", label: "Ref IP subnets" },
  { id: "org_traffic", label: "Organic traffic" },
  { id: "org_keywords", label: "Organic keywords" },
  { id: "org_keywords_4_10", label: "Organic keywords 4-10" },
  { id: "org_keywords_11_20", label: "Organic keywords 11-20" },
];

// Format a batch-analysis metric value for display: DR is a 1-decimal
// float, everything else an integer count. null → "—".
export function formatBatchMetric(id: string, v: number | null | undefined): string {
  if (v == null) return "—";
  if (id === "domain_rating") return v.toFixed(1);
  return Math.round(v).toLocaleString();
}

// Absolute URL for the run's batch-analysis CSV export (streamed by the
// backend). Goes through the same /api base the request() helper uses.
export function ahrefsBatchAnalysisCsvUrl(runId: number): string {
  return `${BASE}/runs/${runId}/ahrefs-batch-analysis.csv`;
}

// Absolute URL for an availability run's verdict CSV (streamed by the
// backend) — server-side counterpart of the old client CSV, used once the
// availability Run page paginates server-side.
export function availabilityCsvUrl(runId: number): string {
  return `${BASE}/runs/${runId}/availability.csv`;
}

export type WhoisHistoryTestResult =
  | {
      ok: true;
      domain: string;
      provider: string;
      records_found: number;
      latest_record_preview: {
        query_time: string | null;
        creation_date: string | null;
        expiry_date: string | null;
        registrar_name: string;
        registrant_country: string;
        domain_status: string[];
      } | null;
    }
  | {
      ok: false;
      domain: string;
      error: string;
    };

// --- Whois History types (added Wave 2, 2026-05-15) ---
export type WhoisHistorySettings = {
  provider: string;
  // Backend never round-trips the API key; this flag is "do we have
  // one stored?" so the UI can show set/unset state without leaking
  // the secret. Pair with setWhoisHistoryApiKey to write.
  api_key_set: boolean;
  max_records: number;
  coverage_gap_threshold_days: number;
  drop_confidence_threshold: number;
  // Plan-tier multiplier — how many WhoisFreaks units one request
  // consumes (Wave 2b, 2026-05-15). Default 1 (free tier); operator
  // updates to match the value shown on their WhoisFreaks dashboard.
  units_per_request: number;
  // Rate limits applied to the configured provider (Wave 2b,
  // 2026-05-15). Storing per-provider means a future provider swap
  // doesn't inherit WhoisFreaks's tuning.
  rate_limits: { rpm: number; max_concurrent: number };
};

// --- Share-link types (added 2026-05-15) ---

export type ShareRecord = {
  token: string;
  run_domain_id: number;
  domain: string;
  job_id: number | null;
  job_name: string;
  run_id: number | null;
  note: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  is_active: boolean;
};

// Effective share defaults blob — `defaults` echoes the shipped values
// so the FE can render a "Reset to default" affordance without a
// separate round-trip.
export type ShareSettings = {
  default_expires_in_days: number;
  defaults: { default_expires_in_days: number };
};

// `POST /database/quick-share` response. `error` is non-empty when the
// domain has no analyzed RunDomain or token allocation failed.
export type QuickShareResult = {
  domain: string;
  run_domain_id: number | null;
  token: string | null;
  share_url: string | null;
  expires_at: string | null;
  reused: boolean;
  error: string;
};

// Same shape as RunDomainDetail minus operator-only fields. We type it
// as a loose dict here rather than a sister of RunDomainDetail because
// the public page only reads a fixed subset (domain, criteria, final).
export type PublicShareDetail = {
  id: number;
  domain: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  last_analyzed_at: string | null;
  error: string;
  criteria: Record<string, Record<string, unknown>>;
  final_assessment: Record<string, unknown> | null;
  final_summary: string;
  note: string;
  note_updated_at: string | null;
  share: {
    token: string;
    shared_at: string;
    expires_at: string | null;
    note: string;
  };
};

export type BackupSnapshot = {
  filename: string;
  size_bytes: number;
  created_at: string;
  age_seconds: number;
  // True for safety snapshots auto-written right before a restore.
  // Exempt from rotation; UI flags them so the user knows what
  // they're looking at.
  prerestore: boolean;
};

export type BackupStatus = {
  enabled: boolean;
  interval_hours: number;
  keep: number;
  backup_dir: string;
  supported: boolean;
  db_path: string | null;
  snapshots: BackupSnapshot[];
  remote: RemoteBackupConfig;
};

export type BackupRunResult = {
  filename: string;
  size_bytes: number;
  created_at: string;
  pruned: number;
  remote: { bucket: string; key: string; size_bytes: number } | null;
  remote_error: string | null;
};

// Secrets come back as the masked shape; non-secrets are plain strings.
export type RemoteBackupSecret = {
  set: boolean;
  last4: string;
  length: number;
};

export type RemoteBackupConfig = {
  enabled: boolean;
  provider_label: string;
  endpoint_url: string;
  region: string;
  bucket: string;
  access_key_id: RemoteBackupSecret;
  secret_access_key: RemoteBackupSecret;
  prefix: string;
};

// What we POST back. Strings only — empty string for a secret means
// "leave unchanged"; null means "clear it".
export type RemoteBackupSetPayload = {
  enabled: boolean | null;
  provider_label: string;
  endpoint_url: string;
  region: string;
  bucket: string;
  access_key_id: string | null;
  secret_access_key: string | null;
  prefix: string;
};



export type BacklogRowPatch = {
  project?: string;
  comments?: string;
  desired_price?: number | null;
  max_price?: number | null;
  // ISO date `YYYY-MM-DD` (or null to clear). Backend's `UpdateRowIn`
  // accepts a Pydantic `date` field; sending the ISO string keeps the
  // wire format identical to what `BacklogRow.expiration_date` looks
  // like on the way back.
  expiration_date?: string | null;
};

export type BacklogImportRow = {
  domain: string;
  status?: BacklogStatus;
  registrar?: string;
  expiration_date?: string | null; // ISO YYYY-MM-DD
  project?: string;
  comments?: string;
  desired_price?: number | null;
  max_price?: number | null;
  // Ahrefs DR (0-100) captured at import (added 2026-05-20).
  // Storage-only — not surfaced in the Backlog page or Database page
  // UI yet; reserved for a future order-list export. Numeric; the
  // importer's parser drops malformed cells to null.
  ahrefs_dr?: number | null;
  // Domain age in years (added 2026-05-20). Same storage-only
  // contract as ahrefs_dr.
  domain_age_years?: number | null;
  // Ahrefs Rank (added 2026-06-14). Storage-only, mirrors ahrefs_dr;
  // integer (rank #1 = strongest). Not displayed anywhere yet.
  ahrefs_rank?: number | null;
  // Dofollow referring domains (added 2026-06-18). Storage-only, mirrors
  // ahrefs_rank; whole-number count captured at import.
  dofollow_refdomains?: number | null;
};

export type BacklogImportResult = {
  inserted: number;
  skipped_duplicates: number;
  skipped_invalid: number;
  // Domains rejected because they appear on the ban list (added wave L,
  // surfaced in import-result UI in wave O). Distinct counter from
  // duplicates so the user can tell "already in backlog" apart from
  // "permanently banned".
  skipped_banned?: number;
  // Per-category counters for the Settings → Domain Filter exclusions
  // (added 2026-06-07). Shape is {category_key: count}; today only
  // `cctld` ships, but the dict shape lets new categories surface
  // automatically — the UI iterates whatever keys are present.
  skipped_filtered?: Record<string, number>;
  errors: { row_index: number; message: string }[];
};

// Domain Filter (Settings → Domain Filter, added 2026-06-07). Schema is
// a dict of category -> entries so new categories (spam-keywords,
// banned-substrings, …) can ship by extending the backend's recognised
// category list — the UI renders one section per `categories` entry
// returned by the server.
export type DomainFilterConfig = {
  // Stop keywords — a domain whose name CONTAINS any of these (substring,
  // anywhere, case-insensitive) is filtered out at import.
  keywords: string[];
  // When true, a domain whose TLD is NOT in the shared allowed-TLDs Spam
  // Filter is filtered out. The TLD list is edited under SERP Overview
  // settings; this is just the on/off gate.
  tld_whitelist_enabled: boolean;
};

export type DomainFilterPayload = {
  config: DomainFilterConfig;
  // Size of the shared allowed-TLDs list the whitelist would enforce.
  allowed_tlds_count: number;
};

export type AllowedTldsPayload = {
  tlds: string[];
  count: number;
  // Size of the shipped default list, for the "reset to default" label.
  default_count: number;
};

// Stop words (Settings → Brain, added 2026-08-24). `max_clauses_per_request`
// is Ahrefs's hard per-`where` clause ceiling minus our safety margin —
// crossing it doesn't break anything, but the request builder starts
// splitting into extra (separately billed) chunks, so the UI warns.
export type StopWordsPayload = {
  terms: string[];
  count: number;
  max_clauses_per_request: number;
  // Server-side per-term character cap. Sent so the UI can explain a
  // rejection without hardcoding the number.
  max_term_length?: number;
  // Entries the server REFUSED on this write (over-long / non-string),
  // capped at 20. Always [] on GET. Surfaced because the likeliest
  // mistake — pasting a whole delimited list into a field that doesn't
  // split on that delimiter — otherwise looks like a successful no-op.
  rejected?: string[];
};

// ---- Backlog types ---------------------------------------------------------

export type BacklogStatus =
  | "backlog"
  | "in_progress"
  | "analyzed"
  | "order"
  | "backordered"
  | "bought"
  | "discarded"
  | "question"
  | "banned";

export const BACKLOG_STATUSES: BacklogStatus[] = [
  "backlog",
  "in_progress",
  "analyzed",
  "order",
  "backordered",
  "bought",
  "discarded",
  "question",
  "banned",
];

export type BacklogRow = {
  id: number;
  domain: string;
  status: BacklogStatus;
  registrar: string;
  expiration_date: string | null; // ISO YYYY-MM-DD
  project: string;
  comments: string;
  desired_price: number | null;
  max_price: number | null;
  created_at: string;
  updated_at: string;
  // Per-row link to the per-domain page when the domain has been
  // analyzed (most-recent finished RunDomain). Null when not analyzed.
  analyzed_run_domain_id: number | null;
  analyzed_run_id: number | null;
  analyzed_job_id: number | null;
};

export type BacklogListResponse = {
  rows: BacklogRow[];
  // `total` is 0 + `registrars` is null when the caller passed
  // include_options=false. The frontend caches the previous values in
  // those cases.
  total: number;
  filtered_total: number;
  page: number;
  per_page: number;
  registrars: string[] | null;
  statuses: BacklogStatus[];
};

export type BacklogSortColumn =
  | "expiration_date"
  | "desired_price"
  | "max_price";
export type BacklogSortDirection = "asc" | "desc";

export type BacklogListOpts = {
  page?: number;
  per_page?: number;
  search?: string;
  status?: BacklogStatus[];
  registrar?: string[];
  // ISO YYYY-MM-DD; inclusive on both ends.
  expiry_from?: string;
  expiry_to?: string;
  // Availability filter (added 2026-05-15). CSV of
  // "available"/"registered"/"unknown"/"error" plus the "__none__"
  // sentinel for "domain has never been checked". Empty = no filter.
  availability?: string[];
  // Max-price range filter (added 2026-06-08, mirrors the Database page).
  // USD bounds on BacklogDomain.max_price; 0 = no bound on that side.
  max_price_min?: number;
  max_price_max?: number;
  // Notes filter on the backlog Comments column: "any" | "with" | "without".
  notes?: string;
  sort?: BacklogSortColumn;
  direction?: BacklogSortDirection;
  // Pass false on page navigation to skip the heavy total/registrars
  // queries — the frontend keeps the cached values.
  include_options?: boolean;
};

// ---- Errors page types -----------------------------------------------------

export type ErrorCategory =
  | "ai"
  | "ahrefs"
  | "wayback"
  | "domain"
  | "run"
  | "backend";
export type ErrorSourceKind =
  | "criterion_ai"
  | "criterion_fetch"
  | "run_domain"
  | "run"
  | "log";
export type ErrorStatus = "open" | "dismissed" | "all";

export type ErrorRow = {
  source_kind: ErrorSourceKind;
  source_id: number;
  message_hash: string;
  category: ErrorCategory;
  occurred_at: string | null;
  message: string;
  preview: string;
  context: Record<string, unknown>;
  job_id: number | null;
  run_id: number | null;
  run_domain_id: number | null;
  criterion: string | null;
  dismissed_at: string | null;
};

export type ErrorListResponse = {
  errors: ErrorRow[];
  // Counts include "total", "open", "dismissed" plus per-category keys.
  counts: Record<string, number>;
};
