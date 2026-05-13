"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";
import {
  api,
  AISpec,
  AnalyzeSpec,
  CriteriaSpec,
  PreviewResponse,
} from "@/lib/api";
import { DomainInput } from "@/components/domain-input";
import {
  AnchorsCard,
  BacklinksCard,
  KeywordsCard,
  RefdomainsCard,
  WaybackCard,
  WaybackClassifyCard,
} from "@/components/criterion-card";
import { PreviewPanel } from "@/components/preview-panel";
import { AISelector } from "@/components/ai-selector";

const DEFAULT_CRITERIA: CriteriaSpec = {
  backlinks: {
    enabled: true,
    // Default 20 (lower than the 100 used by other Ahrefs criteria) — see
    // BacklinksConfig in schemas.py for rationale.
    limit: 20,
    filters: {
      dofollow: true,
      nofollow: false,
      non_spammy: true,
      noindex_exclude: true,
      content_only: true,
      languages: [],
      domain_contains: [],
      dr_min: null,
      dr_max: null,
      ur_min: null,
      ur_max: null,
      traffic_min: null,
      traffic_max: null,
      positions_min: null,
      positions_max: null,
    },
    sort: [{ field: "domain_rating_source", direction: "desc" }],
    aggregation: "1_per_domain",
  },
  refdomains: {
    enabled: true,
    limit: 20,
    filters: {
      dofollow: true,
      nofollow: false,
      non_spammy: true,
      domain_contains: [],
      dr_min: null,
      dr_max: null,
    },
    sort: [],
  },
  anchors: {
    enabled: true,
    limit: 20,
    filters: { dofollow: true, nofollow: false },
    sort: [],
  },
  keywords: {
    enabled: true,
    limit: 20,
    sort: [],
  },
  // Wayback: opt-in. Hits the free CDX API — see WaybackCard for filter
  // semantics. Defaults updated 2026-05-07 after a 35-domain batch
  // cascade-failed: `match_type: "host"` (was "domain") is much faster
  // on CDX's slow free backend with the same triage signal in 95% of
  // cases; `limit: 100` (was 200) prevents oversized queries that the
  // backend chokes on. Power users can flip to "domain" for deep
  // subdomain history when they're triaging a single domain.
  // V2 page-content sampling defaults to OFF (slow — adds 1–3s per pick);
  // strategy "even" + path "mixed" + count 6 are sane starting values.
  wayback: {
    enabled: false,
    limit: 100,
    filters: {
      from_year: null,
      to_year: null,
      match_type: "host",
      collapse: "timestamp:6",
    },
    sort: [],
    sample_pages: false,
    sample_count: 6,
    sample_strategy: "even",
    sample_path_mode: "mixed",
  },
  // wayback_classify (added 2026-05-09): combined language + theme + auto-
  // chained category. Opt-in. When enabled, submit auto-flips wayback +
  // sample_pages so the runner has the V2 samples it needs.
  wayback_classify: {
    enabled: false,
    language_mode: "ai",
  },
};

