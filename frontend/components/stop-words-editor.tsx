"use client";
// Settings → Brain → Stop words editor (added 2026-08-24).
//
// One flat vocabulary of "spoiled niche" terms (gambling / adult / pharma
// / loan / replica …) shared by both halves of the Stop Words quality
// criterion: it becomes the substring terms of an Ahrefs `where` against
// the `anchor` column (anchors endpoint) and the `keyword` column
// (organic-keywords endpoint).
//
// Persistence semantics mirror DomainFilterEditor: every mutation (add /
// bulk-paste / delete / clear-all) PUTs the whole list and the server
// normalises + sorts; we reconcile local state from the response so an
// optimistic reorder can never drift from what's stored.
//
// The only non-obvious control here is the clause-ceiling warning. Ahrefs
// rejects a `where` with more than 255 clauses (HTTP 500, no explanation),
// so the request builder chunks the list — and every chunk is a
// separately-billed request. Crossing the line isn't an error, it's a
// silent doubling of cost per domain, which is exactly the kind of thing
// worth a banner.

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";

/** Split pasted text into candidate terms.
 *
 * Newline / comma / semicolon / pipe. Pipe is in the set because the rest
 * of the app already treats it as a list separator — the criterion cards'
 * ListInput splits on `[,|]`, and the CSV export joins multi-values with
 * "|" — so it's what an operator reaches for.
 *
 * Whitespace is deliberately NOT a separator, unlike the domain filter:
 * multi-word phrases ("free spins", "car insurance quotes") are legitimate
 * stop words, and splitting on spaces would shred them into single tokens
 * that match almost everything.
 *
 * Shared by BOTH inputs so the single-term field and the bulk box can
 * never disagree about what a separator is. */
function splitTerms(raw: string): string[] {
  return raw
    .split(/[\n,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function StopWordsEditor() {
  const { t } = useT();
  const ts = t.pages.settings.stopWords;
  const [terms, setTerms] = useState<string[]>([]);
  const [maxClauses, setMaxClauses] = useState(250);
  const [maxTermLength, setMaxTermLength] = useState(120);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Entries the server refused on the last write. Rendered as a warning
  // rather than swallowed: an over-long "term" is almost always a whole
  // delimited list pasted into a box that didn't split on that
  // delimiter, and reporting success with nothing added is the worst
  // possible response to that.
  const [rejected, setRejected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [addText, setAddText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getStopWords()
      .then((d) => {
        if (cancelled) return;
        setTerms(d.terms);
        setMaxClauses(d.max_clauses_per_request);
        if (d.max_term_length) setMaxTermLength(d.max_term_length);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message || "load failed");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: string[]) {
    setError(null);
    setBusy(true);
    try {
      const r = await api.putStopWords(next);
      setTerms(r.terms);
      setMaxClauses(r.max_clauses_per_request);
      if (r.max_term_length) setMaxTermLength(r.max_term_length);
      setRejected(r.rejected || []);
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function addTerms(raws: string[]) {
    // Normalise client-side too so the dedup check below matches what
    // the server will do — otherwise adding "Casino" when "casino" is
    // already stored looks like a no-op that silently "lost" the entry.
    const cleaned = raws
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean);
    if (cleaned.length === 0) return;
    const merged = new Set(terms);
    for (const v of cleaned) merged.add(v);
    await persist(Array.from(merged));
  }

  async function handleAddOne() {
    // Split on the same delimiters the bulk box uses. Pasting a whole
    // list into the single-term field is the obvious mistake to make —
    // the two inputs sit next to each other — and silently storing a
    // 1500-char "word" (or having the server reject it) helps nobody.
    // One term in still means one term out.
    await addTerms(splitTerms(addText));
    setAddText("");
  }

  async function handleBulk() {
    const raws = splitTerms(bulkText);
    if (raws.length === 0) return;
    await addTerms(raws);
    setBulkText("");
    setBulkOpen(false);
  }

  async function removeTerm(v: string) {
    await persist(terms.filter((x) => x !== v));
  }

  async function clearAll() {
    if (!window.confirm(ts.confirmClear)) return;
    await persist([]);
  }

  const overCeiling = terms.length > maxClauses;
  const chunkCount = Math.max(1, Math.ceil(terms.length / maxClauses));

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>

      {error && (
        <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">{t.common.loading}</p>
      ) : (
        <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <span>{ts.listTitle}</span>
              <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                ({terms.length})
              </span>
            </h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setBulkOpen((v) => !v)}
                className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {bulkOpen ? ts.bulkClose : ts.bulkOpen}
              </button>
              {terms.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded-md border border-red-300 dark:border-red-800/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                >
                  {ts.clearAll}
                </button>
              )}
            </div>
          </div>

          {rejected.length > 0 && (
            <div className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300 space-y-1">
              <p>{ts.rejectedWarning(rejected.length, maxTermLength)}</p>
              <ul className="list-disc pl-4 font-mono break-all">
                {rejected.map((r, i) => (
                  <li key={i}>
                    {r.length > 80 ? r.slice(0, 80) + "…" : r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {overCeiling && (
            <p className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {ts.ceilingWarning(maxClauses, chunkCount)}
            </p>
          )}

          {bulkOpen && (
            <div className="space-y-2 rounded-md border dark:border-neutral-700 p-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.bulkHint}
              </p>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={ts.placeholder}
                rows={5}
                className="w-full font-mono text-xs rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={handleBulk}
                  disabled={busy || !bulkText.trim()}
                  className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? ts.bulkAdding : ts.bulkAdd}
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[12rem]">
              <input
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                placeholder={ts.placeholder}
                className="w-full text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && addText.trim()) handleAddOne();
                }}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {ts.hint}
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddOne}
              disabled={busy || !addText.trim()}
              className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? ts.adding : ts.add}
            </button>
          </div>

          {terms.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.empty}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {terms.map((v) => (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60"
                >
                  <span>{v}</span>
                  <button
                    type="button"
                    onClick={() => removeTerm(v)}
                    aria-label={ts.removeAria(v)}
                    className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
