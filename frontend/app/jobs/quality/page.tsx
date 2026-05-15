"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, JobsArchivedFilter, JobsListItem } from "@/lib/api";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import {
  PaginationBottomBar,
  PaginationTopBar,
} from "@/components/pagination-bar";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const TABS: JobsArchivedFilter[] = ["active", "archived", "all"];

export default function JobsListPage() {
  const { t } = useT();
  const ts = t.pages.jobs;
  const [tab, setTab] = useState<JobsArchivedFilter>("active");
  const [jobs, setJobs] = useState<JobsListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selection: a Set of job ids. Cleared whenever the tab or list reloads
  // since stale ids might no longer exist.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"idle" | "deleting" | "archiving" | "unarchiving">(
    "idle",
  );

  const reload = useCallback(async () => {
    try {
      const d = await api.listJobs(tab);
      setJobs(d.jobs);
      // Drop any selected ids not in the new list (e.g. after archive).
      setSelected((s) => {
        const next = new Set<number>();
        const ids = new Set(d.jobs.map((j) => j.id));
        for (const id of s) if (ids.has(id)) next.add(id);
        return next;
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tab]);

  useEffect(() => {
    reload();
  }, [reload]);

  const matchJob = useCallback(
    (j: JobsListItem, q: string) =>
      j.name.toLowerCase().includes(q) ||
      j.notes.toLowerCase().includes(q),
    [],
  );
  const search = usePaginatedSearch(jobs ?? [], matchJob);

  // Select-all checkbox semantics: checks all rows on the CURRENT page.
  const allOnPageSelected =
    search.paged.length > 0 &&
    search.paged.every((j) => selected.has(j.id));
  function toggleAllOnPage() {
    setSelected((s) => {
      const next = new Set(s);
      if (allOnPageSelected) {
        for (const j of search.paged) next.delete(j.id);
      } else {
        for (const j of search.paged) next.add(j.id);
      }
      return next;
    });
  }
  function toggleOne(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(ts.bulk.deleteConfirm(selected.size))) return;
    setBusy("deleting");
    try {
      await api.bulkDeleteJobs(Array.from(selected));
      await reload();
    } finally {
      setBusy("idle");
    }
  }

  async function bulkArchive() {
    if (selected.size === 0) return;
    setBusy("archiving");
    try {
      for (const id of Array.from(selected)) {
        await api.archiveJob(id);
      }
      await reload();
    } finally {
      setBusy("idle");
    }
  }

  async function bulkUnarchive() {
    if (selected.size === 0) return;
    setBusy("unarchiving");
    try {
      for (const id of Array.from(selected)) {
        await api.unarchiveJob(id);
      }
      await reload();
    } finally {
      setBusy("idle");
    }
  }

  const showArchiveAction = tab !== "archived";
  const showUnarchiveAction = tab !== "active";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {ts.intro}
        </p>
      </div>

      <div className="border-b dark:border-neutral-800 -mb-px">
        <nav className="flex flex-wrap gap-1">
          {TABS.map((k) => {
            const active = tab === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={
                  "px-3 py-2 text-sm border-b-2 transition-colors " +
                  (active
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200")
                }
              >
                {ts.tabs[k]}
              </button>
            );
          })}
        </nav>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {jobs === null && !error && (
        <div className="text-sm text-neutral-500">{t.common.loading}</div>
      )}

      {jobs && jobs.length === 0 && (
        <div className="rounded-md border border-dashed dark:border-neutral-700 p-6 space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {tab === "archived" ? ts.emptyArchived : ts.empty}
          </p>
          {tab !== "archived" && (
            <Link
              href="/analyze"
              className="inline-block text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
            >
              {ts.goAnalyze}
            </Link>
          )}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <>
          <PaginationTopBar
            state={search}
            searchPlaceholder="Search by name or notes…"
          />

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-300 dark:border-blue-700/50 bg-blue-50 dark:bg-blue-900/20 px-3 py-2">
              <span className="text-sm text-blue-900 dark:text-blue-200 font-medium">
                {ts.bulk.selected(selected.size)}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                {showArchiveAction && (
                  <button
                    type="button"
                    onClick={bulkArchive}
                    disabled={busy !== "idle"}
                    className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {busy === "archiving" ? ts.bulk.archiving : ts.bulk.archive}
                  </button>
                )}
                {showUnarchiveAction && (
                  <button
                    type="button"
                    onClick={bulkUnarchive}
                    disabled={busy !== "idle"}
                    className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {busy === "unarchiving"
                      ? ts.bulk.unarchiving
                      : ts.bulk.unarchive}
                  </button>
                )}
                <button
                  type="button"
                  onClick={bulkDelete}
                  disabled={busy !== "idle"}
                  className="text-xs px-2 py-1 rounded-md border border-red-300 dark:border-red-700/50 text-red-700 dark:text-red-400 bg-white dark:bg-neutral-900 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  {busy === "deleting" ? ts.bulk.deleting : ts.bulk.delete}
                </button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleAllOnPage}
                      aria-label="Select all on page"
                      className="rounded border-neutral-300 dark:border-neutral-700"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">{ts.cols.name}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.notes}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.runs}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.created}</th>
                </tr>
              </thead>
              <tbody>
                {search.paged.map((j) => (
                  <tr
                    key={j.id}
                    className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(j.id)}
                        onChange={() => toggleOne(j.id)}
                        aria-label={`Select ${j.name}`}
                        className="rounded border-neutral-300 dark:border-neutral-700"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/jobs/${j.id}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {j.name || `Job #${j.id}`}
                      </Link>
                      {j.archived_at && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          {ts.archivedBadge}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400 max-w-[24rem] truncate">
                      {j.notes || (
                        <span className="text-neutral-400 dark:text-neutral-500">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {j.run_count}
                    </td>
                    <td className="px-3 py-2 text-neutral-500 dark:text-neutral-500 whitespace-nowrap">
                      {formatDate(j.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {search.filteredTotal === 0 && (
            <p className="text-sm text-neutral-500">{t.pagination.none}</p>
          )}
          <PaginationBottomBar state={search} />
        </>
      )}
    </div>
  );
}