function parseDomains(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Submit state was a 5-variant machine that powered an inline summary
// table + polling loop on this page (pre-2026-05-07). After moving the
// "watch a run" surface entirely to the Run page (`/jobs/{id}/runs/{run}`)
// — which now also has Pause/Resume/Cancel — submitting redirects there
// immediately. The state collapses to: idle, submitting, error. The
// `submitting` window is just the time between Submit click and router
// push; long enough to disable the button, short enough to be invisible.
type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

// useSearchParams() needs a Suspense boundary at build time (Next 15
// requirement — otherwise prerender bails out). We wrap the whole inner
// component since basically all of it depends on the (?rerun=) param.
export default function AnalyzePage() {
  return (
    <Suspense fallback={null}>
      <AnalyzePageInner />
    </Suspense>
  );
}

function AnalyzePageInner() {
  const { t, lang } = useT();
  const ts = t.pages.analyze;
  const router = useRouter();
  const searchParams = useSearchParams();
  const rerunJobId = (() => {
    const v = searchParams.get("rerun");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  })();
  // Database → Analyze entry point (added 2026-05-09): the Database
  // page sends the user here with `?domains=a.com,b.com,...&cross_cache=1`
  // when they hit "Analyze selected". We pre-fill the domain textarea
  // and tick the cross-job cache box so that on submit, prior CR rows
  // from any matching job get reused.
  const fromDatabaseDomains = searchParams.get("domains");
  const fromDatabaseCrossCache = searchParams.get("cross_cache") === "1";
  // Source job for pre-filling criteria + AI from the run that produced
  // the selected rows' wayback verdicts (added 2026-05-13). Database
  // page passes this so the form's params_hash matches the cached data
  // — without it, default form values would produce a different
  // params_hash and every domain would miss the cross-job cache.
  const sourceJobIdParam = (() => {
    const v = searchParams.get("source_job_id");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  })();
  // Backlog → Analyze entry point: triggered by the Backlog page's "Send
  // to Analyze" button. The domain list is too big for a URL at
  // thousands-of-rows scale, so we hand it off via sessionStorage and
  // pull the last-used spec from the most-recent Job. The flag in the
  // URL is just the trigger.
  const fromBacklog = searchParams.get("from_backlog") === "1";

  const [domainsRaw, setDomainsRaw] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState<CriteriaSpec>(DEFAULT_CRITERIA);
  const [ai, setAi] = useState<AISpec>({ provider: null, model: null });
  // Cache toggle is only meaningful in rerun mode (no prior runs exist for
  // a brand-new job). Default on; the rerun banner exposes the checkbox.
  const [useCache, setUseCache] = useState(true);
  // Cross-job cache toggle. Off by default for normal /analyze submits;
  // ticked automatically when arriving from the Database page so the user
  // gets the reuse-everywhere semantics they asked for. Visible whenever
  // the Database-entry banner is showing.
  const [crossJobCache, setCrossJobCache] = useState(false);
  const [fromDatabase, setFromDatabase] = useState(false);
  // When the Database hand-off includes source_job_id, we fetch that
  // job's spec and pre-fill criteria + AI from it. This banner state
  // drives the green note that surfaces the auto-fill so the user
  // knows they're aligned with the cache. Cleared when the user opens
  // a fresh /analyze without the source param.
  const [prefillSource, setPrefillSource] = useState<
    { jobId: number; jobName: string } | null
  >(null);
  // Availability cascade toggle (added 2026-05-12). When ON, the runner
  // calls RDAP/DNS/etc. before Ahrefs/Wayback. Off by default — opt in
  // per-submit via the box at the top of the page.
  const [checkAvailability, setCheckAvailability] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [rerunJobName, setRerunJobName] = useState<string | null>(null);

  // When ?rerun=<id> is present, load the job's last spec into the form.
  // Once. Subsequent edits by the user are theirs to keep.
  useEffect(() => {
    if (rerunJobId === null) {
      setRerunJobName(null);
      return;
    }
    let cancelled = false;
    api
      .getJobSpec(rerunJobId)
      .then((r) => {
        if (cancelled) return;
        setDomainsRaw(r.spec.domains.join("\n"));
        setCriteria(r.spec.criteria);
        if (r.spec.ai) setAi(r.spec.ai);
        setName(r.name || "");
        setNotes(r.notes || "");
        setRerunJobName(r.name || `Job #${r.job_id}`);
      })
      .catch(() => {
        // Treat a failed prefill as "rerun not available" — strip the param.
        setRerunJobName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rerunJobId]);

  function clearRerun() {
    router.replace("/analyze");
  }

  // Prefill from Database "Analyze selected" — runs once per param-change.
  // Strips the query params after consumption so a refresh doesn't re-set
  // the textarea on top of any user edits.
  useEffect(() => {
    if (fromDatabaseDomains === null) return;
    const list = fromDatabaseDomains
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    setDomainsRaw(list.join("\n"));
    setCrossJobCache(fromDatabaseCrossCache);
    setFromDatabase(true);
    // Strip ONLY `domains=` (the bulky payload) — preserve every other
    // URL param so the source_job_id pre-fill effect still has its
    // input to act on. Building this URL as
    // `/analyze?cross_cache=1` (the pre-2026-05-13 version) would
    // accidentally strip `source_job_id=N` and cancel the in-flight
    // pre-fill fetch (since sourceJobIdParam transitioning to null
    // triggers the effect's cleanup → cancelled=true).
    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete("domains");
    const qs = remaining.toString();
    router.replace(qs ? `/analyze?${qs}` : "/analyze");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDatabaseDomains, fromDatabaseCrossCache]);

  function clearFromDatabase() {
    setFromDatabase(false);
    setCrossJobCache(false);
    setPrefillSource(null);
    router.replace("/analyze");
  }

  // Pre-fill criteria + AI from the source job (Database → Analyze
  // hand-off, added 2026-05-13). Runs after the Database prefill effect
  // has consumed the domain list. Pulls the source job's spec — same
  // mechanism as `?rerun=N` — but only copies `criteria` + `ai` so the
  // user's domain selection (which came from the URL above) isn't
  // overwritten. Strips `source_job_id` from the URL on success so a
  // back-button refresh doesn't re-overwrite user edits.
  useEffect(() => {
    if (sourceJobIdParam === null) return;
    let cancelled = false;
    api
      .getJobSpec(sourceJobIdParam)
      .then((r) => {
        if (cancelled) return;
        setCriteria(r.spec.criteria);
        if (r.spec.ai) setAi(r.spec.ai);
        setPrefillSource({
          jobId: sourceJobIdParam,
          jobName: r.name || `#${sourceJobIdParam}`,
        });
        // Strip ONLY `source_job_id` — preserve any other params
        // (cross_cache=1, future additions) so we don't fight the
        // Database prefill effect or future entry-point hand-offs.
        const remaining = new URLSearchParams(searchParams.toString());
        remaining.delete("source_job_id");
        const qs = remaining.toString();
        router.replace(qs ? `/analyze?${qs}` : "/analyze");
      })
      .catch(() => {
        // Source job missing or fetch failed — leave defaults, no banner.
        if (!cancelled) setPrefillSource(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceJobIdParam]);

  // Prefill from Backlog "Send to Analyze". Reads the domain list from
  // sessionStorage (set by the Backlog page right before the redirect),
  // then pulls the most-recent job's spec to seed criteria + AI. Both
  // are one-shot — strip the URL flag and clear sessionStorage so a
  // refresh doesn't re-trigger.
  useEffect(() => {
    if (!fromBacklog) return;
    let domains: string[] = [];
    try {
      const raw = sessionStorage.getItem(BACKLOG_HANDOFF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.domains)) domains = parsed.domains;
      }
    } catch {
      // Ignore malformed sessionStorage; the user just sees an empty
      // textarea and can paste manually.
    }
    sessionStorage.removeItem(BACKLOG_HANDOFF_KEY);
    if (domains.length > 0) {
      setDomainsRaw(domains.join("\n"));
    }
    // Pull last-used spec — best-effort. If no jobs exist yet, the
    // hard-coded DEFAULT_CRITERIA stay in place.
    api
      .getLastSpec()
      .then((r) => {
        if (!r.spec) return;
        setCriteria(r.spec.criteria);
        if (r.spec.ai) setAi(r.spec.ai);
      })
      .catch(() => {
        // Silent fail — defaults are fine.
      });
    router.replace("/analyze");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromBacklog]);

  const spec: AnalyzeSpec = useMemo(
    () => ({
      domains: parseDomains(domainsRaw),
      criteria,
      ai,
      // Only send the toggle on reruns; new jobs have nothing to cache from.
      ...(rerunJobId !== null ? { use_cache: useCache } : {}),
      // Cross-job cache: only send when explicitly enabled (Database-flow
      // entry or manual tick). Backend defaults to false either way; we
      // only send when ON to keep the wire payload obvious in DevTools.
      ...(crossJobCache ? { cross_job_cache: true } : {}),
      // Availability cascade — only send when ON so the wire payload
      // stays obvious in DevTools.
      ...(checkAvailability ? { check_availability: true } : {}),
      // Carry the current UI language so the backend appends a Russian-
      // output directive to the AI system prompts on RU runs.
      lang,
    }),
    [
      domainsRaw,
      criteria,
      ai,
      rerunJobId,
      useCache,
      crossJobCache,
      checkAvailability,
      lang,
    ],
  );

  // --- Live preview (debounced) -------------------------------------------
  const specKey = JSON.stringify(spec);
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      let cancelled = false;
      setPreviewLoading(true);
      api
        .previewAnalyze(spec)
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setPreviewError(null);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) setPreviewError(e.message || "preview failed");
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, 300);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  const domainCount = spec.domains.length;
  const enabledCount = (Object.keys(criteria) as (keyof CriteriaSpec)[]).filter(
    (k) => criteria[k].enabled,
  ).length;

  function validate(): string | null {
    if (domainCount === 0) return ts.submit.validation.noDomains;
    if (enabledCount === 0) return ts.submit.validation.noCriteria;
    return null;
  }

  // --- Submit + polling ----------------------------------------------------
  async function handleSubmit() {
    const err = validate();
    if (err) {
      setSubmit({ kind: "error", message: err });
      return;
    }
    setSubmit({ kind: "submitting" });
    try {
      const r =
        rerunJobId !== null
          ? await api.rerunJob(rerunJobId, spec)
          : await api.submitJob(
              spec,
              name.trim() || undefined,
              notes.trim() || undefined,
            );
      // Redirect to the Run page — that's the canonical surface for
      // watching a run now (Pause/Resume/Cancel + per-domain progress
      // table + reanalyze all live there). The Analyze page used to
      // render an inline Summary table here; replaced 2026-05-07 because
      // it duplicated the Run page with fewer controls.
      router.push(`/jobs/${r.job_id}/runs/${r.run_id}`);
    } catch (e) {
      const errObj = e as Error;
      setSubmit({ kind: "error", message: errObj.message || "submit failed" });
    }
  }

  const validationError = validate();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {ts.intro}
        </p>
      </div>

      {/* Domain-availability cascade toggle — first box on the page so
          it's the first thing the user reads. Opt-in per submit; the
          actual provider config + skip policy live in Settings → Domain
          availability. */}
      <section className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4 space-y-2 bg-neutral-50/50 dark:bg-neutral-900/30">
        <header>
          <h2 className="text-base font-semibold">
            {t.pages.availability.analyzeBoxTitle}
          </h2>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">
            {t.pages.availability.analyzeBoxHint}
          </p>
        </header>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checkAvailability}
            onChange={(e) => setCheckAvailability(e.target.checked)}
            className="rounded border-neutral-300 dark:border-neutral-700"
          />
          <span>{t.pages.availability.analyzeBoxToggle}</span>
        </label>
      </section>

      {fromDatabase && (
        <div className="rounded-md border border-violet-300 dark:border-violet-700/50 bg-violet-50 dark:bg-[#1a1030] p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-semibold text-violet-900 dark:text-violet-100">
                {ts.fromDatabaseBanner.title(parseDomains(domainsRaw).length)}
              </h3>
              <p className="text-xs text-violet-800 dark:text-violet-200/80 mt-0.5">
                {ts.fromDatabaseBanner.help}
              </p>
            </div>
            <button
              type="button"
              onClick={clearFromDatabase}
              className="text-xs text-violet-700 dark:text-violet-200 hover:underline whitespace-nowrap"
            >
              {ts.fromDatabaseBanner.clear}
            </button>
          </div>
          <label className="flex items-start gap-2 text-xs text-violet-900 dark:text-violet-100 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={crossJobCache}
              onChange={(e) => setCrossJobCache(e.target.checked)}
              className="mt-0.5 rounded border-violet-300 dark:border-violet-700"
            />
            <span>
              <span className="font-medium">
                {ts.fromDatabaseBanner.crossCacheLabel}
              </span>
              <br />
              <span className="text-violet-800/80 dark:text-violet-200/80">
                {ts.fromDatabaseBanner.crossCacheHelp}
              </span>
            </span>
          </label>
          {prefillSource && (
            <p className="text-xs rounded-md px-2 py-1 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200">
              {ts.fromDatabaseBanner.prefilledFromJob(
                prefillSource.jobName,
                prefillSource.jobId,
              )}
            </p>
          )}
        </div>
      )}

      {rerunJobName && (
        <div className="rounded-md border border-blue-300 dark:border-blue-700/50 bg-blue-50 dark:bg-blue-900/20 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-semibold text-blue-900 dark:text-blue-200">
                {ts.rerunBanner.title(rerunJobName)}
              </h3>
              <p className="text-xs text-blue-800 dark:text-blue-300 mt-0.5">
                {ts.rerunBanner.help}
              </p>
            </div>
            <button
              type="button"
              onClick={clearRerun}
              className="text-xs text-blue-700 dark:text-blue-300 hover:underline whitespace-nowrap"
            >
              {ts.rerunBanner.clear}
            </button>
          </div>
          <label className="flex items-start gap-2 text-xs text-blue-900 dark:text-blue-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={useCache}
              onChange={(e) => setUseCache(e.target.checked)}
              className="mt-0.5 rounded border-blue-300 dark:border-blue-700"
            />
            <span>
              <span className="font-medium">
                {ts.rerunBanner.useCacheLabel}
              </span>
              <br />
              <span className="text-blue-800/80 dark:text-blue-300/80">
                {ts.rerunBanner.useCacheHelp}
              </span>
            </span>
          </label>
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {ts.jobName.label}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ts.jobName.placeholder}
            className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {ts.jobNotes.label}
          </label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={ts.jobNotes.placeholder}
            className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>
      </section>

      <DomainInput value={domainsRaw} onChange={setDomainsRaw} />

      <section className="space-y-3">
        <header>
          <h2 className="text-lg font-semibold">{ts.criteria.heading}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {ts.criteria.help}
          </p>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          <BacklinksCard
            cfg={criteria.backlinks}
            onChange={(b) => setCriteria((c) => ({ ...c, backlinks: b }))}
          />
          <RefdomainsCard
            cfg={criteria.refdomains}
            onChange={(r) => setCriteria((c) => ({ ...c, refdomains: r }))}
          />
          <AnchorsCard
            cfg={criteria.anchors}
            onChange={(a) => setCriteria((c) => ({ ...c, anchors: a }))}
          />
          <KeywordsCard
            cfg={criteria.keywords}
            onChange={(k) => setCriteria((c) => ({ ...c, keywords: k }))}
          />
          <WaybackCard
            cfg={criteria.wayback}
            onChange={(w) => setCriteria((c) => ({ ...c, wayback: w }))}
          />
          <WaybackClassifyCard
            cfg={criteria.wayback_classify}
            onChange={(wc) =>
              setCriteria((c) => ({ ...c, wayback_classify: wc }))
            }
            waybackEnabled={criteria.wayback.enabled}
            waybackSamplingEnabled={criteria.wayback.sample_pages}
          />
        </div>
      </section>

      <AISelector value={ai} onChange={setAi} />

      {previewError && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {previewError}
        </div>
      )}

      <PreviewPanel preview={preview} loading={previewLoading} />

      <SubmitSection
        validationError={validationError}
        submit={submit}
        onSubmit={handleSubmit}
        isRerun={rerunJobId !== null}
      />
    </div>
  );
}

function SubmitSection({
  validationError,
  submit,
  onSubmit,
  isRerun,
}: {
  validationError: string | null;
  submit: SubmitState;
  onSubmit: () => void;
  isRerun: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.submit;
  // Post-submit state lives entirely on the Run page now (`router.push` in
  // handleSubmit). This component just handles the pre-submit UX:
  // the button itself, validation hint, and any submit-call error.
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={onSubmit}
        disabled={validationError !== null || submit.kind === "submitting"}
        className="text-sm px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submit.kind === "submitting"
          ? ts.running
          : isRerun
            ? ts.rerunCta
            : ts.run}
      </button>
      {validationError && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {validationError}
        </p>
      )}
      {submit.kind === "error" && (
        <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {submit.message}
        </p>
      )}
    </section>
  );
}
