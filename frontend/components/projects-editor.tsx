"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api, ProjectRow } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Settings → Projects (added 2026-11-09). The projects a job's API spend is
// booked to: add one (a name is all it takes) or paste a list, rename one,
// delete one. A
// rename shows everywhere at once (jobs and spend point at the project by
// id); a deleted project can no longer be picked, while jobs and past spend
// keep its name. Searched and paged server-side, 20 per page.

const PER_PAGE = 20;

const INPUT =
  "rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40";
const BTN =
  "text-sm px-2.5 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50";

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const detail = JSON.parse(msg)?.detail;
    if (typeof detail === "string") return detail;
  } catch {
    // not JSON
  }
  return msg;
}

export function ProjectsEditor() {
  const { t } = useT();
  const ts = t.pages.settings.projects;
  const tp = t.pagination;
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filtered, setFiltered] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const load = useCallback(async () => {
    try {
      const r = await api.listProjects({ search, page, per_page: PER_PAGE });
      setRows(r.rows);
      setTotal(r.total);
      setFiltered(r.filtered_total);
      // Deleting the last row of the last page: step back a page.
      if (r.rows.length === 0 && page > 1) setPage(page - 1);
    } catch (e) {
      setError(errorText(e));
    }
  }, [search, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>, name: string, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
      await load();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 409 ? ts.duplicate(name) : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    newName.trim() &&
    run(() => api.createProject(newName.trim()), newName.trim(), () => {
      setNewName("");
      setAdding(false);
    });
  const rename = (id: number) =>
    editName.trim() &&
    run(() => api.renameProject(id, editName.trim()), editName.trim(), () => setEditId(null));
  const pasteNames = pasteText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pasteAll = () =>
    pasteNames.length > 0 &&
    run(
      async () => {
        const r = await api.createProjectsBulk(pasteNames);
        setPasteResult(ts.pasteResult(r.added, r.skipped.length));
      },
      "",
      () => {
        setPasteText("");
        setPasting(false);
      },
    );
  const remove = (p: ProjectRow) => {
    if (!window.confirm(ts.deleteConfirm(p.name, p.jobs))) return;
    run(() => api.deleteProject(p.id), p.name);
  };

  const pageCount = Math.max(1, Math.ceil(filtered / PER_PAGE));
  const start = filtered === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const end = Math.min(filtered, page * PER_PAGE);

  return (
    <div className="space-y-3 max-w-3xl">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{ts.intro}</p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={ts.search}
            className={INPUT + " w-full pl-7 py-1.5"}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setPasting(true);
            setAdding(false);
            setPasteResult(null);
          }}
          disabled={pasting}
          className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <ClipboardList className="w-3.5 h-3.5" />
          {ts.paste}
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setPasting(false);
            setEditId(null);
          }}
          disabled={adding}
          className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          {ts.add}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 p-2"
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            placeholder={ts.namePlaceholder}
            maxLength={255}
            className={INPUT + " flex-1 min-w-[200px]"}
          />
          <button type="submit" disabled={busy || !newName.trim()} className={BTN}>
            {ts.save}
          </button>
          <button type="button" onClick={() => setAdding(false)} className={BTN}>
            {ts.cancel}
          </button>
        </form>
      )}

      {pasting && (
        <div className="space-y-2 rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 p-2">
          <p className="text-xs text-neutral-600 dark:text-neutral-400">{ts.pasteHint}</p>
          <textarea
            autoFocus
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setPasting(false)}
            placeholder={ts.pastePlaceholder}
            className={INPUT + " w-full font-mono"}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={pasteAll}
              disabled={busy || pasteNames.length === 0}
              className="text-sm px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            >
              {ts.pasteAdd(pasteNames.length)}
            </button>
            <button type="button" onClick={() => setPasting(false)} className={BTN}>
              {ts.cancel}
            </button>
          </div>
        </div>
      )}

      {pasteResult && !pasting && (
        <p className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          {pasteResult}
        </p>
      )}

      {error && (
        <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="rounded-md border dark:border-neutral-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 bg-neutral-50 dark:bg-neutral-900/60 border-b dark:border-neutral-800">
            <tr>
              <th className="px-3 py-2 font-medium">{ts.colName}</th>
              <th className="px-3 py-2 font-medium text-right">{ts.colJobs}</th>
              <th className="px-3 py-2 font-medium">{ts.colCreated}</th>
              <th className="px-3 py-2 w-24" />
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-neutral-500">
                  {t.common.loading}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-neutral-500">
                  {total === 0 ? ts.empty : ts.noMatch}
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/30"
                >
                  <td className="px-3 py-1.5">
                    {editId === p.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename(p.id);
                        }}
                        className="flex items-center gap-2"
                      >
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => e.key === "Escape" && setEditId(null)}
                          maxLength={255}
                          className={INPUT + " flex-1"}
                        />
                        <button type="submit" disabled={busy || !editName.trim()} className={BTN}>
                          {ts.save}
                        </button>
                        <button type="button" onClick={() => setEditId(null)} className={BTN}>
                          {ts.cancel}
                        </button>
                      </form>
                    ) : (
                      <span className="font-medium">{p.name}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{p.jobs.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-neutral-500 text-xs">
                    {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {editId !== p.id && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditId(p.id);
                            setEditName(p.name);
                            setAdding(false);
                          }}
                          title={ts.edit}
                          aria-label={ts.edit}
                          className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(p)}
                          title={ts.delete}
                          aria-label={ts.delete}
                          className="p-1.5 rounded-md text-neutral-500 hover:text-red-700 hover:bg-red-50 dark:hover:text-red-300 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
          <span>
            {total === filtered
              ? tp.showingX(start, end, total)
              : tp.showingFiltered(start, end, filtered, total)}
          </span>
          {pageCount > 1 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs">{tp.page(page, pageCount)}</span>
              <button
                type="button"
                onClick={() => setPage(page - 1)}
                disabled={page <= 1}
                className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 inline-flex items-center gap-1"
              >
                <ChevronLeft className="w-3 h-3" /> {tp.prev}
              </button>
              <button
                type="button"
                onClick={() => setPage(page + 1)}
                disabled={page >= pageCount}
                className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 inline-flex items-center gap-1"
              >
                {tp.next} <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
