"use client";
import { useT } from "@/lib/i18n";
import { RunDomainDetail } from "@/lib/api";

// Per-domain page for availability-kind runs (Wave 3, 2026-05-15).
// Rendered INSTEAD of the Quality criterion tabs when
// `data.job_kind === 'availability'`.
//
// The cascade has one CriterionResult per rd:
//   • data_json: { verdict: {status, provider, registrar, expires_on},
//                  trace: [{provider, status, latency_ms, registrar,
//                           expires_on, error_message, error_category,
//                           checked_at}] }
//   • ai_verdict_json: empty (no AI on this pillar)
//
// Surface order: top verdict pill + summary → trace table.

type AvailabilityVerdict = {
  status?: string;
  provider?: string;
  registrar?: string;
  expires_on?: string | null;
};

type TraceRow = {
  provider?: string;
  status?: string;
  latency_ms?: number;
  registrar?: string;
  expires_on?: string;
  error_message?: string;
  error_category?: string;
  checked_at?: string;
};

type AvailabilityCriterionDetail = {
  status?: string;
  error?: string;
  raw?: {
    verdict?: AvailabilityVerdict;
    trace?: TraceRow[];
  } | null;
};

function statusTone(status?: string): string {
  if (status === "available")
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (status === "registered")
    return "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200";
  if (status === "not_supported")
    return "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200";
  if (status === "unknown")
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  if (status === "error")
    return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300";
}

// "not_supported" → "not supported" for display; everything else passes
// through unchanged (the trace shows raw provider statuses).
function statusLabel(status?: string): string {
  if (status === "not_supported") return "not supported";
  return status || "—";
}

export function AvailabilityDomainView({ data }: { data: RunDomainDetail }) {
  const { t } = useT();
  const ts = t.pages.availabilityDomain;
  const cr = (data.criteria as Record<string, AvailabilityCriterionDetail>)?.[
    "availability"
  ];
  const verdict = cr?.raw?.verdict;
  const trace = cr?.raw?.trace ?? [];
  const fetchError = cr?.error || "";

  return (
    <div className="space-y-6">
      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">{ts.verdictHeading}</h2>
          {verdict?.status && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${statusTone(
                verdict.status,
              )}`}
            >
              {statusLabel(verdict.status)}
            </span>
          )}
        </div>
        {fetchError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300 whitespace-pre-wrap">
            {ts.cascadeErrorPrefix}: {fetchError}
          </p>
        )}
        {verdict ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.resolvedBy}
              </dt>
              <dd className="font-mono">{verdict.provider || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.registrar}
              </dt>
              <dd>{verdict.registrar || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.expiresOn}
              </dt>
              <dd>{verdict.expires_on || "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {ts.noVerdict}
          </p>
        )}
      </section>

      <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-3">
        <h2 className="text-lg font-semibold">{ts.traceHeading}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.traceHint}
        </p>
        {trace.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {ts.traceEmpty}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 dark:bg-neutral-900/60 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">{ts.cols.provider}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.status}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.latency}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.registrar}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.expires}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.error}</th>
                  <th className="px-3 py-2 font-medium">{ts.cols.checkedAt}</th>
                </tr>
              </thead>
              <tbody>
                {trace.map((r, i) => (
                  <tr
                    key={`${r.provider}-${r.checked_at}-${i}`}
                    className="border-t dark:border-neutral-800"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.provider || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${statusTone(
                          r.status,
                        )}`}
                      >
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300">
                      {typeof r.latency_ms === "number"
                        ? `${r.latency_ms} ms`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
                      {r.registrar || (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
                      {r.expires_on || (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 max-w-[20rem]">
                      {r.error_message ? (
                        <span
                          className="break-words"
                          title={r.error_category || ""}
                        >
                          {r.error_message}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {r.checked_at
                        ? new Date(r.checked_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
