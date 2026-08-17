"use client";

// Residential-proxy pool for the Wayback pillar (added 2026-08-11).
//
// Mirrors WebshareProxiesEditor's Replace/Clear gesture for the write-only URL,
// but drives a SEPARATE source: archive.org tarpits datacenter ranges, so this
// list must point at a residential/ISP plan. See backend wayback_proxies.py.
//
// Layout intent: the master switch first (it's the rollback the operator
// reaches for when the pool underperforms), then the URL, then the per-phase
// routing. Phase checkboxes are disabled while the master switch is off so it
// reads as "off means everything goes direct" rather than a half-applied state.

import { useCallback, useEffect, useState } from "react";
import { api, WaybackProxiesStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function WaybackProxiesEditor() {
  const { t } = useT();
  const w = t.pages.settings.waybackProxies;
  const [st, setSt] = useState<WaybackProxiesStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [day, setDay] = useState("25");

  const reload = useCallback(async () => {
    try {
      const r = await api.getWaybackProxiesStatus();
      setSt(r);
      setDay(String(r.refresh_day_of_month));
      setEditingUrl(!r.configured);
    } catch (e) {
      setErr((e as Error).message || "load failed");
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  async function save(body: {
    enabled?: boolean;
    proxy_list_url?: string | null;
    use_v1?: boolean;
    use_v2?: boolean;
    use_retry?: boolean;
    refresh_day_of_month?: number;
  }) {
    setBusy(true);
    setErr(null);
    try {
      let r = await api.setWaybackProxiesConfig(body);
      // A freshly-saved URL populates the pool via a background task; force one
      // synchronous refresh so the count shows now instead of on the next poll.
      if (body.proxy_list_url) r = await api.refreshWaybackProxies();
      setSt(r);
      setDay(String(r.refresh_day_of_month));
      if (body.proxy_list_url !== undefined) {
        setUrlDraft("");
        setEditingUrl(!r.configured);
      }
    } catch (e) {
      setErr((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshNow() {
    setRefreshing(true);
    setErr(null);
    try {
      setSt(await api.refreshWaybackProxies());
    } catch (e) {
      setErr((e as Error).message || "refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  if (!st) {
    return (
      <div className="text-sm text-neutral-500 dark:text-neutral-400">
        {err ?? "Loading…"}
      </div>
    );
  }

  const phaseRows: {
    key: "use_v1" | "use_v2" | "use_retry";
    label: string;
    on: boolean;
  }[] = [
    { key: "use_v1", label: w.useV1, on: st.use_v1 },
    { key: "use_v2", label: w.useV2, on: st.use_v2 },
    { key: "use_retry", label: w.useRetry, on: st.use_retry },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-3xl">
        {w.hint}
      </p>

      {err && (
        <div className="rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300 text-sm">
          {err}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={st.enabled}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>{w.enableLabel}</span>
      </label>

      {editingUrl ? (
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder={w.urlPlaceholder}
            className="flex-1 max-w-xl px-2 py-1 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono"
          />
          <button
            type="button"
            onClick={() =>
              save({
                proxy_list_url: urlDraft.trim(),
                refresh_day_of_month: Number(day),
              })
            }
            disabled={busy || urlDraft.trim().length === 0}
            className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? w.saving : w.save}
          </button>
          {st.configured && (
            <button
              type="button"
              onClick={() => {
                setEditingUrl(false);
                setUrlDraft("");
              }}
              className="text-xs px-2 py-1 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {w.cancel}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-neutral-500">••••••••</span>
          <button
            type="button"
            onClick={() => {
              setUrlDraft("");
              setEditingUrl(true);
            }}
            className="text-xs px-2 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {w.replace}
          </button>
          <button
            type="button"
            onClick={() => save({ proxy_list_url: "" })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
          >
            {w.clear}
          </button>
        </div>
      )}
      {editingUrl && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-2">
          {w.urlHint}
        </p>
      )}

      <div className="space-y-1">
        <div className="text-sm font-medium">{w.phasesHeading}</div>
        {phaseRows.map((p) => (
          <label
            key={p.key}
            className={`flex items-center gap-2 text-sm ${
              st.enabled ? "" : "opacity-50"
            }`}
          >
            <input
              type="checkbox"
              checked={p.on}
              disabled={busy || !st.enabled}
              onChange={(e) => save({ [p.key]: e.target.checked })}
            />
            <span>{p.label}</span>
          </label>
        ))}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {w.phasesHint}
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span>{w.dayLabel}</span>
        <input
          type="number"
          min={1}
          max={28}
          value={day}
          disabled={busy}
          onChange={(e) => setDay(e.target.value)}
          onBlur={() => {
            const n = Number(day);
            if (n >= 1 && n <= 28 && n !== st.refresh_day_of_month)
              save({ refresh_day_of_month: n });
          }}
          className="w-20 px-2 py-0.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {w.dayHint}
        </span>
      </div>

      <div className="text-xs text-neutral-600 dark:text-neutral-400 space-y-0.5">
        <div>{st.configured ? w.configured : w.notConfigured}</div>
        {st.configured && (
          <>
            <div>
              {w.countLabel}:{" "}
              <span className="tabular-nums font-medium text-neutral-800 dark:text-neutral-200">
                {st.count}
              </span>
              {" · "}
              {w.availableLabel}:{" "}
              <span className="tabular-nums">{st.available}</span>
              {" · "}
              {w.coolingLabel}:{" "}
              <span className="tabular-nums">{st.cooling_down}</span>
            </div>
            <div>
              {w.lastFetchLabel}:{" "}
              {st.last_fetch_at
                ? new Date(st.last_fetch_at).toLocaleString()
                : w.never}
            </div>
            {st.last_error && (
              <div className="text-rose-600 dark:text-rose-400">
                {w.lastErrorLabel}: {st.last_error}
              </div>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        onClick={refreshNow}
        disabled={refreshing || !st.configured}
        className="text-xs px-3 py-1 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
      >
        {refreshing ? w.refreshing : w.refreshNow}
      </button>
    </div>
  );
}
