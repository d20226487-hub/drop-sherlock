"use client";
import { useEffect, useState } from "react";
import { api, SpendPricing } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Settings → API → Other API prices (added 2026-11-09). Prices for the
// non-AI paid APIs, read by the Dashboard's Spend section: the Ahrefs plan
// (units included per month, then $ per 1M above that), WhoisFreaks $ per
// credit (Whois History + live availability lookups) and Domainr $ per
// lookup. Unlike AI prices these apply to all recorded usage at the
// current values.

type Field = keyof SpendPricing;

const FIELDS: { key: Field; step: string }[] = [
  { key: "ahrefs_included_units", step: "100000" },
  { key: "ahrefs_usd_per_million", step: "1" },
  { key: "whoisfreaks_usd_per_credit", step: "0.0001" },
  { key: "domainr_usd_per_request", step: "0.0001" },
];

export function ApiPricesEditor() {
  const { t } = useT();
  const ts = t.pages.settings.apiPrices;
  const labels: Record<Field, string> = {
    ahrefs_included_units: ts.ahrefsIncluded,
    ahrefs_usd_per_million: ts.ahrefsRate,
    whoisfreaks_usd_per_credit: ts.whoisfreaksRate,
    domainr_usd_per_request: ts.domainrRate,
  };
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function toDraft(p: SpendPricing): Record<Field, string> {
    return Object.fromEntries(FIELDS.map((f) => [f.key, String(p[f.key])])) as Record<
      Field,
      string
    >;
  }

  useEffect(() => {
    api
      .getSpendPricing()
      .then((p) => setDraft(toDraft(p)))
      .catch((e) => setMessage({ ok: false, text: (e as Error).message }));
  }, []);

  async function save() {
    if (!draft) return;
    const body: Partial<SpendPricing> = {};
    for (const f of FIELDS) {
      const v = Number(draft[f.key]);
      if (draft[f.key].trim() === "" || !Number.isFinite(v) || v < 0) {
        setMessage({ ok: false, text: ts.errInvalid });
        return;
      }
      body[f.key] = f.key === "ahrefs_included_units" ? Math.round(v) : v;
    }
    setBusy(true);
    setMessage(null);
    try {
      setDraft(toDraft(await api.putSpendPricing(body)));
      setMessage({ ok: true, text: ts.saved });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{ts.help}</p>
      {draft && (
        <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
          {FIELDS.map((f) => (
            <label key={f.key} className="text-sm space-y-1">
              <span className="block">{labels[f.key]}</span>
              <input
                type="number"
                min={0}
                step={f.step}
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="w-full px-2 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 tabular-nums"
              />
              {f.key === "whoisfreaks_usd_per_credit" && (
                <span className="block text-xs text-neutral-500">{ts.whoisfreaksHint}</span>
              )}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-neutral-500">{ts.zeroHint}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !draft}
          className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {ts.save}
        </button>
        {message && (
          <span
            className={
              "text-sm " +
              (message.ok
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400")
            }
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
