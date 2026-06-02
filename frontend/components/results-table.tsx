"use client";

// Reusable results table used by both Tools pages (Ahrefs + Wayback).
// Provides:
//   - Column definition (label + cell renderer + optional CSV mapper)
//   - Free-text search across every column's CSV value (sticky, debounced)
//   - Client-side OR server-side pagination
//   - Copy-to-clipboard for the visible rows (TSV — Excel-friendly)
//   - CSV export of either the visible page or the whole filtered set
//
// Mode A — client-side: pass the whole `rows: T[]` array; the table
// filters, sorts, and paginates locally. Used by the Ahrefs Tools page
// (200-row caps fit comfortably in memory).
//
// Mode B — server-side: pass `serverPagination = { page, pageSize,
// total, onPageChange, onPageSizeChange }`. The parent owns the row
// fetch + search + sort; the table just renders. Used by the Wayback
// Tools page (100k-row batches).
//
// Both modes share the same toolbar (Search box + Export + Copy) so
// the UX is identical regardless of mode. The toolbar respects the
// active filter — Export-CSV exports the filtered set, not the raw
// input list.
import { useMemo, useState } from "react";

export type ResultsColumn<T> = {
  // Unique key — also used as the React list key for cells.
  key: string;
  // Header label.
  label: string;
  // Optional CSS class for the cell + header (alignment, font, etc.).
  className?: string;
  // Optional CSS class for the header only (sort affordance).
  headerClassName?: string;
  // Render function for the cell. Should return JSX.
  render: (row: T) => React.ReactNode;
  // CSV / clipboard / search value. Returned as a string. Defaults
  // to "" so columns with no exportable representation (e.g. pure
  // action buttons) don't pollute the export.
  toExport?: (row: T) => string;
  // When true, the search box matches against this column. Defaults
  // to true if toExport is set. Set false on pure-action columns.
  searchable?: boolean;
};

export type ServerPagination = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  // Parent owns search input when server-side; the table just lifts
  // the q value up. Optional — when omitted, the search box hides
  // (parent has its own search input).
  search?: string;
  onSearchChange?: (q: string) => void;
  pageSizeOptions?: number[];
};

const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500];

