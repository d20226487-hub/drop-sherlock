"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  AIProvider,
  AvailabilityStatus,
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

// Helper: wrap children in a Next Link when href is non-null, otherwise
// pass through. Used by the Database-page verdict cells so each cell
// navigates to the rd that actually supplied its data (per-criterion
// source rd, post-2026-05-12). Returning `<Link>{children}</Link>`
// inherits the link's tab + accessibility behavior; when href is null
// the cell stays static.
function MaybeLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <Link href={href} className="hover:underline">
      {children}
    </Link>
  );
}

// Confidence-threshold slider (added 2026-05-15 iteration). Replaces
// the prior text/number input for Wayback/Ahrefs confidence filters.
// Range [0, 1] with 0.05 step; 0 = filter off. The track + thumb gets
// blue tint when active (>0), grey when off. The right-hand label
// shows either the current % (when active) or the off-label.
// Clicking the small × clears in one tap. Keyboard arrows move the
// thumb in 5%-steps (native range input behavior).
function ConfidenceSlider({
  label,
  title,
  offLabel,
  value,
  onChange,
}: {
  label: string;
  title: string;
  offLabel: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const active = value > 0;
  return (
    <label
      className="flex items-center gap-2 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm cursor-pointer"
      title={title}
    >
      <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={
          "flex-1 min-w-[5rem] h-1.5 cursor-pointer accent-blue-600 " +
          (active ? "" : "opacity-60")
        }
        aria-label={label}
      />
      <span
        className={
          "text-xs font-mono shrink-0 w-9 text-right " +
          (active
            ? "text-blue-700 dark:text-blue-300 font-medium"
            : "text-neutral-400 dark:text-neutral-500")
        }
      >
        {active ? `${Math.round(value * 100)}%` : offLabel}
      </span>
      {active && (
        <button
          type="button"
          onClick={(e) => {
            // Prevent the label click from re-firing onto the slider.
            e.preventDefault();
            e.stopPropagation();
            onChange(0);
          }}
          aria-label={`Clear ${label}`}
          className="text-xs text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 leading-none px-0.5"
        >
          ×
        </button>
      )}
    </label>
  );
}

const CRITERIA_KEYS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  "wayback",
  // Added 2026-05-15: classify (wayback_classify) and Whois are
  // selectable in the "Any criterion" multi-select so the user can
  // narrow to rows that ran them. Availability is NOT here — it's not
  // a CR-row criterion, so it gets its own filter dropdown below.
  "wayback_classify",
  "whois_history",
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
  const [whoisBands, setWhoisBands] = useState<string[]>([]);
  // Availability filter (added 2026-05-15) — separate from the
  // criterion multi-select because availability isn't a CR-row
  // criterion. Values: "available"/"registered"/"unknown"/"error"
  // plus "__none__" for "never checked." Matches against the
  // domain's entry in `availabilityByDomain` (hydrated post-fetch).
  const [availabilityFilter, setAvailabilityFilter] = useState<string[]>([]);
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
  // Confidence thresholds (added 2026-05-13; iterated to slider UX
  // 2026-05-15). 0 = "no filter". Rows with null confidence (no
  // verdict, partial final stub, etc.) are excluded when the min is
  // > 0 — they can't meet a threshold by definition.
  //
  // Slider over text/number input: a numeric input forced operators
  // to think in absolute confidence percents and made decimals
  // awkward (the prior `value={n||""}` text shape broke 0→"" round-
  // trip when typing "0.7"). A slider makes the gesture "drag right
  // for stricter, all the way left for off" obvious, keeps keyboard
  // accessibility (arrows), and the live badge on the right shows
  // the current threshold as a %.
  const [waybackConfMin, setWaybackConfMin] = useState<number>(0);
  const [ahrefsConfMin, setAhrefsConfMin] = useState<number>(0);

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

  // pinBusy / pinError were removed 2026-05-14 alongside the dead
  // PinSelect — see the PinSelect-removed comment near the bottom of
  // the file.

  const [verdictSort, setVerdictSort] = useState<"asc" | "desc" | null>(null);
  // Whois sort cycles the OPPOSITE direction first (asc = stable on top,
  // since low dropped_confidence is "good"). Mutually exclusive with
  // verdictSort — clicking one clears the other so the table has a
  // single active sort signal.
  const [whoisSort, setWhoisSort] = useState<"asc" | "desc" | null>(null);

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

  // Availability cascade results, keyed by domain. Hydrated alongside
  // the database rows in `reload()`, refreshed per-row by the recheck
  // button. Domains absent from the map render the Availability cell
  // as "—" (never checked).
  const [availabilityByDomain, setAvailabilityByDomain] = useState<
    Record<
      string,
      {
        status: AvailabilityStatus;
        provider: string;
        registrar: string;
        expires_on: string | null;
        checked_at: string | null;
      }
    >
  >({});
  const [recheckBusy, setRecheckBusy] = useState<Set<string>>(new Set());

  async function handleRecheckAvailability(domain: string) {
    setRecheckBusy((prev) => new Set(prev).add(domain));
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
      // Errors land on the Errors page via the backend log handler.
      // Surface nothing here — the user can retry from the same button.
    } finally {
      setRecheckBusy((prev) => {
        const next = new Set(prev);
        next.delete(domain);
        return next;
      });
    }
  }

  async function handleBulkRecheck() {
    const domains = Array.from(selected);
    if (domains.length === 0) return;
    setRecheckBusy((prev) => {
      const next = new Set(prev);
      for (const d of domains) next.add(d);
      return next;
    });
    try {
      const r = await api.bulkCheckAvailability(domains, false);
      setAvailabilityByDomain((prev) => {
        const next = { ...prev };
        for (const item of r.items) {
          next[item.domain] = {
            status: item.status,
            provider: item.provider,
            registrar: item.registrar,
            expires_on: item.expires_on,
            checked_at: new Date().toISOString(),
          };
        }
        return next;
      });
    } catch {
      // Same: errors land on /errors.
    } finally {
      setRecheckBusy(new Set());
    }
  }

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
          // Hydrate availability column from the cache history. One
          // read per refresh — never spawns a fresh cascade. Domains
          // with no cached row stay rendered as "—".
          const domains = d.rows.map((r) => r.domain);
          if (domains.length > 0) {
            api
              .latestAvailability(domains)
              .then((rows) => {
                if (cancelled) return;
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
                // Non-fatal; column just stays empty.
              });
          }
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

  // handlePin / handleUnpin were removed 2026-05-14 alongside the dead
  // PinSelect — see the PinSelect-removed comment near the bottom of
  // the file. Pin management now lives on the Run page (per-criterion
  // pins panel) and the Job page (read-only widget).

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
    function matchWhois(r: DatabaseDomainRow): boolean {
      if (whoisBands.length === 0) return true;
      return whoisBands.some((v) => {
        if (v === "__none__") return !r.whois_band;
        return r.whois_band === v;
      });
    }
    function matchAvailability(r: DatabaseDomainRow): boolean {
      if (availabilityFilter.length === 0) return true;
      const avail = availabilityByDomain[r.domain];
      return availabilityFilter.some((v) => {
        if (v === "__none__") return !avail;
        return !!avail && avail.status === v;
      });
    }
    return data.rows.filter((r) => {
      if (pinFilter === "pinned" && !r.is_pinned) return false;
      if (pinFilter === "unpinned" && r.is_pinned) return false;
      if (!matchVerdict(r)) return false;
      if (!matchWayback(r)) return false;
      if (!matchWhois(r)) return false;
      if (!matchAvailability(r)) return false;
      if (!matchLang(r)) return false;
      if (!matchCat(r)) return false;
      // Confidence thresholds (added 2026-05-13). null verdicts are
      // excluded when the threshold is > 0 — a row without a verdict
      // can't be "above 0.7 confidence" by any meaningful definition.
      if (waybackConfMin > 0) {
        if (
          typeof r.wayback_confidence !== "number" ||
          r.wayback_confidence < waybackConfMin
        ) {
          return false;
        }
      }
      if (ahrefsConfMin > 0) {
        if (
          typeof r.final_confidence !== "number" ||
          r.final_confidence < ahrefsConfMin
        ) {
          return false;
        }
      }
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
    whoisBands,
    availabilityFilter,
    availabilityByDomain,
    languages,
    categories,
    provider,
    model,
    criteria,
    cache,
    notesFilter,
    minRecords,
    waybackConfMin,
    ahrefsConfMin,
  ]);

  const sorted = useMemo<DatabaseDomainRow[]>(() => {
    if (verdictSort) {
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
    }
    if (whoisSort) {
      // Whois sort: rows WITH a Whois verdict on top, rest sink. Within
      // the verdict set, ascending puts the lowest dropped_confidence
      // (most stable) first — that's the "good first" direction.
      const dir = whoisSort === "asc" ? 1 : -1;
      function hasVerdict(r: DatabaseDomainRow): boolean {
        return typeof r.whois_dropped_confidence === "number";
      }
      return [...filtered].sort((a, b) => {
        const aHas = hasVerdict(a);
        const bHas = hasVerdict(b);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (!aHas && !bHas) return a.domain.localeCompare(b.domain);
        const ra = a.whois_dropped_confidence as number;
        const rb = b.whois_dropped_confidence as number;
        if (ra === rb) return a.domain.localeCompare(b.domain);
        return (ra - rb) * dir;
      });
    }
    return filtered;
  }, [filtered, verdictSort, whoisSort]);

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

  // Bulk-ban (added 2026-05-13 wave L). Sends the selected rows to the
  // ban list via the /database/domains/bulk-ban endpoint, which reuses
  // the same normalization as the rest of the app. Existing
  // BacklogDomain rows are untouched per design call (a).
  const [bulkBanBusy, setBulkBanBusy] = useState(false);
  const [bulkBanResult, setBulkBanResult] = useState<{
    added: number;
    already: number;
    invalid: number;
    error?: string;
  } | null>(null);
  async function handleBulkBan() {
    if (selected.size === 0 || bulkBanBusy) return;
    const list = Array.from(selected);
    if (!window.confirm(ts.bulkBanConfirm(list.length))) return;
    setBulkBanBusy(true);
    setBulkBanResult(null);
    try {
      const r = await api.bulkBanFromDatabase(list);
      setBulkBanResult({
        added: r.added,
        already: r.already_banned,
        invalid: r.invalid,
      });
      reload({ silent: true });
    } catch (e) {
      setBulkBanResult({
        added: 0,
        already: 0,
        invalid: 0,
        error: (e as Error).message || "bulk-ban failed",
      });
    } finally {
      setBulkBanBusy(false);
    }
  }

  function clearFilters() {
    setVerdicts([]);
    setWaybackVerdicts([]);
    setWhoisBands([]);
    setAvailabilityFilter([]);
    setLanguages([]);
    setCategories([]);
    setProvider("");
    setModel("");
    setCriteria([]);
    setCache("any");
    setNotesFilter("any");
    setPinFilter("any");
    setMinRecords(0);
    setWaybackConfMin(0);
    setAhrefsConfMin(0);
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
        header: "whois_dropped_confidence",
        get: (r) => r.whois_dropped_confidence ?? "",
      },
      {
        header: "whois_transferred_confidence",
        get: (r) => r.whois_transferred_confidence ?? "",
      },
      { header: "whois_band", get: (r) => r.whois_band || "" },
      { header: "whois_summary", get: (r) => r.whois_summary || "" },
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
    whoisBands.length > 0 ||
    availabilityFilter.length > 0 ||
    languages.length > 0 ||
    categories.length > 0 ||
    !!provider ||
    !!model ||
    criteria.length > 0 ||
    cache !== "any" ||
    notesFilter !== "any" ||
    pinFilter !== "any" ||
    minRecords > 0 ||
    waybackConfMin > 0 ||
    ahrefsConfMin > 0;

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
            label={ts.filters.verdictWhoisLabel}
            anyLabel={ts.filters.verdictWhoisAny}
            value={whoisBands}
            onChange={setWhoisBands}
            title={ts.filters.verdictWhoisHint}
            disabled={(opts.whois_bands || []).length === 0}
            options={[
              // Always show the full stable → insufficient → mixed →
              // dropped scale so the user sees the spectrum even when
              // current data only covers a subset. The dropdown is
              // disabled at the parent level when no bands exist at
              // all; once any verdict lands, the user wants to see all
              // four threshold ranges.
              ...(["stable", "insufficient", "mixed", "dropped"] as const)
                .map((b) => ({
                  value: b,
                  label:
                    b === "stable"
                      ? ts.filters.verdictWhoisStable
                      : b === "insufficient"
                        ? ts.filters.verdictWhoisInsufficient
                        : b === "mixed"
                          ? ts.filters.verdictWhoisMixed
                          : ts.filters.verdictWhoisDropped,
                })),
              {
                value: "__none__",
                label: ts.filters.verdictWhoisNone,
                group: "tail" as const,
              },
            ]}
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

          <ConfidenceSlider
            label={ts.filters.waybackConfMin}
            title={ts.filters.waybackConfMinHelp}
            offLabel={ts.filters.confSliderOff}
            value={waybackConfMin}
            onChange={setWaybackConfMin}
          />
          <ConfidenceSlider
            label={ts.filters.ahrefsConfMin}
            title={ts.filters.ahrefsConfMinHelp}
            offLabel={ts.filters.confSliderOff}
            value={ahrefsConfMin}
            onChange={setAhrefsConfMin}
          />
        </div>
        {/* Filtered count under the filter grid (added 2026-05-15).
            Only renders when filters are active — when nothing is
            filtered, "X of X" is just noise. Pagination footer still
            shows the overall total. */}
        {filtersActive && (
          <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 pt-1">
            <span>
              {ts.filters.matchedCount(
                filtered.length,
                data?.rows.length ?? 0,
              )}
            </span>
            {filtered.length === 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                · {ts.filters.matchedCountEmpty}
              </span>
            )}
          </div>
        )}
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
                  //
                  // Additionally pass `source_job_id` — the dominant
                  // job that produced the selected rows' WAYBACK
                  // criterion (added 2026-05-13). Wayback's
                  // `params_hash` is the cache-key-critical config for
                  // this workflow; pre-filling the form from this
                  // source job's spec guarantees the cache hits
                  // instead of the user accidentally setting a
                  // different limit / sample_pages / sample_count and
                  // missing cache on every domain.
                  const list = Array.from(selected);
                  if (list.length === 0) return;
                  // Comma-separated; domains can't contain commas.
                  // encodeURIComponent handles any unicode/IDN domains.
                  const param = encodeURIComponent(list.join(","));
                  // Dominant wayback source job: count source_job_id
                  // per selected row, pick the highest. Tie-break by
                  // greatest source_run_id (most recent). Rows without
                  // a wayback source (criterion not yet analyzed)
                  // contribute nothing.
                  const counts = new Map<number, { n: number; maxRun: number }>();
                  if (data) {
                    for (const r of data.rows) {
                      if (!selected.has(r.domain)) continue;
                      const wb = r.criteria?.wayback;
                      const jid = wb?.source_job_id;
                      const rid = wb?.source_run_id;
                      if (typeof jid !== "number") continue;
                      const cur = counts.get(jid) ?? { n: 0, maxRun: 0 };
                      cur.n += 1;
                      if (typeof rid === "number" && rid > cur.maxRun) {
                        cur.maxRun = rid;
                      }
                      counts.set(jid, cur);
                    }
                  }
                  let dominantJobId: number | null = null;
                  let bestN = 0;
                  let bestRun = 0;
                  for (const [jid, { n, maxRun }] of counts) {
                    if (
                      n > bestN ||
                      (n === bestN && maxRun > bestRun)
                    ) {
                      dominantJobId = jid;
                      bestN = n;
                      bestRun = maxRun;
                    }
                  }
                  let url = `/analyze?domains=${param}&cross_cache=1`;
                  if (dominantJobId !== null) {
                    url += `&source_job_id=${dominantJobId}`;
                  }
                  router.push(url);
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
                onClick={handleBulkBan}
                disabled={deleting || reanalyzeBusy || bulkBacklogBusy || bulkBanBusy}
                title={ts.bulkBanHint}
                className="text-xs px-3 py-1 rounded-md border border-rose-400 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                {bulkBanBusy ? ts.bulkBanBusy : ts.bulkBan(selected.size)}
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
          {bulkBanResult && (
            <div className="text-xs text-rose-800 dark:text-rose-300 pt-1 border-t border-rose-200 dark:border-rose-900/60">
              {bulkBanResult.error
                ? `${ts.bulkBanFailed}: ${bulkBanResult.error}`
                : ts.bulkBanResult(
                    bulkBanResult.added,
                    bulkBanResult.already,
                    bulkBanResult.invalid,
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
                    onClick={() => {
                      setWhoisSort(null);
                      setVerdictSort((cur) =>
                        cur === "desc" ? "asc" : cur === "asc" ? null : "desc",
                      );
                    }}
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
                <th className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    onClick={() => {
                      setVerdictSort(null);
                      // Whois cycle starts with asc (stable on top — the
                      // "good first" direction for drop-confidence).
                      setWhoisSort((cur) =>
                        cur === "asc" ? "desc" : cur === "desc" ? null : "asc",
                      );
                    }}
                    className="inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400"
                    title={ts.cols.whoisSortHint}
                  >
                    {ts.cols.whois}
                    <span className="text-xs opacity-70 w-3 inline-block text-left">
                      {whoisSort === "asc"
                        ? "↑"
                        : whoisSort === "desc"
                          ? "↓"
                          : ""}
                    </span>
                  </button>
                </th>
                <th className="px-3 py-2 font-medium">{ts.cols.wayback}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.language}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.theme}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.category}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.note}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.backlog}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.criteria}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.availability}</th>
              </tr>
            </thead>
            <tbody>
              {search.paged.map((r) => (
                <DomainListRow
                  key={r.domain}
                  row={r}
                  selected={selected.has(r.domain)}
                  onToggle={() => toggleOne(r.domain)}
                  onBacklogUpdated={() => reload({ silent: true })}
                  availability={availabilityByDomain[r.domain]}
                  recheckBusy={recheckBusy.has(r.domain)}
                  onRecheck={() => handleRecheckAvailability(r.domain)}
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
  onBacklogUpdated,
  availability,
  recheckBusy,
  onRecheck,
}: {
  row: DatabaseDomainRow;
  selected: boolean;
  onToggle: () => void;
  onBacklogUpdated: () => void;
  availability?: {
    status: AvailabilityStatus;
    provider: string;
    registrar: string;
    expires_on: string | null;
    checked_at: string | null;
  };
  recheckBusy: boolean;
  onRecheck: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.database;

  // Per-criterion → rd link. Each verdict cell navigates to the rd
  // that supplied that criterion's data (added 2026-05-12). Cleaner
  // than the old single-link-on-domain-column behavior, which broke
  // down once criteria could be stitched from multiple rds.
  const hrefFor = (
    keys: readonly string[],
  ): string | null => {
    for (const k of keys) {
      const c = row.criteria[k];
      if (
        c &&
        c.source_job_id != null &&
        c.source_run_id != null &&
        c.source_run_domain_id != null
      ) {
        return `/jobs/${c.source_job_id}/runs/${c.source_run_id}/domains/${c.source_run_domain_id}`;
      }
    }
    return null;
  };
  // Final-verdict cell points at whichever Ahrefs rd we have — they're
  // the weighted ones driving the score. Falls through B → D → A → K
  // so something is linkable even if the user only pinned one.
  const finalHref = hrefFor([
    "backlinks", "refdomains", "anchors", "keywords",
  ]);
  const waybackHref = hrefFor(["wayback"]);
  const classifyHref = hrefFor(["wayback_classify"]);

  // Per-cell cached-data marker (added 2026-05-12). A criterion is
  // "cached" if its underlying CR reused either raw data
  // (cached_from_run_id) or an AI verdict (ai_cached_from_run_id) from
  // a prior run. The row-level any_cached badge was confusing once
  // criteria could be sourced from different runs — e.g. a fresh
  // Ahrefs pin alongside a stale-cached Wayback pin would tag the
  // whole row as cached even though the score itself was fresh. Now
  // each verdict cell decides for itself.
  const cachedFor = (keys: readonly string[]): boolean => {
    for (const k of keys) {
      const c = row.criteria[k];
      if (
        c &&
        (c.cached_from_run_id != null || c.ai_cached_from_run_id != null)
      ) {
        return true;
      }
    }
    return false;
  };
  const finalCached = cachedFor([
    "backlinks", "refdomains", "anchors", "keywords",
  ]);
  const waybackCached = cachedFor(["wayback"]);
  const classifyCached = cachedFor(["wayback_classify"]);

  const bucket: FinalBucket | null = isBucket(row.final_bucket)
    ? row.final_bucket
    : labelToBucket(row.final_summary);
  const score = row.final_score;
  const confidence = row.final_confidence;
  const verdictTone = bucket
    ? pillToneWithConfidence(bucket, confidence)
    : "";

  // Single-letter criteria pills for the Criteria column — matches the
  // run-page + pin-panel letter scheme so a `B` in either place refers
  // to the same criterion. Tooltip carries the full criterion name +
  // row count + source-run badge. Green tone signals "data fetched"
  // (the Database page sources from a pinned/fallback rd, which is by
  // definition `done` — there's no failed/pending state to render
  // here, so a single tone is enough).
  //
  // Pre-2026-05-15 this list was just B/D/A/K because Wayback /
  // Classify / Whois had dedicated columns. Now expanded to include
  // W (Wayback fetched), C (wayback_classify ran), and H (Whois
  // history collected) so the operator can see at a glance which
  // pillars touched a row — even when the dedicated columns are
  // empty for that row (e.g. a Whois-only row still gets H here).
  // Availability lives in its own dedicated column + filter and isn't
  // a CR-criterion to the operator's mental model, so it's NOT shown
  // here.
  const CRITERIA_LETTERS = [
    ["backlinks", "B"],
    ["refdomains", "D"],
    ["anchors", "A"],
    ["keywords", "K"],
    ["wayback", "W"],
    ["wayback_classify", "C"],
    ["whois_history", "H"],
  ] as const;
  const enabledCriteriaPills = CRITERIA_LETTERS.filter(
    ([k]) => row.criteria[k]?.enabled,
  ).map(([k, letter]) => ({
    key: k,
    letter,
    rows: row.criteria[k].rows,
    fullName: t.pages.analyze.criteria[k],
    sourceRunId: row.criteria[k].source_run_id ?? null,
    sourceJobName: row.criteria[k].source_job_name ?? "",
    sourceRunName: row.criteria[k].source_run_name ?? "",
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
        <span className="font-mono text-neutral-700 dark:text-neutral-300 break-all">
          {row.domain}
        </span>
        {row.is_banned && (
          <span
            className="ml-2 inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
            title={ts.bannedBadgeHint}
          >
            {ts.bannedBadge}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            —
          </span>
        ) : row.final_partial && score == null ? (
          // No score available → render whichever cause applies. Failed
          // takes precedence (red, error condition); underweight is the
          // milder "subset" badge (amber). Tooltip uses the cause-
          // appropriate text so the user knows what's missing rather
          // than what's present.
          (() => {
            const LETTERS: Record<string, string> = {
              backlinks: "B",
              refdomains: "D",
              anchors: "A",
              keywords: "K",
              wayback: "W",
              wayback_classify: "C",
              whois_history: "H",
              availability: "V",
            };
            const lettersFor = (xs?: string[]) =>
              (xs ?? []).map((c) => LETTERS[c] ?? c).join(", ");
            if (row.final_failed) {
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200"
                  title={ts.failedTooltip}
                >
                  {ts.failedBadge}
                </span>
              );
            }
            if (row.final_underweight) {
              const missing = lettersFor(row.missing_weighted_criteria);
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                  title={
                    missing
                      ? ts.underweightMissing(missing)
                      : ts.underweightTooltip
                  }
                >
                  {ts.underweightBadge}
                </span>
              );
            }
            // Fallback: legacy combined partial (e.g. an old row without
            // the split fields). Tooltip still names what IS pinned —
            // we don't know which side caused it.
            return (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
                title={
                  row.pinned_criteria && row.pinned_criteria.length > 0
                    ? ts.partialFromCriteria(lettersFor(row.pinned_criteria))
                    : ts.partialTooltip
                }
              >
                {ts.partialBadge}
              </span>
            );
          })()
        ) : bucket ? (
          row.pinned_run_domain_id != null ? (
            <MaybeLink href={finalHref}>
            <VerdictHoverCard
              runDomainId={row.pinned_run_domain_id}
              mode="final"
            >
              <span
                className={`text-xs px-2 py-0.5 rounded-full cursor-help ${verdictTone} ${row.final_failed ? "ring-1 ring-dashed ring-red-400 dark:ring-red-500" : row.final_underweight ? "ring-1 ring-dashed ring-amber-400 dark:ring-amber-500" : row.final_partial ? "ring-1 ring-dashed ring-neutral-400 dark:ring-neutral-500" : ""}`}
                title={(() => {
                  const LETTERS: Record<string, string> = {
                    backlinks: "B",
                    refdomains: "D",
                    anchors: "A",
                    keywords: "K",
                    wayback: "W",
                    wayback_classify: "C",
                    whois_history: "H",
                    availability: "V",
                  };
                  const lettersFor = (xs?: string[]) =>
                    (xs ?? []).map((c) => LETTERS[c] ?? c).join(", ");
                  const base =
                    score != null
                      ? `Score ${formatScore(score)} · bucket ${bucket}`
                      : bucket;
                  const parts: string[] = [base];
                  if (confidence != null) {
                    const conf = `${Math.round(confidence * 100)}% confidence`;
                    const note = isLowConfidence(confidence)
                      ? " (low — greyed)"
                      : "";
                    parts.push(`${conf}${note}`);
                  }
                  // Cause-specific tooltip line. Failed wins over
                  // underweight when both are true.
                  if (row.final_failed) {
                    parts.push(ts.failedTooltip);
                  } else if (row.final_underweight) {
                    const missing = lettersFor(row.missing_weighted_criteria);
                    parts.push(
                      missing
                        ? ts.underweightMissing(missing)
                        : ts.underweightTooltip,
                    );
                  } else if (
                    row.final_partial &&
                    row.pinned_criteria &&
                    row.pinned_criteria.length > 0
                  ) {
                    parts.push(
                      ts.partialFromCriteria(lettersFor(row.pinned_criteria)),
                    );
                  }
                  return parts.join(" · ");
                })()}
              >
                {score != null ? formatScore(score) : bucket}
                {row.final_partial && (
                  <span
                    className={
                      "ml-0.5 " +
                      (row.final_failed
                        ? "text-red-700 dark:text-red-400"
                        : row.final_underweight
                          ? "text-amber-700 dark:text-amber-400"
                          : "opacity-70")
                    }
                    aria-label={
                      row.final_failed
                        ? ts.failedBadge
                        : row.final_underweight
                          ? ts.underweightBadge
                          : ts.partialBadge
                    }
                  >
                    *
                  </span>
                )}
              </span>
            </VerdictHoverCard>
            </MaybeLink>
          ) : (
            <MaybeLink href={finalHref}>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${verdictTone}`}
              title={bucket}
            >
              {score != null ? formatScore(score) : bucket}
              {row.final_partial && (
                <span className="ml-0.5 opacity-70">*</span>
              )}
            </span>
            </MaybeLink>
          )
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {ts.noVerdict}
          </span>
        )}
        {row.is_pinned && finalCached && (
          <span
            className="ml-2 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-400"
            title="One or more Ahrefs criteria reused data or AI verdict from a prior run"
          >
            {ts.cachedTag}
          </span>
        )}
      </td>
      {/* Whois (AI verdict) column (added 2026-05-15) — shows
          dropped_confidence as a percentage with band-based color tone
          (stable=emerald, insufficient=neutral, mixed=amber, dropped=
          rose). Mirrors the per-domain Whois view's `dropTone()` bands
          so a row reading "12%" on Database matches the green-banded
          verdict box on the per-domain page. */}
      <td className="px-3 py-2 align-top">
        {(() => {
          const drop = row.whois_dropped_confidence;
          if (typeof drop !== "number") {
            return (
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                —
              </span>
            );
          }
          const band = row.whois_band;
          const pillCls =
            band === "dropped"
              ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
              : band === "mixed"
                ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                : band === "stable"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300";
          const pct = Math.round(drop * 100);
          const whoisHref =
            row.criteria.whois_history?.source_job_id != null &&
            row.criteria.whois_history?.source_run_id != null &&
            row.criteria.whois_history?.source_run_domain_id != null
              ? `/jobs/${row.criteria.whois_history.source_job_id}/runs/${row.criteria.whois_history.source_run_id}/domains/${row.criteria.whois_history.source_run_domain_id}`
              : null;
          const xfer = row.whois_transferred_confidence;
          const titleParts = [
            `drop ${pct}%`,
            band ? `band: ${band}` : "",
            typeof xfer === "number"
              ? `transferred ${Math.round(xfer * 100)}%`
              : "",
            row.whois_summary || "",
          ].filter(Boolean);
          return (
            <MaybeLink href={whoisHref}>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${pillCls}`}
                title={titleParts.join(" · ")}
              >
                {pct}%
              </span>
            </MaybeLink>
          );
        })()}
      </td>
      <td className="px-3 py-2 align-top">
        {!row.is_pinned ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            —
          </span>
        ) : row.wayback_assessment ? (
          (row.criteria.wayback?.source_run_domain_id ??
            row.pinned_run_domain_id) != null ? (
            <MaybeLink href={waybackHref}>
            <VerdictHoverCard
              runDomainId={
                row.criteria.wayback?.source_run_domain_id ??
                row.pinned_run_domain_id!
              }
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
            </MaybeLink>
          ) : (
            <MaybeLink href={waybackHref}>
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
            </MaybeLink>
          )
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {ts.noVerdict}
          </span>
        )}
        {row.is_pinned && row.wayback_assessment && waybackCached && (
          <span
            className="ml-2 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-400"
            title="Wayback data or AI verdict reused from a prior run"
          >
            {ts.cachedTag}
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
              <MaybeLink href={classifyHref}>
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
              </MaybeLink>
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
              <MaybeLink href={classifyHref}>
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
              </MaybeLink>
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
          <MaybeLink href={classifyHref}>
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
          </MaybeLink>
        ) : (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">—</span>
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
              {enabledCriteriaPills.map(
                ({
                  key,
                  letter,
                  rows,
                  fullName,
                  sourceRunId,
                  sourceJobName,
                  sourceRunName,
                }) => {
                  const sourceSuffix = sourceRunId
                    ? `\nFrom Run #${sourceRunId}${
                        sourceRunName ? ` "${sourceRunName}"` : ""
                      }${sourceJobName ? ` (Job: ${sourceJobName})` : ""}`
                    : "";
                  return (
                    <span
                      key={key}
                      className="text-xs px-1.5 py-0.5 rounded font-medium tabular-nums bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                      title={`${fullName} (${rows.toLocaleString()})${sourceSuffix}`}
                    >
                      {letter}
                    </span>
                  );
                },
              )}
            </div>
          )
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        <AvailabilityCell
          status={availability?.status ?? null}
          provider={availability?.provider ?? ""}
          registrar={availability?.registrar ?? ""}
          expiresOn={availability?.expires_on ?? null}
          checkedAt={availability?.checked_at ?? null}
          busy={recheckBusy}
          onRecheck={onRecheck}
        />
      </td>
    </tr>
  );
}

