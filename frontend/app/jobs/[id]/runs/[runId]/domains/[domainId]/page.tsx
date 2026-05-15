"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, AIProvider, RunCost, RunDomainDetail } from "@/lib/api";
import { StatusPill } from "@/components/status-pill";
import { CriterionTable } from "@/components/criterion-table";
import { VerdictBox } from "@/components/verdict-box";
import { ReanalyzeBar } from "@/components/reanalyze-bar";
import { NotesEditor } from "@/components/notes-editor";
import { ShareButton } from "@/components/share-button";
import { AiPreviewPanel } from "@/components/ai-preview-panel";
import {
  WaybackSamplesTimeline,
  WaybackSample,
} from "@/components/wayback-samples-timeline";
import {
  bannerToneWithConfidence,
  bucketAccentTone,
  bucketBannerTone,
  FinalBucket,
  formatScore,
  isLowConfidence,
  labelToBucket,
  parseFinalScore,
  scoreToBucket,
} from "@/lib/score";

// Format $ amount: 4 decimal places under $1, 2 above. Mirrors the run-
// level CostPill formatter so micro-spend (one domain × tiny verdict ≈
// fractions of a cent) doesn't all render as "$0.00".
function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return "$0";
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function DomainCostPill({ cost }: { cost: RunCost }) {
  const tooltip = [
    `Input tokens: ${cost.total_input_tokens.toLocaleString()}`,
    `Output tokens: ${cost.total_output_tokens.toLocaleString()}`,
    `Fresh AI calls: ${cost.fresh_calls}`,
    cost.cache_hits > 0 ? `Cache hits: ${cost.cache_hits} (cost $0)` : null,
    cost.missing_pricing.length > 0
      ? `Missing pricing for ${cost.missing_pricing.length} model(s) — total is incomplete:\n  ` +
        cost.missing_pricing
          .map((m) => `${m.provider} / ${m.model}`)
          .join("\n  ")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const tone =
    cost.missing_pricing.length > 0
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
      : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200";
  return (
    <span
      className={`px-2 py-0.5 rounded-md font-medium ${tone}`}
      title={tooltip}
    >
      <span className="opacity-70 mr-1">Cost</span>
      {formatUsd(cost.total_cost_usd)}
      {cost.missing_pricing.length > 0 && (
        <span className="ml-1 opacity-70">⚠</span>
      )}
    </span>
  );
}

const TABS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  "wayback",
  // wayback_classify (added 2026-05-09): no fetched rows — the tab body
  // renders the classify verdict directly (language + theme + category +
  // drift history) instead of a raw-data table.
  "wayback_classify",
] as const;
type Tab = (typeof TABS)[number];

