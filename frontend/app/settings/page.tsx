"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, ProviderStatus, RateLimits, SettingsPayload } from "@/lib/api";
import { ProviderCard } from "@/components/provider-card";
import { WaybackClassifyEditor } from "@/components/wayback-classify-editor";
import { RateLimitsTable } from "@/components/rate-limits-table";
import { ClassifyContextEditor } from "@/components/classify-context-editor";
import { PromptEditors } from "@/components/prompt-editors";
import { ScoringEditor } from "@/components/scoring-editor";
import { PricingEditor } from "@/components/pricing-editor";
import { RetentionEditor } from "@/components/retention-editor";
import { BackupsEditor } from "@/components/backups-editor";
import { ImportLimitEditor } from "@/components/import-limit-editor";
import { AvailabilityEditor } from "@/components/availability-editor";
import { WhoisHistoryEditor } from "@/components/whois-history-editor";

type SettingsTab =
  | "api"
  | "brain"
  | "wayback"
  | "availability"
  | "whoisHistory"
  | "others";

const TABS: SettingsTab[] = [
  "api",
  "brain",
  "wayback",
  "availability",
  // Wave 2b (2026-05-15): pillar-specific tab for the WHOIS history
  // pillar. Lives between Availability and Others so the order matches
  // the pipeline pillars on the nav (Availability → Whois → Quality).
  "whoisHistory",
  "others",
];

export default function SettingsPage() {
  const { t } = useT();
  const ts = t.pages.settings;
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>("api");

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function updateProvider(next: ProviderStatus) {
    setData((d) =>
      d
        ? {
            ...d,
            providers: d.providers.map((p) =>
              p.provider === next.provider ? next : p,
            ),
          }
        : d,
    );
  }

  function updateRateLimits(provider: string, next: RateLimits) {
    setData((d) =>
      d ? { ...d, rate_limits: { ...d.rate_limits, [provider]: next } } : d,
    );
  }

  function updateKnownModels(provider: string, models: string[]) {
    setData((d) =>
      d
        ? {
            ...d,
            known_models: { ...d.known_models, [provider]: models },
          }
        : d,
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {ts.intro}
        </p>
      </div>

      {loadError && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {loadError}
        </div>
      )}

      {data === null && !loadError && (
        <div className="text-sm text-neutral-500">{t.common.loading}</div>
      )}

      {data && (
        <>
          <div
            role="tablist"
            aria-label={ts.title}
            className="flex flex-wrap gap-1 border-b dark:border-neutral-800"
          >
            {TABS.map((key) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(key)}
                  className={
                    "px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors " +
                    (active
                      ? "border-blue-600 text-blue-600 dark:text-blue-400"
                      : "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100")
                  }
                >
                  {ts.tabs[key]}
                </button>
              );
            })}
          </div>

          {tab === "api" && (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.providers}
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {data.providers.map((p) => (
                    <ProviderCard
                      key={p.provider}
                      status={p}
                      knownModels={data.known_models[p.provider] || []}
                      onChanged={updateProvider}
                      onKnownModelsChanged={updateKnownModels}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.rateLimits}
                </h2>
                <RateLimitsTable
                  values={data.rate_limits}
                  onChanged={updateRateLimits}
                />
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-semibold">{ts.sections.pricing}</h2>
                <PricingEditor />
              </section>
            </div>
          )}

          {tab === "brain" && (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">{ts.sections.scoring}</h2>
                <ScoringEditor />
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.classifyContext}
                </h2>
                <ClassifyContextEditor />
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-semibold">{ts.sections.prompts}</h2>
                <PromptEditors />
              </section>
            </div>
          )}

          {tab === "wayback" && (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.waybackClassify}
                </h2>
                <WaybackClassifyEditor />
              </section>
            </div>
          )}

          {tab === "availability" && (
            <div className="space-y-8">
              <AvailabilityEditor />
            </div>
          )}

          {tab === "whoisHistory" && (
            <div className="space-y-8">
              <WhoisHistoryEditor />
            </div>
          )}

          {tab === "others" && (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.retention.heading}
                </h2>
                <RetentionEditor />
              </section>
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.importLimit.heading}
                </h2>
                <ImportLimitEditor />
              </section>
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.backups.heading}
                </h2>
                <BackupsEditor />
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
