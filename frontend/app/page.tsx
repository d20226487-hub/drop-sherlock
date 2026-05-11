"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const noneConfigured =
    data &&
    data.integrations.every((it) => it.state === "unconfigured");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{ts.title}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {ts.intro}
          </p>
          {data && (
            <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
              {ts.checkedAt(formatChecked(data.checked_at))}
            </p>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center gap-2"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {ts.refresh}
        </button>
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
