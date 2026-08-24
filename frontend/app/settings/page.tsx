"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, ProviderStatus, RateLimits, SettingsPayload } from "@/lib/api";
import { ProviderCard } from "@/components/provider-card";
import { WaybackClassifyEditor } from "@/components/wayback-classify-editor";
import { WaybackAutoRetryEditor } from "@/components/wayback-auto-retry-editor";
import { WaybackProxiesEditor } from "@/components/wayback-proxies-editor";
import { AvailabilityAutoRetryEditor } from "@/components/availability-auto-retry-editor";
import { RateLimitsTable } from "@/components/rate-limits-table";
import { ClassifyContextEditor } from "@/components/classify-context-editor";
import { PromptEditors } from "@/components/prompt-editors";
import { StopWordsEditor } from "@/components/stop-words-editor";
import { ScoringEditor } from "@/components/scoring-editor";
import { PricingEditor } from "@/components/pricing-editor";
import { RetentionEditor } from "@/components/retention-editor";
import { BackupsEditor } from "@/components/backups-editor";
import { ImportLimitEditor } from "@/components/import-limit-editor";
import { AvailabilityEditor } from "@/components/availability-editor";
import { WhoisHistoryEditor } from "@/components/whois-history-editor";
import { DomainFilterEditor } from "@/components/domain-filter-editor";
import { SerpOverviewEditor } from "@/components/serp-overview-editor";

type SettingsTab =
  | "api"
  | "brain"
  | "wayback"
  | "availability"
  | "whoisHistory"
  | "domainFilter"
  | "serpOverview"
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
  // 2026-06-07: Domain Filter — multi-category exclusion list applied at
  // /backlog/import. Today only ccTLDs; designed to grow with more
  // categories (spam-keywords, banned-substrings, …) without touching
  // the schema or this enum.
  "domainFilter",
  // 2026-07-10: SERP Overview tool settings (duplicate-ignore window).
  "serpOverview",
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

              {/* Stop words sits directly above the prompt list: the
                  word list and the Stop Words judge prompt are edited
                  together, and the vocabulary is the input the prompt
                  reasons over. */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.stopWords}
                </h2>
                <StopWordsEditor />
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-semibold">{ts.sections.prompts}</h2>
                <PromptEditors />
              </section>
            </div>
          )}

          {tab === "wayback" && (
            <div className="space-y-8">
              {/* Post-run auto-retry sits ABOVE the classify config
                  because it's the toggle the user is most likely to
                  reach for ("I just want the run to finish without me
                  babysitting it") — same logic that puts the most-
                  used controls at the top elsewhere in Settings. */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">Auto-retry</h2>
                <WaybackAutoRetryEditor />
              </section>
              {/* Residential proxies sit next to auto-retry because they solve
                  the same complaint ("the run doesn't finish") — auto-retry
                  re-attempts the failures, this stops the direct IP from
                  generating them in the first place. */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.sections.waybackProxies}
                </h2>
                <WaybackProxiesEditor />
              </section>
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
              {/* Auto-retry sits above the cascade-order editor for the
                  same reason it does on Wayback — it's the toggle the
                  user is most likely to reach for after a flaky burst
                  run. Mirrors the Wayback tab's layout exactly. */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">Auto-retry</h2>
                <AvailabilityAutoRetryEditor />
              </section>
              <AvailabilityEditor />
            </div>
          )}

          {tab === "whoisHistory" && (
            <div className="space-y-8">
              <WhoisHistoryEditor />
            </div>
          )}

          {tab === "domainFilter" && (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {ts.domainFilter.heading}
                </h2>
                <DomainFilterEditor />
              </section>
            </div>
          )}

          {tab === "serpOverview" && <SerpOverviewEditor />}

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
