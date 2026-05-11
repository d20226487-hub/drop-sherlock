"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  AIProvider,
  RunCost,
  RunDetail,
  RunDomainProgress,
  RunStatus,
} from "@/lib/api";
import { StatusPill } from "@/components/status-pill";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import {
  PaginationBottomBar,
  PaginationTopBar,
} from "@/components/pagination-bar";
import { ReanalyzeBar } from "@/components/reanalyze-bar";
import { CsvColumn, csvFilename, downloadBlob, toCsv } from "@/lib/csv";
import { isLowConfidence } from "@/lib/score";

// Format $ amount: 4 decimal places under $1, 2 above. Picked so micro-
// runs (a few thousand tokens at $0.075/M ≈ $0.0008) don't render as
// "$0.00", but big runs aren't cluttered with trailing zeros.
function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return "$0";
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function CostPill({ cost }: { cost: RunCost }) {
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
      ? // Warn-tone when totals are incomplete due to missing prices.
        "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const CRITERIA_ORDER = [
  "backlinks", "refdomains", "anchors", "keywords",
  "wayback",
  // wayback_classify is included in the Criteria pill column so the user
  // can scan its fetch/AI status alongside the others.
  "wayback_classify",
] as const;
// (criterion key, single-letter abbreviation for AI Ahrefs mini-pills)
const AHREFS_LETTERS: ReadonlyArray<readonly [string, string]> = [
  ["backlinks", "B"],
  ["refdomains", "D"],
  ["anchors", "A"],
  ["keywords", "K"],
];

// Single-letter abbreviations for the Criteria pills column. Match the
// AHREFS_LETTERS scheme so a B-pill in the AI-verdict column and a B-pill
// in the Criteria column refer to the same criterion. Wayback gets W;
// wayback_classify gets C (Classify) since "W" is taken — tooltip on hover
// still shows the full criterion name so the disambiguation is discoverable.
const CRITERION_ABBREVIATIONS: Record<string, string> = {
  backlinks: "B",
  refdomains: "D",
  anchors: "A",
  keywords: "K",
  wayback: "W",
  wayback_classify: "C",
};

function CriteriaPills({ criteria }: { criteria: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {CRITERIA_ORDER.filter((c) => criteria[c]).map((c) => {
        const status = criteria[c];
        const tone =
          status === "done"
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
            : status === "failed"
              ? "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300"
              : status === "running"
                ? "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300";
        return (
          <span
            key={c}
            className={`text-xs px-1.5 py-0.5 rounded font-medium tabular-nums ${tone}`}
            title={`${c}: ${status}`}
          >
            {CRITERION_ABBREVIATIONS[c] ?? c.slice(0, 1).toUpperCase()}
          </span>
        );
      })}
    </div>
  );
}

// Color tone for an AI verdict status: "done" | "failed" | "pending" | undefined
function aiVerdictTone(status: string | undefined): string {
  if (status === "done")
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "failed")
    return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  if (status === "pending")
    return "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300";
  // Criterion not in ai_status (disabled in spec, or no CR row yet).
  return "bg-neutral-100 text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-500";
}

