"use client";
import { useCallback, useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { api, AhrefsUnits } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Highlight the box red when fewer than this many Ahrefs units remain.
const LOW_UNITS_THRESHOLD = 1_000_000;

function fmtInt(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// Always-visible Ahrefs API unit balance for the Dashboard (added
// 2026-07-27). Fetches the FREE, server-cached (~60 min) /dashboard/ahrefs-
// units on mount; the refresh button re-probes now (force=true, bypasses the
// cache). Goes red when the remaining balance drops below the threshold.
export function AhrefsUnitsCard() {
  const { t } = useT();
  const ts = t.pages.dashboard;
  const [u, setU] = useState<AhrefsUnits | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const r = await api.getAhrefsUnits(force ? { force: true } : undefined);
      setU(r);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the dashboard clean when Ahrefs isn't configured or the probe
  // fails — the Ahrefs integration card below already surfaces those.
  if (failed || (u && u.state !== "ok")) return null;

  if (!u) {
    return (
      <div className="rounded-lg border dark:border-neutral-800 px-4 py-3 text-sm text-neutral-500 dark:text-neutral-400">
        {ts.ahrefsUnitsLoading}
      </div>
    );
  }

  const remaining = u.units_remaining ?? null;
  const low = typeof remaining === "number" && remaining < LOW_UNITS_THRESHOLD;

  return (
    <div
      className={
        "rounded-lg border px-4 py-3 " +
        (low
          ? "border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950/40"
          : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40")
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge
            className={
              "w-4 h-4 " +
              (low
                ? "text-red-600 dark:text-red-400"
                : "text-neutral-500 dark:text-neutral-400")
            }
          />
          <h3
            className={
              "text-sm font-semibold " +
              (low ? "text-red-800 dark:text-red-300" : "")
            }
          >
            {ts.ahrefsUnitsTitle}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {low && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-600 text-white">
              {ts.ahrefsUnitsLow}
            </span>
          )}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={busy}
            title={ts.ahrefsUnitsRefresh}
            aria-label={ts.ahrefsUnitsRefresh}
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-50"
          >
            <RefreshCw className={"w-3.5 h-3.5 " + (busy ? "animate-spin" : "")} />
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={
            "text-3xl font-bold tabular-nums " +
            (low
              ? "text-red-700 dark:text-red-400"
              : "text-neutral-900 dark:text-neutral-100")
          }
        >
          {fmtInt(remaining)}
        </span>
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.ahrefsUnitsRemainingOf(fmtInt(u.units_limit))}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
        <span>{ts.ahrefsUnitsResets(fmtDate(u.usage_reset_date))}</span>
        {u.subscription && (
          <span className="text-neutral-500 dark:text-neutral-500">
            · {u.subscription}
          </span>
        )}
      </div>
    </div>
  );
}
