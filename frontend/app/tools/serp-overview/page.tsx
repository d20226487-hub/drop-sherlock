"use client";

// Tool: SERP Overview (persistent).
//
// Rebuilt 2026-07-10 from the stateless probe into a persistent,
// resumable Job(kind='serp_overview') — same resilience contract as the
// Linked Domains Checker: survives restarts (auto-pause + resume), unit
// budget, live cost, and a runs history so past runs can be re-opened /
// downloaded. Backend:
//   POST   /api/analyze/serp-overview            → { job_id, run_id }
//   GET    /api/runs/{id}/status                 → progress poll
//   GET    /api/runs/{id}/cost                   → cost poll
//   POST   /api/runs/{id}/{pause,resume,cancel}  → run controls
//   GET    /api/runs/{id}/serp-overview.csv      → keyword,position,url export
//   GET    /api/analyze/serp-overview/runs       → recent-runs history

import { useCallback, useEffect, useState } from "react";

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

type SerpRunStatus = {
  id: number;
  status: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
};

type SerpCost = {
  ahrefs_units_billed: number;
  ahrefs_units_list: number;
  ahrefs_fresh_calls: number;
  ahrefs_cached_calls: number;
};

// One row of the recent-runs history table. Mirrors the backend
// /api/analyze/serp-overview/runs payload exactly.
type SerpRunHistoryItem = {
  job_id: number;
  run_id: number;
  name: string;
  status: string;
  created_at: string;
  keywords_total: number;
  keywords_done: number;
  keywords_failed: number;
  urls_total: number;
  units_billed: number;
};

const SERP_TERMINAL = ["done", "failed", "canceled", "paused"];

const HISTORY_PAGE_SIZE = 20;