function AiVerdictPill({
  status,
  title,
}: {
  status: string | undefined;
  title?: string;
}) {
  const label = status ?? "—";
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded ${aiVerdictTone(status)}`}
      title={title ? `${title}: ${label}` : label}
    >
      {label}
    </span>
  );
}

function AhrefsAiPills({ aiStatus }: { aiStatus: Record<string, string> }) {
  // Suppress entirely when no Ahrefs criterion has a verdict (typical for
  // wayback-only runs) — keeps the column from looking like four broken
  // pills. The spec disabled them; a single em-dash is honest and quiet.
  const anyPresent = AHREFS_LETTERS.some(([k]) => aiStatus[k]);
  if (!anyPresent) {
    return <span className="text-neutral-400 dark:text-neutral-500">—</span>;
  }
  return (
    <div className="flex gap-1">
      {AHREFS_LETTERS.map(([key, letter]) => {
        const status = aiStatus[key];
        return (
          <span
            key={key}
            className={`text-xs px-1 py-0.5 rounded font-mono w-5 text-center ${aiVerdictTone(status)}`}
            title={`${key}: ${status ?? "disabled"}`}
          >
            {letter}
          </span>
        );
      })}
    </div>
  );
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId: runIdStr } = use(params);
  const jobId = parseInt(id, 10);
  const runId = parseInt(runIdStr, 10);
  const { t } = useT();
  const ts = t.pages.jobs.run;

  const [run, setRun] = useState<RunDetail | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [cost, setCost] = useState<RunCost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  // Pause/Resume/Cancel state for non-terminal runs. Distinct from
  // reanalyze state so a busy reanalyze doesn't disable lifecycle buttons.
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [pinAllBusy, setPinAllBusy] = useState(false);
  const [pinAllError, setPinAllError] = useState<string | null>(null);
  const [pinAllResult, setPinAllResult] = useState<{
    pinned: number;
    replaced: number;
  } | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Snapshot of the dispatched retry: counts at submit time + the
  // failed-count we measured BEFORE the dispatch. Cleared once the batch
  // settles (no RD reports `reanalyzing` anymore) and we've emitted a
  // success/partial/all-still-failed message.
  const [pendingRetry, setPendingRetry] = useState<{
    criteria: number;
    domains: number;
    failedBefore: number;
    sawInFlight: boolean;
  } | null>(null);
  // Final outcome banner: set when the batch settles. Distinct from
  // `retryError` (which is dispatch-time failure, e.g. backend 400).
  const [retryOutcome, setRetryOutcome] = useState<{
    tone: "success" | "partial" | "fail";
    text: string;
  } | null>(null);

  async function reload() {
    try {
      const [d, s, c] = await Promise.all([
        api.getRun(runId),
        api.getRunStatus(runId).catch(() => null),
        api.getRunCost(runId).catch(() => null),
      ]);
      setRun(d);
      if (s) setStatus(s);
      if (c) setCost(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleReanalyze(provider: AIProvider, model: string) {
    setReanalyzeBusy(true);
    setReanalyzeError(null);
    try {
      await api.reanalyzeRun(runId, { provider, model });
      // The polling effect will pick up reanalyzing=true on next tick.
      reload();
    } catch (e) {
      setReanalyzeError((e as Error).message || "reanalyze failed");
    } finally {
      setReanalyzeBusy(false);
    }
  }

  async function handlePause() {
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await api.pauseRun(runId);
      reload();
    } catch (e) {
      setLifecycleError((e as Error).message || "pause failed");
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleResume() {
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await api.resumeRun(runId);
      reload();
    } catch (e) {
      setLifecycleError((e as Error).message || "resume failed");
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm(ts.cancelConfirm)) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await api.cancelRun(runId);
      reload();
    } catch (e) {
      setLifecycleError((e as Error).message || "cancel failed");
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handlePinAll() {
    if (!run) return;
    const total = run.domains.length;
    if (total === 0) return;
    // We don't know the replaced count up-front; show a generic confirm.
    if (!window.confirm(ts.pinAllConfirm(total, 0))) return;
    setPinAllBusy(true);
    setPinAllError(null);
    setPinAllResult(null);
    try {
      const r = await api.pinEntireRun(runId);
      setPinAllResult({ pinned: r.pinned, replaced: r.replaced });
      reload();
    } catch (e) {
      setPinAllError((e as Error).message || "pin failed");
    } finally {
      setPinAllBusy(false);
    }
  }

  // Pull spec.ai out of the run's stored spec_json so reanalyze + retry
  // pickers can default to it. Defined here (not below) so the
  // handlers that reference it don't sit in front of their dependency
  // declaration.
  const specAi = useMemo<{ provider: AIProvider | ""; model: string }>(() => {
    if (!run?.spec_json) return { provider: "", model: "" };
    try {
      const j = JSON.parse(run.spec_json);
      const p = j?.ai?.provider as AIProvider | null | undefined;
      const m = j?.ai?.model as string | null | undefined;
      return { provider: p ?? "", model: m ?? "" };
    } catch {
      return { provider: "", model: "" };
    }
  }, [run?.spec_json]);

  // Counts strict fetch + AI failures from data already on the page.
  // Missing-CR-row cases (rare; only when a run aborted before a criterion
  // started) aren't reflected here, but the backend will pick them up when
  // the action runs. So this is a lower bound — accurate enough for the
  // button label.
  const failedCount = useMemo(() => {
    if (!run) return { criteria: 0, domains: 0 };
    const ALL = [
      "backlinks", "refdomains", "anchors", "keywords",
      "wayback", "wayback_classify",
    ];
    let criteria = 0;
    let domains = 0;
    for (const d of run.domains) {
      let perDomain = 0;
      for (const c of ALL) {
        if (d.criteria?.[c] === "failed") perDomain += 1;
        if (d.ai_status?.[c] === "failed") perDomain += 1;
      }
      if (perDomain > 0) {
        criteria += perDomain;
        domains += 1;
      }
    }
    return { criteria, domains };
  }, [run]);

  // Per-RD retry/reanalyze progress. Drives the in-flight "Retrying X of Y"
  // label and disables the button until the batch drains. Includes the
  // run-level reanalyze case via the same `reanalyzing` flag the backend
  // OR's together.
  const reanalyzingCount = useMemo(() => {
    if (!run) return 0;
    return run.domains.filter((d) => d.reanalyzing).length;
  }, [run]);
  const anyReanalyzing = reanalyzingCount > 0;

  // Watch the batch settle. Two-phase: (1) wait until we've actually seen
  // some RD report `reanalyzing` (in case dispatch is faster than the
  // first poll), (2) when it then drops to zero, compute the outcome
  // from the *current* failedCount vs the snapshot we took at dispatch.
  useEffect(() => {
    if (!pendingRetry) return;
    if (anyReanalyzing && !pendingRetry.sawInFlight) {
      setPendingRetry({ ...pendingRetry, sawInFlight: true });
      return;
    }
    if (pendingRetry.sawInFlight && !anyReanalyzing) {
      const before = pendingRetry.failedBefore;
      const after = failedCount.criteria;
      const recovered = Math.max(before - after, 0);
      let outcome: { tone: "success" | "partial" | "fail"; text: string };
      if (after === 0) {
        outcome = {
          tone: "success",
          text: ts.retryOutcomeAllRecovered(before),
        };
      } else if (recovered > 0) {
        outcome = {
          tone: "partial",
          text: ts.retryOutcomePartial(recovered, after),
        };
      } else {
        outcome = {
          tone: "fail",
          text: ts.retryOutcomeAllStillFailed(after),
        };
      }
      setRetryOutcome(outcome);
      setPendingRetry(null);
    }
  }, [
    anyReanalyzing,
    pendingRetry,
    failedCount.criteria,
    ts,
  ]);

  async function handleRetryFailed() {
    if (!run) return;
    if (failedCount.criteria === 0) {
      setRetryError(ts.retryFailedNone);
      return;
    }
    if (
      !window.confirm(
        ts.retryFailedConfirm(failedCount.criteria, failedCount.domains),
      )
    )
      return;
    setRetryBusy(true);
    setRetryError(null);
    setRetryOutcome(null);
    // Snapshot before dispatch — the outcome banner compares this against
    // the post-batch failed count to compute recovered/still-failing.
    const failedBefore = failedCount.criteria;
    try {
      const r = await api.retryFailedRun(runId, {
        provider: specAi.provider || undefined,
        model: specAi.model || undefined,
      });
      setPendingRetry({
        criteria: r.criteria ?? failedBefore,
        domains: r.domains ?? failedCount.domains,
        failedBefore,
        sawInFlight: false,
      });
      reload();
    } catch (e) {
      setRetryError((e as Error).message || "retry failed");
    } finally {
      setRetryBusy(false);
    }
  }

  async function handleRename() {
    if (!run) return;
    const next = window.prompt(ts.renamePrompt(run.id), run.name ?? "");
    if (next === null) return;
    try {
      await api.patchRun(run.id, { name: next });
      await reload();
    } catch (e) {
      setLifecycleError((e as Error).message || "rename failed");
    }
  }

  useEffect(() => {
    reload();
    const id = window.setInterval(() => {
      reload();
    }, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (error) {
    return (
      <div className="space-y-3">
        <Link
          href={`/jobs/${jobId}`}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← Back
        </Link>
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (run === null) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/jobs/${jobId}`}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.backToJob(run.job_name || `Job #${jobId}`)}
      </Link>

      <header className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{ts.title(run.id, run.name)}</h1>
            <StatusPill status={run.status} />
            {status?.reanalyzing && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400 animate-pulse" />
                {ts.reanalyzing}
              </span>
            )}
            <button
              type="button"
              onClick={handleRename}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {ts.rename}
            </button>
          </div>
          {(run.status === "done" ||
            run.status === "failed" ||
            run.status === "canceled") && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <button
                type="button"
                onClick={handleRetryFailed}
                disabled={
                  retryBusy ||
                  anyReanalyzing ||
                  pendingRetry !== null ||
                  failedCount.criteria === 0
                }
                title={ts.retryFailedHint}
                className="text-xs px-2 py-1 rounded-md border border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
              >
                {retryBusy
                  ? ts.retryFailedRunning
                  : pendingRetry && anyReanalyzing
                    ? ts.retryFailedProgress(
                        reanalyzingCount,
                        pendingRetry.domains,
                      )
                    : ts.retryFailed(failedCount.criteria)}
              </button>
              <button
                type="button"
                onClick={handlePinAll}
                disabled={pinAllBusy || run.domains.length === 0}
                title={ts.pinAllHint}
                className="text-xs px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              >
                {pinAllBusy ? ts.pinAllRunning : ts.pinAll}
              </button>
              <ReanalyzeBar
                defaultProvider={specAi.provider}
                defaultModel={specAi.model}
                busy={reanalyzeBusy}
                inflight={!!status?.reanalyzing}
                onSubmit={handleReanalyze}
              />
            </div>
          )}
          {(run.status === "running" || run.status === "pending") && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePause}
                disabled={lifecycleBusy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {ts.pause}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={lifecycleBusy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
              >
                {ts.cancel}
              </button>
            </div>
          )}
          {run.status === "paused" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleResume}
                disabled={lifecycleBusy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-blue-600 dark:text-blue-400 disabled:opacity-50"
              >
                {ts.resume}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={lifecycleBusy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
              >
                {ts.cancel}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {run.started_at && (
            <span className="px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
              <span className="opacity-60 mr-1">Started</span>
              {formatDate(run.started_at)}
            </span>
          )}
          {run.finished_at && (
            <span className="px-2 py-0.5 rounded-md bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
              <span className="opacity-60 mr-1">Finished</span>
              {formatDate(run.finished_at)}
            </span>
          )}
          {(() => {
            // "Last analyzed" = max(last_analyzed_at across all domains).
            // Distinct from finished_at — survives reanalyze.
            const lastTs = run.domains
              .map((d) => d.last_analyzed_at)
              .filter((s): s is string => !!s)
              .sort()
              .pop();
            return lastTs ? (
              <span className="px-2 py-0.5 rounded-md font-medium bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                <span className="opacity-70 mr-1">Last analyzed</span>
                {formatDate(lastTs)}
              </span>
            ) : null;
          })()}
          {cost && (cost.fresh_calls > 0 || cost.cache_hits > 0) && (
            <CostPill cost={cost} />
          )}
        </div>
        {run.error && (
          <p className="text-sm text-red-600 dark:text-red-400">{run.error}</p>
        )}
        {reanalyzeError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {ts.reanalyzeFailed}: {reanalyzeError}
          </p>
        )}
        {lifecycleError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {lifecycleError}
          </p>
        )}
        {pinAllError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {ts.pinAllFailed}: {pinAllError}
          </p>
        )}
        {pinAllResult && (
          <p className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            {ts.pinAllResult(pinAllResult.pinned, pinAllResult.replaced)}
          </p>
        )}
        {retryError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {ts.retryFailedFailed}: {retryError}
          </p>
        )}
        {pendingRetry && (
          <p className="text-sm rounded-md px-3 py-2 bg-violet-50 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100">
            {anyReanalyzing
              ? ts.retryFailedProgressBanner(
                  reanalyzingCount,
                  pendingRetry.domains,
                )
              : ts.retryFailedDispatched(
                  pendingRetry.criteria,
                  pendingRetry.domains,
                )}
          </p>
        )}
        {retryOutcome && (
          <p
            className={`text-sm rounded-md px-3 py-2 flex items-center justify-between gap-3 ${
              retryOutcome.tone === "success"
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : retryOutcome.tone === "partial"
                  ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
            }`}
          >
            <span>
              {retryOutcome.text}
              {retryOutcome.tone !== "success" && (
                <>
                  {" · "}
                  <Link
                    href="/errors?status=open"
                    className="underline decoration-dotted hover:no-underline"
                  >
                    {ts.retryOutcomeViewErrors}
                  </Link>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setRetryOutcome(null)}
              className="text-xs px-2 py-0.5 rounded-md border dark:border-neutral-700 hover:bg-white/60 dark:hover:bg-neutral-800"
              aria-label="Dismiss"
            >
              ×
            </button>
          </p>
        )}
      </header>

      <DomainsSection
        domains={run.domains}
        jobId={jobId}
        runId={runId}
      />
    </div>
  );
}

