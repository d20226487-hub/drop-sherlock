"use client";

// Standalone test page for the /tools/ahrefs-batch-analysis backend
// probe. Lets the operator paste a batch of domains and pull two
// independent Ahrefs data sources:
//
//   1. Batch Analysis (/batch-analysis) — current-snapshot metrics
//      (DR, referring domains follow/nofollow, dofollow backlinks,
//      referring IP subnets, organic traffic + keyword bands). Batched
//      at ~1 unit/domain/field. Rendered in its own table.
//   2. Keywords history (Site Explorer /keywords-history) — per-domain
//      time series of top4_10 / top11_20 ranking-keyword counts over a
//      date range. One call per domain (50-unit floor each). Rendered
//      below with expandable per-domain detail rows.
//
// Not wired into the Job/Run/CR pipeline — pure ad-hoc experimentation.
// Results aren't persisted; close the tab and they're gone.
//
// Renamed 2026-06-02 from /tools/keywords-history; batch-analysis grew
// from a DR-only sidecar into a first-class metric set.

import { useMemo, useState } from "react";

import { ResultsTable, type ResultsColumn } from "@/components/results-table";

// Mirror of backend BATCH_METRICS (same ids + order). The backend
// canonicalizes order regardless of request order, but keeping the list
// here in sync means the checkboxes + columns render in the same order.
const BATCH_METRICS: { id: string; label: string }[] = [
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

const BATCH_LABELS: Record<string, string> = Object.fromEntries(
  BATCH_METRICS.map((m) => [m.id, m.label]),
);

// DR is a 1-decimal float; everything else is an integer count.
function formatMetric(id: string, v: number | null): string {
  if (v == null) return "—";
  if (id === "domain_rating") return v.toFixed(1);
  return Math.round(v).toLocaleString();
}

type Row = {
  date: string | null;
  top11_20: number | null;
  top4_10: number | null;
};

type DomainResult = {
  domain: string;
  http_status: number;
  cost_row: number | null;
  cost_total: number | null;
  cost_actual: number | null;
  rows: Row[];
  error: string;
  // Batch-analysis sub-result. Backend always emits these keys (empty
  // dict / null when batch not requested), so the table stays one row
  // per domain.
  batch_http_status: number | null;
  batch: Record<string, number | null>;
  batch_error: string;
};

type ToolOut = {
  date_from: string;
  date_to: string;
  grouping: string;
  // Selected batch metric ids, canonical order — drives the columns.
  metrics: string[];
  results: DomainResult[];
  totals: {
    domains_total: number;
    domains_ok: number;
    rows: number;
    cost_list_price: number;
    cost_billed_actual: number;
    // Split between the two endpoint families so the summary card can
    // show that batch metrics were fetched cheaply (vs per-domain KH).
    kh_cost_list?: number;
    kh_cost_billed?: number;
    batch_cost_list?: number;
    batch_cost_billed?: number;
    batch_calls?: number;
  };
};

// --- Keywords-history per-band analytics ---------------------------------
//
// All derived client-side from the monthly time series already in the
// response (r.rows) — no extra Ahrefs spend. Each band yields Max / Avg /
// Total over the returned buckets plus a sparkline of the raw series.
// A null/absent count coerces to 0 so the bucket still counts toward the
// average denominator (a month with no ranking keywords is a real 0, not
// missing data).
type Band = "top4_10" | "top11_20";

function bandValues(rows: Row[], band: Band): number[] {
  return rows.map((r) => {
    const v = r[band];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });
}

type BandStats = { max: number; avg: number; total: number; months: number };

function bandStats(values: number[]): BandStats {
  const months = values.length;
  if (months === 0) return { max: 0, avg: 0, total: 0, months: 0 };
  const total = values.reduce((a, b) => a + b, 0);
  return { max: Math.max(...values), avg: total / months, total, months };
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtAvg(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// Per-bucket suffix for the Max/Avg column labels, matched to the
// grouping the probe ran at ("monthly" → "/mo").
function perLabel(grouping: string): string {
  if (grouping === "daily") return "/day";
  if (grouping === "weekly") return "/wk";
  return "/mo";
}

// Bands rendered left→right, each with a distinguishable sparkline color
// that reads in both light and dark themes (blue-500 / violet-500).
const BAND_META: { band: Band; short: string; stroke: string }[] = [
  { band: "top4_10", short: "4-10", stroke: "#3b82f6" },
  { band: "top11_20", short: "11-20", stroke: "#8b5cf6" },
];

// Inline SVG sparkline of a band's raw series — oldest→newest, left→right.
// Compact (88×24) so it fits a table cell; area fill + last-point dot give
// a quick read of the trajectory. Hover shows min/max/last + point count.
function Sparkline({ values, stroke }: { values: number[]; stroke: string }) {
  const w = 88;
  const h = 24;
  const pad = 3;
  if (values.length === 0) {
    return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const n = values.length;
  const xAt = (i: number) =>
    pad + (n === 1 ? (w - pad * 2) / 2 : (i / (n - 1)) * (w - pad * 2));
  const yAt = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);
  const pts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const area =
    `M${xAt(0).toFixed(1)},${(h - pad).toFixed(1)} L` +
    pts.join(" L") +
    ` L${xAt(n - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const last = values[n - 1];
  const title = `${n} pts · min ${fmtInt(min)} · max ${fmtInt(max)} · last ${fmtInt(last)}`;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="block"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d={area} fill={stroke} fillOpacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={xAt(n - 1)} cy={yAt(last)} r={1.6} fill={stroke} />
    </svg>
  );
}

const RANGE_OPTIONS: { value: "3m" | "6m" | "1y" | "2y" | "5y"; label: string }[] = [
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "1y", label: "1 year" },
  { value: "2y", label: "2 years" },
  { value: "5y", label: "5 years" },
];

const GROUPING_OPTIONS: { value: "daily" | "weekly" | "monthly"; label: string }[] = [
  { value: "monthly", label: "monthly" },
  { value: "weekly", label: "weekly" },
  { value: "daily", label: "daily (very expensive)" },
];

export default function AhrefsBatchAnalysisToolPage() {
  const [domainsRaw, setDomainsRaw] = useState("");
  const [dateRange, setDateRange] = useState<"3m" | "6m" | "1y" | "2y" | "5y">("2y");
  const [grouping, setGrouping] = useState<"daily" | "weekly" | "monthly">("monthly");
  const [concurrency, setConcurrency] = useState(4);
  // Batch-analysis is the primary surface now, but default to DR only —
  // it's the cheapest single field; the operator opts into the rest.
  const [batchSel, setBatchSel] = useState<Set<string>>(
    () => new Set(["domain_rating"]),
  );
  // Keywords-history (Site Explorer) is the secondary time-series probe
  // — default OFF because each domain costs a 50-unit floor (vs batch's
  // ~1u/domain/field). Operator opts in when they want the timeline.
  const [selectTop4_10, setSelectTop4_10] = useState(false);
  const [selectTop11_20, setSelectTop11_20] = useState(false);
  const includeKh = selectTop4_10 || selectTop11_20;
  const includeBatch = batchSel.size > 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ToolOut | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function parseDomains(): string[] {
    return domainsRaw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function toggleBatch(id: string) {
    setBatchSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allBatchOn = batchSel.size === BATCH_METRICS.length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const domains = parseDomains();
    if (domains.length === 0) {
      setError("Add at least one domain");
      return;
    }
    if (domains.length > 1000) {
      setError(`Max 1000 domains per probe (you have ${domains.length})`);
      return;
    }
    if (!includeKh && !includeBatch) {
      setError("Pick at least one metric to probe");
      return;
    }
    setBusy(true);
    setResult(null);
    setExpanded(new Set());
    try {
      const res = await fetch("/api/tools/ahrefs-batch-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains,
          date_range: dateRange,
          history_grouping: grouping,
          concurrency,
          select_top4_10: selectTop4_10,
          select_top11_20: selectTop11_20,
          // Send in canonical order so the request is stable/diffable.
          batch_metrics: BATCH_METRICS.filter((m) => batchSel.has(m.id)).map(
            (m) => m.id,
          ),
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data: ToolOut = await res.json();
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleRow(domain: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tool · Ahrefs bulk probe</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Bulk <code>/batch-analysis</code> (current-snapshot metrics) and/or{" "}
          <code>/keywords-history</code> (top4_10 / top11_20 time series)
          across a batch of domains. Batch metrics come from Ahrefs{" "}
          <strong>batch analysis</strong> (not Site Explorer) and batch at
          ~1 unit/domain/field; keywords-history is per-domain with a
          ~50-unit floor. Results are <strong>not persisted</strong>.
        </p>
      </header>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4"
      >
        <label className="block">
          <span className="text-sm font-medium block mb-1">
            Domains (one per line, comma, or whitespace separated · max 1000)
          </span>
          <textarea
            value={domainsRaw}
            onChange={(e) => setDomainsRaw(e.target.value)}
            rows={8}
            placeholder={"example.com\nkotopes.kz\nzhurnal-prostor.kz"}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono outline-none"
            disabled={busy}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            Parsed: {parseDomains().length} domain
            {parseDomains().length === 1 ? "" : "s"}
          </span>
        </label>

        {/* Batch Analysis metric picker — every field is a single
            /batch-analysis SELECT column, batched at ~1u/domain/field.
            Pick any subset; empty = skip the batch call entirely. */}
        <div className="border-t dark:border-neutral-800 pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">
              Batch Analysis{" "}
              <span className="font-normal text-neutral-500">
                (Ahrefs /batch-analysis — current snapshot)
              </span>
            </span>
            <button
              type="button"
              onClick={() =>
                setBatchSel(
                  allBatchOn
                    ? new Set()
                    : new Set(BATCH_METRICS.map((m) => m.id)),
                )
              }
              disabled={busy}
              className="text-xs text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
            >
              {allBatchOn ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            {BATCH_METRICS.map((m) => (
              <label key={m.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={batchSel.has(m.id)}
                  onChange={() => toggleBatch(m.id)}
                  disabled={busy}
                />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Keywords-history time-series toggles (Site Explorer). Each
            adds 1 to cost_row on /keywords-history; trimming one matters
            at long ranges (5y+) where rows × cost_row exceeds the
            50-unit floor. */}
        <div className="border-t dark:border-neutral-800 pt-3 space-y-2">
          <span className="text-sm font-semibold">
            Keywords history{" "}
            <span className="font-normal text-neutral-500">
              (Site Explorer /keywords-history — time series)
            </span>
          </span>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selectTop4_10}
                onChange={(e) => setSelectTop4_10(e.target.checked)}
                disabled={busy}
              />
              <span>
                <strong>top4_10</strong>{" "}
                <span className="text-neutral-500">(positions 4-10)</span>
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selectTop11_20}
                onChange={(e) => setSelectTop11_20(e.target.checked)}
                disabled={busy}
              />
              <span>
                <strong>top11_20</strong>{" "}
                <span className="text-neutral-500">(positions 11-20)</span>
              </span>
            </label>
          </div>
        </div>

        {/* Date range + grouping only relevant when keywords-history
            is in the probe — /batch-analysis is a current snapshot. */}
        {includeKh && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium block mb-1">Date range</span>
              <select
                value={dateRange}
                onChange={(e) =>
                  setDateRange(
                    e.target.value as "3m" | "6m" | "1y" | "2y" | "5y",
                  )
                }
                className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
                disabled={busy}
              >
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium block mb-1">Grouping</span>
              <select
                value={grouping}
                onChange={(e) =>
                  setGrouping(e.target.value as "daily" | "weekly" | "monthly")
                }
                className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
                disabled={busy}
              >
                {GROUPING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <label className="block max-w-[12rem]">
          <span className="text-sm font-medium block mb-1">
            Concurrency (1–10)
          </span>
          <input
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(e) =>
              setConcurrency(
                Math.max(1, Math.min(10, parseInt(e.target.value || "1", 10))),
              )
            }
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
            disabled={busy}
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={
              busy || parseDomains().length === 0 || (!includeKh && !includeBatch)
            }
            className="px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {busy ? "Probing…" : "Probe"}
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {(() => {
              const n = parseDomains().length;
              if (!includeKh && !includeBatch) {
                return "Pick at least one metric to probe.";
              }
              // KH cost: per-domain 50-unit floor (one call per domain).
              // Batch cost: chunked at 100/call; each call has Ahrefs's
              // universal 50-unit floor, then converges to ~fields×N.
              const khCost = includeKh ? 50 * n : 0;
              const batches = Math.max(1, Math.ceil(n / 100));
              const fields = batchSel.size;
              const batchCost = includeBatch
                ? Math.max(50 * batches, fields * n)
                : 0;
              const total = khCost + batchCost;
              return (
                <>
                  Estimated cost lower bound:{" "}
                  <strong>{total.toLocaleString()} units</strong>
                  {includeBatch && (
                    <>
                      {" — Batch "}
                      <strong>{batchCost.toLocaleString()}u</strong>{" "}
                      ({fields} metric{fields === 1 ? "" : "s"} × {n})
                    </>
                  )}
                  {includeKh && (
                    <>
                      {" — KH "}
                      <strong>{khCost.toLocaleString()}u</strong>{" "}
                      (50/domain × {n})
                    </>
                  )}
                </>
              );
            })()}
          </span>
        </div>
      </form>

      {error && (
        <div className="rounded-md border border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-800 dark:text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <section className="space-y-4">
          {/* Cost summary card */}
          <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
            <h2 className="text-lg font-semibold mb-2">Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <Stat label="Domains" value={result.totals.domains_total} />
              <Stat
                label="OK"
                value={result.totals.domains_ok}
                tone={
                  result.totals.domains_ok === result.totals.domains_total
                    ? "good"
                    : "warn"
                }
              />
              <Stat label="KH rows" value={result.totals.rows} />
              <Stat
                label="List price"
                value={`${result.totals.cost_list_price.toLocaleString()} u`}
              />
              <Stat
                label="Billed actual"
                value={`${result.totals.cost_billed_actual.toLocaleString()} u`}
                tone={
                  result.totals.cost_billed_actual <
                  result.totals.cost_list_price
                    ? "good"
                    : "neutral"
                }
              />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-3">
              Date range: <code>{result.date_from}</code> →{" "}
              <code>{result.date_to}</code> · grouping:{" "}
              <code>{result.grouping}</code>. Billed-actual {"<"} list price
              means Ahrefs's server-side cache hit on one or more domains.
            </p>
            {result.totals.kh_cost_list || result.totals.batch_cost_list ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Cost split:
                {result.totals.batch_cost_list ? (
                  <>
                    {" "}
                    <strong>
                      Batch {result.totals.batch_cost_list.toLocaleString()}u
                    </strong>{" "}
                    list across {result.totals.batch_calls ?? 0} batch call
                    {result.totals.batch_calls === 1 ? "" : "s"}
                    {result.totals.batch_cost_billed !==
                      result.totals.batch_cost_list && (
                      <>
                        {" "}
                        / {result.totals.batch_cost_billed?.toLocaleString()}u
                        billed
                      </>
                    )}
                  </>
                ) : null}
                {result.totals.batch_cost_list && result.totals.kh_cost_list
                  ? " · "
                  : ""}
                {result.totals.kh_cost_list ? (
                  <>
                    <strong>
                      KH {result.totals.kh_cost_list.toLocaleString()}u
                    </strong>{" "}
                    list
                    {result.totals.kh_cost_billed !==
                      result.totals.kh_cost_list && (
                      <>
                        {" "}
                        / {result.totals.kh_cost_billed?.toLocaleString()}u
                        billed
                      </>
                    )}
                  </>
                ) : null}
              </p>
            ) : null}
          </div>

          {/* Batch Analysis section — one row per domain, one column per
              selected metric. Driven entirely by result.metrics. */}
          {result.metrics.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Batch Analysis</h2>
              <BatchAnalysisTable result={result} />
            </div>
          )}

          {/* Keywords history section — per-domain time series with
              expandable detail rows. Only rendered when KH was probed. */}
          {includeKh && (
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Keywords history</h2>
              <KeywordsHistoryTable
                result={result}
                expanded={expanded}
                onToggleRow={toggleRow}
                selectTop4_10={selectTop4_10}
                selectTop11_20={selectTop11_20}
              />
            </div>
          )}
        </section>
      )}

      {/* SERP Overview — a separate, self-contained tool below Keywords
          history. Operates on KEYWORDS (not domains) and mirrors Ahrefs's
          SERP Overview API, returning the ranking-page URLs per keyword.
          Its own form / button / results so it never crowds the combined
          domain probe above. */}
      <SerpOverviewSection />
    </main>
  );
}

// Batch-analysis table: Domain + one column per selected metric.
// Columns are derived from result.metrics (canonical order).
function BatchAnalysisTable({ result }: { result: ToolOut }) {
  const columns: ResultsColumn<DomainResult>[] = useMemo(() => {
    const cols: ResultsColumn<DomainResult>[] = [
      {
        key: "domain",
        label: "Domain",
        className: "font-mono",
        render: (r) => r.domain,
        toExport: (r) => r.domain,
      },
    ];
    for (const id of result.metrics) {
      cols.push({
        key: id,
        label: BATCH_LABELS[id] ?? id,
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => {
          if (r.batch_error) {
            return (
              <span
                className="text-rose-700 dark:text-rose-400"
                title={`batch error: ${r.batch_error}`}
              >
                err
              </span>
            );
          }
          return formatMetric(id, r.batch?.[id] ?? null);
        },
        toExport: (r) => {
          const v = r.batch?.[id];
          return v == null ? "" : formatMetric(id, v);
        },
      });
    }
    return cols;
  }, [result.metrics]);

  return (
    <ResultsTable<DomainResult>
      rows={result.results}
      columns={columns}
      csvFilename="ahrefs-batch-analysis.csv"
      emptyMessage="No domains in the batch."
    />
  );
}

// Keywords-history table — the original per-domain KH view with
// expandable detail rows below the main table.
function KeywordsHistoryTable({
  result,
  expanded,
  onToggleRow,
  selectTop4_10,
  selectTop11_20,
}: {
  result: ToolOut;
  expanded: Set<string>;
  onToggleRow: (domain: string) => void;
  selectTop4_10: boolean;
  selectTop11_20: boolean;
}) {
  const columns: ResultsColumn<DomainResult>[] = useMemo(() => {
    const per = perLabel(result.grouping);
    // Max / Avg / Total / Trend per selected band, all derived from
    // r.rows. Only the bands the operator probed get columns.
    const bandCols: ResultsColumn<DomainResult>[] = [];
    for (const meta of BAND_META) {
      const on =
        meta.band === "top4_10" ? selectTop4_10 : selectTop11_20;
      if (!on) continue;
      bandCols.push(
        {
          key: `${meta.band}_max`,
          label: `${meta.short} Max${per}`,
          className: "text-right tabular-nums",
          headerClassName: "text-right",
          render: (r) =>
            fmtInt(bandStats(bandValues(r.rows, meta.band)).max),
          toExport: (r) =>
            String(Math.round(bandStats(bandValues(r.rows, meta.band)).max)),
        },
        {
          key: `${meta.band}_avg`,
          label: `${meta.short} Avg${per}`,
          className: "text-right tabular-nums",
          headerClassName: "text-right",
          render: (r) =>
            fmtAvg(bandStats(bandValues(r.rows, meta.band)).avg),
          toExport: (r) =>
            bandStats(bandValues(r.rows, meta.band)).avg.toFixed(1),
        },
        {
          key: `${meta.band}_total`,
          label: `${meta.short} Total`,
          className: "text-right tabular-nums font-medium",
          headerClassName: "text-right",
          render: (r) =>
            fmtInt(bandStats(bandValues(r.rows, meta.band)).total),
          toExport: (r) =>
            String(Math.round(bandStats(bandValues(r.rows, meta.band)).total)),
        },
        {
          key: `${meta.band}_trend`,
          label: `${meta.short} Trend`,
          render: (r) => (
            <Sparkline
              values={bandValues(r.rows, meta.band)}
              stroke={meta.stroke}
            />
          ),
          // Export the raw series so "CSV all" still carries the data a
          // sparkline can't. Not searchable — it's a visual.
          toExport: (r) => bandValues(r.rows, meta.band).join(" "),
          searchable: false,
        },
      );
    }
    const cols: ResultsColumn<DomainResult>[] = [
      {
        key: "domain",
        label: "Domain",
        className: "font-mono",
        render: (r) => r.domain,
        toExport: (r) => r.domain,
      },
      ...bandCols,
      {
        key: "kh_http",
        label: "HTTP",
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => (
          <span
            className={
              r.http_status === 200
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
            }
          >
            {r.http_status || "—"}
          </span>
        ),
        toExport: (r) => String(r.http_status || ""),
      },
      {
        key: "rows",
        label: "Rows",
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => r.rows.length,
        toExport: (r) => String(r.rows.length),
      },
      {
        key: "cost_row",
        label: "cost_row",
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => r.cost_row ?? "—",
        toExport: (r) => (r.cost_row != null ? String(r.cost_row) : ""),
      },
      {
        key: "kh_list",
        label: "KH list",
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => r.cost_total ?? "—",
        toExport: (r) => (r.cost_total != null ? String(r.cost_total) : ""),
      },
      {
        key: "kh_billed",
        label: "KH billed",
        className: "text-right tabular-nums",
        headerClassName: "text-right",
        render: (r) => r.cost_actual ?? "—",
        toExport: (r) => (r.cost_actual != null ? String(r.cost_actual) : ""),
      },
      {
        key: "actions",
        label: "",
        render: (r) => {
          const isExp = expanded.has(r.domain);
          return (
            <div className="flex items-center justify-end gap-2">
              {r.rows.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onToggleRow(r.domain)}
                  className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                >
                  {isExp ? "Hide rows" : "Show rows"}
                </button>
              ) : null}
              {r.error && (
                <span
                  className="text-xs text-rose-700 dark:text-rose-400"
                  title={r.error}
                >
                  error
                </span>
              )}
            </div>
          );
        },
        searchable: false,
      },
    ];
    return cols;
  }, [expanded, onToggleRow, result.grouping, selectTop4_10, selectTop11_20]);

  const expandedRows = useMemo(
    () =>
      result.results.filter(
        (r) => expanded.has(r.domain) && r.rows.length > 0,
      ),
    [result.results, expanded],
  );

  return (
    <div className="space-y-4">
      <ResultsTable<DomainResult>
        rows={result.results}
        columns={columns}
        csvFilename="ahrefs-keywords-history.csv"
        emptyMessage="No domains in the batch."
      />
      {expandedRows.length > 0 && (
        <div className="space-y-3">
          {expandedRows.map((r) => (
            <div
              key={r.domain}
              className="rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/30 p-3"
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-mono">{r.domain}</h4>
                <button
                  type="button"
                  onClick={() => onToggleRow(r.domain)}
                  className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                >
                  Hide
                </button>
              </div>
              <table className="w-full text-xs">
                <thead className="text-neutral-500 dark:text-neutral-400">
                  <tr>
                    <th className="text-left py-1 pr-3">Date</th>
                    {selectTop4_10 && (
                      <th className="text-right py-1 pr-3">top4_10</th>
                    )}
                    {selectTop11_20 && (
                      <th className="text-right py-1">top11_20</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row, i) => (
                    <tr
                      key={i}
                      className="border-t border-neutral-200 dark:border-neutral-800/60"
                    >
                      <td className="py-1 pr-3 font-mono">
                        {row.date ? row.date.slice(0, 10) : "—"}
                      </td>
                      {selectTop4_10 && (
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {row.top4_10 ?? "—"}
                        </td>
                      )}
                      {selectTop11_20 && (
                        <td className="py-1 text-right tabular-nums">
                          {row.top11_20 ?? "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "good" | "warn" | "neutral";
}) {
  const valueCls =
    tone === "good"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "text-neutral-900 dark:text-neutral-100";
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${valueCls}`}>
        {value}
      </div>
    </div>
  );
}

// =========================================================================
// SERP Overview tool
// =========================================================================
//
// Mirrors Ahrefs's SERP Overview API (/serp-overview). Input is a batch
// of KEYWORDS; for each one we fetch the ranking-page URLs in the chosen
// country, limited to the top N organic positions. To minimise Ahrefs
// unit spend the backend SELECTs only `url` (the cheapest column set), so
// the result table is deliberately just Keyword + URL.

// Curated country list (ISO 3166-1 alpha-2). Ahrefs accepts any valid
// code; this covers the common ones for this operator's niche, with the
// regional markets first. The backend lower-cases + validates.
const SERP_COUNTRY_OPTIONS: { code: string; label: string }[] = [
  { code: "kz", label: "Kazakhstan (kz)" },
  { code: "ru", label: "Russia (ru)" },
  { code: "ua", label: "Ukraine (ua)" },
  { code: "by", label: "Belarus (by)" },
  { code: "uz", label: "Uzbekistan (uz)" },
  { code: "us", label: "United States (us)" },
  { code: "gb", label: "United Kingdom (gb)" },
  { code: "de", label: "Germany (de)" },
  { code: "fr", label: "France (fr)" },
  { code: "es", label: "Spain (es)" },
  { code: "it", label: "Italy (it)" },
  { code: "pl", label: "Poland (pl)" },
  { code: "tr", label: "Turkey (tr)" },
  { code: "nl", label: "Netherlands (nl)" },
  { code: "ca", label: "Canada (ca)" },
  { code: "au", label: "Australia (au)" },
  { code: "in", label: "India (in)" },
  { code: "br", label: "Brazil (br)" },
];

type SerpUrlRow = { url: string };

type SerpKeywordResult = {
  keyword: string;
  http_status: number;
  cost_row: number | null;
  cost_total: number | null;
  cost_actual: number | null;
  // Raw position count before null-URL rows are dropped — lets us tell
  // "Ahrefs has no SERP data" (0) from "only SERP features" (>0).
  positions_count: number;
  urls: SerpUrlRow[];
  error: string;
};

type SerpToolOut = {
  country: string;
  top_positions: number | null;
  results: SerpKeywordResult[];
  totals: {
    keywords_total: number;
    keywords_ok: number;
    urls: number;
    cost_list_price: number;
    cost_billed_actual: number;
  };
};

// One flat row per (keyword, ranking-page URL) — what the results table
// renders. Keeping it flat lets the shared ResultsTable handle search /
// sort / pagination / CSV export for free.
type SerpFlatRow = { keyword: string; url: string };

// NOTE: not exported — Next.js page.tsx files reject any named export
// other than the page/metadata fields ("not a valid Page export field").
function SerpOverviewSection() {
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const [country, setCountry] = useState("kz");
  const [topPositions, setTopPositions] = useState(10);
  const [concurrency, setConcurrency] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SerpToolOut | null>(null);

  // One keyword per line. Keep raw case for display but the backend
  // folds case when deduping/sending.
  function parseKeywords(): string[] {
    return keywordsRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const keywords = parseKeywords();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (keywords.length === 0) {
      setError("Add at least one keyword");
      return;
    }
    if (keywords.length > 500) {
      setError(`Max 500 keywords per probe (you have ${keywords.length})`);
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/tools/ahrefs-serp-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords,
          country,
          top_positions: topPositions,
          concurrency,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data: SerpToolOut = await res.json();
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 border-t-2 dark:border-neutral-800 pt-8">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">SERP Overview</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Bulk <code>/serp-overview</code> across a batch of{" "}
          <strong>keywords</strong>. Returns the ranking-page{" "}
          <strong>URLs</strong> per keyword for the chosen country, limited
          to the top organic positions. Only the <code>url</code> column is
          fetched to keep Ahrefs spend at the floor (~50 units/keyword).
          Results are <strong>not persisted</strong>. Tip: keyword{" "}
          <code>ahrefs</code> or <code>wordcount</code> probes for free.
        </p>
      </header>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4"
      >
        <label className="block">
          <span className="text-sm font-medium block mb-1">
            Keywords (one per line · max 500)
          </span>
          <textarea
            value={keywordsRaw}
            onChange={(e) => setKeywordsRaw(e.target.value)}
            rows={6}
            placeholder={"купить телефон\nдоставка цветов алматы\nahrefs"}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm outline-none"
            disabled={busy}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            Parsed: {keywords.length} keyword{keywords.length === 1 ? "" : "s"}
          </span>
        </label>

        {/* Filters: country + top_positions (the two Ahrefs SERP-overview
            knobs the operator asked for). */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm font-medium block mb-1">Country</span>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            >
              {SERP_COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Top positions (1–100)
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={topPositions}
              onChange={(e) =>
                setTopPositions(
                  Math.max(
                    1,
                    Math.min(100, parseInt(e.target.value || "1", 10)),
                  ),
                )
              }
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Concurrency (1–10)
            </span>
            <input
              type="number"
              min={1}
              max={10}
              value={concurrency}
              onChange={(e) =>
                setConcurrency(
                  Math.max(
                    1,
                    Math.min(10, parseInt(e.target.value || "1", 10)),
                  ),
                )
              }
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || keywords.length === 0}
            className="px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {busy ? "Probing…" : "Probe SERPs"}
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {keywords.length > 0 ? (
              <>
                Estimated cost lower bound:{" "}
                <strong>
                  {(50 * keywords.length).toLocaleString()} units
                </strong>{" "}
                (~50/keyword floor × {keywords.length})
              </>
            ) : (
              "Add keywords to estimate cost."
            )}
          </span>
        </div>
      </form>

      {error && (
        <div className="rounded-md border border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-800 dark:text-rose-300">
          {error}
        </div>
      )}

      {result && <SerpOverviewResult result={result} />}
    </section>
  );
}

function SerpOverviewResult({ result }: { result: SerpToolOut }) {
  // Flatten to (keyword, url) rows for the shared table. Keywords that
  // returned no URLs (all-null SERP, or an error) contribute no rows but
  // are still visible in the per-keyword status panel below.
  const flatRows: SerpFlatRow[] = useMemo(() => {
    const out: SerpFlatRow[] = [];
    for (const r of result.results) {
      for (const u of r.urls) {
        out.push({ keyword: r.keyword, url: u.url });
      }
    }
    return out;
  }, [result.results]);

  const columns: ResultsColumn<SerpFlatRow>[] = useMemo(
    () => [
      {
        key: "keyword",
        label: "Keyword",
        render: (r) => r.keyword,
        toExport: (r) => r.keyword,
      },
      {
        key: "url",
        label: "URL",
        className: "font-mono break-all",
        render: (r) => (
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 dark:text-blue-400 hover:underline"
          >
            {r.url}
          </a>
        ),
        toExport: (r) => r.url,
      },
    ],
    [],
  );

  // Keywords that came back empty or errored — surfaced so a 0-row
  // result doesn't look like a silent failure.
  const problems = result.results.filter(
    (r) => r.error || (r.http_status === 200 && r.urls.length === 0),
  );

  return (
    <div className="space-y-4">
      {/* Cost summary card — mirrors the Ahrefs probe summary above. */}
      <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
        <h3 className="text-lg font-semibold mb-2">Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          <Stat label="Keywords" value={result.totals.keywords_total} />
          <Stat
            label="OK"
            value={result.totals.keywords_ok}
            tone={
              result.totals.keywords_ok === result.totals.keywords_total
                ? "good"
                : "warn"
            }
          />
          <Stat label="URLs" value={result.totals.urls} />
          <Stat
            label="List price"
            value={`${result.totals.cost_list_price.toLocaleString()} u`}
          />
          <Stat
            label="Billed actual"
            value={`${result.totals.cost_billed_actual.toLocaleString()} u`}
            tone={
              result.totals.cost_billed_actual <
              result.totals.cost_list_price
                ? "good"
                : "neutral"
            }
          />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-3">
          Country: <code>{result.country}</code> · top positions:{" "}
          <code>{result.top_positions ?? "all"}</code>. Billed-actual{" "}
          {"<"} list price means Ahrefs's server-side cache hit on one or
          more keywords.
        </p>
      </div>

      <ResultsTable<SerpFlatRow>
        rows={flatRows}
        columns={columns}
        csvFilename="ahrefs-serp-overview.csv"
        emptyMessage="No ranking-page URLs returned."
      />

      {problems.length > 0 && (
        <div className="rounded-md border border-amber-300 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
          <p className="font-medium text-amber-800 dark:text-amber-300 mb-1">
            {problems.length} keyword{problems.length === 1 ? "" : "s"} with
            no URLs:
          </p>
          <ul className="space-y-0.5 text-xs text-amber-800/90 dark:text-amber-200/90">
            {problems.map((r) => (
              <li key={r.keyword}>
                <span className="font-medium">{r.keyword}</span>
                {" — "}
                {r.error
                  ? r.error
                  : r.positions_count === 0
                    ? `Ahrefs has no SERP snapshot for this keyword in “${result.country}” (still billed the ~50-unit floor)`
                    : "only SERP features — no ranking-page URLs in the top positions"}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mt-1.5">
            A keyword with no snapshot often has data in a different country
            — e.g. the same term may return results under <code>us</code>.
          </p>
        </div>
      )}
    </div>
  );
}
