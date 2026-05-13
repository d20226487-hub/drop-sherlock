"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, ClassifyContextConfig, ClassifyContextEnvelope } from "@/lib/api";

// Brain → "Wayback classify → Ahrefs judges". User controls:
// 1. Master toggle (enable/disable the whole context-injection feature).
// 2. Criterion scope — which Ahrefs judges receive the context block.
//    Defaults to backlinks/anchors/keywords; refdomains is opt-in (no
//    anchors/snippets to ground the AI's theme inference → hallucination
//    risk).
// 3. Field scope — which fields from the wayback_classify verdict get
//    projected into the prompt block. Defaults to all 9.
//
// Cache impact note rendered in the UI: changing criteria or fields
// invalidates the AI verdict cache for affected criteria (the runner
// folds the field-set sentinel into compute_prompt_hash, so different
// configs produce different cache keys).

export function ClassifyContextEditor() {
  const { t } = useT();
  const ts = t.pages.settings.classifyContext;

  const [env, setEnv] = useState<ClassifyContextEnvelope | null>(null);
  // Local draft state. Only flushed to backend on Save so toggle-thrash
  // doesn't cause N writes / N cache busts.
  const [draft, setDraft] = useState<ClassifyContextConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getClassifyContext()
      .then((e) => {
        if (cancelled) return;
        setEnv(e);
        setDraft({ ...e.config });
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!env || !draft) return false;
    if (draft.enabled !== env.config.enabled) return true;
    const a = [...draft.criteria].sort().join(",");
    const b = [...env.config.criteria].sort().join(",");
    if (a !== b) return true;
    const c = [...draft.fields].sort().join(",");
    const d = [...env.config.fields].sort().join(",");
    return c !== d;
  }, [env, draft]);

  function toggleCriterion(c: string) {
    setDraft((d) =>
      d
        ? {
            ...d,
            criteria: d.criteria.includes(c)
              ? d.criteria.filter((x) => x !== c)
              : [...d.criteria, c],
          }
        : d,
    );
  }

  function toggleField(f: string) {
    setDraft((d) =>
      d
        ? {
            ...d,
            fields: d.fields.includes(f)
              ? d.fields.filter((x) => x !== f)
              : [...d.fields, f],
          }
        : d,
    );
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateClassifyContext({
        enabled: draft.enabled,
        criteria: draft.criteria,
        fields: draft.fields,
      });
      setEnv(updated);
      setDraft({ ...updated.config });
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.resetClassifyContext();
      setEnv(updated);
      setDraft({ ...updated.config });
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!env || !draft) {
    return (
      <p className="text-sm text-neutral-500">…</p>
    );
  }

  const criterionLabels = ts.criterionNames;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-neutral-600 dark:text-neutral-400">{ts.intro}</p>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, enabled: e.target.checked } : d))
          }
        />
        <span className="font-medium">{ts.masterToggle}</span>
      </label>

      <fieldset
        className={
          "space-y-2 border-l-2 pl-3 " +
          (draft.enabled
            ? "border-neutral-300 dark:border-neutral-700"
            : "border-neutral-200 dark:border-neutral-800 opacity-50")
        }
        disabled={!draft.enabled}
      >
        <div>
          <div className="font-medium">{ts.criteriaHeading}</div>
          <p className="text-xs text-neutral-500">{ts.criteriaHelp}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {env.allowed_criteria.map((c) => (
            <label
              key={c}
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <input
                type="checkbox"
                checked={draft.criteria.includes(c)}
                onChange={() => toggleCriterion(c)}
              />
              <span>
                {criterionLabels[c as keyof typeof criterionLabels] ?? c}
              </span>
              <span className="font-mono text-neutral-400">{c}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset
        className={
          "space-y-2 border-l-2 pl-3 " +
          (draft.enabled
            ? "border-neutral-300 dark:border-neutral-700"
            : "border-neutral-200 dark:border-neutral-800 opacity-50")
        }
        disabled={!draft.enabled}
      >
        <div>
          <div className="font-medium">{ts.fieldsHeading}</div>
          <p className="text-xs text-neutral-500">{ts.fieldsHelp}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {env.allowed_fields.map((f) => (
            <label
              key={f}
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <input
                type="checkbox"
                checked={draft.fields.includes(f)}
                onChange={() => toggleField(f)}
              />
              <span className="font-mono">{f}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="text-xs rounded-md px-2 py-1 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200">
        {ts.cacheNote}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? ts.saving : ts.save}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {ts.resetDefaults}
        </button>
        {savedAt && !dirty && !busy && (
          <span className="text-xs text-neutral-500">
            {ts.savedAt(savedAt.toLocaleTimeString())}
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs rounded-md px-2 py-1 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
