"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ShareRecord, ShareSettings } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Management UI for view-only share links. Surfaces every share token
// the operator has minted (active + revoked + expired) with filters,
// search, bulk revoke, per-row revoke / extend-expiry actions.
//
// 2026-05-24 wave: added per-row Delete (hard-delete) + Activate
// (un-revoke), a bulk "Delete revoked" button, and a collapsible
// Settings panel for the per-shop default share duration. The new UX
// keeps the original Revoke flow untouched — Delete + Activate only
// surface on revoked rows.

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

  // Settings panel state (collapsible, closed by default — keeps the
  // primary management workflow front-and-centre).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<number>(0);
  const [settingsBusy, setSettingsBusy] = useState(false);

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

  // Load settings once on mount — the panel renders the value
  // regardless of whether the operator has opened it (collapsible header
  // shows the current default in the trigger).
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.getShareSettings();
        setSettings(s);
        setSettingsDraft(s.default_expires_in_days);
      } catch {
        // Non-fatal — page still works without the settings panel.
      }
    })();
  }, []);

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

  async function activateOne(token: string) {
    if (!window.confirm(ts.activateConfirm)) return;
    try {
      await api.activateShare(token);
      await load();
    } catch (e) {
      setBulkResult(
        ts.activateFailed + ": " + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async function hardDeleteOne(token: string) {
    if (!window.confirm(ts.hardDeleteConfirm)) return;
    try {
      await api.hardDeleteShare(token);
      // Drop from selection set since the row no longer exists.
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(token);
        return next;
      });
      await load();
    } catch (e) {
      setBulkResult(
        ts.hardDeleteFailed + ": " + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async function deleteAllRevoked() {
    // The endpoint with empty `tokens` wipes EVERY revoked row, not
    // just those on the current page. We display the on-page revoked
    // count in the prompt as a rough magnitude hint — exact wipe count
    // comes back in the response.
    const visibleRevoked = items.filter((x) => statusOf(x) === "revoked").length;
    if (!window.confirm(ts.deleteRevokedConfirm(visibleRevoked))) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const r = await api.deleteRevokedShares([]);
      setBulkResult(ts.deleteRevokedDone(r.deleted));
      setSelected(new Set());
      await load();
    } catch (e) {
      setBulkResult(
        ts.deleteRevokedFailed +
          ": " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function saveSettings() {
    setSettingsBusy(true);
    try {
      const updated = await api.updateShareSettings({
        default_expires_in_days: settingsDraft,
      });
      setSettings(updated);
      setSettingsDraft(updated.default_expires_in_days);
      setBulkResult(ts.settings.saved);
      setTimeout(() => setBulkResult(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function resetSettings() {
    if (!window.confirm(ts.settings.resetConfirm)) return;
    setSettingsBusy(true);
    try {
      const updated = await api.resetShareSettings();
      setSettings(updated);
      setSettingsDraft(updated.default_expires_in_days);
      setBulkResult(ts.settings.saved);
      setTimeout(() => setBulkResult(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingsBusy(false);
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

      {/* Default settings — collapsible. Closed by default so it
          doesn't compete with the management table on first view, but
          the trigger surfaces the current default so it's never
          invisible. */}
      <div className="rounded-md border dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-900/40">
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className="w-full px-3 py-2 flex items-center justify-between text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/40 rounded-md"
        >
          <span className="font-medium">
            {ts.settings.toggle}
            {settings && (
              <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400 font-normal">
                — {ts.settings.currentDefault(settings.default_expires_in_days)}
              </span>
            )}
          </span>
          <span className="text-neutral-400">{settingsOpen ? "▾" : "▸"}</span>
        </button>
        {settingsOpen && (
          <div className="px-4 py-3 border-t dark:border-neutral-800 space-y-3 text-sm">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              {ts.settings.intro}
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-1">
                <label className="text-xs text-neutral-500 dark:text-neutral-400 block">
                  {ts.settings.defaultExpiresLabel}
                </label>
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={settingsDraft}
                  onChange={(e) =>
                    setSettingsDraft(
                      Math.max(0, Math.min(3650, parseInt(e.target.value || "0", 10))),
                    )
                  }
                  className="w-28 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
                />
              </div>
              <button
                type="button"
                onClick={saveSettings}
                disabled={settingsBusy}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {settingsBusy ? ts.settings.saving : ts.settings.save}
              </button>
              <button
                type="button"
                onClick={resetSettings}
                disabled={settingsBusy}
                className="text-xs px-3 py-1.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {ts.settings.reset}
              </button>
            </div>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {ts.settings.defaultExpiresHint}
            </p>
          </div>
        )}
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

      {/* Bulk actions strip — selection-conditional revoke + always-on
          nuclear buttons on the right. "Delete revoked" sits alongside
          "Revoke all active" so the two destructive ops live together. */}
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
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={deleteAllRevoked}
            disabled={bulkBusy}
            className="text-xs px-3 py-1.5 rounded border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50"
            title={ts.deleteRevokedHint}
          >
            {ts.deleteRevoked}
          </button>
          <button
            type="button"
            onClick={revokeAllActive}
            disabled={bulkBusy}
            className="text-xs px-3 py-1.5 rounded border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50"
            title={ts.revokeAllHint}
          >
            {ts.revokeAll}
          </button>
        </div>
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
                    {st === "revoked" && (
                      <>
                        <button
                          type="button"
                          onClick={() => activateOne(s.token)}
                          className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline mr-2"
                        >
                          {ts.activate}
                        </button>
                        <button
                          type="button"
                          onClick={() => hardDeleteOne(s.token)}
                          className="text-xs text-rose-600 dark:text-rose-400 hover:underline"
                        >
                          {ts.hardDelete}
                        </button>
                      </>
                    )}
                    {st === "expired" && (
                      <button
                        type="button"
                        onClick={() => hardDeleteOne(s.token)}
                        className="text-xs text-rose-600 dark:text-rose-400 hover:underline"
                      >
                        {ts.hardDelete}
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
