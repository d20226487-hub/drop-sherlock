"use client";
import React, { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, AiPreview, Criterion } from "@/lib/api";

// Inline collapsible panel that shows EXACTLY what the AI would receive
// for the next reanalyze of this (domain, criterion). Lazy-loads on first
// expand so the parent doesn't pay the bytes for criteria the user never
// inspects. Read-only — runs no AI, mutates nothing.
export function AiPreviewPanel({
  runDomainId,
  criterion,
}: {
  runDomainId: number;
  criterion: Criterion;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.aiPreview;

  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AiPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showMessage, setShowMessage] = useState(true);
  // Default view = table (readable). Toggle to "json" when the user wants
  // to see the literal text the AI receives.
  const [view, setView] = useState<"table" | "json">("table");

  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setError(null);
    api
      .getAiPreview(runDomainId, criterion)
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, data, loading, runDomainId, criterion]);

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-blue-700 dark:text-blue-300 hover:underline"
        title={ts.toggleHint}
      >
        {open ? ts.hide : ts.show}
      </button>
      {open && (
        <div className="mt-2 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3 space-y-3">
          {loading && (
            <p className="text-neutral-500 dark:text-neutral-400">
              {t.common.loading}
            </p>
          )}
          {error && (
            <p className="rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}
          {data && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
                  {ts.provider}: <strong>{data.provider || "—"}</strong>
                  {data.model ? ` · ${data.model}` : ""}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
                  {ts.rows(data.row_count)}
                </span>
              </div>
              <div>
                <div className="font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {ts.fieldsSent}
                </div>
                <div className="flex flex-wrap gap-1">
                  {data.fields_sent.map((f) => (
                    <span
                      key={f}
                      className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-neutral-100 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 border dark:border-neutral-800"
                    >
                      {f}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-neutral-500 dark:text-neutral-400">
                  {ts.fieldsHelp}
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => setShowPrompt((v) => !v)}
                  className="text-blue-700 dark:text-blue-300 hover:underline"
                >
                  {showPrompt ? ts.hidePrompt : ts.showPrompt}
                </button>
                {showPrompt && (
                  <pre className="mt-1 max-h-72 overflow-auto rounded border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-2 text-[11px] whitespace-pre-wrap break-words">
                    {data.system_prompt}
                  </pre>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setShowMessage((v) => !v)}
                    className="text-blue-700 dark:text-blue-300 hover:underline"
                  >
                    {showMessage ? ts.hideMessage : ts.showMessage}
                  </button>
                  {showMessage && (
                    <div
                      className="ml-auto inline-flex rounded border dark:border-neutral-800 overflow-hidden"
                      role="tablist"
                    >
                      <button
                        type="button"
                        onClick={() => setView("table")}
                        className={`px-2 py-0.5 ${view === "table" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
                      >
                        {ts.viewTable}
                      </button>
                      <button
                        type="button"
                        onClick={() => setView("json")}
                        className={`px-2 py-0.5 border-l dark:border-neutral-800 ${view === "json" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
                      >
                        {ts.viewJson}
                      </button>
                    </div>
                  )}
                </div>
                {showMessage && view === "table" && (
                  <RowsTable
                    columns={data.fields_sent}
                    rows={data.rows}
                    domain={data.domain}
                    criterion={data.criterion}
                  />
                )}
                {showMessage && view === "json" && (
                  <pre className="mt-1 max-h-96 overflow-auto rounded border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-2 text-[11px] whitespace-pre-wrap break-words font-mono">
                    {data.user_message}
                  </pre>
                )}
              </div>
              {/* Chained category step preview — only present for the
                  wayback_classify criterion. Renders the second of the
                  two AI calls (theme detection feeds it). */}
              {data.category_system_prompt && (
                <ChainedCategoryPreview
                  systemPrompt={data.category_system_prompt}
                  userMessage={data.category_user_message || ""}
                  languageMode={data.language_mode || "ai"}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Compact table that renders the EXACT rows the AI receives — same field
// order as `fields_sent`. Read-only inspection; mirrors what users see in
// the Raw Data section but with the AI-trimmed column set so the
// is_spam / first_seen columns the AI cited are visible without expanding
// the raw row.
function RowsTable({
  columns,
  rows,
  domain,
  criterion,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  domain: string;
  criterion: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-1 text-neutral-500 dark:text-neutral-400">
        (no rows)
      </p>
    );
  }
  // Use the union of fields_sent + any extra keys present in rows
  // (defensive — should match exactly).
  const seen = new Set(columns);
  const extras: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        extras.push(k);
      }
    }
  }
  const cols = [...columns, ...extras];

  return (
    <div className="mt-1 space-y-1">
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
        Header sent: <span className="font-mono">Domain: {domain}</span> ·{" "}
        <span className="font-mono">Criterion: {criterion}</span> ·{" "}
        <span className="font-mono">Row count: {rows.length}</span>
      </p>
      <div className="max-h-96 overflow-auto rounded border dark:border-neutral-800">
        <table className="w-full text-[11px]">
          <thead className="bg-neutral-100 dark:bg-neutral-900 sticky top-0">
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="text-left font-medium px-2 py-1 border-b dark:border-neutral-800 whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                className="border-t dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
              >
                {cols.map((c) => (
                  <td
                    key={c}
                    className="px-2 py-1 align-top whitespace-nowrap font-mono"
                  >
                    {renderValue(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// wayback_classify-specific: shows the chained category prompt + user
// message that runs after the language+theme step. Collapsed by default
// since it's a secondary preview. Uses the same expand/collapse pattern
// as the main system prompt block above.
function ChainedCategoryPreview({
  systemPrompt,
  userMessage,
  languageMode,
}: {
  systemPrompt: string;
  userMessage: string;
  languageMode: "ai" | "library";
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  return (
    <div className="rounded-md border dark:border-neutral-800 p-2 space-y-2 bg-neutral-50/60 dark:bg-neutral-900/40">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100 font-medium">
          Step 2 · Category classification
        </span>
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Chained automatically after the {languageMode === "library" ? "theme-only" : "combined"} step above.
          Uses your predefined categories from Settings.
        </span>
      </div>
      <div>
        <button
          type="button"
          onClick={() => setShowPrompt((v) => !v)}
          className="text-blue-700 dark:text-blue-300 hover:underline"
        >
          {showPrompt ? "Hide category system prompt" : "Show category system prompt"}
        </button>
        {showPrompt && (
          <pre className="mt-1 max-h-72 overflow-auto rounded border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-2 text-[11px] whitespace-pre-wrap break-words">
            {systemPrompt}
          </pre>
        )}
      </div>
      <div>
        <button
          type="button"
          onClick={() => setShowMessage((v) => !v)}
          className="text-blue-700 dark:text-blue-300 hover:underline"
        >
          {showMessage ? "Hide category user message" : "Show category user message"}
        </button>
        {showMessage && (
          userMessage ? (
            <pre className="mt-1 max-h-72 overflow-auto rounded border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-2 text-[11px] whitespace-pre-wrap break-words font-mono">
              {userMessage}
            </pre>
          ) : (
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 italic">
              No user message yet — the category step's input is built from the theme-detection output, so it only appears once the previous step has produced a verdict. Run the criterion to populate.
            </p>
          )
        )}
      </div>
    </div>
  );
}

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span className="text-neutral-400 dark:text-neutral-500">—</span>;
  }
  if (typeof v === "boolean") {
    return v ? "✓" : "—";
  }
  if (typeof v === "number") {
    return v.toLocaleString();
  }
  if (typeof v === "string") {
    // Truncate very long strings (e.g. URLs, snippets) to keep the table
    // readable; full value stays in title for hover.
    if (v.length > 80) {
      return <span title={v}>{v.slice(0, 80) + "…"}</span>;
    }
    return v;
  }
  // Arrays / nested objects — fall back to JSON.
  return <span title={JSON.stringify(v)}>{JSON.stringify(v)}</span>;
}