function DomainsSection({
  domains,
  jobId,
  runId,
}: {
  domains: RunDomainProgress[];
  jobId: number;
  runId: number;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.run;
  const matchDomain = useCallback(
    (d: RunDomainProgress, q: string) => d.domain.toLowerCase().includes(q),
    [],
  );
  const search = usePaginatedSearch<RunDomainProgress>(domains, matchDomain);

  const csvColumns = useMemo<CsvColumn<RunDomainProgress>[]>(
    () => [
      { header: "domain", get: (d) => d.domain },
      { header: "status", get: (d) => d.status },
      { header: "partial", get: (d) => (d.final_partial ? "true" : "") },
      { header: "score", get: (d) => d.final_score ?? "" },
      { header: "bucket", get: (d) => d.final_bucket },
      { header: "confidence", get: (d) => d.final_confidence ?? "" },
      { header: "ai_provider", get: (d) => d.ai_provider },
      { header: "ai_model", get: (d) => d.ai_model },
      { header: "backlinks", get: (d) => d.criteria.backlinks ?? "" },
      { header: "refdomains", get: (d) => d.criteria.refdomains ?? "" },
      { header: "anchors", get: (d) => d.criteria.anchors ?? "" },
      { header: "keywords", get: (d) => d.criteria.keywords ?? "" },
      // wayback_classify columns mirror the Database CSV export shape.
      { header: "primary_language", get: (d) => d.primary_language || "" },
      {
        header: "secondary_languages",
        get: (d) => (d.secondary_languages || []).join("|"),
      },
      {
        header: "language_confidence",
        get: (d) => d.language_confidence ?? "",
      },
      { header: "primary_theme", get: (d) => d.primary_theme || "" },
      {
        header: "secondary_themes",
        get: (d) => (d.secondary_themes || []).join("|"),
      },
      { header: "theme_confidence", get: (d) => d.theme_confidence ?? "" },
      {
        header: "classify_drift_detected",
        get: (d) => (d.classify_drift_detected ? "true" : ""),
      },
      { header: "category", get: (d) => d.category || "" },
      { header: "category_confidence", get: (d) => d.category_confidence ?? "" },
      { header: "category_was", get: (d) => d.category_was || "" },
      { header: "finished_at", get: (d) => d.finished_at || "" },
      { header: "last_analyzed_at", get: (d) => d.last_analyzed_at || "" },
      { header: "error", get: (d) => d.error || "" },
    ],
    [],
  );

  function exportCsv(scope: "visible" | "all") {
    const rows = scope === "visible" ? search.filteredAll : domains;
    const csv = toCsv(rows, csvColumns);
    downloadBlob(csv, csvFilename(`drop-sherlock-run-${runId}-${scope}`));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-semibold">{ts.domainsHeading}</h2>
        {domains.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => exportCsv("visible")}
              disabled={search.filteredTotal === 0}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              title={ts.exportVisibleHelp}
            >
              {ts.exportVisible(search.filteredTotal)}
            </button>
            <button
              type="button"
              onClick={() => exportCsv("all")}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              title={ts.exportAllHelp}
            >
              {ts.exportAll(domains.length)}
            </button>
          </div>
        )}
      </div>
      {domains.length === 0 && (
        <p className="text-sm text-neutral-500">{ts.empty}</p>
      )}
      {domains.length > 0 && (
        <>
          <PaginationTopBar
            state={search}
            searchPlaceholder="Search by domain…"
          />
          <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">{ts.cols.domain}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.status}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.criteria}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.aiWayback}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.aiAhrefs}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.language}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.theme}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.category}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.finished}</th>
                  <th className="px-3 py-2 w-1" />
                </tr>
              </thead>
              <tbody>
                {search.paged.map((d) => {
                  const href = `/jobs/${jobId}/runs/${runId}/domains/${d.id}`;
                  return (
                    <tr
                      key={d.id}
                      className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                    >
                      <td className="px-3 py-2">
                        <Link
                          href={href}
                          className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {d.domain}
                        </Link>
                        {d.is_pinned && (
                          <span
                            className="ml-1.5 text-amber-600 dark:text-amber-400"
                            title={ts.pinAllHint}
                          >
                            ★
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusPill status={d.status} />
                          {d.reanalyzing && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100 inline-flex items-center gap-1"
                              title={ts.reanalyzing}
                            >
                              <span className="w-1 h-1 rounded-full bg-violet-500 dark:bg-violet-400 animate-pulse" />
                              {ts.reanalyzing}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <CriteriaPills criteria={d.criteria} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {d.ai_status?.wayback ? (
                            <AiVerdictPill
                              status={d.ai_status.wayback}
                              title="wayback"
                            />
                          ) : (
                            <span className="text-neutral-400 dark:text-neutral-500">
                              —
                            </span>
                          )}
                          {/* wayback_classify is rendered as a cls pill
                              right after the wayback pill, since both
                              run on Wayback content. */}
                          {d.ai_status?.wayback_classify && (
                            <span
                              className={`text-xs px-1 py-0.5 rounded font-mono ${
                                d.ai_status.wayback_classify === "done"
                                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                                  : d.ai_status.wayback_classify === "failed"
                                    ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                                    : "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                              }`}
                              title={`wayback_classify: ${d.ai_status.wayback_classify}`}
                            >
                              cls
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <AhrefsAiPills aiStatus={d.ai_status ?? {}} />
                      </td>
                      {/* wayback_classify columns (added 2026-05-09) —
                          same confidence-aware tone as the Database row:
                          high confidence → blue pill / full text color,
                          low → grey pill / muted italic. */}
                      <td className="px-3 py-2">
                        {d.primary_language ? (
                          (() => {
                            const lowConf =
                              d.language_confidence != null &&
                              isLowConfidence(d.language_confidence);
                            return (
                              <span
                                className={
                                  "text-xs font-mono px-1.5 py-0.5 rounded " +
                                  (lowConf
                                    ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                                    : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200")
                                }
                                title={(() => {
                                  const sec =
                                    (d.secondary_languages?.length ?? 0) > 0
                                      ? ` · also: ${(d.secondary_languages || []).join(", ")}`
                                      : "";
                                  const conf =
                                    d.language_confidence != null
                                      ? ` · ${Math.round(d.language_confidence * 100)}% confidence${lowConf ? " (low — greyed)" : ""}`
                                      : "";
                                  return `${d.primary_language}${sec}${conf}`;
                                })()}
                              >
                                {d.primary_language}
                                {(d.secondary_languages?.length ?? 0) > 0 && (
                                  <span className="ml-0.5 opacity-60">
                                    +{d.secondary_languages!.length}
                                  </span>
                                )}
                              </span>
                            );
                          })()
                        ) : (
                          <span className="text-xs text-neutral-400 dark:text-neutral-500">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-[14rem]">
                        {d.primary_theme ? (
                          (() => {
                            const lowConf =
                              d.theme_confidence != null &&
                              isLowConfidence(d.theme_confidence);
                            return (
                              <div
                                className={
                                  "text-xs " +
                                  (lowConf
                                    ? "text-neutral-500 dark:text-neutral-400 italic"
                                    : "text-neutral-900 dark:text-neutral-100")
                                }
                                title={(() => {
                                  const sec =
                                    (d.secondary_themes?.length ?? 0) > 0
                                      ? `\nAlso: ${(d.secondary_themes || []).join(", ")}`
                                      : "";
                                  const conf =
                                    d.theme_confidence != null
                                      ? `\n${Math.round(d.theme_confidence * 100)}% confidence${lowConf ? " (low — muted)" : ""}`
                                      : "";
                                  return `${d.primary_theme}${sec}${conf}`;
                                })()}
                              >
                                <span className="break-words">
                                  {d.primary_theme}
                                </span>
                                {d.classify_drift_detected && (
                                  <span
                                    className="ml-1 text-amber-600 dark:text-amber-400 not-italic"
                                    title="Theme drift detected — site changed topics over time"
                                  >
                                    ⚠
                                  </span>
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          <span className="text-xs text-neutral-400 dark:text-neutral-500">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {d.category ? (
                          <span
                            className={
                              "text-xs px-2 py-0.5 rounded-full " +
                              (d.category === "other"
                                ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                                : "bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100")
                            }
                            title={(() => {
                              const conf =
                                d.category_confidence != null
                                  ? ` · ${Math.round(d.category_confidence * 100)}%`
                                  : "";
                              const was = d.category_was
                                ? ` · was: ${d.category_was}`
                                : "";
                              return `${d.category}${conf}${was}`;
                            })()}
                          >
                            {d.category}
                            {d.category_was && (
                              <span className="ml-1 opacity-70">
                                ← {d.category_was}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400 dark:text-neutral-500">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300 whitespace-nowrap">
                        {formatDate(d.finished_at)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={href}
                          className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 inline-block"
                        >
                          {ts.viewDomain}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {search.filteredTotal === 0 && (
            <p className="text-sm text-neutral-500">
              {t.pagination.none}
            </p>
          )}
          <PaginationBottomBar state={search} />
        </>
      )}
    </section>
  );
}
