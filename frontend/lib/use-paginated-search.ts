"use client";
import { useEffect, useMemo, useState } from "react";

const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [20, 50, 100];

export type PaginatedSearch<T> = {
  query: string;
  setQuery: (q: string) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  page: number;
  setPage: (n: number) => void;
  total: number; // unfiltered length
  filteredTotal: number; // post-search length
  filteredAll: T[]; // full post-search list (all pages) — used by CSV export
  pageCount: number;
  paged: T[]; // current page slice
  start: number; // 1-based index of first item on page (for "showing X–Y")
  end: number; // 1-based inclusive index of last item on page
};

/** Client-side search + pagination over an in-memory list. The filter
 * function decides whether an item matches the current query string;
 * caller controls casing and which fields to inspect. */
export function usePaginatedSearch<T>(
  items: T[],
  match: (item: T, query: string) => boolean,
  options?: { initialPageSize?: number },
): PaginatedSearch<T> {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(
    options?.initialPageSize ?? DEFAULT_PAGE_SIZE,
  );
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => match(i, q));
  }, [items, query, match]);

  const filteredTotal = filtered.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));

  // Snap page back into range when items shrink (e.g. typing a search that
  // removes most rows). Avoids "page 5 but only 1 page exists".
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [pageCount, page]);

  const safePage = Math.min(Math.max(1, page), pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const paged = filtered.slice(startIdx, startIdx + pageSize);

  return {
    query,
    setQuery: (q) => {
      setQuery(q);
      setPage(1); // any new search restarts at page 1
    },
    pageSize,
    setPageSize: (n) => {
      setPageSize(n);
      setPage(1);
    },
    page: safePage,
    setPage,
    total: items.length,
    filteredTotal,
    filteredAll: filtered,
    pageCount,
    paged,
    start: filteredTotal === 0 ? 0 : startIdx + 1,
    end: Math.min(filteredTotal, startIdx + pageSize),
  };
}
