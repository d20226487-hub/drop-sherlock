"use client";
import { useT } from "@/lib/i18n";
import {
  AHREFS_BATCH_METRICS,
  formatBatchMetric,
  RunDomainDetail,
} from "@/lib/api";

// Per-domain page for ahrefs_batch_analysis-kind runs (2026-06-02).
// Rendered INSTEAD of the Quality criterion tabs when
// `data.job_kind === 'ahrefs_batch_analysis'`.
//
// The runner writes one CriterionResult(criterion='ahrefs_batch_analysis')
// per domain with data_json `{ metrics: {field: value|null},
// http_status, error }`. We surface it as a simple metric → value table,
// ordered by the canonical metric list.

const LABELS: Record<string, string> = Object.fromEntries(
  AHREFS_BATCH_METRICS.map((m) => [m.id, m.label]),
);

type BatchRaw = {
  metrics?: Record<string, number | null>;
  http_status?: number;
  error?: string;
};

type BatchCriterionDetail = {
  status?: string;
  error?: string;
  raw?: BatchRaw | null;
};

export function AhrefsBatchAnalysisDomainView({
  data,
}: {
  data: RunDomainDetail;
}) {
  const { t } = useT();
  const ts = t.pages.ahrefsBatchDomain;
  const cr = (data.criteria as Record<string, BatchCriterionDetail>)?.[
    "ahrefs_batch_analysis"
  ];
  const raw = cr?.raw;
  const metrics = raw?.metrics ?? {};
  const fetchError = cr?.error || raw?.error || "";

  // Order rows by the canonical metric list; fall back to any extra keys
  // present in the payload (defensive — should match the spec).
  const ids = [
    ...AHREFS_BATCH_METRICS.map((m) => m.id).filter((id) => id in metrics),
    ...Object.keys(metrics).filter(
      (k) => !AHREFS_BATCH_METRICS.some((m) => m.id === k),
    ),
  ];

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
      <h2 className="text-lg font-semibold">{ts.heading}</h2>
      {fetchError && (
        <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300 whitespace-pre-wrap">
          {ts.errorPrefix}: {fetchError}
        </p>
      )}
      {ids.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {ts.noData}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 dark:bg-neutral-900/60 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">{ts.metric}</th>
                <th className="px-3 py-2 font-medium text-right">{ts.value}</th>
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => (
                <tr key={id} className="border-t dark:border-neutral-800">
                  <td className="px-3 py-2">{LABELS[id] ?? id}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatBatchMetric(id, metrics[id])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
