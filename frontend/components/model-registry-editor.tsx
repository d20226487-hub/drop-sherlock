"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";

/** Per-provider known-models registry editor.
 *
 * UI shape:
 * - A list of saved models. Each has a ★ button to mark it default and an
 *   × button to remove it. The starred entry is the provider's `default_model`.
 * - A `+ Add model` row for typing a single model id.
 * - A bulk-paste textarea for dropping a list (one per line, or comma-
 *   separated). `+ Merge` button adds new entries (dedup, preserve order).
 *
 * Locked behaviors (decided 2026-05-06):
 * - Bulk paste MERGES (dedup), not replace.
 * - Deleting the current default falls back to the first remaining model
 *   automatically (server-side in `set_known_models`).
 * - Stars / deletes always do a full replace round-trip so the order the
 *   user sees matches what's persisted (PUT, not POST).
 */
export function ModelRegistryEditor({
  provider,
  models,
  defaultModel,
  onModelsChanged,
  onDefaultChanged,
}: {
  provider: string;
  models: string[];
  defaultModel: string;
  // Parent owns the canonical state — every backend round-trip echoes the
  // cleaned list back, so the parent can update its cache and re-render.
  onModelsChanged: (models: string[]) => void;
  // Setting a default still goes through the existing creds endpoint —
  // parent owns that too.
  onDefaultChanged: (model: string) => Promise<void> | void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.modelRegistry;

  const [single, setSingle] = useState("");
  const [bulk, setBulk] = useState("");
  const [busy, setBusy] = useState<
    "idle" | "addingSingle" | "merging" | "removing" | "starring"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  function parseList(input: string): string[] {
    // Accept newlines, commas, or both. Trim each line; drop blanks.
    return input
      .split(/[\n,]/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function addSingle() {
    const v = single.trim();
    if (!v) return;
    setBusy("addingSingle");
    setError(null);
    try {
      const r = await api.addKnownModels(provider, [v]);
      onModelsChanged(r.models);
      setSingle("");
    } catch (e) {
      setError((e as Error).message || "add failed");
    } finally {
      setBusy("idle");
    }
  }

  async function mergeBulk() {
    const list = parseList(bulk);
    if (list.length === 0) return;
    setBusy("merging");
    setError(null);
    try {
      const r = await api.addKnownModels(provider, list);
      onModelsChanged(r.models);
      setBulk("");
    } catch (e) {
      setError((e as Error).message || "merge failed");
    } finally {
      setBusy("idle");
    }
  }

  async function remove(model: string) {
    setBusy("removing");
    setError(null);
    try {
      const next = models.filter((m) => m !== model);
      const r = await api.replaceKnownModels(provider, next);
      onModelsChanged(r.models);
      // Backend already handled "deleted the default" by falling back to
      // first remaining; parent's defaultModel will refresh on the next
      // settings reload — but we proactively refetch via the reload chain.
    } catch (e) {
      setError((e as Error).message || "remove failed");
    } finally {
      setBusy("idle");
    }
  }

  async function star(model: string) {
    setBusy("starring");
    setError(null);
    try {
      await onDefaultChanged(model);
    } catch (e) {
      setError((e as Error).message || "set default failed");
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="space-y-2 rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
          {ts.heading}
        </h4>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.count(models.length)}
        </span>
      </div>

      {models.length > 0 ? (
        <ul className="space-y-1">
          {models.map((m) => {
            const isDefault = m === defaultModel;
            return (
              <li
                key={m}
                className="flex items-center gap-2 text-xs px-2 py-1 rounded-md bg-white dark:bg-neutral-900 border dark:border-neutral-800"
              >
                <button
                  type="button"
                  onClick={() => star(m)}
                  disabled={busy !== "idle" || isDefault}
                  title={isDefault ? ts.defaultTooltip : ts.makeDefault}
                  className={
                    "text-base leading-none disabled:cursor-not-allowed " +
                    (isDefault
                      ? "text-amber-500 dark:text-amber-400"
                      : "text-neutral-400 dark:text-neutral-600 hover:text-amber-500 dark:hover:text-amber-400")
                  }
                >
                  ★
                </button>
                <span className="flex-1 font-mono break-all text-neutral-800 dark:text-neutral-200">
                  {m}
                </span>
                {isDefault && (
                  <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    {ts.defaultBadge}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => remove(m)}
                  disabled={busy !== "idle"}
                  title={ts.remove}
                  className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      )}

      <div className="flex items-center gap-2 pt-2">
        <input
          type="text"
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addSingle();
            }
          }}
          placeholder={ts.singlePlaceholder}
          disabled={busy !== "idle"}
          className="flex-1 text-xs rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={addSingle}
          disabled={busy !== "idle" || !single.trim()}
          className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy === "addingSingle" ? ts.adding : ts.addSingle}
        </button>
      </div>

      <details className="pt-1">
        <summary className="text-xs text-blue-600 dark:text-blue-400 cursor-pointer select-none">
          {ts.bulkToggle}
        </summary>
        <div className="space-y-2 pt-2">
          <textarea
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            placeholder={ts.bulkPlaceholder}
            rows={4}
            disabled={busy !== "idle"}
            className="w-full text-xs font-mono rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.bulkHelp}
            </span>
            <button
              type="button"
              onClick={mergeBulk}
              disabled={busy !== "idle" || parseList(bulk).length === 0}
              className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy === "merging"
                ? ts.merging
                : ts.mergeCount(parseList(bulk).length)}
            </button>
          </div>
        </div>
      </details>

      {error && (
        <p className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
