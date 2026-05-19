"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { api, ProviderStatus, TestResult } from "@/lib/api";
import { ModelRegistryEditor } from "@/components/model-registry-editor";

type FieldKey =
  | "api_key"
  | "token"
  | "default_model"
  | "service_account_json"
  | "project_id"
  | "location";

const FIELDS_BY_PROVIDER: Record<string, FieldKey[]> = {
  ahrefs: ["api_key"],
  gemini: ["api_key", "default_model"],
  github_models: ["token", "default_model"],
  openrouter: ["api_key", "default_model"],
  // Vertex AI auto-detects mode at call time: service_account_json wins
  // when present (enterprise mode); api_key is the Vertex Express
  // fallback. project_id + location are only consumed by the SA path.
  vertex_ai: [
    "api_key",
    "service_account_json",
    "project_id",
    "location",
    "default_model",
  ],
};

const AI_PROVIDERS_FOR_MODELS = new Set([
  "gemini",
  "github_models",
  "openrouter",
  "vertex_ai",
]);

// Fields that should render as a multi-line textarea rather than a
// single-line input. Currently only the Vertex service-account JSON.
const TEXTAREA_FIELDS: ReadonlySet<FieldKey> = new Set([
  "service_account_json",
]);

export function ProviderCard({
  status,
  knownModels,
  onChanged,
  onKnownModelsChanged,
}: {
  status: ProviderStatus;
  // Per-provider list of known model IDs from the parent's settings
  // payload. Empty array for ahrefs (no model concept) and for AI
  // providers with no models added yet.
  knownModels: string[];
  onChanged: (next: ProviderStatus) => void;
  // Echoed up so the parent's cached `known_models` map stays in sync
  // after any add / merge / remove round-trip.
  onKnownModelsChanged: (provider: string, models: string[]) => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings;
  const fields = FIELDS_BY_PROVIDER[status.provider] || [];
  const [draft, setDraft] = useState<Record<FieldKey, string>>({
    api_key: "",
    token: "",
    default_model: "",
    service_account_json: "",
    project_id: "",
    location: "",
  });
  const [busy, setBusy] = useState<"idle" | "saving" | "testing" | "clearing">(
    "idle",
  );
  const [message, setMessage] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | null
  >(null);
  const [testDetails, setTestDetails] = useState<unknown>(null);

  const providerLabel =
    ts.providerNames[status.provider as keyof typeof ts.providerNames] ||
    status.provider;
  const help =
    ts.providerHelp[status.provider as keyof typeof ts.providerHelp] || "";

  const headerStatus = (() => {
    // Vertex AI is "configured" when EITHER the service-account JSON
    // OR the API key is filled in — both auth modes count.
    if (status.provider === "vertex_ai") {
      const sa = status.fields["service_account_json"];
      const ak = status.fields["api_key"];
      const anyCred = (sa && sa.configured) || (ak && ak.configured);
      return anyCred ? "configured" : "not_set";
    }
    const isAi = status.provider !== "ahrefs";
    const credField: FieldKey = isAi
      ? status.provider === "github_models"
        ? "token"
        : "api_key"
      : "api_key";
    const f = status.fields[credField];
    return f && f.configured ? "configured" : "not_set";
  })();

  async function save() {
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = draft[f].trim();
      if (v) payload[f] = v;
    }
    if (Object.keys(payload).length === 0) {
      setMessage({ kind: "err", text: "Nothing to save." });
      return;
    }
    setBusy("saving");
    setMessage(null);
    try {
      const next = await api.updateProviderCreds(status.provider, payload);
      onChanged(next);
      setDraft({
        api_key: "",
        token: "",
        default_model: "",
        service_account_json: "",
        project_id: "",
        location: "",
      });
      setMessage({ kind: "ok", text: t.common.saved });
    } catch (e) {
      const err = e as Error;
      setMessage({ kind: "err", text: err.message || "save failed" });
    } finally {
      setBusy("idle");
    }
  }

  async function clearAll() {
    if (!confirm(ts.clearConfirm(providerLabel))) return;
    setBusy("clearing");
    setMessage(null);
    try {
      const next = await api.clearProvider(status.provider);
      onChanged(next);
      setTestDetails(null);
      setMessage({ kind: "ok", text: t.common.cleared });
    } catch (e) {
      const err = e as Error;
      setMessage({ kind: "err", text: err.message || "clear failed" });
    } finally {
      setBusy("idle");
    }
  }

  async function test() {
    setBusy("testing");
    setMessage(null);
    setTestDetails(null);
    const r: TestResult = await api.testProvider(status.provider);
    if (r.ok) {
      setMessage({ kind: "ok", text: ts.testOk });
      const { ok: _ok, ...rest } = r;
      void _ok;
      setTestDetails(rest);
    } else {
      setMessage({ kind: "err", text: `${ts.testFail}: ${r.error}` });
    }
    setBusy("idle");
  }

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{providerLabel}</h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {help}
          </p>
        </div>
        <span
          className={
            "text-xs px-2 py-0.5 rounded-full whitespace-nowrap " +
            (headerStatus === "configured"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400")
          }
        >
          {headerStatus === "configured" ? "configured" : ts.notSet}
        </span>
      </header>

      <div className="space-y-3">
        {fields.map((f) => {
          const current = status.fields[f];
          const isSecret =
            f === "api_key" ||
            f === "token" ||
            f === "service_account_json";
          const isTextarea = TEXTAREA_FIELDS.has(f);
          // For AI providers, default_model is now a dropdown sourced from
          // the known-models registry — typing IDs by hand is the old flow.
          // The registry editor below the inputs is where you add models.
          const isAiDefaultModel =
            f === "default_model" &&
            AI_PROVIDERS_FOR_MODELS.has(status.provider);
          return (
            <div key={f} className="space-y-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {ts.fieldLabels[f]}
              </label>
              {isAiDefaultModel ? (
                <select
                  value={draft[f]}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [f]: e.target.value }))
                  }
                  className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">
                    {knownModels.length === 0
                      ? ts.modelDropdownEmpty
                      : ts.modelDropdownPlaceholder}
                  </option>
                  {knownModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : isTextarea ? (
                <textarea
                  value={draft[f]}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [f]: e.target.value }))
                  }
                  placeholder={ts.fieldPlaceholders[f]}
                  rows={6}
                  className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <input
                  type={isSecret ? "password" : "text"}
                  value={draft[f]}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [f]: e.target.value }))
                  }
                  placeholder={ts.fieldPlaceholders[f]}
                  className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {current && current.configured
                  ? isSecret && "last4" in current
                    ? ts.savedSecret(current.last4, current.length)
                    : "value" in current
                      ? ts.savedValue(current.value)
                      : ""
                  : ts.notSet}
              </div>
            </div>
          );
        })}
      </div>

      {AI_PROVIDERS_FOR_MODELS.has(status.provider) && (
        <ModelRegistryEditor
          provider={status.provider}
          models={knownModels}
          defaultModel={
            (() => {
              const f = status.fields.default_model;
              return f && f.configured && "value" in f ? f.value : "";
            })()
          }
          onModelsChanged={(models) =>
            onKnownModelsChanged(status.provider, models)
          }
          onDefaultChanged={async (model) => {
            const next = await api.updateProviderCreds(status.provider, {
              default_model: model,
            });
            onChanged(next);
          }}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={save}
          disabled={busy !== "idle"}
          className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {busy === "saving" ? t.common.loading : t.common.save}
        </button>
        <button
          onClick={test}
          disabled={busy !== "idle" || headerStatus !== "configured"}
          className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy === "testing" ? t.common.loading : t.common.test}
        </button>
        <button
          onClick={clearAll}
          disabled={busy !== "idle" || headerStatus !== "configured"}
          className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
        >
          {busy === "clearing" ? t.common.loading : t.common.clear}
        </button>
      </div>

      {message && (
        <div
          className={
            "text-sm rounded-md px-3 py-2 " +
            (message.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300")
          }
        >
          {message.text}
        </div>
      )}

      {testDetails != null && (
        <pre className="text-xs bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 overflow-x-auto border dark:border-neutral-800">
          {JSON.stringify(testDetails, null, 2)}
        </pre>
      )}
    </section>
  );
}
