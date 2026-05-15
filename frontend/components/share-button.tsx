"use client";
import Link from "next/link";
import { useState } from "react";
import { api, ShareRecord } from "@/lib/api";
import { useT } from "@/lib/i18n";

// "Create a view-only link" affordance. Shows on the operator-side
// domain page header. Clicking opens a modal:
//   1. Pick expiry preset (Never / 7d / 30d / 90d) — passed as
//      `expires_in_days` to POST /shares.
//   2. Optional note (free-text label, shown in the management table).
//   3. Confirm → backend mints a 32-char urlsafe token, response
//      includes the share URL components.
//   4. Modal swaps to "share URL" view with a Copy button and a
//      "Manage all shares" link to the /shares management page.

const EXPIRY_PRESETS: { key: string; days: number | null }[] = [
  { key: "never", days: null },
  { key: "d7", days: 7 },
  { key: "d30", days: 30 },
  { key: "d90", days: 90 },
];

export function ShareButton({
  runDomainId,
  domain,
}: {
  runDomainId: number;
  domain: string;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.share;
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={ts.buttonHint}
        className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 inline-flex items-center gap-1"
      >
        <span aria-hidden>🔗</span>
        {ts.button}
      </button>
      {open && (
        <ShareModal
          runDomainId={runDomainId}
          domain={domain}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareModal({
  runDomainId,
  domain,
  onClose,
}: {
  runDomainId: number;
  domain: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.share;
  const [expiryKey, setExpiryKey] = useState<string>("d30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ShareRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const preset = EXPIRY_PRESETS.find((p) => p.key === expiryKey)!;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rec = await api.createShare({
        run_domain_id: runDomainId,
        note: note.trim() || undefined,
        expires_in_days: preset.days ?? undefined,
      });
      setCreated(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const url = created
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/share/${created.token}`
    : "";

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / non-HTTPS contexts: fall back to a selectable
      // input (the textarea below stays visible so users can select+copy
      // manually).
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl p-4 space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{ts.modalTitle}</h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 font-mono">
            {domain}
          </p>
        </div>

        {created ? (
          <>
            <div className="space-y-2">
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                {ts.successHint}
              </p>
              <textarea
                readOnly
                value={url}
                rows={2}
                className="w-full text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-800 px-2 py-1.5 break-all resize-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="flex items-center justify-between flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyUrl}
                  className="text-xs px-3 py-1.5 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                >
                  {copied ? ts.copied : ts.copyButton}
                </button>
                <Link
                  href="/shares"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {ts.manageAll} →
                </Link>
              </div>
              {created.expires_at && (
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {ts.expiresHint}{" "}
                  {new Date(created.expires_at).toLocaleString()}
                </p>
              )}
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {ts.done}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300 block">
                {ts.expiryLabel}
              </label>
              <div className="flex flex-wrap gap-1">
                {EXPIRY_PRESETS.map((p) => {
                  const active = p.key === expiryKey;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setExpiryKey(p.key)}
                      className={
                        "text-xs px-2.5 py-1 rounded border " +
                        (active
                          ? "border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-500"
                          : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800")
                      }
                    >
                      {ts.expiryPresets[p.key as "never" | "d7" | "d30" | "d90"]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300 block">
                {ts.noteLabel}
              </label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={ts.notePlaceholder}
                maxLength={200}
                className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
              />
            </div>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 border-l-4 border-amber-400 pl-2 py-1 bg-amber-50/40 dark:bg-amber-950/20">
              {ts.warning}
            </p>
            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 break-words">
                {ts.failPrefix}: {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={create}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {busy ? ts.creating : ts.createButton}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
