"use client";
// Shared Jobs list (Wave 2b, 2026-05-15) — parameterized by pillar
// `kind` so /jobs/quality and /jobs/whois-history (and later
// /jobs/availability) share the same archive/select/delete/search
// machinery. Per-pillar copy + the "go to Check" empty-state link
// come from i18n keys keyed by `kind`.
//
// History: started as /jobs/page.tsx → moved to /jobs/quality/page.tsx
// in Wave 1 → extracted here in Wave 2b once a second pillar needed
// the same shape.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, JobKind, JobsArchivedFilter, JobsListItem } from "@/lib/api";
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

// Per-pillar links the empty-state CTA points at.
const CHECK_LINK_BY_KIND: Record<JobKind, string> = {
  quality: "/check/quality",
  whois_history: "/check/whois-history",
  availability: "/check/availability",
  ahrefs_batch_analysis: "/check/ahrefs-batch-analysis",
};

export function JobsListByKind({ kind }: { kind: JobKind }) {
  const { t } = useT();
  // Per-pillar headings + empty-state CTA copy live under a tagged
  // sub-object so we don't pollute the legacy `pages.jobs` namespace
  // (which the Quality page's i18n still owns).
  const tsBase = t.pages.jobs;
  const tsKind = t.pages.jobsByKind[kind];

  const [tab, setTab] = useState<JobsArchivedFilter>("active");
  const [jobs, setJobs] = useState<JobsListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<
    "idle" | "deleting" | "archiving" | "unarchiving" | "importing"
  >("idle");
  // Import flow: a hidden file input the "Import" button clicks. We
  // route the file picker through it (instead of an inline `<input
  // type=file>`) so the visible button can match the other toolbar
  // buttons' styling. Result banner stays in component state until the
  // user dismisses or kicks off another import.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<{
    ok: boolean;
    message: string;
    job_id?: number;
  } | null>(null);
  const router = useRouter();

  const reload = useCallback(async () => {
    try {
      const d = await api.listJobs(tab, kind);
      setJobs(d.jobs);
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
  }, [tab, kind]);

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
    if (!window.confirm(tsBase.bulk.deleteConfirm(selected.size))) return;
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

  async function handleImportFile(file: File) {
    setBusy("importing");
    setImportResult(null);
    try {
      const r = await api.importJob(file);
      // Soft-warn on pillar mismatch: importing a Whois bundle into the
      // Quality jobs page works (the row carries `kind` so it lands in
      // the correct list either way), but the user is probably about
      // to be confused about which list to look at.
      if (r.kind && r.kind !== kind) {
        setImportResult({
          ok: true,
          message: `Imported a "${r.kind}" job — see the ${r.kind} jobs list.`,
          job_id: r.job_id,
        });
      } else if (r.dupe_skipped) {
        setImportResult({
          ok: true,
          message: `Already imported — opened existing Job #${r.job_id}.`,
          job_id: r.job_id,
        });
      } else {
        setImportResult({
          ok: true,
          message:
            `Imported Job #${r.job_id}: ${r.runs} run(s), ${r.run_domains} domain(s), ${r.criterion_results} CR(s)` +
            (r.job_criterion_pins ? `, ${r.job_criterion_pins} pin(s)` : ``) +
            `.`,
          job_id: r.job_id,
        });
      }
      await reload();
    } catch (e) {
      setImportResult({
        ok: false,
        message: `Import failed: ${(e as Error).message}`,
      });
    } finally {
      setBusy("idle");
      // Reset the input so picking the same file again re-fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const showArchiveAction = tab !== "archived";
  const showUnarchiveAction = tab !== "active";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{tsKind.title}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {tsKind.intro}
          </p>
        </div>
        {/* Import a Job bundle exported from another instance. Hidden
            file input + visible button so the styling matches the
            rest of the toolbar. Re-importing the same bundle is a
            safe no-op (the server's UUID lookup dupe-skips). */}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gz,.json,application/gzip,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportFile(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== "idle"}
            className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy === "importing" ? "Importing…" : "Import Job"}
          </button>
        </div>
      </div>

      {importResult && (
        <div
          className={
            "flex items-start gap-3 rounded-md px-3 py-2 text-sm " +
            (importResult.ok
              ? "border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-900 dark:text-green-200"
              : "border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 text-red-900 dark:text-red-300")
          }
        >
          <div className="flex-1">{importResult.message}</div>
          {importResult.ok && importResult.job_id !== undefined && (
            <button
              type="button"
              onClick={() => router.push(`/jobs/${importResult.job_id}`)}
              className="text-xs underline"
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={() => setImportResult(null)}
            className="text-xs opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

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
                {tsBase.tabs[k]}
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
            {tab === "archived" ? tsBase.emptyArchived : tsKind.empty}
          </p>
          {tab !== "archived" && (
            <Link
              href={CHECK_LINK_BY_KIND[kind]}
              className="inline-block text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
            >
              {tsKind.goCheck}
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
                {tsBase.bulk.selected(selected.size)}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                {showArchiveAction && (
                  <button
                    type="button"
                    onClick={bulkArchive}
                    disabled={busy !== "idle"}
                    className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {busy === "archiving"
                      ? tsBase.bulk.archiving
                      : tsBase.bulk.archive}
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
                      ? tsBase.bulk.unarchiving
                      : tsBase.bulk.unarchive}
                  </button>
                )}
                <button
                  type="button"
                  onClick={bulkDelete}
                  disabled={busy !== "idle"}
                  className="text-xs px-2 py-1 rounded-md border border-red-300 dark:border-red-700/50 text-red-700 dark:text-red-400 bg-white dark:bg-neutral-900 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  {busy === "deleting"
                    ? tsBase.bulk.deleting
                    : tsBase.bulk.delete}
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
                  <th className="px-3 py-2 font-medium">{tsBase.cols.name}</th>
                  <th className="px-3 py-2 font-medium">{tsBase.cols.notes}</th>
                  <th className="px-3 py-2 font-medium">{tsBase.cols.runs}</th>
                  <th className="px-3 py-2 font-medium">
                    {tsBase.cols.created}
                  </th>
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
                          {tsBase.archivedBadge}
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
