"use client";
import { useT } from "@/lib/i18n";
import { IntegrationStatus } from "@/lib/api";

const STATE_PILL: Record<IntegrationStatus["state"], string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  unconfigured: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const STATE_DOT: Record<IntegrationStatus["state"], string> = {
  ok: "bg-emerald-500",
  unconfigured: "bg-neutral-400",
  error: "bg-red-500",
};

function summary(it: IntegrationStatus): string | null {
  if (it.state !== "ok") return null;
  const d = it.details;
  switch (it.provider) {
    case "gemini": {
      const count = d.model_count;
      const dm = d.default_model;
      const ok = d.default_model_available;
      const parts: string[] = [];
      if (typeof count === "number") parts.push(`${count} models available`);
      if (typeof dm === "string" && dm)
        parts.push(`default: ${dm}${ok === false ? " (not in catalog)" : ""}`);
      return parts.join(" · ") || null;
    }
    case "github_models": {
      const count = d.model_count;
      const dm = d.default_model;
      const ok = d.default_model_available;
      const parts: string[] = [];
      if (typeof count === "number") parts.push(`${count} models available`);
      if (typeof dm === "string" && dm)
        parts.push(`default: ${dm}${ok === false ? " (not in catalog)" : ""}`);
      return parts.join(" · ") || null;
    }
    case "openrouter": {
      const dm = d.default_model;
      const usage = d.usage;
      const limit = d.limit;
      const parts: string[] = [];
      if (typeof dm === "string" && dm) parts.push(`default: ${dm}`);
      if (typeof usage === "number" || typeof limit === "number")
        parts.push(`usage: ${usage ?? "?"}/${limit ?? "∞"}`);
      return parts.join(" · ") || null;
    }
    case "ahrefs": {
      const raw = (d.raw || {}) as Record<string, unknown>;
      const plan = typeof raw.subscription === "string" ? raw.subscription : null;
      const used = typeof raw.units_usage_api_key === "number" ? raw.units_usage_api_key : null;
      const limit = typeof raw.units_limit_api_key === "number" ? raw.units_limit_api_key : null;
      const parts: string[] = [];
      if (plan) parts.push(plan);
      if (used !== null && limit !== null)
        parts.push(`${used.toLocaleString()} / ${limit.toLocaleString()} units used`);
      return parts.join(" · ") || null;
    }
    default:
      return null;
  }
}

export function IntegrationCard({ status }: { status: IntegrationStatus }) {
  const { t } = useT();
  const ts = t.pages.dashboard;
  const label =
    ts.providerNames[status.provider as keyof typeof ts.providerNames] ||
    status.provider;
  const stateLabel = ts.states[status.state] || status.state;
  const oneLiner = summary(status);

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <span
              aria-hidden
              className={`w-2 h-2 rounded-full ${STATE_DOT[status.state]}`}
            />
            {label}
          </h3>
          {oneLiner && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {oneLiner}
            </p>
          )}
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${STATE_PILL[status.state]}`}
        >
          {stateLabel}
          {status.state === "ok" && status.elapsed_ms != null && (
            <> · {ts.elapsed(status.elapsed_ms)}</>
          )}
        </span>
      </header>

      {(status.state === "unconfigured" || status.state === "error") && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {status.error}
        </p>
      )}
    </section>
  );
}
