"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  AIProvider,
  DatabaseDomainList,
  DatabaseDomainRow,
  ProviderStatus,
} from "@/lib/api";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import {
  PaginationBottomBar,
  PaginationTopBar,
} from "@/components/pagination-bar";
import {
  criterionPillTone,
  FinalBucket,
  formatScore,
  isLowConfidence,
  labelToBucket,
  pillToneWithConfidence,
} from "@/lib/score";
import { CsvColumn, csvFilename, downloadBlob, toCsv } from "@/lib/csv";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { VerdictHoverCard } from "@/components/verdict-hover-card";
import { BacklogActionsCell } from "@/components/backlog-actions-cell";

const CRITERIA_KEYS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  "wayback",
] as const;
type CriterionKey = (typeof CRITERIA_KEYS)[number];

type CacheFilter = "any" | "cached" | "fresh";
type NotesFilter = "any" | "with" | "without";
type PinFilter = "any" | "pinned" | "unpinned";

function isBucket(v: string): v is FinalBucket {
  return v === "good" || v === "mixed" || v === "low_quality";
}

export default function DatabasePage() {
  const { t } = useT();
  const ts = t.pages.database;
  const router = useRouter();

  const [data, setData] = useState<DatabaseDomainList | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter state. Multi-select filters store an array of selected option
  // values; an empty array means "no filter" (matches every row). The
  // sentinel values `__none__` and `__partial__` are valid array entries —
  // they filter to rows missing the respective field.
  const [verdicts, setVerdicts] = useState<string[]>([]);
  const [waybackVerdicts, setWaybackVerdicts] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [criteria, setCriteria] = useState<CriterionKey[]>([]);
  const [cache, setCache] = useState<CacheFilter>("any");
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("any");
  const [pinFilter, setPinFilter] = useState<PinFilter>("any");
  const [minRecords, setMinRecords] = useState<number>(0);
  // wayback_classify filters (added 2026-05-09).
  const [languages, setLanguages] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<{
    rds: number;
    runs: number;
    jobs: number;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // Per-row pin state. Key is the domain string. busy=true while a
  // pin/unpin request is in flight; error holds the last pin error to
  // show inline.
  const [pinBusy, setPinBusy] = useState<Set<string>>(new Set());
  const [pinError, setPinError] = useState<Record<string, string>>({});

  const [verdictSort, setVerdictSort] = useState<"asc" | "desc" | null>(null);

  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  const [reanalyzeResult, setReanalyzeResult] = useState<{
    started: number;
    skipped: number;
  } | null>(null);
  const [bulkBacklogBusy, setBulkBacklogBusy] = useState(false);
  const [bulkBacklogResult, setBulkBacklogResult] = useState<{
    status: string;
    updated?: number;
    created?: number;
    error?: string;
  } | null>(null);
  const [bulkProvider, setBulkProvider] = useState<AIProvider | "">("");
  const [bulkModel, setBulkModel] = useState<string>("");
  const [providerStatuses, setProviderStatuses] = useState<
    Record<string, ProviderStatus> | null
  >(null);
  const [bulkKnownModels, setBulkKnownModels] = useState<
    Record<string, string[]>
  >({});

  const dataRef = useRef<DatabaseDomainList | null>(null);
  dataRef.current = data;

  function reload(opts: { silent?: boolean } = {}) {
    let cancelled = false;
    if (!opts.silent) setError(null);
    setRefreshing(true);
    api
      .listDatabaseDomains()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLastRefreshed(new Date());
          setSelected((prev) => {
            const stillExists = new Set(d.rows.map((r) => r.domain));
            const next = new Set<string>();
            for (const dom of prev) if (stillExists.has(dom)) next.add(dom);
            return next;
          });
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    return reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        reload({ silent: true });
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!reanalyzeOpen || providerStatuses !== null) return;
    api
      .getSettings()
      .then((d) => {
        const m: Record<string, ProviderStatus> = {};
        for (const p of d.providers) m[p.provider] = p;
        setProviderStatuses(m);
        setBulkKnownModels(d.known_models || {});
      })
      .catch(() => setProviderStatuses({}));
  }, [reanalyzeOpen, providerStatuses]);

  function toggleOne(domain: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  async function handlePin(domain: string, runDomainId: number) {
    setPinBusy((prev) => new Set(prev).add(domain));
    setPinError((prev) => {
      const { [domain]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      await api.pinDomain(domain, runDomainId);
      reload({ silent: true });
    } catch (e) {
      setPinError((prev) => ({
        ...prev,
        [domain]: (e as Error).message || "pin failed",
      }));
    } finally {
      setPinBusy((prev) => {
        const next = new Set(prev);
        next.delete(domain);
        return next;
      });
    }
  }

  async function handleUnpin(domain: string) {
    setPinBusy((prev) => new Set(prev).add(domain));
    setPinError((prev) => {
      const { [domain]: _drop, ...rest } = prev;
      return rest;
    });
    try {
      await api.unpinDomain(domain);
      reload({ silent: true });
    } catch (e) {
      setPinError((prev) => ({
        ...prev,
        [domain]: (e as Error).message || "unpin failed",
      }));
    } finally {
      setPinBusy((prev) => {
        const next = new Set(prev);
        next.delete(domain);
        return next;
      });
    }
  }

  const filtered = useMemo<DatabaseDomainRow[]>(() => {
    if (!data) return [];
    // OR semantics inside each multi-select: a row passes the filter if its
    // value is one of the selected options. AND semantics across distinct
    // filters: a row must pass every active filter.
    function matchVerdict(r: DatabaseDomainRow): boolean {
      if (verdicts.length === 0) return true;
      return verdicts.some((v) => {
        if (v === "__none__") return !r.final_bucket && !r.final_partial;
        if (v === "__partial__") return !!r.final_partial;
        return r.final_bucket === v;
      });
    }
    function matchWayback(r: DatabaseDomainRow): boolean {
      if (waybackVerdicts.length === 0) return true;
      return waybackVerdicts.some((v) => {
        if (v === "__none__") return !r.wayback_assessment;
        return r.wayback_assessment === v;
      });
    }
    function matchLang(r: DatabaseDomainRow): boolean {
      if (languages.length === 0) return true;
      return languages.some((v) => {
        if (v === "__none__") return !r.primary_language;
        return r.primary_language === v;
      });
    }
    function matchCat(r: DatabaseDomainRow): boolean {
      if (categories.length === 0) return true;
      return categories.some((v) => {
        if (v === "__none__") return !r.category;
        return r.category === v;
      });
    }
    return data.rows.filter((r) => {
      if (pinFilter === "pinned" && !r.is_pinned) return false;
      if (pinFilter === "unpinned" && r.is_pinned) return false;
      if (!matchVerdict(r)) return false;
      if (!matchWayback(r)) return false;
      if (!matchLang(r)) return false;
      if (!matchCat(r)) return false;
      if (provider) {
        if (provider === "__none__") {
          if (r.ai_provider) return false;
        } else if (r.ai_provider !== provider) {
          return false;
        }
      }
      if (model && r.ai_model !== model) return false;
      // "Any criterion" semantics: a row passes if at least one of the
      // selected criteria is enabled (and ≥ minRecords when set). With no
      // criteria selected and minRecords > 0, fall back to "any criterion at
      // all meets minRecords" — preserves the prior behaviour.
      if (criteria.length > 0) {
        const anyMatch = criteria.some((k) => {
          const c = r.criteria[k];
          if (!c || !c.enabled) return false;
          if (minRecords > 0 && c.rows < minRecords) return false;
          return true;
        });
        if (!anyMatch) return false;
      } else if (minRecords > 0) {
        const anyMeets = CRITERIA_KEYS.some(
          (k) => r.criteria[k]?.enabled && r.criteria[k].rows >= minRecords,
        );
        if (!anyMeets) return false;
      }
      if (cache === "cached" && !r.any_cached) return false;
      if (cache === "fresh" && r.any_cached) return false;
      if (notesFilter === "with" && !r.note) return false;
      if (notesFilter === "without" && r.note) return false;
      return true;
    });
  }, [
    data,
    pinFilter,
    verdicts,
    waybackVerdicts,
    languages,
    categories,
    provider,
    model,
    criteria,
    cache,
    notesFilter,
    minRecords,
  ]);

  const sorted = useMemo<DatabaseDomainRow[]>(() => {
    if (!verdictSort) return filtered;
    const dir = verdictSort === "asc" ? 1 : -1;
    function rank(r: DatabaseDomainRow): number {
      return r.final_score ?? Number.NEGATIVE_INFINITY;
    }
    function isScored(r: DatabaseDomainRow): boolean {
      return !r.final_partial && r.final_score != null;
    }
    return [...filtered].sort((a, b) => {
      const aScored = isScored(a);
      const bScored = isScored(b);
      if (aScored !== bScored) return aScored ? -1 : 1;
      if (!aScored && !bScored) {
        return (
          (a.final_partial ? 0 : 1) - (b.final_partial ? 0 : 1)
        );
      }
      const ra = rank(a);
      const rb = rank(b);
      if (ra === rb) return a.domain.localeCompare(b.domain);
      return (ra - rb) * dir;
    });
  }, [filtered, verdictSort]);

  const search = usePaginatedSearch<DatabaseDomainRow>(
    sorted,
    (item, q) =>
      item.domain.toLowerCase().includes(q) ||
      item.pinned_job_name.toLowerCase().includes(q),
    { initialPageSize: 50 },
  );

  const pageDomains = search.paged.map((r) => r.domain);
  const pageAllSelected =
    pageDomains.length > 0 && pageDomains.every((d) => selected.has(d));
  function togglePageSelect() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        for (const d of pageDomains) next.delete(d);
      } else {
        for (const d of pageDomains) next.add(d);
      }
      return next;
    });
  }

  async function handleBulkReanalyze() {
    if (selected.size === 0) return;
    const ids: number[] = [];
    if (data) {
      const byDomain = new Map(data.rows.map((r) => [r.domain, r]));
      for (const dom of selected) {
        const r = byDomain.get(dom);
        // Only domains with a pinned rd are reanalyzable from here. Skip
        // unpinned rows silently — the picker is gated on pin anyway.
        if (r && r.pinned_run_domain_id != null) {
          ids.push(r.pinned_run_domain_id);
        }
      }
    }
    if (ids.length === 0) return;
    setReanalyzeBusy(true);
    setReanalyzeError(null);
    setReanalyzeResult(null);
    try {
      const r = await api.bulkReanalyzeDomains(ids, {
        provider: bulkProvider || undefined,
        model: bulkModel.trim() || undefined,
      });
      setReanalyzeResult({ started: r.started, skipped: r.skipped });
      reload({ silent: true });
    } catch (e) {
      setReanalyzeError((e as Error).message || "bulk reanalyze failed");
    } finally {
      setReanalyzeBusy(false);
    }
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    const list = Array.from(selected);
    const confirmMsg =
      list.length === 1
        ? ts.deleteConfirmOne(list[0])
        : ts.deleteConfirmMany(list.length);
    if (!window.confirm(confirmMsg)) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteSummary(null);
    try {
      const r = await api.deleteDatabaseDomains(list);
      setDeleteSummary({
        rds: r.deleted_run_domains,
        runs: r.deleted_runs,
        jobs: r.deleted_jobs,
      });
      reload();
    } catch (e) {
      setDeleteError((e as Error).message || "delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkBacklogStatus(status: "order" | "discarded") {
    if (selected.size === 0 || bulkBacklogBusy) return;
    const list = Array.from(selected);
    setBulkBacklogBusy(true);
    setBulkBacklogResult(null);
    try {
      const r = await api.bulkSetDomainBacklogStatus(list, status);
      setBulkBacklogResult({
        status: r.status,
        updated: r.updated,
        created: r.created,
      });
      reload({ silent: true });
    } catch (e) {
      setBulkBacklogResult({
        status,
        error: (e as Error).message || "bulk failed",
      });
    } finally {
      setBulkBacklogBusy(false);
    }
  }

  function clearFilters() {
    setVerdicts([]);
    setWaybackVerdicts([]);
    setLanguages([]);
    setCategories([]);
    setProvider("");
    setModel("");
    setCriteria([]);
    setCache("any");
    setNotesFilter("any");
    setPinFilter("any");
    setMinRecords(0);
  }

  const csvColumns = useMemo<CsvColumn<DatabaseDomainRow>[]>(
    () => [
      { header: "domain", get: (r) => r.domain },
      { header: "is_pinned", get: (r) => (r.is_pinned ? "true" : "false") },
      {
        header: "pinned_run_id",
        get: (r) => r.pinned_run_id ?? "",
      },
      {
        header: "pinned_run_name",
        get: (r) => r.pinned_run_name || "",
      },
      { header: "partial", get: (r) => (r.final_partial ? "true" : "") },
      { header: "score", get: (r) => r.final_score ?? "" },
      { header: "bucket", get: (r) => r.final_bucket },
      { header: "confidence", get: (r) => r.final_confidence ?? "" },
      { header: "ai_provider", get: (r) => r.ai_provider },
      { header: "ai_model", get: (r) => r.ai_model },
      {
        header: "wayback_verdict",
        get: (r) => r.wayback_assessment || "",
      },
      {
        header: "wayback_confidence",
        get: (r) => r.wayback_confidence ?? "",
      },
      {
        header: "primary_language",
        get: (r) => r.primary_language || "",
      },
      {
        header: "secondary_languages",
        get: (r) => (r.secondary_languages || []).join("|"),
      },
      {
        header: "language_confidence",
        get: (r) => r.language_confidence ?? "",
      },
      {
        header: "primary_theme",
        get: (r) => r.primary_theme || "",
      },
      {
        header: "secondary_themes",
        get: (r) => (r.secondary_themes || []).join("|"),
      },
      {
        header: "theme_confidence",
        get: (r) => r.theme_confidence ?? "",
      },
      {
        header: "classify_drift_detected",
        get: (r) => (r.classify_drift_detected ? "true" : ""),
      },
      {
        header: "category",
        get: (r) => r.category || "",
      },
      {
        header: "category_confidence",
        get: (r) => r.category_confidence ?? "",
      },
      {
        header: "category_was",
        get: (r) => r.category_was || "",
      },
      {
        header: "backlinks_rows",
        get: (r) => (r.criteria.backlinks?.enabled ? r.criteria.backlinks.rows : ""),
      },
      {
        header: "refdomains_rows",
        get: (r) => (r.criteria.refdomains?.enabled ? r.criteria.refdomains.rows : ""),
      },
      {
        header: "anchors_rows",
        get: (r) => (r.criteria.anchors?.enabled ? r.criteria.anchors.rows : ""),
      },
      {
        header: "keywords_rows",
        get: (r) => (r.criteria.keywords?.enabled ? r.criteria.keywords.rows : ""),
      },
      {
        header: "wayback_rows",
        get: (r) => (r.criteria.wayback?.enabled ? r.criteria.wayback.rows : ""),
      },
      {
        header: "wayback_samples_count",
        get: (r) => r.wayback_samples_count || "",
      },
      { header: "total_runs", get: (r) => r.total_runs },
      { header: "any_cached", get: (r) => (r.any_cached ? "true" : "false") },
      {
        header: "pinned_finished_at",
        get: (r) => r.pinned_finished_at || "",
      },
      { header: "pinned_job_name", get: (r) => r.pinned_job_name },
      { header: "note", get: (r) => r.note },
    ],
    [],
  );

  function exportCsv(scope: "visible" | "all") {
    const rows =
      scope === "visible" ? search.filteredAll : data?.rows ?? [];
    const csv = toCsv(rows, csvColumns);
    downloadBlob(csv, csvFilename(`drop-sherlock-database-${scope}`));
  }

  const filtersActive =
    verdicts.length > 0 ||
    waybackVerdicts.length > 0 ||
    languages.length > 0 ||
    categories.length > 0 ||
    !!provider ||
    !!model ||
    criteria.length > 0 ||
    cache !== "any" ||
    notesFilter !== "any" ||
    pinFilter !== "any" ||
    minRecords > 0;

  if (error) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      </div>
    );
  }
  if (data.rows.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      </div>
    );
  }

  const opts = data.filter_options;

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
              {ts.refreshedAt(lastRefreshed.toLocaleTimeString())}
            </span>
          )}
          <button
            type="button"
            onClick={() => reload()}
            disabled={refreshing}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {refreshing ? ts.refreshing : ts.refresh}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("visible")}
            disabled={!data || search.filteredTotal === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportVisibleHelp}
          >
            {ts.exportVisible(search.filteredTotal)}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("all")}
            disabled={!data || data.rows.length === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportAllHelp}
          >
            {ts.exportAll(data?.rows.length ?? 0)}
          </button>
        </div>
      </div>

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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 text-sm">
          <select
            value={pinFilter}
            onChange={(e) => setPinFilter(e.target.value as PinFilter)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="any">{ts.filters.pinAny}</option>
            <option value="pinned">{ts.filters.pinPinned}</option>
            <option value="unpinned">{ts.filters.pinUnpinned}</option>
          </select>

          <MultiSelectFilter
            label={ts.filters.verdictAhrefsLabel}
            anyLabel={ts.filters.verdictAhrefsAny}
            value={verdicts}
            onChange={setVerdicts}
            title={ts.filters.verdictAhrefsHint}
            options={[
              ...opts.verdicts.map((v) => ({ value: v, label: v })),
              {
                value: "__partial__",
                label: ts.filters.verdictPartial,
                group: "tail" as const,
              },
              {
                value: "__none__",
                label: ts.filters.verdictNone,
                group: "tail" as const,
              },
            ]}
          />

          <MultiSelectFilter
            label={ts.filters.verdictWaybackLabel}
            anyLabel={ts.filters.verdictWaybackAny}
            value={waybackVerdicts}
            onChange={setWaybackVerdicts}
            title={ts.filters.verdictWaybackHint}
            disabled={opts.wayback_verdicts.length === 0}
            options={[
              ...opts.wayback_verdicts.map((v) => ({ value: v, label: v })),
              {
                value: "__none__",
                label: ts.filters.verdictWaybackNone,
                group: "tail" as const,
              },
            ]}
          />

          <MultiSelectFilter
            label={ts.filters.languageLabel}
            anyLabel={ts.filters.languageAny}
            value={languages}
            onChange={setLanguages}
            title={ts.filters.languageHint}
            disabled={(opts.languages || []).length === 0}
            options={[
              ...(opts.languages || []).map((v) => ({ value: v, label: v })),
              {
                value: "__none__",
                label: ts.filters.languageNone,
                group: "tail" as const,
              },
            ]}
            searchable
            searchPlaceholder={ts.filters.languageSearchPlaceholder}
          />

          <MultiSelectFilter
            label={ts.filters.categoryLabel}
            anyLabel={ts.filters.categoryAny}
            value={categories}
            onChange={setCategories}
            title={ts.filters.categoryHint}
            disabled={(opts.categories || []).length === 0}
            options={[
              ...(opts.categories || []).map((v) => ({ value: v, label: v })),
              {
                value: "__none__",
                label: ts.filters.categoryNone,
                group: "tail" as const,
              },
            ]}
            searchable
            searchPlaceholder={ts.filters.categorySearchPlaceholder}
          />

          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="">{ts.filters.providerAny}</option>
            {opts.ai_providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="__none__">{ts.filters.providerNone}</option>
          </select>

          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
            disabled={opts.ai_models.length === 0}
          >
            <option value="">{ts.filters.modelAny}</option>
            {opts.ai_models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <MultiSelectFilter
            label={ts.filters.criterionLabel}
            anyLabel={ts.filters.criterionAny}
            value={criteria}
            onChange={(v) => setCriteria(v as CriterionKey[])}
            options={CRITERIA_KEYS.map((k) => ({
              value: k,
              label: t.pages.analyze.criteria[k],
            }))}
          />

          <select
            value={cache}
            onChange={(e) => setCache(e.target.value as CacheFilter)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="any">{ts.filters.cacheAny}</option>
            <option value="cached">{ts.filters.cacheCached}</option>
            <option value="fresh">{ts.filters.cacheFresh}</option>
          </select>

          <select
            value={notesFilter}
            onChange={(e) => setNotesFilter(e.target.value as NotesFilter)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="any">{ts.filters.notesAny}</option>
            <option value="with">{ts.filters.notesWith}</option>
            <option value="without">{ts.filters.notesWithout}</option>
          </select>

          <input
            type="number"
            min={0}
            value={minRecords || ""}
            onChange={(e) => setMinRecords(parseInt(e.target.value, 10) || 0)}
            placeholder={ts.filters.minRecords}
            title={ts.filters.minRecordsHelp}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          />
        </div>
      </section>

      <PaginationTopBar state={search} />

      {selected.size > 0 && (
        <div className="rounded-md border border-blue-300 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-sm space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-blue-800 dark:text-blue-300">
              {ts.selectedCount(selected.size)}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setSelected(new Set());
                  setReanalyzeOpen(false);
                  setReanalyzeResult(null);
                }}
                disabled={deleting || reanalyzeBusy}
                className="text-xs px-2 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
              >
                {ts.clearSelection}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Hand the selected domains to the Analyze page via
                  // URL params + the cross-job cache flag, so prior
                  // matching CR rows from ANY job can be reused on
                  // submit. The Analyze page reads `domains=` and
                  // pre-fills the textarea + ticks the cross-cache box.
                  const list = Array.from(selected);
                  if (list.length === 0) return;
                  // Comma-separated; domains can't contain commas.
                  // encodeURIComponent handles any unicode/IDN domains.
                  const param = encodeURIComponent(list.join(","));
                  router.push(
                    `/analyze?domains=${param}&cross_cache=1`,
                  );
                }}
                disabled={deleting || reanalyzeBusy}
                className="text-xs px-3 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
                title={ts.analyzeSelectedHint}
              >
                {ts.analyzeSelected(selected.size)}
              </button>
              <button
                type="button"
                onClick={() => setReanalyzeOpen((v) => !v)}
                disabled={deleting || reanalyzeBusy}
                className="text-xs px-3 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
              >
                {reanalyzeOpen
                  ? ts.bulkReanalyzeHide
                  : ts.bulkReanalyzeShow(selected.size)}
              </button>
              <button
                type="button"
                onClick={() => handleBulkBacklogStatus("order")}
                disabled={deleting || reanalyzeBusy || bulkBacklogBusy}
                title={ts.backlogActions.orderHint}
                className="text-xs px-3 py-1 rounded-md border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50"
              >
                {bulkBacklogBusy
                  ? ts.backlogActions.saving
                  : ts.backlogActions.bulkOrder(selected.size)}
              </button>
              <button
                type="button"
                onClick={() => handleBulkBacklogStatus("discarded")}
                disabled={deleting || reanalyzeBusy || bulkBacklogBusy}
                title={ts.backlogActions.discardHint}
                className="text-xs px-3 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {bulkBacklogBusy
                  ? ts.backlogActions.saving
                  : ts.backlogActions.bulkDiscard(selected.size)}
              </button>
              <button
                type="button"
                onClick={handleDeleteSelected}
                disabled={deleting || reanalyzeBusy || bulkBacklogBusy}
                className="text-xs px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? ts.deleting : ts.deleteSelected(selected.size)}
              </button>
            </div>
          </div>
          {bulkBacklogResult && (
            <div className="text-xs text-blue-800 dark:text-blue-300 pt-1 border-t border-blue-200 dark:border-blue-900/60">
              {bulkBacklogResult.error
                ? `${ts.backlogActions.saveFailed}: ${bulkBacklogResult.error}`
                : ts.backlogActions.bulkResult(
                    bulkBacklogResult.updated ?? 0,
                    bulkBacklogResult.created ?? 0,
                    bulkBacklogResult.status,
                  )}
            </div>
          )}
          {reanalyzeOpen && (
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-blue-200 dark:border-blue-900/60">
              <span className="text-xs text-blue-800 dark:text-blue-300">
                {ts.bulkReanalyzePickerLabel}
              </span>
              <select
                value={bulkProvider}
                onChange={(e) =>
                  setBulkProvider(e.target.value as AIProvider | "")
                }
                disabled={reanalyzeBusy}
                className="text-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-1 outline-none disabled:opacity-50"
              >
                <option value="">—</option>
                {(["gemini", "github_models", "openrouter"] as const).map(
                  (k) => {
                    const s = providerStatuses?.[k];
                    const credField =
                      k === "github_models"
                        ? s?.fields.token
                        : s?.fields.api_key;
                    const configured = !!(credField && credField.configured);
                    return (
                      <option key={k} value={k} disabled={!configured}>
                        {k}
                        {configured ? "" : " (not configured)"}
                      </option>
                    );
                  },
                )}
              </select>
              {(() => {
                const known = bulkProvider
                  ? (providerStatuses
                      ? bulkKnownModels[bulkProvider] || []
                      : [])
                  : [];
                const status = bulkProvider
                  ? providerStatuses?.[bulkProvider]
                  : null;
                const defaultModel =
                  status &&
                  status.fields.default_model &&
                  status.fields.default_model.configured &&
                  "value" in status.fields.default_model
                    ? status.fields.default_model.value
                    : "";
                return (
                  <select
                    value={bulkModel}
                    onChange={(e) => setBulkModel(e.target.value)}
                    disabled={
                      reanalyzeBusy ||
                      !bulkProvider ||
                      known.length === 0
                    }
                    className="text-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-1 outline-none disabled:opacity-50 font-mono w-56"
                  >
                    <option value="">
                      {defaultModel
                        ? `default · ${defaultModel}`
                        : known.length === 0
                          ? "no models in registry"
                          : "default"}
                    </option>
                    {known
                      .filter((m) => m !== defaultModel)
                      .map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                  </select>
                );
              })()}
              <button
                type="button"
                onClick={handleBulkReanalyze}
                disabled={reanalyzeBusy || !bulkProvider}
                className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reanalyzeBusy
                  ? ts.bulkReanalyzeRunning
                  : ts.bulkReanalyzeSubmit(selected.size)}
              </button>
              {reanalyzeResult && (
                <span className="text-xs text-blue-800 dark:text-blue-300">
                  {ts.bulkReanalyzeResult(
                    reanalyzeResult.started,
                    reanalyzeResult.skipped,
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {reanalyzeError && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {reanalyzeError}
        </div>
      )}
      {deleteError && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {deleteError}
        </div>
      )}
      {deleteSummary && (
        <div className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 flex items-center justify-between gap-3">
          <span>
            {ts.deleteSummary(
              deleteSummary.rds,
              deleteSummary.runs,
              deleteSummary.jobs,
            )}
          </span>
          <button
            type="button"
            onClick={() => setDeleteSummary(null)}
            className="text-xs hover:underline opacity-70"
          >
            ×
          </button>
        </div>
      )}

      {search.paged.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.noMatch}
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
                <th className="px-3 py-2 font-medium">{ts.cols.domain}</th>
                <th className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    onClick={() =>
                      setVerdictSort((cur) =>
                        cur === "desc" ? "asc" : cur === "asc" ? null : "desc",
                      )
                    }
                    className="inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400"
                    title={ts.cols.verdictSortHint}
                  >
                    {ts.cols.verdict}
                    <span className="text-xs opacity-70 w-3 inline-block text-left">
                      {verdictSort === "desc"
                        ? "↓"
                        : verdictSort === "asc"
                          ? "↑"
                          : ""}
                    </span>
                  </button>
                </th>
                <th className="px-3 py-2 font-medium">{ts.cols.wayback}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.language}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.theme}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.category}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.provider}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.note}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.backlog}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.criteria}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.runs}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.pin}</th>
              </tr>
            </thead>
            <tbody>
              {search.paged.map((r) => (
                <DomainListRow
                  key={r.domain}
                  row={r}
                  selected={selected.has(r.domain)}
                  onToggle={() => toggleOne(r.domain)}
                  pinBusy={pinBusy.has(r.domain)}
                  pinError={pinError[r.domain]}
                  onPin={(rdId) => handlePin(r.domain, rdId)}
                  onUnpin={() => handleUnpin(r.domain)}
                  onBacklogUpdated={() => reload({ silent: true })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PaginationBottomBar state={search} />
    </div>
  );
}

function DomainListRow({
  row,
  selected,
  onToggle,
  pinBusy,
  pinError,
  onPin,
  onUnpin,
  onBacklogUpdated,
}: {
  row: DatabaseDomainRow;
  selected: boolean;
  onToggle: () => void;
  pinBusy: boolean;
  pinError: string | undefined;
  onPin: (runDomainId: number) => void;
  onUnpin: () => void;
  onBacklogUpdated: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.database;

  const href =
    row.is_pinned &&
    row.pinned_job_id != null &&
    row.pinned_run_id != null &&
    row.pinned_run_domain_id != null
      ? `/jobs/${row.pinned_job_id}/runs/${row.pinned_run_id}/domains/${row.pinned_run_domain_id}`
      : null;

  const bucket: FinalBucket | null = isBucket(row.final_bucket)
    ? row.final_bucket
    : labelToBucket(row.final_summary);
  const score = row.final_score;
  const confidence = row.final_confidence;
  const verdictTone = bucket
    ? pillToneWithConfidence(bucket, confidence)
    : "";

  // Single-letter criteria pills for the Criteria column — matches the
  // run-page abbreviations (B/D/A/K) so a B in either table refers to
  // the same criterion. Tooltip carries the full criterion name + row
  // count. Green tone signals "data fetched" (the Database page sources
  // from the pinned rd, which is by definition `done` — there's no
  // failed/pending state to render here, so a single tone is enough).
  const CRITERIA_LETTERS = [
    ["backlinks", "B"],
    ["refdomains", "D"],
    ["anchors", "A"],
    ["keywords", "K"],
  ] as const;
  const enabledCriteriaPills = CRITERIA_LETTERS.filter(
    ([k]) => row.criteria[k]?.enabled,
  ).map(([k, letter]) => ({
    key: k,
    letter,
    rows: row.criteria[k].rows,
    fullName: t.pages.analyze.criteria[k],
  }));

  const finishedAt = row.pinned_finished_at
    ? new Date(row.pinned_finished_at).toLocaleString()
    : "—";

  return (
    <tr
      // `content-visibility: auto` lets the browser skip layout +
      // paint work for rows that are scrolled offscreen — real perf
      // win once the table grows past a viewport-worth of rows. Zero
      // behavior change at small sizes (the property is a hint,
      // browsers without support ignore it). `contain-intrinsic-size`
      // reserves a placeholder height so the scrollbar doesn't jump
      // around as rows render/unrender. ~80 px is a reasonable
      // estimate for a typical row with criteria pills + notes.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 80px" }}
      className={`border-t dark:border-neutral-800 ${
        selected
          ? "bg-blue-50/70 dark:bg-blue-950/30"
          : row.is_pinned
            ? "hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
            : "bg-neutral-50/40 dark:bg-neutral-900/30 hover:bg-neutral-100 dark:hover:bg-neutral-900/60"
      }`}
    >
      <td className="px-3 py-2 align-top">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.domain}`}
          className="cursor-pointer"
        />
      </td>
      <td className="px-3 py-2 align-top">
        {href ? (
          <Link
            href={href}
            className="font-mono text-blue-600 dark:text-blue-400 hover:underline break-all"
          >
            {row.domain}
          </Link>
        ) : (
          <span className="font-mono text-neutral-700 dark:text-neutral-300 break-all">
            {row.domain}
          </span>
        )}
        {row.is_pinned && (
          <span
            className="ml-1.5 text-amber-600 dark:text-amber-400"
            title={ts.pin.pinnedHint}
          >
            ★
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            —
          </span>
        ) : row.final_partial ? (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
            title={ts.partialTooltip}
          >
            {ts.partialBadge}
          </span>
        ) : bucket ? (
          row.pinned_run_domain_id != null ? (
            <VerdictHoverCard
              runDomainId={row.pinned_run_domain_id}
              mode="final"
            >
              <span
                className={`text-xs px-2 py-0.5 rounded-full cursor-help ${verdictTone}`}
                title={(() => {
                  const base =
                    score != null
                      ? `Score ${formatScore(score)} · bucket ${bucket}`
                      : bucket;
                  if (confidence == null) return base;
                  const conf = `${Math.round(confidence * 100)}% confidence`;
                  const note = isLowConfidence(confidence)
                    ? " (low — greyed)"
                    : "";
                  return `${base} · ${conf}${note}`;
                })()}
              >
                {score != null ? formatScore(score) : bucket}
              </span>
            </VerdictHoverCard>
          ) : (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${verdictTone}`}
              title={bucket}
            >
              {score != null ? formatScore(score) : bucket}
            </span>
          )
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {ts.noVerdict}
          </span>
        )}
        {row.is_pinned && row.any_cached && (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-400">
            {ts.cachedTag}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            —
          </span>
        ) : row.wayback_assessment ? (
          row.pinned_run_domain_id != null ? (
            <VerdictHoverCard
              runDomainId={row.pinned_run_domain_id}
              mode="criterion"
              criterion="wayback"
            >
              <span
                className={`text-xs px-2 py-0.5 rounded-full cursor-help ${criterionPillTone(
                  row.wayback_assessment,
                  row.wayback_confidence,
                )}`}
                title={(() => {
                  const a = row.wayback_assessment;
                  const c = row.wayback_confidence;
                  const conf =
                    c != null
                      ? ` · ${Math.round(c * 100)}% confidence${
                          isLowConfidence(c) ? " (low — greyed)" : ""
                        }`
                      : "";
                  return `Wayback: ${a}${conf}`;
                })()}
              >
                {row.wayback_assessment.replace("_quality", "").replace(
                  "quality",
                  "good",
                )}
              </span>
            </VerdictHoverCard>
          ) : (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${criterionPillTone(
                row.wayback_assessment,
                row.wayback_confidence,
              )}`}
              title={`Wayback: ${row.wayback_assessment}`}
            >
              {row.wayback_assessment.replace("_quality", "").replace(
                "quality",
                "good",
              )}
            </span>
          )
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {ts.noVerdict}
          </span>
        )}
      </td>
      {/* Language column (wayback_classify, added 2026-05-09).
          Confidence-aware tone: HIGH (≥ LOW_CONFIDENCE_THRESHOLD) → blue
          tint so the value pops; LOW → grey so the user knows to discount
          it. Same two-tone logic as the wayback assessment column above
          (criterionPillTone), just without the assessment dimension. */}
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        ) : row.primary_language ? (
          (() => {
            const lowConf =
              row.language_confidence != null &&
              isLowConfidence(row.language_confidence);
            return (
              <span
                className={
                  "text-xs font-mono px-1.5 py-0.5 rounded " +
                  (lowConf
                    ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                    : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200")
                }
                title={(() => {
                  const sec = row.secondary_languages?.length
                    ? ` · also: ${row.secondary_languages.join(", ")}`
                    : "";
                  const conf = row.language_confidence != null
                    ? ` · ${Math.round(row.language_confidence * 100)}% confidence${lowConf ? " (low — greyed)" : ""}`
                    : "";
                  return `${row.primary_language}${sec}${conf}`;
                })()}
              >
                {row.primary_language}
                {row.secondary_languages?.length > 0 && (
                  <span className="ml-0.5 opacity-60">+{row.secondary_languages.length}</span>
                )}
              </span>
            );
          })()
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      {/* Theme column — same confidence-aware tone. High = full text color,
          low = muted (and italicized for an extra cue since theme is
          freeform, not a short code). */}
      <td className="px-3 py-2 align-top max-w-[14rem]">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        ) : row.primary_theme ? (
          (() => {
            const lowConf =
              row.theme_confidence != null &&
              isLowConfidence(row.theme_confidence);
            return (
              <div
                className={
                  "text-xs " +
                  (lowConf
                    ? "text-neutral-500 dark:text-neutral-400 italic"
                    : "text-neutral-900 dark:text-neutral-100")
                }
                title={(() => {
                  const sec = row.secondary_themes?.length
                    ? `\nAlso: ${row.secondary_themes.join(", ")}`
                    : "";
                  const conf = row.theme_confidence != null
                    ? `\n${Math.round(row.theme_confidence * 100)}% confidence${lowConf ? " (low — muted)" : ""}`
                    : "";
                  return `${row.primary_theme}${sec}${conf}`;
                })()}
              >
                <span className="break-words">{row.primary_theme}</span>
                {row.classify_drift_detected && (
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
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      {/* Category column */}
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        ) : row.category ? (
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              row.category === "other"
                ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                : "bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100"
            }`}
            title={(() => {
              const conf = row.category_confidence != null
                ? ` · ${Math.round(row.category_confidence * 100)}%`
                : "";
              const was = row.category_was
                ? ` · was: ${row.category_was}`
                : "";
              return `${row.category}${conf}${was}`;
            })()}
          >
            {row.category}
            {row.category_was && (
              <span className="ml-1 opacity-70">← {row.category_was}</span>
            )}
          </span>
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {row.is_pinned && row.ai_provider ? (
          <div className="text-xs">
            <div className="font-medium">{row.ai_provider}</div>
            {row.ai_model && (
              <div className="text-neutral-500 dark:text-neutral-400 break-all">
                {row.ai_model}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {row.is_pinned ? ts.noProvider : "—"}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {row.note ? (
          <div
            className="max-w-[18rem] text-neutral-700 dark:text-neutral-200 line-clamp-3 whitespace-pre-wrap break-all"
            title={row.note}
          >
            {row.note}
          </div>
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <BacklogActionsCell
          domain={row.domain}
          backlogStatus={row.backlog_status}
          onUpdated={onBacklogUpdated}
        />
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {row.is_pinned ? (
          enabledCriteriaPills.length === 0 ? (
            <span className="text-neutral-400 dark:text-neutral-500">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {enabledCriteriaPills.map(({ key, letter, rows, fullName }) => (
                <span
                  key={key}
                  className="text-xs px-1.5 py-0.5 rounded font-medium tabular-nums bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                  title={`${fullName} (${rows.toLocaleString()})`}
                >
                  {letter}
                </span>
              ))}
            </div>
          )
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="text-xs">
          <span className="font-medium">{ts.runsBadge(row.total_runs)}</span>
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="text-xs space-y-1">
          <PinSelect
            row={row}
            pinBusy={pinBusy}
            onPin={onPin}
            ts={ts}
          />
          {row.is_pinned && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-neutral-500 dark:text-neutral-400">
                {finishedAt}
              </span>
              <button
                type="button"
                onClick={onUnpin}
                disabled={pinBusy}
                className="text-[11px] px-1.5 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {pinBusy ? ts.pin.unpinning : ts.pin.unpin}
              </button>
            </div>
          )}
          {pinError && (
            <div className="text-red-600 dark:text-red-400">
              {ts.pin.pinFailed}: {pinError}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// Lazy-loading pin dropdown. The /database/domains response only sends
// pin_options_count to keep the payload small; we fetch the full list
// on first focus/click of the select. After load it's cached on the
// component so toggling stays snappy.
function PinSelect({
  row,
  pinBusy,
  onPin,
  ts,
}: {
  row: DatabaseDomainRow;
  pinBusy: boolean;
  onPin: (runDomainId: number) => void;
  ts: ReturnType<typeof useT>["t"]["pages"]["database"];
}) {
  const [options, setOptions] = useState<
    | null
    | { run_domain_id: number; run_id: number; run_name: string; status: string }[]
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ensureLoaded() {
    if (options !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getDomainPinOptions(row.domain);
      setOptions(r.options);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Pre-render: just the currently-pinned option as a synthetic entry
  // so the select shows the active selection without a network call.
  // After loading, the full list takes over.
  const renderOptions = options ?? (
    row.is_pinned && row.pinned_run_domain_id != null
      ? [{
          run_domain_id: row.pinned_run_domain_id,
          run_id: row.pinned_run_id ?? 0,
          run_name: row.pinned_run_name,
          status: "done",
        }]
      : []
  );

  return (
    <>
      <select
        value={row.pinned_run_domain_id ?? ""}
        disabled={pinBusy || row.pin_options_count === 0}
        onMouseDown={() => void ensureLoaded()}
        onFocus={() => void ensureLoaded()}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const id = parseInt(v, 10);
          if (Number.isFinite(id)) onPin(id);
        }}
        className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-1 outline-none disabled:opacity-50 max-w-[16rem]"
        title={row.is_pinned ? ts.pin.pinnedHint : ts.pin.notPinnedHint}
      >
        {!row.is_pinned && (
          <option value="">{ts.pin.pickPlaceholder}</option>
        )}
        {renderOptions.map((o) => (
          <option key={o.run_domain_id} value={o.run_domain_id}>
            {ts.pin.runOption(o.run_id, o.run_name, o.status)}
          </option>
        ))}
      </select>
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
    </>
  );
}
