"use client";

// Tool: Linked Domains Checker.
//
// Unlike the stateless probes (Ahrefs bulk probe / SERP Overview), this
// submits a persistent Job(kind='linked_domains') and polls its Run.
// Backend:
//   POST   /api/analyze/linked-domains          → { job_id, run_id }
//   GET    /api/runs/{id}/status                → RunStatus (progress poll)
//   GET    /api/runs/{id}/cost                  → cost poll
//   POST   /api/runs/{id}/{pause,resume,cancel} → run controls
//   GET    /api/runs/{id}/linked-domains.csv    → unique-domains export
//   GET    /api/analyze/linked-domains/runs     → recent-runs history
//
// Split out 2026-07-02 from /tools/ahrefs-batch-analysis into its own tool
// page, and given a persistent runs-history table so past runs can be
// re-opened / downloaded (previously the run id was lost on reload).

import { useCallback, useEffect, useState } from "react";

type LinkedRunStatus = {
  id: number;
  status: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
};

type LinkedCost = {
  ahrefs_units_billed: number;
  ahrefs_units_list: number;
  ahrefs_fresh_calls: number;
  ahrefs_cached_calls: number;
};

// One row of the recent-runs history table. Mirrors the backend
// /api/analyze/linked-domains/runs payload exactly.
type LinkedRunHistoryItem = {
  job_id: number;
  run_id: number;
  name: string;
  status: string;
  created_at: string;
  targets_total: number;
  targets_done: number;
  targets_failed: number;
  unique_domains: number;
  units_billed: number;
};

const LINKED_TERMINAL = ["done", "failed", "canceled", "paused"];

