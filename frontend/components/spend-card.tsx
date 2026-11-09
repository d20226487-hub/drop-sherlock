"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import { api, SpendJobRow, SpendPeriod, SpendSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import { PaginationBottomBar, PaginationTopBar } from "@/components/pagination-bar";

// Dashboard ▸ Spend (added 2026-11-09). What the paid APIs cost, from the
// per-call spend log (backend app/spend.py): totals per API, by job, AI by
// provider + model, by feature, and the last 12 months; for a preset period
// or any month picked from the list. AI dollars are the
// price at call time, or — for calls made before their model had a price —
// an estimate at today's price, called out as such. Ahrefs dollars exist
// only per calendar month (an allowance, then $ per 1M units above it), so
// the 7-day / today views show Ahrefs units only.

const PERIODS: SpendPeriod[] = [
  "this_month",
  "last_month",
  "last_7_days",
  "today",
  "all_time",
];

export function fmtUsd(v: number | null | undefined): string {
  if (typeof v !== "number") return "—";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  const digits = abs < 0.01 ? 4 : 2;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
}

function Tile({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md border dark:border-neutral-800 px-3 py-2.5">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div
        className={
          "text-2xl font-bold tabular-nums " +
          (muted ? "text-neutral-400 dark:text-neutral-500" : "")
        }
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">{sub}</div>
      )}
    </div>
  );
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function fmtMonth(m: string): string {
  return new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

// The section's blocks (overview, by project, by job, by model / feature,
// by month) sit 50px apart (!mt overrides the parent's space-y-4).
const TH = "px-2 py-1.5 font-medium";
const TD = "px-2 py-1.5 tabular-nums";

export function SpendCard() {
  const { t } = useT();
  const ts = t.pages.spend;
  // A preset (SpendPeriod) or a month picked from the list, "2026-10".
  const [period, setPeriod] = useState<string>("this_month");
  const [months, setMonths] = useState<string[]>([]);
  const [data, setData] = useState<SpendSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.getSpendSummary(p);
      setData(next);
      setMonths(next.months_available);
    } catch (e) {
      setError((e as Error).message || "request failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [load, period]);

  const provider = (p: string) => ts.providerNames[p] ?? p;
  const feature = (f: string) => ts.features[f] ?? f;

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wallet className="w-4 h-4 text-neutral-500" />
            {ts.title}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{ts.intro}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-md border dark:border-neutral-700 overflow-hidden text-sm">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={
                  "px-2.5 py-1 border-l first:border-l-0 dark:border-neutral-700 " +
                  (p === period
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800")
                }
              >
                {ts.periods[p]}
              </button>
            ))}
          </div>
          <select
            value={MONTH_RE.test(period) ? period : ""}
            onChange={(e) => e.target.value && setPeriod(e.target.value)}
            aria-label={ts.monthPick}
            className={
              "text-sm rounded-md border px-2 py-1 bg-white dark:bg-neutral-900 " +
              (MONTH_RE.test(period)
                ? "border-neutral-900 dark:border-neutral-100 font-medium"
                : "dark:border-neutral-700")
            }
          >
            <option value="">{ts.monthPick}</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {fmtMonth(m)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => load(period)}
            disabled={busy}
            title={ts.refresh}
            aria-label={ts.refresh}
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-50 p-1"
          >
            <RefreshCw className={"w-4 h-4 " + (busy ? "animate-spin" : "")} />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}
      {!data && !error && <div className="text-sm text-neutral-500">{ts.loading}</div>}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
            <Tile label={ts.total} value={fmtUsd(data.total_usd)} />
            <Tile
              label={ts.kinds.ai}
              value={fmtUsd(data.ai.usd)}
              sub={ts.aiSub(
                data.ai.calls,
                fmtCount(data.ai.input_tokens + data.ai.output_tokens),
              )}
            />
            <Tile
              label={ts.kinds.ahrefs}
              value={data.ahrefs.usd === null ? fmtCount(data.ahrefs.units) : fmtUsd(data.ahrefs.usd)}
              muted={data.ahrefs.usd === null}
              sub={
                data.ahrefs.usd === null ? (
                  ts.ahrefsPerMonth
                ) : (
                  <>
                    {ts.ahrefsSub(fmtCount(data.ahrefs.units))}
                    {period === "this_month" && (
                      <div>
                        {ts.ahrefsAllowance(
                          fmtCount(data.ahrefs.this_month_units),
                          fmtCount(data.ahrefs.included_units),
                        )}
                      </div>
                    )}
                  </>
                )
              }
            />
            <Tile
              label={ts.kinds.whois_history}
              value={data.whois_history.priced ? fmtUsd(data.whois_history.usd) : "—"}
              muted={!data.whois_history.priced}
              sub={
                <>
                  {ts.creditsSub(data.whois_history.units)}
                  {!data.whois_history.priced && ` · ${ts.noPrice}`}
                </>
              }
            />
            <Tile
              label={ts.kinds.availability}
              value={data.availability.priced ? fmtUsd(data.availability.usd) : "—"}
              muted={!data.availability.priced}
              sub={
                <>
                  {ts.lookupsSub(data.availability.calls)}
                  {!data.availability.priced && ` · ${ts.noPrice}`}
                </>
              }
            />
          </div>

          {(data.ai.unpriced_calls > 0 || data.ai.estimated_usd > 0 || data.ai.failed_calls > 0) && (
            <div className="text-sm rounded-md px-3 py-2 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 space-y-1">
              {data.ai.unpriced_calls > 0 && (
                <p>
                  {ts.unpricedNote(data.ai.unpriced_calls)}{" "}
                  {data.unpriced_models
                    .map((m) => `${provider(m.provider)} ${m.model}`)
                    .join(", ")}
                  {" · "}
                  <Link href="/settings" className="underline">
                    {ts.setPrices}
                  </Link>
                </p>
              )}
              {data.ai.estimated_usd > 0 && <p>{ts.estimatedNote(fmtUsd(data.ai.estimated_usd))}</p>}
              {data.ai.failed_calls > 0 && <p>{ts.failedNote(data.ai.failed_calls)}</p>}
            </div>
          )}
          {data.backfill && data.backfill_calls > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.backfillNote(new Date(data.backfill.done_at).toLocaleDateString())}
            </p>
          )}

          {data.projects.some((p) => p.project_id !== null) && (
            <ProjectsTable
              rows={data.projects}
              monthAligned={data.ahrefs.usd !== null}
            />
          )}

          {data.jobs.length > 0 && (
            <JobsTable
              rows={data.jobs}
              monthAligned={data.ahrefs.usd !== null}
              whoisPriced={data.pricing.whoisfreaks_usd_per_credit > 0}
              availabilityPriced={
                data.pricing.whoisfreaks_usd_per_credit > 0 ||
                data.pricing.domainr_usd_per_request > 0
              }
            />
          )}

          {data.ai.calls === 0 && data.features.length === 0 ? (
            <p className="text-sm text-neutral-500">{ts.empty}</p>
          ) : (
            <div className="grid gap-x-5 gap-y-[50px] xl:grid-cols-2 !mt-[50px]">
              {data.ai_models.length > 0 && (
                <div className="space-y-1.5 overflow-x-auto">
                  <h3 className="text-sm font-semibold">{ts.byModel}</h3>
                  <table className="w-full text-sm">
                    <thead className="text-left text-neutral-500 border-b dark:border-neutral-800">
                      <tr>
                        <th className={TH}>{ts.cols.provider}</th>
                        <th className={TH}>{ts.cols.model}</th>
                        <th className={TH + " text-right"}>{ts.cols.calls}</th>
                        <th className={TH + " text-right"}>{ts.cols.input}</th>
                        <th className={TH + " text-right"} title={ts.outputHint}>
                          {ts.cols.output}
                        </th>
                        <th className={TH + " text-right"}>{ts.cols.cost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ai_models.map((m) => (
                        <tr
                          key={`${m.provider}|${m.model}`}
                          className="border-t border-neutral-100 dark:border-neutral-800/60"
                        >
                          <td className="px-2 py-1.5">{provider(m.provider)}</td>
                          <td className="px-2 py-1.5 font-mono text-xs">{m.model || "—"}</td>
                          <td className={TD + " text-right"}>{m.calls.toLocaleString()}</td>
                          <td className={TD + " text-right"}>{fmtCount(m.input_tokens)}</td>
                          <td className={TD + " text-right"} title={ts.outputHint}>
                            {fmtCount(m.output_tokens)}
                          </td>
                          <td className={TD + " text-right"}>
                            {m.unpriced_calls > 0 && m.usd === 0 ? (
                              <span className="text-amber-700 dark:text-amber-300">{ts.noPrice}</span>
                            ) : (
                              <span title={m.estimated_usd > 0 ? ts.estimated : undefined}>
                                {m.estimated_usd > 0 && "≈ "}
                                {fmtUsd(m.usd)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.features.length > 0 && (
                <div className="space-y-1.5 overflow-x-auto">
                  <h3 className="text-sm font-semibold">{ts.byFeature}</h3>
                  <table className="w-full text-sm">
                    <thead className="text-left text-neutral-500 border-b dark:border-neutral-800">
                      <tr>
                        <th className={TH}>{ts.cols.kind}</th>
                        <th className={TH}>{ts.cols.feature}</th>
                        <th className={TH + " text-right"}>{ts.cols.calls}</th>
                        <th className={TH + " text-right"}>{ts.cols.usage}</th>
                        <th className={TH + " text-right"}>{ts.cols.cost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.features.map((f) => (
                        <tr
                          key={`${f.kind}|${f.feature}`}
                          className="border-t border-neutral-100 dark:border-neutral-800/60"
                        >
                          <td className="px-2 py-1.5 text-neutral-500">{ts.kinds[f.kind] ?? f.kind}</td>
                          <td className="px-2 py-1.5">{feature(f.feature)}</td>
                          <td className={TD + " text-right"}>{f.calls.toLocaleString()}</td>
                          <td className={TD + " text-right text-neutral-600 dark:text-neutral-400"}>
                            {f.kind === "ai"
                              ? ts.tokensUnit(fmtCount(f.tokens))
                              : f.kind === "ahrefs"
                                ? ts.unitsUnit(fmtCount(f.units))
                                : f.kind === "whois_history"
                                  ? ts.creditsUnit(fmtCount(f.units))
                                  : ts.lookupsUnit(fmtCount(f.calls))}
                          </td>
                          <td className={TD + " text-right"}>
                            {f.kind === "ahrefs" ? (
                              <span className="text-neutral-400">—</span>
                            ) : f.unpriced_calls > 0 && f.usd === 0 ? (
                              <span className="text-amber-700 dark:text-amber-300">{ts.noPrice}</span>
                            ) : (
                              <span title={f.estimated_usd > 0 ? ts.estimated : undefined}>
                                {f.estimated_usd > 0 && "≈ "}
                                {fmtUsd(f.usd)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {data.months.length > 0 && (
            <div className="space-y-1.5 overflow-x-auto !mt-[50px]">
              <h3 className="text-sm font-semibold">{ts.byMonth}</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-neutral-500 border-b dark:border-neutral-800">
                  <tr>
                    <th className={TH}>{ts.cols.month}</th>
                    <th className={TH + " text-right"}>{ts.cols.ai}</th>
                    <th className={TH + " text-right"}>{ts.cols.ahrefsUnits}</th>
                    <th className={TH + " text-right"}>{ts.cols.ahrefs}</th>
                    <th className={TH + " text-right"}>{ts.cols.whois}</th>
                    <th className={TH + " text-right"}>{ts.cols.availability}</th>
                    <th className={TH + " text-right"}>{ts.cols.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month} className="border-t border-neutral-100 dark:border-neutral-800/60">
                      <td className="px-2 py-1.5">{m.month}</td>
                      <td className={TD + " text-right"}>{fmtUsd(m.ai_usd)}</td>
                      <td className={TD + " text-right text-neutral-600 dark:text-neutral-400"}>
                        {fmtCount(m.ahrefs_units)}
                      </td>
                      <td className={TD + " text-right"}>{fmtUsd(m.ahrefs_usd)}</td>
                      <td className={TD + " text-right"}>
                        {data.pricing.whoisfreaks_usd_per_credit > 0
                          ? fmtUsd(m.whois_history_usd)
                          : ts.creditsUnit(fmtCount(m.whois_history_credits))}
                      </td>
                      <td className={TD + " text-right"}>
                        {data.pricing.whoisfreaks_usd_per_credit > 0 ||
                        data.pricing.domainr_usd_per_request > 0
                          ? fmtUsd(m.availability_usd)
                          : ts.lookupsUnit(fmtCount(m.availability_calls))}
                      </td>
                      <td className={TD + " text-right font-semibold"}>{fmtUsd(m.total_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Search over what the row shows: job name or #id, project, sources.
function jobMatches(r: SpendJobRow, q: string): boolean {
  return [
    r.name ?? "",
    r.job_id !== null ? `#${r.job_id}` : "",
    r.project,
    ...r.sources.map((s) => s.source),
  ].some((v) => v.toLowerCase().includes(q));
}

// By-job table, right under the overview tiles: every job's spend in the
// period, most expensive first, 20 per page with search. A job's Ahrefs $
// is its share of each month's cost above the allowance, by its share of
// that month's units.
function JobsTable({
  rows,
  monthAligned,
  whoisPriced,
  availabilityPriced,
}: {
  rows: SpendJobRow[];
  monthAligned: boolean;
  whoisPriced: boolean;
  availabilityPriced: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.spend;
  const pages = usePaginatedSearch(rows, jobMatches);
  const dash = <span className="text-neutral-300 dark:text-neutral-600">—</span>;

  return (
    <div className="space-y-1.5 !mt-[50px]">
      <div className="flex items-baseline justify-between gap-x-4 gap-y-1 flex-wrap">
        <h3 className="text-sm font-semibold">{ts.byJob}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-3xl">{ts.byJobHint}</p>
      </div>
      <PaginationTopBar state={pages} searchPlaceholder={ts.jobSearch} />
      <div className="rounded-md border dark:border-neutral-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 bg-neutral-50 dark:bg-neutral-900/60 border-b dark:border-neutral-800">
            <tr>
              <th className={TH}>{ts.cols.job}</th>
              <th className={TH}>{ts.cols.project}</th>
              <th className={TH}>{ts.cols.source}</th>
              <th className={TH}>{ts.cols.type}</th>
              <th className={TH}>{ts.cols.dates}</th>
              <th className={TH + " text-right"}>{ts.cols.ai}</th>
              <th className={TH + " text-right"}>{ts.cols.ahrefsUnits}</th>
              <th className={TH + " text-right"} title={ts.byJobHint}>
                {ts.cols.ahrefsShare}
              </th>
              <th className={TH + " text-right"}>{ts.cols.whois}</th>
              <th className={TH + " text-right"}>{ts.cols.availability}</th>
              <th className={TH + " text-right"}>{ts.cols.total}</th>
            </tr>
          </thead>
          <tbody>
            {pages.paged.length === 0 && (
              <tr>
                <td colSpan={11} className="px-2 py-3 text-neutral-500">
                  {ts.noJobMatch}
                </td>
              </tr>
            )}
            {pages.paged.map((r) => (
              <tr
                key={String(r.job_id)}
                className="border-t border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
              >
                <td className="px-2 py-1.5 max-w-xs truncate">
                  {r.job_id === null ? (
                    <span className="text-neutral-500">{ts.noJob}</span>
                  ) : r.deleted ? (
                    <span className="text-neutral-500">{ts.deletedJob(r.job_id)}</span>
                  ) : (
                    <Link
                      href={`/jobs/${r.job_id}`}
                      className="text-blue-700 dark:text-blue-300 hover:underline"
                      title={r.name || ts.jobNum(r.job_id)}
                    >
                      {r.name || ts.jobNum(r.job_id)}
                    </Link>
                  )}
                </td>
                <td className="px-2 py-1.5 max-w-[12rem] truncate">
                  {r.project ? (
                    <>
                      {r.project}
                      {r.project_deleted && (
                        <span className="text-xs text-neutral-400"> ({ts.deletedProject})</span>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-400">{ts.noProject}</span>
                  )}
                </td>
                <td
                  className="px-2 py-1.5 max-w-[12rem] truncate"
                  title={
                    r.sources.length
                      ? ts.sourcesHint(
                          r.sources.map((s) => ts.sourceDomains(s.source, s.domains)).join(", "),
                        )
                      : undefined
                  }
                >
                  {r.sources.length === 0 ? (
                    dash
                  ) : (
                    <>
                      {r.sources[0].source}
                      {r.sources.length > 1 && (
                        <span className="ml-1 text-xs text-neutral-500">
                          {ts.moreSources(r.sources.length - 1)}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                  {r.job_kind ? ts.jobKinds[r.job_kind] ?? r.job_kind : ""}
                </td>
                <td className="px-2 py-1.5 text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                  {r.first_day === r.last_day
                    ? fmtDay(r.first_day)
                    : `${fmtDay(r.first_day)} – ${fmtDay(r.last_day)}`}
                </td>
                <td className={TD + " text-right"}>
                  {r.ai_calls ? (
                    <span title={r.ai_estimated ? ts.estimated : undefined}>
                      {r.ai_estimated && "≈ "}
                      {fmtUsd(r.ai_usd)}
                    </span>
                  ) : (
                    dash
                  )}
                </td>
                <td className={TD + " text-right text-neutral-600 dark:text-neutral-400"}>
                  {r.ahrefs_units ? fmtCount(r.ahrefs_units) : dash}
                </td>
                <td className={TD + " text-right"}>
                  {r.ahrefs_units && monthAligned ? fmtUsd(r.ahrefs_usd) : dash}
                </td>
                <td className={TD + " text-right"}>
                  {!r.whois_history_credits
                    ? dash
                    : whoisPriced
                      ? fmtUsd(r.whois_history_usd)
                      : ts.creditsUnit(fmtCount(r.whois_history_credits))}
                </td>
                <td className={TD + " text-right"}>
                  {!r.availability_calls
                    ? dash
                    : availabilityPriced
                      ? fmtUsd(r.availability_usd)
                      : ts.lookupsUnit(fmtCount(r.availability_calls))}
                </td>
                <td className={TD + " text-right font-semibold"}>{fmtUsd(r.total_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages.filteredTotal > 0 && <PaginationBottomBar state={pages} />}
    </div>
  );
}

// By-project table (2026-11-09): every project's spend in the period, the
// costliest first, "No project" (older jobs, Tools pages) last.
function ProjectsTable({
  rows,
  monthAligned,
}: {
  rows: SpendSummary["projects"];
  monthAligned: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.spend;
  return (
    <div className="space-y-1.5 !mt-[50px]">
      <h3 className="text-sm font-semibold">{ts.byProject}</h3>
      <div className="rounded-md border dark:border-neutral-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 bg-neutral-50 dark:bg-neutral-900/60 border-b dark:border-neutral-800">
            <tr>
              <th className={TH}>{ts.cols.project}</th>
              <th className={TH + " text-right"}>{ts.cols.jobs}</th>
              <th className={TH + " text-right"}>{ts.cols.ai}</th>
              <th className={TH + " text-right"}>{ts.cols.ahrefsUnits}</th>
              <th className={TH + " text-right"} title={ts.byJobHint}>
                {ts.cols.ahrefsShare}
              </th>
              <th className={TH + " text-right"}>{ts.cols.whois}</th>
              <th className={TH + " text-right"}>{ts.cols.availability}</th>
              <th className={TH + " text-right"}>{ts.cols.total}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={String(p.project_id)}
                className="border-t border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
              >
                <td className="px-2 py-1.5 font-medium">
                  {p.project_id === null ? (
                    <span className="font-normal text-neutral-500">{ts.noProject}</span>
                  ) : (
                    <>
                      {p.project}
                      {p.deleted && (
                        <span className="text-xs font-normal text-neutral-400"> ({ts.deletedProject})</span>
                      )}
                    </>
                  )}
                </td>
                <td className={TD + " text-right"}>{p.jobs ? p.jobs.toLocaleString() : "—"}</td>
                <td className={TD + " text-right"}>{fmtUsd(p.ai_usd)}</td>
                <td className={TD + " text-right text-neutral-600 dark:text-neutral-400"}>
                  {p.ahrefs_units ? fmtCount(p.ahrefs_units) : "—"}
                </td>
                <td className={TD + " text-right"}>
                  {monthAligned && p.ahrefs_units ? fmtUsd(p.ahrefs_usd) : "—"}
                </td>
                <td className={TD + " text-right"}>
                  {p.whois_history_credits ? fmtUsd(p.whois_history_usd) : "—"}
                </td>
                <td className={TD + " text-right"}>
                  {p.availability_calls ? fmtUsd(p.availability_usd) : "—"}
                </td>
                <td className={TD + " text-right font-semibold"}>{fmtUsd(p.total_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
