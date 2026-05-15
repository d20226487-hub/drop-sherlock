"use client";
// Wave 3 (2026-05-15): real submit form for the availability pillar.
// Mirrors /check/whois-history but stripped further — no AI selector
// since the cascade gives a deterministic answer (Wave 3 decision (a)).
// All cascade knobs (provider order, RPS, per-provider toggles, TTL)
// live in Settings → Availability and apply globally.
//
// Drains the Backlog handoff (`?from_backlog=1` + sessionStorage) the
// same way Quality + Whois do. Replaces the interim inline-cascade
// stub that lived here previously.

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { DomainInput } from "@/components/domain-input";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";

export default function CheckAvailabilityPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-neutral-500 dark:text-neutral-400 py-12 text-center">
          Loading…
        </div>
      }
    >
      <CheckAvailabilityForm />
    </Suspense>
  );
}

function CheckAvailabilityForm() {
  const { t } = useT();
  const ts = t.pages.checkAvailability;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [domainText, setDomainText] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bannedSkipped, setBannedSkipped] = useState<string[]>([]);

  // Backlog → Check handoff drain. Same shape Whois + Quality use.
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
    router.replace(`/check/availability${q ? `?${q}` : ""}`);
  }, [searchParams, router]);

  const cleanedDomains = domainText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const canSubmit = !submitting && cleanedDomains.length > 0;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setBannedSkipped([]);
    try {
      const r = await api.submitAvailabilityJob({
        domains: cleanedDomains,
        name: name.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      if (r.skipped_banned.length > 0) {
        setBannedSkipped(r.skipped_banned);
      }
      router.push(`/jobs/${r.job_id}/runs/${r.run_id}`);
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

      <DomainInput value={domainText} onChange={setDomainText} />

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
          {ts.summary(cleanedDomains.length)}
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
