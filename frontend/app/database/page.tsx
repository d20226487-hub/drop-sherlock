"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  AvailabilityStatus,
  BACKLOG_STATUSES,
  BacklogStatus,
  DatabaseDomainList,
  DatabaseDomainRow,
} from "@/lib/api";
import { PaginatedSearch } from "@/lib/use-paginated-search";
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
import { EditablePriceCell, EditableTextCell } from "@/components/editable-cell";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";

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

// One-click copy-to-clipboard button next to every Database table
// domain (added 2026-05-23). 14×14 icon button; shows a 1.2s green
// flash on success, falls back to a red flash on the (rare) clipboard
// failure. navigator.clipboard.writeText is preferred; legacy fallback
// via a hidden textarea + document.execCommand("copy") covers
// sandboxed iframes / non-secure contexts (matches the ResultsTable
// clipboard pattern from the Tools pages).
function CopyDomainButton({ domain }: { domain: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  async function copy(e: React.MouseEvent) {
    // The button sits inside the same cell as the domain Link; without
    // stopPropagation a click on the icon would also navigate.
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(domain);
      } else {
        const ta = document.createElement("textarea");
        ta.value = domain;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          ta.remove();
        }
      }
      setState("ok");
    } catch {
      setState("err");
    }
    window.setTimeout(() => setState("idle"), 1200);
  }
  const tone =
    state === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : state === "err"
        ? "text-rose-600 dark:text-rose-400"
        : "text-neutral-300 dark:text-neutral-600 hover:text-blue-600 dark:hover:text-blue-400";
  return (
    <button
      type="button"
      onClick={copy}
      title={state === "ok" ? "Copied!" : `Copy ${domain}`}
      aria-label={`Copy ${domain}`}
      className={`shrink-0 leading-none px-0.5 align-baseline transition-colors ${tone}`}
    >
      {/* Two-square clipboard glyph; small enough to slot beside the
          domain text without nudging the verdict pills downstream. */}
      {state === "ok" ? "✓" : "⧉"}
    </button>
  );
}

