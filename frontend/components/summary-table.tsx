"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, RunSummaryDomain, RunSummaryResponse } from "@/lib/api";
import {
  criterionPillTone,
  FinalBucket,
  formatScore,
  isLowConfidence,
  labelToBucket,
  pillToneWithConfidence,
} from "@/lib/score";

// Per-criterion columns shown BEFORE the final assessment. Wayback is
// rendered separately in its own column AFTER final, since it's an
// informational signal that doesn't (by default) tug the final score.
const CRITERIA_ORDER = ["backlinks", "refdomains", "anchors", "keywords"] as const;

function CriterionVerdictPill({
  value,
  confidence,
}: {
  value: string | null;
  confidence: number | null;
}) {
  if (!value) return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  const tone = criterionPillTone(value, confidence);
  const short = value.replace("_quality", "").replace("quality", "good");
  const titleSuffix =
    confidence != null
      ? ` · ${Math.round(confidence * 100)}% confidence${
          isLowConfidence(confidence) ? " (low — greyed)" : ""
        }`
      : "";
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
      title={`${value}${titleSuffix}`}
    >
      {short}
    </span>
  );
}

function isBucket(v: string): v is FinalBucket {
  return v === "good" || v === "mixed" || v === "low_quality";
}

function FinalPill({ d }: { d: RunSummaryDomain }) {
  if (d.final_partial) {
    return (
      <span
        className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
        title="Partial result — at least one criterion's AI verdict failed. Score not computed. Reanalyze to retry."
      >
        partial
      </span>
    );
  }
  const bucket: FinalBucket | null = isBucket(d.final_bucket)
    ? d.final_bucket
    : labelToBucket(d.final_summary);
  if (!bucket) {
    return (
      <span className="text-neutral-400 dark:text-neutral-600">—</span>
    );
  }
  const tone = pillToneWithConfidence(bucket, d.final_confidence);
  const display =
    d.final_score != null ? formatScore(d.final_score) : bucket;
  const titleSuffix =
    d.final_confidence != null
      ? ` · ${Math.round(d.final_confidence * 100)}% confidence${
          isLowConfidence(d.final_confidence) ? " (low — greyed)" : ""
        }`
      : "";
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
      title={
        d.final_score != null
          ? `Score ${display} · ${bucket}${titleSuffix}`
          : `${bucket}${titleSuffix}`
      }
    >
      {display}
    </span>
  );
}

export function SummaryTable({
  runId,
  jobId,
  terminal,
}: {
  runId: number;
  jobId: number;
  terminal: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.summaryTable;
  const [data, setData] = useState<RunSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const d = await api.getRunSummary(runId);
        if (alive) setData(d);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    tick();
    // Stop polling once the run is in terminal state and we've fetched once.
    if (terminal && data) return;
    const id = window.setInterval(tick, 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, terminal]);

  if (error) {
    return (
      <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <section className="rounded-md border border-dashed dark:border-neutral-700 p-6 space-y-2">
        <h2 className="text-lg font-semibold">{ts.heading}</h2>
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{ts.heading}</h2>
      <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">{ts.cols.domain}</th>
              {CRITERIA_ORDER.map((c) => (
                <th key={c} className="px-3 py-2 font-medium">
                  {ts.cols[c as keyof typeof ts.cols]}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">{ts.cols.final}</th>
              <th className="px-3 py-2 font-medium">{ts.cols.wayback}</th>
              <th className="px-3 py-2 w-1" />
            </tr>
          </thead>
          <tbody>
            {data.domains.map((d) => {
              const href = `/jobs/${jobId}/runs/${runId}/domains/${d.id}`;
              return (
                <tr
                  key={d.id}
                  className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={href}
                      className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {d.domain}
                    </Link>
                  </td>
                  {CRITERIA_ORDER.map((c) => {
                    const cell = d.criteria[c];
                    if (!cell) {
                      return (
                        <td key={c} className="px-3 py-2 text-neutral-400">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={c} className="px-3 py-2">
                        <CriterionVerdictPill
                          value={cell.ai_assessment}
                          confidence={cell.ai_confidence}
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2">
                    <FinalPill d={d} />
                  </td>
                  <td className="px-3 py-2">
                    {(() => {
                      const cell = d.criteria.wayback;
                      if (!cell) {
                        return (
                          <span className="text-neutral-400 dark:text-neutral-600">
                            —
                          </span>
                        );
                      }
                      return (
                        <CriterionVerdictPill
                          value={cell.ai_assessment}
                          confidence={cell.ai_confidence}
                        />
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={href}
                      className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 inline-block"
                    >
                      {ts.viewDetail}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
