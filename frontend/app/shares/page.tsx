"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ShareRecord } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Management UI for view-only share links. Surfaces every share token
// the operator has minted (active + revoked + expired) with filters,
// search, bulk revoke, per-row revoke / extend-expiry actions.
//
// The page is read-mostly so we server-paginate (50/page default) +
// poll the backend for fresh `view_count` + `last_viewed_at` on a soft
// cadence. Bulk actions go through POST /shares/bulk-revoke.

type StatusFilter = "all" | "active" | "revoked" | "expired";

function statusOf(s: ShareRecord): "active" | "revoked" | "expired" {
  if (s.revoked_at) return "revoked";
  if (s.expires_at && new Date(s.expires_at) <= new Date()) return "expired";
  return "active";
}

export default function SharesPage() {
  const { t } = useT();
  const ts = t.pages.shares;

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ShareRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listShares({
        page,
        per_page: perPage,
        status: statusFilter,
        search: search.trim() || undefined,
      } as Parameters<typeof api.listShares>[0]);
      setItems(r.items);
      setTotal(r.total);
      // Drop selections that aren't visible on the current page so
      // a "select all" doesn't lie about how many will be revoked.
      const visible = new Set(r.items.map((x) => x.token));
      setSelected((prev) => new Set([...prev].filter((t) => visible.has(t))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const allVisibleSelected = useMemo(
    () => items.length > 0 && items.every((x) => selected.has(x.token)),
    [items, selected],
  );

  function toggleAllVisible() {
    if (allVisibleSelected) {
      const next = new Set(selected);
      items.forEach((x) => next.delete(x.token));
      setSelected(next);
    } else {
      const next = new Set(selected);
      items.forEach((x) => next.add(x.token));
      setSelected(next);
    }
  }
  function toggleOne(token: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  async function bulkRevoke() {
    if (selected.size === 0) return;
    if (!window.confirm(ts.bulkRevokeConfirm(selected.size))) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const r = await api.bulkRevokeShares([...selected]);
      setBulkResult(ts.bulkRevokeDone(r.revoked, r.requested));
      setSelected(new Set());
      await load();
    } catch (e) {
      setBulkResult(
        ts.bulkRevokeFailed + ": " + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function revokeAllActive() {
    if (!window.confirm(ts.revokeAllConfirm)) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const r = await api.revokeAllActiveShares();
      setBulkResult(ts.revokeAllDone(r.revoked));
      setSelected(new Set());
      await load();
    } catch (e) {
      setBulkResult(
        ts.bulkRevokeFailed + ": " + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function revokeOne(token: string) {
    if (!window.confirm(ts.revokeOneConfirm)) return;
    try {
      await api.revokeShare(token);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copyUrl(token: string) {
    const url = `${window.location.origin}/share/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setBulkResult(ts.copied);
      setTimeout(() => setBulkResult(null), 1500);
    } catch {
      setError("Clipboard not available — copy from the link below the row.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {ts.intro}
        </p>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div className="space-y-1">
          <label className="text-xs text-neutral-500 dark:text-neutral-400 block">
            {ts.statusLabel}
          </label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value as StatusFilter);
            }}
            className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
          >
            <option value="all">{ts.statusOptions.all}</option>
            <option value="active">{ts.statusOptions.active}</option>
            <option value="revoked">{ts.statusOptions.revoked}</option>
            <option value="expired">{ts.statusOptions.expired}</option>
          </select>
        </div>
        <div className="space-y-1 flex-1 min-w-[200px]">
          <label className="text-xs text-neutral-500 dark:text-neutral-400 block">
            {ts.searchLabel}
          </label>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder={ts.searchPlaceholder}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-neutral-500 dark:text-neutral-400 block">
            {ts.perPageLabel}
          </label>
          <select
            value={perPage}
            onChange={(e) => {
              setPage(1);
              setPerPage(parseInt(e.target.value, 10));
            }}
            className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
          >
            {[20, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? t.common.loading : ts.refresh}
        </button>
      </div>

      {/* Bulk actions strip — only shown when something is selected, OR
          when we want to expose the nuclear "revoke all active". */}
      <div className="flex items-center gap-2 flex-wrap">
        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 px-3 py-1.5 text-xs">
            <span className="text-amber-800 dark:text-amber-300">
              {ts.selectedCount(selected.size)}
            </span>
            <button
              type="button"
              onClick={bulkRevoke}
              disabled={bulkBusy}
              className="px-2 py-0.5 rounded border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50"
            >
              {bulkBusy ? ts.revokingPlural : ts.bulkRevoke}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-neutral-500 dark:text-neutral-400 hover:underline"
            >
              {ts.clearSelection}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={revokeAllActive}
          disabled={bulkBusy}
          className="ml-auto text-xs px-3 py-1.5 rounded border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50"
          title={ts.revokeAllHint}
        >
          {ts.revokeAll}
        </button>
      </div>

      {bulkResult && (
        <div className="text-xs px-3 py-1.5 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300">
          {bulkResult}
        </div>
      )}
      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 dark:bg-neutral-900/60 text-left text-neutral-500 dark:text-neutral-400">
            <tr>
              <th className="px-3 py-2 w-6">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label={ts.selectAllAria}
                />
              </th>
              <th className="px-3 py-2 font-medium">{ts.cols.domain}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.status}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.note}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.job}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.created}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.expires}</th>
              <th className="px-3 py-2 font-medium text-right">
                {ts.cols.views}
              </th>
              <th className="px-3 py-2 font-medium">{ts.cols.actions}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-6 text-center text-neutral-500 dark:text-neutral-400"
                >
                  {ts.empty}
                </td>
              </tr>
            )}
            {items.map((s) => {
              const st = statusOf(s);
              const isChecked = selected.has(s.token);
              return (
                <tr
                  key={s.token}
                  className={
                    "border-t dark:border-neutral-800 " +
                    (st !== "active"
                      ? "bg-neutral-50/50 dark:bg-neutral-900/30 opacity-80"
                      : "")
                  }
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleOne(s.token)}
                      aria-label={ts.selectAria(s.domain)}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono break-all">{s.domain}</td>
                  <td className="px-3 py-2">
                    <StatusChip status={st} />
                  </td>
                  <td className="px-3 py-2 max-w-[200px] truncate" title={s.note}>
                    {s.note || (
                      <span className="text-neutral-400 italic">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {s.job_id != null ? (
                      <Link
                        href={`/jobs/${s.job_id}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {s.job_name || `#${s.job_id}`}
                      </Link>
                    ) : (
                      <span className="text-neutral-400 italic">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {new Date(s.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">
                    {s.expires_at
                      ? new Date(s.expires_at).toLocaleDateString()
                      : ts.never}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.view_count}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => copyUrl(s.token)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline mr-2"
                    >
                      {ts.copy}
                    </button>
                    <a
                      href={`/share/${s.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline mr-2"
                    >
                      {ts.open}
                    </a>
                    {st === "active" && (
                      <button
                        type="button"
                        onClick={() => revokeOne(s.token)}
                        className="text-xs text-rose-600 dark:text-rose-400 hover:underline"
                      >
                        {ts.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
        <span>
          {total > 0
            ? ts.pageInfo((page - 1) * perPage + 1, Math.min(page * perPage, total), total)
            : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-2 py-1 rounded border dark:border-neutral-700 disabled:opacity-40"
          >
            {ts.prev}
          </button>
          <span>
            {page} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="px-2 py-1 rounded border dark:border-neutral-700 disabled:opacity-40"
          >
            {ts.next}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: "active" | "revoked" | "expired" }) {
  const { t } = useT();
  const ts = t.pages.shares;
  const cls =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
      : status === "revoked"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300";
  const label =
    status === "active"
      ? ts.statusOptions.active
      : status === "revoked"
        ? ts.statusOptions.revoked
        : ts.statusOptions.expired;
  return (
    <span className={`px-1.5 py-0.5 rounded text-[11px] ${cls}`}>{label}</span>
  );
}
