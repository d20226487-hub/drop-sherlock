"use client";
import { use, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, PublicShareDetail } from "@/lib/api";
import { StatusPill } from "@/components/status-pill";
import { CriterionTable } from "@/components/criterion-table";
import { VerdictBox } from "@/components/verdict-box";
import {
  WaybackSamplesTimeline,
  WaybackSample,
} from "@/components/wayback-samples-timeline";
import {
  bannerToneWithConfidence,
  parseFinalScore,
  scoreToBucket,
  formatScore,
  labelToBucket,
} from "@/lib/score";

// Public, basic-auth-free domain analysis page. Loaded via a share
// token; the backend at `/api/public/share/{token}` validates the
// token + serves a sanitized payload (no cost, no AI provider, no
// request URLs, no internal IDs). Mutation actions (pin / reanalyze /
// edit notes) are intentionally absent — this view is read-only.
//
// Layout differs from the operator-side domain page:
//   - No back link (recipient may not have any other operator page
//     accessible)
//   - No reanalyze bar, no pin button, no AI cost/units pills
//   - Notes appear if present, but read-only
//   - No nav header (HeaderShell auto-hides on /share/* paths)

const TABS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  "wayback",
  "wayback_classify",
] as const;
type Tab = (typeof TABS)[number];

export default function PublicSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const { t } = useT();
  const ts = t.pages.share;
  const tsDomain = t.pages.jobs.domain;

  const [data, setData] = useState<PublicShareDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("backlinks");

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicShare(token)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Pick the first criterion with rows so the recipient lands on
        // useful content (an empty backlinks tab on a wayback-only run
        // would look broken).
        const firstWithRows = TABS.find((c) => {
          const cd = d.criteria[c];
          const rows = (cd?.rows as unknown[] | undefined) ?? [];
          return Array.isArray(rows) && rows.length > 0;
        });
        const firstPresent = TABS.find((c) => d.criteria[c]);
        setTab(firstWithRows ?? firstPresent ?? "backlinks");
      })
      .catch((e: Error) => {
        if (!cancelled) {
          // Backend returns 404 for missing/revoked/expired — same
          // message for all so we can't be probed for token validity.
          setError(e.message || ts.notFound);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, ts.notFound]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-3">
        <h1 className="text-2xl font-semibold">{ts.notFoundTitle}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.notFound}
        </p>
      </div>
    );
  }
  if (data === null) {
    return (
      <div className="text-sm text-neutral-500 py-16 text-center">
        {t.common.loading}
      </div>
    );
  }

  const detail = data.criteria[tab] as
    | (Record<string, unknown> & {
        rows?: unknown[];
        ai_verdict?: Record<string, unknown> | null;
        ai_verdict_error?: string;
        status?: string;
      })
    | undefined;

  // Final assessment parsing — mirror the operator page's logic.
  const fa = data.final_assessment;
  const scoreRaw =
    (fa && (fa["final"] as unknown)) ?? (fa && (fa["score"] as unknown));
  const scoreNum = parseFinalScore(scoreRaw);
  const fromLabel =
    typeof fa?.assessment === "string" ? labelToBucket(fa.assessment as string) : null;
  const bucket = scoreNum != null ? scoreToBucket(scoreNum) : fromLabel;
  const conf =
    typeof fa?.confidence === "number" ? (fa.confidence as number) : null;
  // bannerToneWithConfidence handles the low-confidence override
  // internally via isLowConfidence(conf) — pass the raw number.
  const tone = bucket
    ? bannerToneWithConfidence(bucket, conf)
    : "bg-neutral-50 text-neutral-900 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-100 dark:border-neutral-800";

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-8 space-y-8">
      {/* Minimal "page chrome" so the recipient knows what they're
          looking at without seeing the operator's brand/nav. */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-neutral-500 dark:text-neutral-400">
        <span>{ts.viewOnlyBadge}</span>
        <span>
          {ts.sharedOn}{" "}
          {new Date(data.share.shared_at).toLocaleDateString()}
          {data.share.expires_at && (
            <>
              {" · "}
              {ts.expiresOn}{" "}
              {new Date(data.share.expires_at).toLocaleDateString()}
            </>
          )}
        </span>
      </div>

      <header className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold font-mono">{data.domain}</h1>
          <StatusPill status={data.status} />
        </div>
        {data.share.note && (
          <p className="text-sm text-neutral-700 dark:text-neutral-300 italic">
            “{data.share.note}”
          </p>
        )}
      </header>

      {/* Final assessment banner. Same tone palette as the operator
          page so the recipient sees the headline recommendation
          immediately. */}
      {fa && (
        <section
          className={`rounded-lg border-l-4 border p-4 space-y-2 ${tone}`}
        >
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg font-semibold">{ts.finalAssessment}</h2>
            {scoreNum != null && (
              <span className="px-2 py-0.5 rounded-md bg-white/70 dark:bg-black/30 text-sm font-mono">
                {formatScore(scoreNum)}
              </span>
            )}
            {typeof fa.assessment === "string" && (
              <span className="text-sm">
                <span className="opacity-70 mr-1">{ts.verdictLabel}:</span>
                <strong>{String(fa.assessment)}</strong>
              </span>
            )}
            {conf != null && (
              <span className="text-sm">
                <span className="opacity-70 mr-1">
                  {ts.confidenceLabel}:
                </span>
                <strong>{Math.round(conf * 100)}%</strong>
              </span>
            )}
          </div>
          {typeof fa.summary === "string" && fa.summary.trim() && (
            <p className="text-sm leading-relaxed">{String(fa.summary)}</p>
          )}
          {typeof fa.recommendation === "string" &&
            fa.recommendation.trim() && (
              <p className="text-sm leading-relaxed">
                <span className="opacity-70 mr-1">
                  {ts.recommendationLabel}:
                </span>
                {String(fa.recommendation)}
              </p>
            )}
        </section>
      )}

      {/* Criterion tabs */}
      <section className="space-y-4">
        <div
          role="tablist"
          className="flex flex-wrap gap-1 border-b dark:border-neutral-800"
        >
          {TABS.filter((c) => data.criteria[c]).map((c) => {
            const active = tab === c;
            return (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(c)}
                className={
                  "px-3 py-1.5 text-sm font-medium -mb-px border-b-2 transition-colors " +
                  (active
                    ? "border-blue-600 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100")
                }
              >
                {tsDomain.tabs[c] ?? c}
              </button>
            );
          })}
        </div>

        {detail && (
          <div className="space-y-4">
            {/* Per-criterion AI verdict. onReanalyze omitted = no
                button rendered → view-only. */}
            <VerdictBox
              verdict={
                (detail.ai_verdict as Parameters<
                  typeof VerdictBox
                >[0]["verdict"]) ?? null
              }
              error={(detail.ai_verdict_error as string) || ""}
              criterionLabel={tsDomain.tabs[tab] ?? tab}
            />
            {/* Wayback samples timeline (only for wayback tab). */}
            {tab === "wayback" && Array.isArray(detail.rows) && (
              <WaybackSamplesTimeline
                samples={
                  ((detail as Record<string, unknown>)[
                    "samples"
                  ] as WaybackSample[] | undefined) ?? extractWaybackSamples(detail)
                }
              />
            )}
            {/* Raw rows table — reuses the operator-side CriterionTable.
                Cast the loose dict back to the table's expected shape;
                the sanitized payload preserves all the fields the table
                reads (rows, status, error, fetched_at). request_url
                was stripped — the table renders an empty URL block,
                which is fine. */}
            <CriterionTable
              criterion={tab}
              detail={
                detail as unknown as Parameters<typeof CriterionTable>[0]["detail"]
              }
              viewOnly
            />
          </div>
        )}
      </section>

      {/* Read-only notes (only render when present). */}
      {data.note && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{ts.notesHeading}</h2>
          <div className="rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-4 text-sm whitespace-pre-wrap leading-relaxed">
            {data.note}
          </div>
        </section>
      )}

      <footer className="pt-8 border-t dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 text-center">
        {ts.footer}
      </footer>
    </div>
  );
}

// The wayback CR returns its sample blobs under different keys in the
// raw body depending on which fetcher produced them. Look in common
// spots so the timeline renders whether the share happens to have
// already-flattened `samples` or the original nested `raw.samples`.
function extractWaybackSamples(
  detail: Record<string, unknown>,
): WaybackSample[] {
  const raw = detail["raw"];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.samples)) return r.samples as WaybackSample[];
  }
  return [];
}
