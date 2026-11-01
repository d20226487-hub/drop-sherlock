"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  CLEANUP_OPTIONAL_STATUSES,
  CleanupCheck,
  CleanupOptionalStatus,
  CleanupOrphansPreview,
  CleanupStatus,
  CleanupTakenPreview,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

// Database ▸ Cleanup (2026-11-01). One place to delete taken domains and
// orphaned rows. Every delete is preview → typed count → backup → delete,
// and runs as a background job on the server; this page polls its status.
// The server re-checks the count, so a stale preview can't delete more
// than was shown.

const BTN =
  "text-base px-3 py-1.5 rounded-md border disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DANGER = `${BTN} border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40`;
const BTN_PLAIN = `${BTN} border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800`;
const CARD =
  "rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40 p-4 space-y-3";

// FastAPI sends {"detail": "..."}; show the sentence, not the JSON.
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  try {
    const detail = JSON.parse(e.message)?.detail;
    if (typeof detail === "string") return detail;
  } catch {
    // not JSON
  }
  return e.message;
}

function confirmCount(prompt: string, n: number, mismatch: string): boolean {
  const typed = window.prompt(prompt);
  if (typed === null) return false;
  if (typed.replace(/[\s,]/g, "") !== String(n)) {
    window.alert(mismatch);
    return false;
  }
  return true;
}

