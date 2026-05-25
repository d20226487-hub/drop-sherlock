"use client";
// Wave 2b (2026-05-15): real submit form for the whois_history pillar.
// Mirrors the layout of /check/quality but stripped down — this pillar
// has ONE criterion (WHOIS history drop-detection) and no per-criterion
// knobs (everything's in Settings → Whois History).
//
// `useSearchParams` (used for the Backlog handoff drain) requires a
// Suspense boundary during Next.js's prerender pass — the outer
// component sets one up; the inner one holds all the actual form
// state + the searchParams hook.

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, AISpec, AnalyzeSpec } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { DomainInput } from "@/components/domain-input";
import { AISelector } from "@/components/ai-selector";
import { BACKLOG_HANDOFF_KEY } from "@/lib/backlog-handoff";

export default function CheckWhoisHistoryPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-neutral-500 dark:text-neutral-400 py-12 text-center">
          Loading…
        </div>
      }
    >
      <CheckWhoisHistoryForm />
    </Suspense>
  );
}

function CheckWhoisHistoryForm() {
  const { t, lang } = useT();
  const ts = t.pages.checkWhoisHistory;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [domainText, setDomainText] = useState("");
  const [ai, setAi] = useState<AISpec>({ provider: null, model: null });
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bannedSkipped, setBannedSkipped] = useState<string[]>([]);

  // Rerun mode (added 2026-05-21). Reads `?rerun=<jobId>` and pre-fills
  // the form from the source job's spec. On submit, adds a Run to the
  // existing Job via api.rerunJob instead of creating a new Job. The
  // Rerun button on /jobs/[id] routes here by job.kind.
  const rerunJobId = (() => {
    const v = searchParams?.get("rerun");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const [rerunJobName, setRerunJobName] = useState<string | null>(null);
  // Snapshot of the source spec — we copy criteria + ai + lang verbatim
  // on submit (the user only edits domain list / AI on this page).
  const [rerunSourceSpec, setRerunSourceSpec] = useState<AnalyzeSpec | null>(
    null,
  );

  // Rerun prefill (2026-05-21). When ?rerun=<id> is present, load the
  // source job's spec and copy domains + ai into the form. Mirrors the
  // /check/quality rerun mechanism, simplified — this pillar has no
  // criteria knobs to surface beyond AI selection.
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
        if (r.spec.ai) setAi(r.spec.ai);
      })
      .catch(() => {
        // Failed prefill — strip the param so the page reverts to a
        // fresh-job submit.
        router.replace("/check/whois-history");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunJobId]);

  // Backlog → Check handoff. Mirrors the Quality form's behavior:
  // when the user clicks "Send to Whois History" from Backlog, we
  // stash the domain list in sessionStorage (same key as Quality
  // uses, since only one transit is ever in flight) and arrive with
  // `?from_backlog=1`. Drain on mount, then strip the query param so
  // a reload doesn't re-drain stale state.
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
    // Strip ?from_backlog=1 without re-routing so the next reload
    // doesn't try the handoff again. URLSearchParams.delete + replace.
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("from_backlog");
    const q = sp.toString();
    router.replace(`/check/whois-history${q ? `?${q}` : ""}`);
  }, [searchParams, router]);

  const cleanedDomains = domainText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const canSubmit =
    !submitting &&
    cleanedDomains.length > 0 &&
    ai.provider !== null;

  async function submit() {
    if (!canSubmit || ai.provider === null) return;
    setSubmitting(true);
    setError(null);
    setBannedSkipped([]);
    // Resolve the submit-time locale defensively. The React-state `lang`
    // from useT() is sufficient in the common case, but a layout shell
    // race (LangProvider initialises to "en" and only switches to the
    // localStorage value via a mount-time useEffect) means an unlucky
    // submit on a freshly-hydrated page could capture the stale "en"
    // closure. `document.documentElement.lang` is set BEFORE React
    // hydrates by the pre-init `<script>` in app/layout.tsx — so it's
    // the most authoritative source we have at click time. Fall back
    // to the React state if the DOM somehow has neither expected
    // value (sandboxed iframes can wipe documentElement.lang).
    const submitLang: "en" | "ru" = (() => {
      const fromDom = document.documentElement.lang;
      if (fromDom === "ru" || fromDom === "en") return fromDom;
      return lang === "ru" ? "ru" : "en";
    })();
    try {
      let jobId: number;
      let runId: number;
      let skippedBanned: string[] = [];
      if (rerunJobId !== null && rerunSourceSpec !== null) {
        // Rerun path: add a new Run to the existing Job. Carry the
        // source spec's criteria + lang verbatim (this pillar's only
        // criterion is whois_history.enabled=true; the source spec
        // already has it on) and overlay user-editable bits (domains
        // + ai). `lang` is OVERRIDDEN with the current UI locale so
        // an EN-locale rerun of an originally-RU job (or vice versa)
        // produces verdicts in the operator's current language — same
        // behaviour as new submits below.
        const spec: AnalyzeSpec = {
          ...rerunSourceSpec,
          domains: cleanedDomains,
          ai: { provider: ai.provider, model: ai.model ?? null },
          lang: submitLang,
        };
        const r = await api.rerunJob(rerunJobId, spec);
        jobId = r.job_id;
        runId = r.run_id;
        // The rerun endpoint doesn't return skipped_banned today — the
        // ban-list pre-filter happens client-side on the analyze
        // submit path. For reruns we trust the user's curated domain
        // list (they're re-running a known set).
      } else {
        const r = await api.submitWhoisHistoryJob({
          domains: cleanedDomains,
          ai_provider: ai.provider,
          ai_model: ai.model ?? undefined,
          name: name.trim() || undefined,
          notes: notes.trim() || undefined,
          // Carry the current UI language so the backend appends a
          // Russian-output directive to the whois_history_judge AI
          // prompt on RU runs (parallels how /check/quality submits
          // its spec). Without this, RU operators always saw English
          // verdict summaries / key_signals / recommendation text
          // because the backend defaulted to lang="en".
          lang: submitLang,
        });
        jobId = r.job_id;
        runId = r.run_id;
        skippedBanned = r.skipped_banned;
      }
      if (skippedBanned.length > 0) {
        setBannedSkipped(skippedBanned);
      }
      router.push(`/jobs/${jobId}/runs/${runId}`);
    } catch (e) {
      // Structured 'all_banned' error from the backend has the same
      // shape as the Quality submit; localize the message but otherwise
      // surface the raw error text.
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
              href="/check/whois-history"
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

      <AISelector value={ai} onChange={setAi} />

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
