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

import { COUNTRIES } from "@/lib/countries";
import { useT } from "@/lib/i18n";

// One created run per selected country — the submit response shape.
type CreatedRun = {
  country: string;
  job_id: number;
  run_id: number;
  skipped_duplicates: string[];
};

type SkippedCountry = { country: string; count: number };

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
  const { t } = useT();
  const ts = t.pages.serpOverview;
  const tsh = t.pages.toolsShared;
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const [selectedCountries, setSelectedCountries] = useState<string[]>([
    "kz",
  ]);
  const [countrySearch, setCountrySearch] = useState("");
  const [topPositions, setTopPositions] = useState("10");
  const [unitBudget, setUnitBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [status, setStatus] = useState<SerpRunStatus | null>(null);
  const [cost, setCost] = useState<SerpCost | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState<string | null>(null);
  // Applies the Settings allowed-TLDs list to the domain exports/copy
  // (read-time filter — stored data stays complete, untick for raw).
  const [tldFiltered, setTldFiltered] = useState(true);
  const [recheck, setRecheck] = useState(false);
  const [dupNotices, setDupNotices] = useState<string[]>([]);
  const [multiNotice, setMultiNotice] = useState<string | null>(null);
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

  function toggleCountry(code: string) {
    setSelectedCountries((prev) =>
      prev.includes(code)
        ? prev.filter((c) => c !== code)
        : [...prev, code],
    );
  }

  const countryFilter = countrySearch.trim().toLowerCase();
  const filteredCountries = countryFilter
    ? COUNTRIES.filter((c) => c.label.toLowerCase().includes(countryFilter))
    : COUNTRIES;

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
      setError(ts.errAddKeyword);
      return;
    }
    if (keywords.length > 500) {
      setError(ts.errMaxKeywords(keywords.length));
      return;
    }
    const topNum = topPositions.trim() === "" ? null : Number(topPositions);
    if (topNum != null && (Number.isNaN(topNum) || topNum < 1 || topNum > 100)) {
      setError(ts.errTopPositions);
      return;
    }
    const budgetNum = unitBudget.trim() === "" ? null : Number(unitBudget);
    if (budgetNum != null && (Number.isNaN(budgetNum) || budgetNum < 1)) {
      setError(ts.errUnitBudget);
      return;
    }
    if (selectedCountries.length === 0) {
      setError(ts.errSelectCountry);
      return;
    }
    if (selectedCountries.length > 30) {
      setError(ts.errMaxCountries(selectedCountries.length));
      return;
    }
    setBusy(true);
    setStatus(null);
    setCost(null);
    setDupNotices([]);
    setMultiNotice(null);
    setRunId(null);
    try {
      const res = await fetch("/api/analyze/serp-overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords,
          countries: selectedCountries,
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
          throw new Error(ts.errAllDuplicates(windowDays, count));
        }
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const runs: CreatedRun[] = Array.isArray(data.runs) ? data.runs : [];
      const skippedCountries: SkippedCountry[] = Array.isArray(
        data.skipped_countries,
      )
        ? data.skipped_countries
        : [];
      const notices: string[] = [];
      for (const r of runs) {
        if (r.skipped_duplicates?.length) {
          notices.push(
            ts.dupNoticeCountry(
              r.country,
              r.skipped_duplicates.length,
              r.skipped_duplicates.slice(0, 5).join(", "),
              r.skipped_duplicates.length > 5 ? "…" : "",
            ),
          );
        }
      }
      for (const s of skippedCountries) {
        notices.push(ts.dupNoticeSkippedCountry(s.country, s.count));
      }
      setDupNotices(notices);
      if (runs.length > 1) {
        setMultiNotice(
          ts.multiNotice(
            runs.length,
            runs.map((r) => r.country).join(", "),
            runs[0].country,
          ),
        );
      }
      if (runs.length > 0) setRunId(runs[0].run_id);
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
      const res = await fetch(
        `/api/analyze/serp-overview/domains.csv${
          tldFiltered ? "?tlds=allowed" : ""
        }`,
      );
      if (!res.ok) {
        setCopiedAll(tsh.copyFailed);
      } else {
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean);
        const ok = await copyText(domains.join("\n"));
        setCopiedAll(
          ok ? tsh.copyAllDone(domains.length.toLocaleString()) : tsh.copyFailed,
        );
      }
    } catch {
      setCopiedAll(tsh.copyFailed);
    }
    setTimeout(() => setCopiedAll(null), 2500);
  }

  // Copy the run's unique ranking domains (newline-joined) — fetches the
  // domains CSV and strips the header, so clipboard = paste-ready list.
  async function copyDomains() {
    if (runId == null) return;
    try {
      const res = await fetch(
        `/api/runs/${runId}/serp-overview-domains.csv${
          tldFiltered ? "?tlds=allowed" : ""
        }`,
      );
      if (!res.ok) {
        setCopied(tsh.copyFailed);
      } else {
        const text = await res.text();
        const domains = text
          .split(/\r?\n/)
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean);
        const ok = await copyText(domains.join("\n"));
        setCopied(ok ? ts.copyUniqueDomainsDone(domains.length) : tsh.copyFailed);
      }
    } catch {
      setCopied(tsh.copyFailed);
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
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.description}
        </p>
      </header>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4"
      >
        <label className="block">
          <span className="text-sm font-medium block mb-1">
            {ts.keywordsLabel}
          </span>
          <textarea
            value={keywordsRaw}
            onChange={(e) => setKeywordsRaw(e.target.value)}
            rows={6}
            placeholder={ts.keywordsPlaceholder}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm outline-none"
            disabled={busy}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            {ts.parsedCount(keywords.length)}
          </span>
        </label>

        <div className="space-y-1">
          <span className="text-sm font-medium block">
            {ts.countriesLabel(selectedCountries.length)}
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block">
            {ts.countriesHint}
          </span>
          <input
            type="text"
            value={countrySearch}
            onChange={(e) => setCountrySearch(e.target.value)}
            placeholder={ts.countrySearchPlaceholder}
            className="w-full sm:max-w-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
            disabled={busy}
          />
          <div className="max-h-44 overflow-y-auto rounded border dark:border-neutral-700 divide-y divide-neutral-100 dark:divide-neutral-800/60">
            {filteredCountries.map((c) => (
              <label
                key={c.code}
                className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <input
                  type="checkbox"
                  checked={selectedCountries.includes(c.code)}
                  onChange={() => toggleCountry(c.code)}
                  disabled={busy}
                />
                <span>{c.label}</span>
              </label>
            ))}
            {filteredCountries.length === 0 && (
              <p className="px-2 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {ts.noCountryMatches}
              </p>
            )}
          </div>
          {selectedCountries.length > 0 && (
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.selectedPrefix} {selectedCountries.join(", ")}{" "}
              <button
                type="button"
                onClick={() => setSelectedCountries([])}
                disabled={busy}
                className="text-blue-700 dark:text-blue-400 hover:underline"
              >
                {ts.clearCountries}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              {ts.topPositionsLabel}
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={topPositions}
              onChange={(e) => setTopPositions(e.target.value)}
              placeholder={ts.topPositionsPlaceholder}
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              {ts.unitBudgetLabel}
            </span>
            <input
              type="number"
              min={1}
              value={unitBudget}
              onChange={(e) => setUnitBudget(e.target.value)}
              placeholder={ts.unitBudgetPlaceholder}
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
        </div>

        <label className="block sm:max-w-xs">
          <span className="text-sm font-medium block mb-1">
            {ts.jobNameLabel}
          </span>
          <input
            type="text"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            placeholder={ts.jobNamePlaceholder}
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
            {ts.recheckLabel}
            <span className="block text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {ts.recheckHint}
            </span>
          </span>
        </label>

        <button
          type="submit"
          disabled={busy || keywords.length === 0}
          className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? ts.submitting : ts.submit}
        </button>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>

      {multiNotice && (
        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          {multiNotice}
        </p>
      )}

      {dupNotices.length > 0 && (
        <div className="space-y-0.5">
          {dupNotices.map((n, i) => (
            <p key={i} className="text-xs text-sky-700 dark:text-sky-300">
              {n}
            </p>
          ))}
        </div>
      )}

      {status && (
        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-medium">
              {tsh.runNo(status.id)} ·{" "}
              <span className="uppercase tracking-wide">{status.status}</span>
            </div>
            <div className="flex gap-2">
              {isActive && status.status === "running" && (
                <button
                  type="button"
                  onClick={() => control("pause")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  {tsh.pause}
                </button>
              )}
              {status.status === "paused" && (
                <button
                  type="button"
                  onClick={() => control("resume")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  {tsh.resume}
                </button>
              )}
              {isActive && (
                <button
                  type="button"
                  onClick={() => control("cancel")}
                  className="rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-3 py-1 text-xs"
                >
                  {tsh.cancel}
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
            {ts.progressCounts(
              processed,
              status.total,
              status.done,
              status.failed,
              status.running,
              status.pending,
            )}
          </div>

          {cost && (
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {tsh.unitsLabel}{" "}
              <strong className="text-neutral-700 dark:text-neutral-200">
                {cost.ahrefs_units_billed.toLocaleString()}
              </strong>{" "}
              {tsh.unitsBilled}
              {cost.ahrefs_units_list !== cost.ahrefs_units_billed &&
                tsh.unitsListPrice(cost.ahrefs_units_list.toLocaleString())}
              {tsh.apiCalls(cost.ahrefs_fresh_calls)}
            </div>
          )}

          {isTerminal && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/runs/${status.id}/serp-overview.csv`}
                className="inline-block rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium"
              >
                {ts.downloadCsv}
              </a>
              <a
                href={`/api/runs/${status.id}/serp-overview-domains.csv${
                  tldFiltered ? "?tlds=allowed" : ""
                }`}
                className="inline-block rounded border dark:border-neutral-700 px-4 py-2 text-sm font-medium"
              >
                {ts.downloadDomainsCsv}
              </a>
              <button
                type="button"
                onClick={copyDomains}
                className="rounded border dark:border-neutral-700 px-4 py-2 text-sm font-medium"
              >
                {copied ?? ts.copyUniqueDomains}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Recent runs — persistent history so past runs can be re-opened
          and downloaded even after a page reload. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">{tsh.recentRuns}</h2>
          {/* Global export — every run ever, deduped across runs. */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={tldFiltered}
                onChange={(e) => setTldFiltered(e.target.checked)}
              />
              {ts.allowedTldsOnly}
            </label>
            <a
              href={`/api/analyze/serp-overview/domains.csv${
                tldFiltered ? "?tlds=allowed" : ""
              }`}
              className="rounded border dark:border-neutral-700 px-3 py-1.5 text-xs font-medium"
            >
              {tsh.downloadAllDomains}
            </a>
            <button
              type="button"
              onClick={copyAllDomains}
              className="rounded border dark:border-neutral-700 px-3 py-1.5 text-xs font-medium"
            >
              {copiedAll ?? tsh.copyAll}
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
            placeholder={tsh.searchPlaceholder}
            className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-xs w-56"
          />
          <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              {tsh.runsPage(
                total,
                page,
                Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
              )}
            </span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border dark:border-neutral-700 px-2 py-1 disabled:opacity-40"
            >
              {tsh.prev}
            </button>
            <button
              type="button"
              disabled={page >= Math.ceil(total / HISTORY_PAGE_SIZE)}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border dark:border-neutral-700 px-2 py-1 disabled:opacity-40"
            >
              {tsh.next}
            </button>
          </div>
        </div>

        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-x-auto">
          {history.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 py-6">
              {search.trim() ? tsh.noMatchingRuns : tsh.noRunsYet}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-neutral-500 dark:text-neutral-400 border-b dark:border-neutral-800">
                <tr>
                  <th className="text-left font-medium px-3 py-2">
                    {tsh.colDate}
                  </th>
                  <th className="text-left font-medium px-3 py-2">
                    {tsh.colName}
                  </th>
                  <th className="text-left font-medium px-3 py-2">
                    {tsh.colStatus}
                  </th>
                  <th className="text-left font-medium px-3 py-2">
                    {ts.colKeywords}
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    {ts.colUrls}
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    {tsh.colAhrefsUnits}
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    {tsh.colActions}
                  </th>
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
                            {tsh.save}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingJobId(null)}
                            className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
                          >
                            {tsh.renameCancel}
                          </button>
                        </span>
                      ) : (
                        h.name || tsh.runFallbackName(h.run_id)
                      )}
                    </td>
                    <td className="px-3 py-2 uppercase tracking-wide text-xs">
                      {h.status}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {h.keywords_done}/{h.keywords_total}
                      {h.keywords_failed > 0 && (
                        <span className="text-rose-600 dark:text-rose-400">
                          {tsh.failedSuffix(h.keywords_failed)}
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
                          {tsh.view}
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(h)}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          {tsh.rename}
                        </button>
                        <a
                          href={`/api/runs/${h.run_id}/serp-overview.csv`}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          {ts.downloadCsvShort}
                        </a>
                        <a
                          href={`/api/runs/${h.run_id}/serp-overview-domains.csv${
                            tldFiltered ? "?tlds=allowed" : ""
                          }`}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          {ts.domainsCsvShort}
                        </a>
                        {h.status === "paused" && (
                          <button
                            type="button"
                            onClick={() => resumeRun(h.run_id)}
                            className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            {tsh.resumeAction}
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
