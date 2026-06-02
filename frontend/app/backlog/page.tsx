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
  EditableDateCell,
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
  // Availability filter (added 2026-05-15) — selected statuses from
  // {"available","registered","unknown","error","__none__"} where
  // "__none__" matches domains that have never had an availability
  // check. Server-side resolved via the `availability` query param.
  const [availabilityFilter, setAvailabilityFilter] = useState<string[]>([]);
  // Initial search seed (2026-05-17 B5 fix): read `?search=` from the
  // URL on mount so the Database → Backlog status-pill link can land
  // the user on a pre-filtered view. Uses window.location (vs.
  // useSearchParams) to avoid the Suspense-boundary requirement
  // Next.js 15 imposes on the hook. After mount the URL is left alone
  // — the search box owns subsequent edits and the URL doesn't
  // round-trip.
  const [search, setSearch] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return new URLSearchParams(window.location.search).get("search") || "";
    } catch {
      return "";
    }
  });

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

  // Availability cascade column (added 2026-05-12). Map domain →
  // latest cached check. Hydrated when `data` lands; per-row recheck +
  // bulk recheck refresh it.
  const [availabilityByDomain, setAvailabilityByDomain] = useState<
    Record<
      string,
      {
        status: import("@/lib/api").AvailabilityStatus;
        provider: string;
        registrar: string;
        expires_on: string | null;
        checked_at: string | null;
      }
    >
  >({});
  const [availabilityBusy, setAvailabilityBusy] = useState<Set<string>>(
    new Set(),
  );

  async function recheckOne(domain: string) {
    setAvailabilityBusy((prev) => new Set(prev).add(domain));
    try {
      const r = await api.checkAvailability(domain, false);
      setAvailabilityByDomain((prev) => ({
        ...prev,
        [domain]: {
          status: r.status,
          provider: r.provider,
          registrar: r.registrar,
          expires_on: r.expires_on,
          checked_at: r.checked_at,
        },
      }));
    } catch {
      // Surfaced on /errors via backend log handler.
    } finally {
      setAvailabilityBusy((prev) => {
        const n = new Set(prev);
        n.delete(domain);
        return n;
      });
    }
  }


  // Build the export URL from the current filter state. `scope=filtered`
  // includes the filters; `scope=all` ignores them. Browser's native
  // `<a download>` handles the streaming response — no fetch+Blob needed.
  function exportUrl(scope: "filtered" | "all"): string {
    const params = new URLSearchParams({ scope });
    if (scope === "filtered") {
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter.length) params.set("status", statusFilter.join(","));
      // Repeated `registrar=` params (not comma-joined) — matches the
      // list endpoint's new shape; commas in registrar names no longer
      // break the round-trip.
      for (const r of registrarFilter) params.append("registrar", r);
      if (expiryFrom) params.set("expiry_from", expiryFrom);
      if (expiryTo) params.set("expiry_to", expiryTo);
      if (availabilityFilter.length)
        params.set("availability", availabilityFilter.join(","));
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
    availabilityFilter,
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

  function reload(
    opts: {
      silent?: boolean;
      refreshOptions?: boolean;
      // True when the candidate set is changing (filter / sort / search
      // / per-page). The page navigation case + the manual Refresh
      // button + post-mutation reloads explicitly keep the selection
      // — pagination because the user is sweeping across pages, the
      // others because the rows they picked still exist.
      clearSelection?: boolean;
    } = {},
  ) {
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
        availability: availabilityFilter.length
          ? availabilityFilter
          : undefined,
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
        // Selection survives pagination + manual Refresh + post-
        // mutation reload (bulk action handlers already clear it
        // themselves where appropriate). Only the deps-effect path
        // sets `clearSelection: true`, and only when filter / sort /
        // search / per-page actually changed — in that case the
        // candidate set reshapes and old picks may not apply.
        if (opts.clearSelection) {
          setSelected(new Set());
        }
        // Hydrate availability column from the cache history (no
        // fresh cascade calls).
        const domains = d.rows.map((r) => r.domain);
        if (domains.length > 0) {
          api
            .latestAvailability(domains)
            .then((rows) => {
              const map: typeof availabilityByDomain = {};
              for (const r of rows) {
                map[r.domain] = {
                  status: r.status,
                  provider: r.provider,
                  registrar: r.registrar,
                  expires_on: r.expires_on,
                  checked_at: r.checked_at,
                };
              }
              setAvailabilityByDomain(map);
            })
            .catch(() => {
              // Column stays empty — non-fatal.
            });
        }
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
      availabilityFilter,
      search,
      sortCol,
      sortDir,
    });
    const onlyPageChanged =
      lastDepsRef.current !== null && lastDepsRef.current === nonPageDeps;
    lastDepsRef.current = nonPageDeps;
    reload({
      silent: true,
      refreshOptions: !onlyPageChanged,
      // Filter / sort / search / per-page change → drop stale picks.
      // Pure page-flip keeps the selection so the user can sweep.
      clearSelection: !onlyPageChanged,
    });
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
    availabilityFilter,
    search,
    sortCol,
    sortDir,
  ]);

  function clearFilters() {
    setStatusFilter([]);
    setRegistrarFilter([]);
    setExpiryFrom("");
    setExpiryTo("");
    setAvailabilityFilter([]);
    setSearch("");
  }

  const filtersActive =
    statusFilter.length > 0 ||
    registrarFilter.length > 0 ||
    !!expiryFrom ||
    !!expiryTo ||
    availabilityFilter.length > 0 ||
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

  // Resolve which /check page each pillar lands on. Quality + Whois
  // have functional forms; Availability accepts the same handoff key
  // even though its check page is currently a stub — operators can
  // still kick off availability runs from this menu.
  type Pillar = "quality" | "whois" | "availability" | "ahrefs_batch";
  const PILLAR_ROUTES: Record<Pillar, string> = {
    quality: "/check/quality?from_backlog=1",
    whois: "/check/whois-history?from_backlog=1",
    availability: "/check/availability?from_backlog=1",
    ahrefs_batch: "/check/ahrefs-batch-analysis?from_backlog=1",
  };

  // Unified handoff for "send these domains to <pillar>". Replaces the
  // pre-Wave-3 separate handlers per scope; the pillar choice is
  // surfaced via a 3-button picker in the selection + all-filtered
  // toolbars. The backend's `/send-to-analyze` endpoint still flips
  // affected rows' status to `in_progress` regardless of pillar — that
  // status reflects "operator-decided-to-act," not pillar-specific
  // pipeline state.
  async function handleSendTo(
    pillar: Pillar,
    scope: "ids" | "filtered",
  ): Promise<void> {
    if (scope === "ids" && selected.size === 0) return;
    if (scope === "filtered" && (!data || data.filtered_total === 0)) return;
    if (
      scope === "filtered" &&
      !window.confirm(ts.confirmSendAllFiltered(data!.filtered_total))
    ) {
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    try {
      const r =
        scope === "ids"
          ? await api.sendBacklogToAnalyze({
              scope: "ids",
              ids: Array.from(selected),
            })
          : await api.sendBacklogToAnalyze({
              scope: "filtered",
              search: search.trim() || undefined,
              status: statusFilter.length ? statusFilter : undefined,
              registrar: registrarFilter.length ? registrarFilter : undefined,
              expiry_from: expiryFrom || undefined,
              expiry_to: expiryTo || undefined,
              availability: availabilityFilter.length
                ? availabilityFilter
                : undefined,
            });
      if (r.count === 0) return;
      sessionStorage.setItem(
        BACKLOG_HANDOFF_KEY,
        JSON.stringify({ domains: r.domains }),
      );
      router.push(PILLAR_ROUTES[pillar]);
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
        availability: availabilityFilter.length
          ? availabilityFilter
          : undefined,
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
    patch: {
      project?: string;
      comments?: string;
      desired_price?: number | null;
      max_price?: number | null;
      expiration_date?: string | null;
    },
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

  // Delete every row matching the current filters, regardless of
  // pagination or selection. Confirms first — the user can't see the
  // full affected set on screen.
  async function handleBulkDeleteAllFiltered() {
    if (!data) return;
    const n = data.filtered_total;
    if (n === 0) return;
    if (!window.confirm(ts.confirmBulkDeleteFiltered(n))) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await api.bulkBacklogDeleteFiltered({
        search: search.trim() || undefined,
        status: statusFilter.length ? statusFilter : undefined,
        registrar: registrarFilter.length ? registrarFilter : undefined,
        expiry_from: expiryFrom || undefined,
        expiry_to: expiryTo || undefined,
        availability: availabilityFilter.length
          ? availabilityFilter
          : undefined,
      });
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
          <MultiSelectFilter
            label={ts.filters.availabilityLabel}
            anyLabel={ts.filters.availabilityAny}
            value={availabilityFilter}
            onChange={setAvailabilityFilter}
            title={ts.filters.availabilityHint}
            options={[
              {
                value: "available",
                label: ts.filters.availabilityAvailable,
              },
              {
                value: "registered",
                label: ts.filters.availabilityRegistered,
              },
              {
                value: "unknown",
                label: ts.filters.availabilityUnknown,
              },
              {
                value: "error",
                label: ts.filters.availabilityError,
              },
              {
                value: "__none__",
                label: ts.filters.availabilityNeverChecked,
                group: "tail" as const,
              },
            ]}
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
          placeholder={ts.searchPlaceholder}
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
          <span className="text-xs text-neutral-500 dark:text-neutral-400 self-center">
            {ts.sendToPicker.allFilteredLabel(data.filtered_total)}
          </span>
          <button
            type="button"
            onClick={() => handleSendTo("quality", "filtered")}
            disabled={bulkBusy}
            className="text-xs px-3 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
            title={ts.sendToPicker.qualityHint}
          >
            {ts.sendToPicker.quality}
          </button>
          <button
            type="button"
            onClick={() => handleSendTo("whois", "filtered")}
            disabled={bulkBusy}
            className="text-xs px-3 py-1 rounded-md border border-indigo-300 dark:border-indigo-900/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:opacity-50"
            title={ts.sendToPicker.whoisHint}
          >
            {ts.sendToPicker.whois}
          </button>
          <button
            type="button"
            onClick={() => handleSendTo("availability", "filtered")}
            disabled={bulkBusy}
            className="text-xs px-3 py-1 rounded-md border border-sky-300 dark:border-sky-900/60 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40 disabled:opacity-50"
            title={ts.sendToPicker.availabilityHint}
          >
            {ts.sendToPicker.availability}
          </button>
          <button
            type="button"
            onClick={() => handleSendTo("ahrefs_batch", "filtered")}
            disabled={bulkBusy}
            className="text-xs px-3 py-1 rounded-md border border-emerald-300 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
            title={ts.sendToPicker.ahrefsBatchHint}
          >
            {ts.sendToPicker.ahrefsBatch}
          </button>
          <button
            type="button"
            onClick={handleBulkDeleteAllFiltered}
            // Disabled when no filter is active — protects against
            // a careless "Delete all 358 filtered" click on a fresh
            // page where the filtered set IS the whole backlog. The
            // selection-toolbar's per-row delete still works; the user
            // has to actually narrow the set to wipe in bulk.
            disabled={bulkBusy || !filtersActive}
            title={
              !filtersActive
                ? ts.bulkDeleteAllFilteredNoFilterHint
                : undefined
            }
            className="text-xs px-3 py-1 rounded-md border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bulkBusy
              ? ts.bulkDeleting
              : ts.bulkDeleteAllFiltered(data.filtered_total)}
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
            <span className="text-xs text-neutral-500 dark:text-neutral-400 self-center">
              {ts.sendToPicker.label(selected.size)}
            </span>
            <button
              type="button"
              onClick={() => handleSendTo("quality", "ids")}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              title={ts.sendToPicker.qualityHint}
            >
              {ts.sendToPicker.quality}
            </button>
            <button
              type="button"
              onClick={() => handleSendTo("whois", "ids")}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              title={ts.sendToPicker.whoisHint}
            >
              {ts.sendToPicker.whois}
            </button>
            <button
              type="button"
              onClick={() => handleSendTo("availability", "ids")}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
              title={ts.sendToPicker.availabilityHint}
            >
              {ts.sendToPicker.availability}
            </button>
            <button
              type="button"
              onClick={() => handleSendTo("ahrefs_batch", "ids")}
              disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              title={ts.sendToPicker.ahrefsBatchHint}
            >
              {ts.sendToPicker.ahrefsBatch}
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
                  <th className="px-3 py-2 font-medium">
                    {ts.cols.availability}
                  </th>
                  <th className="px-3 py-2 font-medium">{ts.cols.project}</th>
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
                        <EditableDateCell
                          value={r.expiration_date}
                          display={isoToDisplay(r.expiration_date)}
                          onSave={(v) =>
                            patchRow(r.id, {
                              expiration_date: (v as string | null) ?? null,
                            })
                          }
                        />
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
                      <td className="px-3 py-2 align-top text-xs">
                        <BacklogAvailabilityCell
                          availability={availabilityByDomain[r.domain]}
                          busy={availabilityBusy.has(r.domain)}
                          onRecheck={() => recheckOne(r.domain)}
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-neutral-600 dark:text-neutral-400 max-w-[18rem]">
                        <EditableTextCell
                          value={r.project}
                          multiline
                          onSave={(v) =>
                            patchRow(r.id, { project: String(v ?? "") })
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

function BacklogAvailabilityCell({
  availability,
  busy,
  onRecheck,
}: {
  availability?: {
    status: import("@/lib/api").AvailabilityStatus;
    provider: string;
    registrar: string;
    expires_on: string | null;
    checked_at: string | null;
  };
  busy: boolean;
  onRecheck: () => void;
}) {
  const { t } = useT();
  const a = t.pages.availability;
  const status = availability?.status ?? null;
  const tone = (() => {
    switch (status) {
      case "available":
        return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200";
      case "registered":
        return "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200";
      case "not_supported":
        return "bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-200";
      case "error":
        return "bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200";
      default:
        return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-400";
    }
  })();
  const label = (() => {
    if (status === "available") return a.statusAvailable;
    if (status === "registered") return a.statusRegistered;
    if (status === "not_supported") return a.statusNotSupported;
    if (status === "error") return a.statusError;
    if (status === "unknown") return a.statusUnknown;
    return null;
  })();
  return (
    <div className="space-y-1">
      {label ? (
        <span
          className={`inline-block px-2 py-0.5 rounded-full ${tone}`}
          title={[
            availability?.checked_at
              ? a.checkedAt(new Date(availability.checked_at).toLocaleString())
              : null,
            availability?.provider ? a.sourceProvider(availability.provider) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {label}
        </span>
      ) : (
        <span className="text-neutral-400 dark:text-neutral-500">—</span>
      )}
      {status === "registered" && availability && (availability.registrar || availability.expires_on) && (
        <div className="text-[11px] text-neutral-600 dark:text-neutral-400 space-y-0.5">
          {availability.registrar && <div>{a.registrar(availability.registrar)}</div>}
          {availability.expires_on && <div>{a.expiresOn(availability.expires_on)}</div>}
        </div>
      )}
      <button
        type="button"
        onClick={onRecheck}
        disabled={busy}
        className="text-[11px] px-1.5 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? a.rechecking : a.recheck}
      </button>
    </div>
  );
}
