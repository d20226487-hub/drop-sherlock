"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

// One-click view-only share link, slotted into the Domain page header.
//
// History: shipped 2026-05-15 as a modal (expiry preset + note input).
// Rewritten 2026-05-24 to 1-click to match the Database-page icon flow
// and the user's stated intent that share creation should be a single
// click whenever the operator is looking at a specific domain.
//
// Behaviour now:
//   1. Click → POST /shares/quick { run_domain_id }.
//   2. Server reuses the most-recent active share for this rd if one
//      exists (so re-clicking doesn't multiply tokens); otherwise mints
//      a fresh token with the configured default expiry (Settings →
//      /shares → Default settings; ships as "never expires").
//   3. URL is written to the clipboard; an inline toast confirms.
//
// Notes/custom expiry/inline picker were dropped from this entry point.
// Operators who need a labelled or custom-expiry share can mint a
// regular one via the /shares page (or, in batch, the Apruv export).

export function ShareButton({
  runDomainId,
  domain,
}: {
  runDomainId: number;
  domain: string;
}) {
  const { t } = useT();
  // Reuse the Database-page quick-share copy — the toast messages are
  // identical UX and would be word-for-word duplicates if we forked
  // them into the jobs.domain.share namespace.
  const ts = t.pages.database.quickShare;
  const buttonLabel = t.pages.jobs.domain.share.button;
  const [state, setState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(
    null,
  );

  async function copyToClipboard(url: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        return true;
      }
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        return true;
      } finally {
        ta.remove();
      }
    } catch {
      return false;
    }
  }

  function showToast(msg: string, tone: "ok" | "err") {
    setToast({ msg, tone });
    window.setTimeout(() => setToast(null), 2500);
  }

  async function handleClick() {
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await api.quickShareForRd(runDomainId);
      if (r.error || !r.share_url) {
        // The Domain-page caller normally has a valid rd_id (it's
        // reading rd data right now), so this branch is mostly for
        // race conditions (rd just deleted) or token-allocation
        // failure. Surface the raw backend message either way.
        showToast(`${ts.failed}: ${r.error || "unknown"}`, "err");
        setState("err");
      } else {
        const url = `${window.location.origin}${r.share_url}`;
        const ok = await copyToClipboard(url);
        if (ok) {
          showToast(r.reused ? ts.copiedReused : ts.copiedNew, "ok");
          setState("ok");
        } else {
          showToast(`${ts.copyFailed} ${url}`, "err");
          setState("err");
        }
      }
    } catch (err) {
      showToast(
        `${ts.failed}: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
      setState("err");
    }
    window.setTimeout(() => setState("idle"), 1500);
  }

  // Tone matches the button's outline style across states so the icon
  // colour change is the primary feedback channel; the floating toast
  // carries the actual prose.
  const tone =
    state === "ok"
      ? "border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300"
      : state === "err"
        ? "border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300"
        : state === "busy"
          ? "border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
          : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800";

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "busy"}
        title={
          state === "busy"
            ? ts.copying
            : `${ts.iconTitle} — ${domain}`
        }
        aria-label={`${buttonLabel}: ${domain}`}
        className={
          "text-xs px-2 py-1 rounded-md border inline-flex items-center gap-1 transition-colors disabled:opacity-50 " +
          tone
        }
      >
        <span aria-hidden>
          {state === "ok" ? "✓" : state === "busy" ? "…" : "🔗"}
        </span>
        {buttonLabel}
      </button>
      {toast && (
        <span
          role="status"
          className={
            "absolute left-1/2 -translate-x-1/2 -top-8 z-10 whitespace-nowrap text-[11px] px-2 py-1 rounded shadow-sm border " +
            (toast.tone === "ok"
              ? "bg-emerald-50 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200"
              : "bg-rose-50 dark:bg-rose-950/80 border-rose-300 dark:border-rose-700 text-rose-800 dark:text-rose-200")
          }
        >
          {toast.msg}
        </span>
      )}
    </span>
  );
}
