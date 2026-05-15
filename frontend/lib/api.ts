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
  | "error";

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
  availability__cascade_order: string;
  availability__dns__rps: string;
  availability__dns__max_concurrent: string;
  availability__rdap__rps: string;
  availability__rdap__max_concurrent: string;
  availability__domainr__rps: string;
  availability__domainr__max_concurrent: string;
  availability__whois__rps: string;
  availability__whois__max_concurrent: string;
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
  configured: ProviderStatus;
} & (
  | { state: "ok"; elapsed_ms: number; details: Record<string, unknown> }
  | { state: "unconfigured"; error: string }
  | { state: "error"; error: string }
);

export type DashboardStatus = {
  checked_at: string;
  integrations: IntegrationStatus[];
};

// ---- Analyze flow -----------------------------------------------------------

export type Criterion =
  | "backlinks"
  | "refdomains"
  | "anchors"
  | "keywords"
  | "wayback"
  // wayback_classify is a derived AI-only criterion — no fetch URL, no
  // raw rows. Result lives in the CR's ai_verdict_json with shape
  // {primary_language, primary_theme, drift_detected, history?, category,
  // category_confidence, category_was?, ...}.
  | "wayback_classify";

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
  };
};

export type AIProvider = "gemini" | "github_models" | "openrouter";

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
};

export type RunProgress = {
  run_id: number;
  status: "pending" | "running" | "done" | "failed" | "canceled" | "paused";
  started_at: string | null;
  finished_at: string | null;
  error: string;
  counts: {
    total: number;
    done: number;
    failed: number;
    running: number;
    pending: number;
  };
  domains: RunDomainProgressSlim[];
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
export type JobKind = "quality" | "availability" | "whois_history";

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
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  spec_json: string;
  domains: RunDomainProgress[];
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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  // Ban-list flag (added 2026-05-13 wave L). True when the domain is
  // on the ban list. The row stays visible per design call (i) — the
  // UI renders a small "banned" badge in the domain cell.
  is_banned?: boolean;
};

export type BanRow = {
  domain: string;
  note: string;
  created_at: string;
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
    // wayback_classify universes (added 2026-05-09). languages = ISO 639-1
    // codes seen on pinned rds; categories = the user-defined category
    // names actually assigned by the AI.
    languages: string[];
    categories: string[];
  };
  // Total domain count across the full set (regardless of pagination).
  // Equal to rows.length when no offset/limit was passed.
  total: number;
};

export type RunDomainProgressLite = {
  is_pinned?: boolean;
};

export const api = {
  getSettings: () => request<SettingsPayload>("/settings/"),

  listDatabaseDomains: () =>
    request<DatabaseDomainList>("/database/domains"),

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

  getDashboardStatus: () => request<DashboardStatus>("/dashboard/status"),

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
  getRunProgress: (runId: number) =>
    request<RunProgress>(`/runs/${runId}/progress`),

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

  getRun: (runId: number) => request<RunDetail>(`/runs/${runId}`),

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
    if (opts.registrar && opts.registrar.length)
      params.set("registrar", opts.registrar.join(","));
    if (opts.expiry_from) params.set("expiry_from", opts.expiry_from);
    if (opts.expiry_to) params.set("expiry_to", opts.expiry_to);
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
  }) =>
    request<{ deleted: number }>(`/backlog/bulk-delete-filtered`, {
      method: "POST",
      body: JSON.stringify({
        search: filters.search || "",
        status_filter: filters.status?.length
          ? filters.status.join(",")
          : null,
        registrar: filters.registrar?.length
          ? filters.registrar.join(",")
          : null,
        expiry_from: filters.expiry_from || null,
        expiry_to: filters.expiry_to || null,
      }),
    }),

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
        registrar: payload.registrar?.length
          ? payload.registrar.join(",")
          : null,
        expiry_from: payload.expiry_from || null,
        expiry_to: payload.expiry_to || null,
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
        registrar: filters.registrar?.length
          ? filters.registrar.join(",")
          : null,
        expiry_from: filters.expiry_from || null,
        expiry_to: filters.expiry_to || null,
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
  comments?: string;
  desired_price?: number | null;
  max_price?: number | null;
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
  errors: { row_index: number; message: string }[];
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
  | "banned";

export const BACKLOG_STATUSES: BacklogStatus[] = [
  "backlog",
  "in_progress",
  "analyzed",
  "order",
  "backordered",
  "bought",
  "discarded",
  "banned",
];

export type BacklogRow = {
  id: number;
  domain: string;
  status: BacklogStatus;
  registrar: string;
  expiration_date: string | null; // ISO YYYY-MM-DD
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
