"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, type JobDetail, type RunSummary } from "@/lib/api";
import { StatusPill } from "@/components/status-pill";
import { bucketPillTone, FinalBucket } from "@/lib/score";
import { usePaginatedSearch } from "@/lib/use-paginated-search";
import {
  PaginationBottomBar,
  PaginationTopBar,
} from "@/components/pagination-bar";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const jobId = parseInt(id, 10);
  // Next.js static segments (whois-history, quality, availability, etc.)
  // sit at the same depth as this dynamic `[id]` route. When the user
  // navigates back from /jobs/<numericId> to /jobs/<staticSlug>, the
  // browser sometimes briefly re-renders this component with the new
  // path's id value before the route swap completes — at that moment
  // `id` is e.g. "whois-history" and `parseInt` yields NaN. Without a
  // guard, the polling useEffect fires `api.getJob(NaN)` and the
  // backend rejects with 422. Treat non-finite jobIds as "no job" —
  // the static handler will take over a moment later anyway.
  const jobIdValid = Number.isFinite(jobId);
  const { t } = useT();
  const ts = t.pages.jobs.detail;
  const router = useRouter();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function reload() {
    if (!jobIdValid) return;
    try {
      const d = await api.getJob(jobId);
      setJob(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!jobIdValid) return;
    reload();
    // Poll while any run is non-terminal so the user sees live progress
    // without manual refresh. Polling the job-detail endpoint is cheap.
    const id = window.setInterval(() => {
      reload();
    }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobIdValid]);

  async function rename() {
    if (!job) return;
    const next = window.prompt(ts.renamePrompt, job.name);
    if (!next || next.trim() === job.name) return;
    setBusy("rename");
    try {
      await api.patchJob(jobId, { name: next.trim() });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function deleteJob() {
    if (!job) return;
    if (!window.confirm(ts.deleteConfirm(job.name || `Job #${job.id}`))) return;
    setBusy("delete");
    try {
      await api.deleteJob(jobId);
      router.push("/jobs");
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (!job) return;
    setBusy("archive");
    try {
      if (job.archived_at) {
        await api.unarchiveJob(jobId);
      } else {
        await api.archiveJob(jobId);
      }
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function cancelRun(runId: number) {
    if (!window.confirm(ts.cancelConfirm)) return;
    try {
      await api.cancelRun(runId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pauseRun(runId: number) {
    try {
      await api.pauseRun(runId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resumeRun(runId: number) {
    try {
      await api.resumeRun(runId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteRun(runId: number, total: number) {
    if (!window.confirm(ts.deleteRunConfirm(runId, total))) return;
    try {
      await api.deleteRun(runId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function renameRun(runId: number, currentName: string) {
    const next = window.prompt(ts.renameRunPrompt(runId), currentName ?? "");
    if (next === null) return;
    try {
      await api.patchRun(runId, { name: next });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Per-job Run pin (added 2026-05-10). Toggles the canonical run for
  // this job's L/M/H rollup pills. Only `done` runs are pinnable
  // (backend enforces; the button is also disabled in the UI for non-
  // done runs). Pinning a different run silently replaces the previous
  // pin in the same job — backend handles that in one transaction.
  async function togglePinRun(runId: number, isPinned: boolean) {
    try {
      if (isPinned) {
        await api.unpinRun(runId);
      } else {
        await api.pinRun(runId);
      }
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startNotesEdit() {
    if (!job) return;
    setNotesDraft(job.notes);
    setEditingNotes(true);
  }

  async function saveNotes() {
    setBusy("notes");
    try {
      await api.patchJob(jobId, { notes: notesDraft });
      await reload();
      setEditingNotes(false);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        {/* Error branch: job didn't load, so we don't know its kind.
            Fall back to /jobs/quality (the default pillar) — the old
            /jobs path redirects there anyway. */}
        <Link
          href="/jobs/quality"
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

  if (job === null) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }

  // Per-pillar back link (Wave 1, 2026-05-15) — point the user back at
  // the list page that matches THIS job's kind, not the legacy /jobs
  // path. Fallback to 'quality' for any row whose kind didn't backfill.
  const backHref = `/jobs/${job.kind || "quality"}`;

  return (
    <div className="space-y-6">
      <Link
        href={backHref}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.backLink}
      </Link>

      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">
              {job.name || `Job #${job.id}`}
            </h1>
            <VerdictRollupPills
              counts={job.latest_run_verdict_counts}
              sourceRunId={job.latest_run_id}
              pinnedRunId={job.pinned_run_id ?? null}
              jobKind={job.kind || "quality"}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/analyze?rerun=${jobId}`}
              className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
            >
              {ts.rerun}
            </Link>
            {job.runs.length >= 2 && (
              <Link
                href={`/jobs/${jobId}/compare`}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {ts.compareRuns}
              </Link>
            )}
            <button
              onClick={rename}
              disabled={busy !== null}
              className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {ts.rename}
            </button>
            <button
              onClick={toggleArchive}
              disabled={busy !== null}
              className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy === "archive"
                ? t.common.loading
                : job.archived_at
                  ? ts.unarchive
                  : ts.archive}
            </button>
            {/* Per-Job export — bundles Job + Runs + RunDomains +
                CriterionResults + JobCriterionPins into one gzip JSON
                file the user can import on another server (e.g. move
                analysis from local to deploy without touching the
                colleagues' Database/Backlog state). Native <a download>
                handles the streaming response; no fetch+Blob needed. */}
            <a
              href={api.exportJobUrl(jobId)}
              download
              className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              Export
            </a>
            <button
              onClick={deleteJob}
              disabled={busy !== null}
              className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              {busy === "delete" ? t.common.loading : ts.delete}
            </button>
          </div>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.meta(formatDate(job.created_at), formatDate(job.updated_at))}
        </p>
      </header>

      {job.archived_at && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          {ts.archivedBanner}
        </div>
      )}

      <section className="rounded-md border dark:border-neutral-800 p-4 bg-white dark:bg-neutral-900 space-y-2">
        {!editingNotes && (
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">
              {job.notes || (
                <span className="text-neutral-400 dark:text-neutral-500">
                  {ts.notesEmpty}
                </span>
              )}
            </div>
            <button
              onClick={startNotesEdit}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
            >
              {ts.editNotes}
            </button>
          </div>
        )}
        {editingNotes && (
          <div className="space-y-2">
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder={ts.notesPlaceholder}
              className="w-full min-h-[100px] rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <div className="flex gap-2">
              <button
                onClick={saveNotes}
                disabled={busy === "notes"}
                className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {busy === "notes" ? t.common.loading : ts.saveNotes}
              </button>
              <button
                onClick={() => setEditingNotes(false)}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {ts.cancelEdit}
              </button>
            </div>
          </div>
        )}
      </section>

      <JobPinsPanel jobId={jobId} />

      <RunsSection
        runs={job.runs}
        jobId={jobId}
        onCancel={cancelRun}
        onPause={pauseRun}
        onResume={resumeRun}
        onDelete={deleteRun}
        onRename={renameRun}
        onTogglePin={togglePinRun}
      />
    </div>
  );
}

// Read-only Job-level pin view (added 2026-05-14). Read-only by design:
// pin management still happens on the Run page's Per-criterion pins
// panel. This widget is the missing surface that says, at a glance,
// "for THIS Job: which Run feeds which criterion?". Empty state when
// no pins have been set yet.
function JobPinsPanel({ jobId }: { jobId: number }) {
  const { t } = useT();
  const ts = t.pages.jobs.detail;

  const CRITERIA_ORDER = [
    "backlinks",
    "refdomains",
    "anchors",
    "keywords",
    "wayback",
    "wayback_classify",
    "whois_history",
    "availability",
  ] as const;
  const LETTERS: Record<string, string> = {
    backlinks: "B",
    refdomains: "D",
    anchors: "A",
    keywords: "K",
    wayback: "W",
    wayback_classify: "C",
    whois_history: "H",
    availability: "V",
  };

  const [pins, setPins] = useState<
    {
      criterion: string;
      run_id: number;
      run_name: string;
      run_finished_at: string | null;
    }[]
  >([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listJobCriterionPins(jobId)
      .then((r) => {
        if (!cancelled) {
          setPins(r.pins);
          setLoaded(true);
        }
      })
      .catch(() => {
        // Non-fatal — empty state covers it.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Build a (criterion → pin) lookup so we can render the canonical
  // criterion order, gaps included. Gaps = "not pinned" (read from
  // most-recent Run by default on the Database page).
  const byCriterion = new Map(pins.map((p) => [p.criterion, p]));
  const pinnedCount = pins.length;

  return (
    <section className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 space-y-2 bg-neutral-50/50 dark:bg-neutral-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-2 justify-between text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-md"
      >
        <div className="flex items-start gap-2">
          <span
            className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 select-none"
            aria-hidden
          >
            {open ? "▾" : "▸"}
          </span>
          <div>
            <div className="text-sm font-medium">{ts.pinsHeading}</div>
            {open && (
              <div className="text-xs text-neutral-600 dark:text-neutral-400 max-w-2xl">
                {ts.pinsHint}
              </div>
            )}
          </div>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-md border border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          {ts.pinsBadge(pinnedCount, CRITERIA_ORDER.length)}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {CRITERIA_ORDER.map((c) => {
            const p = byCriterion.get(c);
            return (
              <div
                key={c}
                className={
                  "flex flex-col gap-1 rounded-md border p-2 text-xs " +
                  (p
                    ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30"
                    : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900")
                }
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    <span className="inline-block w-5 text-center rounded bg-neutral-200 dark:bg-neutral-800 mr-1">
                      {LETTERS[c] ?? c[0]?.toUpperCase()}
                    </span>
                    {c}
                  </span>
                </div>
                {p ? (
                  <Link
                    href={`/jobs/${jobId}/runs/${p.run_id}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Run #{p.run_id}
                    {p.run_name ? ` · ${p.run_name}` : ""}
                  </Link>
                ) : (
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {ts.pinsUnpinned}
                  </span>
                )}
              </div>
            );
          })}
          {!loaded && pins.length === 0 && (
            <div className="col-span-full text-xs text-neutral-500">…</div>
          )}
        </div>
      )}
    </section>
  );
}

function RunsSection({
  runs,
  jobId,
  onCancel,
  onPause,
  onResume,
  onDelete,
  onRename,
  onTogglePin,
}: {
  runs: RunSummary[];
  jobId: number;
  onCancel: (runId: number) => void;
  onPause: (runId: number) => void;
  onResume: (runId: number) => void;
  onDelete: (runId: number, total: number) => void;
  onRename: (runId: number, currentName: string) => void;
  onTogglePin: (runId: number, isPinned: boolean) => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.detail;
  const search = usePaginatedSearch<RunSummary>(runs, () => true);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{ts.runsHeading}</h2>
      {runs.length === 0 && (
        <p className="text-sm text-neutral-500">{ts.noRuns}</p>
      )}
      {runs.length > 0 && (
        <>
          <PaginationTopBar state={search} searchable={false} />
          <div className="space-y-2">
            {search.paged.map((r) => (
              <RunSummaryRow
                key={r.id}
                jobId={jobId}
                run={r}
                onCancel={onCancel}
                onPause={onPause}
                onResume={onResume}
                onDelete={onDelete}
                onRename={onRename}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
          <PaginationBottomBar state={search} />
        </>
      )}
    </section>
  );
}

function RunSummaryRow({
  jobId,
  run,
  onCancel,
  onPause,
  onResume,
  onDelete,
  onRename,
  onTogglePin,
}: {
  jobId: number;
  run: RunSummary;
  onCancel: (runId: number) => void;
  onPause: (runId: number) => void;
  onResume: (runId: number) => void;
  onDelete: (runId: number, total: number) => void;
  onRename: (runId: number, currentName: string) => void;
  onTogglePin: (runId: number, isPinned: boolean) => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.detail;
  // Pin button is enabled only for `done` runs (backend enforces too —
  // pinning a still-running run would expose unstable counts to the
  // rollup pills). Already-pinned runs always show the button (so the
  // user can unpin) regardless of status, in case the run later moves
  // out of `done` (re-running etc.) — backend lets you unpin anytime.
  const pinAvailable = run.status === "done" || run.is_pinned === true;
  const total = run.total_domains;
  const done = run.done_domains;
  const failed = run.failed_domains;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  // The whole row is a Link; we use a stop-propagation onClick on the Cancel
  // button so clicking it doesn't navigate into the run.
  return (
    <Link
      href={`/jobs/${jobId}/runs/${run.id}`}
      className={
        "block rounded-md border bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-800/60 p-3 " +
        (run.is_pinned
          ? "border-amber-400 dark:border-amber-700 ring-1 ring-amber-300/60 dark:ring-amber-700/40"
          : "border-neutral-200 dark:border-neutral-800")
      }
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-medium">{ts.runLabel(run.id, run.name)}</span>
        <StatusPill status={run.status} />
        {run.is_pinned && (
          <span
            className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 inline-flex items-center gap-1"
            title={ts.runPinnedHint}
          >
            <span aria-hidden="true">📌</span>
            {ts.runPinnedBadge}
          </span>
        )}
        <span className="text-sm text-neutral-600 dark:text-neutral-400">
          {ts.progress(done, total, failed)}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-500 ml-auto whitespace-nowrap">
          {run.finished_at
            ? ts.finishedAt(formatDate(run.finished_at))
            : run.started_at
              ? ts.startedAt(formatDate(run.started_at))
              : "—"}
        </span>
        {(run.status === "running" || run.status === "pending") && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPause(run.id);
              }}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {ts.pause}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancel(run.id);
              }}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
            >
              {ts.cancel}
            </button>
          </>
        )}
        {run.status === "paused" && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onResume(run.id);
              }}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-blue-600 dark:text-blue-400"
            >
              {ts.resume}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancel(run.id);
              }}
              className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
            >
              {ts.cancel}
            </button>
          </>
        )}
        {pinAvailable && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTogglePin(run.id, !!run.is_pinned);
            }}
            className={
              "text-xs px-2 py-1 rounded-md border " +
              (run.is_pinned
                ? "border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                : "dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800")
            }
            title={
              run.is_pinned
                ? ts.unpinRunHint
                : ts.pinRunHint
            }
          >
            {run.is_pinned ? ts.unpinRun : ts.pinRun}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRename(run.id, run.name);
          }}
          className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title={ts.renameRun}
        >
          {ts.renameRun}
        </button>
        {(run.status === "done" ||
          run.status === "failed" ||
          run.status === "canceled") && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(run.id, total);
            }}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
            title={ts.deleteRun}
          >
            {ts.deleteRun}
          </button>
        )}
      </div>
      {run.status === "running" && (
        <div className="mt-2 h-1 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {run.error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {run.error}
        </p>
      )}
    </Link>
  );
}

// Order matters — match the user's requested layout: good · mixed · low ·
// partial · no_verdict. The `unknown` and `error` keys are only emitted
// by the availability bucketing (2026-05-16 split — see
// `_bucket_counts_for_run`); quality and whois never produce them, so
// the chip is rendered as 0 → hidden via the `if (n === 0) return null`
// guard in `VerdictRollupPills`.
const ROLLUP_ORDER: { key: string; bucket: FinalBucket | null }[] = [
  { key: "good", bucket: "good" },
  { key: "mixed", bucket: "mixed" },
  { key: "low_quality", bucket: "low_quality" },
  { key: "unknown", bucket: null },
  { key: "error", bucket: null },
  { key: "partial", bucket: null },
  { key: "no_verdict", bucket: null },
];

function VerdictRollupPills({
  counts,
  sourceRunId,
  pinnedRunId,
  jobKind = "quality",
}: {
  counts: Record<string, number>;
  // The run id the counts actually came from (pinned when set, else latest).
  sourceRunId: number | null;
  // The pinned run id, if any. When set, counts came from the pinned run
  // and we render the "Pinned: Run #N" prefix; otherwise "Latest: Run #N".
  pinnedRunId: number | null;
  // Pillar discriminator. Drives the chip vocabulary — availability
  // jobs say "available / registered / unknown", whois says
  // "stable / drift suspected / dropped". Quality uses the default
  // good/mixed/low quality labels.
  jobKind?: string;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.detail.rollup;
  // Pick the right label map for the pillar. Falls back to the
  // default `label` (quality) if the kind doesn't have a dedicated
  // dictionary — keeps newer pillars working without an i18n edit.
  const labelMap: Record<string, string> =
    jobKind === "availability"
      ? (ts.labelAvailability as unknown as Record<string, string>)
      : jobKind === "whois_history"
        ? (ts.labelWhois as unknown as Record<string, string>)
        : (ts.label as unknown as Record<string, string>);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const isPinnedSource = pinnedRunId != null && pinnedRunId === sourceRunId;
  const sourceLabel =
    sourceRunId == null
      ? null
      : isPinnedSource
        ? ts.fromPinnedRun(sourceRunId)
        : ts.fromLatestRun(sourceRunId);
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {sourceLabel && (
        <span
          className={
            "text-[11px] px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1 " +
            (isPinnedSource
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400")
          }
          title={
            isPinnedSource ? ts.pinnedSourceHint : ts.latestSourceHint
          }
        >
          {isPinnedSource && <span aria-hidden="true">📌</span>}
          {sourceLabel}
        </span>
      )}
      {ROLLUP_ORDER.map(({ key, bucket }) => {
        const n = counts[key] || 0;
        if (n === 0) return null;
        // Tone selection for bucket=null chips:
        //   `error`     → red (cascade failed, retryable)
        //   `unknown`   → neutral-grey (cascade ran, no terminal answer)
        //   `partial`   → slightly stronger neutral (mid-run / blocked)
        //   `no_verdict`→ neutral (default catch-all)
        const tone = bucket
          ? bucketPillTone(bucket)
          : key === "error"
            ? "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300"
            : key === "partial"
              ? "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400";
        return (
          <span
            key={key}
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${tone}`}
          >
            {n} {labelMap[key] ?? key}
          </span>
        );
      })}
    </div>
  );
}