export default function CleanupPage() {
  const { t } = useT();
  const tc = t.pages.cleanup;

  // Registered is always included; each other verdict is its own opt-in.
  const [include, setInclude] = useState<CleanupOptionalStatus[]>([]);
  const toggleInclude = (s: CleanupOptionalStatus) =>
    setInclude((cur) =>
      cur.includes(s)
        ? cur.filter((x) => x !== s)
        : CLEANUP_OPTIONAL_STATUSES.filter((x) => x === s || cur.includes(x)),
    );
  const [expiryInput, setExpiryInput] = useState("30");
  const [expiryDays, setExpiryDays] = useState(30);
  const [deleteBacklog, setDeleteBacklog] = useState(true);
  const [ban, setBan] = useState(false);

  const [taken, setTaken] = useState<CleanupTakenPreview | null>(null);
  const [orphans, setOrphans] = useState<CleanupOrphansPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [resultHidden, setResultHidden] = useState(false);

  // Commit the typed expiry window after a pause, so each keystroke
  // doesn't re-run the selection.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const n = parseInt(expiryInput, 10);
      setExpiryDays(Number.isFinite(n) ? Math.min(3650, Math.max(0, n)) : 0);
    }, 400);
    return () => window.clearTimeout(id);
  }, [expiryInput]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tk, or] = await Promise.all([
        api.cleanupTakenPreview({
          include,
          protect_expiry_days: expiryDays,
        }),
        api.cleanupOrphansPreview(),
      ]);
      setTaken(tk);
      setOrphans(or);
      setStatus(tk.status);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [include, expiryDays]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll while a cleanup runs; refresh the previews once it ends.
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      try {
        const s = await api.cleanupStatus();
        setStatus(s);
        if (!s.running) void reload();
      } catch {
        // keep polling; a blip shouldn't end the progress display
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, reload]);

  const checksRunning: CleanupCheck[] = taken?.checks_running ?? [];
  const blocked = loading || running || checksRunning.length > 0;

  const start = useCallback(
    async (run: () => Promise<{ total: number }>) => {
      setError(null);
      try {
        await run();
        setResultHidden(false);
        setStatus(await api.cleanupStatus());
      } catch (e) {
        setError(errorText(e));
        void reload();
      }
    },
    [reload],
  );

  const handleDeleteTaken = useCallback(() => {
    if (!taken || taken.count === 0) return;
    const n = taken.count;
    if (!confirmCount(tc.confirmPrompt(n), n, tc.confirmMismatch)) return;
    void start(() =>
      api.runCleanupTaken({
        include,
        protect_expiry_days: expiryDays,
        delete_backlog: deleteBacklog,
        ban,
        expected_count: n,
      }),
    );
  }, [taken, tc, start, include, expiryDays, deleteBacklog, ban]);

  const handleDeleteOrphans = useCallback(() => {
    if (!orphans || orphans.total === 0) return;
    const n = orphans.total;
    if (!confirmCount(tc.confirmPrompt(n), n, tc.confirmMismatch)) return;
    void start(() => api.runCleanupOrphans(n));
  }, [orphans, tc, start]);

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-6 space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{tc.title}</h1>
        <p className="text-base text-neutral-600 dark:text-neutral-400 max-w-3xl">
          {tc.intro}
        </p>
        {taken && (
          <p className="text-base text-neutral-600 dark:text-neutral-400 max-w-3xl">
            {tc.notAffected(taken.never_analyzed)}
          </p>
        )}
      </header>

      {checksRunning.length > 0 && (
        <div className="text-base rounded-md px-3 py-2 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 space-x-2">
          <span>{tc.checksRunning}</span>
          {checksRunning.map((c) => (
            <Link
              key={c.run_id}
              href={`/jobs/${c.job_id}/runs/${c.run_id}`}
              className="underline hover:no-underline"
            >
              {c.kind} #{c.run_id}
            </Link>
          ))}
        </div>
      )}

      <StatusBanner
        status={status}
        hidden={resultHidden}
        onHide={() => setResultHidden(true)}
      />

      {error && (
        <p className="text-base rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || running}
          className={BTN_PLAIN}
        >
          {loading ? tc.loading : tc.refresh}
        </button>
      </div>

      {/* Taken domains */}
      <section className={CARD}>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{tc.takenTitle}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-4xl">
            {tc.takenHint}
          </p>
        </div>

        <div className="space-y-2 text-base">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{tc.includeLabel}</span>
            {CLEANUP_OPTIONAL_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={include.includes(s)}
                  onChange={() => toggleInclude(s)}
                />
                {tc.statusLabels[s] ?? s}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              {tc.expiryLabel}
              <input
                type="number"
                min={0}
                max={3650}
                value={expiryInput}
                onChange={(e) => setExpiryInput(e.target.value)}
                className="w-20 px-2 py-1 text-base rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950"
              />
            </label>
            <span className="text-sm text-neutral-600 dark:text-neutral-400">{tc.expiryHint}</span>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={deleteBacklog}
              onChange={(e) => setDeleteBacklog(e.target.checked)}
            />
            {tc.deleteBacklog}
          </label>
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={ban}
                onChange={(e) => setBan(e.target.checked)}
              />
              {tc.ban}
            </label>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 ml-6">{tc.banHint}</p>
          </div>
        </div>

        {taken && (
          <div className="space-y-2 text-base">
            <p>
              <span className="font-semibold">{tc.takenCount(taken.count)}</span>
              {taken.count > 0 && (
                <span className="text-neutral-600 dark:text-neutral-400">
                  {" · "}
                  {tc.withBacklog(taken.with_backlog_row)}
                </span>
              )}
            </p>
            <p className="text-neutral-600 dark:text-neutral-400">
              {tc.keptTitle} {tc.keptNote(taken.kept.note)} ·{" "}
              {tc.keptPinned(taken.kept.pinned)} ·{" "}
              {tc.keptInProgress(taken.kept.in_progress)} ·{" "}
              {tc.keptExpiring(taken.kept.expiring)}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{tc.takenDeletes}</p>
          </div>
        )}

        {taken && taken.count > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600 dark:text-neutral-400">
              <span>{tc.sampleTitle(taken.sample.length, taken.count)}</span>
              <a
                href={api.cleanupTakenCsvUrl({
                  include,
                  protect_expiry_days: expiryDays,
                })}
                className="text-blue-700 dark:text-blue-300 hover:underline"
              >
                {tc.downloadCsv}
              </a>
            </div>
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-base">
                <thead className="text-left text-neutral-500 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 font-medium">{tc.colDomain}</th>
                    <th className="px-3 py-2 font-medium">{tc.colStatus}</th>
                    <th className="px-3 py-2 font-medium">{tc.colExpires}</th>
                    <th className="px-3 py-2 font-medium">{tc.colSource}</th>
                  </tr>
                </thead>
                <tbody>
                  {taken.sample.map((r) => (
                    <tr
                      key={r.domain}
                      className="border-t border-neutral-100 dark:border-neutral-800/60"
                    >
                      <td className="px-3 py-1.5 font-mono">{r.domain}</td>
                      <td className="px-3 py-1.5">{r.status}</td>
                      <td className="px-3 py-1.5 text-neutral-500">
                        {r.expires_on || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-neutral-500">
                        {r.source || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={handleDeleteTaken}
            disabled={blocked || !taken || taken.count === 0}
            className={BTN_DANGER}
          >
            {taken && taken.count > 0 ? tc.deleteTaken(taken.count) : tc.nothing}
          </button>
        </div>
      </section>

      {/* Orphaned rows */}
      <section className={CARD}>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{tc.orphansTitle}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-4xl">
            {tc.orphansHint}
          </p>
        </div>

        {orphans && (
          <div className="grid gap-4 md:grid-cols-2 text-base">
            <CountList
              rows={orphans.delete}
              labels={tc.orphanLabels}
              help={tc.orphanHelp}
            />
            <div className="space-y-1">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{tc.keptOrphansTitle}</p>
              <CountList
                rows={orphans.kept}
                labels={tc.keptOrphanLabels}
                help={tc.keptOrphanHelp}
                muted
              />
            </div>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={handleDeleteOrphans}
            disabled={blocked || !orphans || orphans.total === 0}
            className={BTN_DANGER}
          >
            {orphans && orphans.total > 0
              ? tc.deleteOrphans(orphans.total)
              : tc.nothing}
          </button>
        </div>
      </section>
    </main>
  );
}

// Each label opens a short plain-language explanation on click; a click
// elsewhere or Esc closes it.
function CountList({
  rows,
  labels,
  help,
  muted = false,
}: {
  rows: Record<string, number>;
  labels: Record<string, string>;
  help: Record<string, string>;
  muted?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <ul ref={listRef} className="space-y-1">
      {Object.entries(rows).map(([key, n]) => (
        <li
          key={key}
          className={`relative flex justify-between gap-4 ${muted ? "text-neutral-500" : ""}`}
        >
          {help[key] ? (
            <button
              type="button"
              onClick={() => setOpen(open === key ? null : key)}
              aria-expanded={open === key}
              className="text-left underline decoration-dotted decoration-neutral-400 underline-offset-4 hover:decoration-solid"
            >
              {labels[key] ?? key}
              <span
                aria-hidden
                className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] leading-none opacity-60 align-middle no-underline"
              >
                ?
              </span>
            </button>
          ) : (
            <span>{labels[key] ?? key}</span>
          )}
          <span className="tabular-nums">{n.toLocaleString()}</span>
          {open === key && (
            <div
              role="tooltip"
              className="absolute left-0 top-full z-20 mt-1 w-[28rem] max-w-[calc(100vw-3rem)] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3 text-sm leading-relaxed text-neutral-700 dark:text-neutral-200 shadow-lg"
            >
              {help[key]}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// Progress while a cleanup runs; its outcome afterwards. The server keeps
// the last outcome until the next cleanup, so it shows after a reload too.
function StatusBanner({
  status,
  hidden,
  onHide,
}: {
  status: CleanupStatus | null;
  hidden: boolean;
  onHide: () => void;
}) {
  const { t } = useT();
  const tc = t.pages.cleanup;
  if (!status) return null;

  if (status.running) {
    const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
    return (
      <div className="text-base rounded-md px-3 py-2 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200 space-y-1.5">
        <div>
          {status.phase === "deleting"
            ? tc.phaseDeleting(status.done, status.total)
            : tc.phaseBackup}
        </div>
        {status.phase === "deleting" && (
          <div className="h-1.5 rounded bg-sky-100 dark:bg-sky-900/60 overflow-hidden">
            <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (hidden || (!status.result && !status.error)) return null;

  const r = (status.result ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const backup = typeof r.backup === "string" ? r.backup : null;
  let message: string;
  if (status.error) {
    message = tc.failed(status.error);
  } else if (status.kind === "taken") {
    message = tc.doneTaken(
      num(r.domains),
      num(r.checks),
      num(r.history_rows),
      num(r.backlog_rows),
      num(r.banned),
    );
  } else {
    const deleted = (r.deleted ?? {}) as Record<string, number>;
    message = tc.doneOrphans(
      Object.values(deleted).reduce((a, b) => a + num(b), 0),
    );
  }
  const tone = status.error
    ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
    : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200";
  return (
    <div className={`text-base rounded-md px-3 py-2 flex justify-between gap-3 ${tone}`}>
      <div className="space-y-0.5">
        <div>{message}</div>
        {backup && <div className="text-sm opacity-80">{tc.backupNote(backup)}</div>}
      </div>
      <button
        type="button"
        onClick={onHide}
        aria-label="×"
        className="self-start opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
