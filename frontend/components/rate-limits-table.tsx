"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { api, RateLimits } from "@/lib/api";

const FIELDS: (keyof RateLimits)[] = ["rpm", "max_concurrent", "retry_max"];

export function RateLimitsTable({
  values,
  onChanged,
}: {
  values: Record<string, RateLimits>;
  onChanged: (provider: string, next: RateLimits) => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings;
  const [drafts, setDrafts] = useState<Record<string, Partial<RateLimits>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setField(provider: string, field: keyof RateLimits, value: string) {
    const n = parseInt(value, 10);
    setDrafts((d) => ({
      ...d,
      [provider]: {
        ...(d[provider] || {}),
        [field]: Number.isNaN(n) ? undefined : n,
      },
    }));
  }

  async function save(provider: string) {
    const draft = drafts[provider];
    if (!draft) return;
    const payload: Partial<RateLimits> = {};
    for (const f of FIELDS) {
      const v = draft[f];
      if (typeof v === "number" && v !== values[provider][f]) payload[f] = v;
    }
    if (Object.keys(payload).length === 0) return;
    setBusy(provider);
    setError(null);
    try {
      const next = await api.updateRateLimits(provider, payload);
      onChanged(provider, next);
      setDrafts((d) => {
        const { [provider]: _, ...rest } = d;
        void _;
        return rest;
      });
    } catch (e) {
      const err = e as Error;
      setError(err.message || "update failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.rateLimitsHelp}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border dark:border-neutral-800 rounded-md overflow-hidden">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Provider</th>
              {FIELDS.map((f) => (
                <th key={f} className="px-3 py-2 font-medium">
                  {ts.rateLimitFields[f]}
                </th>
              ))}
              <th className="px-3 py-2 w-1" />
            </tr>
          </thead>
          <tbody>
            {Object.keys(values).map((provider) => {
              const row = values[provider];
              const draft = drafts[provider] || {};
              const dirty = FIELDS.some(
                (f) =>
                  typeof draft[f] === "number" && draft[f] !== row[f],
              );
              return (
                <tr
                  key={provider}
                  className="border-t dark:border-neutral-800"
                >
                  <td className="px-3 py-2">
                    {ts.providerNames[
                      provider as keyof typeof ts.providerNames
                    ] || provider}
                  </td>
                  {FIELDS.map((f) => (
                    <td key={f} className="px-3 py-2">
                      <input
                        type="number"
                        min={f === "retry_max" ? 0 : 1}
                        value={
                          typeof draft[f] === "number"
                            ? (draft[f] as number)
                            : row[f]
                        }
                        onChange={(e) => setField(provider, f, e.target.value)}
                        className="w-24 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <button
                      onClick={() => save(provider)}
                      disabled={!dirty || busy === provider}
                      className="text-xs px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {busy === provider ? t.common.loading : t.common.save}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
