"use client";
import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { CriterionDetail } from "@/lib/api";

type SortDir = "asc" | "desc";
type SortState = { field: string; dir: SortDir } | null;

/** Compare arbitrary values for sort. Numbers numerically, dates as ms,
 * booleans true>false, strings case-insensitively. Nulls sort last. */
function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined || a === "";
  const bNull = b === null || b === undefined || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls last
  if (bNull) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? -1 : 1;
  }
  // ISO date strings sort correctly lexicographically, but we coerce
  // anyway in case of mixed types.
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

// Default columns per criterion — picked for SEO judgment value. Power users
// can hit "Show raw row" to see the rest. Order matters: leftmost columns
// are the ones the user scans first.
const DEFAULT_COLUMNS: Record<string, string[]> = {
  // Trimmed 2026-05-10 to match backend SELECT_FIELDS["backlinks"]:
  // dropped is_dofollow / is_spam (no longer fetched — would render as
  // "—"). snippet/url_to are available via "Show raw row" but not
  // shown by default since they're long-text and crowd the table.
  backlinks: [
    "url_from",
    "anchor",
    "domain_rating_source",
    "url_rating_source",
    "traffic_domain",
    "refdomains_source",
    "first_seen_link",
  ],
  // Trimmed 2026-05-10: dropped is_spam (no longer fetched).
  refdomains: [
    "domain",
    "domain_rating",
    "dofollow_links",
    "links_to_target",
    "traffic_domain",
    "first_seen",
  ],
  // Trimmed 2026-05-10: dropped is_spam (no longer fetched).
  anchors: [
    "anchor",
    "refdomains",
    "refpages",
    "dofollow_links",
    "links_to_target",
    "top_domain_rating",
  ],
  // Trimmed 2026-05-10 to match the slimmed Ahrefs SELECT (see
  // backend ahrefs_requests.py SELECT_FIELDS["keywords"] for the
  // rationale). Showing dropped columns here would just render "—" in
  // every cell — confusing and a wrong cost-saved signal.
  keywords: [
    "keyword",
    "volume",
    "best_position",
    "sum_traffic",
    "keyword_difficulty",
    "is_branded",
  ],
  // Wayback CDX rows. `original` is the URL crawled at that timestamp;
  // `statuscode` is critical for spotting 301 patterns. `digest` skipped
  // (just hash noise).
  wayback: [
    "timestamp",
    "original",
    "statuscode",
    "mimetype",
    "length",
  ],
};

// Display helpers — shorten long URLs, show booleans nicely, truncate.
function renderCell(key: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "")
    return <span className="text-neutral-400 dark:text-neutral-500">—</span>;
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    if (key.includes("url")) {
      const short = value.length > 60 ? value.slice(0, 60) + "…" : value;
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 font-mono text-xs"
        >
          {short}
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
      );
    }
    if (
      key === "first_seen_link" ||
      key === "last_seen" ||
      key === "first_seen" ||
      key === "fetched_at"
    ) {
      try {
        return (
          <span className="whitespace-nowrap font-mono text-xs">
            {new Date(value).toLocaleDateString()}
          </span>
        );
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) return value.join(", ");
  return JSON.stringify(value);
}

