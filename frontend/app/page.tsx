"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api, DashboardStatus } from "@/lib/api";
import { IntegrationCard } from "@/components/integration-card";

function formatChecked(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function DashboardPage() {
  const { t } = useT();
  const ts = t.pages.dashboard;
  const [data, setData] = useState<DashboardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveBusy, setLiveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<string | null>(null);

  // Default load + "Refresh" button — passive (config-only). Zero
  // upstream HTTP requests. The visible "Working" pill on a provider
  // means "credentials stored", not "currently live".
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.getDashboardStatus();
      setData(next);
    } catch (e) {
      const err = e as Error;
      setError(err.message || "request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // "Run live checks" — explicit opt-in. Hits AI/Ahrefs/Wayback's
  // FREE upstream test endpoints; WhoisFreaks stays config-only
  // server-side (its requests cost money — use Settings → Whois
  // History → Test for a single explicit live probe there).
  const runLiveChecks = useCallback(async () => {
    setLiveBusy(true);
    setError(null);
    try {
      const next = await api.getDashboardStatus({ live: true });
      setData(next);
      setLastLiveAt(next.checked_at);
    } catch (e) {
      const err = e as Error;
      setError(err.message || "request failed");
    } finally {
      setLiveBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const noneConfigured =
    data && data.integrations.every((it) => it.state === "unconfigured");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{ts.title}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {ts.intro}
          </p>
          {data && (
            <div className="text-xs text-neutral-500 dark:text-neutral-500 mt-1 space-y-0.5">
              <p>
                {/* Config-mode loads finish in < 50 ms — surfacing the
                    timestamp here lets the operator confirm "did the
                    page actually re-fetch?" after a Refresh click. */}
                {data.mode === "live"
                  ? ts.liveCheckedAt(formatChecked(data.checked_at))
                  : ts.checkedAt(formatChecked(data.checked_at))}
              </p>
              {lastLiveAt && data.mode !== "live" && (
                <p className="text-neutral-400 dark:text-neutral-600">
                  {ts.lastLiveAt(formatChecked(lastLiveAt))}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={refresh}
            disabled={loading || liveBusy}
            title={ts.refreshHint}
            className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center gap-2"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {ts.refresh}
          </button>
          <button
            onClick={runLiveChecks}
            disabled={loading || liveBusy}
            title={ts.liveChecksHint}
            className="text-sm px-3 py-1.5 rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50 inline-flex items-center gap-2"
          >
            <Zap
              className={`w-3.5 h-3.5 ${liveBusy ? "animate-pulse" : ""}`}
            />
            {liveBusy ? ts.liveChecksRunning : ts.liveChecks}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-sm text-neutral-500">{t.common.loading}</div>
      )}

      {data && (
        <>
          {noneConfigured && (
            <div className="rounded-md border border-dashed dark:border-neutral-700 p-6 text-sm text-neutral-600 dark:text-neutral-400 space-y-3">
              <p>{ts.noKeyYet}</p>
              <Link
                href="/settings"
                className="inline-block text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
              >
                {ts.openSettings}
              </Link>
            </div>
          )}
          {/* Mode banner — small but visible so the operator never
              wonders "did I just look at a stale page?" */}
          <div
            className={
              "text-xs px-3 py-1.5 rounded-md border " +
              (data.mode === "live"
                ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300"
                : "border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/40 text-neutral-700 dark:text-neutral-300")
            }
          >
            {data.mode === "live"
              ? ts.modeBannerLive
              : ts.modeBannerConfig}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {data.integrations.map((it) => (
              <IntegrationCard key={it.provider} status={it} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
