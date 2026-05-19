"use client";
// Settings editor for the post-run Availability auto-retry watcher
// (added 2026-05-18). Sibling of the Wayback editor, with one extra
// control: `retry_providers` — a checkbox set that gates WHICH
// provider's terminal failure makes an RD eligible for auto-retry.
//
// Why the extra control: the cascade has 4 providers (DNS / RDAP /
// Domainr / WHOIS) and they don't have the same cost / failure
// semantics. RDAP is free + reliable; Domainr is metered/paid;
// WHOIS port-43 is free but rate-limited and often the slowest. The
// user opted for "default to RDAP only" so the feature is auto-on
// without surprise Domainr bills. Adding domainr / whois is opt-in.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type AutoRetryCfg = {
  enabled: boolean;
  max_attempts: number;
  initial_delay_sec: number;
  backoff_multiplier: number;
  retry_providers: string[];
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

// Per-provider warning copy. Shown under the checkbox when enabled
// so the user sees the cost implications inline.
const PROVIDER_NOTES: Record<string, string> = {
  dns: "Free + fast. Usually only errors on local resolver problems.",
  rdap: "Free. Default — RDAP rate-limit / timeout failures are the most common retry-worthy case.",
  domainr: "Metered / paid. Enabling auto-retry here can quietly spike your Domainr bill on a flaky run.",
  whois: "Free but rate-limited; WHOIS port-43 is often the slowest provider. Auto-retry can lengthen the loop noticeably.",
};

export function AvailabilityAutoRetryEditor() {
  const [cfg, setCfg] = useState<AutoRetryCfg | null>(null);
  const [defaults, setDefaults] = useState<AutoRetryCfg | null>(null);
  const [allowedProviders, setAllowedProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let canceled = false;
    api
      .getAvailabilityAutoRetry()
      .then((r) => {
        if (canceled) return;
        setCfg(r.config);
        setDefaults(r.defaults);
        setAllowedProviders(r.allowed_providers);
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
      const r = await api.updateAvailabilityAutoRetry(patch);
      setCfg(r.config);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
      try {
        const r = await api.getAvailabilityAutoRetry();
        setCfg(r.config);
      } catch {
        /* swallow */
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleProvider(provider: string, on: boolean) {
    if (!cfg) return;
    const cur = new Set(cfg.retry_providers);
    if (on) cur.add(provider);
    else cur.delete(provider);
    // Preserve allowed_providers order so the saved list stays
    // canonical regardless of click order.
    const next = allowedProviders.filter((p) => cur.has(p));
    save({ retry_providers: next });
  }

  if (cfg === null) {
    return (
      <div className="text-sm text-neutral-500">Loading…</div>
    );
  }

  const schedule = projected_schedule(cfg);
  const noProvidersWhitelisted =
    cfg.enabled && cfg.retry_providers.length === 0;

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        After an Availability run finishes, automatically re-fire the
        cascade on a backoff schedule until either every transient
        failure resolves or the attempt budget is hit. Domains whose
        verdict came back <code>unknown</code> (all providers
        responded inconclusive — usually a TLD with no cascade path)
        are skipped — retrying won&apos;t change that.
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
                setCfg({
                  ...cfg,
                  max_attempts: Math.max(0, Math.min(20, n)),
                });
            }}
            onBlur={() => save({ max_attempts: cfg.max_attempts })}
            className="w-full px-2 py-1 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-900"
          />
          <div className="text-xs text-neutral-500">
            0 disables. Cap: 20. Default: 2.
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

      <div
        className={
          "space-y-2 " +
          (cfg.enabled ? "" : "opacity-50 pointer-events-none")
        }
      >
        <div className="text-sm font-medium">Retry providers</div>
        <p className="text-xs text-neutral-500">
          Only domains whose failing cascade provider matches one of
          these will be auto-retried. Cascade-crashed rows
          (CR.status=failed) are always retried regardless.
        </p>
        <div className="space-y-1">
          {allowedProviders.map((p) => {
            const on = cfg.retry_providers.includes(p);
            return (
              <label
                key={p}
                className="flex items-start gap-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || !cfg.enabled}
                  onChange={(e) => toggleProvider(p, e.target.checked)}
                  className="mt-1"
                />
                <div>
                  <span className="font-medium">{p}</span>
                  <span className="text-xs text-neutral-500 ml-2">
                    {PROVIDER_NOTES[p] ?? ""}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
        {noProvidersWhitelisted && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No providers selected — only cascade-crashed (failed)
            rows will be auto-retried. <code>done</code>+
            <code>error</code> rows from any provider will be left
            alone.
          </p>
        )}
      </div>

      {cfg.enabled && schedule.length > 0 && (
        <div className="text-xs text-neutral-600 dark:text-neutral-400">
          Schedule: waits {schedule.join(" → ")} before each retry pass.
        </div>
      )}

      {(error || saved || defaults) && (
        <div className="flex items-center gap-3 text-xs">
          {error && (
            <span className="text-red-600 dark:text-red-400">{error}</span>
          )}
          {saved && (
            <span className="text-green-600 dark:text-green-400">
              Saved.
            </span>
          )}
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
