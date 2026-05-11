"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";

// Auto-prune setting for dismissed errors. Backend stores as int days
// (7|15|30) or null for "never". The dropdown's value uses the literal
// strings "7"/"15"/"30"/"never" so React's controlled-select stays simple.

type Choice = "7" | "15" | "30" | "never";

function daysToChoice(days: number | null): Choice {
  if (days === null) return "never";
  if (days === 7 || days === 15 || days === 30) return String(days) as Choice;
  return "30";
}

function choiceToDays(c: Choice): number | null {
  return c === "never" ? null : parseInt(c, 10);
}

export function RetentionEditor() {
  const { t } = useT();
  const ts = t.pages.settings.retention;

  const [options, setOptions] = useState<number[]>([7, 15, 30]);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [savedChoice, setSavedChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getErrorRetention()
      .then((d) => {
        if (cancelled) return;
        if (Array.isArray(d.options) && d.options.length > 0) {
          setOptions(d.options);
        }
        const c = daysToChoice(d.days);
        setChoice(c);
        setSavedChoice(c);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || ts.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [ts.loadFailed]);

  async function save() {
    if (!choice || choice === savedChoice) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setErrorRetention(choiceToDays(choice));
      const c = daysToChoice(result.days);
      setSavedChoice(c);
      setChoice(c);
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message || ts.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const dirty = choice !== null && choice !== savedChoice;

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
        <select
          value={choice ?? ""}
          onChange={(e) => setChoice(e.target.value as Choice)}
          disabled={choice === null || busy}
          className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm outline-none disabled:opacity-50"
        >
          {options.map((n) => (
            <option key={n} value={String(n)}>
              {ts.optionDays(n)}
            </option>
          ))}
          <option value="never">{ts.optionNever}</option>
        </select>
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
      </div>
    </div>
  );
}
