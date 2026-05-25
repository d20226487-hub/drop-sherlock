"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  JobDetail,
  RunSummaryResponse,
  RunSummaryDomain,
} from "@/lib/api";
import {
  FinalBucket,
  formatScore,
  isLowConfidence,
  labelToBucket,
  pillToneWithConfidence,
} from "@/lib/score";

// Canonical display order for the known quality-pillar criteria. Any
// criterion produced by a run but absent from this list (e.g. a future
// pillar) is appended after these in alphabetical order — the page itself
// derives the column set from what each run actually ran, not from this
// hardcoded order.
const CRITERIA_ORDER = ["backlinks", "refdomains", "anchors", "keywords", "wayback"] as const;

// A criterion "ran" in a run iff at least one domain has an entry for it
// in the criteria dict. Backend populates that dict from CriterionResult
// rows, which only exist for criteria the runner actually executed — so
// presence is a reliable "did this run run this criterion" signal.
function criteriaRanIn(run: RunSummaryResponse): Set<string> {
  const out = new Set<string>();
  for (const d of run.domains) {
    for (const key of Object.keys(d.criteria || {})) {
      out.add(key);
    }
  }
  return out;
}

// Intersection of `criteriaRanIn` for both runs, ordered: known criteria
// in their canonical order first, then any extras alphabetically. Used to
// drive both the header and the per-row cells so columns line up.
function sharedCriteria(
  runA: RunSummaryResponse,
  runB: RunSummaryResponse,
): string[] {
  const a = criteriaRanIn(runA);
  const b = criteriaRanIn(runB);
  const both = new Set<string>();
  a.forEach((k) => {
    if (b.has(k)) both.add(k);
  });
  const known = CRITERIA_ORDER.filter((k) => both.has(k));
  const extras = Array.from(both)
    .filter((k) => !(CRITERIA_ORDER as readonly string[]).includes(k))
    .sort();
  return [...known, ...extras];
}

export default function ComparePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <CompareInner jobId={parseInt(id, 10)} />
    </Suspense>
  );
}

