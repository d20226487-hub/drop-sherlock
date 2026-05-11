"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  ErrorCategory,
  ErrorRow,
  ErrorStatus,
} from "@/lib/api";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import {
  PaginationBottomBar,
  PaginationTopBar,
} from "@/components/pagination-bar";
import { CsvColumn, csvFilename, downloadBlob, toCsv } from "@/lib/csv";

const CATEGORIES: ErrorCategory[] = [
  "ai",
  "ahrefs",
  "wayback",
  "domain",
  "run",
  "backend",
];

const CATEGORY_TONE: Record<ErrorCategory, string> = {
  ai: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  ahrefs: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  // Wayback gets its own teal-ish tone so the user can scan the table by
  // provider at a glance.
  wayback: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300",
  domain: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  run: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  backend: "bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function rowKey(r: ErrorRow): string {
  return `${r.source_kind}:${r.source_id}:${r.message_hash}`;
}

function rowLink(r: ErrorRow): string | null {
  if (r.run_domain_id != null && r.run_id != null && r.job_id != null) {
    return `/jobs/${r.job_id}/runs/${r.run_id}/domains/${r.run_domain_id}`;
  }
  if (r.run_id != null && r.job_id != null) {
    return `/jobs/${r.job_id}/runs/${r.run_id}`;
  }
  if (r.job_id != null) {
    return `/jobs/${r.job_id}`;
  }
  return null;
}

function contextSummary(r: ErrorRow): string {
  const ctx = r.context as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof ctx.domain === "string" && ctx.domain) parts.push(ctx.domain);
  if (typeof ctx.criterion === "string" && ctx.criterion) parts.push(ctx.criterion);
  if (typeof ctx.ai_provider === "string" && ctx.ai_provider) {
    parts.push(
      String(ctx.ai_provider) + (ctx.ai_model ? ` · ${ctx.ai_model}` : ""),
    );
  }
  if (typeof ctx.http_status === "number" && ctx.http_status) {
    parts.push(`HTTP ${ctx.http_status}`);
  }
  if (typeof ctx.logger === "string" && ctx.logger) parts.push(ctx.logger);
  if (typeof ctx.path === "string" && ctx.path) {
    parts.push(`${ctx.method ?? ""} ${ctx.path}`.trim());
  }
  return parts.join(" · ");
}