// Render an ISO timestamp as a compact local date+time. Falls back to
// the raw string if it doesn't parse.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Copy text to the clipboard with a fallback for non-secure contexts
// (the LAN deploy is plain http, where navigator.clipboard is undefined).
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function SerpOverviewToolPage() {
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const [country, setCountry] = useState("kz");
  const [topPositions, setTopPositions] = useState("10");
  const [unitBudget, setUnitBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [status, setStatus] = useState<SerpRunStatus | null>(null);
  const [cost, setCost] = useState<SerpCost | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(false);
  const [skippedDuplicates, setSkippedDuplicates] = useState<string[]>([]);
  const [jobName, setJobName] = useState("");
  const [history, setHistory] = useState<SerpRunHistoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [renamingJobId, setRenamingJobId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  function parseKeywords(): string[] {
    return keywordsRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const keywords = parseKeywords();

  // Fetch the recent-runs history. Called on mount, after a successful
  // submit, and whenever the active run reaches a terminal state.
  const loadHistory = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(HISTORY_PAGE_SIZE),
      });
      if (search.trim()) params.set("q", search.trim());
      const res = await fetch(`/api/analyze/serp-overview/runs?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setHistory(Array.isArray(data.runs) ? data.runs : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
    } catch {
      return; // transient — history refreshes on the next trigger
    }
  }, [search, page]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Poll run status while a run is active; stop at a terminal state and
  // refresh history so the finished run's counts land in the table.
  useEffect(() => {
    if (runId == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let refreshedTerminal = false;
    async function poll() {
      try {
        const [sRes, cRes] = await Promise.all([
          fetch(`/api/runs/${runId}/status`),
          fetch(`/api/runs/${runId}/cost`),
        ]);
        if (cancelled) return;
        if (cRes.ok) setCost(await cRes.json());
        if (!sRes.ok) return;
        const data: SerpRunStatus = await sRes.json();
        setStatus(data);
        if (SERP_TERMINAL.includes(data.status)) {
          if (timer) clearInterval(timer);
          if (!refreshedTerminal) {
            refreshedTerminal = true;
            loadHistory();
          }
        }
      } catch {
        return; // transient — the next tick retries
      }
    }
    poll();
    timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, loadHistory]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (keywords.length === 0) {
      setError("Add at least one keyword");
      return;
    }
    if (keywords.length > 500) {
      setError(`Max 500 keywords per run (you have ${keywords.length})`);
      return;
    }
    const topNum = topPositions.trim() === "" ? null : Number(topPositions);
    if (topNum != null && (Number.isNaN(topNum) || topNum < 1 || topNum > 100)) {
      setError("Top positions must be between 1 and 100");
      return;
    }
    const budgetNum = unitBudget.trim() === "" ? null : Number(unitBudget);
    if (budgetNum != null && (Number.isNaN(budgetNum) || budgetNum < 1)) {
      setError("Unit budget must be a positive number");
      return;
    }
    setBusy(true);
    setStatus(null);
    setCost(null);
    setSkippedDuplicates([]);
    setRunId(null);
    try {
      const res = await fetch("/api/analyze/serp-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords,
          country,
          top_positions: topNum,
          unit_budget: budgetNum,
          recheck_keywords: recheck,
          name: jobName.trim() || null,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        let code = "";
        let count = 0;
        let windowDays = 0;
        try {
          const j = JSON.parse(t);
          code = j?.detail?.code ?? "";
          count = j?.detail?.count ?? 0;
          windowDays = j?.detail?.window_days ?? 0;
        } catch {
          code = "";
        }
        if (code === "all_duplicates") {
          throw new Error(
            `All ${count} keyword(s) were already checked with the same ` +
              `country & result count within the last ${windowDays} days — ` +
              `tick "Recheck keywords" to force a re-check.`,
          );
        }
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      setSkippedDuplicates(data.skipped_duplicates || []);
      setRunId(data.run_id);
      loadHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (runId == null) return;
    try {
      await fetch(`/api/runs/${runId}/${action}`, { method: "POST" });
      const res = await fetch(`/api/runs/${runId}/status`);
      if (res.ok) setStatus(await res.json());
    } catch {
      return; // the poll loop reconciles
    }
  }

  // View a past run: point the active runId at it so the polling effect
  // (keyed on runId) loads and polls it.
  function viewRun(id: number) {
    setError(null);
    setStatus(null);
    setCost(null);
    setCopied(null);
    setRunId(id);
  }

  // Copy the GLOBAL unique ranking-domain set (every run ever, deduped).
  async function copyAllDomains() {
    try {
      const res = await fetch("/api/analyze/serp-overview/domains.csv");
      if (!res.ok) {
        setCopiedAll("Copy failed");
      } else {
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean);
        const ok = await copyText(domains.join("\n"));
        setCopiedAll(
          ok ? `Copied ${domains.length.toLocaleString()} ✓` : "Copy failed",
        );
      }
    } catch {
      setCopiedAll("Copy failed");
    }
    setTimeout(() => setCopiedAll(null), 2500);
  }

  // Copy the run's unique ranking domains (newline-joined) — fetches the
  // domains CSV and strips the header, so clipboard = paste-ready list.
  async function copyDomains() {
    if (runId == null) return;
    try {
      const res = await fetch(`/api/runs/${runId}/serp-overview-domains.csv`);
      if (!res.ok) {
        setCopied("Copy failed");
      } else {
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean);
        const ok = await copyText(domains.join("\n"));
        setCopied(
          ok ? `Copied ${domains.length} domains ✓` : "Copy failed",
        );
      }
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  // Resume a paused run straight from the history table, then refresh
  // history and open it in the status panel.
  async function resumeRun(id: number) {
    try {
      await fetch(`/api/runs/${id}/resume`, { method: "POST" });
    } catch {
      // fall through — viewRun's poll loop reconciles the real state
    }
    viewRun(id);
    loadHistory();
  }

  // Inline job rename from the history table (PATCH /jobs/{id}).
  function startRename(h: SerpRunHistoryItem) {
    setRenamingJobId(h.job_id);
    setRenameValue(h.name || "");
  }

  async function saveRename() {
    if (renamingJobId == null) return;
    const name = renameValue.trim();
    if (!name) return;
    setRenameBusy(true);
    try {
      const res = await fetch(`/api/jobs/${renamingJobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setRenamingJobId(null);
        loadHistory();
      }
    } catch {
      // stay in edit mode — the user can retry or cancel
    } finally {
      setRenameBusy(false);
    }
  }

  const isActive = status != null && !SERP_TERMINAL.includes(status.status);
  const isTerminal = status != null && SERP_TERMINAL.includes(status.status);
  const processed = status ? status.done + status.failed : 0;
  const pct =
    status && status.total > 0
      ? Math.round((processed / status.total) * 100)
      : 0;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tool · SERP Overview</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Bulk <code>/serp-overview</code> across a batch of{" "}
          <strong>keywords</strong>: the ranking-page <strong>URLs</strong>{" "}
          per keyword for the chosen country, limited to the top organic
          positions. Runs as a <strong>persistent, resumable job</strong> —
          survives restarts, and past runs stay downloadable below. Only the{" "}
          <code>url</code> column is fetched to keep spend at the{" "}
          <strong>~50 units/keyword</strong> floor. Keywords already checked
          with the <strong>same country &amp; result count</strong> are
          skipped by default for the window set in Settings → SERP Overview
          (30 days out of the box). Tip: keyword <code>ahrefs</code> or{" "}
          <code>wordcount</code> probes for free.
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
              Top positions (1-100)
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={topPositions}
              onChange={(e) => setTopPositions(e.target.value)}
              placeholder="10"
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Unit budget (optional)
            </span>
            <input
              type="number"
              min={1}
              value={unitBudget}
              onChange={(e) => setUnitBudget(e.target.value)}
              placeholder="auto-pause above N units"
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
        </div>

        <label className="block sm:max-w-xs">
          <span className="text-sm font-medium block mb-1">
            Job name (optional)
          </span>
          <input
            type="text"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            placeholder="auto-named from first keyword"
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
            disabled={busy}
          />
        </label>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={recheck}
            onChange={(e) => setRecheck(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span className="text-sm font-medium">
            Recheck keywords
            <span className="block text-xs font-normal text-neutral-500 dark:text-neutral-400">
              check again even if a keyword was already checked with the same
              country &amp; result count within the ignore window
            </span>
          </span>
        </label>

        <button
          type="submit"
          disabled={busy || keywords.length === 0}
          className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Run SERP overview"}
        </button>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>

      {skippedDuplicates.length > 0 && (
        <p className="text-xs text-sky-700 dark:text-sky-300">
          Skipped {skippedDuplicates.length} previously-checked keyword
          {skippedDuplicates.length === 1 ? "" : "s"} (same country &amp;
          result count, within the ignore window):{" "}
          {skippedDuplicates.slice(0, 5).join(", ")}
          {skippedDuplicates.length > 5 ? "…" : ""}
        </p>
      )}

      {status && (
        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-medium">
              Run #{status.id} ·{" "}
              <span className="uppercase tracking-wide">{status.status}</span>
            </div>
            <div className="flex gap-2">
              {isActive && status.status === "running" && (
                <button
                  type="button"
                  onClick={() => control("pause")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  Pause
                </button>
              )}
              {status.status === "paused" && (
                <button
                  type="button"
                  onClick={() => control("resume")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  Resume
                </button>
              )}
              {isActive && (
                <button
                  type="button"
                  onClick={() => control("cancel")}
                  className="rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="h-2 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
            <div
              className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {processed}/{status.total} keywords · {status.done} done ·{" "}
            {status.failed} failed · {status.running} running ·{" "}
            {status.pending} pending
          </div>

          {cost && (
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              Ahrefs units:{" "}
              <strong className="text-neutral-700 dark:text-neutral-200">
                {cost.ahrefs_units_billed.toLocaleString()}
              </strong>{" "}
              billed
              {cost.ahrefs_units_list !== cost.ahrefs_units_billed && (
                <> · {cost.ahrefs_units_list.toLocaleString()} list price</>
              )}{" "}
              · {cost.ahrefs_fresh_calls} API call
              {cost.ahrefs_fresh_calls === 1 ? "" : "s"}
            </div>
          )}

          {isTerminal && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/runs/${status.id}/serp-overview.csv`}
                className="inline-block rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium"
              >
                Download CSV (keyword · position · URL)
              </a>
              <a
                href={`/api/runs/${status.id}/serp-overview-domains.csv`}
                className="inline-block rounded border dark:border-neutral-700 px-4 py-2 text-sm font-medium"
              >
                Download unique domains CSV
              </a>
              <button
                type="button"
                onClick={copyDomains}
                className="rounded border dark:border-neutral-700 px-4 py-2 text-sm font-medium"
              >
                {copied ?? "Copy unique domains"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Recent runs — persistent history so past runs can be re-opened
          and downloaded even after a page reload. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">Recent runs</h2>
          {/* Global export — every run ever, deduped across runs. */}
          <div className="flex items-center gap-2">
            <a
              href="/api/analyze/serp-overview/domains.csv"
              className="rounded border dark:border-neutral-700 px-3 py-1.5 text-xs font-medium"
            >
              Download all unique domains (all runs)
            </a>
            <button
              type="button"
              onClick={copyAllDomains}
              className="rounded border dark:border-neutral-700 px-3 py-1.5 text-xs font-medium"
            >
              {copiedAll ?? "Copy all"}
            </button>
          </div>
        </div>

        {/* Search by job name + pagination */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by job name…"
            className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-xs w-56"
          />
          <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              {total} run{total === 1 ? "" : "s"} · page {page}/
              {Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))}
            </span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border dark:border-neutral-700 px-2 py-1 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= Math.ceil(total / HISTORY_PAGE_SIZE)}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border dark:border-neutral-700 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>

        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-x-auto">
          {history.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 py-6">
              {search.trim() ? "No matching runs." : "No runs yet."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-neutral-500 dark:text-neutral-400 border-b dark:border-neutral-800">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Date</th>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Keywords</th>
                  <th className="text-right font-medium px-3 py-2">URLs</th>
                  <th className="text-right font-medium px-3 py-2">
                    Ahrefs units
                  </th>
                  <th className="text-right font-medium px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr
                    key={h.run_id}
                    className={
                      "border-t border-neutral-100 dark:border-neutral-800/60 " +
                      (h.run_id === runId
                        ? "bg-blue-50/60 dark:bg-blue-950/20"
                        : "")
                    }
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-600 dark:text-neutral-300">
                      {fmtDate(h.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      {renamingJobId === h.job_id ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveRename();
                              }
                              if (e.key === "Escape") setRenamingJobId(null);
                            }}
                            disabled={renameBusy}
                            className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs w-44"
                          />
                          <button
                            type="button"
                            onClick={saveRename}
                            disabled={renameBusy || !renameValue.trim()}
                            className="text-xs text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingJobId(null)}
                            className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        h.name || `Run #${h.run_id}`
                      )}
                    </td>
                    <td className="px-3 py-2 uppercase tracking-wide text-xs">
                      {h.status}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {h.keywords_done}/{h.keywords_total}
                      {h.keywords_failed > 0 && (
                        <span className="text-rose-600 dark:text-rose-400">
                          {" "}
                          · {h.keywords_failed} failed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.urls_total.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.units_billed.toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => viewRun(h.run_id)}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(h)}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Rename
                        </button>
                        <a
                          href={`/api/runs/${h.run_id}/serp-overview.csv`}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Download CSV
                        </a>
                        <a
                          href={`/api/runs/${h.run_id}/serp-overview-domains.csv`}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Domains CSV
                        </a>
                        {h.status === "paused" && (
                          <button
                            type="button"
                            onClick={() => resumeRun(h.run_id)}
                            className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            Resume
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