function Row({ row, columns }: { row: Record<string, unknown>; columns: string[] }) {
  const [open, setOpen] = useState(false);
  const { t } = useT();
  return (
    <>
      <tr className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/60">
        <td className="px-2 py-2 align-top">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            aria-label={open ? t.pages.jobs.domain.hideRaw : t.pages.jobs.domain.showRaw}
          >
            {open ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        </td>
        {columns.map((c) => (
          <td key={c} className="px-2 py-2 align-top text-sm break-words max-w-[24rem]">
            {renderCell(c, row[c])}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="bg-neutral-50 dark:bg-neutral-900/40">
          <td />
          <td colSpan={columns.length} className="px-2 py-2">
            <pre className="text-xs bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 overflow-x-auto border dark:border-neutral-800 whitespace-pre-wrap break-all">
              {JSON.stringify(row, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function CriterionTable({
  criterion,
  detail,
  // When true, suppress operator-only widgets above the table:
  // request-URL toggle, "data from cache · Run #N" badge, and the
  // Ahrefs units pill. Used by the public share page (/share/[token])
  // where the recipient shouldn't see internal IDs / Ahrefs spend.
  // Defaults to false so every existing call site keeps its current
  // behavior; only the share-page caller passes `true`.
  viewOnly = false,
}: {
  criterion: string;
  detail: CriterionDetail | undefined;
  viewOnly?: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain;
  const [showUrl, setShowUrl] = useState(false);

  if (!detail) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {ts.criterionMissing}
      </p>
    );
  }
  if (detail.status === "failed") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-600 dark:text-red-400">
          {ts.criterionFailed}
          {detail.error && <>: {detail.error}</>}
        </p>
        {/* Request-URL toggle is operator-only debugging output —
            suppress on the public share page (viewOnly=true). */}
        {!viewOnly && (
          <RequestUrlBlock
            showUrl={showUrl}
            onToggle={() => setShowUrl((s) => !s)}
            url={detail.request_url}
          />
        )}
      </div>
    );
  }
  if (!detail.rows || detail.rows.length === 0) {
    // In viewOnly: render nothing. wayback_classify has no rows by
    // design (it's a derived verdict, not a fetched dataset), and
    // empty Ahrefs criteria (e.g. zero organic keywords on a
    // low-volume domain) are operator-internal scaffolding too. The
    // VerdictBox rendered ABOVE this table already conveys what the
    // AI judged. Showing "No rows returned." + "View request URL" on
    // a public share page is confusing for the recipient and leaks
    // operator UX wording.
    if (viewOnly) return null;
    return (
      <div className="space-y-2">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.criterionEmpty}
        </p>
        <RequestUrlBlock
          showUrl={showUrl}
          onToggle={() => setShowUrl((s) => !s)}
          url={detail.request_url}
        />
      </div>
    );
  }

  const defaultColumns =
    DEFAULT_COLUMNS[criterion] || Object.keys(detail.rows[0] || {});
  // Interleave `_prev` mirrors when the row data carries them. Applies
  // to organic-keywords with `date_compared` set (2026-05-17 fix): the
  // base fields are null on "lost keyword" rows and the real values
  // live on `keyword_prev`, `sum_traffic_prev`, etc. Without this the
  // table looked empty even though the rows had real comparison data.
  // Detect by probing the first row for the `${col}_prev` key.
  const sampleRow = (detail.rows[0] || {}) as Record<string, unknown>;
  const baseColumns: string[] = [];
  for (const col of defaultColumns) {
    baseColumns.push(col);
    const prev = `${col}_prev`;
    if (prev in sampleRow && !defaultColumns.includes(prev)) {
      baseColumns.push(prev);
    }
  }
  const sortColumns = detail.sort_columns ?? [];
  // Append any user-chosen sort columns that aren't already in the default
  // set so the user can eyeball the ordering Ahrefs returned. Order matters:
  // sort columns appended at the end are easy to spot.
  const extraSortColumns = sortColumns.filter((c) => !baseColumns.includes(c));
  const columns = [...baseColumns, ...extraSortColumns];
  const sortColumnSet = new Set(sortColumns);

  return (
    <SortableTable
      rows={detail.rows as Record<string, unknown>[]}
      columns={columns}
      sortColumnSet={sortColumnSet}
      rowCountLabel={ts.rowCount(detail.rows.length)}
      requestUrl={detail.request_url}
      cachedFromRunId={detail.cached_from_run_id}
      unitsCostRow={detail.units_cost_row}
      unitsCostTotal={detail.units_cost_total}
      unitsCostActual={detail.units_cost_actual}
      showUrl={showUrl}
      onToggleUrl={() => setShowUrl((s) => !s)}
      viewOnly={viewOnly}
    />
  );
}

function SortableTable({
  rows,
  columns,
  sortColumnSet,
  rowCountLabel,
  requestUrl,
  cachedFromRunId,
  unitsCostRow,
  unitsCostTotal,
  unitsCostActual,
  showUrl,
  onToggleUrl,
  viewOnly,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  sortColumnSet: Set<string>;
  rowCountLabel: string;
  requestUrl: string;
  cachedFromRunId: number | null;
  unitsCostRow: number | null;
  unitsCostTotal: number | null;
  unitsCostActual: number | null;
  showUrl: boolean;
  onToggleUrl: () => void;
  viewOnly: boolean;
}) {
  const { t } = useT();
  const [sort, setSort] = useState<SortState>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const dirSign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort(
      (a, b) => dirSign * compareValues(a[sort.field], b[sort.field]),
    );
  }, [rows, sort]);

  function clickHeader(c: string) {
    setSort((cur) => {
      if (!cur || cur.field !== c) return { field: c, dir: "desc" };
      if (cur.dir === "desc") return { field: c, dir: "asc" };
      return null; // third click clears the sort, reverting to API order
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {rowCountLabel}
          </p>
          {/* Cache provenance + Ahrefs unit accounting + the request
              URL toggle are operator-only — suppress in viewOnly so the
              public share page doesn't leak internal run IDs, spend
              numbers, or the raw Ahrefs request signature. The
              `cachedFromRunId != null` guard (loose !=) also catches
              the `undefined` we get from the sanitized public payload —
              tighter than the previous `!== null` which let undefined
              through and rendered "Run #undefined". */}
          {!viewOnly && cachedFromRunId != null && (
            <span
              className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
              title="Reused from a prior run with matching criteria"
            >
              {t.pages.jobs.domain.dataCachedFromRun(cachedFromRunId)}
            </span>
          )}
          {!viewOnly && (
            <UnitsChip
              cachedFromRunId={cachedFromRunId}
              costRow={unitsCostRow}
              costTotal={unitsCostTotal}
              costActual={unitsCostActual}
            />
          )}
        </div>
        {!viewOnly && (
          <RequestUrlBlock
            showUrl={showUrl}
            onToggle={onToggleUrl}
            url={requestUrl}
          />
        )}
      </div>
      <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              <th className="px-2 py-2 w-6" />
              {columns.map((c) => {
                const active = sort?.field === c;
                const isApiSort = sortColumnSet.has(c);
                return (
                  <th
                    key={c}
                    className={
                      "px-2 py-2 font-medium whitespace-nowrap select-none " +
                      (isApiSort
                        ? "bg-amber-50 dark:bg-amber-900/20"
                        : "")
                    }
                    title={
                      isApiSort
                        ? "Sorted by Ahrefs API (chosen at submit time)"
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      onClick={() => clickHeader(c)}
                      className={
                        "inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400 " +
                        (active ? "text-blue-600 dark:text-blue-400" : "")
                      }
                    >
                      {c}
                      {isApiSort && (
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300">
                          api
                        </span>
                      )}
                      {active && sort.dir === "desc" && (
                        <ChevronDown className="w-3 h-3" />
                      )}
                      {active && sort.dir === "asc" && (
                        <ChevronUp className="w-3 h-3" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, idx) => (
              <Row key={idx} row={row} columns={columns} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UnitsChip({
  cachedFromRunId,
  costRow,
  costTotal,
  costActual,
}: {
  cachedFromRunId: number | null;
  costRow: number | null;
  costTotal: number | null;
  costActual: number | null;
}) {
  const { t } = useT();
  const tu = t.pages.jobs.domain.units;
  // 1) drop-sherlock cache: no Ahrefs call was made — explicit 0 + cached pill.
  if (cachedFromRunId !== null) {
    return (
      <span
        className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
        title={tu.tooltip}
      >
        ✦ {tu.cached}
      </span>
    );
  }
  // 2) No unit data captured (legacy row before this feature shipped).
  if (costTotal == null && costActual == null) {
    return null;
  }
  const actual = costActual ?? 0;
  const total = costTotal ?? actual;
  const ahrefsCached = total > 0 && actual === 0;
  const tone = ahrefsCached
    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300"
    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  // 3) Ahrefs server-side cache: total > 0 but actual = 0.
  // 4) Fresh fetch: total = actual (or close to it).
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
      title={ahrefsCached ? tu.ahrefsCachedHint(total) : tu.tooltip}
    >
      ✦ {tu.actual(actual)}
      {ahrefsCached && (
        <span className="ml-1 opacity-70">
          / {total} list
        </span>
      )}
      {costRow != null && (
        <span className="ml-1 opacity-60">· {tu.perRow(costRow)}</span>
      )}
    </span>
  );
}


function RequestUrlBlock({
  showUrl,
  onToggle,
  url,
}: {
  showUrl: boolean;
  onToggle: () => void;
  url: string;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain;
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onToggle}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.viewRequest}
      </button>
      {showUrl && (
        <pre className="text-xs bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 overflow-x-auto border dark:border-neutral-800 break-all whitespace-pre-wrap">
          {url}
        </pre>
      )}
    </div>
  );
}
