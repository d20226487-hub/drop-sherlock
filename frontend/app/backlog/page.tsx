"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  BACKLOG_STATUSES,
  BacklogListResponse,
  BacklogSortColumn,
  BacklogSortDirection,
  BacklogStatus,
} from "@/lib/api";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { isoToDisplay } from "@/lib/dates";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";
import { BacklogImport } from "@/components/backlog-import";
import {
  EditablePriceCell,
  EditableTextCell,
} from "@/components/editable-cell";

const PER_PAGE_OPTIONS = [20, 50, 100];

export default function BacklogPage() {
  const { t } = useT();
  const ts = t.pages.backlog;
  const router = useRouter();

  // --- Filter state -------------------------------------------------------
  const [statusFilter, setStatusFilter] = useState<BacklogStatus[]>([]);
  const [registrarFilter, setRegistrarFilter] = useState<string[]>([]);
  const [expiryFrom, setExpiryFrom] = useState<string>("");
  const [expiryTo, setExpiryTo] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  // --- Pagination state ---------------------------------------------------
  const [page, setPage] = useState<number>(1);
  const [perPage, setPerPage] = useState<number>(50);

  // --- Sort state ---------------------------------------------------------
  // null = default backend ordering (newest-first by created_at).
  const [sortCol, setSortCol] = useState<BacklogSortColumn | null>(null);
  const [sortDir, setSortDir] = useState<BacklogSortDirection>("asc");

  // --- Data state ---------------------------------------------------------
  const [data, setData] = useState<BacklogListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  // Options (total + registrars) are expensive at hundreds of thousands of
  // rows. Cache them locally so page navigation can skip the heavy queries
  // and still render the right counts/filters.
  const [cachedTotal, setCachedTotal] = useState<number>(0);
  const [cachedRegistrars, setCachedRegistrars] = useState<string[]>([]);

  // --- Selection ----------------------------------------------------------
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // --- Import wizard ------------------------------------------------------
  const [importOpen, setImportOpen] = useState(false);

  // --- Passive "X were analyzed; mark them?" hint ------------------------
  const [analyzedPending, setAnalyzedPending] = useState<{
    count: number;
    ids: number[];
  } | null>(null);
  // Soft-dismiss the hint for the rest of this session — user might want
  // to ignore it temporarily without actually marking the rows.
  const [hintDismissed, setHintDismissed] = useState(false);

  // Build the export URL from the current filter state. `scope=filtered`
  // includes the filters; `scope=all` ignores them. Browser's native
  // `<a download>` handles the streaming response — no fetch+Blob needed.
  function exportUrl(scope: "filtered" | "all"): string {
    const params = new URLSearchParams({ scope });
    if (scope === "filtered") {
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter.length) params.set("status", statusFilter.join(","));
      if (registrarFilter.length)
        params.set("registrar", registrarFilter.join(","));
      if (expiryFrom) params.set("expiry_from", expiryFrom);
      if (expiryTo) params.set("expiry_to", expiryTo);
    }
    if (sortCol) {
      params.set("sort", sortCol);
      params.set("direction", sortDir);
    }
    return `/api/backlog/export.csv?${params.toString()}`;
  }

  // Sort header click cycles: none → asc → desc → none. Same column on
  // each click; clicking a different column resets to that column's asc.
  function toggleSort(col: BacklogSortColumn) {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortCol(null);
    setSortDir("asc");
  }

  function sortIndicator(col: BacklogSortColumn): string {
    if (sortCol !== col) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  // Reset to page 1 whenever filters/search/sort/per_page change. Avoids
  // the surprise "filtered down to 3 rows but I'm still on page 4" empty
  // state.
  useEffect(() => {
    setPage(1);
  }, [
    statusFilter,
    registrarFilter,
    expiryFrom,
    expiryTo,
    search,
    perPage,
    sortCol,
    sortDir,
  ]);

  // Track whether the next reload was triggered solely by `page` changing
  // — that's the cheap-path that skips the heavy total+registrars
  // queries. Anything else (filter / sort / search / mount) refreshes
  // them. Initialized null so the first-mount reload always refreshes.
  const lastDepsRef = useRef<string | null>(null);

  // Refresh the analyzed-pending hint. Cheap query; runs alongside the
  // option-refresh path so it stays in sync with mutations.
  function refreshAnalyzedPending() {
    api
      .getBacklogAnalyzedPending()
      .then((r) => setAnalyzedPending(r))
      .catch(() => {
        // Silent fail — the hint is opportunistic.
      });
  }

  function reload(opts: { silent?: boolean; refreshOptions?: boolean } = {}) {
    if (!opts.silent) setError(null);
    setLoading(true);
    // Refresh options (total count + distinct registrars) on initial load
    // and after mutations, but NOT on every page navigation. At 200k rows
    // those queries dominate the response time.
    const includeOptions = opts.refreshOptions ?? false;
    api
      .listBacklog({
        page,
        per_page: perPage,
        search: search.trim() || undefined,
        status: statusFilter.length ? statusFilter : undefined,
        registrar: registrarFilter.length ? registrarFilter : undefined,
        expiry_from: expiryFrom || undefined,
        expiry_to: expiryTo || undefined,
        sort: sortCol || undefined,
        direction: sortCol ? sortDir : undefined,
        include_options: includeOptions,
      })
      .then((d) => {
        setData(d);
        setLastRefreshed(new Date());
        if (includeOptions) {
          setCachedTotal(d.total);
          if (d.registrars) setCachedRegistrars(d.registrars);
          refreshAnalyzedPending();
        }
        // Drop selections that are no longer visible on the current page.
        // Keeps the bulk action counter honest after pagination/filter
        // changes.
        const visibleIds = new Set(d.rows.map((r) => r.id));
        setSelected((prev) => {
          const next = new Set<number>();
          for (const id of prev) if (visibleIds.has(id)) next.add(id);
          return next;
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  // Refetch on any filter / pagination / sort change. Page-only changes
  // skip the heavy total+registrars queries; everything else refreshes
  // them.
  useEffect(() => {
    const nonPageDeps = JSON.stringify({
      perPage,
      statusFilter,
      registrarFilter,
      expiryFrom,
      expiryTo,
      search,
      sortCol,
      sortDir,
    });
    const onlyPageChanged =
      lastDepsRef.current !== null && lastDepsRef.current === nonPageDeps;
    lastDepsRef.current = nonPageDeps;
    reload({ silent: true, refreshOptions: !onlyPageChanged });
    if (onlyPageChanged) {
      // Page-flip: jump to the top so the user lands at the first row of
      // the new page instead of staying scrolled into the previous page.
      // `behavior: "instant"` (not smooth) — the new page's table renders
      // mid-scroll, so a smooth animation gets clobbered by reflow.
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    page,
    perPage,
    statusFilter,
    registrarFilter,
    expiryFrom,
    expiryTo,
    search,
    sortCol,
    sortDir,
  ]);

  function clearFilters() {
    setStatusFilter([]);
    setRegistrarFilter([]);
    setExpiryFrom("");
    setExpiryTo("");
    setSearch("");
  }

  const filtersActive =
    statusFilter.length > 0 ||
    registrarFilter.length > 0 ||
    !!expiryFrom ||
    !!expiryTo ||
    search.trim().length > 0;

  // --- Selection helpers --------------------------------------------------
  const pageIds = useMemo(() => (data?.rows || []).map((r) => r.id), [data]);
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

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkStatus(newStatus: BacklogStatus) {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.bulkBacklogStatus(Array.from(selected), newStatus);
      setSelected(new Set());
      reload({ silent: true, refreshOptions: true });
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // One-click action behind the passive hint: flip every "analyzed but
  // not yet marked" row to status='analyzed'. Uses the existing bulk-
  // status endpoint with the ids the hint already collected.
  async function handleMarkAllAnalyzed() {
    if (!analyzedPending || analyzedPending.count === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.bulkBacklogStatus(analyzedPending.ids, "analyzed");
      reload({ silent: true, refreshOptions: true });
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // Hand domains off to the Analyze page via sessionStorage (URLs would
  // blow past length limits at thousands of rows). The backend also
  // flips the affected rows' status to in_progress as a side effect.
  async function handleSendSelectedToAnalyze() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const r = await api.sendBacklogToAnalyze({
        scope: "ids",
        ids: Array.from(selected),
      });
      if (r.count === 0) return;
      sessionStorage.setItem(
        BACKLOG_HANDOFF_KEY,
        JSON.stringify({ domains: r.domains }),
      );
      router.push("/analyze?from_backlog=1");
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleSendAllFilteredToAnalyze() {
    if (!data || data.filtered_total === 0) return;
    if (
      !window.confirm(ts.confirmSendAllFiltered(data.filtered_total))
    )
      return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const r = await api.sendBacklogToAnalyze({
        scope: "filtered",
        search: search.trim() || undefined,
        status: statusFilter.length ? statusFilter : undefined,
        registrar: registrarFilter.length ? registrarFilter : undefined,
        expiry_from: expiryFrom || undefined,
        expiry_to: expiryTo || undefined,
      });
      if (r.count === 0) return;
      sessionStorage.setItem(
        BACKLOG_HANDOFF_KEY,
        JSON.stringify({ domains: r.domains }),
      );
      router.push("/analyze?from_backlog=1");
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // Apply a status to every row matching current filters, regardless of
  // pagination. Confirms first because the user can't see the full
  // affected set on screen.
  async function handleBulkStatusAllFiltered(newStatus: BacklogStatus) {
    if (!data) return;
    const n = data.filtered_total;
    if (n === 0) return;
    if (
      !window.confirm(
        ts.confirmBulkStatusFiltered(n, ts.statusLabels[newStatus]),
      )
    )
      return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.bulkBacklogStatusFiltered(newStatus, {
        search: search.trim() || undefined,
        status: statusFilter.length ? statusFilter : undefined,
        registrar: registrarFilter.length ? registrarFilter : undefined,
        expiry_from: expiryFrom || undefined,
        expiry_to: expiryTo || undefined,
      });
      setSelected(new Set());
      reload({ silent: true, refreshOptions: true });
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // Per-cell partial update used by the inline editors. Throws on failure
  // so the EditableCell components can show their inline error + stay in
  // edit mode for retry.
  async function patchRow(
    id: number,
    patch: { comments?: string; desired_price?: number | null; max_price?: number | null },
  ): Promise<void> {
    const updated = await api.updateBacklogRow(id, patch);
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map((r) => (r.id === id ? updated : r)),
      };
    });
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(ts.confirmBulkDelete(selected.size))) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.bulkBacklogDelete(Array.from(selected));
      setSelected(new Set());
      reload({ silent: true, refreshOptions: true });
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  // --- Render -------------------------------------------------------------

  const statusOptions = BACKLOG_STATUSES.map((s) => ({
    value: s,
    label: ts.statusLabels[s],
  }));
  const registrarOptions = cachedRegistrars.map((r) => ({
    value: r,
    label: r,
  }));

  const totalPages = data
    ? Math.max(1, Math.ceil(data.filtered_total / perPage))
    : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="text-2xl font-semibold">{ts.title}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {ts.intro}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end shrink-0">
          {lastRefreshed && (
            <span
              className="text-xs text-neutral-500 dark:text-neutral-400"
              title={lastRefreshed.toISOString()}
            >
              {lastRefreshed.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => reload({ refreshOptions: true })}
            disabled={loading}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {loading ? ts.refreshing : ts.refresh}
          </button>
          <a
            href={exportUrl("filtered")}
            download
            aria-disabled={!data || data.filtered_total === 0}
            title={ts.exportFilteredHint}
            className={
              "text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 " +
              (!data || data.filtered_total === 0
                ? "opacity-50 pointer-events-none"
                : "")
            }
          >
            {ts.exportFiltered(data?.filtered_total ?? 0)}
          </a>
          <a
            href={exportUrl("all")}
            download
            aria-disabled={!data || cachedTotal === 0}
            title={ts.exportAllHint}
            className={
              "text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 " +
              (!data || cachedTotal === 0
                ? "opacity-50 pointer-events-none"
                : "")
            }
          >
            {ts.exportAll(cachedTotal)}
          </a>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            {ts.importBtn}
          </button>
        </div>
      </div>

      {importOpen && (
        <BacklogImport
          onClose={() => setImportOpen(false)}
          onImported={() => reload({ silent: true, refreshOptions: true })}
        />
      )}

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold">{ts.filters.heading}</h2>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {ts.filters.clear}
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <MultiSelectFilter
            label={ts.filters.statusLabel}
            anyLabel={ts.filters.statusAny}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as BacklogStatus[])}
            options={statusOptions}
          />
          <MultiSelectFilter
            label={ts.filters.registrarLabel}
            anyLabel={ts.filters.registrarAny}
            value={registrarFilter}
            onChange={setRegistrarFilter}
            disabled={registrarOptions.length === 0}
            options={registrarOptions}
            searchable
            searchPlaceholder={ts.filters.registrarSearchPlaceholder}
          />
          <label className="flex items-center gap-2 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
              {ts.filters.expiryFrom}
            </span>
            <input
              type="date"
              value={expiryFrom}
              onChange={(e) => setExpiryFrom(e.target.value)}
              className="bg-transparent outline-none w-full text-sm"
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
              {ts.filters.expiryTo}
            </span>
            <input
              type="date"
              value={expiryTo}
              onChange={(e) => setExpiryTo(e.target.value)}
              className="bg-transparent outline-none w-full text-sm"
            />
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3 flex-wrap text-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.pagination.searchPlaceholder}
          className="flex-1 min-w-[12rem] rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 outline-none"
        />
        <label className="flex items-center gap-2">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {t.pagination.perPage}
          </span>
          <select
            value={perPage}
            onChange={(e) => setPerPage(parseInt(e.target.value, 10))}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5"
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-auto">
            {ts.totalHint(data.filtered_total, cachedTotal)}
          </span>
        )}
      </div>

      {/* Bulk-action bar that scopes to the entire filtered set, not just
          the visible page. Lives outside the selection toolbar so the
          user can act on all-filtered without first selecting rows. */}
      {data && data.filtered_total > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <select
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value as BacklogStatus | "";
              if (!v) return;
              handleBulkStatusAllFiltered(v);
              e.currentTarget.value = "";
            }}
            disabled={bulkBusy}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 disabled:opacity-50"
          >
            <option value="">
              {ts.bulkChangeStatusAllFiltered(data.filtered_total)}
            </option>
            {BACKLOG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ts.bulkChangeStatusTo(ts.statusLabels[s])}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSendAllFilteredToAnalyze}
            disabled={bulkBusy}
            className="text-xs px-3 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
          >
            {ts.sendAllFilteredToAnalyze(data.filtered_total)}
          </button>
        </div>
      )}

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
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value as BacklogStatus | "";
                if (!v) return;
                handleBulkStatus(v);
                e.currentTarget.value = "";
              }}
              disabled={bulkBusy}
              className="text-xs px-2 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 bg-white dark:bg-neutral-950 text-blue-800 dark:text-blue-300 disabled:opacity-50"
            >
              <option value="">{ts.bulkChangeStatus}</option>
              {BACKLOG_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ts.bulkChangeStatusTo(ts.statusLabels[s])}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSendSelectedToAnalyze}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {ts.sendToAnalyze(selected.size)}
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {bulkBusy ? ts.bulkDeleting : ts.bulkDelete(selected.size)}
            </button>
          </div>
        </div>
      )}

      {bulkError && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {bulkError}
        </div>
      )}

      {/* Passive hint surfaced when domains have been analyzed (in any
          job/run) but their backlog status hasn't caught up to it. The
          user picked manual-only status changes, but this nudge keeps
          the backlog honest without auto-flipping behind their back. */}
      {analyzedPending && analyzedPending.count > 0 && !hintDismissed && (
        <div className="rounded-md border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm flex items-center justify-between gap-3 flex-wrap">
          <span className="text-amber-800 dark:text-amber-300">
            {ts.analyzedHint(analyzedPending.count)}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setHintDismissed(true)}
              disabled={bulkBusy}
              className="text-xs px-2 py-1 rounded-md border border-amber-300 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
            >
              {ts.analyzedHintDismiss}
            </button>
            <button
              type="button"
              onClick={handleMarkAllAnalyzed}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {ts.analyzedHintMark(analyzedPending.count)}
            </button>
          </div>
        </div>
      )}

      {data === null ? (
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      ) : cachedTotal === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      ) : data.rows.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.noMatch}
        </p>
      ) : (
        <>
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
                  <th className="px-3 py-2 font-medium">{ts.cols.registrar}</th>
                  <th className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort("expiration_date")}
                      className="font-medium hover:text-blue-600 dark:hover:text-blue-400"
                      title="Click to sort"
                    >
                      {ts.cols.expirationDate}
                      {sortIndicator("expiration_date")}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort("desired_price")}
                      className="font-medium hover:text-blue-600 dark:hover:text-blue-400"
                      title="Click to sort"
                    >
                      {ts.cols.desiredPrice}
                      {sortIndicator("desired_price")}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort("max_price")}
                      className="font-medium hover:text-blue-600 dark:hover:text-blue-400"
                      title="Click to sort"
                    >
                      {ts.cols.maxPrice}
                      {sortIndicator("max_price")}
                    </button>
                  </th>
                  <th className="px-3 py-2 font-medium">{ts.cols.comments}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isSel = selected.has(r.id);
                  return (
                    <tr
                      key={r.id}
                      className={
                        "border-t dark:border-neutral-800 " +
                        (isSel ? "bg-blue-50/70 dark:bg-blue-950/30" : "")
                      }
                    >
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleOne(r.id)}
                          aria-label={`Select ${r.domain}`}
                          className="cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2 align-top font-mono">
                        {r.analyzed_run_domain_id != null &&
                        r.analyzed_run_id != null &&
                        r.analyzed_job_id != null ? (
                          <Link
                            href={`/jobs/${r.analyzed_job_id}/runs/${r.analyzed_run_id}/domains/${r.analyzed_run_domain_id}`}
                            className="text-blue-600 dark:text-blue-400 hover:underline"
                            title={ts.openAnalyzed}
                          >
                            {r.domain}
                          </Link>
                        ) : (
                          r.domain
                        )}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
                          {ts.statusLabels[r.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top">{r.registrar || "—"}</td>
                      <td className="px-3 py-2 align-top whitespace-nowrap">
                        {isoToDisplay(r.expiration_date) || "—"}
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <EditablePriceCell
                          value={r.desired_price}
                          onSave={(v) =>
                            patchRow(r.id, { desired_price: v as number | null })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <EditablePriceCell
                          value={r.max_price}
                          onSave={(v) =>
                            patchRow(r.id, { max_price: v as number | null })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-neutral-600 dark:text-neutral-400 max-w-[24rem]">
                        <EditableTextCell
                          value={r.comments}
                          multiline
                          onSave={(v) =>
                            patchRow(r.id, { comments: String(v ?? "") })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 text-xs text-neutral-600 dark:text-neutral-400">
            <span>
              {t.pagination.page(data.page, totalPages)}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={data.page <= 1 || loading}
                className="px-2 py-1 rounded-md border dark:border-neutral-700 disabled:opacity-50"
              >
                {t.pagination.prev}
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={data.page >= totalPages || loading}
                className="px-2 py-1 rounded-md border dark:border-neutral-700 disabled:opacity-50"
              >
                {t.pagination.next}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
