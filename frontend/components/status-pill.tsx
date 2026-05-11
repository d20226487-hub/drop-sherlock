"use client";
import { useT } from "@/lib/i18n";

type Status = "pending" | "running" | "done" | "failed" | "canceled" | "paused";

const TONE: Record<Status, string> = {
  pending: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  canceled: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

const KNOWN: Status[] = ["pending", "running", "done", "failed", "canceled", "paused"];

export function StatusPill({ status }: { status: string }) {
  const { t } = useT();
  const norm: Status = (KNOWN as readonly string[]).includes(status)
    ? (status as Status)
    : "pending";
  const label =
    norm === "paused"
      ? t.pages.jobs.detail.statusBadgePaused
      : t.pages.jobs.run.statusBadge[norm];
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${TONE[norm]}`}
    >
      {label}
    </span>
  );
}
