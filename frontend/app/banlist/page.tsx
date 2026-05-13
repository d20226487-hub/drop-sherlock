"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, BanRow } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Ban List page (added 2026-05-13 wave L). Permanent "never analyze /
// backlog this domain again" filter. Distinct from the Backlog
// `discarded` status — a ban is hard, recurring, applied at every
// domain ingestion point on the backend.

export default function BanListPage() {
  const { t } = useT();
  const ts = t.pages.banlist;

  const [rows, setRows] = useState<BanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bulk-select state — same shape as the Database page so the user
  // recognizes the pattern.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Search box: case-insensitive substring match on domain + note.
  const [search, setSearch] = useState("");

  // CSV import panel state. Accept both `domain` and `domain,note`
  // shapes — per design call #4 (domain required, note optional).
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{
    added: number;
    already: number;
    invalid: number;
  } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.listBans();
      setRows(resp.rows);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.domain.toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const allFilteredSelected = useMemo(
    () => filtered.length > 0 && filtered.every((r) => selected.has(r.domain)),
    [filtered, selected],
  );

  const handleToggleRow = useCallback((domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        for (const r of filtered) next.delete(r.domain);
        return next;
      }
      const next = new Set(prev);
      for (const r of filtered) next.add(r.domain);
      return next;
    });
  }, [allFilteredSelected, filtered]);

  const handleBulkUnban = useCallback(async () => {
    if (selected.size === 0) return;
    if (!window.confirm(ts.unbanSelectedConfirm(selected.size))) return;
    try {
      await api.bulkDeleteBans(Array.from(selected));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "bulk unban failed");
    }
  }, [selected, reload, ts]);

  const handleDeleteOne = useCallback(
    async (domain: string) => {
      try {
        await api.deleteBan(domain);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "unban failed");
      }
    },
    [reload],
  );

  const handleCsvImport = useCallback(async () => {
    if (!csvText.trim()) return;
    setImportBusy(true);
    setImportResult(null);
    setError(null);
    // Parse: one row per line, comma separates `domain` and optional
    // `note`. Empty lines and `# comments` are ignored. This mirrors
    // what the Backlog CSV importer accepts so a user can paste from
    // the same spreadsheet without reformatting.
    const lines = csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const payload: { domain: string; note: string }[] = [];
    for (const line of lines) {
      const idx = line.indexOf(",");
      if (idx === -1) {
        payload.push({ domain: line, note: "" });
      } else {
        payload.push({
          domain: line.slice(0, idx).trim(),
          note: line.slice(idx + 1).trim(),
        });
      }
    }
    if (payload.length === 0) {
      setImportBusy(false);
      return;
    }
    try {
      const result = await api.addBans(payload);
      setImportResult({
        added: result.added,
        already: result.already_banned,
        invalid: result.invalid,
      });
      setCsvText("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setImportBusy(false);
    }
  }, [csvText, reload]);

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-6 space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-3xl">
          {ts.hint}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <input
          type="search"
          placeholder={ts.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 w-full sm:w-80"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCsvOpen((v) => !v);
              setImportResult(null);
            }}
            className="text-sm px-3 py-1.5 rounded-md border border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200 hover:bg-sky-100 dark:hover:bg-sky-900/40"
          >
            {csvOpen ? ts.importClose : ts.importOpen}
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={handleBulkUnban}
              className="text-sm px-3 py-1.5 rounded-md border border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              {ts.unbanSelected(selected.size)}
            </button>
          )}
        </div>
      </div>

      {csvOpen && (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 space-y-2 bg-neutral-50/50 dark:bg-neutral-900/30">
          <div>
            <div className="text-sm font-medium">{ts.importTitle}</div>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              {ts.importHint}
            </p>
          </div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={6}
            placeholder={ts.importPlaceholder}
            className="w-full text-xs font-mono px-2 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950"
          />
          <div className="flex items-center justify-between gap-2">
            {importResult ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                {ts.importResult(
                  importResult.added,
                  importResult.already,
                  importResult.invalid,
                )}
              </p>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={handleCsvImport}
              disabled={importBusy || !csvText.trim()}
              className="text-sm px-3 py-1.5 rounded-md border border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
            >
              {importBusy ? ts.importBusy : ts.importSubmit}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={handleToggleAll}
                  aria-label={ts.selectAll}
                />
              </th>
              <th className="px-3 py-2 font-medium">{ts.colDomain}</th>
              <th className="px-3 py-2 font-medium">{ts.colNote}</th>
              <th className="px-3 py-2 font-medium">{ts.colCreatedAt}</th>
              <th className="w-20 px-3 py-2 font-medium text-right">
                {ts.colActions}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-neutral-500">
                  {ts.loading}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-neutral-500">
                  {rows.length === 0 ? ts.emptyAll : ts.emptyFiltered}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr
                  key={r.domain}
                  className="border-t border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50/50 dark:hover:bg-neutral-900/50"
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.domain)}
                      onChange={() => handleToggleRow(r.domain)}
                      aria-label={r.domain}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">{r.domain}</td>
                  <td className="px-3 py-2 text-neutral-600 dark:text-neutral-300">
                    {r.note || (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-500 text-xs">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteOne(r.domain)}
                      className="text-xs px-2 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      {ts.unbanOne}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-500">
        {ts.totalLine(rows.length, filtered.length, selected.size)}
      </p>
    </main>
  );
}