export function ResultsTable<T>({
  rows,
  columns,
  emptyMessage = "No rows.",
  csvFilename = "export.csv",
  // Show "0 of N matched" when search is active. Stays subtle but
  // tells the operator the export size at a glance.
  showCount = true,
  // Server-side pagination overrides client-side filtering /
  // pagination entirely. Search is still rendered IF the parent
  // wired up onSearchChange.
  serverPagination,
  // Extra toolbar items (e.g. status filter dropdown). Rendered
  // between the search box and the action buttons. Optional.
  toolbarExtras,
  // Initial sort applied client-side. Server-side ignores this —
  // the parent sorts via its API call.
  initialSort,
}: {
  rows: T[];
  columns: ResultsColumn<T>[];
  emptyMessage?: string;
  csvFilename?: string;
  showCount?: boolean;
  serverPagination?: ServerPagination;
  toolbarExtras?: React.ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  // Local-only state. Server-side mode short-circuits both.
  const [clientQuery, setClientQuery] = useState("");
  const [clientPage, setClientPage] = useState(1);
  const [clientPageSize, setClientPageSize] = useState(50);
  const [clientSort, setClientSort] = useState<
    { key: string; dir: "asc" | "desc" } | null
  >(initialSort ?? null);

  // Resolve effective values from the active mode.
  const serverMode = !!serverPagination;
  const query = serverMode
    ? (serverPagination?.search ?? "")
    : clientQuery;
  const setQuery = serverMode
    ? (serverPagination?.onSearchChange ?? (() => {}))
    : (q: string) => {
        setClientQuery(q);
        setClientPage(1);
      };
  const page = serverMode ? serverPagination!.page : clientPage;
  const pageSize = serverMode ? serverPagination!.pageSize : clientPageSize;
  const pageSizeOptions =
    serverPagination?.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;

  // Client-side filter + sort + paginate. Server-side mode skips
  // everything and renders the parent-provided rows as-is.
  const { displayRows, filteredTotal } = useMemo(() => {
    if (serverMode) {
      return { displayRows: rows, filteredTotal: serverPagination!.total };
    }
    // Substring search across every searchable column's CSV value.
    const q = query.trim().toLowerCase();
    let filtered = rows;
    if (q) {
      filtered = rows.filter((row) =>
        columns.some((c) => {
          const searchable = c.searchable ?? !!c.toExport;
          if (!searchable || !c.toExport) return false;
          return c.toExport(row).toLowerCase().includes(q);
        }),
      );
    }
    if (clientSort) {
      const col = columns.find((c) => c.key === clientSort.key);
      if (col?.toExport) {
        const sign = clientSort.dir === "asc" ? 1 : -1;
        filtered = [...filtered].sort((a, b) => {
          const av = col.toExport!(a);
          const bv = col.toExport!(b);
          // Coerce to number when both sides parse cleanly so
          // count columns sort numerically not lexicographically.
          const an = Number(av);
          const bn = Number(bv);
          if (!Number.isNaN(an) && !Number.isNaN(bn)) {
            return (an - bn) * sign;
          }
          return av.localeCompare(bv) * sign;
        });
      }
    }
    const start = (clientPage - 1) * clientPageSize;
    return {
      displayRows: filtered.slice(start, start + clientPageSize),
      filteredTotal: filtered.length,
    };
  }, [
    rows,
    columns,
    query,
    clientPage,
    clientPageSize,
    clientSort,
    serverMode,
    serverPagination,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const currentPage = Math.min(page, totalPages);

  function exportRows(scope: "page" | "all"): void {
    // For server-side mode the parent must hand us the full filtered
    // set on demand — but realistically a 100k CSV export is what the
    // user wants from a sparkline batch, so we don't try to be clever
    // here: we export whatever the parent's currently-rendered rows
    // are. The Wayback page has a separate "Download CSV" button that
    // fans out across pages; this table-level export is for the
    // page view. (Client mode exports the filtered set in full.)
    const exportable = serverMode || scope === "page" ? displayRows : (() => {
      // Re-derive filtered without pagination for client mode.
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((row) =>
        columns.some((c) => {
          const searchable = c.searchable ?? !!c.toExport;
          if (!searchable || !c.toExport) return false;
          return c.toExport(row).toLowerCase().includes(q);
        }),
      );
    })();
    const csv = toCsv(exportable, columns);
    downloadCsv(csv, csvFilename);
  }

  async function copyVisible(): Promise<void> {
    const tsv = toTsv(displayRows, columns);
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Fallback for browsers that block clipboard.writeText in
      // non-secure contexts (rare in this LAN deploy but defensive).
      const ta = document.createElement("textarea");
      ta.value = tsv;
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
  }

  function setPage(p: number): void {
    if (serverMode) serverPagination!.onPageChange(p);
    else setClientPage(p);
  }
  function setPageSize(s: number): void {
    if (serverMode) serverPagination!.onPageSizeChange(s);
    else {
      setClientPageSize(s);
      setClientPage(1);
    }
  }

  function toggleSort(key: string): void {
    if (serverMode) return; // server mode owns sort
    setClientSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  return (
    <div className="space-y-2">
      {/* Toolbar: search + extras + actions */}
      <div className="flex flex-wrap items-center gap-2">
        {(serverPagination?.onSearchChange || !serverMode) && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 min-w-[14rem] max-w-md rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        )}
        {toolbarExtras}
        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => copyVisible()}
            disabled={displayRows.length === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
            title="Copy visible rows to clipboard (TSV, Excel-friendly)"
          >
            Copy page
          </button>
          <button
            type="button"
            onClick={() => exportRows("page")}
            disabled={displayRows.length === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
          >
            CSV page
          </button>
          {!serverMode && (
            <button
              type="button"
              onClick={() => exportRows("all")}
              disabled={filteredTotal === 0}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40"
              title="Export every row matching the current search"
            >
              CSV all ({filteredTotal.toLocaleString()})
            </button>
          )}
        </div>
      </div>

      {showCount && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {query
            ? `${filteredTotal.toLocaleString()} match${
                filteredTotal === 1 ? "" : "es"
              }`
            : `${filteredTotal.toLocaleString()} row${
                filteredTotal === 1 ? "" : "s"
              }`}
          {serverMode &&
            ` · server-paginated`}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              {columns.map((c) => {
                const active = clientSort?.key === c.key;
                const arrow = active
                  ? clientSort?.dir === "asc"
                    ? " ▲"
                    : " ▼"
                  : "";
                return (
                  <th
                    key={c.key}
                    className={`px-3 py-2 font-medium ${c.headerClassName ?? c.className ?? ""} ${
                      serverMode || !c.toExport
                        ? ""
                        : "cursor-pointer select-none hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    }`}
                    onClick={() => c.toExport && toggleSort(c.key)}
                  >
                    {c.label}
                    {arrow}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              displayRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.className ?? ""}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {filteredTotal > 0 && (
        <div className="flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400 pt-1">
          <div className="flex items-center gap-2">
            <span>Per page:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-0.5"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              Page {currentPage} of {totalPages.toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- CSV / TSV helpers ----------------------------------------------------
//
// RFC-4180 conformant: double quotes around any field containing
// commas, quotes, newlines, or leading/trailing whitespace. Embedded
// quotes are doubled. CRLF row separator matches Excel's default.

function csvEscape(s: string): string {
  if (s == null) return "";
  const needsQuote = /[",\r\n]|^\s|\s$/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv<T>(rows: T[], columns: ResultsColumn<T>[]): string {
  const exportCols = columns.filter((c) => !!c.toExport);
  const header = exportCols.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) =>
      exportCols
        .map((c) => csvEscape(c.toExport!(row)))
        .join(","),
    )
    .join("\r\n");
  return header + "\r\n" + body + (body ? "\r\n" : "");
}

export function toTsv<T>(rows: T[], columns: ResultsColumn<T>[]): string {
  // Tab-separated for clipboard → Excel paste. No quote escaping
  // (Excel handles tab-delimited paste without it). Replace any tab
  // or newline in cell values with a single space so the row+column
  // alignment survives the paste.
  const exportCols = columns.filter((c) => !!c.toExport);
  const header = exportCols.map((c) => c.label).join("\t");
  const body = rows
    .map((row) =>
      exportCols
        .map((c) => c.toExport!(row).replace(/[\t\r\n]+/g, " "))
        .join("\t"),
    )
    .join("\n");
  return header + "\n" + body;
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