function AvailabilityCell({
  status,
  provider,
  registrar,
  expiresOn,
  checkedAt,
  busy,
  onRecheck,
}: {
  status: AvailabilityStatus | null;
  provider: string;
  registrar: string;
  expiresOn: string | null;
  checkedAt: string | null;
  busy: boolean;
  onRecheck: () => void;
}) {
  const { t } = useT();
  const a = t.pages.availability;
  const tone = (() => {
    switch (status) {
      case "available":
        return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200";
      case "registered":
        return "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200";
      case "error":
        return "bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200";
      default:
        return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-400";
    }
  })();
  const label = (() => {
    if (status === "available") return a.statusAvailable;
    if (status === "registered") return a.statusRegistered;
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
            checkedAt
              ? a.checkedAt(new Date(checkedAt).toLocaleString())
              : null,
            provider ? a.sourceProvider(provider) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {label}
        </span>
      ) : (
        <span className="text-neutral-400 dark:text-neutral-500">—</span>
      )}
      {status === "registered" && (registrar || expiresOn) && (
        <div className="text-[11px] text-neutral-600 dark:text-neutral-400 space-y-0.5">
          {registrar && <div>{a.registrar(registrar)}</div>}
          {expiresOn && <div>{a.expiresOn(expiresOn)}</div>}
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

// PinSelect was removed 2026-05-14 — never mounted in the JSX, dead
// since the Database page was restructured to surface per-criterion
// source attribution via cell tooltips. Pin management now happens on
// the Run page's "Per-criterion pins" panel and the Job page's read-
// only pins widget.
