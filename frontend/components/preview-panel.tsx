"use client";
import { useState } from "react";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { PreviewResponse } from "@/lib/api";

export function PreviewPanel({
  preview,
  loading,
}: {
  preview: PreviewResponse | null;
  loading: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.preview;
  const ct = t.pages.analyze.criteria;
  const [copied, setCopied] = useState<string | null>(null);
  // Collapsed by default — power-user info; users debugging the request
  // shape will open it on demand.
  const [open, setOpen] = useState(false);

  const enabled = preview?.requests.filter((r) => r.enabled) || [];

  async function copy(url: string, key: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // clipboard blocked; ignore
    }
  }

  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 p-5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors rounded-lg"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-neutral-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-neutral-500" />
        )}
        <div className="flex-1">
          <h2 className="text-lg font-semibold inline">{ts.heading}</h2>
          <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-2">
            {enabled.length} enabled
          </span>
          {!open && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {ts.help}
            </p>
          )}
        </div>
      </button>

      {open && (
      <div className="px-5 pb-5 space-y-3">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.help}
        </p>
        {preview?.note && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
            {preview.note}
          </p>
        )}
        {preview?.domain && !preview.note && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
            {ts.domainNote(preview.domain)}
          </p>
        )}
      </div>

      {loading && !preview && (
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      )}

      {preview && enabled.length === 0 && (
        <p className="text-sm text-neutral-500">{ts.empty}</p>
      )}

      <div className="space-y-3">
        {preview?.requests.map((r) => {
          const label =
            r.criterion === "backlinks"
              ? ct.backlinks
              : r.criterion === "refdomains"
                ? ct.refdomains
                : r.criterion === "anchors"
                  ? ct.anchors
                  : ct.keywords;
          if (!r.enabled) return null;
          const key = r.criterion;
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {label}
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-2">
                    GET · limit={r.limit}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => copy(r.url, key)}
                  className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 inline-flex items-center gap-1"
                >
                  {copied === key ? (
                    <>
                      <Check className="w-3 h-3" /> {ts.copied}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> {ts.copy}
                    </>
                  )}
                </button>
              </div>
              <pre className="text-xs bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 overflow-x-auto border dark:border-neutral-800 break-all whitespace-pre-wrap">
                {r.url}
              </pre>
            </div>
          );
        })}
      </div>
      </div>
      )}
    </section>
  );
}
