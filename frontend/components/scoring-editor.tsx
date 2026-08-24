"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, ScoringConfig } from "@/lib/api";
import { setScoringConfig } from "@/lib/score";

// User-tunable final-score knobs. Loads {config, defaults} on mount; the
// "Reset to defaults" button shows the original locked values from project
// memory. On save, also seeds the lib/score.ts module cache so any other
// page already mounted sees the new thresholds without a refresh.
//
// The four assessment scores (high_quality=85 / mixed=50 / low_quality=15)
// are deliberately NOT exposed — changing them changes the meaning of the
// AI labels themselves and would invalidate every prior verdict's mapping.

export function ScoringEditor() {
  const { t } = useT();
  const ts = t.pages.settings.scoring;

  const [config, setConfig] = useState<ScoringConfig | null>(null);
  const [defaults, setDefaults] = useState<ScoringConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getScoringConfig()
      .then((env) => {
        if (cancelled) return;
        setConfig(env.config);
        setDefaults(env.defaults);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const weightsTotal = useMemo(() => {
    if (!config) return 0;
    const w = config.weights;
    return (
      w.backlinks +
      w.refdomains +
      w.anchors +
      w.keywords +
      (w.wayback ?? 0) +
      (w.stop_words ?? 0)
    );
  }, [config]);

  const isAtDefault = useMemo(() => {
    if (!config || !defaults) return false;
    return (
      config.weights.backlinks === defaults.weights.backlinks &&
      config.weights.refdomains === defaults.weights.refdomains &&
      config.weights.anchors === defaults.weights.anchors &&
      config.weights.keywords === defaults.weights.keywords &&
      (config.weights.wayback ?? 0) === (defaults.weights.wayback ?? 0) &&
      (config.weights.stop_words ?? 0) ===
        (defaults.weights.stop_words ?? 0) &&
      config.good_threshold === defaults.good_threshold &&
      config.mixed_threshold === defaults.mixed_threshold &&
      config.low_confidence_threshold === defaults.low_confidence_threshold
    );
  }, [config, defaults]);

  function setWeight(key: keyof ScoringConfig["weights"], v: number) {
    setConfig((c) =>
      c ? { ...c, weights: { ...c.weights, [key]: v } } : c,
    );
  }

  function setField(key: keyof ScoringConfig, v: number) {
    setConfig((c) => (c ? { ...c, [key]: v } : c));
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const env = await api.updateScoringConfig(config);
      setConfig(env.config);
      setDefaults(env.defaults);
      setScoringConfig(env.config);
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
      const env = await api.resetScoringConfig();
      setConfig(env.config);
      setDefaults(env.defaults);
      setScoringConfig(env.config);
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !config) {
    return (
      <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (!config) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }

  const inputCls =
    "w-20 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none";

  return (
    <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-5 text-sm">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.intro}
      </p>

      {/* Weights */}
      <div className="space-y-2">
        <div className="font-medium">{ts.weightsHeading}</div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.weightsHelp}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {(
            [
              ["backlinks", t.pages.analyze.criteria.backlinks],
              ["refdomains", t.pages.analyze.criteria.refdomains],
              ["anchors", t.pages.analyze.criteria.anchors],
              ["keywords", t.pages.analyze.criteria.keywords],
              ["wayback", t.pages.analyze.criteria.wayback],
              ["stop_words", t.pages.analyze.criteria.stop_words],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-neutral-600 dark:text-neutral-400">
                {label}
              </span>
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={config.weights[key] ?? 0}
                onChange={(e) =>
                  setWeight(key, parseFloat(e.target.value) || 0)
                }
                disabled={busy}
                className={inputCls}
              />
            </label>
          ))}
        </div>
        <p
          className={`text-xs ${weightsTotal === 1 ? "text-neutral-500 dark:text-neutral-400" : "text-amber-600 dark:text-amber-400"}`}
        >
          {ts.weightsTotal(Number(weightsTotal.toFixed(3)))}
        </p>
      </div>

      {/* Bucket thresholds */}
      <div className="space-y-2">
        <div className="font-medium">{ts.bucketsHeading}</div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.bucketsHelp}
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2">
            <span className="text-neutral-600 dark:text-neutral-400">
              {ts.goodThreshold}
            </span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={config.good_threshold}
              onChange={(e) =>
                setField("good_threshold", parseFloat(e.target.value) || 0)
              }
              disabled={busy}
              className={inputCls}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-neutral-600 dark:text-neutral-400">
              {ts.mixedThreshold}
            </span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={config.mixed_threshold}
              onChange={(e) =>
                setField("mixed_threshold", parseFloat(e.target.value) || 0)
              }
              disabled={busy}
              className={inputCls}
            />
          </label>
        </div>
      </div>

      {/* Low-confidence threshold */}
      <div className="space-y-2">
        <div className="font-medium">{ts.lowConfHeading}</div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.lowConfHelp}
        </p>
        <label className="flex items-center gap-2">
          <span className="text-neutral-600 dark:text-neutral-400">
            {ts.lowConfThreshold}
          </span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.low_confidence_threshold}
            onChange={(e) =>
              setField(
                "low_confidence_threshold",
                parseFloat(e.target.value) || 0,
              )
            }
            disabled={busy}
            className={inputCls}
          />
        </label>
      </div>

      {error && (
        <div className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {busy ? ts.saving : ts.save}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || isAtDefault}
          className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {ts.resetDefaults}
        </button>
        {savedAt && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {ts.savedAt(savedAt.toLocaleTimeString())}
          </span>
        )}
      </div>
    </div>
  );
}