export default function ErrorsPage() {
  const { t } = useT();
  const ts = t.pages.errors;

  const [allRows, setAllRows] = useState<ErrorRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState<ErrorCategory | "all">("all");
  const [status, setStatus] = useState<ErrorStatus>("open");

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function reload() {
    setLoading(true);
    setError(null);
    // Single big fetch — all categories, all statuses. Filtering / paging
    // happen client-side so toggling tabs is instant.
    api
      .listErrors({ status: "all", limit: 5000 })
      .then((d) => setAllRows(d.errors))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  // Counts derived from the single fetched set so tab badges stay in sync
  // with status/search filtering elsewhere on the page.
  const counts = useMemo(() => {
    const c: Record<string, number> = {
      ai: 0,
      ahrefs: 0,
      wayback: 0,
      domain: 0,
      run: 0,
      backend: 0,
      total: 0,
      open: 0,
      dismissed: 0,
    };
    if (!allRows) return c;
    for (const r of allRows) {
      c[r.category] = (c[r.category] || 0) + 1;
      c.total += 1;
      if (r.dismissed_at == null) c.open += 1;
      else c.dismissed += 1;
    }
    return c;
  }, [allRows]);

  // Apply category + status BEFORE the search hook so the page badges
  // reflect the active tabs.
  const filtered = useMemo<ErrorRow[]>(() => {
    if (!allRows) return [];
    return allRows.filter((r) => {
      if (category !== "all" && r.category !== category) return false;
      if (status === "open" && r.dismissed_at != null) return false;
      if (status === "dismissed" && r.dismissed_at == null) return false;
      return true;
    });
  }, [allRows, category, status]);

  const search = usePaginatedSearch<ErrorRow>(
    filtered,
    (item, q) => {
      if (item.message.toLowerCase().includes(q)) return true;
      const ctx = contextSummary(item).toLowerCase();
      return ctx.includes(q);
    },
    { initialPageSize: 50 },
  );

  // Drop selections that are no longer in the visible (filtered+searched) set
  // when filters change. Keeps "Dismiss N" honest.
  useEffect(() => {
    setSelected((prev) => {
      const visibleKeys = new Set(search.filteredAll.map(rowKey));
      const next = new Set<string>();
      for (const k of prev) if (visibleKeys.has(k)) next.add(k);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, search.query]);

  function toggleOne(r: ErrorRow) {
    const k = rowKey(r);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Page-level select-all = checkbox covers only rows currently visible
  // on this page. Cross-page bulk select would surprise users.
  const pageKeys = search.paged.map(rowKey);
  const pageAllSelected =
    pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  function togglePageSelect() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) for (const k of pageKeys) next.delete(k);
      else for (const k of pageKeys) next.add(k);
      return next;
    });
  }

  async function handleDismiss(r: ErrorRow) {
    const key = rowKey(r);
    setBusyKey(key);
    try {
      await api.dismissError(r.source_kind, r.source_id, r.message_hash);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRestore(r: ErrorRow) {
    const key = rowKey(r);
    setBusyKey(key);
    try {
      await api.restoreError(r.source_kind, r.source_id, r.message_hash);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteLog(r: ErrorRow) {
    if (r.source_kind !== "log") return;
    if (!window.confirm(ts.confirmDeleteLog)) return;
    setBusyKey(rowKey(r));
    try {
      await api.deleteLogError(r.source_id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleBulkDismiss() {
    if (selected.size === 0) return;
    if (!window.confirm(ts.confirmBulkDismiss(selected.size))) return;
    const items = (allRows || [])
      .filter((r) => selected.has(rowKey(r)) && r.dismissed_at == null)
      .map((r) => ({
        source_kind: r.source_kind,
        source_id: r.source_id,
        message_hash: r.message_hash,
      }));
    if (items.length === 0) {
      // All selected were already dismissed — nothing to do.
      setSelected(new Set());
      return;
    }
    setBulkBusy(true);
    try {
      await api.dismissManyErrors(items);
      setSelected(new Set());
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // CSV export. Columns chosen to be useful for downstream triage / sharing.
  const csvColumns = useMemo<CsvColumn<ErrorRow>[]>(
    () => [
      { header: "category", get: (r) => r.category },
      { header: "occurred_at", get: (r) => r.occurred_at || "" },
      { header: "dismissed_at", get: (r) => r.dismissed_at || "" },
      { header: "message", get: (r) => r.message },
      { header: "context", get: (r) => contextSummary(r) },
      { header: "source_kind", get: (r) => r.source_kind },
      { header: "source_id", get: (r) => r.source_id },
      { header: "job_id", get: (r) => r.job_id ?? "" },
      { header: "run_id", get: (r) => r.run_id ?? "" },
      { header: "run_domain_id", get: (r) => r.run_domain_id ?? "" },
      { header: "criterion", get: (r) => r.criterion ?? "" },
      { header: "message_hash", get: (r) => r.message_hash },
    ],
    [],
  );

  function exportCsv(scope: "selected" | "visible" | "all") {
    let rows: ErrorRow[];
    if (scope === "selected") {
      rows = (allRows || []).filter((r) => selected.has(rowKey(r)));
    } else if (scope === "visible") {
      rows = search.filteredAll;
    } else {
      rows = allRows || [];
    }
    if (rows.length === 0) return;
    const csv = toCsv(rows, csvColumns);
    downloadBlob(csv, csvFilename(`drop-sherlock-errors-${scope}`));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{ts.title}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {ts.intro}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? ts.refreshing : ts.refresh}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("visible")}
            disabled={search.filteredTotal === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportVisibleHint}
          >
            {ts.exportVisible(search.filteredTotal)}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("all")}
            disabled={!allRows || allRows.length === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportAllHint}
          >
            {ts.exportAll(allRows?.length ?? 0)}
          </button>
        </div>
      </div>

      {/* Category tabs with counts */}
      <div className="flex flex-wrap gap-1 text-sm">
        {(["all", ...CATEGORIES] as const).map((c) => {
          const n = c === "all" ? counts.total : counts[c];
          const active = category === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-md border ${active ? "bg-blue-600 text-white border-blue-600" : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"}`}
            >
              {ts.tabs[c]}
              <span
                className={`ml-2 text-xs ${active ? "opacity-90" : "opacity-60"}`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {/* Status select */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ErrorStatus)}
          className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
        >
          <option value="open">{ts.statusOpen(counts.open)}</option>
          <option value="dismissed">
            {ts.statusDismissed(counts.dismissed)}
          </option>
          <option value="all">{ts.statusAll(counts.total)}</option>
        </select>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {allRows === null ? (
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      ) : (
        <>
          <PaginationTopBar state={search} />

          {selected.size > 0 && (
            <div className="rounded-md border border-blue-300 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-sm flex items-center justify-between gap-3 flex-wrap">
              <span className="text-blue-800 dark:text-blue-300">
                {ts.selectedCount(selected.size)}
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={bulkBusy}
                  className="text-xs px-2 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
                >
                  {ts.clearSelection}
                </button>
                <button
                  type="button"
                  onClick={() => exportCsv("selected")}
                  disabled={bulkBusy}
                  className="text-xs px-2 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
                >
                  {ts.exportSelected(selected.size)}
                </button>
                <button
                  type="button"
                  onClick={handleBulkDismiss}
                  disabled={bulkBusy}
                  className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {bulkBusy
                    ? ts.bulkDismissing
                    : ts.bulkDismiss(selected.size)}
                </button>
              </div>
            </div>
          )}

          {search.paged.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {ts.empty}
            </p>
          ) : (
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
                    <th className="px-3 py-2 font-medium">{ts.cols.category}</th>
                    <th className="px-3 py-2 font-medium">{ts.cols.when}</th>
                    <th className="px-3 py-2 font-medium">{ts.cols.message}</th>
                    <th className="px-3 py-2 font-medium">{ts.cols.context}</th>
                    <th className="px-3 py-2 font-medium text-right">
                      {ts.cols.actions}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {search.paged.map((r) => {
                    const key = rowKey(r);
                    const expanded = expandedKey === key;
                    const link = rowLink(r);
                    const isSelected = selected.has(key);
                    return (
                      <tr
                        key={key}
                        className={`border-t dark:border-neutral-800 ${r.dismissed_at ? "opacity-60" : ""} ${isSelected ? "bg-blue-50/70 dark:bg-blue-950/30" : ""}`}
                      >
                        <td className="px-3 py-2 align-top">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(r)}
                            aria-label={`Select error ${key}`}
                            className="cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-2 align-top whitespace-nowrap">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_TONE[r.category]}`}
                          >
                            {r.category}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top whitespace-nowrap text-xs text-neutral-600 dark:text-neutral-400">
                          {formatTime(r.occurred_at)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedKey(expanded ? null : key)
                            }
                            className="text-left w-full hover:underline"
                            title={ts.expandHint}
                          >
                            <span className="font-mono text-xs whitespace-pre-wrap break-words">
                              {expanded ? r.message : r.preview}
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-2 align-top text-xs">
                          {link ? (
                            <Link
                              href={link}
                              className="text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap mr-2"
                            >
                              {ts.openSource}
                            </Link>
                          ) : null}
                          {(() => {
                            const s = contextSummary(r);
                            return s ? (
                              <span className="text-neutral-600 dark:text-neutral-400 break-all">
                                {s}
                              </span>
                            ) : null;
                          })()}
                        </td>
                        <td className="px-3 py-2 align-top text-right whitespace-nowrap">
                          {r.dismissed_at == null ? (
                            <button
                              type="button"
                              onClick={() => handleDismiss(r)}
                              disabled={busyKey === key}
                              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                            >
                              {ts.dismiss}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRestore(r)}
                              disabled={busyKey === key}
                              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                            >
                              {ts.restore}
                            </button>
                          )}
                          {r.source_kind === "log" && (
                            <button
                              type="button"
                              onClick={() => handleDeleteLog(r)}
                              disabled={busyKey === key}
                              className="ml-2 text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
                              title={ts.deleteLogHint}
                            >
                              {ts.delete}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <PaginationBottomBar state={search} />
        </>
      )}
    </div>
  );
}
