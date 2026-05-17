"use client";
// Settings editor for the post-run Wayback auto-retry watcher (added
// 2026-05-17). Scoped to the wayback fetch + chained wayback_classify
// criteria — Ahrefs / Whois / Availability failures stay manual. See
// backend/app_settings.get_wayback_auto_retry_config for the field
// semantics and the safety caps.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type AutoRetryCfg = {
  enabled: boolean;
  max_attempts: number;
  initial_delay_sec: number;
  backoff_multiplier: number;
};

function format_delay_secs(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return `${m} min`;
  }
  const h = (seconds / 3600).toFixed(1);
  return `${h} h`;
}

// Project the schedule the user is configuring so they can see at a
// glance how aggressive the loop will be. Mirrors the watcher's
// `delay *= multiplier` step exactly.
function projected_schedule(cfg: AutoRetryCfg): string[] {
  if (!cfg.enabled || cfg.max_attempts <= 0) return [];
  let delay = cfg.initial_delay_sec;
  const out: string[] = [];
  for (let i = 0; i < cfg.max_attempts; i++) {
    out.push(format_delay_secs(Math.round(delay)));
    delay *= cfg.backoff_multiplier;
  }
  return out;
}

export function WaybackAutoRetryEditor() {
  const [cfg, setCfg] = useState<AutoRetryCfg | null>(null);
  const [defaults, setDefaults] = useState<AutoRetryCfg | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let canceled = false;
    api
      .getWaybackAutoRetry()
      .then((r) => {
        if (canceled) return;
        setCfg(r.config);
        setDefaults(r.defaults);
      })
      .catch((e: Error) => {
        if (!canceled) setError(e.message);
      });
    return () => {
      canceled = true;
    };
  }, []);

  async function save(patch: Partial<AutoRetryCfg>) {
    if (!cfg) return;
    const optimistic: AutoRetryCfg = { ...cfg, ...patch };
    setCfg(optimistic);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await api.updateWaybackAutoRetry(patch);
      setCfg(r.config);
      setSaved(true);
      // Auto-clear the "Saved" hint after a few seconds.
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
      // Roll back to whatever the server reports next time.
      try {
        const r = await api.getWaybackAutoRetry();
        setCfg(r.config);
      } catch {
        /* swallow */
      }
    } finally {
      setBusy(false);
    }
  }

  if (cfg === null) {
    return (
      <div className="text-sm text-neutral-500">Loading…</div>
    );
  }

  const schedule = projected_schedule(cfg);
  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        After a Quality run finishes, automatically re-fire the Wayback
        fetch (and chained classification) on a backoff schedule until
        either every failure resolves or the attempt budget is hit.
        Domains whose Wayback fetch succeeded with zero archive rows are
        skipped — retrying won&apos;t find archives that don&apos;t exist.
        Ahrefs / Whois / Availability failures are NOT auto-retried; use
        the &quot;Retry failed&quot; button on the run page for those.
      </p>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={cfg.enabled}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span className="font-medium">Enable auto-retry</span>
      </label>

      <div
        className={
          "grid grid-cols-1 sm:grid-cols-3 gap-4 " +
          (cfg.enabled ? "" : "opacity-50 pointer-events-none")
        }
      >
        <label className="text-sm space-y-1">
          <div className="font-medium">Max attempts</div>
          <input
            type="number"
            min={0}
            max={20}
            step={1}
            value={cfg.max_attempts}
            disabled={busy || !cfg.enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n))
                setCfg({ ...cfg, max_attempts: Math.max(0, Math.min(20, n)) });
            }}
            onBlur={() => save({ max_attempts: cfg.max_attempts })}
            className="w-full px-2 py-1 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900"
          />
          <div className="text-xs text-neutral-500">
            0 disables. Cap: 20.
          </div>
        </label>

        <label className="text-sm space-y-1">
          <div className="font-medium">Initial delay (sec)</div>
          <input
            type="number"
            min={0}
            max={3600}
            step={5}
            value={cfg.initial_delay_sec}
            disabled={busy || !cfg.enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n))
                setCfg({
                  ...cfg,
                  initial_delay_sec: Math.max(0, Math.min(3600, n)),
                });
            }}
            onBlur={() =>
              save({ initial_delay_sec: cfg.initial_delay_sec })
            }
            className="w-full px-2 py-1 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900"
          />
          <div className="text-xs text-neutral-500">
            Time to wait before the first retry pass.
          </div>
        </label>

        <label className="text-sm space-y-1">
          <div className="font-medium">Backoff ×</div>
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            value={cfg.backoff_multiplier}
            disabled={busy || !cfg.enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n))
                setCfg({
                  ...cfg,
                  backoff_multiplier: Math.max(1, Math.min(10, n)),
                });
            }}
            onBlur={() =>
              save({ backoff_multiplier: cfg.backoff_multiplier })
            }
            className="w-full px-2 py-1 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900"
          />
          <div className="text-xs text-neutral-500">
            Applied between passes (delay × this).
          </div>
        </label>
      </div>

      {cfg.enabled && schedule.length > 0 && (
        <div className="text-xs text-neutral-600 dark:text-neutral-400">
          Schedule: waits {schedule.join(" → ")} before each retry pass.
        </div>
      )}

      {(error || saved || defaults) && (
        <div className="flex items-center gap-3 text-xs">
          {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
          {saved && <span className="text-green-600 dark:text-green-400">Saved.</span>}
          {defaults && (
            <button
              type="button"
              onClick={() => save(defaults)}
              disabled={busy}
              className="ml-auto px-2 py-1 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              Reset to defaults
            </button>
          )}
        </div>
      )}
    </div>
  );
}
