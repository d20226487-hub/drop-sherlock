"use client";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useT } from "@/lib/i18n";
import { PAGE_SIZE_OPTIONS, PaginatedSearch } from "@/lib/use-paginated-search";

/** Top bar with optional search + page-size selector. Pass `searchable={false}`
 * to hide the search input on lists where it doesn't make sense (e.g. runs). */
export function PaginationTopBar<T>({
  state,
  searchable = true,
  searchPlaceholder,
}: {
  state: PaginatedSearch<T>;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      {searchable && (
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            value={state.query}
            onChange={(e) => state.setQuery(e.target.value)}
            placeholder={searchPlaceholder || t.pagination.searchPlaceholder}
            className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 pl-7 pr-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>
      )}
      <label className="text-xs text-neutral-500 dark:text-neutral-400 inline-flex items-center gap-2">
        {t.pagination.perPage}
        <select
          value={state.pageSize}
          onChange={(e) => state.setPageSize(parseInt(e.target.value, 10))}
          className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Bottom bar — count summary + prev/next + page x/n. */
export function PaginationBottomBar<T>({ state }: { state: PaginatedSearch<T> }) {
  const { t } = useT();
  const ts = t.pagination;
  const summary =
    state.total === state.filteredTotal
      ? ts.showingX(state.start, state.end, state.total)
      : ts.showingFiltered(
          state.start,
          state.end,
          state.filteredTotal,
          state.total,
        );

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
      <span>{summary}</span>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs">{ts.page(state.page, state.pageCount)}</span>
        <button
          type="button"
          onClick={() => state.setPage(state.page - 1)}
          disabled={state.page <= 1}
          className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          <ChevronLeft className="w-3 h-3" /> {ts.prev}
        </button>
        <button
          type="button"
          onClick={() => state.setPage(state.page + 1)}
          disabled={state.page >= state.pageCount}
          className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          {ts.next} <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
