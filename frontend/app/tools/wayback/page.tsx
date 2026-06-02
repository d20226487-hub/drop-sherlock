"use client";

// Tool: bulk Wayback total-snapshot-count probe.
//
// One submit creates a persistent batch job (Postgres-like contract
// on top of SQLite — see WaybackSparklineJob / WaybackSparklineResult)
// that the runner drains in the background, ~0.5s/domain at the
// default concurrency=8. UI polls the job's status endpoint until the
// queue empties; results land in a server-paginated table that the
// operator can search, copy, and export.
//
// Difference from /tools/keywords-history: 100k-row target scale means
// the request can't return synchronously. Job survives tab close +
// page reload. State is hydrated from `?job=N` (router-driven so
// share-links work).

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { ResultsTable, type ResultsColumn } from "@/components/results-table";

type JobStatus = {
  id: number;
  name: string;
  notes: string;
  status: "pending" | "running" | "paused" | "done" | "failed" | "canceled";
  error: string;
  submitted_count: number;
  concurrency: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  counts: {
    pending: number;
    fetching: number;
    ok: number;
    error: number;
  };
};

type ResultRow = {
  id: number;
  domain: string;
  status: "pending" | "fetching" | "ok" | "error";
  snapshot_count: number | null;
  first_year: number | null;
  last_year: number | null;
  years_with_data: number | null;
  error_msg: string;
  elapsed_ms: number | null;
  fetched_at: string | null;
};

type ResultsPage = {
  rows: ResultRow[];
  total: number;
  page: number;
  page_size: number;
};

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000];
const DEFAULT_PAGE_SIZE = 100;
const TERMINAL_STATUSES = new Set(["done", "failed", "canceled"]);
const POLL_INTERVAL_MS = 2000;
// How long the bulk "Download CSV all" walk pauses between page
// fetches. Throttling here is mostly courtesy to the SQLite reader —
// at 1000-row pages a 100k batch is 100 sequential roundtrips.
const BULK_PAGE_DELAY_MS = 50;

export default function WaybackToolPage() {
  return (
    <Suspense fallback={null}>
      <WaybackToolPageInner />
    </Suspense>
  );
}

function WaybackToolPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobIdFromUrl = (() => {
    const v = searchParams?.get("job");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [domainsRaw, setDomainsRaw] = useState("");
  const [name, setName] = useState("");
  // Default 1 after extended live calibration (Job 2, 2026-05-23):
  // 8 → immediate 429s; 3 → sustained 429s after IP-throttle armed.
  // The sparkline endpoint tolerates one request per second from a
  // single IP comfortably; bumping concurrency only helps when the
  // batch is large enough to amortize the global cooldown gate (5
  // min stalls after any 429). Stick to 1 unless you've verified
  // your IP is fresh.
  const [concurrency, setConcurrency] = useState(1);

  const [activeJobId, setActiveJobId] = useState<number | null>(jobIdFromUrl);
  const [job, setJob] = useState<JobStatus | null>(null);

  // Server-paginated results table state.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | ResultRow["status"]>("");
  const [sort, setSort] = useState<
    | "domain_asc"
    | "domain_desc"
    | "count_asc"
    | "count_desc"
    | "first_asc"
    | "first_desc"
    | "last_asc"
    | "last_desc"
  >("count_desc");
  const [results, setResults] = useState<ResultsPage | null>(null);
  const [bulkExporting, setBulkExporting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Debounce the free-text search box so each keystroke doesn't fire
  // a roundtrip against a 100k-row job.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(id);
  }, [search]);

  // URL → state sync. When the user navigates back, restore active
  // job id.
  useEffect(() => {
    setActiveJobId(jobIdFromUrl);
  }, [jobIdFromUrl]);

  // Job status polling. Stops when the job hits a terminal state to
  // avoid hammering the API after the work is done.
  useEffect(() => {
    if (activeJobId === null) {
      setJob(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    async function pollOnce() {
      try {
        const r = await fetch(`/api/tools/wayback-sparkline/${activeJobId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as JobStatus;
        if (cancelled) return;
        setJob(data);
        if (TERMINAL_STATUSES.has(data.status)) return;
        timer = window.setTimeout(pollOnce, POLL_INTERVAL_MS);
      } catch {
        // Network glitch — retry after the same interval.
        if (cancelled) return;
        timer = window.setTimeout(pollOnce, POLL_INTERVAL_MS);
      }
    }
    pollOnce();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeJobId]);

  // Results-table polling. While the job is running, refresh the
  // visible page every poll tick so the progress is live. When
  // terminal, refresh on user interaction (page/sort/filter change).
  useEffect(() => {
    if (activeJobId === null) {
      setResults(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    async function loadOnce() {
      try {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(pageSize),
          sort,
        });
        if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
        if (statusFilter) params.set("status", statusFilter);
        const r = await fetch(
          `/api/tools/wayback-sparkline/${activeJobId}/results?${params.toString()}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as ResultsPage;
        if (cancelled) return;
        setResults(data);
      } catch {
        // Silently retry.
      }
      // Schedule next poll only while running. Terminal-state job
      // means results are stable — no need to refresh until the user
      // changes a control.
      if (job && !TERMINAL_STATUSES.has(job.status) && !cancelled) {
        timer = window.setTimeout(loadOnce, POLL_INTERVAL_MS);
      }
    }
    loadOnce();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeJobId, page, pageSize, debouncedSearch, statusFilter, sort, job?.status]);

  const parseDomains = useCallback((): string[] => {
    return domainsRaw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }, [domainsRaw]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const domains = parseDomains();
    if (domains.length === 0) {
      setSubmitError("Add at least one domain");
      return;
    }
    if (domains.length > 100_000) {
      setSubmitError(
        `Max 100,000 domains per submit (you have ${domains.length.toLocaleString()}). Split into multiple batches.`,
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tools/wayback-sparkline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains,
          name: name.trim() || undefined,
          concurrency,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = (await res.json()) as { job_id: number };
      // Navigate to the new job, clears the submit form.
      router.replace(`/tools/wayback?job=${data.job_id}`);
      setActiveJobId(data.job_id);
      setDomainsRaw("");
      setName("");
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function action(kind: "pause" | "resume" | "cancel" | "delete") {
    if (activeJobId === null) return;
    try {
      if (kind === "delete") {
        if (
          !window.confirm(
            "Delete this batch and all results? This cannot be undone.",
          )
        ) {
          return;
        }
        await fetch(`/api/tools/wayback-sparkline/${activeJobId}`, {
          method: "DELETE",
        });
        router.replace("/tools/wayback");
        setActiveJobId(null);
        setJob(null);
        setResults(null);
      } else {
        const res = await fetch(
          `/api/tools/wayback-sparkline/${activeJobId}/${kind}`,
          { method: "POST" },
        );
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
        }
      }
    } catch (e) {
      setSubmitError((e as Error).message);
    }
  }

  // Bulk "Download CSV (all)" walk — sequentially fetches every page
  // with current search/filter applied, then concatenates the rows
  // into one CSV download. For 100k rows × 1000 page-size that's 100
  // roundtrips, ~2-3s wall time.
  async function bulkExportAll() {
    if (activeJobId === null || results === null) return;
    setBulkExporting(true);
    setBulkProgress({ done: 0, total: results.total });
    try {
      const all: ResultRow[] = [];
      const total = results.total;
      const size = 1000;
      const pages = Math.max(1, Math.ceil(total / size));
      for (let p = 1; p <= pages; p++) {
        const params = new URLSearchParams({
          page: String(p),
          page_size: String(size),
          sort,
        });
        if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
        if (statusFilter) params.set("status", statusFilter);
        const r = await fetch(
          `/api/tools/wayback-sparkline/${activeJobId}/results?${params.toString()}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status} on page ${p}`);
        const data = (await r.json()) as ResultsPage;
        all.push(...data.rows);
        setBulkProgress({ done: all.length, total });
        if (p < pages) {
          await new Promise((res) => setTimeout(res, BULK_PAGE_DELAY_MS));
        }
      }
      // Build CSV identical to the in-component formatter so the
      // bulk and per-page exports stay consistent.
      const header = [
        "domain",
        "status",
        "snapshot_count",
        "first_year",
        "last_year",
        "years_with_data",
        "elapsed_ms",
        "error_msg",
        "fetched_at",
      ];
      const lines: string[] = [header.join(",")];
      for (const row of all) {
        lines.push(
          [
            csvEsc(row.domain),
            csvEsc(row.status),
            row.snapshot_count ?? "",
            row.first_year ?? "",
            row.last_year ?? "",
            row.years_with_data ?? "",
            row.elapsed_ms ?? "",
            csvEsc(row.error_msg),
            row.fetched_at ?? "",
          ].join(","),
        );
      }
      const blob = new Blob([lines.join("\r\n") + "\r\n"], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wayback-sparkline-job-${activeJobId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setBulkExporting(false);
      setBulkProgress(null);
    }
  }

  const columns: ResultsColumn<ResultRow>[] = [
    {
      key: "domain",
      label: "Domain",
      className: "font-mono text-xs",
      render: (r) => r.domain,
      toExport: (r) => r.domain,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      toExport: (r) => r.status,
    },
    {
      key: "snapshot_count",
      label: "Captures",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      render: (r) =>
        r.snapshot_count != null ? r.snapshot_count.toLocaleString() : "—",
      toExport: (r) => (r.snapshot_count != null ? String(r.snapshot_count) : ""),
    },
    {
      key: "first_year",
      label: "First",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      render: (r) => r.first_year ?? "—",
      toExport: (r) => (r.first_year != null ? String(r.first_year) : ""),
    },
    {
      key: "last_year",
      label: "Last",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      render: (r) => r.last_year ?? "—",
      toExport: (r) => (r.last_year != null ? String(r.last_year) : ""),
    },
    {
      key: "years_with_data",
      label: "Years",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      render: (r) => r.years_with_data ?? "—",
      toExport: (r) => (r.years_with_data != null ? String(r.years_with_data) : ""),
    },
    {
      key: "elapsed_ms",
      label: "ms",
      className: "text-right tabular-nums text-xs text-neutral-500",
      headerClassName: "text-right",
      render: (r) => (r.elapsed_ms != null ? r.elapsed_ms : "—"),
      toExport: (r) => (r.elapsed_ms != null ? String(r.elapsed_ms) : ""),
    },
    {
      key: "error",
      label: "Error",
      className: "text-xs text-rose-700 dark:text-rose-400 max-w-[20rem] truncate",
      render: (r) => (r.error_msg ? <span title={r.error_msg}>{r.error_msg}</span> : ""),
      toExport: (r) => r.error_msg,
    },
  ];

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tool · Wayback total captures</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Bulk total-snapshot-count probe via archive.org&apos;s sparkline
          endpoint (~0.5s/domain at concurrency=8). Persistent — close
          the tab and come back; the batch keeps running. Max 100k
          domains per submit.
        </p>
      </header>

      {/* Submit form */}
      <form
        onSubmit={submit}
        className="space-y-3 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4"
      >
        <label className="block">
          <span className="text-sm font-medium block mb-1">
            Domains (one per line, comma, or whitespace separated · max
            100,000)
          </span>
          <textarea
            value={domainsRaw}
            onChange={(e) => setDomainsRaw(e.target.value)}
            rows={6}
            placeholder={"example.com\nkotopes.kz\ngithub.com"}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono outline-none"
            disabled={submitting}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            Parsed: {parseDomains().length.toLocaleString()} domain
            {parseDomains().length === 1 ? "" : "s"}
          </span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium block mb-1">Batch name (optional)</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. namecheap dropping list 2026-06"
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm"
              disabled={submitting}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Concurrency (1–16)
            </span>
            <input
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) =>
                setConcurrency(
                  Math.max(1, Math.min(16, parseInt(e.target.value || "3", 10))),
                )
              }
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm"
              disabled={submitting}
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
              Default 1 is the calibrated-safe value. archive.org
              throttles aggressively at higher numbers and once
              tripped the IP stays throttled for several minutes
              (cooldown gate auto-handles this but it stalls the
              batch). Bump only if the IP is fresh + batch is small.
            </span>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || parseDomains().length === 0}
            className="px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {submitting ? "Submitting…" : "Start batch"}
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            ~{Math.round((parseDomains().length * 0.6) / Math.max(1, concurrency))}s
            estimated runtime at 0.6s/domain
          </span>
        </div>
        {submitError && (
          <div className="rounded-md border border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-800 dark:text-rose-300">
            {submitError}
          </div>
        )}
      </form>

      {/* Active job summary + controls */}
      {job && (
        <section className="space-y-3">
          <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  {job.name || `Batch #${job.id}`}{" "}
                  <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400 ml-2">
                    #{job.id}
                  </span>
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Status: <strong>{job.status}</strong>
                  {" · "}
                  {job.submitted_count.toLocaleString()} domains{" · "}
                  concurrency {job.concurrency}
                  {job.error ? ` · ${job.error}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {(job.status === "pending" || job.status === "running") && (
                  <button
                    type="button"
                    onClick={() => action("pause")}
                    className="text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    Pause
                  </button>
                )}
                {job.status === "paused" && (
                  <button
                    type="button"
                    onClick={() => action("resume")}
                    className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Resume
                  </button>
                )}
                {!TERMINAL_STATUSES.has(job.status) && (
                  <button
                    type="button"
                    onClick={() => action("cancel")}
                    className="text-xs px-3 py-1.5 rounded-md border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950 text-amber-800 dark:text-amber-300"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => action("delete")}
                  className="text-xs px-3 py-1.5 rounded-md border border-rose-300 dark:border-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950 text-rose-800 dark:text-rose-300"
                >
                  Delete
                </button>
              </div>
            </div>
            {/* Progress bar */}
            <div className="mt-3">
              <ProgressBar counts={job.counts} total={job.submitted_count} />
              <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {job.counts.ok.toLocaleString()} ok ·{" "}
                {job.counts.error.toLocaleString()} errors ·{" "}
                {job.counts.fetching.toLocaleString()} fetching ·{" "}
                {job.counts.pending.toLocaleString()} pending
              </div>
            </div>
          </div>

          {/* Results table */}
          {results && (
            <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="text-sm font-semibold">Results</h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={bulkExportAll}
                    disabled={bulkExporting || results.total === 0}
                    className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                    title="Walk every page of the current filter and bundle into one CSV"
                  >
                    {bulkExporting
                      ? bulkProgress
                        ? `Downloading ${bulkProgress.done.toLocaleString()}/${bulkProgress.total.toLocaleString()}`
                        : "Downloading…"
                      : `Download CSV (all ${results.total.toLocaleString()})`}
                  </button>
                </div>
              </div>

              <ResultsTable<ResultRow>
                rows={results.rows}
                columns={columns}
                csvFilename={`wayback-sparkline-job-${job.id}-page${results.page}.csv`}
                serverPagination={{
                  page: results.page,
                  pageSize: results.page_size,
                  total: results.total,
                  onPageChange: setPage,
                  onPageSizeChange: setPageSize,
                  search,
                  onSearchChange: setSearch,
                  pageSizeOptions: PAGE_SIZE_OPTIONS,
                }}
                toolbarExtras={
                  <>
                    <select
                      value={statusFilter}
                      onChange={(e) => {
                        setStatusFilter(
                          e.target.value as "" | ResultRow["status"],
                        );
                        setPage(1);
                      }}
                      className="text-sm rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5"
                      title="Status filter"
                    >
                      <option value="">All statuses</option>
                      <option value="pending">pending</option>
                      <option value="fetching">fetching</option>
                      <option value="ok">ok</option>
                      <option value="error">error</option>
                    </select>
                    <select
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value as typeof sort);
                        setPage(1);
                      }}
                      className="text-sm rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5"
                      title="Sort"
                    >
                      <option value="count_desc">Captures ↓</option>
                      <option value="count_asc">Captures ↑</option>
                      <option value="domain_asc">Domain A→Z</option>
                      <option value="domain_desc">Domain Z→A</option>
                      <option value="first_asc">First year ↑</option>
                      <option value="first_desc">First year ↓</option>
                      <option value="last_asc">Last year ↑</option>
                      <option value="last_desc">Last year ↓</option>
                    </select>
                  </>
                }
                emptyMessage={
                  job.status === "pending" || job.status === "running"
                    ? "Waiting for results…"
                    : "No rows match the current filter."
                }
              />
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ProgressBar({
  counts,
  total,
}: {
  counts: { pending: number; fetching: number; ok: number; error: number };
  total: number;
}) {
  const safeTotal = Math.max(1, total);
  const okPct = (counts.ok / safeTotal) * 100;
  const errPct = (counts.error / safeTotal) * 100;
  const fetchPct = (counts.fetching / safeTotal) * 100;
  return (
    <div className="h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden flex">
      <div
        className="bg-emerald-500 transition-all"
        style={{ width: `${okPct}%` }}
        title={`${counts.ok.toLocaleString()} ok`}
      />
      <div
        className="bg-rose-500 transition-all"
        style={{ width: `${errPct}%` }}
        title={`${counts.error.toLocaleString()} errors`}
      />
      <div
        className="bg-blue-400 dark:bg-blue-500 transition-all animate-pulse"
        style={{ width: `${fetchPct}%` }}
        title={`${counts.fetching.toLocaleString()} fetching`}
      />
    </div>
  );
}

function StatusPill({ status }: { status: ResultRow["status"] }) {
  const tone =
    status === "ok"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : status === "error"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
        : status === "fetching"
          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
          : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${tone}`}>{status}</span>
  );
}

function csvEsc(s: string | null | undefined): string {
  if (s == null) return "";
  const needsQuote = /[",\r\n]|^\s|\s$/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
