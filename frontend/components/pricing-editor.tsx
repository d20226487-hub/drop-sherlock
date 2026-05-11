"use client";
import { useEffect, useState } from "react";
import { api, ModelPriceRow } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Per-(provider, model) AI token-cost editor. Shows one row per pair in
// the model registry — auto-seeded on first GET so the table is never
// empty, even before the user has opened it. Edits are committed per
// row (Save button per row); the user can also delete a pair to remove
// it from the table.
//
// Cost values are LOCKED IN at the time of each AI call: editing a row
// here only affects FUTURE calls. Past CriterionResult.ai_cost_usd
// values are not retroactively recomputed (see backend tasks.py:
// _compute_ai_cost_usd is called at write time only).

export function PricingEditor() {
  const { t } = useT();
  const ts = t.pages.settings.pricing;

  const [rows, setRows] = useState<ModelPriceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Per-row local draft state so users can edit without committing every
  // keystroke. Keyed by `${provider}|${model}` — the same composite the
  // backend uses for the row's primary key.
  const [drafts, setDrafts] = useState<
    Record<string, { in: string; out: string }>
  >({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  function key(p: string, m: string): string {
    return `${p}|${m}`;
  }

  async function reload() {
    try {
      const r = await api.listPricing();
      setRows(r.rows);
      // Seed drafts from canonical rows so the inputs reflect saved state.
      const next: Record<string, { in: string; out: string }> = {};
      for (const row of r.rows) {
        next[key(row.provider, row.model)] = {
          in: String(row.input_per_million ?? 0),
          out: String(row.output_per_million ?? 0),
        };
      }
      setDrafts(next);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function save(row: ModelPriceRow) {
    const k = key(row.provider, row.model);
    const d = drafts[k];
    if (!d) return;
    const inN = parseFloat(d.in);
    const outN = parseFloat(d.out);
    if (!Number.isFinite(inN) || inN < 0 || !Number.isFinite(outN) || outN < 0) {
      setRowError((s) => ({ ...s, [k]: ts.errInvalid }));
      return;
    }
    setRowError((s) => ({ ...s, [k]: "" }));
    setSavingKey(k);
    try {
      await api.upsertPricing(row.provider, row.model, {
        input_per_million: inN,
        output_per_million: outN,
      });
      await reload();
    } catch (e) {
      setRowError((s) => ({ ...s, [k]: (e as Error).message }));
    } finally {
      setSavingKey(null);
    }
  }

  async function remove(row: ModelPriceRow) {
    const k = key(row.provider, row.model);
    if (!window.confirm(ts.deleteConfirm(row.provider, row.model))) return;
    setSavingKey(k);
    try {
      await api.deletePricing(row.provider, row.model);
      await reload();
    } catch (e) {
      setRowError((s) => ({ ...s, [k]: (e as Error).message }));
    } finally {
      setSavingKey(null);
    }
  }

  if (loadError) {
    return (
      <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200">
        {loadError}
      </p>
    );
  }
  if (rows === null) {
    return <p className="text-sm text-neutral-500">{t.common.loading}</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {ts.empty}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.help}
      </p>
      <div className="overflow-x-auto rounded-md border dark:border-neutral-700">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">{ts.cols.provider}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.model}</th>
              <th className="px-3 py-2 font-medium text-right">
                {ts.cols.inputRate}
              </th>
              <th className="px-3 py-2 font-medium text-right">
                {ts.cols.outputRate}
              </th>
              <th className="px-3 py-2 w-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const k = key(row.provider, row.model);
              const d = drafts[k] ?? {
                in: String(row.input_per_million),
                out: String(row.output_per_million),
              };
              const dirty =
                d.in !== String(row.input_per_million) ||
                d.out !== String(row.output_per_million);
              const err = rowError[k];
              const isSaving = savingKey === k;
              return (
                <tr
                  key={k}
                  className="border-t dark:border-neutral-800"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.provider}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs break-all max-w-[18rem]">
                    {row.model}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      step="0.0001"
                      min={0}
                      value={d.in}
                      onChange={(e) =>
                        setDrafts((s) => ({
                          ...s,
                          [k]: { ...d, in: e.target.value },
                        }))
                      }
                      disabled={isSaving}
                      className="w-28 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 text-right"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      step="0.0001"
                      min={0}
                      value={d.out}
                      onChange={(e) =>
                        setDrafts((s) => ({
                          ...s,
                          [k]: { ...d, out: e.target.value },
                        }))
                      }
                      disabled={isSaving}
                      className="w-28 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 text-right"
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => save(row)}
                        disabled={!dirty || isSaving}
                        className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {isSaving ? t.common.loading : ts.save}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(row)}
                        disabled={isSaving}
                        className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
                        title={ts.delete}
                      >
                        {ts.delete}
                      </button>
                    </div>
                    {err && (
                      <div className="text-[11px] text-red-600 dark:text-red-300 mt-1">
                        {err}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
