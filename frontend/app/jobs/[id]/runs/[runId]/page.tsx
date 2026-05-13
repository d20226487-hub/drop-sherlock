"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  AIProvider,
  RecomputeFinalResult,
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

// Ahrefs units pill (added 2026-05-13). Sibling of CostPill — shows the
// total Ahrefs units billed for B/D/A/K calls in this run. Hover reveals
// the breakdown: list price vs billed (Ahrefs server-cache savings),
// fresh vs cached call counts (our local cross-run cache savings).
function AhrefsUnitsPill({ cost }: { cost: RunCost }) {
  const saved = cost.ahrefs_units_list - cost.ahrefs_units_billed;
  const tooltip = [
    `Billed (real Ahrefs spend): ${cost.ahrefs_units_billed.toLocaleString()} units`,
    cost.ahrefs_units_list !== cost.ahrefs_units_billed
      ? `List price: ${cost.ahrefs_units_list.toLocaleString()} units (Ahrefs server-cache saved ${saved.toLocaleString()})`
      : null,
    `Fresh Ahrefs calls: ${cost.ahrefs_fresh_calls}`,
    cost.ahrefs_cached_calls > 0
      ? `Local cache hits: ${cost.ahrefs_cached_calls} (zero Ahrefs cost)`
      : null,
    "Wayback CDX is free and excluded from these totals.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      className="px-2 py-0.5 rounded-md font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200"
      title={tooltip}
    >
      <span className="opacity-70 mr-1">Ahrefs</span>
      {cost.ahrefs_units_billed.toLocaleString()}
      <span className="ml-1 opacity-70">units</span>
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

// Per-run scoring-weights override panel (added 2026-05-13 wave J).
// Recomputes finals against custom weights without touching per-criterion
// AI verdicts. See `tasks.recompute_run_finals` for the backend contract.
const SCORE_WEIGHTS_CRITERIA: ReadonlyArray<readonly [string, string]> = [
  ["backlinks", "B"],
  ["refdomains", "D"],
  ["anchors", "A"],
  ["keywords", "K"],
  ["wayback", "W"],
  ["wayback_classify", "C"],
];

function ScoreWeightsPanel({
  runId,
  currentOverride,
  onApplied,
}: {
  runId: number;
  currentOverride: { weights: Record<string, number> } | null;
  onApplied: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.run;

  // Track weights as strings so the input boxes preserve user-typed
  // values like "0.40" without clobbering them on every render. Parsed
  // to numbers only when submitting / computing sum.
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecomputeFinalResult | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply" | "reset">("");
  const [opError, setOpError] = useState<string | null>(null);
  // Collapsed by default — the panel is a power-user tool. The header
  // stays visible so the override-active badge is always discoverable,
  // and we auto-expand when a custom override is in effect so the user
  // sees the current weights without an extra click on reopen.
  const [open, setOpen] = useState<boolean>(!!currentOverride);

  // Populate initial weights from either the active override or the
  // global Settings defaults. We only run this once on mount and once
  // when `currentOverride` flips (after an apply/reset).
  useEffect(() => {
    let cancelled = false;
    setLoadingDefaults(true);
    setLoadError(null);
    (async () => {
      try {
        let initial: Record<string, number>;
        if (currentOverride) {
          initial = currentOverride.weights;
        } else {
          const env = await api.getScoringConfig();
          initial = (env.config.weights as Record<string, number>) ?? {};
        }
        if (cancelled) return;
        const nextW: Record<string, string> = {};
        const nextE: Record<string, boolean> = {};
        for (const [c] of SCORE_WEIGHTS_CRITERIA) {
          const v = Number(initial[c] ?? 0);
          nextW[c] = Number.isFinite(v) ? v.toFixed(2) : "0.00";
          nextE[c] = v === 0;
        }
        setWeights(nextW);
        setExcluded(nextE);
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof Error ? e.message : ts.scoreWeightsFailedToLoad,
        );
      } finally {
        if (!cancelled) setLoadingDefaults(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOverride, ts.scoreWeightsFailedToLoad]);

  const parsedWeights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [c] of SCORE_WEIGHTS_CRITERIA) {
      if (excluded[c]) {
        out[c] = 0;
        continue;
      }
      const n = Number(weights[c] ?? "0");
      out[c] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    return out;
  }, [weights, excluded]);

  const sum = useMemo(
    () => Object.values(parsedWeights).reduce((a, b) => a + b, 0),
    [parsedWeights],
  );
  const sumOk = Math.abs(sum - 1) < 0.005;

  const handleNormalize = useCallback(() => {
    if (sum <= 0) return;
    const next: Record<string, string> = {};
    for (const [c] of SCORE_WEIGHTS_CRITERIA) {
      const v = parsedWeights[c] / sum;
      next[c] = v.toFixed(2);
    }
    setWeights(next);
  }, [parsedWeights, sum]);

  const handlePreview = useCallback(async () => {
    setBusy("preview");
    setOpError(null);
    try {
      const result = await api.previewRunFinal(runId, parsedWeights);
      setPreview(result);
    } catch (e) {
      setOpError(
        e instanceof Error ? e.message : ts.scoreWeightsFailedPreview,
      );
    } finally {
      setBusy("");
    }
  }, [runId, parsedWeights, ts.scoreWeightsFailedPreview]);

  const handleApply = useCallback(async () => {
    if (!window.confirm(ts.scoreWeightsApplyConfirm)) return;
    setBusy("apply");
    setOpError(null);
    try {
      await api.recomputeRunFinal(runId, parsedWeights);
      setPreview(null);
      onApplied();
    } catch (e) {
      setOpError(
        e instanceof Error ? e.message : ts.scoreWeightsFailedApply,
      );
    } finally {
      setBusy("");
    }
  }, [
    runId,
    parsedWeights,
    onApplied,
    ts.scoreWeightsApplyConfirm,
    ts.scoreWeightsFailedApply,
  ]);

  const handleReset = useCallback(async () => {
    if (!window.confirm(ts.scoreWeightsResetConfirm)) return;
    setBusy("reset");
    setOpError(null);
    try {
      await api.resetRunFinal(runId);
      setPreview(null);
      onApplied();
    } catch (e) {
      setOpError(
        e instanceof Error ? e.message : ts.scoreWeightsFailedApply,
      );
    } finally {
      setBusy("");
    }
  }, [
    runId,
    onApplied,
    ts.scoreWeightsResetConfirm,
    ts.scoreWeightsFailedApply,
  ]);

  const previewChangedCount = useMemo(() => {
    if (!preview) return 0;
    return preview.rows.filter((r) => {
      if (r.partial) return false;
      if (r.score_old === null && r.score_new === null) return false;
      if (r.score_old === null || r.score_new === null) return true;
      return Math.abs(r.score_old - r.score_new) >= 0.05;
    }).length;
  }, [preview]);

  const overrideActive = !!currentOverride;

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 space-y-3 bg-neutral-50/50 dark:bg-neutral-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-2 justify-between text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-md"
      >
        <div className="flex items-start gap-2">
          <span
            className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 select-none"
            aria-hidden
          >
            {open ? "▾" : "▸"}
          </span>
          <div>
            <div className="text-sm font-medium">
              {ts.scoreWeightsHeading}
            </div>
            {open && (
              <div className="text-xs text-neutral-600 dark:text-neutral-400 max-w-2xl">
                {ts.scoreWeightsHint}
              </div>
            )}
          </div>
        </div>
        <span
          className={
            overrideActive
              ? "text-xs px-2 py-0.5 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
              : "text-xs px-2 py-0.5 rounded-md border border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          }
        >
          {overrideActive
            ? ts.scoreWeightsOverrideActive
            : ts.scoreWeightsOverrideGlobal}
        </span>
      </button>

      {open && (loadingDefaults ? (
        <div className="text-xs text-neutral-500">…</div>
      ) : loadError ? (
        <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {SCORE_WEIGHTS_CRITERIA.map(([c, letter]) => {
              const isExcluded = !!excluded[c];
              return (
                <div
                  key={c}
                  className={
                    "flex flex-col gap-1 rounded-md border p-2 " +
                    (isExcluded
                      ? "border-neutral-200 bg-neutral-100 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-500"
                      : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900")
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">
                      <span className="inline-block w-5 text-center rounded bg-neutral-200 dark:bg-neutral-800 mr-1">
                        {letter}
                      </span>
                      {c}
                    </span>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={weights[c] ?? "0.00"}
                    disabled={isExcluded || busy !== ""}
                    onChange={(e) => {
                      setWeights((w) => ({ ...w, [c]: e.target.value }));
                      setPreview(null);
                    }}
                    className="w-full px-2 py-1 text-sm rounded-md border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950 disabled:opacity-50"
                  />
                  <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isExcluded}
                      disabled={busy !== ""}
                      onChange={(e) => {
                        setExcluded((x) => ({
                          ...x,
                          [c]: e.target.checked,
                        }));
                        if (e.target.checked) {
                          setWeights((w) => ({ ...w, [c]: "0.00" }));
                        }
                        setPreview(null);
                      }}
                    />
                    {ts.scoreWeightsExclude}
                  </label>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="text-xs">
              {ts.scoreWeightsSum(sum)}{" "}
              <span
                className={
                  sumOk
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-amber-700 dark:text-amber-300"
                }
              >
                {sumOk ? ts.scoreWeightsSumOk : ts.scoreWeightsSumOff}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleNormalize}
                disabled={busy !== "" || sum <= 0}
                className="text-xs px-2 py-1 rounded-md border border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {ts.scoreWeightsNormalize}
              </button>
              <button
                type="button"
                onClick={handlePreview}
                disabled={busy !== "" || sum <= 0}
                className="text-xs px-2 py-1 rounded-md border border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200 hover:bg-sky-100 dark:hover:bg-sky-900/40 disabled:opacity-50"
              >
                {busy === "preview"
                  ? ts.scoreWeightsBusyPreview
                  : ts.scoreWeightsPreview}
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={busy !== "" || sum <= 0}
                className="text-xs px-2 py-1 rounded-md border border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
              >
                {busy === "apply"
                  ? ts.scoreWeightsBusyApply
                  : ts.scoreWeightsApply}
              </button>
              {overrideActive && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={busy !== ""}
                  className="text-xs px-2 py-1 rounded-md border border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy === "reset"
                    ? ts.scoreWeightsBusyReset
                    : ts.scoreWeightsReset}
                </button>
              )}
            </div>
          </div>

          {opError && (
            <p className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
              {opError}
            </p>
          )}

          {preview && (
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/50">
              <div className="px-3 py-1.5 text-xs border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <span className="font-medium">
                  {ts.scoreWeightsPreviewTitle}
                </span>
                <span className="text-neutral-500">
                  {ts.scoreWeightsPreviewCount(
                    previewChangedCount,
                    preview.rows.length,
                  )}
                </span>
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-neutral-500 sticky top-0 bg-white dark:bg-neutral-900/80">
                    <tr>
                      <th className="px-3 py-1 font-medium">
                        {ts.scoreWeightsColDomain}
                      </th>
                      <th className="px-3 py-1 font-medium">
                        {ts.scoreWeightsColOld}
                      </th>
                      <th className="px-3 py-1 font-medium">
                        {ts.scoreWeightsColNew}
                      </th>
                      <th className="px-3 py-1 font-medium">
                        {ts.scoreWeightsColDelta}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => {
                      const delta =
                        r.score_old != null && r.score_new != null
                          ? r.score_new - r.score_old
                          : null;
                      const deltaCls = !delta
                        ? "text-neutral-400"
                        : delta > 0
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-red-700 dark:text-red-400";
                      return (
                        <tr
                          key={r.run_domain_id}
                          className="border-t border-neutral-100 dark:border-neutral-800/60"
                        >
                          <td className="px-3 py-1">{r.domain}</td>
                          <td className="px-3 py-1 tabular-nums">
                            {r.partial
                              ? ts.scoreWeightsPartial
                              : (r.score_old ?? ts.scoreWeightsPartial)}
                          </td>
                          <td className="px-3 py-1 tabular-nums">
                            {r.partial
                              ? ts.scoreWeightsPartial
                              : (r.score_new ?? ts.scoreWeightsPartial)}
                          </td>
                          <td
                            className={
                              "px-3 py-1 tabular-nums " + deltaCls
                            }
                          >
                            {delta == null
                              ? ""
                              : (delta > 0 ? "+" : "") + delta.toFixed(1)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ))}
    </div>
  );
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
  // Per-criterion pins for this Job (added 2026-05-12). Keyed by
  // criterion → run_id of whoever's currently pinned (across all runs in
  // this job, not just this one). Loaded on mount + after every pin/
  // unpin call.
  const [critPins, setCritPins] = useState<Record<string, number>>({});
  const [critPinBusy, setCritPinBusy] = useState<string | null>(null);
  const [critPinAllResult, setCritPinAllResult] = useState<{
    pinned: number;
    replaced: number;
  } | null>(null);
  const [critPinError, setCritPinError] = useState<string | null>(null);
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

  const reloadCritPins = useCallback(async () => {
    try {
      const r = await api.listJobCriterionPins(jobId);
      const map: Record<string, number> = {};
      for (const p of r.pins) map[p.criterion] = p.run_id;
      setCritPins(map);
    } catch {
      // Non-fatal — the panel just stays empty.
    }
  }, [jobId]);

  useEffect(() => {
    reloadCritPins();
  }, [reloadCritPins]);

  async function handleToggleCritPin(criterion: string) {
    setCritPinBusy(criterion);
    setCritPinError(null);
    setCritPinAllResult(null);
    try {
      if (critPins[criterion] === runId) {
        await api.clearJobCriterionPin(jobId, criterion);
      } else {
        await api.setJobCriterionPin(jobId, criterion, runId);
      }
      await reloadCritPins();
    } catch (e) {
      setCritPinError((e as Error).message || "pin failed");
    } finally {
      setCritPinBusy(null);
    }
  }

  async function handlePinAllCriteria() {
    setCritPinBusy("__all__");
    setCritPinError(null);
    setCritPinAllResult(null);
    try {
      const r = await api.pinRunAllCriteria(runId);
      setCritPinAllResult({
        pinned: r.pinned_criteria.length,
        replaced: r.replaced,
      });
      await reloadCritPins();
    } catch (e) {
      setCritPinError((e as Error).message || "pin failed");
    } finally {
      setCritPinBusy(null);
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

  // Criteria this Run has CR data for — drives the per-criterion pin
  // panel. A criterion appears if any domain in this Run has a CR row
  // whose status=='done' OR has non-empty data (we approximate the
  // backend's check via `d.criteria[c]` reflecting CR.status).
  const criteriaInRun = useMemo<string[]>(() => {
    if (!run) return [];
    const ALL = [
      "backlinks",
      "refdomains",
      "anchors",
      "keywords",
      "wayback",
      "wayback_classify",
    ];
    const out: string[] = [];
    for (const c of ALL) {
      const any = run.domains.some(
        (d) => d.criteria?.[c] === "done" || d.criteria?.[c] === "failed",
      );
      // "done" definitely has data; "failed" *may* have partial data
      // (Ahrefs partial responses) — include both so the user can pin
      // and the backend will filter out criteria with no CR data.
      if (any) out.push(c);
    }
    return out;
  }, [run]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Adaptive polling. The naive 2s interval pegged the API at 75% CPU
  // when ≥2 tabs sat on a run page (regression observed 2026-05-12 with
  // a 352-domain Wayback run): /runs/{id} walks every RunDomain on
  // every call, so polling cost scales with run size × open tabs. Fix:
  //   - Terminal (done / failed / canceled): stop polling entirely.
  //     The displayed data won't change without user action.
  //   - Paused: 10s. Status only flips when the user clicks Resume on
  //     this page, which triggers a manual reload anyway.
  //   - Running / pending: 2s, same as before.
  // Reanalyze in-flight forces 2s even on terminal runs so the live
  // verdicts repaint promptly.
  useEffect(() => {
    if (!run) return;
    const reanalyzing = !!status?.reanalyzing;
    const terminal =
      run.status === "done" ||
      run.status === "failed" ||
      run.status === "canceled";
    if (terminal && !reanalyzing) {
      // Nothing to watch — leave the displayed snapshot alone.
      return;
    }
    const intervalMs =
      run.status === "paused" && !reanalyzing ? 10_000 : 2_000;
    const id = window.setInterval(() => {
      reload();
    }, intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, run?.status, status?.reanalyzing]);

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
          {cost &&
            (cost.ahrefs_fresh_calls > 0 ||
              cost.ahrefs_cached_calls > 0) && (
              <AhrefsUnitsPill cost={cost} />
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
        {run.status === "done" && (
          <ScoreWeightsPanel
            runId={runId}
            currentOverride={run.scoring_override ?? null}
            onApplied={reload}
          />
        )}
        {run.status === "done" && criteriaInRun.length > 0 && (
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 space-y-2 bg-neutral-50/50 dark:bg-neutral-900/30">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div>
                <div className="text-sm font-medium">
                  {ts.pinPerCriterionHeading}
                </div>
                <div className="text-xs text-neutral-600 dark:text-neutral-400 max-w-2xl">
                  {ts.pinPerCriterionHint}
                </div>
              </div>
              <button
                type="button"
                onClick={handlePinAllCriteria}
                disabled={critPinBusy !== null}
                title={ts.pinAllCriteriaHint}
                className="text-xs px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              >
                {ts.pinAllCriteria}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {criteriaInRun.map((c) => {
                const pinnedTo = critPins[c];
                const pinnedHere = pinnedTo === runId;
                const pinnedElsewhere = pinnedTo !== undefined && !pinnedHere;
                const letter = (
                  {
                    backlinks: "B",
                    refdomains: "D",
                    anchors: "A",
                    keywords: "K",
                    wayback: "W",
                    wayback_classify: "C",
                  } as Record<string, string>
                )[c];
                const tone = pinnedHere
                  ? "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
                  : pinnedElsewhere
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                    : "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300";
                const label = pinnedHere
                  ? ts.pinCriterionHere
                  : pinnedElsewhere
                    ? ts.pinCriterionElsewhere(pinnedTo!)
                    : ts.pinCriterionNone;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleToggleCritPin(c)}
                    disabled={critPinBusy !== null}
                    title={`${c}: ${label}`}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border ${tone} hover:opacity-80 disabled:opacity-50`}
                  >
                    <span className="font-mono font-bold">{letter}</span>
                    <span className="opacity-70">·</span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            {critPinError && (
              <p className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
                {critPinError}
              </p>
            )}
            {critPinAllResult && (
              <p className="text-xs rounded-md px-2 py-1 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                {ts.pinAllCriteriaResult(
                  critPinAllResult.pinned,
                  critPinAllResult.replaced,
                )}
              </p>
            )}
          </div>
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
        runStatus={run.status}
        onChanged={reload}
      />
    </div>
  );
}

type RunRowStatus = "pending" | "running" | "done" | "failed" | "canceled";
type StatusFilterValue = "all" | RunRowStatus;
// "any" = no filter; "zero" = wayback ran & returned 0 CDX rows (the
// done-but-empty signal worth pairing with status=done to retry); "nonzero"
// = wayback returned ≥1 row. Rows where wayback didn't run / hasn't reached
// done yet have wayback_rows=null and only match "any" — they're
// deliberately excluded from both "zero" and "nonzero" so a disabled-wayback
// row doesn't get lumped in with structurally empty CDX results.
type WaybackFilterValue = "any" | "zero" | "nonzero";

function DomainsSection({
  domains,
  jobId,
  runId,
  runStatus,
  onChanged,
}: {
  domains: RunDomainProgress[];
  jobId: number;
  runId: number;
  runStatus: string;
  onChanged: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.run;

  // Status filter (added 2026-05-12). Applied BEFORE search/pagination
  // so the page counts + select-all reflect the filtered set.
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  // Wayback CDX row-count filter (added 2026-05-13). ANDed with statusFilter;
  // common combo is status=done + cdx=zero → done-but-empty wayback for
  // bulk-retry of wayback / wayback_classify on those rows.
  const [waybackFilter, setWaybackFilter] = useState<WaybackFilterValue>("any");
  const filtered = useMemo<RunDomainProgress[]>(() => {
    return domains.filter((d) => {
      if (statusFilter !== "all" && d.status !== statusFilter) return false;
      if (waybackFilter === "zero" && d.wayback_rows !== 0) return false;
      if (
        waybackFilter === "nonzero" &&
        !(typeof d.wayback_rows === "number" && d.wayback_rows >= 1)
      )
        return false;
      return true;
    });
  }, [domains, statusFilter, waybackFilter]);

  // Bulk selection (added 2026-05-12) — Set of RunDomain ids. Persists
  // across pagination but clears when either filter changes (so the user
  // doesn't accidentally retry rows they can no longer see).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [statusFilter, waybackFilter]);

  // Bulk-retry state.
  const [bulkOpen, setBulkOpen] = useState(false);
  // Which criteria the user picked. Defaults to "every criterion that
  // actually has CR rows across the visible domains" (= enabled in the
  // spec). Picker is shown only when bulk panel is open.
  const enabledCriteria = useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const d of domains) {
      for (const c of Object.keys(d.criteria || {})) seen.add(c);
    }
    return Array.from(seen).sort();
  }, [domains]);
  const [pickedCriteria, setPickedCriteria] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setPickedCriteria(new Set(enabledCriteria));
  }, [enabledCriteria]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  // Re-sample V2 only mode (added 2026-05-13). Skips CDX refetch and
  // re-collects V2 samples against the existing wayback CR's rows.
  // Only meaningful when wayback is checked in the criterion picker;
  // the checkbox is disabled otherwise.
  const [waybackResampleOnly, setWaybackResampleOnly] = useState(false);
  // If the user unchecks wayback after toggling resample-only, drop
  // the flag so a later wayback re-check doesn't silently re-enable it.
  useEffect(() => {
    if (!pickedCriteria.has("wayback") && waybackResampleOnly) {
      setWaybackResampleOnly(false);
    }
  }, [pickedCriteria, waybackResampleOnly]);

  // Bulk retry needs the run to be terminal (matches the backend gate
  // on /retry-batch). Disable the panel when the run is still active.
  const retryEligible =
    runStatus === "done" || runStatus === "failed" || runStatus === "canceled";

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePicked(c: string) {
    setPickedCriteria((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function handleBulkRetry() {
    if (selected.size === 0) return;
    if (pickedCriteria.size === 0) {
      setBulkError(ts.bulkRetryNothing);
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const r = await api.retryRunBatch(runId, Array.from(selected), {
        criteria: Array.from(pickedCriteria),
        waybackResampleOnly,
      });
      setBulkResult(
        ts.bulkRetryResult(r.domains ?? 0, r.criteria ?? 0),
      );
      setSelected(new Set());
      setBulkOpen(false);
      onChanged();
    } catch (e) {
      setBulkError((e as Error).message || "retry failed");
    } finally {
      setBulkBusy(false);
    }
  }

  const matchDomain = useCallback(
    (d: RunDomainProgress, q: string) => d.domain.toLowerCase().includes(q),
    [],
  );
  const search = usePaginatedSearch<RunDomainProgress>(filtered, matchDomain);

  // Page-level select-all checkbox covers the currently-visible page
  // (post-filter, post-search, post-paginate). Cross-page bulk select
  // would surprise users.
  const pageIds = search.paged.map((d) => d.id);
  const pageAllSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  function togglePageSelect() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }
  // "Select all matching filter" — across pages, but only the filtered
  // (and searched) set.
  function selectAllMatching() {
    setSelected(new Set(search.filteredAll.map((d) => d.id)));
  }

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
          {/* Status filter (added 2026-05-12) + Wayback CDX filter
              (added 2026-05-13). Both ANDed via the `filtered` useMemo. */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">
                {ts.filterStatusLabel}
              </span>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as StatusFilterValue)
                }
                className="px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950"
              >
                <option value="all">{ts.filterStatusAll}</option>
                <option value="pending">{ts.filterStatusPending}</option>
                <option value="running">{ts.filterStatusRunning}</option>
                <option value="done">{ts.filterStatusDone}</option>
                <option value="failed">{ts.filterStatusFailed}</option>
                <option value="canceled">{ts.filterStatusCanceled}</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">
                {ts.filterWaybackLabel}
              </span>
              <select
                value={waybackFilter}
                onChange={(e) =>
                  setWaybackFilter(e.target.value as WaybackFilterValue)
                }
                className="px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950"
              >
                <option value="any">{ts.filterWaybackAny}</option>
                <option value="zero">{ts.filterWaybackZero}</option>
                <option value="nonzero">{ts.filterWaybackNonzero}</option>
              </select>
            </label>
            <span className="text-neutral-500 dark:text-neutral-400">
              ({search.filteredTotal})
            </span>
          </div>

          {/* Bulk action bar (added 2026-05-12) — appears once any row
              is selected. The criterion picker shows the run's enabled
              criteria; user can narrow to e.g. wayback-only retries. */}
          {selected.size > 0 && (
            <div className="rounded-md border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-amber-900 dark:text-amber-200">
                  {ts.bulkSelected(selected.size)}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setBulkOpen((v) => !v)}
                  disabled={!retryEligible || bulkBusy}
                  title={
                    retryEligible
                      ? ""
                      : ts.retryFailedHint
                  }
                  className="text-xs px-2 py-1 rounded-md border border-amber-400 bg-white dark:bg-neutral-900 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
                >
                  {bulkBusy
                    ? ts.bulkRetryRunning
                    : ts.bulkRetry(selected.size)}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {ts.clearSelection}
                </button>
              </div>
              {bulkOpen && retryEligible && (
                <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-neutral-950 p-3 space-y-2">
                  <div>
                    <div className="text-sm font-medium">
                      {ts.bulkRetryCriteriaHeading}
                    </div>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      {ts.bulkRetryCriteriaHint}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {enabledCriteria.map((c) => (
                      <label
                        key={c}
                        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      >
                        <input
                          type="checkbox"
                          checked={pickedCriteria.has(c)}
                          onChange={() => togglePicked(c)}
                        />
                        <span className="font-mono">{c}</span>
                      </label>
                    ))}
                  </div>
                  {/* Auto-cascade note (added 2026-05-13). Surfaces the
                      server-side `_cascade_wayback_classify` behavior so
                      the user isn't surprised when classify re-runs even
                      though they unchecked it. Only renders when the
                      cascade would actually fire on submit. */}
                  {pickedCriteria.has("wayback") &&
                    enabledCriteria.includes("wayback_classify") &&
                    !pickedCriteria.has("wayback_classify") && (
                      <p className="text-xs rounded-md px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200">
                        {ts.bulkRetryClassifyAutoNote}
                      </p>
                    )}
                  {/* Re-sample V2 only toggle (added 2026-05-13). Only
                      offered when wayback is on the run; disabled when
                      wayback isn't checked in the picker (the flag has
                      nothing to act on otherwise — backend would 400). */}
                  {enabledCriteria.includes("wayback") && (
                    <div className="space-y-1 pt-1 border-t dark:border-neutral-800">
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={waybackResampleOnly}
                          onChange={(e) =>
                            setWaybackResampleOnly(e.target.checked)
                          }
                          disabled={!pickedCriteria.has("wayback")}
                        />
                        <span
                          className={
                            pickedCriteria.has("wayback")
                              ? "font-medium"
                              : "font-medium text-neutral-400 dark:text-neutral-600"
                          }
                        >
                          {ts.bulkRetryResampleLabel}
                        </span>
                      </label>
                      <p className="text-xs text-neutral-600 dark:text-neutral-400 pl-6">
                        {ts.bulkRetryResampleHelp}
                      </p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleBulkRetry}
                      disabled={bulkBusy || pickedCriteria.size === 0}
                      className="text-xs px-3 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {bulkBusy
                        ? ts.bulkRetryRunning
                        : ts.bulkRetryConfirm}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkOpen(false)}
                      className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              )}
              {bulkError && (
                <p className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
                  {bulkError}
                </p>
              )}
              {bulkResult && (
                <p className="text-xs rounded-md px-2 py-1 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                  {bulkResult}
                </p>
              )}
            </div>
          )}

          <PaginationTopBar
            state={search}
            searchPlaceholder="Search by domain…"
          />
          {/* "Select all matching" link — only useful when the filter
              + search has narrowed things AND there's more to grab
              than just the visible page. */}
          {search.filteredTotal > pageIds.length &&
            search.filteredTotal !== selected.size && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={selectAllMatching}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {ts.selectAllMatching(search.filteredTotal)}
                </button>
              </div>
            )}
          <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={pageAllSelected}
                      onChange={togglePageSelect}
                      aria-label={ts.selectAllOnPage}
                      className="cursor-pointer"
                    />
                  </th>
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
                  const isSel = selected.has(d.id);
                  return (
                    <tr
                      key={d.id}
                      className={
                        "border-t dark:border-neutral-800 " +
                        (isSel
                          ? "bg-blue-50/70 dark:bg-blue-950/30"
                          : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60")
                      }
                    >
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleOne(d.id)}
                          aria-label={`Select ${d.domain}`}
                          className="cursor-pointer"
                        />
                      </td>
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
                            title={ts.pinIndicator}
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