function CompareInner({ jobId }: { jobId: number }) {
  const { t } = useT();
  const ts = t.pages.jobs.compare;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runA, setRunA] = useState<RunSummaryResponse | null>(null);
  const [runB, setRunB] = useState<RunSummaryResponse | null>(null);
  const [loadingPair, setLoadingPair] = useState(false);

  const aId = useMemo(() => {
    const v = searchParams.get("a");
    return v ? parseInt(v, 10) : null;
  }, [searchParams]);
  const bId = useMemo(() => {
    const v = searchParams.get("b");
    return v ? parseInt(v, 10) : null;
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    api
      .getJob(jobId)
      .then((d) => {
        if (cancelled) return;
        setJob(d);
        // Default to the latest two runs if no params provided.
        if ((aId === null || bId === null) && d.runs.length >= 2) {
          const params = new URLSearchParams(searchParams.toString());
          if (aId === null) params.set("a", String(d.runs[0].id));
          if (bId === null) params.set("b", String(d.runs[1].id));
          router.replace(`/jobs/${jobId}/compare?${params.toString()}`);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    if (aId === null || bId === null) return;
    let cancelled = false;
    setLoadingPair(true);
    Promise.all([api.getRunSummary(aId), api.getRunSummary(bId)])
      .then(([a, b]) => {
        if (cancelled) return;
        setRunA(a);
        setRunB(b);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingPair(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  function setRun(side: "a" | "b", runId: number) {
    const p = new URLSearchParams(searchParams.toString());
    p.set(side, String(runId));
    router.replace(`/jobs/${jobId}/compare?${p.toString()}`);
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          href={`/jobs/${jobId}`}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          {ts.backLink}
        </Link>
        <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }
  if (!job) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }
  if (job.runs.length < 2) {
    return (
      <div className="space-y-4">
        <Link
          href={`/jobs/${jobId}`}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          {ts.backLink}
        </Link>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.notEnoughRuns}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/jobs/${jobId}`}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.backLink}
      </Link>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {ts.title(job.name || `Job #${job.id}`)}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.intro}
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <RunPicker
          label={ts.runA}
          jobRuns={job.runs}
          value={aId}
          otherValue={bId}
          onChange={(id) => setRun("a", id)}
        />
        <RunPicker
          label={ts.runB}
          jobRuns={job.runs}
          value={bId}
          otherValue={aId}
          onChange={(id) => setRun("b", id)}
        />
      </section>

      {loadingPair && !runA && !runB && (
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      )}

      {runA && runB && (
        <CompareTable
          jobId={jobId}
          runA={runA}
          runB={runB}
        />
      )}
    </div>
  );
}

function RunPicker({
  label,
  jobRuns,
  value,
  otherValue,
  onChange,
}: {
  label: string;
  jobRuns: { id: number; name: string; status: string; finished_at: string | null }[];
  value: number | null;
  otherValue: number | null;
  onChange: (runId: number) => void;
}) {
  const { t } = useT();
  const runLabel = t.pages.jobs.detail.runLabel;
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
      >
        {value === null && <option value="">—</option>}
        {jobRuns.map((r) => (
          <option key={r.id} value={r.id} disabled={r.id === otherValue}>
            {runLabel(r.id, r.name)} · {r.status}
            {r.finished_at ? ` · ${new Date(r.finished_at).toLocaleString()}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

// Per-criterion verdicts come straight from the criterion judges and still
// use "high_quality"/"mixed"/"low_quality" labels — keep the original pill
// for those columns.
const VERDICT_TONE: Record<string, string> = {
  high_quality: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  low_quality: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  quality: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

function VerdictPill({ value }: { value: string | null }) {
  if (!value) return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  const tone =
    VERDICT_TONE[value] ||
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  const short = value.replace("_quality", "").replace("quality", "good");
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${tone}`} title={value}>
      {short}
    </span>
  );
}

// Tone map for the 4 whois bands. Mirrors the Database page so the
// vocabulary is consistent across pages: dropped = red, mixed = amber,
// insufficient = neutral-grey (signal too thin), stable = green.
const WHOIS_BAND_TONE: Record<string, string> = {
  dropped: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  insufficient:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  stable:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

function WhoisCell({
  band,
  cycles,
  summary,
}: {
  band: string | undefined;
  cycles: number | null | undefined;
  summary: string | undefined;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.compare;
  const bandLabels = ts.whoisBand as unknown as Record<string, string>;
  if (!band) {
    return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  }
  const tone =
    WHOIS_BAND_TONE[band] ||
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  const label = bandLabels[band] ?? band;
  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      <span
        className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
        title={summary || label}
      >
        {label}
      </span>
      {typeof cycles === "number" && cycles > 1 && (
        <span
          className="text-[10px] text-neutral-600 dark:text-neutral-400"
          title={summary || undefined}
        >
          {ts.whoisCycles(cycles)}
        </span>
      )}
    </div>
  );
}

// Neutral text chip for wayback_classify outputs (category, theme). These
// aren't quality verdicts — they're free-form / user-defined strings — so
// they get a neutral tone, no semantic color coding. Wraps long themes
// gracefully and shows the full value on hover.
function TextChip({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      title={value}
    >
      {value}
    </span>
  );
}

// Final-assessment pill: score-aware. Numeric scores get rendered as a
// percentage with bucket tone; the pill greys out when the AI's confidence
// in its sub-verdicts was too low to trust the aggregate.
function FinalCompareCell({
  value,
}: {
  value: {
    final_summary: string | null;
    final_score: number | null;
    final_confidence: number | null;
    final_bucket: string;
  } | null;
}) {
  if (!value) return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  const bucket: FinalBucket | null =
    value.final_bucket === "good" ||
    value.final_bucket === "mixed" ||
    value.final_bucket === "low_quality"
      ? value.final_bucket
      : labelToBucket(value.final_summary);
  if (!bucket) {
    return <span className="text-neutral-400 dark:text-neutral-600">—</span>;
  }
  const tone = pillToneWithConfidence(bucket, value.final_confidence);
  const display =
    value.final_score != null ? formatScore(value.final_score) : bucket;
  const titleSuffix =
    value.final_confidence != null
      ? ` · ${Math.round(value.final_confidence * 100)}% confidence${
          isLowConfidence(value.final_confidence) ? " (low — greyed)" : ""
        }`
      : "";
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
      title={
        value.final_score != null
          ? `Score ${display} · ${bucket}${titleSuffix}`
          : `${bucket}${titleSuffix}`
      }
    >
      {display}
    </span>
  );
}

function CompareTable({
  jobId,
  runA,
  runB,
}: {
  jobId: number;
  runA: RunSummaryResponse;
  runB: RunSummaryResponse;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.compare;
  const runLabel = t.pages.jobs.detail.runLabel;
  // Resolve user-facing labels for the two runs once. Falls back to
  // "Run #N" when the user hasn't named the run.
  const aLabel = runLabel(runA.run_id, runA.name);
  const bLabel = runLabel(runB.run_id, runB.name);

  // Columns to show: criteria that ran in BOTH runs (intersection). Excludes
  // criteria only one side ran — those would be all-dashes on the empty side
  // and add noise to the diff view.
  const visibleCriteria = useMemo(
    () => sharedCriteria(runA, runB),
    [runA, runB],
  );
  // Theme is a derived column attached to wayback_classify — only render
  // when both runs actually ran classify. The runner emits `theme` on the
  // classify CR's summary entry; backend surfaces it via get_run_summary.
  const showThemeColumn = visibleCriteria.includes("wayback_classify");
  // Friendly labels. i18n only has entries for the 5 quality criteria —
  // for `wayback_classify` use the existing "Classify" string from the
  // backlog/analyze cards; for `theme` use a dedicated key. Unknown
  // criteria fall back to the raw key.
  const colLabel = (key: string): string => {
    const known = ts.cols as unknown as Record<string, string>;
    if (key === "wayback_classify") {
      return known.wayback_classify ?? "Classify";
    }
    if (key === "whois_history") {
      return known.whois_history ?? "Whois";
    }
    return known[key] ?? key;
  };
  const themeLabel = (ts.cols as unknown as Record<string, string>).theme ?? "Theme";

  // Pair domains by name. A domain may exist in only one run (e.g. user
  // changed the domain list between runs); show those rows with a missing
  // marker on the empty side.
  const byDomainA = new Map(runA.domains.map((d) => [d.domain, d]));
  const byDomainB = new Map(runB.domains.map((d) => [d.domain, d]));
  const allDomains = Array.from(
    new Set([...byDomainA.keys(), ...byDomainB.keys()]),
  ).sort();

  return (
    <section className="space-y-3">
      <Legend aLabel={aLabel} bLabel={bLabel} />
      <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
            <tr>
              <th rowSpan={2} className="px-3 py-2 font-medium align-bottom">
                {ts.cols.domain}
              </th>
              {visibleCriteria.flatMap((c) => {
                // For wayback_classify, render its own column AND a
                // sibling "Theme" column right after it — keeps both
                // pieces of the classify verdict adjacent in the table.
                const cells = [
                  <th
                    key={c}
                    colSpan={2}
                    className="px-3 py-2 font-medium border-l dark:border-neutral-800 text-center"
                  >
                    {colLabel(c)}
                  </th>,
                ];
                if (c === "wayback_classify") {
                  cells.push(
                    <th
                      key={`${c}-theme`}
                      colSpan={2}
                      className="px-3 py-2 font-medium border-l dark:border-neutral-800 text-center"
                    >
                      {themeLabel}
                    </th>,
                  );
                }
                return cells;
              })}
              <th
                colSpan={2}
                className="px-3 py-2 font-medium border-l dark:border-neutral-800 text-center"
              >
                {ts.cols.final}
              </th>
            </tr>
            <tr className="text-xs text-neutral-500">
              {visibleCriteria.flatMap((c) => {
                const cells = [
                  <th
                    key={`${c}-A`}
                    className="px-2 py-1 font-normal border-l dark:border-neutral-800"
                    title={aLabel}
                  >
                    {aLabel}
                  </th>,
                  <th
                    key={`${c}-B`}
                    className="px-2 py-1 font-normal"
                    title={bLabel}
                  >
                    {bLabel}
                  </th>,
                ];
                if (c === "wayback_classify") {
                  cells.push(
                    <th
                      key={`${c}-theme-A`}
                      className="px-2 py-1 font-normal border-l dark:border-neutral-800"
                      title={aLabel}
                    >
                      {aLabel}
                    </th>,
                    <th
                      key={`${c}-theme-B`}
                      className="px-2 py-1 font-normal"
                      title={bLabel}
                    >
                      {bLabel}
                    </th>,
                  );
                }
                return cells;
              })}
              <th
                className="px-2 py-1 font-normal border-l dark:border-neutral-800"
                title={aLabel}
              >
                {aLabel}
              </th>
              <th className="px-2 py-1 font-normal" title={bLabel}>
                {bLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {allDomains.map((domain) => {
              const a = byDomainA.get(domain) || null;
              const b = byDomainB.get(domain) || null;
              return (
                <CompareRow
                  key={domain}
                  domain={domain}
                  a={a}
                  b={b}
                  jobId={jobId}
                  runAId={runA.run_id}
                  runBId={runB.run_id}
                  aLabel={aLabel}
                  bLabel={bLabel}
                  visibleCriteria={visibleCriteria}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {visibleCriteria.length === 0 && (
        <p className="text-xs text-neutral-500 italic">
          {ts.noSharedCriteria ??
            "No criteria were run by both runs — only the Final column applies."}
        </p>
      )}
    </section>
  );
}

function Legend({ aLabel, bLabel }: { aLabel: string; bLabel: string }) {
  const { t } = useT();
  const ts = t.pages.jobs.compare;
  return (
    <div className="flex flex-wrap gap-3 text-xs text-neutral-600 dark:text-neutral-400">
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded bg-amber-200 dark:bg-amber-800/60" />
        {ts.legendDiff}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded bg-neutral-200 dark:bg-neutral-700" />
        {ts.legendSame}
      </span>
      <span className="inline-flex items-center gap-1.5 ml-2">
        {ts.legendOnlyA}: <em>{aLabel}</em> only
      </span>
      <span className="inline-flex items-center gap-1.5">
        {ts.legendOnlyB}: <em>{bLabel}</em> only
      </span>
    </div>
  );
}

function CompareRow({
  domain,
  a,
  b,
  jobId,
  runAId,
  runBId,
  aLabel,
  bLabel,
  visibleCriteria,
}: {
  domain: string;
  a: RunSummaryDomain | null;
  b: RunSummaryDomain | null;
  jobId: number;
  runAId: number;
  runBId: number;
  aLabel: string;
  bLabel: string;
  visibleCriteria: string[];
}) {
  const aOnly = a && !b;
  const bOnly = !a && b;
  const both = a && b;
  return (
    <tr className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/60">
      <td className="px-3 py-2">
        <div className="font-mono text-xs">{domain}</div>
        <div className="text-[10px] text-neutral-500 mt-0.5 flex gap-2">
          {a && (
            <Link
              href={`/jobs/${jobId}/runs/${runAId}/domains/${a.id}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
              title={aLabel}
            >
              Open {aLabel}
            </Link>
          )}
          {b && (
            <Link
              href={`/jobs/${jobId}/runs/${runBId}/domains/${b.id}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
              title={bLabel}
            >
              Open {bLabel}
            </Link>
          )}
        </div>
      </td>
      {visibleCriteria.flatMap((c) => {
        // wayback_classify carries non-quality outputs (category + theme),
        // not the high_quality/mixed/low_quality assessment. Render its
        // category in the criterion column and the theme in an adjacent
        // column pair.
        if (c === "wayback_classify") {
          const aCat = a?.criteria[c]?.category ?? "";
          const bCat = b?.criteria[c]?.category ?? "";
          const catDiff = both && aCat !== bCat
            ? "bg-amber-50 dark:bg-amber-900/10"
            : "";
          const aTheme = a?.criteria[c]?.theme ?? "";
          const bTheme = b?.criteria[c]?.theme ?? "";
          const themeDiff = both && aTheme !== bTheme
            ? "bg-amber-50 dark:bg-amber-900/10"
            : "";
          return [
            <td
              key={`${c}-A`}
              className={`px-2 py-2 border-l dark:border-neutral-800 ${catDiff}`}
            >
              <TextChip value={aCat} />
            </td>,
            <td key={`${c}-B`} className={`px-2 py-2 ${catDiff}`}>
              <TextChip value={bCat} />
            </td>,
            <td
              key={`${c}-theme-A`}
              className={`px-2 py-2 border-l dark:border-neutral-800 ${themeDiff}`}
            >
              <TextChip value={aTheme} />
            </td>,
            <td key={`${c}-theme-B`} className={`px-2 py-2 ${themeDiff}`}>
              <TextChip value={bTheme} />
            </td>,
          ];
        }
        // whois_history has no `ai_assessment` — its verdict is encoded
        // as `band` (derived from dropped_confidence on the backend) plus
        // `ownership_cycles` for the drop count. Compare across runs by
        // band; cycles count comes along but doesn't drive the diff
        // shade (a re-judge might shift dropped_confidence across band
        // boundaries without changing the underlying cycle count).
        if (c === "whois_history") {
          const aWh = a?.criteria[c];
          const bWh = b?.criteria[c];
          const aBand = aWh?.band ?? "";
          const bBand = bWh?.band ?? "";
          const diffShade = both && aBand !== bBand
            ? "bg-amber-50 dark:bg-amber-900/10"
            : "";
          return [
            <td
              key={`${c}-A`}
              className={`px-2 py-2 border-l dark:border-neutral-800 ${diffShade}`}
            >
              <WhoisCell
                band={aBand}
                cycles={aWh?.ownership_cycles}
                summary={aWh?.summary}
              />
            </td>,
            <td key={`${c}-B`} className={`px-2 py-2 ${diffShade}`}>
              <WhoisCell
                band={bBand}
                cycles={bWh?.ownership_cycles}
                summary={bWh?.summary}
              />
            </td>,
          ];
        }
        const aVal = a?.criteria[c]?.ai_assessment ?? null;
        const bVal = b?.criteria[c]?.ai_assessment ?? null;
        const diffShade = both && aVal !== bVal
          ? "bg-amber-50 dark:bg-amber-900/10"
          : "";
        return [
          <td
            key={`${c}-A`}
            className={`px-2 py-2 border-l dark:border-neutral-800 ${diffShade}`}
          >
            <VerdictPill value={aVal} />
          </td>,
          <td key={`${c}-B`} className={`px-2 py-2 ${diffShade}`}>
            <VerdictPill value={bVal} />
          </td>,
        ];
      })}
      {(() => {
        // Compare via the normalized bucket so a 78% (mixed) and a "mixed"
        // text label don't get flagged as a difference.
        const aBucket = a?.final_bucket || labelToBucket(a?.final_summary ?? null) || "";
        const bBucket = b?.final_bucket || labelToBucket(b?.final_summary ?? null) || "";
        const diffShade = both && aBucket !== bBucket
          ? "bg-amber-50 dark:bg-amber-900/10"
          : "";
        return (
          <>
            <td
              className={`px-2 py-2 border-l dark:border-neutral-800 ${diffShade}`}
            >
              <FinalCompareCell value={a} />
            </td>
            <td className={`px-2 py-2 ${diffShade}`}>
              <FinalCompareCell value={b} />
            </td>
          </>
        );
      })()}
      {(aOnly || bOnly) && (
        <td className="px-2 py-2 text-xs text-neutral-500 italic">
          {aOnly ? `only in ${aLabel}` : `only in ${bLabel}`}
        </td>
      )}
    </tr>
  );
}
