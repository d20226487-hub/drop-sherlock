"use client";
import { useState } from "react";
import { api, BacklogStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Pill colors per status. Greens = positive outcome (ordered/bought),
// amber = queued-to-buy (order), neutral = neutral state, grey = pass.
const STATUS_TONE: Record<BacklogStatus, string> = {
  backlog:
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  in_progress:
    "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  analyzed:
    "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  order:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  backordered:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  bought:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 font-semibold",
  discarded:
    "bg-neutral-200 text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-500 line-through",
  banned:
    "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 line-through font-medium",
};

type Props = {
  domain: string;
  backlogStatus: BacklogStatus | null;
  // Called after a successful status change so the parent can refresh
  // its row data (the new status is then displayed without a full
  // refetch round-trip).
  onUpdated: () => void;
};

/** Small action cell for the Database page's Backlog column.
 *
 * Shows the current backlog status as a pill (or a "not in backlog"
 * hint when the domain is ad-hoc-analyzed). Click "Order" or "Discard"
 * to upsert the matching backlog row via
 * `setDomainBacklogStatus(domain, status)` — the backend handles both
 * the PATCH-existing and create-new paths. */
export function BacklogActionsCell({
  domain,
  backlogStatus,
  onUpdated,
}: Props) {
  const { t } = useT();
  const ts = t.pages.database.backlogActions;
  const labels = t.pages.backlog.statusLabels;
  const [busy, setBusy] = useState<BacklogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: BacklogStatus) {
    setBusy(next);
    setError(null);
    try {
      await api.setDomainBacklogStatus(domain, next);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="text-xs space-y-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setStatus("order")}
          disabled={busy !== null}
          title={ts.orderHint}
          className="px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50"
        >
          {busy === "order" ? ts.saving : ts.order}
        </button>
        <button
          type="button"
          onClick={() => setStatus("discarded")}
          disabled={busy !== null}
          title={ts.discardHint}
          className="px-2 py-0.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy === "discarded" ? ts.saving : ts.discard}
        </button>
      </div>
      {backlogStatus ? (
        <div
          className={`inline-block px-1.5 py-0.5 rounded ${STATUS_TONE[backlogStatus]}`}
          title={ts.currentStatus(labels[backlogStatus])}
        >
          {labels[backlogStatus]}
        </div>
      ) : (
        <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {ts.notInBacklog}
        </div>
      )}
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400">
          {ts.saveFailed}: {error}
        </div>
      )}
    </div>
  );
}