// Render an ISO timestamp as a compact local date+time. Falls back to
// the raw string if it doesn't parse.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LinkedDomainsToolPage() {
  const [domainsRaw, setDomainsRaw] = useState("");
  const [rootOnly, setRootOnly] = useState(false);
  const [minDr, setMinDr] = useState("");
  const [perTargetLimit, setPerTargetLimit] = useState("");
  const [unitBudget, setUnitBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [status, setStatus] = useState<LinkedRunStatus | null>(null);
  const [cost, setCost] = useState<LinkedCost | null>(null);
  const [skippedBanned, setSkippedBanned] = useState<string[]>([]);
  const [skipChecked, setSkipChecked] = useState(false);
  const [skippedAlreadyChecked, setSkippedAlreadyChecked] = useState<string[]>(
    [],
  );
  const [history, setHistory] = useState<LinkedRunHistoryItem[]>([]);

  function parseDomains(): string[] {
    return domainsRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const domains = parseDomains();

  // Fetch the recent-runs history. Called on mount, after a successful
  // submit, and whenever the active run reaches a terminal state.
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/analyze/linked-domains/runs?limit=50");
      if (!res.ok) return;
      const data: LinkedRunHistoryItem[] = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch {
      return; // transient — history refreshes on the next trigger
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Poll run status while a run is active; stop at a terminal state.
  // Refresh the history table once the run finishes so its final
  // counts / unique-domains / units land in the table.
  useEffect(() => {
    if (runId == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let refreshedTerminal = false;
    async function poll() {
      try {
        const [sRes, cRes] = await Promise.all([
          fetch(`/api/runs/${runId}/status`),
          fetch(`/api/runs/${runId}/cost`),
        ]);
        if (cancelled) return;
        if (cRes.ok) setCost(await cRes.json());
        if (!sRes.ok) return;
        const data: LinkedRunStatus = await sRes.json();
        setStatus(data);
        if (LINKED_TERMINAL.includes(data.status)) {
          if (timer) clearInterval(timer);
          if (!refreshedTerminal) {
            refreshedTerminal = true;
            loadHistory();
          }
        }
      } catch {
        return; // transient — the next tick retries
      }
    }
    poll();
    timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, loadHistory]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (domains.length === 0) {
      setError("Add at least one domain");
      return;
    }
    if (domains.length > 1000) {
      setError(`Max 1000 domains per run (you have ${domains.length})`);
      return;
    }
    const minDrNum = minDr.trim() === "" ? null : Number(minDr);
    if (
      minDrNum != null &&
      (Number.isNaN(minDrNum) || minDrNum < 0 || minDrNum > 100)
    ) {
      setError("Min DR must be between 0 and 100");
      return;
    }
    const limitNum =
      perTargetLimit.trim() === "" ? null : Number(perTargetLimit);
    if (
      limitNum != null &&
      (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 5000)
    ) {
      setError("Per-target limit must be between 1 and 5000");
      return;
    }
    const budgetNum = unitBudget.trim() === "" ? null : Number(unitBudget);
    if (budgetNum != null && (Number.isNaN(budgetNum) || budgetNum < 1)) {
      setError("Unit budget must be a positive number");
      return;
    }
    setBusy(true);
    setStatus(null);
    setCost(null);
    setSkippedBanned([]);
    setSkippedAlreadyChecked([]);
    setRunId(null);
    try {
      const res = await fetch("/api/analyze/linked-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains,
          root_only: rootOnly,
          min_dr: minDrNum,
          per_target_limit: limitNum,
          unit_budget: budgetNum,
          skip_checked: skipChecked,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        let code = "";
        let count = 0;
        try {
          const j = JSON.parse(t);
          code = j?.detail?.code ?? "";
          count = j?.detail?.count ?? 0;
        } catch {
          code = "";
        }
        if (code === "all_already_checked") {
          throw new Error(
            `All ${count} domain(s) were already checked in a previous run — nothing new to run.`,
          );
        }
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      setSkippedBanned(data.skipped_banned || []);
      setSkippedAlreadyChecked(data.skipped_already_checked || []);
      setRunId(data.run_id);
      loadHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (runId == null) return;
    try {
      await fetch(`/api/runs/${runId}/${action}`, { method: "POST" });
      const res = await fetch(`/api/runs/${runId}/status`);
      if (res.ok) setStatus(await res.json());
    } catch {
      return; // the poll loop reconciles
    }
  }

  // View a past run: point the active runId at it so the existing
  // status/cost polling effect (keyed on runId) loads and polls it.
  function viewRun(id: number) {
    setError(null);
    setStatus(null);
    setCost(null);
    setSkippedBanned([]);
    setRunId(id);
  }

  // Resume a paused run straight from the history table, then refresh
  // history and open it in the status panel.
  async function resumeRun(id: number) {
    try {
      await fetch(`/api/runs/${id}/resume`, { method: "POST" });
    } catch {
      // fall through — viewRun's poll loop reconciles the real state
    }
    viewRun(id);
    loadHistory();
  }

  const isActive = status != null && !LINKED_TERMINAL.includes(status.status);
  const isTerminal = status != null && LINKED_TERMINAL.includes(status.status);
  const processed = status ? status.done + status.failed : 0;
  const pct =
    status && status.total > 0
      ? Math.round((processed / status.total) * 100)
      : 0;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Tool · Linked Domains Checker</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          For each domain, pull the external{" "}
          <strong>domains it links out to</strong> via Ahrefs{" "}
          <code>/linkeddomains</code> (one call per domain). Runs as a{" "}
          <strong>persistent, resumable job</strong> — safe to leave running,
          and it survives restarts. Export the <strong>unique</strong> linked
          domains across all inputs as CSV. Only the <code>domain</code>{" "}
          column is fetched to keep spend near the{" "}
          <strong>~50 units/domain</strong> floor; DR and root-only apply as
          server-side filters. Tip: domain <code>ahrefs.com</code> probes for
          free.
        </p>
      </header>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4"
      >
        <label className="block">
          <span className="text-sm font-medium block mb-1">
            Domains (one per line · max 1000)
          </span>
          <textarea
            value={domainsRaw}
            onChange={(e) => setDomainsRaw(e.target.value)}
            rows={6}
            placeholder={"example.com\nsomesite.org\nahrefs.com"}
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm outline-none"
            disabled={busy}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            Parsed: {domains.length} domain{domains.length === 1 ? "" : "s"}
          </span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={rootOnly}
              onChange={(e) => setRootOnly(e.target.checked)}
              disabled={busy}
              className="mt-0.5"
            />
            <span className="text-sm font-medium">
              Root domains only
              <span className="block text-xs font-normal text-neutral-500 dark:text-neutral-400">
                exclude subdomains
              </span>
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Min DR (optional)
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={minDr}
              onChange={(e) => setMinDr(e.target.value)}
              placeholder="e.g. 20"
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium block mb-1">
              Per-target limit (optional)
            </span>
            <input
              type="number"
              min={1}
              max={5000}
              value={perTargetLimit}
              onChange={(e) => setPerTargetLimit(e.target.value)}
              placeholder="5000 (default)"
              className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
        </div>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={skipChecked}
            onChange={(e) => setSkipChecked(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span className="text-sm font-medium">
            Skip already-checked domains
            <span className="block text-xs font-normal text-neutral-500 dark:text-neutral-400">
              drop domains that already completed in a previous run
            </span>
          </span>
        </label>

        <label className="block sm:max-w-xs">
          <span className="text-sm font-medium block mb-1">
            Unit budget (optional)
          </span>
          <input
            type="number"
            min={1}
            value={unitBudget}
            onChange={(e) => setUnitBudget(e.target.value)}
            placeholder="auto-pause above N units"
            className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
            disabled={busy}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
            Pauses the run (resumable) once Ahrefs spend crosses this ceiling.
          </span>
        </label>

        <button
          type="submit"
          disabled={busy || domains.length === 0}
          className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Run checker"}
        </button>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </form>

      {skippedBanned.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Skipped {skippedBanned.length} banned domain(s):{" "}
          {skippedBanned.slice(0, 5).join(", ")}
          {skippedBanned.length > 5 ? "…" : ""}
        </p>
      )}

      {skippedAlreadyChecked.length > 0 && (
        <p className="text-xs text-sky-700 dark:text-sky-300">
          Skipped {skippedAlreadyChecked.length} already-checked domain
          {skippedAlreadyChecked.length === 1 ? "" : "s"} (from previous runs):{" "}
          {skippedAlreadyChecked.slice(0, 5).join(", ")}
          {skippedAlreadyChecked.length > 5 ? "…" : ""}
        </p>
      )}

      {status && (
        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-medium">
              Run #{status.id} ·{" "}
              <span className="uppercase tracking-wide">{status.status}</span>
            </div>
            <div className="flex gap-2">
              {isActive && status.status === "running" && (
                <button
                  type="button"
                  onClick={() => control("pause")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  Pause
                </button>
              )}
              {status.status === "paused" && (
                <button
                  type="button"
                  onClick={() => control("resume")}
                  className="rounded border dark:border-neutral-700 px-3 py-1 text-xs"
                >
                  Resume
                </button>
              )}
              {isActive && (
                <button
                  type="button"
                  onClick={() => control("cancel")}
                  className="rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="h-2 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
            <div
              className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {processed}/{status.total} targets · {status.done} done ·{" "}
            {status.failed} failed · {status.running} running ·{" "}
            {status.pending} pending
          </div>

          {cost && (
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              Ahrefs units:{" "}
              <strong className="text-neutral-700 dark:text-neutral-200">
                {cost.ahrefs_units_billed.toLocaleString()}
              </strong>{" "}
              billed
              {cost.ahrefs_units_list !== cost.ahrefs_units_billed && (
                <> · {cost.ahrefs_units_list.toLocaleString()} list price</>
              )}{" "}
              · {cost.ahrefs_fresh_calls} API call
              {cost.ahrefs_fresh_calls === 1 ? "" : "s"}
            </div>
          )}

          {isTerminal && (
            <a
              href={`/api/runs/${status.id}/linked-domains.csv`}
              className="inline-block rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium"
            >
              Download unique domains CSV
            </a>
          )}
        </div>
      )}

      {/* Recent runs — persistent history so past runs can be re-opened
          and downloaded even after a page reload. */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <div className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-x-auto">
          {history.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 px-4 py-6">
              No runs yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-neutral-500 dark:text-neutral-400 border-b dark:border-neutral-800">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Date</th>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Targets</th>
                  <th className="text-right font-medium px-3 py-2">
                    Unique domains
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    Ahrefs units
                  </th>
                  <th className="text-right font-medium px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr
                    key={h.run_id}
                    className={
                      "border-t border-neutral-100 dark:border-neutral-800/60 " +
                      (h.run_id === runId
                        ? "bg-blue-50/60 dark:bg-blue-950/20"
                        : "")
                    }
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-600 dark:text-neutral-300">
                      {fmtDate(h.created_at)}
                    </td>
                    <td className="px-3 py-2">{h.name || `Run #${h.run_id}`}</td>
                    <td className="px-3 py-2 uppercase tracking-wide text-xs">
                      {h.status}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {h.targets_done}/{h.targets_total}
                      {h.targets_failed > 0 && (
                        <span className="text-rose-600 dark:text-rose-400">
                          {" "}
                          · {h.targets_failed} failed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.unique_domains.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.units_billed.toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => viewRun(h.run_id)}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          View
                        </button>
                        <a
                          href={`/api/runs/${h.run_id}/linked-domains.csv`}
                          className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          Download CSV
                        </a>
                        {h.status === "paused" && (
                          <button
                            type="button"
                            onClick={() => resumeRun(h.run_id)}
                            className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                          >
                            Resume
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
