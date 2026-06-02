"use client";
// Submit form for the Ahrefs Batch Analysis pillar (2026-06-02).
// Mirrors /check/availability (no AI) but adds two per-job knobs:
//   • metric checkboxes (subset of AHREFS_BATCH_METRICS; DR only default)
//   • optional country (scopes org_traffic / org_keywords)
// Drains the Backlog handoff + supports rerun, same as the other pillars.

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AHREFS_BATCH_METRICS, AnalyzeSpec, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { DomainInput } from "@/components/domain-input";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";

export default function CheckAhrefsBatchAnalysisPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-neutral-500 dark:text-neutral-400 py-12 text-center">
          Loading…
        </div>
      }
    >
      <CheckAhrefsBatchAnalysisForm />
    </Suspense>
  );
}

function CheckAhrefsBatchAnalysisForm() {
  const { t } = useT();
  const ts = t.pages.checkAhrefsBatch;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [domainText, setDomainText] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  // Default: DR only (cheapest single field).
  const [metrics, setMetrics] = useState<Set<string>>(
    () => new Set(["domain_rating"]),
  );
  const [country, setCountry] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bannedSkipped, setBannedSkipped] = useState<string[]>([]);

  const rerunJobId = (() => {
    const v = searchParams?.get("rerun");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const [rerunJobName, setRerunJobName] = useState<string | null>(null);
  const [rerunSourceSpec, setRerunSourceSpec] = useState<AnalyzeSpec | null>(
    null,
  );

  useEffect(() => {
    if (rerunJobId === null) {
      setRerunJobName(null);
      setRerunSourceSpec(null);
      return;
    }
    let cancelled = false;
    api
      .getJobSpec(rerunJobId)
      .then((r) => {
        if (cancelled) return;
        setRerunJobName(r.name || `Job #${rerunJobId}`);
        setRerunSourceSpec(r.spec);
        setDomainText((r.spec.domains || []).join("\n"));
        // Prefill metrics + country from the source job's spec.
        const cfg = r.spec.criteria?.ahrefs_batch_analysis;
        if (cfg) {
          if (Array.isArray(cfg.metrics) && cfg.metrics.length > 0) {
            setMetrics(new Set(cfg.metrics));
          }
          if (typeof cfg.country === "string") setCountry(cfg.country);
        }
      })
      .catch(() => {
        router.replace("/check/ahrefs-batch-analysis");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunJobId]);

  useEffect(() => {
    if (!searchParams) return;
    if (searchParams.get("from_backlog") !== "1") return;
    try {
      const raw = sessionStorage.getItem(BACKLOG_HANDOFF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { domains?: string[] };
        const list = Array.isArray(parsed.domains) ? parsed.domains : [];
        if (list.length > 0) setDomainText(list.join("\n"));
        sessionStorage.removeItem(BACKLOG_HANDOFF_KEY);
      }
    } catch {
      // Bad JSON / blocked storage — ignore, user can paste manually.
    }
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("from_backlog");
    const q = sp.toString();
    router.replace(`/check/ahrefs-batch-analysis${q ? `?${q}` : ""}`);
  }, [searchParams, router]);

  const cleanedDomains = domainText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const canSubmit =
    !submitting && cleanedDomains.length > 0 && metrics.size > 0;

  function toggleMetric(id: string) {
    setMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOn = metrics.size === AHREFS_BATCH_METRICS.length;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setBannedSkipped([]);
    // Send in canonical order.
    const selected = AHREFS_BATCH_METRICS.filter((m) => metrics.has(m.id)).map(
      (m) => m.id,
    );
    try {
      let jobId: number;
      let runId: number;
      let skippedBanned: string[] = [];
      if (rerunJobId !== null && rerunSourceSpec !== null) {
        const spec: AnalyzeSpec = {
          ...rerunSourceSpec,
          domains: cleanedDomains,
          criteria: {
            ...rerunSourceSpec.criteria,
            ahrefs_batch_analysis: {
              enabled: true,
              metrics: selected,
              country: country.trim() || null,
            },
          },
        };
        const r = await api.rerunJob(rerunJobId, spec);
        jobId = r.job_id;
        runId = r.run_id;
      } else {
        const r = await api.submitAhrefsBatchAnalysisJob({
          domains: cleanedDomains,
          metrics: selected,
          country: country.trim() || null,
          name: name.trim() || undefined,
          notes: notes.trim() || undefined,
        });
        jobId = r.job_id;
        runId = r.run_id;
        skippedBanned = r.skipped_banned;
      }
      if (skippedBanned.length > 0) setBannedSkipped(skippedBanned);
      router.push(`/jobs/${jobId}/runs/${runId}`);
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.detail?.code === "all_banned") {
          const sample = (parsed.detail.sample as string[]).join(", ");
          msg = ts.allBannedError(
            parsed.detail.count as number,
            sample,
            !!parsed.detail.truncated,
          );
        }
      } catch {
        // Not JSON — leave msg as-is.
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ts.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1 leading-relaxed max-w-3xl">
          {ts.subtitle}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2 max-w-3xl">
          {ts.pipelineHint}
        </p>
      </div>

      {rerunJobId !== null && rerunJobName !== null && (
        <div className="rounded-md border border-blue-300 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <span className="font-semibold text-blue-900 dark:text-blue-100">
                {ts.rerunBannerTitle}:
              </span>{" "}
              <span className="text-blue-800 dark:text-blue-200">
                {rerunJobName}
              </span>
            </div>
            <Link
              href="/check/ahrefs-batch-analysis"
              className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
            >
              {ts.rerunBannerCancel}
            </Link>
          </div>
          <p className="text-xs text-blue-800/80 dark:text-blue-200/80 mt-1">
            {ts.rerunBannerHelp}
          </p>
        </div>
      )}

      <DomainInput value={domainText} onChange={setDomainText} />

      {/* Metric picker */}
      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{ts.metricsHeading}</h2>
          <button
            type="button"
            onClick={() =>
              setMetrics(
                allOn
                  ? new Set(["domain_rating"])
                  : new Set(AHREFS_BATCH_METRICS.map((m) => m.id)),
              )
            }
            disabled={submitting}
            className="text-xs text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            {allOn ? ts.clearAll : ts.selectAll}
          </button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.metricsHint}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          {AHREFS_BATCH_METRICS.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={metrics.has(m.id)}
                onChange={() => toggleMetric(m.id)}
                disabled={submitting}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
        <label className="block max-w-[16rem] pt-2 border-t dark:border-neutral-800">
          <span className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1 mt-2">
            {ts.countryLabel}
          </span>
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder={ts.countryAny}
            maxLength={2}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40 lowercase"
          />
          <span className="block text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {ts.countryHint}
          </span>
        </label>
      </section>

      {/* Job label */}
      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
        <h2 className="text-lg font-semibold">{ts.labelHeading}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.labelHint}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1">
              {ts.nameLabel}
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={ts.namePlaceholder}
              maxLength={200}
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1">
              {ts.notesLabel}
            </span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={ts.notesPlaceholder}
              maxLength={500}
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </label>
        </div>
      </section>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300 whitespace-pre-wrap">
          {error}
        </div>
      )}
      {bannedSkipped.length > 0 && (
        <div className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {ts.skippedBanned(bannedSkipped.length)}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {metrics.size === 0 ? ts.noMetricsError : ts.summary(cleanedDomains.length)}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/settings"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {ts.settingsLink} →
          </Link>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="text-sm px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? ts.submitting : ts.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
