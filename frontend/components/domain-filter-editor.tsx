"use client";
// Settings → Domain Filter editor (added 2026-06-07; reshaped 2026-08-24).
//
// Import-time gate applied at /backlog/import. Two independent rules:
//   1. Stop keywords — a domain whose NAME contains any keyword (substring,
//      anywhere, case-insensitive) is filtered out. Active whenever the
//      list is non-empty.
//   2. Allowed-TLD whitelist — a domain whose TLD is NOT in the shared
//      "Spam Filter" (allowed-tlds) list is filtered out. Opt-in toggle;
//      the TLD list itself is edited under SERP Overview settings, so here
//      we only show the count + a warning and link.
//
// Persistence mirrors the other whole-config editors: every mutation PUTs
// the full config and the server normalises (lower / dedup / sort); we
// reconcile local state from the response.

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, DomainFilterConfig } from "@/lib/api";

// Split a pasted TLD blob: newline / comma / semicolon / pipe / whitespace.
// Whitespace IS a separator here (unlike keywords) — TLD labels never
// contain spaces, and operators paste space- or newline-separated lists.
function splitTlds(raw: string): string[] {
  return raw
    .split(/[\s,;|]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean);
}

export function DomainFilterEditor() {
  const { t } = useT();
  const ts = t.pages.settings.domainFilter;
  const [keywords, setKeywords] = useState<string[]>([]);
  const [tldEnabled, setTldEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  // Allowed-TLD list (the shared Spam Filter). Held as newline text for a
  // large-list textarea; `tldList` is the parsed set used for the
  // missing-ccTLD check.
  const [tldsText, setTldsText] = useState("");
  const [tldList, setTldList] = useState<string[]>([]);
  const [defaultCount, setDefaultCount] = useState(0);
  const [tldBusy, setTldBusy] = useState(false);
  const [tldDirty, setTldDirty] = useState(false);
  const [tldSaved, setTldSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getDomainFilter(), api.getAllowedTlds()])
      .then(([d, tld]) => {
        if (cancelled) return;
        setKeywords(d.config.keywords);
        setTldEnabled(d.config.tld_whitelist_enabled);
        setTldsText(tld.tlds.join("\n"));
        setTldList(tld.tlds);
        setDefaultCount(tld.default_count);
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

  function applyTldResponse(tlds: string[]) {
    setTldList(tlds);
    setTldsText(tlds.join("\n"));
    setTldDirty(false);
    setTldSaved(true);
    setTimeout(() => setTldSaved(false), 2000);
  }

  async function saveTlds() {
    setTldBusy(true);
    setError(null);
    try {
      const r = await api.putAllowedTlds({ tlds: splitTlds(tldsText) });
      applyTldResponse(r.tlds);
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setTldBusy(false);
    }
  }

  async function resetTlds() {
    if (!window.confirm(ts.tld.resetConfirm)) return;
    setTldBusy(true);
    setError(null);
    try {
      const r = await api.putAllowedTlds({ reset: true });
      applyTldResponse(r.tlds);
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setTldBusy(false);
    }
  }

  async function persist(next: DomainFilterConfig) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.putDomainFilter(next);
      setKeywords(r.config.keywords);
      setTldEnabled(r.config.tld_whitelist_enabled);
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  function splitTerms(raw: string): string[] {
    // Newline / comma / semicolon / pipe — NOT space (keywords can be
    // multi-token substrings). Same convention as the Stop Words editor.
    return raw
      .split(/[\n,;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function addKeywords(raws: string[]) {
    const cleaned = raws
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean);
    if (cleaned.length === 0) return;
    const merged = new Set(keywords);
    for (const v of cleaned) merged.add(v);
    await persist({
      keywords: Array.from(merged),
      tld_whitelist_enabled: tldEnabled,
    });
  }

  async function removeKeyword(v: string) {
    await persist({
      keywords: keywords.filter((x) => x !== v),
      tld_whitelist_enabled: tldEnabled,
    });
  }

  async function clearKeywords() {
    if (!window.confirm(ts.confirmClear)) return;
    await persist({ keywords: [], tld_whitelist_enabled: tldEnabled });
  }

  async function toggleTld(v: boolean) {
    await persist({ keywords, tld_whitelist_enabled: v });
  }

  return (
    <div className="space-y-6">
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
        <>
          {/* --- Stop keywords --- */}
          <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <span>{ts.keywords.title}</span>
                  <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                    ({keywords.length})
                  </span>
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {ts.keywords.body}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setBulkOpen((v) => !v)}
                  className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {bulkOpen ? ts.bulkClose : ts.bulkOpen}
                </button>
                {keywords.length > 0 && (
                  <button
                    type="button"
                    onClick={clearKeywords}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded-md border border-red-300 dark:border-red-800/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                  >
                    {ts.clearAll}
                  </button>
                )}
              </div>
            </div>

            {bulkOpen && (
              <div className="space-y-2 rounded-md border dark:border-neutral-700 p-3">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {ts.keywords.bulkHint}
                </p>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={ts.keywords.placeholder}
                  rows={4}
                  className="w-full font-mono text-xs rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={async () => {
                      const raws = splitTerms(bulkText);
                      if (raws.length === 0) return;
                      await addKeywords(raws);
                      setBulkText("");
                      setBulkOpen(false);
                    }}
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
                  placeholder={ts.keywords.placeholder}
                  className="w-full text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && addText.trim()) {
                      addKeywords(splitTerms(addText));
                      setAddText("");
                    }
                  }}
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {ts.keywords.hint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  addKeywords(splitTerms(addText));
                  setAddText("");
                }}
                disabled={busy || !addText.trim()}
                className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {ts.add}
              </button>
            </div>

            {keywords.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.keywords.empty}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {keywords.map((v) => (
                  <span
                    key={v}
                    className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60"
                  >
                    <span>{v}</span>
                    <button
                      type="button"
                      onClick={() => removeKeyword(v)}
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

          {/* --- Allowed-TLD whitelist --- */}
          <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tldEnabled}
                disabled={busy}
                onChange={(e) => toggleTld(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <h3 className="text-sm font-semibold">
                  {ts.tld.title}{" "}
                  <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                    ({ts.tld.count(tldList.length)})
                  </span>
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {ts.tld.body}
                </p>
              </div>
            </label>

            {/* Inline editor for the shared list. Textarea (not chips)
                because it's ~hundreds of entries; the same list backs
                Linked Domains + SERP exports. */}
            <div className="space-y-2">
              <label className="text-xs text-neutral-600 dark:text-neutral-400 block">
                {ts.tld.editorLabel}
              </label>
              <textarea
                value={tldsText}
                onChange={(e) => {
                  setTldsText(e.target.value);
                  setTldDirty(true);
                }}
                spellCheck={false}
                rows={8}
                className="w-full font-mono text-xs rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
                placeholder={"com\nnet\nio\nkz\nru"}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.tld.editorHint}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={saveTlds}
                  disabled={tldBusy || !tldDirty}
                  className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {tldBusy ? ts.tld.saving : ts.tld.save}
                </button>
                <button
                  type="button"
                  onClick={resetTlds}
                  disabled={tldBusy}
                  className="text-xs px-2 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  {ts.tld.reset(defaultCount)}
                </button>
                {tldSaved && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    {ts.tld.saved}
                  </span>
                )}
                {tldDirty && !tldBusy && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    {ts.tld.unsaved}
                  </span>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
