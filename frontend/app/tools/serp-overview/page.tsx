"use client";

// Tool: bulk Ahrefs SERP Overview probe.
//
// Mirrors Ahrefs's SERP Overview API (/serp-overview). Input is a batch
// of KEYWORDS; for each one we fetch the ranking-page URLs in the chosen
// country, limited to the top N organic positions. To minimise Ahrefs
// unit spend the backend SELECTs only `url` (the cheapest column set), so
// the result table is deliberately just Keyword + URL.
//
// Stateless probe — no Job/Run/CR pipeline, no persistence; close the tab
// and results are gone. POSTs to /api/tools/ahrefs-serp-overview.
//
// Split out 2026-07-02 from /tools/ahrefs-batch-analysis into its own tool
// page.

import { useMemo, useState } from "react";

import { ResultsTable, type ResultsColumn } from "@/components/results-table";

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

export default function SerpOverviewToolPage() {
  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tool · SERP Overview</h1>
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

      <SerpOverviewSection />
    </main>
  );
}

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
    <section className="space-y-4">
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

// Copied from /tools/ahrefs-batch-analysis (the batch page keeps its own
// copy for its Summary card). Small stat cell used in the summary grid.
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
