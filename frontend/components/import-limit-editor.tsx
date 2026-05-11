"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";

// Number-input editor for the user-configurable CSV import row cap.
// Lives on Settings → Others. Saves on click; the wizard reads the live
// value on open, so changes take effect on the next import without a
// reload.

export function ImportLimitEditor() {
  const { t } = useT();
  const ts = t.pages.settings.importLimit;

  const [bounds, setBounds] = useState<{ min: number; max: number } | null>(
    null,
  );
  const [draft, setDraft] = useState<string>("");
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBacklogImportLimit()
      .then((d) => {
        if (cancelled) return;
        setBounds({ min: d.min, max: d.max });
        setSaved(d.rows);
        setDraft(String(d.rows));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || ts.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [ts.loadFailed]);

  async function save() {
    if (!bounds) return;
    const trimmed = draft.trim();
    const parsed = parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      setError(ts.notANumber);
      return;
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      setError(ts.outOfRange(bounds.min, bounds.max));
      return;
    }
    if (parsed === saved) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setBacklogImportLimit(parsed);
      setSaved(result.rows);
      setDraft(String(result.rows));
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message || ts.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const dirty = saved !== null && draft.trim() !== String(saved);

  return (
    <div className="space-y-3 max-w-xl">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>
      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-neutral-700 dark:text-neutral-300">
          {ts.currentLabel}
        </label>
        <input
          type="number"
          inputMode="numeric"
          min={bounds?.min}
          max={bounds?.max}
          step={1000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saved === null || busy}
          className="w-32 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm text-right outline-none disabled:opacity-50"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.unit}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? ts.saving : ts.save}
        </button>
        {savedAt && !dirty && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {ts.savedAt(savedAt.toLocaleTimeString())}
          </span>
        )}
        {bounds && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-auto">
            {ts.boundsHint(bounds.min, bounds.max)}
          </span>
        )}
      </div>
    </div>
  );
}
