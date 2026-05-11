"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { api, AIProvider, AISpec, ProviderStatus } from "@/lib/api";

const AI_PROVIDERS: AIProvider[] = ["gemini", "github_models", "openrouter"];

type Status = {
  configured: boolean;
  default_model: string | null;
};

function readStatus(p: ProviderStatus): Status {
  // The credential field varies per provider — both api_key and token
  // count as "configured". `default_model` is plaintext.
  const fields = p.fields;
  const credField =
    p.provider === "github_models"
      ? fields["token"]
      : fields["api_key"];
  const dm = fields["default_model"];
  return {
    configured: !!(credField && credField.configured),
    default_model: dm && dm.configured && "value" in dm ? dm.value : null,
  };
}

export function AISelector({
  value,
  onChange,
}: {
  value: AISpec;
  onChange: (next: AISpec) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.ai;
  const labels = t.pages.dashboard.providerNames;

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
        // Auto-pick the first CONFIGURED provider on first load. We don't
        // require a default_model here — the selector renders a "no default
        // model" warning if the picked provider is missing one, which is
        // actionable. Silently leaving "None" because no model is set led
        // to users submitting jobs that never invoked AI.
        if (value.provider === null) {
          const firstConfigured = AI_PROVIDERS.find(
            (k) => m[k]?.configured,
          );
          if (firstConfigured) {
            onChange({ provider: firstConfigured, model: null });
          }
        }
      })
      .catch(() => {
        // Silently ignore — selector falls back to None.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = value.provider;
  const status = selected && statuses ? statuses[selected] : null;
  const modelsForSelected = selected ? knownModels[selected] || [] : [];

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
      <header>
        <h2 className="text-lg font-semibold">{ts.heading}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          {ts.help}
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.provider}
        </label>
        <select
          value={selected || ""}
          onChange={(e) => {
            const v = e.target.value as AIProvider | "";
            onChange({ provider: v ? v : null, model: null });
          }}
          className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="">{ts.none}</option>
          {AI_PROVIDERS.map((k) => {
            const s = statuses?.[k];
            const label = labels[k as keyof typeof labels] || k;
            const disabled = !s?.configured;
            return (
              <option key={k} value={k} disabled={disabled}>
                {label}
                {disabled ? ` ${ts.notConfigured}` : ""}
              </option>
            );
          })}
        </select>
        {selected && (
          <>
            <label className="text-sm text-neutral-600 dark:text-neutral-400">
              {ts.modelPickerLabel}
            </label>
            <select
              value={value.model || ""}
              onChange={(e) => {
                const m = e.target.value;
                onChange({ provider: value.provider, model: m ? m : null });
              }}
              className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
              disabled={modelsForSelected.length === 0}
            >
              <option value="">
                {status?.default_model
                  ? ts.modelDropdownDefaultOption(status.default_model)
                  : ts.modelDropdownNoDefault}
              </option>
              {modelsForSelected
                .filter((m) => m !== status?.default_model)
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
            {modelsForSelected.length === 0 && (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {ts.noKnownModels}{" "}
                <Link href="/settings" className="underline">
                  Settings
                </Link>
                .
              </span>
            )}
          </>
        )}
      </div>
      {!selected &&
        statuses &&
        AI_PROVIDERS.some((k) => statuses[k]?.configured) && (
          <div className="text-sm rounded-md px-3 py-2 bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800/50">
            {ts.skippedWarning}
          </div>
        )}
    </section>
  );
}