// One-click view-only share icon next to every Database table domain
// (added 2026-05-24). Mirrors CopyDomainButton's gesture model
// (stopPropagation so click-on-icon doesn't navigate, brief flash
// feedback) but the backend call is a quick-share round-trip:
//   1. POST /database/quick-share { domain }
//   2. Server resolves rd (pinned → latest), reuses or mints a share
//      with the operator-configured default expiry.
//   3. Response URL is copied to the clipboard.
//
// Self-contained micro-toast — floats above the button for ~2.5s on
// every outcome so the operator sees "Copied" / "Reused" / "No analysis
// yet" without us having to plumb toast state through the row tree.
function QuickShareButton({ domain }: { domain: string }) {
  const { t } = useT();
  const ts = t.pages.database.quickShare;
  const [state, setState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(
    null,
  );

  async function copyToClipboard(url: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        return true;
      }
      // Sandboxed-iframe / non-secure-context fallback.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        return true;
      } finally {
        ta.remove();
      }
    } catch {
      return false;
    }
  }

  function showToast(msg: string, tone: "ok" | "err") {
    setToast({ msg, tone });
    window.setTimeout(() => setToast(null), 2500);
  }

  async function handle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await api.databaseQuickShare(domain);
      if (r.error || !r.share_url) {
        const msg = r.error.includes("no analyzed RunDomain")
          ? ts.noRd
          : `${ts.failed}: ${r.error || "unknown"}`;
        showToast(msg, "err");
        setState("err");
      } else {
        const url = `${window.location.origin}${r.share_url}`;
        const ok = await copyToClipboard(url);
        if (ok) {
          showToast(r.reused ? ts.copiedReused : ts.copiedNew, "ok");
          setState("ok");
        } else {
          showToast(`${ts.copyFailed} ${url}`, "err");
          setState("err");
        }
      }
    } catch (err) {
      showToast(
        `${ts.failed}: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
      setState("err");
    }
    window.setTimeout(() => setState("idle"), 1500);
  }

  const tone =
    state === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : state === "err"
        ? "text-rose-600 dark:text-rose-400"
        : state === "busy"
          ? "text-blue-500 dark:text-blue-400"
          : "text-neutral-300 dark:text-neutral-600 hover:text-blue-600 dark:hover:text-blue-400";

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={handle}
        title={state === "busy" ? ts.copying : ts.iconTitle}
        aria-label={ts.iconTitle}
        className={`shrink-0 leading-none px-0.5 align-baseline transition-colors ${tone}`}
      >
        {/* Link/chain glyph — distinct from the clipboard glyph next to
            it so the operator can tell the two actions apart. ✓ on
            success mirrors CopyDomainButton's success feedback. */}
        {state === "ok" ? "✓" : state === "busy" ? "…" : "🔗"}
      </button>
      {toast && (
        <span
          role="status"
          className={
            "absolute left-1/2 -translate-x-1/2 -top-7 z-10 whitespace-nowrap text-[10px] px-2 py-0.5 rounded shadow-sm border " +
            (toast.tone === "ok"
              ? "bg-emerald-50 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200"
              : "bg-rose-50 dark:bg-rose-950/80 border-rose-300 dark:border-rose-700 text-rose-800 dark:text-rose-200")
          }
        >
          {toast.msg}
        </span>
      )}
    </span>
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
  // AI provider / model / minRecords filters removed 2026-05-17 — the
  // user found them noisy and never used. The filter row stays cleaner
  // with verdict / availability / wayback / confidence / language /
  // category / pin / cache / notes / criteria multi-select doing the
  // actual narrowing work.
  const [criteria, setCriteria] = useState<CriterionKey[]>([]);
  // Cache filter + Pin filter UI removed 2026-05-23 (user-requested
  // simplification). State variables NOT re-declared — anything that
  // referenced `cache` or `pinFilter` was scrubbed from the predicate
  // + filtersActive + reset paths. localStorage still reads the
  // legacy keys (defensively) but no UI exposes them.
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("any");
  // Source filter (2026-05-17) — multi-select on BacklogDomain.registrar.
  // Same vocabulary as the Backlog page's Source filter; backend
  // populates `filter_options.sources` with the distinct universe.
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  // Backlog-status filter (2026-05-20) — multi-select on
  // BacklogDomain.status, surfaced from the joined row that already
  // hydrates `backlog_status` on every DomainRow. Vocabulary reused
  // verbatim from BACKLOG_STATUSES so the chip labels stay 1:1 with
  // the Backlog page filter (per the locked "chip/filter vocab lines
  // up 1:1" rule). Empty selection = no constraint; otherwise a row
  // passes only when its `backlog_status` is in the selected set.
  // Rows whose domain has no BacklogDomain attached (backlog_status
  // null) are excluded whenever this filter has values selected —
  // those rows have no status to match.
  const [statusFilter, setStatusFilter] = useState<BacklogStatus[]>([]);
  // wayback_classify filters (added 2026-05-09).
  const [languages, setLanguages] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  // Whois ownership-cycles filter (added 2026-05-21). 0 = off; >=1
  // shows only rows where the deterministic cycle counter from the
  // whois diff is >= the selected value. Use 2 to focus on domains
  // that definitely dropped at least once, 3+ to find "multi-hand"
  // domains (passed through multiple drop hunters before this auction).
  // Rows with no whois CR have whois_ownership_cycles=null and are
  // excluded as soon as the filter is > 0 (can't satisfy a threshold
  // they have no data for).
  const [whoisCyclesMax, setWhoisCyclesMax] = useState<number>(0);
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
  // Ahrefs Batch Analysis numeric thresholds (2026-06-02). "≥" filters
  // on the pinned batch metrics: DR (prefers batch domain_rating, falls
  // back to the imported backlog DR) and referring domains (dofollow).
  // 0 = off. Rows lacking the value are excluded when the filter is on.
  const [drMin, setDrMin] = useState<number>(0);
  const [refDomainsMin, setRefDomainsMin] = useState<number>(0);
  // Max price range filter (added 2026-05-23, iterated to a paired
  // min/max input the same day after the slider proved unusable — a
  // step-50 slider can't express "between $1 and $20" cleanly, which
  // is the actual procurement question on most drop auctions). Both
  // values are independent USD numbers; 0 (or NaN) means "no bound
  // on that side". Predicate: row passes when
  //   (min === 0 OR row.backlog_max_price >= min) AND
  //   (max === 0 OR row.backlog_max_price <= max).
  // Rows without a backlog row OR without max_price set are excluded
  // when EITHER bound is non-zero — null can't satisfy a numeric
  // comparison.
  const [maxPriceMin, setMaxPriceMin] = useState<number>(0);
  const [maxPriceMax, setMaxPriceMax] = useState<number>(0);
  // "Show taken" toggle (2026-06-02). OFF by default: availability-only
  // domains whose Availability-JOB verdict isn't `available` are hidden
  // server-side so a bulk-availability run doesn't bury the page. ON
  // reveals them. (Domains with real analysis / inline rechecks / notes
  // are never hidden — see hide_candidates in routers/database.py.) This
  // is a visibility toggle, not a narrowing filter, so it's deliberately
  // excluded from `filtersActive` / `clearFilters`.
  const [showTaken, setShowTaken] = useState<boolean>(false);

  // Persistent filters (2026-05-18). Each browser keeps its own copy in
  // localStorage so two operators on the same /database page don't
  // clobber each other's view (no per-user accounts here — basic auth
  // is shared). Versioned key so a future filter-schema bump can drop
  // stale blobs by changing the suffix instead of writing a migration.
  //
  // Pattern: hydrate AFTER mount (avoids SSR/CSR markup mismatch) and
  // gate persist writes on `filtersHydrated` so the initial-default
  // render doesn't overwrite a saved blob with empty state before
  // hydration runs. Defensive Array.isArray / type checks per field
  // mean a hand-edited or stale entry degrades gracefully.
  const FILTERS_STORAGE_KEY = "dropSherlock.database.filters.v1";
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v.verdicts)) setVerdicts(v.verdicts);
        if (Array.isArray(v.waybackVerdicts)) setWaybackVerdicts(v.waybackVerdicts);
        if (Array.isArray(v.whoisBands)) setWhoisBands(v.whoisBands);
        if (Array.isArray(v.availabilityFilter)) setAvailabilityFilter(v.availabilityFilter);
        if (Array.isArray(v.criteria)) setCriteria(v.criteria);
        // `v.cache` and `v.pinFilter` may exist in legacy blobs; ignored
        // (both filters removed 2026-05-23).
        if (v.notesFilter === "any" || v.notesFilter === "with" || v.notesFilter === "without") setNotesFilter(v.notesFilter);
        if (Array.isArray(v.sourceFilter)) setSourceFilter(v.sourceFilter);
        if (Array.isArray(v.statusFilter)) {
          // Defensive: drop any persisted value that isn't a known
          // BacklogStatus, so a stale blob from a future migration
          // can't poison the filter state.
          setStatusFilter(
            v.statusFilter.filter((s: unknown): s is BacklogStatus =>
              typeof s === "string" &&
              (BACKLOG_STATUSES as readonly string[]).includes(s),
            ),
          );
        }
        if (Array.isArray(v.languages)) setLanguages(v.languages);
        if (Array.isArray(v.categories)) setCategories(v.categories);
        if (typeof v.waybackConfMin === "number") setWaybackConfMin(v.waybackConfMin);
        if (typeof v.ahrefsConfMin === "number") setAhrefsConfMin(v.ahrefsConfMin);
        if (typeof v.drMin === "number") setDrMin(v.drMin);
        if (typeof v.refDomainsMin === "number") setRefDomainsMin(v.refDomainsMin);
        if (
          typeof v.whoisCyclesMax === "number" &&
          v.whoisCyclesMax >= 0 &&
          v.whoisCyclesMax <= 10
        ) {
          setWhoisCyclesMax(v.whoisCyclesMax);
        }
        // 2026-05-23: a legacy blob carries `whoisCyclesMin` (the
        // pre-flip ">= N" encoding). The semantic flipped to "< N" —
        // re-using the old value would invert what the user expected.
        // Deliberately ignore the legacy field; the filter resets to
        // "any" on first reload post-flip. Same logic for
        // `cache` / `pinFilter` legacy fields above.
        if (
          typeof v.maxPriceMin === "number" &&
          v.maxPriceMin >= 0 &&
          v.maxPriceMin <= 1_000_000
        ) {
          setMaxPriceMin(v.maxPriceMin);
        }
        if (
          typeof v.maxPriceMax === "number" &&
          v.maxPriceMax >= 0 &&
          v.maxPriceMax <= 1_000_000
        ) {
          setMaxPriceMax(v.maxPriceMax);
        }
        if (typeof v.showTaken === "boolean") setShowTaken(v.showTaken);
      }
    } catch {
      // Corrupt / inaccessible localStorage — fall through to defaults.
    }
    setFiltersHydrated(true);
  }, []);
  // Debounced persist (2026-05-18, perf fix). The first version of this
  // effect wrote to localStorage on EVERY filter change, which made
  // slider drags + rapid multi-select toggles laggy: each tick paid
  // for a JSON.stringify of all 13 fields + a synchronous setItem on
  // top of the (already non-trivial) filtered/sorted recompute.
  // Debouncing collapses any burst of changes into a single write
  // 250ms after the user stops fiddling — invisible to the user
  // (they're not reloading mid-drag) but takes the write off the hot
  // path entirely.
  useEffect(() => {
    if (!filtersHydrated) return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          FILTERS_STORAGE_KEY,
          JSON.stringify({
            verdicts,
            waybackVerdicts,
            whoisBands,
            availabilityFilter,
            criteria,
            notesFilter,
            sourceFilter,
            statusFilter,
            languages,
            categories,
            waybackConfMin,
            ahrefsConfMin,
            drMin,
            refDomainsMin,
            whoisCyclesMax,
            maxPriceMin,
            maxPriceMax,
            showTaken,
          }),
        );
      } catch {
        // Quota exceeded / private mode — silently drop the write
        // rather than break the filter UX.
      }
    }, 250);
    return () => window.clearTimeout(id);
  }, [
    filtersHydrated,
    verdicts,
    waybackVerdicts,
    whoisBands,
    availabilityFilter,
    criteria,
    notesFilter,
    sourceFilter,
    statusFilter,
    languages,
    categories,
    waybackConfMin,
    ahrefsConfMin,
    drMin,
    refDomainsMin,
    whoisCyclesMax,
    maxPriceMin,
    maxPriceMax,
    showTaken,
  ]);

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
  // Max-price sort (added 2026-05-23). Cycles asc (cheapest first —
  // most operators' default scan direction) → desc → null. Mutually
  // exclusive with the other two sort signals; clicking it clears
  // them so the table has one active sort at a time.
  const [maxPriceSort, setMaxPriceSort] = useState<"asc" | "desc" | null>(null);

  // --- Server-side pagination (2026-06-02) -------------------------------
  // Mirrors the Backlog page: filters / sort / search / page all live here
  // and drive a server fetch (filtering + sorting + pagination now happen
  // backend-side). `searchInput` is the immediate input value; `search`
  // is its debounced echo used for fetching. `cachedTotal` / `cachedOptions`
  // persist across page-flips so the page-flip fetch can skip the heavy
  // option computation (include_options=false), exactly like Backlog.
  const [page, setPage] = useState<number>(1);
  const [perPage, setPerPage] = useState<number>(50);
  const [searchInput, setSearchInput] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [cachedTotal, setCachedTotal] = useState<number>(0);
  // Count of availability-only-taken domains hidden by the default rule —
  // labels the "show taken" toggle + guards the empty screen.
  const [cachedHiddenTotal, setCachedHiddenTotal] = useState<number>(0);
  const [cachedOptions, setCachedOptions] = useState<
    DatabaseDomainList["filter_options"]
  >({
    ai_providers: [],
    ai_models: [],
    verdicts: [],
    wayback_verdicts: [],
    languages: [],
    categories: [],
    whois_bands: [],
    availability_statuses: [],
    sources: [],
  });
  // Tracks the last non-page deps so the fetch effect can tell a pure
  // page-flip (cheap: skip options) from a filter/sort/search change.
  const lastDepsRef = useRef<string | null>(null);
  // Monotonic request id — guards against an earlier (slower, full) fetch
  // resolving AFTER a later page-flip fetch and clobbering the view.
  const reqSeqRef = useRef<number>(0);
  // Accumulates row data across every page the user visits so the
  // selection-driven handlers (Apruv export, Quality dominant-job hint)
  // can read fields for domains selected on a different page than the one
  // currently displayed. Reset when the candidate set changes.
  const rowsByDomainRef = useRef<Map<string, DatabaseDomainRow>>(new Map());

  // Resolve the single active sort signal (the three are mutually
  // exclusive — each header handler clears the other two) into the
  // server's sort/direction params.
  const { serverSort, serverDir } = useMemo<{
    serverSort: "verdict" | "whois" | "max_price" | undefined;
    serverDir: "asc" | "desc" | undefined;
  }>(() => {
    if (verdictSort) return { serverSort: "verdict", serverDir: verdictSort };
    if (whoisSort) return { serverSort: "whois", serverDir: whoisSort };
    if (maxPriceSort)
      return { serverSort: "max_price", serverDir: maxPriceSort };
    return { serverSort: undefined, serverDir: undefined };
  }, [verdictSort, whoisSort, maxPriceSort]);

  // Send-to-pillar state (replaces the old "Reanalyze" bulk picker
  // 2026-05-18). Tracks which pillar dispatch is currently in flight
  // so the toolbar buttons can disable themselves during navigation.
  type Pillar = "quality" | "whois" | "availability" | "ahrefs_batch";
  const [sendingPillar, setSendingPillar] = useState<Pillar | null>(null);
  const [bulkBacklogBusy, setBulkBacklogBusy] = useState(false);
  const [bulkBacklogResult, setBulkBacklogResult] = useState<{
    status: string;
    updated?: number;
    created?: number;
    error?: string;
  } | null>(null);
  const dataRef = useRef<DatabaseDomainList | null>(null);
  dataRef.current = data;

  // Ad-hoc recheck OVERLAY (2026-05-16 rewire). The Availability column
  // primarily reads from `row.availability_*` (CR-scoped, matches the
  // Job-page chip). The recheck button still triggers a fresh cascade
  // via `/availability/check` and writes its result into this overlay so
  // the user sees their click reflected immediately. The overlay is
  // local to the page session — a full reload reverts the column to the
  // CR-scoped value. Filter logic ignores the overlay on purpose so the
  // filter universe stays consistent with chip-page semantics.
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

  // Server-driven fetch. Pulls ONE page of already-filtered/sorted rows.
  //   • refreshOptions=true  → ask for total + filter_options (heavy);
  //     cache them. Used on filter/sort/search changes, manual Refresh,
  //     and post-mutation reloads. Page-flips pass false and reuse the
  //     cached values (mirrors Backlog's include_options skip).
  //   • fresh=true           → bypass the backend's 20s aggregation
  //     snapshot cache so a just-committed mutation (or a change made on
  //     another page, e.g. Backlog) shows immediately.
  //   • clearSelection=true  → the candidate set reshaped; drop stale
  //     picks + reset the cross-page row accumulator.
  function reload(
    opts: {
      silent?: boolean;
      refreshOptions?: boolean;
      clearSelection?: boolean;
      fresh?: boolean;
    } = {},
  ) {
    if (!opts.silent) setError(null);
    setRefreshing(true);
    const includeOptions = opts.refreshOptions ?? true;
    const seq = ++reqSeqRef.current;
    api
      .listDatabaseDomains({
        page,
        per_page: perPage,
        include_options: includeOptions,
        fresh: opts.fresh ?? false,
        verdict: verdicts,
        wayback_verdict: waybackVerdicts,
        whois_band: whoisBands,
        availability: availabilityFilter,
        language: languages,
        category: categories,
        criterion: criteria,
        notes: notesFilter,
        source: sourceFilter,
        status: statusFilter,
        wayback_conf_min: waybackConfMin,
        ahrefs_conf_min: ahrefsConfMin,
        dr_min: drMin,
        ref_domains_min: refDomainsMin,
        whois_cycles_max: whoisCyclesMax,
        max_price_min: maxPriceMin,
        max_price_max: maxPriceMax,
        search,
        sort: serverSort,
        direction: serverDir,
        show_taken: showTaken,
      })
      .then((d) => {
        // Drop stale responses (an earlier full fetch landing after a
        // later page-flip fetch). Only the most recent request wins.
        if (seq !== reqSeqRef.current) return;
        setData(d);
        setLastRefreshed(new Date());
        if (includeOptions) {
          setCachedTotal(d.total);
          setCachedHiddenTotal(d.hidden_total ?? 0);
          setCachedOptions(d.filter_options);
        }
        // Merge this page's rows into the cross-page accumulator so
        // selection-driven handlers can read fields for off-page picks.
        if (opts.clearSelection) {
          rowsByDomainRef.current = new Map(
            d.rows.map((r) => [r.domain, r]),
          );
          setSelected(new Set());
        } else {
          for (const r of d.rows) rowsByDomainRef.current.set(r.domain, r);
        }
        // Clear the ad-hoc recheck overlay only on a genuine (non-silent
        // or option-refreshing) reload — NOT on every page-flip, or a
        // user's recheck result would vanish when they page away.
        if (includeOptions) setAvailabilityByDomain({});
      })
      .catch((e: Error) => {
        if (seq === reqSeqRef.current) setError(e.message);
      })
      .finally(() => {
        if (seq === reqSeqRef.current) setRefreshing(false);
      });
  }

  // Keep a ref to the latest `reload` so the mount-only visibility/focus
  // listener calls it with current filter state (not the stale empty-
  // filter closure from first render — the run-page's stale-closure trap).
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // Debounce the search box into the fetched `search` value so typing
  // doesn't fire a request per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Reset to page 1 whenever a filter / sort / search / per-page change
  // reshapes the candidate set (avoids "page 5 of a 1-page result").
  useEffect(() => {
    setPage(1);
  }, [
    verdicts,
    waybackVerdicts,
    whoisBands,
    availabilityFilter,
    languages,
    categories,
    criteria,
    notesFilter,
    sourceFilter,
    statusFilter,
    waybackConfMin,
    ahrefsConfMin,
    drMin,
    refDomainsMin,
    whoisCyclesMax,
    maxPriceMin,
    maxPriceMax,
    search,
    perPage,
    serverSort,
    serverDir,
    showTaken,
  ]);

  // Main fetch effect. Gated on `filtersHydrated` so the first request
  // already carries the localStorage-restored filters (no fetch-twice
  // flash). A pure page-flip skips the heavy total/options query +
  // keeps the selection; everything else refreshes them.
  useEffect(() => {
    if (!filtersHydrated) return;
    const nonPageDeps = JSON.stringify({
      perPage,
      verdicts,
      waybackVerdicts,
      whoisBands,
      availabilityFilter,
      languages,
      categories,
      criteria,
      notesFilter,
      sourceFilter,
      statusFilter,
      waybackConfMin,
      ahrefsConfMin,
      drMin,
      refDomainsMin,
      whoisCyclesMax,
      maxPriceMin,
      maxPriceMax,
      search,
      serverSort,
      serverDir,
      showTaken,
    });
    const onlyPageChanged =
      lastDepsRef.current !== null && lastDepsRef.current === nonPageDeps;
    lastDepsRef.current = nonPageDeps;
    reload({
      silent: true,
      refreshOptions: !onlyPageChanged,
      clearSelection: !onlyPageChanged,
    });
    if (onlyPageChanged) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filtersHydrated,
    page,
    perPage,
    verdicts,
    waybackVerdicts,
    whoisBands,
    availabilityFilter,
    languages,
    categories,
    criteria,
    notesFilter,
    sourceFilter,
    statusFilter,
    waybackConfMin,
    ahrefsConfMin,
    drMin,
    refDomainsMin,
    whoisCyclesMax,
    maxPriceMin,
    maxPriceMax,
    search,
    serverSort,
    serverDir,
    showTaken,
  ]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        // Refresh on focus to catch cross-tab changes — but DON'T force a
        // fresh rebuild (the focus event also fires on initial navigation,
        // and a cache-bypass there would re-run the ~seconds-long
        // aggregation on every landing). The backend's 20s snapshot TTL +
        // mutation invalidation keep this fresh enough; the manual Refresh
        // button is the on-demand cache-bypass. Via the ref so it uses the
        // CURRENT filter state.
        reloadRef.current({ silent: true, refreshOptions: true });
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Server already returns this page's filtered + sorted slice; the
  // client no longer re-filters or re-sorts (server-side pagination
  // rewire, 2026-06-02 — see routers/database.py:list_domains). `pageRows`
  // is simply the current page.
  const pageRows = data?.rows ?? [];

  // Adapter exposing the server pagination state in the PaginatedSearch
  // shape the shared PaginationTopBar / PaginationBottomBar consume — so
  // those components stay untouched. `query`/`setQuery` drive the
  // (debounced) search box; `setPage`/`setPageSize` map to the server
  // page/perPage state. `total` = full-set count (cached across page-
  // flips); `filteredTotal` = post-filter count from the last response.
  const filteredTotal = data?.filtered_total ?? 0;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / Math.max(1, perPage)));
  const startIdx = (page - 1) * perPage;
  const searchState: PaginatedSearch<DatabaseDomainRow> = {
    query: searchInput,
    setQuery: (q) => setSearchInput(q),
    pageSize: perPage,
    setPageSize: (n) => setPerPage(n),
    page,
    setPage: (n) => setPage(n),
    total: cachedTotal,
    filteredTotal,
    // The bars never read filteredAll; CSV export does its own full fetch.
    filteredAll: pageRows,
    pageCount,
    paged: pageRows,
    start: filteredTotal === 0 ? 0 : startIdx + 1,
    end: filteredTotal === 0 ? 0 : startIdx + pageRows.length,
  };

  const pageDomains = pageRows.map((r) => r.domain);
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

  // Send the current selection to a pillar's /check page (2026-05-18,
  // mirrors the Backlog page's 3-button pattern).
  //
  // - Quality keeps its legacy URL-param plumbing (`?domains=` +
  //   `cross_cache=1` + dominant `source_job_id`) so the Quality form
  //   can pre-fill criteria + AI from the source job to maximize cache
  //   hits. Pushes to `/check/quality` directly — no /analyze redirect
  //   hop.
  // - Whois + Availability use the sessionStorage handoff (same key
  //   the Backlog page uses) since those pages already drain from it.
  //   They don't need cache hinting today.
  async function handleSendToPillar(pillar: Pillar) {
    if (selected.size === 0 || sendingPillar !== null) return;
    const domains = Array.from(selected);
    setSendingPillar(pillar);
    try {
      if (pillar === "quality") {
        const param = encodeURIComponent(domains.join(","));
        // Dominant wayback source job — same logic as the pre-2026-05-18
        // single "Analyze N" button. Used to pre-fill the Quality form
        // so cache hits stay warm.
        const counts = new Map<number, { n: number; maxRun: number }>();
        // Read from the cross-page row accumulator (not just the visible
        // page) so a selection spanning multiple pages still resolves the
        // dominant source job. Missing rows just don't contribute — the
        // hint is a cache-warming optimization, safe to under-count.
        for (const domain of domains) {
          const r = rowsByDomainRef.current.get(domain);
          if (!r) continue;
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
        let dominantJobId: number | null = null;
        let bestN = 0;
        let bestRun = 0;
        for (const [jid, { n, maxRun }] of counts) {
          if (n > bestN || (n === bestN && maxRun > bestRun)) {
            dominantJobId = jid;
            bestN = n;
            bestRun = maxRun;
          }
        }
        let url = `/check/quality?domains=${param}&cross_cache=1`;
        if (dominantJobId !== null) {
          url += `&source_job_id=${dominantJobId}`;
        }
        router.push(url);
        return;
      }
      sessionStorage.setItem(
        BACKLOG_HANDOFF_KEY,
        JSON.stringify({ domains }),
      );
      router.push(
        pillar === "whois"
          ? "/check/whois-history?from_backlog=1"
          : pillar === "ahrefs_batch"
            ? "/check/ahrefs-batch-analysis?from_backlog=1"
            : "/check/availability?from_backlog=1",
      );
    } finally {
      // sendingPillar clears when this component unmounts on
      // navigation; setting it false here would briefly re-enable the
      // buttons during the route change and looks jittery.
    }
  }

  // Send ALL filtered domains (every page, not just the loaded one) to a
  // pillar's /check page (2026-06-22) — the "all-filtered" analog of
  // handleSendToPillar, mirroring the Backlog page's all-filtered bar.
  // Resolves the full filtered set with the SAME per_page=0 fetch the CSV
  // export uses (so the set matches exactly what the filters show), then
  // hands the domains off via sessionStorage. Even Quality goes through the
  // sessionStorage handoff here (not its ?domains= URL path) because a
  // tens-of-thousands-domain set won't fit in a URL — /check/quality already
  // drains sessionStorage on from_backlog=1.
  async function handleSendFilteredToPillar(pillar: Pillar) {
    if (filteredTotal === 0 || sendingPillar !== null) return;
    if (!window.confirm(ts.sendFilteredConfirm(filteredTotal))) return;
    setSendingPillar(pillar);
    try {
      const d = await api.listDatabaseDomains({
        per_page: 0,
        include_options: false,
        verdict: verdicts,
        wayback_verdict: waybackVerdicts,
        whois_band: whoisBands,
        availability: availabilityFilter,
        language: languages,
        category: categories,
        criterion: criteria,
        notes: notesFilter,
        source: sourceFilter,
        status: statusFilter,
        wayback_conf_min: waybackConfMin,
        ahrefs_conf_min: ahrefsConfMin,
        dr_min: drMin,
        ref_domains_min: refDomainsMin,
        whois_cycles_max: whoisCyclesMax,
        max_price_min: maxPriceMin,
        max_price_max: maxPriceMax,
        search,
        show_taken: showTaken,
      });
      const domains = d.rows.map((r) => r.domain);
      if (domains.length === 0) {
        setSendingPillar(null);
        return;
      }
      sessionStorage.setItem(
        BACKLOG_HANDOFF_KEY,
        JSON.stringify({ domains }),
      );
      router.push(
        pillar === "quality"
          ? "/check/quality?from_backlog=1"
          : pillar === "whois"
            ? "/check/whois-history?from_backlog=1"
            : pillar === "ahrefs_batch"
              ? "/check/ahrefs-batch-analysis?from_backlog=1"
              : "/check/availability?from_backlog=1",
      );
    } catch (e) {
      setError((e as Error).message);
      setSendingPillar(null);
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
      reload({ fresh: true });
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
      // Cheaper-fix (2026-06-17): a backlog-status change does NOT
      // invalidate the server's heavy whole-DB aggregation snapshot, so
      // forcing fresh=true here re-ran the ~20s `_build_all_rows` rebuild
      // and pegged the API at ~100% CPU on large sources (60k+ domains).
      // Patch the affected rows' status chips locally instead — no rebuild,
      // no spike. Off-page rows / the backlog-status filter reflect the
      // change on the next manual Refresh or 5-min cache expiry.
      const marked = new Set(list);
      setData((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((row) =>
                marked.has(row.domain)
                  ? { ...row, backlog_status: r.status }
                  : row,
              ),
            }
          : prev,
      );
    } catch (e) {
      setBulkBacklogResult({
        status,
        error: (e as Error).message || "bulk failed",
      });
    } finally {
      setBulkBacklogBusy(false);
    }
  }

  // Apruv export (added 2026-05-20). Opens a modal where the user picks
  // which columns to include in a CSV destined for an approver, and
  // ships one auto-generated share URL per row so the approver can
  // open each domain's analysis page WITHOUT basic-auth. Backend
  // endpoint POST /database/approve-share-links handles the
  // pin>most-recent resolution + share token reuse policy. Modal
  // closes on Cancel or after a successful download.
  const [apruvOpen, setApruvOpen] = useState(false);
  const [apruvBusy, setApruvBusy] = useState(false);
  const [apruvExpiresDays, setApruvExpiresDays] = useState<number>(30);
  // Per-column inclusion. Domain + share_url are always on; the rest
  // are user-toggleable. Defaults flag the procurement signals an
  // approver typically wants at a glance (expiry / DR / age / score
  // / bucket / source / notes).
  // Order matches the CSV output (and the picker layout — they're
  // kept in lockstep so the visual sequence in the modal mirrors what
  // the approver sees in the file). Top block = the 12 procurement
  // signals the user prioritised on 2026-05-20; "extras" below stay
  // available but default off. `final_bucket` (verdict) was dropped
  // 2026-05-20 — the numeric `final_score` already conveys verdict.
  const APRUV_COLUMN_DEFAULTS: Record<string, boolean> = {
    backlog_status: true,
    backlog_registrar: true,
    primary_theme: true,
    final_score: true,
    backlog_ahrefs_dr: true,
    // Ahrefs batch-analysis link metrics (added 2026-06-07). DR / RD(f) /
    // B are the three procurement signals an approver looks at together,
    // so they default on whenever DR does.
    refdomains_dofollow: true,
    backlinks_dofollow: true,
    backlog_domain_age_years: true,
    backlog_desired_price: true,
    backlog_max_price: true,
    backlog_expiration_date: true,
    note: true,
    // Extras — off by default.
    final_confidence: false,
    wayback_verdict: false,
    wayback_confidence: false,
    whois_band: false,
    primary_language: false,
    category: false,
    ai_provider: false,
    ai_model: false,
  };
  const [apruvColumns, setApruvColumns] = useState<Record<string, boolean>>(
    APRUV_COLUMN_DEFAULTS,
  );
  const [apruvResult, setApruvResult] = useState<{
    inserted: number;
    skipped: number;
    skipped_reasons: string[];
  } | null>(null);

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
      reload({ silent: true, fresh: true });
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

  // Apruv export handler — composes a CSV from (a) user-selected
  // columns on the local DatabaseDomainRow data + (b) auto-generated
  // share URLs minted by the backend. Always emits `domain` + `share_url`
  // as the leading two columns even when neither is in the picker; both
  // are conceptually mandatory for an approver export.
  async function handleApruvExport() {
    if (selected.size === 0 || apruvBusy) return;
    setApruvBusy(true);
    setApruvResult(null);
    try {
      const domains = Array.from(selected);
      // Map domain -> DatabaseDomainRow from current page data so the
      // column getters have something to read from. Pure backlog rows
      // (no analyzed run) won't be in `data.rows` but we still want
      // to include them in the CSV with empty cells — they'll have a
      // share-link error from the backend.
      // Use the cross-page accumulator so a selection spanning pages
      // still has column data for every picked domain (not just the
      // visible page). Domains never loaded yield empty cells (+ a
      // backend share-link error), same as before.
      const rowByDomain = rowsByDomainRef.current;

      const linkResp = await api.approveShareLinks(domains, apruvExpiresDays);
      const linkByDomain = new Map<string, typeof linkResp.items[number]>();
      for (const it of linkResp.items) linkByDomain.set(it.domain, it);

      // Column catalog — order matches the modal listing AND the CSV
      // output (kept in lockstep so the approver sees the same column
      // sequence in the file as the operator picked in the modal).
      // `domain` (slot 1) and `share_url` (slot 5) are emitted
      // unconditionally; everything else is gated on `apruvColumns[key]`.
      // The first 12 entries below are the 2026-05-20 procurement order;
      // the trailing "extras" remain available but default off.
      // `final_bucket` (verdict) intentionally absent — `final_score`
      // already conveys the verdict numerically.
      const allColumns: { key: string; header: string; get: (r: DatabaseDomainRow | undefined, domain: string) => string | number }[] = [
        { key: "domain", header: "domain", get: (_r, d) => d },
        { key: "backlog_status", header: "status", get: (r) => r?.backlog_status || "" },
        { key: "backlog_registrar", header: "source", get: (r) => r?.backlog_registrar || "" },
        { key: "primary_theme", header: "theme", get: (r) => r?.primary_theme || "" },
        {
          key: "share_url",
          header: "share_url",
          get: (_r, d) => {
            const it = linkByDomain.get(d);
            if (!it || !it.share_url) return "";
            return `${window.location.origin}${it.share_url}`;
          },
        },
        { key: "final_score", header: "ahrefs_score", get: (r) => r?.final_score ?? "" },
        {
          key: "backlog_ahrefs_dr",
          header: "ahrefs_dr",
          // Mirror the Database row's DR chip policy (2026-06-02):
          // prefer the pinned Ahrefs Batch Analysis `domain_rating`,
          // fall back to the import-time `backlog_ahrefs_dr`. Without
          // this fallback the export came out blank for every domain
          // whose DR is only known from the batch run (the common
          // case — the user rarely types DR into the import CSV).
          get: (r) => r?.batch_metrics?.domain_rating ?? r?.backlog_ahrefs_dr ?? "",
        },
        // RD(f) / B come only from the pinned Ahrefs Batch Analysis CR
        // (no import-time fallback exists; backlog CSVs don't carry
        // these). Empty when the domain has no batch-analysis pin.
        // Same field IDs the Database chip uses (page.tsx:2969-2970),
        // so the CSV value matches the chip number 1:1.
        {
          key: "refdomains_dofollow",
          header: "refdomains_dofollow",
          get: (r) => r?.batch_metrics?.refdomains_dofollow ?? "",
        },
        {
          key: "backlinks_dofollow",
          header: "backlinks_dofollow",
          get: (r) => r?.batch_metrics?.backlinks_dofollow ?? "",
        },
        { key: "backlog_domain_age_years", header: "age_years", get: (r) => r?.backlog_domain_age_years ?? "" },
        { key: "backlog_desired_price", header: "desired_price", get: (r) => r?.backlog_desired_price ?? "" },
        { key: "backlog_max_price", header: "max_price", get: (r) => r?.backlog_max_price ?? "" },
        { key: "backlog_expiration_date", header: "expiration_date", get: (r) => r?.backlog_expiration_date || "" },
        { key: "note", header: "note", get: (r) => r?.note || "" },
        // Extras (below the user's prioritised top-12).
        { key: "final_confidence", header: "confidence", get: (r) => r?.final_confidence ?? "" },
        { key: "wayback_verdict", header: "wayback_verdict", get: (r) => r?.wayback_assessment || "" },
        { key: "wayback_confidence", header: "wayback_confidence", get: (r) => r?.wayback_confidence ?? "" },
        { key: "whois_band", header: "whois_band", get: (r) => r?.whois_band || "" },
        { key: "primary_language", header: "language", get: (r) => r?.primary_language || "" },
        { key: "category", header: "category", get: (r) => r?.category || "" },
        { key: "ai_provider", header: "ai_provider", get: (r) => r?.ai_provider || "" },
        { key: "ai_model", header: "ai_model", get: (r) => r?.ai_model || "" },
      ];

      // domain + share_url always; everything else gated by the picker.
      const activeColumns = allColumns.filter(
        (c) =>
          c.key === "domain" ||
          c.key === "share_url" ||
          apruvColumns[c.key],
      );

      // Build CSV with the existing toCsv helper. The helper expects a
      // CsvColumn<T> shape; we adapt by passing a stub T = string (the
      // domain) and reading the per-row data via the Map.
      const csvCols: CsvColumn<string>[] = activeColumns.map((c) => ({
        header: c.header,
        get: (domain: string) => c.get(rowByDomain.get(domain), domain),
      }));
      const csv = toCsv(domains, csvCols);
      downloadBlob(csv, csvFilename(`drop-sherlock-apruv`));

      const skipped = linkResp.items.filter((i) => !i.token);
      setApruvResult({
        inserted: linkResp.items.length - skipped.length,
        skipped: skipped.length,
        skipped_reasons: skipped.map((i) => `${i.domain}: ${i.error}`),
      });
      // Keep the modal open so the user sees the result summary; they
      // close it manually via Cancel/Close.
    } catch (e) {
      setApruvResult({
        inserted: 0,
        skipped: 0,
        skipped_reasons: [(e as Error).message || "Apruv export failed"],
      });
    } finally {
      setApruvBusy(false);
    }
  }

  function clearFilters() {
    setVerdicts([]);
    setWaybackVerdicts([]);
    setWhoisBands([]);
    setAvailabilityFilter([]);
    setLanguages([]);
    setCategories([]);
    setCriteria([]);
    // setCache + setPinFilter removed (controls deleted 2026-05-23).
    setNotesFilter("any");
    setSourceFilter([]);
    setStatusFilter([]);
    setWaybackConfMin(0);
    setAhrefsConfMin(0);
    setDrMin(0);
    setRefDomainsMin(0);
    setWhoisCyclesMax(0);
    setMaxPriceMin(0);
    setMaxPriceMax(0);
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

  // Server-side pagination means the client only holds ONE page, so CSV
  // export fetches the full set itself (per_page=0 = every row). "visible"
  // re-sends the active filters/sort so the file matches what the user is
  // looking at; "all" omits them for the whole database. Reuses the same
  // client-side column getters — no backend CSV builder needed.
  const [exporting, setExporting] = useState<"" | "visible" | "all">("");
  async function exportCsv(scope: "visible" | "all") {
    if (exporting) return;
    setExporting(scope);
    try {
      const d = await api.listDatabaseDomains(
        scope === "visible"
          ? {
              per_page: 0,
              include_options: false,
              verdict: verdicts,
              wayback_verdict: waybackVerdicts,
              whois_band: whoisBands,
              availability: availabilityFilter,
              language: languages,
              category: categories,
              criterion: criteria,
              notes: notesFilter,
              source: sourceFilter,
              status: statusFilter,
              wayback_conf_min: waybackConfMin,
              ahrefs_conf_min: ahrefsConfMin,
              dr_min: drMin,
              ref_domains_min: refDomainsMin,
              whois_cycles_max: whoisCyclesMax,
              max_price_min: maxPriceMin,
              max_price_max: maxPriceMax,
              search,
              sort: serverSort,
              direction: serverDir,
              show_taken: showTaken,
            }
          : { per_page: 0, include_options: false },
      );
      const csv = toCsv(d.rows, csvColumns);
      downloadBlob(csv, csvFilename(`drop-sherlock-database-${scope}`));
    } catch (e) {
      setError((e as Error).message || "export failed");
    } finally {
      setExporting("");
    }
  }

  const filtersActive =
    verdicts.length > 0 ||
    waybackVerdicts.length > 0 ||
    whoisBands.length > 0 ||
    availabilityFilter.length > 0 ||
    languages.length > 0 ||
    categories.length > 0 ||
    criteria.length > 0 ||
    notesFilter !== "any" ||
    sourceFilter.length > 0 ||
    statusFilter.length > 0 ||
    waybackConfMin > 0 ||
    ahrefsConfMin > 0 ||
    drMin > 0 ||
    refDomainsMin > 0 ||
    whoisCyclesMax > 0 ||
    maxPriceMin > 0 ||
    maxPriceMax > 0;

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
  // Full-page "empty" ONLY when the database genuinely has no domains —
  // NOT when an active filter narrowed the page to zero (that case keeps
  // the filter bar visible and shows the in-table "no match" message, so
  // the user can adjust/clear the filter). cachedTotal is the unfiltered
  // count from the last options-bearing response.
  if (
    cachedTotal === 0 &&
    cachedHiddenTotal === 0 &&
    !filtersActive &&
    search === ""
  ) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      </div>
    );
  }

  // Filter dropdowns read the CACHED options (preserved across page-flips
  // where the server skips the heavy options computation).
  const opts = cachedOptions;

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
            onClick={() => reload({ fresh: true })}
            disabled={refreshing}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {refreshing ? ts.refreshing : ts.refresh}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("visible")}
            disabled={exporting !== "" || filteredTotal === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportVisibleHelp}
          >
            {ts.exportVisible(filteredTotal)}
          </button>
          <button
            type="button"
            onClick={() => exportCsv("all")}
            disabled={exporting !== "" || cachedTotal === 0}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            title={ts.exportAllHelp}
          >
            {ts.exportAll(cachedTotal)}
          </button>
        </div>
      </div>

      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold">{ts.filters.heading}</h2>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Show-taken toggle — only meaningful when there ARE hidden
                availability-only-taken domains (or it's already on, so the
                user can switch it back off). */}
            {(cachedHiddenTotal > 0 || showTaken) && (
              <label
                className="text-xs inline-flex items-center gap-1.5 cursor-pointer text-neutral-600 dark:text-neutral-400"
                title={ts.filters.showTakenHelp}
              >
                <input
                  type="checkbox"
                  checked={showTaken}
                  onChange={(e) => setShowTaken(e.target.checked)}
                  className="cursor-pointer"
                />
                {ts.filters.showTaken(cachedHiddenTotal)}
              </label>
            )}
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
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 text-sm">
          {/* Source filter (2026-05-17) — multi-select on
              BacklogDomain.registrar, mirrors the Backlog page filter.
              Replaced the Pin filter at this position; Pin moved down
              to live next to the confidence sliders since it's used
              mostly during deep triage, not high-level scoping. */}
          <MultiSelectFilter
            label={ts.filters.sourceLabel}
            anyLabel={ts.filters.sourceAny}
            value={sourceFilter}
            onChange={setSourceFilter}
            options={(opts.sources ?? []).map((s) => ({
              value: s,
              label: s,
            }))}
            disabled={(opts.sources ?? []).length === 0}
            searchable
            searchPlaceholder={ts.filters.sourceSearchPlaceholder}
          />

          {/* Backlog-status filter (2026-05-20) — positioned right after
              Source per the user request. Options come from the shared
              BACKLOG_STATUSES vocabulary so chips line up 1:1 with the
              Backlog page filter; labels reuse t.pages.backlog.statusLabels
              so a future relabel propagates to both surfaces without
              duplication.

              "backlog" and "banned" are deliberately omitted from the
              dropdown per the 2026-05-20 follow-up: on the Database
              page, "backlog" is the default no-decision state (filtering
              to it would just hide every triaged row), and banned
              domains already have a distinct visual treatment + their
              own "is_banned" badge so the user doesn't need a status
              re-filter for them. The vocabulary still LIVES in
              BACKLOG_STATUSES so a stale persisted value isn't lost —
              it's just not in the picker. */}
          <MultiSelectFilter
            label={ts.filters.statusLabel}
            anyLabel={ts.filters.statusAny}
            value={statusFilter}
            onChange={(next) => setStatusFilter(next as BacklogStatus[])}
            options={BACKLOG_STATUSES
              .filter((s) => s !== "backlog" && s !== "banned")
              .map((s) => ({
                value: s,
                label: t.pages.backlog.statusLabels[s],
              }))}
          />

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
                value: "not_supported",
                label: ts.filters.availabilityNotSupported,
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

          {/* Provider / Model / Min records filters removed 2026-05-17 at
              user request — never used, just noise in the filter row. */}

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

          {/* Cache filter + Pin filter REMOVED 2026-05-23 (user-
              requested simplification). See filter-state comments
              near the useState declarations for rationale. */}

          <select
            value={notesFilter}
            onChange={(e) => setNotesFilter(e.target.value as NotesFilter)}
            className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="any">{ts.filters.notesAny}</option>
            <option value="with">{ts.filters.notesWith}</option>
            <option value="without">{ts.filters.notesWithout}</option>
          </select>

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
          {/* Whois ownership-cycles filter. Flipped 2026-05-23 from
              ">= N" to "< N" semantics — drop-hunter mental model is
              "show me freshest history" (low cycle count), not
              "show me reused" (high count). Discrete dropdown
              because the values are integer thresholds with a hard
              semantic per step.

              `min-w-0` on the wrapper + the select keep the cell from
              expanding past its grid track when an option label is
              long ("< 5 (at most 3 drops)"). Without it the select's
              intrinsic content width pushed into the adjacent
              Max-price slider cell at narrower viewports. */}
          <div
            className="flex items-center gap-2 min-w-0"
            title={ts.filters.whoisCyclesMaxHelp}
          >
            <label className="text-neutral-700 dark:text-neutral-300 whitespace-nowrap shrink-0">
              {ts.filters.whoisCyclesMax}
            </label>
            <select
              value={whoisCyclesMax}
              onChange={(e) =>
                setWhoisCyclesMax(parseInt(e.target.value, 10) || 0)
              }
              className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none min-w-0 flex-1"
            >
              <option value={0}>{ts.filters.whoisCyclesAny}</option>
              <option value={2}>{ts.filters.whoisCyclesLt2}</option>
              <option value={3}>{ts.filters.whoisCyclesLt3}</option>
              <option value={4}>{ts.filters.whoisCyclesLt4}</option>
              <option value={5}>{ts.filters.whoisCyclesLt5}</option>
            </select>
          </div>
          {/* Ahrefs Batch "≥" thresholds (2026-06-02): DR + referring
              domains (dofollow) from the pinned batch run. 0/blank = off. */}
          <label className="flex flex-col gap-1 min-w-0" title={ts.filters.drMinHelp}>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.filters.drMin}
            </span>
            <input
              type="number"
              min={0}
              value={drMin || ""}
              placeholder={ts.filters.numMinPlaceholder}
              onChange={(e) =>
                setDrMin(Math.max(0, parseFloat(e.target.value) || 0))
              }
              className="px-2 py-1.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40 tabular-nums"
            />
          </label>
          <label
            className="flex flex-col gap-1 min-w-0"
            title={ts.filters.refDomainsMinHelp}
          >
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.filters.refDomainsMin}
            </span>
            <input
              type="number"
              min={0}
              value={refDomainsMin || ""}
              placeholder={ts.filters.numMinPlaceholder}
              onChange={(e) =>
                setRefDomainsMin(Math.max(0, parseInt(e.target.value, 10) || 0))
              }
              className="px-2 py-1.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40 tabular-nums"
            />
          </label>

          {/* Max price range — paired number inputs (replaced the
              step-50 slider 2026-05-23 same day, after the slider
              proved unusable for $1-$20 ranges). Either bound is
              optional; empty == 0 == "no bound on that side". The
              `inputMode="decimal"` hint surfaces a numeric keypad on
              mobile without forcing strict integer typing.

              `min-w-0` on the wrapper lets the cell shrink in the
              grid without overflowing into the adjacent cell — the
              two number inputs handle their own widths via w-20.

              On <button> "Clear": acts only when ANY bound is set, so
              when filter is inactive the affordance disappears (no
              redundant "Clear nothing" gesture). */}
          <div
            className="flex items-center gap-2 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm min-w-0"
            title={ts.filters.maxPriceMaxHelp}
          >
            <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
              {ts.filters.maxPriceRange}
            </span>
            <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0">
              $
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={ts.filters.maxPriceMinPlaceholder}
              value={maxPriceMin || ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMaxPriceMin(Number.isFinite(v) && v > 0 ? v : 0);
              }}
              aria-label={ts.filters.maxPriceMinAria}
              className="w-20 min-w-0 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-blue-500/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0">
              –
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={ts.filters.maxPriceMaxPlaceholder}
              value={maxPriceMax || ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMaxPriceMax(Number.isFinite(v) && v > 0 ? v : 0);
              }}
              aria-label={ts.filters.maxPriceMaxAria}
              className="w-20 min-w-0 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-blue-500/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            {(maxPriceMin > 0 || maxPriceMax > 0) && (
              <button
                type="button"
                onClick={() => {
                  setMaxPriceMin(0);
                  setMaxPriceMax(0);
                }}
                aria-label={ts.filters.maxPriceClearAria}
                className="text-xs text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 leading-none px-0.5 shrink-0"
              >
                ×
              </button>
            )}
          </div>
        </div>
        {/* Filtered count under the filter grid (added 2026-05-15).
            Only renders when filters are active — when nothing is
            filtered, "X of X" is just noise. Pagination footer still
            shows the overall total. */}
        {filtersActive && (
          <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 pt-1">
            <span>
              {ts.filters.matchedCount(
                filteredTotal,
                cachedTotal,
              )}
            </span>
            {filteredTotal === 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                · {ts.filters.matchedCountEmpty}
              </span>
            )}
          </div>
        )}
      </section>

      <PaginationTopBar state={searchState} searchPlaceholder={ts.searchPlaceholder} />

      {/* All-filtered send bar (2026-06-22) — dispatch the ENTIRE filtered
          set (every page) to a pillar, mirroring the Backlog page. Shown
          only when nothing is hand-selected, so it never stacks with the
          blue selection toolbar below; pick rows for a subset, or use this
          for "everything matching the current filters". */}
      {filteredTotal > 0 && selected.size === 0 && (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-emerald-800 dark:text-emerald-300">
              {t.pages.backlog.sendToPicker.allFilteredLabel(filteredTotal)}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => handleSendFilteredToPillar("quality")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.qualityHint}
              >
                {t.pages.backlog.sendToPicker.quality}
              </button>
              <button
                type="button"
                onClick={() => handleSendFilteredToPillar("whois")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.whoisHint}
              >
                {t.pages.backlog.sendToPicker.whois}
              </button>
              <button
                type="button"
                onClick={() => handleSendFilteredToPillar("ahrefs_batch")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.ahrefsBatchHint}
              >
                {t.pages.backlog.sendToPicker.ahrefsBatch}
              </button>
            </div>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="rounded-md border border-blue-300 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-sm space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-blue-800 dark:text-blue-300">
              {ts.selectedCount(selected.size)}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-2 py-1 rounded-md border border-blue-300 dark:border-blue-900/60 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
              >
                {ts.clearSelection}
              </button>
              {/* 3-pillar send buttons (2026-05-18) — same trio +
                  color scheme as the Backlog page so the UX is
                  consistent. Replaces the old single "Analyze N" + the
                  "Reanalyze" picker. Reuses Backlog's sendToPicker
                  i18n labels. */}
              <button
                type="button"
                onClick={() => handleSendToPillar("quality")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.qualityHint}
              >
                {t.pages.backlog.sendToPicker.quality}
              </button>
              <button
                type="button"
                onClick={() => handleSendToPillar("whois")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.whoisHint}
              >
                {t.pages.backlog.sendToPicker.whois}
              </button>
              <button
                type="button"
                onClick={() => handleSendToPillar("availability")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.availabilityHint}
              >
                {t.pages.backlog.sendToPicker.availability}
              </button>
              <button
                type="button"
                onClick={() => handleSendToPillar("ahrefs_batch")}
                disabled={deleting || sendingPillar !== null}
                className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                title={t.pages.backlog.sendToPicker.ahrefsBatchHint}
              >
                {t.pages.backlog.sendToPicker.ahrefsBatch}
              </button>
              <button
                type="button"
                onClick={() => handleBulkBacklogStatus("order")}
                disabled={deleting || sendingPillar !== null || bulkBacklogBusy}
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
                disabled={deleting || sendingPillar !== null || bulkBacklogBusy}
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
                disabled={deleting || sendingPillar !== null || bulkBacklogBusy || bulkBanBusy}
                title={ts.bulkBanHint}
                className="text-xs px-3 py-1 rounded-md border border-rose-400 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                {bulkBanBusy ? ts.bulkBanBusy : ts.bulkBan(selected.size)}
              </button>
              {/* Apruv export (2026-05-20). Opens a column-picker modal
                  + auto-generates approver-ready share URLs. Emerald to
                  read as a positive action (vs. the rose Ban / amber
                  Order). Disabled mid-batch to avoid double-export
                  races. */}
              <button
                type="button"
                onClick={() => {
                  setApruvResult(null);
                  setApruvOpen(true);
                }}
                disabled={
                  deleting ||
                  sendingPillar !== null ||
                  bulkBacklogBusy ||
                  bulkBanBusy ||
                  apruvBusy
                }
                title={ts.apruv.buttonHint}
                className="text-xs px-3 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {ts.apruv.button(selected.size)}
              </button>
              {/* Bulk-delete intentionally hidden 2026-05-18 pending the
                  Trash redesign — Database cascading delete is the
                  highest-blast-radius destructive action on the platform
                  and needs the safety net before it can stay shipped. The
                  handler + endpoint are deliberately left wired so this
                  is a one-line revert when Trash lands. */}
              {false && (
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={deleting || sendingPillar !== null || bulkBacklogBusy}
                  className="text-xs px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleting ? ts.deleting : ts.deleteSelected(selected.size)}
                </button>
              )}
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

      {pageRows.length === 0 ? (
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
                {/* Row number for orientation. Absolute index across the
                    full sorted set so the user can say "row 250" instead
                    of "row 3 page 5". Bumped by `start` (the
                    PaginatedSearch's first-row position). */}
                <th className="px-3 py-2 font-medium text-right w-12">
                  {ts.cols.rowNumber}
                </th>
                <th className="px-3 py-2 font-medium">{ts.cols.domain}</th>
                {/* Column-group A — AI signals (Verdict, Whois, Wayback,
                    Language, Theme, Category). Sortable headers stay on
                    Verdict + Whois. */}
                <th className="px-3 py-2 font-medium">
                  <button
                    type="button"
                    onClick={() => {
                      setWhoisSort(null);
                      setMaxPriceSort(null);
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
                      setMaxPriceSort(null);
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
                {/* Column-group B — operational state (Criteria pills,
                    Backlog/queue status). Criteria-before-Backlog so the
                    user reads "what ran" then "what stage it's in". */}
                <th className="px-3 py-2 font-medium">{ts.cols.criteria}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.backlog}</th>
                {/* Column-group C — identity + my own state. Source
                    column replaced 2026-05-23 by Max price (drop-hunter
                    procurement signal more useful at-a-glance than the
                    registrar string the source was showing). Source
                    info still available in CSV export. Sortable —
                    asc (cheapest first) is the most natural default
                    for procurement scanning. */}
                <th className="px-3 py-2 font-medium text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setVerdictSort(null);
                      setWhoisSort(null);
                      setMaxPriceSort((cur) =>
                        cur === "asc" ? "desc" : cur === "desc" ? null : "asc",
                      );
                    }}
                    className="inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400"
                    title={ts.cols.maxPriceSortHint}
                  >
                    {ts.cols.maxPrice}
                    <span className="text-xs opacity-70 w-3 inline-block text-left">
                      {maxPriceSort === "asc"
                        ? "↑"
                        : maxPriceSort === "desc"
                          ? "↓"
                          : ""}
                    </span>
                  </button>
                </th>
                <th className="px-3 py-2 font-medium">{ts.cols.availability}</th>
                <th className="px-3 py-2 font-medium">{ts.cols.note}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => (
                <DomainListRow
                  key={r.domain}
                  row={r}
                  rowNumber={startIdx + i + 1}
                  selected={selected.has(r.domain)}
                  onToggle={() => toggleOne(r.domain)}
                  onBacklogUpdated={() => reload({ silent: true })}
                  onNoteSaved={(note) => {
                    // Optimistic merge so the new note is visible
                    // immediately without a full /database/domains
                    // round-trip. Other fields untouched.
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            rows: prev.rows.map((row) =>
                              row.domain === r.domain
                                ? { ...row, note }
                                : row,
                            ),
                          }
                        : prev,
                    );
                  }}
                  onMaxPriceSaved={(maxPrice) => {
                    // Same optimistic merge pattern as onNoteSaved —
                    // the Max Price edit closes its editor in <1ms but
                    // the silent reload settles in 200-500ms, so
                    // without this the cell briefly displays the stale
                    // pre-edit value before the network roundtrip
                    // arrives.
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            rows: prev.rows.map((row) =>
                              row.domain === r.domain
                                ? { ...row, backlog_max_price: maxPrice }
                                : row,
                            ),
                          }
                        : prev,
                    );
                  }}
                  availability={
                    // Prefer ad-hoc recheck overlay when present (so the
                    // user's recheck click shows immediately); fall back
                    // to CR-scoped fields on the row (matches the
                    // Job-page chip).
                    availabilityByDomain[r.domain]
                    ?? (r.availability_status
                      ? {
                          status: r.availability_status as AvailabilityStatus,
                          provider: r.availability_provider,
                          registrar: r.availability_registrar,
                          expires_on: r.availability_expires_on,
                          checked_at: r.availability_checked_at,
                        }
                      : undefined)
                  }
                  recheckBusy={recheckBusy.has(r.domain)}
                  onRecheck={() => handleRecheckAvailability(r.domain)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PaginationBottomBar state={searchState} />

      {/* Apruv export modal (added 2026-05-20). Inline conditional so the
          markup lives next to the state that drives it; the page already
          has too many top-level sections to justify pulling this into a
          dedicated component. Reuses native dialog semantics via aria
          attributes — no extra portal library. */}
      {apruvOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="apruv-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => !apruvBusy && setApruvOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="apruv-modal-title" className="text-lg font-semibold">
                  {ts.apruv.modalTitle}
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {ts.apruv.modalHelp(selected.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => !apruvBusy && setApruvOpen(false)}
                disabled={apruvBusy}
                className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-50"
                aria-label={ts.apruv.close}
              >
                ✕
              </button>
            </div>

            {/* Expiry selector — 4 canned options. Stored as number of
                days (0 = never expires per the backend contract). */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {ts.apruv.expiryLabel}
              </label>
              <select
                value={apruvExpiresDays}
                onChange={(e) =>
                  setApruvExpiresDays(parseInt(e.target.value, 10) || 0)
                }
                disabled={apruvBusy}
                className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm"
              >
                <option value={7}>{ts.apruv.expiry7}</option>
                <option value={30}>{ts.apruv.expiry30}</option>
                <option value={90}>{ts.apruv.expiry90}</option>
                <option value={0}>{ts.apruv.expiryNever}</option>
              </select>
            </div>

            {/* Column picker. Domain + share_url are listed at the top
                as locked-on rows so the user understands they always
                ship; the rest are toggle checkboxes. */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {ts.apruv.columnsLabel}
              </label>
              <div className="grid grid-cols-2 gap-1.5 text-sm rounded-md border dark:border-neutral-800 p-3 bg-neutral-50 dark:bg-neutral-900/60">
                <div className="flex items-center gap-2 col-span-2 text-xs text-neutral-500 dark:text-neutral-400 italic">
                  {ts.apruv.mandatoryHint}
                </div>
                {/* Single ordered iteration so the picker order = CSV
                    order = the order the user negotiated 2026-05-20.
                    `locked: true` rows render as disabled-but-checked
                    (domain @ slot 1, share_url @ slot 5). */}
                {(
                  [
                    { key: "domain", locked: true },
                    { key: "backlog_status", locked: false },
                    { key: "backlog_registrar", locked: false },
                    { key: "primary_theme", locked: false },
                    { key: "share_url", locked: true },
                    { key: "final_score", locked: false },
                    { key: "backlog_ahrefs_dr", locked: false },
                    // RD(f) / B sit next to DR so the picker order and
                    // CSV column order both group the three Ahrefs link
                    // metrics together. Defaults on (procurement signals).
                    { key: "refdomains_dofollow", locked: false },
                    { key: "backlinks_dofollow", locked: false },
                    { key: "backlog_domain_age_years", locked: false },
                    { key: "backlog_desired_price", locked: false },
                    { key: "backlog_max_price", locked: false },
                    { key: "backlog_expiration_date", locked: false },
                    { key: "note", locked: false },
                    // Extras (off by default).
                    { key: "final_confidence", locked: false },
                    { key: "wayback_verdict", locked: false },
                    { key: "wayback_confidence", locked: false },
                    { key: "whois_band", locked: false },
                    { key: "primary_language", locked: false },
                    { key: "category", locked: false },
                    { key: "ai_provider", locked: false },
                    { key: "ai_model", locked: false },
                  ] as const
                ).map(({ key, locked }) => (
                  <label
                    key={key}
                    className={
                      locked
                        ? "flex items-center gap-2 opacity-60"
                        : "flex items-center gap-2 cursor-pointer hover:text-neutral-900 dark:hover:text-neutral-100"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={locked ? true : !!apruvColumns[key]}
                      disabled={locked || apruvBusy}
                      onChange={(e) =>
                        !locked &&
                        setApruvColumns((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      {ts.apruv.cols[key as keyof typeof ts.apruv.cols] || key}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Result summary surfaces after the download completes;
                tells the user how many rows shipped vs. how many were
                skipped (pure backlog rows with no analyzed rd). */}
            {apruvResult && (
              <div
                className={`text-sm rounded-md px-3 py-2 ${
                  apruvResult.skipped === 0 && apruvResult.inserted > 0
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : "bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
                }`}
              >
                <div>
                  {ts.apruv.resultSummary(
                    apruvResult.inserted,
                    apruvResult.skipped,
                  )}
                </div>
                {apruvResult.skipped_reasons.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-xs">
                    {apruvResult.skipped_reasons.slice(0, 6).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                    {apruvResult.skipped_reasons.length > 6 && (
                      <li>
                        +{apruvResult.skipped_reasons.length - 6} more…
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setApruvOpen(false)}
                disabled={apruvBusy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {apruvResult ? ts.apruv.close : ts.apruv.cancel}
              </button>
              <button
                type="button"
                onClick={handleApruvExport}
                disabled={apruvBusy || selected.size === 0}
                className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {apruvBusy ? ts.apruv.exporting : ts.apruv.exportCsv}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DomainListRow({
  row,
  rowNumber,
  selected,
  onToggle,
  onBacklogUpdated,
  onNoteSaved,
  onMaxPriceSaved,
  availability,
  recheckBusy,
  onRecheck,
}: {
  row: DatabaseDomainRow;
  rowNumber: number;
  selected: boolean;
  onToggle: () => void;
  onBacklogUpdated: () => void;
  onNoteSaved: (note: string) => void;
  // Optimistic-merge callback for the Max Price edit (added 2026-05-29).
  // Mirrors `onNoteSaved`'s pattern: parent updates local state instead
  // of forcing a /database/domains round-trip so the new price renders
  // the instant the cell closes its editor, not 200-500ms later when
  // the silent reload settles.
  onMaxPriceSaved: (maxPrice: number | null) => void;
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

  // Domain-cell link target (U1, returned 2026-05-18). Prefers the
  // pinned rd when set; otherwise falls back across every available
  // criterion source so unpinned rows that still have a Whois /
  // Availability / Wayback source land somewhere useful. Per-criterion
  // verdict cells keep their own narrower hrefs above — this is just
  // the catch-all anchor on the domain text.
  const domainHref: string | null = (() => {
    if (
      row.pinned_run_domain_id != null &&
      row.pinned_run_id != null &&
      row.pinned_job_id != null
    ) {
      return `/jobs/${row.pinned_job_id}/runs/${row.pinned_run_id}/domains/${row.pinned_run_domain_id}`;
    }
    return hrefFor([
      "backlinks", "refdomains", "anchors", "keywords",
      "wayback", "wayback_classify", "whois_history", "availability",
    ]);
  })();

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
  ).map(([k, letter]) => {
    const c = row.criteria[k];
    return {
      key: k,
      letter,
      rows: c.rows,
      fullName: t.pages.analyze.criteria[k],
      sourceRunId: c.source_run_id ?? null,
      sourceJobName: c.source_job_name ?? "",
      sourceRunName: c.source_run_name ?? "",
      // Per-criterion AI verdict for confidence-aware coloring (U3).
      // ai_assessment ∈ {high_quality, mixed, low_quality} for Ahrefs
      // + Wayback; null for wayback_classify (no quality axis) and
      // whois_history (uses dropped_confidence on a different axis).
      aiAssessment: c.ai_assessment ?? null,
      aiConfidence:
        typeof c.ai_confidence === "number" ? c.ai_confidence : null,
      aiDroppedConfidence:
        typeof c.ai_dropped_confidence === "number"
          ? c.ai_dropped_confidence
          : null,
    };
  });

  // Split chips into two rows (2026-05-18): Ahrefs criteria (B/D/A/K)
  // on line 1, aux pillars (W/C/H) on line 2. Keeps the eye from
  // having to parse a single dense 5-7 chip strip, and reinforces the
  // mental grouping (quality-scoring vs auxiliary signals).
  const AHREFS_KEYS = new Set([
    "backlinks", "refdomains", "anchors", "keywords",
  ]);
  const ahrefsPills = enabledCriteriaPills.filter((p) =>
    AHREFS_KEYS.has(p.key),
  );
  const auxPills = enabledCriteriaPills.filter(
    (p) => !AHREFS_KEYS.has(p.key),
  );

  // Single source of truth for chip rendering — both row groups call
  // this so the tone/tooltip logic doesn't drift between the two
  // sub-rows. Closes over `row` (for theme_confidence +
  // classify_drift_detected) so callers don't have to pass it.
  const renderCriterionPill = (p: typeof enabledCriteriaPills[number]) => {
    const sourceSuffix = p.sourceRunId
      ? `\nFrom Run #${p.sourceRunId}${
          p.sourceRunName ? ` "${p.sourceRunName}"` : ""
        }${p.sourceJobName ? ` (Job: ${p.sourceJobName})` : ""}`
      : "";
    // Global 4-bucket text scheme used across this row:
    //   grey  → low confidence / unknown
    //   green → good
    //   yellow → mixed
    //   red   → bad
    // Switched mixed from amber-700 to yellow-700 in 2026-05-18 because
    // amber-700 reads as orange on white; yellow-700 stays clearly in
    // the yellow band while keeping enough contrast for legibility.
    const QUALITY_TEXT: Record<string, string> = {
      high_quality: "text-emerald-700 dark:text-emerald-300",
      mixed: "text-yellow-700 dark:text-yellow-400",
      low_quality: "text-rose-700 dark:text-rose-300",
    };
    const NEUTRAL_TEXT = "text-neutral-500 dark:text-neutral-400";
    let tone = "text-emerald-700 dark:text-emerald-300";
    let assessmentLine = "";
    if (p.key === "whois_history") {
      if (typeof p.aiDroppedConfidence === "number") {
        const pct = Math.round(p.aiDroppedConfidence * 100);
        assessmentLine = `\nDropped confidence: ${pct}%`;
        tone =
          p.aiDroppedConfidence > 0.8
            ? "text-rose-700 dark:text-rose-300"
            : p.aiDroppedConfidence > 0.5
              ? "text-yellow-700 dark:text-yellow-400"
              : p.aiDroppedConfidence >= 0.3
                ? NEUTRAL_TEXT
                : "text-emerald-700 dark:text-emerald-300";
      }
    } else if (p.key === "wayback_classify") {
      // 4-bucket scheme for classify (2026-05-18):
      //   grey  → theme_confidence missing or below threshold
      //   red   → drift detected (site changed topics; SEO baggage)
      //   yellow → no drift, but multi-topic (≥1 secondary theme)
      //   green → no drift, single primary theme, high confidence
      const conf =
        typeof row.theme_confidence === "number"
          ? row.theme_confidence
          : null;
      const drift = !!row.classify_drift_detected;
      const hasSecondaries =
        (row.secondary_themes ?? []).filter(Boolean).length > 0;
      if (conf == null || isLowConfidence(conf)) {
        tone = NEUTRAL_TEXT;
        assessmentLine = `\nLow theme confidence`;
      } else if (drift) {
        tone = QUALITY_TEXT.low_quality;
        assessmentLine = `\nTheme drift detected`;
      } else if (hasSecondaries) {
        tone = QUALITY_TEXT.mixed;
        assessmentLine = `\nMulti-topic site`;
      } else {
        tone = QUALITY_TEXT.high_quality;
        assessmentLine = `\nClean single-topic site`;
      }
    } else if (p.aiAssessment) {
      const isLow = isLowConfidence(p.aiConfidence);
      tone = isLow
        ? NEUTRAL_TEXT
        : (QUALITY_TEXT[p.aiAssessment] ?? NEUTRAL_TEXT);
      if (typeof p.aiConfidence === "number") {
        const pct = Math.round(p.aiConfidence * 100);
        assessmentLine = `\nAI: ${p.aiAssessment} · confidence ${pct}%`;
      } else {
        assessmentLine = `\nAI: ${p.aiAssessment}`;
      }
    }
    return (
      <span
        key={p.key}
        className={`leading-none text-sm font-semibold ${tone}`}
        title={`${p.fullName} (${p.rows.toLocaleString()})${assessmentLine}${sourceSuffix}`}
      >
        {p.letter}
      </span>
    );
  };

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
      {/* Row number — bumped up 2026-05-17 from a muted text-xs to a
          prominent semibold text-base so operators can scan position
          at a glance without leaning in. */}
      <td className="px-3 py-2 align-top text-right text-base font-semibold text-neutral-700 dark:text-neutral-200 font-mono tabular-nums">
        {rowNumber}
      </td>
      <td className="px-3 py-2 align-top">
        <span className="inline-flex items-baseline gap-1.5 max-w-full">
          {domainHref ? (
            <Link
              href={domainHref}
              className="font-mono text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-200 hover:underline break-all"
            >
              {row.domain}
            </Link>
          ) : (
            <span className="font-mono text-neutral-700 dark:text-neutral-300 break-all">
              {row.domain}
            </span>
          )}
          {/* One-click copy (added 2026-05-23). The Link wraps just
              the text so a click-on-text still navigates; the copy
              affordance is a separate sibling button so the gestures
              stay unambiguous. The button is dim by default and
              brightens on row hover — discoverable but not visually
              competing with the verdict pills. */}
          <CopyDomainButton domain={row.domain} />
          {/* One-click view-only share link (added 2026-05-24). Same
              dim-by-default, brighten-on-hover treatment as the copy
              icon, slotted next to it so the two cell-level actions
              are visually grouped. */}
          <QuickShareButton domain={row.domain} />
        </span>
        {row.is_banned && (
          <span
            className="ml-2 inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
            title={ts.bannedBadgeHint}
          >
            {ts.bannedBadge}
          </span>
        )}
        {/* Metadata chips. DR / Age come from the BacklogDomain CSV
            import; RD (f) / B (and a fresher DR) come from the PINNED
            ahrefs_batch_analysis CR (2026-06-02). DR prefers the batch
            value when present, falling back to the import-time DR. */}
        {(() => {
          const bm = row.batch_metrics ?? {};
          const batchDr = bm.domain_rating;
          const dr = batchDr != null ? batchDr : row.backlog_ahrefs_dr;
          const drFromBatch = batchDr != null;
          const rdf = bm.refdomains_dofollow;
          const bl = bm.backlinks_dofollow;
          const fmtInt = (n: number) => Math.round(n).toLocaleString();
          const hasAny =
            dr != null ||
            row.backlog_domain_age_years != null ||
            rdf != null ||
            bl != null;
          if (!hasAny) return null;
          const chip =
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300";
          const lbl =
            "font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
          return (
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] leading-none">
              {dr != null && (
                <span
                  className={chip}
                  title={
                    drFromBatch
                      ? "Domain Rating from the pinned Ahrefs Batch Analysis run"
                      : "Ahrefs DR (Domain Rating) imported from the backlog CSV"
                  }
                >
                  <span className={lbl}>DR</span>
                  <span className="tabular-nums">
                    {Number.isInteger(dr) ? dr : dr.toFixed(1)}
                  </span>
                </span>
              )}
              {rdf != null && (
                <span
                  className={chip}
                  title="Referring domains (dofollow) from the pinned Ahrefs Batch Analysis run"
                >
                  <span className={lbl}>RD (f)</span>
                  <span className="tabular-nums">{fmtInt(rdf)}</span>
                </span>
              )}
              {bl != null && (
                <span
                  className={chip}
                  title="Backlinks (dofollow) from the pinned Ahrefs Batch Analysis run"
                >
                  <span className={lbl}>B</span>
                  <span className="tabular-nums">{fmtInt(bl)}</span>
                </span>
              )}
              {row.backlog_domain_age_years != null && (
                <span
                  className={chip}
                  title="Domain age (years) imported from the backlog CSV"
                >
                  <span className={lbl}>Age</span>
                  <span className="tabular-nums">
                    {Number.isInteger(row.backlog_domain_age_years)
                      ? `${row.backlog_domain_age_years}y`
                      : `${row.backlog_domain_age_years.toFixed(1)}y`}
                  </span>
                </span>
              )}
            </div>
          );
        })()}
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
            // Grey out when confidence is below threshold OR missing
            // entirely (2026-05-18). Missing confidence is treated as
            // low — matches the per-domain page rule "if we don't know
            // how sure the AI was, don't render in full color."
            const lowConf =
              row.theme_confidence == null ||
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
      <td className="px-3 py-2 align-top text-xs">
        {row.is_pinned ? (
          enabledCriteriaPills.length === 0 ? (
            <span className="text-neutral-400 dark:text-neutral-500">—</span>
          ) : (
            <div className="space-y-2.5">
              {ahrefsPills.length > 0 && (
                <div className="flex flex-wrap gap-x-1.5">
                  {ahrefsPills.map(renderCriterionPill)}
                </div>
              )}
              {auxPills.length > 0 && (
                <div className="flex flex-wrap gap-x-1.5">
                  {auxPills.map(renderCriterionPill)}
                </div>
              )}
            </div>
          )
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      {/* Backlog (queue) cell — last of the operational-state group
          (Criteria → Backlog reads "what ran" → "what stage it's at"). */}
      <td className="px-3 py-2 align-top">
        <BacklogActionsCell
          domain={row.domain}
          backlogStatus={row.backlog_status}
          onUpdated={onBacklogUpdated}
        />
      </td>
      {/* Identity / triage-record trailing group (Max price →
          Availability → Note). 2026-05-23: Source column replaced
          by Max price — same join (BacklogDomain) so no extra
          fetch cost. Right-aligned numeric. Dim when no price set
          on the backlog row (or no backlog row at all).
          2026-05-29: editable for domains that already have a
          backlog row (matches the Backlog page UX). For domains
          WITHOUT a backlog row (row.backlog_id null), the cell
          stays read-only `—` since editing would need an auto-
          create endpoint — operator can click Order/Discard first
          to seed the row, then come back to edit the price. */}
      <td className="px-3 py-2 align-top text-xs text-right tabular-nums text-neutral-700 dark:text-neutral-300">
        {row.backlog_id !== null ? (
          <EditablePriceCell
            value={row.backlog_max_price ?? null}
            onSave={async (v) => {
              const next = v as number | null;
              await api.updateBacklogRow(row.backlog_id as number, {
                max_price: next,
              });
              // Optimistic local merge — see onMaxPriceSaved comment in
              // the parent for why we don't reload. The user reported
              // (2026-05-29) that going through onBacklogUpdated's
              // silent reload made the cell flash the OLD value for
              // 200-500ms after Enter while waiting for the network
              // roundtrip; the merge avoids the flash entirely.
              onMaxPriceSaved(next);
            }}
          />
        ) : typeof row.backlog_max_price === "number" ? (
          // Safety: backlog_id null but the join surfaced a price.
          // Render read-only rather than offering an edit that would
          // 4xx for lack of a target row.
          `$${row.backlog_max_price.toLocaleString()}`
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
      <td className="px-3 py-2 align-top text-xs max-w-[20rem]">
        <EditableTextCell
          value={row.note}
          multiline
          onSave={async (v) => {
            const next = String(v ?? "").trim();
            if (next === "") {
              if (row.note) await api.deleteDomainNote(row.domain);
            } else {
              await api.putDomainNote(row.domain, next);
            }
            onNoteSaved(next);
          }}
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