export default function DomainDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string; domainId: string }>;
}) {
  const { id, runId: runIdStr, domainId: domainIdStr } = use(params);
  const jobId = parseInt(id, 10);
  const runId = parseInt(runIdStr, 10);
  const domainId = parseInt(domainIdStr, 10);

  const { t } = useT();
  const ts = t.pages.jobs.domain;

  const [data, setData] = useState<RunDomainDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("backlinks");
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  // Once true, keep polling at a faster cadence until reanalyzing flips back
  // to false — at which point we know fresh verdicts have landed.
  const [polling, setPolling] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  async function load() {
    try {
      const d = await api.getRunDomain(domainId);
      setData(d);
      setError(null);
      // First load: pick the initial tab.
      setTab((cur) => {
        const firstWithRows = TABS.find((c) => {
          const detail = d.criteria[c];
          return detail && detail.rows && detail.rows.length > 0;
        });
        const firstPresent = TABS.find((c) => d.criteria[c]);
        return cur === "backlinks" && !d.criteria.backlinks
          ? (firstWithRows ?? firstPresent ?? cur)
          : cur;
      });
      // If reanalysis just finished, drop polling cadence.
      if (polling && !d.reanalyzing) {
        setPolling(false);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainId]);

  // Faster polling while a reanalyze is in flight so the verdict refresh
  // shows up quickly.
  useEffect(() => {
    if (!polling) return;
    const id = window.setInterval(load, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  async function handleReanalyze(provider: AIProvider, model: string) {
    setReanalyzeBusy(true);
    setReanalyzeError(null);
    try {
      await api.reanalyzeRunDomain(domainId, { provider, model });
      setPolling(true);
      load();
    } catch (e) {
      setReanalyzeError((e as Error).message || "reanalyze failed");
    } finally {
      setReanalyzeBusy(false);
    }
  }

  async function handlePinToggle() {
    if (!data) return;
    setPinBusy(true);
    setPinError(null);
    try {
      if (data.is_pinned) {
        await api.unpinRunDomain(domainId);
      } else {
        await api.pinRunDomain(domainId);
      }
      load();
    } catch (e) {
      setPinError((e as Error).message || "pin failed");
    } finally {
      setPinBusy(false);
    }
  }

  async function handleReanalyzeCriterion(criterion: Tab) {
    if (!data) return;
    setReanalyzeError(null);
    try {
      await api.reanalyzeRunDomainCriterion(domainId, criterion, {
        provider: data.spec_ai_provider || undefined,
        model: data.spec_ai_model || undefined,
      });
      setPolling(true);
      load();
    } catch (e) {
      setReanalyzeError((e as Error).message || "reanalyze failed");
    }
  }

  if (error) {
    return (
      <div className="space-y-3">
        <Link
          href={`/jobs/${jobId}/runs/${runId}`}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          {ts.backToRun(runId)}
        </Link>
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (data === null) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }

  const detail = data.criteria[tab];

  return (
    <div className="space-y-10">
      <Link
        href={`/jobs/${jobId}/runs/${runId}`}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.backToRun(runId)}
      </Link>

      <header className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold font-mono">
              {ts.title(data.domain)}
            </h1>
            <StatusPill status={data.status} />
            {data.reanalyzing && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400 animate-pulse" />
                {ts.reanalyzing}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <ShareButton runDomainId={domainId} domain={data.domain} />
            <button
              type="button"
              onClick={handlePinToggle}
              disabled={pinBusy}
              title={
                data.is_pinned
                  ? ts.pinnedHint
                  : ts.pinHint
              }
              className={
                "text-xs px-2 py-1 rounded-md border disabled:opacity-50 " +
                (data.is_pinned
                  ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                  : "dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800")
              }
            >
              {pinBusy
                ? data.is_pinned
                  ? ts.unpinning
                  : ts.pinning
                : data.is_pinned
                  ? ts.pinned
                  : ts.pin}
            </button>
            <ReanalyzeBar
              defaultProvider={(data.spec_ai_provider || "") as AIProvider | ""}
              defaultModel={data.spec_ai_model || ""}
              busy={reanalyzeBusy}
              inflight={data.reanalyzing}
              onSubmit={handleReanalyze}
            />
          </div>
        </div>
        {pinError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {ts.pinFailed}: {pinError}
          </p>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.intro}
        </p>
        {(() => {
          // Headline AI provenance for the domain. Pull from the final
          // assessment (most accurate — this is what last actually ran on
          // this domain). Fall back to spec.ai (the run's original choice)
          // when the final hasn't been produced yet.
          const fa = data.final_assessment;
          const provider = fa?.provider || data.spec_ai_provider || "";
          const model = fa?.model || data.spec_ai_model || "";
          const lastTs = data.last_analyzed_at;
          const cost = data.cost;
          const showCost =
            cost && (cost.fresh_calls > 0 || cost.cache_hits > 0);
          if (!provider && !model && !lastTs && !showCost) return null;
          return (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {(provider || model) && (
                <span className="px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
                  <span className="opacity-60 mr-1">AI</span>
                  <span className="font-mono">
                    {provider || "?"}
                    {model ? ` · ${model}` : ""}
                  </span>
                </span>
              )}
              {lastTs && (
                <span className="px-2 py-0.5 rounded-md font-medium bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                  <span className="opacity-70 mr-1">Last analyzed</span>
                  {new Date(lastTs).toLocaleString()}
                </span>
              )}
              {showCost && cost && <DomainCostPill cost={cost} />}
            </div>
          );
        })()}
        {(data.augments_run_id != null ||
          Object.values(data.criteria).some(
            (cd) => cd.source_run_id != null,
          )) && (
          <div className="text-xs rounded-md border-l-4 border-l-violet-500 dark:border-l-violet-400/70 border px-3 py-2 bg-violet-50 text-violet-900 border-violet-200 dark:bg-[#1a1030] dark:text-violet-100 dark:border-violet-900/60 space-y-1">
            <div className="font-medium">
              {data.augments_run_id != null ? (
                data.augments_job_id != null &&
                data.augments_run_domain_id != null ? (
                  <Link
                    href={`/jobs/${data.augments_job_id}/runs/${data.augments_run_id}/domains/${data.augments_run_domain_id}`}
                    className="hover:underline"
                  >
                    {ts.augmentsBannerHeading(data.augments_run_id)}
                  </Link>
                ) : (
                  ts.augmentsBannerHeading(data.augments_run_id)
                )
              ) : (
                ts.stitchedBannerHeading
              )}
            </div>
            <div className="opacity-80">
              {data.augments_run_id != null
                ? ts.augmentsBannerBody
                : ts.stitchedBannerBody}
            </div>
          </div>
        )}
        {data.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {data.error}
          </p>
        )}
        {reanalyzeError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {ts.reanalyzeFailed}: {reanalyzeError}
          </p>
        )}
      </header>

      {data.final_assessment ? (
        <FinalBanner
          final={data.final_assessment}
          sourceRunId={data.final_source_run_id ?? null}
          sourceJobId={data.final_source_job_id ?? null}
          sourceRunDomainId={data.final_source_run_domain_id ?? null}
        />
      ) : (
        // No final yet. While this rd is still being processed, surface
        // an explicit "Final pending…" placeholder so the user knows the
        // headline is *coming* — instead of just missing-banner ambiguity.
        // (Once the rd is done/failed and there's still no final, render
        // nothing — the verdict boxes below or the partial stub speak
        // for themselves.)
        (data.status === "pending" || data.status === "running") && (
          <div className="rounded-md border border-dashed dark:border-neutral-700 px-4 py-3 text-sm text-neutral-500 dark:text-neutral-400">
            {ts.finalBanner.pending}
          </div>
        )
      )}

      {/* Section 2 — All AI verdicts stacked, no tabs. Only render boxes
          for criteria that actually produced a verdict (or errored). The
          horizontal divider + heading separate this from the Final
          assessment above so the page reads as discrete chapters. */}
      {(() => {
        // Include criteria whose FETCH failed too (cd.error) — the box
        // surfaces the error and the Re-judge button (which now refetches)
        // is the user's recovery path.
        const verdictRows = TABS.filter((c) => {
          const cd = data.criteria[c];
          return (
            cd && (cd.ai_verdict || cd.ai_verdict_error || cd.error)
          );
        });
        if (verdictRows.length === 0) return null;
        return (
          <section className="pt-4 border-t dark:border-neutral-800 space-y-4">
            <h2 className="text-lg font-semibold">{ts.verdictsHeading}</h2>
            {/* 2×2 on lg+, single column on narrower viewports so each box
                stays readable. items-start prevents grid auto-stretching
                shorter boxes to match the tallest. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              {verdictRows.map((c) => {
                const cd = data.criteria[c]!;
                const stitchedFrom = cd.source_run_id ?? null;
                const stitchHref =
                  cd.source_job_id != null &&
                  cd.source_run_id != null &&
                  cd.source_run_domain_id != null
                    ? `/jobs/${cd.source_job_id}/runs/${cd.source_run_id}/domains/${cd.source_run_domain_id}`
                    : null;
                return (
                  <div key={c} className="space-y-2">
                    {stitchedFrom != null && stitchHref != null ? (
                      <Link
                        href={stitchHref}
                        className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100 hover:underline"
                        title={ts.stitchedFromHint}
                      >
                        <span>↳</span>
                        <span>{ts.stitchedFromLabel(stitchedFrom)}</span>
                      </Link>
                    ) : null}
                    <VerdictBox
                      verdict={cd.ai_verdict}
                      error={cd.ai_verdict_error || cd.error}
                      cachedFromRunId={cd.ai_cached_from_run_id}
                      aiProvider={cd.ai_provider}
                      aiModel={cd.ai_model}
                      criterionLabel={ts.tabs[c]}
                      onReanalyze={() => handleReanalyzeCriterion(c)}
                      reanalyzing={data.reanalyzing}
                    />
                    {stitchedFrom == null ? (
                      <AiPreviewPanel runDomainId={data.id} criterion={c} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* Section 3 — Raw data (tab-controlled). Tabs filter only the
          table; verdicts above stay all-visible. */}
      <section className="pt-4 border-t dark:border-neutral-800 space-y-4">
        <h2 className="text-lg font-semibold">{ts.rawDataHeading}</h2>
        <div className="border-b dark:border-neutral-800 -mb-px">
          <nav className="flex flex-wrap gap-1">
            {TABS.filter((c) => data.criteria[c]).map((c) => {
              const has = data.criteria[c];
              const rowCount = has?.rows?.length ?? 0;
              const tone =
                tab === c
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200";
              // wayback_classify has no rows (verdict-only criterion) —
              // suppress the "0" row-count badge so it doesn't read as
              // "this tab has no content". The classify panel renders
              // language/theme/category structurally, not rows.
              const showRowCount = c !== "wayback_classify";
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setTab(c)}
                  className={`px-3 py-2 text-sm border-b-2 transition-colors ${tone}`}
                >
                  {ts.tabs[c]}
                  {showRowCount && (
                    <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">
                      {rowCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {tab === "wayback" ? (
          <WaybackTabContent detail={detail} />
        ) : tab === "wayback_classify" ? (
          <WaybackClassifyTabContent detail={detail} />
        ) : (
          <CriterionTable criterion={tab} detail={detail} />
        )}
      </section>

      {/* Section 4 — Notes. Bottom of page; collapses to view-mode when
          a note is saved (see NotesEditor). */}
      <section className="pt-4 border-t dark:border-neutral-800">
        <NotesEditor
          domain={data.domain}
          initialNote={data.note}
          initialUpdatedAt={data.note_updated_at}
          onSaved={(note, updatedAt) => {
            // Mirror the saved state into the loaded payload so a subsequent
            // poll or reload doesn't flicker the note back to the old value.
            setData((prev) =>
              prev ? { ...prev, note, note_updated_at: updatedAt } : prev,
            );
          }}
        />
      </section>
    </div>
  );
}

function WaybackTabContent({
  detail,
}: {
  detail: import("@/lib/api").CriterionDetail | undefined;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.waybackTab;
  // Default-collapsed: V2 timeline (when present) is the more useful view
  // for theme-drift triage; the CDX rows table is reference data behind it.
  // User can expand on demand.
  const [cdxOpen, setCdxOpen] = useState(false);
  const samples = (() => {
    const raw = detail?.raw as { samples?: WaybackSample[] } | null;
    const s = raw?.samples;
    return Array.isArray(s) && s.length > 0 ? s : null;
  })();
  const cdxRowCount = detail?.rows?.length ?? 0;
  return (
    <div className="space-y-6">
      {samples ? (
        <WaybackSamplesTimeline
          samples={samples}
          cachedFromRunId={detail?.cached_from_run_id ?? null}
        />
      ) : null}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setCdxOpen((v) => !v)}
          className="text-sm font-medium inline-flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400"
        >
          <span>{cdxOpen ? "▾" : "▸"}</span>
          <span>{ts.cdxToggle(cdxRowCount)}</span>
        </button>
        {cdxOpen ? (
          <CriterionTable criterion="wayback" detail={detail} />
        ) : null}
      </div>
    </div>
  );
}

// wayback_classify tab body — renders the classify verdict structurally:
// language section (primary + secondaries + confidence), theme section
// (primary + secondaries + confidence), category section (chained
// classification + drift's category_was when present), and the drift
// history table when drift_detected.
function WaybackClassifyTabContent({
  detail,
}: {
  detail: import("@/lib/api").CriterionDetail | undefined;
}) {
  if (!detail) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        wayback_classify hasn't run for this domain yet.
      </p>
    );
  }
  const verdict = (detail.ai_verdict || {}) as Record<string, unknown>;
  const has = (k: string) =>
    verdict[k] !== undefined && verdict[k] !== null && verdict[k] !== "";
  const conf = (k: string): string => {
    const v = verdict[k];
    return typeof v === "number" ? `${Math.round(v * 100)}%` : "—";
  };
  const arr = (k: string): string[] => {
    const v = verdict[k];
    return Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === "string") as string[] : [];
  };
  const drift = !!verdict["drift_detected"];
  const history = (verdict["history"] as Array<Record<string, unknown>>) || [];
  return (
    <div className="space-y-6">
      <section className="rounded-md border dark:border-neutral-800 p-4 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
          Language
        </h3>
        {has("primary_language") ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-mono font-semibold">
              {String(verdict["primary_language"])}
            </span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {has("language_confidence") ? `${conf("language_confidence")} confidence` : ""}
            </span>
            {has("language_source") && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                source: {String(verdict["language_source"])}
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No language detected.</p>
        )}
        {arr("secondary_languages").length > 0 && (
          <p className="text-sm">
            <span className="text-neutral-500 dark:text-neutral-400">Also detected:</span>{" "}
            {arr("secondary_languages").join(", ")}
          </p>
        )}
      </section>

      <section className="rounded-md border dark:border-neutral-800 p-4 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
          Theme {drift && <span className="ml-2 text-amber-600 dark:text-amber-400 normal-case font-normal">⚠ drift detected</span>}
        </h3>
        {has("primary_theme") ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-lg font-medium">{String(verdict["primary_theme"])}</span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {has("theme_confidence") ? `${conf("theme_confidence")} confidence` : ""}
            </span>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No theme detected.</p>
        )}
        {arr("secondary_themes").length > 0 && (
          <p className="text-sm">
            <span className="text-neutral-500 dark:text-neutral-400">Also present:</span>{" "}
            {arr("secondary_themes").join(", ")}
          </p>
        )}
      </section>

      <section className="rounded-md border dark:border-neutral-800 p-4 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
          Category
        </h3>
        {has("category") ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={`text-base font-medium px-2 py-0.5 rounded-full ${
                String(verdict["category"]) === "other"
                  ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                  : "bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100"
              }`}
            >
              {String(verdict["category"])}
            </span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {has("category_confidence") ? `${conf("category_confidence")} confidence` : ""}
            </span>
            {has("category_was") && (
              <span className="text-sm text-neutral-500 dark:text-neutral-400">
                · was: <span className="font-medium">{String(verdict["category_was"])}</span>
              </span>
            )}
          </div>
        ) : verdict["category_skipped_reason"] ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Category skipped: {String(verdict["category_skipped_reason"])}
          </p>
        ) : verdict["category_error"] ? (
          <p className="text-sm text-red-700 dark:text-red-300">
            Category step failed: {String(verdict["category_error"])}
          </p>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Not categorized yet.</p>
        )}
        {has("category_reasoning") && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400 italic">
            “{String(verdict["category_reasoning"])}”
          </p>
        )}
      </section>

      {drift && history.length > 0 && (
        <section className="rounded-md border dark:border-neutral-800 p-4 space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
            Drift history
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 dark:text-neutral-400">
                <tr>
                  <th className="px-2 py-1 font-normal">Years</th>
                  <th className="px-2 py-1 font-normal">Language</th>
                  <th className="px-2 py-1 font-normal">Theme</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="border-t dark:border-neutral-800">
                    <td className="px-2 py-1 font-mono text-xs">
                      {String(h["from_year"] ?? "?")}–{String(h["to_year"] ?? "?")}
                    </td>
                    <td className="px-2 py-1 font-mono text-xs">
                      {h["language"] ? String(h["language"]) : "—"}
                    </td>
                    <td className="px-2 py-1">{h["theme"] ? String(h["theme"]) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function FinalBanner({
  final,
  sourceRunId,
  sourceJobId,
  sourceRunDomainId,
}: {
  final: {
    final?: unknown;
    confidence?: number;
    provider?: string;
    model?: string;
    summary: string;
    recommendation: string;
    partial?: boolean;
    succeeded?: string[];
    failed?: string[];
  };
  // Non-null when the displayed final was sourced from a PRIOR rd
  // because this rd's own final was missing/partial/no-score AND this
  // rd's run is already terminal (the in-flight guard now lives in the
  // backend — see jobs.py:get_run_domain_detail). Drives the "showing
  // prior run" provenance badge below so the user never mistakes a
  // stale headline for a fresh one.
  sourceRunId?: number | null;
  sourceJobId?: number | null;
  sourceRunDomainId?: number | null;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.finalBanner;
  const fromPriorHref =
    sourceRunId != null && sourceJobId != null && sourceRunDomainId != null
      ? `/jobs/${sourceJobId}/runs/${sourceRunId}/domains/${sourceRunDomainId}`
      : null;

  // Partial result — runner deliberately skipped both compute_final and
  // the synth call to avoid silently misleading the user. Render a clearly
  // distinct "partial" banner and prompt to Reanalyze.
  if (final.partial) {
    const succeeded = final.succeeded ?? [];
    const failed = final.failed ?? [];
    const total = succeeded.length + failed.length;
    return (
      <div className="rounded-md border p-4 space-y-2 bg-neutral-50 text-neutral-900 border-neutral-300 border-l-4 border-l-neutral-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-neutral-500">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold inline-flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
            {ts.partialHeading}
          </span>
          <span className="text-sm px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100 font-medium">
            {ts.partialCount(succeeded.length, total)}
          </span>
        </div>
        {succeeded.length > 0 && (
          <p className="text-[15px] leading-relaxed">
            <span className="opacity-70 mr-1">{ts.partialSucceeded}:</span>
            {succeeded.join(", ")}
          </p>
        )}
        {failed.length > 0 && (
          <p className="text-[15px] leading-relaxed">
            <span className="opacity-70 mr-1">{ts.partialFailed}:</span>
            {failed.join(", ")}
          </p>
        )}
        <p className="text-xs opacity-70">{ts.partialHint}</p>
        {sourceRunId != null && (
          <p className="text-xs text-neutral-700 dark:text-neutral-300 pt-1 border-t border-current/10">
            {fromPriorHref ? (
              <Link href={fromPriorHref} className="underline hover:text-blue-600 dark:hover:text-blue-400">
                {ts.fromPriorRun(sourceRunId)}
              </Link>
            ) : (
              <span>{ts.fromPriorRun(sourceRunId)}</span>
            )}
            {" — "}
            {ts.fromPriorRunHint}
          </p>
        )}
      </div>
    );
  }

  // The runner now computes `final` deterministically (see backend
  // scoring.py); legacy runs may still carry a "quality"/"mixed" string.
  const score = parseFinalScore(final.final);
  const bucket: FinalBucket | null =
    score != null ? scoreToBucket(score) : labelToBucket(final.final);
  const tone = bucket
    ? bannerToneWithConfidence(bucket, final.confidence)
    : "bg-neutral-50 text-neutral-900 border-neutral-200 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700";
  // Bucket-keyed accent for heading + dot. Greyed-out when confidence is
  // low so the visual matches the bannerToneWithConfidence rule.
  const accent =
    bucket && !isLowConfidence(final.confidence)
      ? bucketAccentTone(bucket)
      : "text-neutral-600 dark:text-neutral-400";
  const dotTone =
    bucket && !isLowConfidence(final.confidence)
      ? bucket === "good"
        ? "bg-emerald-500 dark:bg-emerald-400"
        : bucket === "mixed"
          ? "bg-amber-500 dark:bg-amber-400"
          : "bg-red-500 dark:bg-red-400"
      : "bg-neutral-400 dark:bg-neutral-500";
  const display =
    score != null
      ? formatScore(score)
      : typeof final.final === "string"
        ? final.final
        : String(final.final ?? "");
  const lowConf = isLowConfidence(final.confidence);
  return (
    <div className={`rounded-md border p-4 space-y-2 ${tone}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`font-semibold inline-flex items-center gap-2 ${accent}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dotTone}`} />
          {ts.heading}:
        </span>
        <span className="text-sm px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100 font-medium">
          {display}
        </span>
        {score != null && bucket && (
          <span className={`text-xs font-medium ${accent}`}>{bucket}</span>
        )}
        {final.confidence != null && (
          <span
            className="text-xs text-neutral-700 dark:text-neutral-300"
            title={
              lowConf
                ? "Low AI confidence — score is greyed out as a warning"
                : undefined
            }
          >
            {Math.round(final.confidence * 100)}% confidence
            {lowConf && " · low"}
          </span>
        )}
        {(final.provider || final.model) && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200"
            title={`Final assessment produced by ${final.provider || "?"}${final.model ? " / " + final.model : ""}`}
          >
            {final.provider}
            {final.model ? ` · ${final.model}` : ""}
          </span>
        )}
      </div>
      {final.summary && (
        <p className="text-[15px] leading-relaxed">
          <span className="opacity-70 mr-1">{ts.summary}:</span>
          {final.summary}
        </p>
      )}
      {final.recommendation && (
        <p className="text-[15px] leading-relaxed">
          <span className="opacity-70 mr-1">{ts.recommendation}:</span>
          {final.recommendation}
        </p>
      )}
      {sourceRunId != null && (
        <p className="text-xs text-neutral-700 dark:text-neutral-300 pt-1 border-t border-current/10">
          {fromPriorHref ? (
            <Link href={fromPriorHref} className="underline hover:text-blue-600 dark:hover:text-blue-400">
              {ts.fromPriorRun(sourceRunId)}
            </Link>
          ) : (
            <span>{ts.fromPriorRun(sourceRunId)}</span>
          )}
          {" — "}
          {ts.fromPriorRunHint}
        </p>
      )}
    </div>
  );
}
