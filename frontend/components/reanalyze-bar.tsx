"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, AIProvider, ProviderStatus } from "@/lib/api";

const AI_PROVIDERS: AIProvider[] = ["gemini", "github_models", "openrouter"];

type Status = {
  configured: boolean;
  default_model: string | null;
};

function readStatus(p: ProviderStatus): Status {
  const fields = p.fields;
  const credField =
    p.provider === "github_models" ? fields["token"] : fields["api_key"];
  const dm = fields["default_model"];
  return {
    configured: !!(credField && credField.configured),
    default_model: dm && dm.configured && "value" in dm ? dm.value : null,
  };
}

/** Compact inline AI picker + Reanalyze button.
 *
 * The reanalyze action bypasses the AI cache by design (see backend
 * `_run_ai_for_domain` with `use_cache=False`). The picker lets the user
 * try a different model on the existing Ahrefs data without re-fetching
 * — useful for prompt experiments and cross-model comparisons.
 *
 * Defaults to the run's current spec.ai. Empty model = use provider's
 * Settings default (`default_model`). Disabled while a reanalyze is in
 * flight on the run/domain. */
export function ReanalyzeBar({
  defaultProvider,
  defaultModel,
  busy,
  inflight,
  onSubmit,
}: {
  defaultProvider: AIProvider | "";
  defaultModel: string;
  busy: boolean;
  inflight: boolean;
  onSubmit: (provider: AIProvider, model: string) => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.run;

  const [provider, setProvider] = useState<AIProvider | "">(defaultProvider);
  const [model, setModel] = useState<string>(defaultModel || "");
  const [statuses, setStatuses] = useState<Record<string, Status> | null>(null);
  const [knownModels, setKnownModels] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((d) => {
        if (cancelled) return;
        const m: Record<string, Status> = {};
        for (const p of d.providers) {
          if (AI_PROVIDERS.includes(p.provider as AIProvider)) {
            m[p.provider] = readStatus(p);
          }
        }
        setStatuses(m);
        setKnownModels(d.known_models || {});
        // If no default provider was given but one is configured, pre-pick.
        if (!provider) {
          const firstConfigured = AI_PROVIDERS.find((k) => m[k]?.configured);
          if (firstConfigured) setProvider(firstConfigured);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = provider && statuses ? statuses[provider] : null;
  const modelsForProvider = provider ? knownModels[provider] || [] : [];
  const effectiveModel = model.trim() || (status?.default_model ?? "");
  const canSubmit = !busy && !inflight && !!provider && !!effectiveModel;

  function handleSubmit() {
    if (!provider || !effectiveModel) return;
    onSubmit(provider, model.trim());
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5 rounded-md border dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/50 px-2 py-1">
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as AIProvider | "")}
        disabled={busy || inflight}
        className="text-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-1 outline-none disabled:opacity-50"
        title="AI provider"
      >
        <option value="">—</option>
        {AI_PROVIDERS.map((k) => {
          const s = statuses?.[k];
          const disabled = !s?.configured;
          return (
            <option key={k} value={k} disabled={disabled}>
              {k}
              {disabled ? " (not configured)" : ""}
            </option>
          );
        })}
      </select>
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={busy || inflight || !provider || modelsForProvider.length === 0}
        className="text-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-1.5 py-1 outline-none disabled:opacity-50 font-mono w-56"
        title={
          status?.default_model
            ? `Leave blank to use Settings default (${status.default_model})`
            : "Pick a model from the registry (Settings)"
        }
      >
        <option value="">
          {status?.default_model
            ? `default · ${status.default_model}`
            : modelsForProvider.length === 0
              ? "no models in registry"
              : "default"}
        </option>
        {modelsForProvider
          .filter((m) => m !== status?.default_model)
          .map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
      </select>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        title={ts.reanalyzeHint}
        className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy || inflight ? ts.reanalyzing : ts.reanalyze}
      </button>
    </div>
  );
}
