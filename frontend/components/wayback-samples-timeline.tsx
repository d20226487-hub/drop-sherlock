"use client";
import { useT } from "@/lib/i18n";

export type WaybackSample = {
  timestamp?: string;
  url?: string;
  snapshot_url?: string;
  http_status?: number;
  title?: string;
  h1s?: string[];
  h2s?: string[];
  h3s?: string[];
  body_excerpt?: string;
  redirect_to?: string;
  error?: string;
};

type Sample = WaybackSample;

function fmtTs(ts: string | undefined): string {
  if (!ts || ts.length < 8) return ts ?? "";
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

export function WaybackSamplesTimeline({
  samples,
  // Non-null when the wayback CR for this rd was reused from a prior
  // run's cache. Surfaced as a violet "Reused from Run #N" pill in the
  // header — mirrors the badge on the CDX SortableTable below so the
  // user sees cache provenance even when the CDX section stays
  // collapsed (which it is by default — the V2 timeline is the
  // headline view for wayback).
  cachedFromRunId,
}: {
  samples: Sample[];
  cachedFromRunId?: number | null;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.waybackTimeline;
  if (!samples || samples.length === 0) return null;
  const okCount = samples.filter(
    (s) => s.http_status === 200 && (s.title || (s.h1s && s.h1s.length > 0)),
  ).length;
  return (
    <section className="space-y-3 pt-4 border-t dark:border-neutral-800">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold">{ts.heading}</h3>
          {cachedFromRunId != null && (
            <span
              className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
              title="Reused from a prior run with matching criteria"
            >
              {t.pages.jobs.domain.dataCachedFromRun(cachedFromRunId)}
            </span>
          )}
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.coverage(okCount, samples.length)}
        </span>
      </header>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.intro}
      </p>
      <ol className="space-y-3">
        {samples.map((s, i) => {
          const failed = !!s.error || (s.http_status && s.http_status !== 200);
          const dateLabel = fmtTs(s.timestamp);
          return (
            <li
              key={`${s.timestamp}-${i}`}
              className={`rounded-md border p-3 ${
                failed
                  ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900/60"
                  : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                  {dateLabel}
                </span>
                <div className="flex items-center gap-3">
                  {s.http_status ? (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        s.http_status === 200
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      }`}
                    >
                      HTTP {s.http_status}
                    </span>
                  ) : null}
                  {s.snapshot_url ? (
                    <a
                      href={s.snapshot_url.replace("id_/", "/")}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {ts.openSnapshot}
                    </a>
                  ) : null}
                </div>
              </div>
              {s.url ? (
                <div className="text-xs font-mono text-neutral-500 dark:text-neutral-400 break-all mt-1">
                  {s.url}
                </div>
              ) : null}
              {s.title ? (
                <div className="text-sm font-medium mt-2">{s.title}</div>
              ) : (
                <div className="text-sm text-neutral-400 italic mt-2">
                  {ts.noTitle}
                </div>
              )}
              {s.h1s && s.h1s.length > 0 ? (
                <div className="mt-2">
                  <span className="text-xs uppercase tracking-wide text-neutral-500">
                    H1
                  </span>
                  <ul className="text-sm list-disc ml-5">
                    {s.h1s.map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {s.h2s && s.h2s.length > 0 ? (
                <div className="mt-2">
                  <span className="text-xs uppercase tracking-wide text-neutral-500">
                    H2
                  </span>
                  <ul className="text-sm list-disc ml-5 text-neutral-700 dark:text-neutral-300">
                    {s.h2s.slice(0, 6).map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                    {s.h2s.length > 6 ? (
                      <li className="text-neutral-400 italic">
                        {ts.moreItems(s.h2s.length - 6)}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
              {s.h3s && s.h3s.length > 0 ? (
                <div className="mt-2">
                  <span className="text-xs uppercase tracking-wide text-neutral-500">
                    H3
                  </span>
                  <ul className="text-sm list-disc ml-5 text-neutral-700 dark:text-neutral-300">
                    {s.h3s.slice(0, 6).map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                    {s.h3s.length > 6 ? (
                      <li className="text-neutral-400 italic">
                        {ts.moreItems(s.h3s.length - 6)}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
              {s.redirect_to ? (
                <p className="text-xs mt-2">
                  <span className="uppercase tracking-wide text-neutral-500 mr-1">
                    {ts.redirectTo}
                  </span>
                  <a
                    href={s.redirect_to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-blue-600 dark:text-blue-400 hover:underline break-all"
                  >
                    {s.redirect_to}
                  </a>
                </p>
              ) : null}
              {s.body_excerpt ? (
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-2 italic">
                  “{s.body_excerpt}”
                </p>
              ) : null}
              {s.error ? (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 font-mono">
                  {ts.errorPrefix}: {s.error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
