"use client";
// Settings → Domain Filter editor (added 2026-06-07).
//
// The filter holds N per-category exclusion lists (today only `cctld`;
// more categories ship without UI churn because we render one compact
// section per `categories` key returned by the server). Each section
// uses a chip layout so dozens of entries stay scannable in a small
// vertical footprint — important since the user plans to add more
// categories beside this one.
//
// Persistence semantics mirror WaybackClassifyEditor: every mutation
// (add / delete / bulk-paste / clear-all) PUTs the whole state and the
// server normalises + sorts; we reconcile our local state from the
// response so optimistic reorder bugs are impossible.

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, DomainFilterState } from "@/lib/api";

export function DomainFilterEditor() {
  const { t } = useT();
  const ts = t.pages.settings.domainFilter;
  const [categories, setCategories] = useState<string[]>([]);
  const [state, setState] = useState<DomainFilterState>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getDomainFilter()
      .then((d) => {
        if (cancelled) return;
        setCategories(d.categories);
        setState(d.state);
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

  async function persist(next: DomainFilterState) {
    setError(null);
    try {
      const r = await api.putDomainFilter(next);
      setState(r.state);
      setCategories(r.categories);
    } catch (e) {
      setError((e as Error).message || "save failed");
    }
  }

  function entriesOf(cat: string): string[] {
    return state[cat] || [];
  }

  async function addEntries(cat: string, raws: string[]) {
    const existing = new Set(entriesOf(cat));
    const cleaned = raws
      .map((s) => s.trim().toLowerCase().replace(/^\.+/, ""))
      .filter((s) => s.length > 0);
    const merged = new Set(existing);
    for (const v of cleaned) merged.add(v);
    const next: DomainFilterState = {
      ...state,
      [cat]: Array.from(merged),
    };
    await persist(next);
  }

  async function removeEntry(cat: string, value: string) {
    const next: DomainFilterState = {
      ...state,
      [cat]: entriesOf(cat).filter((v) => v !== value),
    };
    await persist(next);
  }

  async function clearCategory(cat: string) {
    if (!window.confirm(ts.confirmClear)) return;
    const next: DomainFilterState = { ...state, [cat]: [] };
    await persist(next);
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
        <div className="space-y-4">
          {categories.map((cat) => (
            <CategorySection
              key={cat}
              category={cat}
              entries={entriesOf(cat)}
              onAdd={(raws) => addEntries(cat, raws)}
              onRemove={(v) => removeEntry(cat, v)}
              onClear={() => clearCategory(cat)}
            />
          ))}
          {categories.length === 0 && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {ts.noCategories}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  entries,
  onAdd,
  onRemove,
  onClear,
}: {
  category: string;
  entries: string[];
  onAdd: (raws: string[]) => Promise<void> | void;
  onRemove: (value: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.domainFilter;
  // Per-category copy lookup. Unknown categories fall back to the key
  // itself + a generic body, so a future category is at least usable
  // without an i18n update.
  const meta = ts.categories[category as keyof typeof ts.categories] || {
    title: category,
    body: ts.fallbackBody,
    placeholder: "",
    hint: "",
  };

  const [addText, setAddText] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  async function handleAddOne() {
    const v = addText.trim();
    if (!v) return;
    setBusy(true);
    try {
      await onAdd([v]);
      setAddText("");
    } finally {
      setBusy(false);
    }
  }

  async function handleBulk() {
    // Accept commas, whitespace, or newlines as separators — paste
    // formats from spreadsheets and one-per-line lists both work.
    const raws = bulkText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (raws.length === 0) return;
    setBusy(true);
    try {
      await onAdd(raws);
      setBulkText("");
      setBulkOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <span>{meta.title}</span>
            <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
              ({entries.length})
            </span>
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {meta.body}
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
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClear}
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
            {ts.bulkHint}
          </p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={meta.placeholder}
            rows={4}
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
            placeholder={meta.placeholder}
            className="w-full text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && addText.trim()) handleAddOne();
            }}
          />
          {meta.hint && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {meta.hint}
            </p>
          )}
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

      {entries.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-full border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60"
            >
              <span>{v}</span>
              <button
                type="button"
                onClick={() => onRemove(v)}
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
  );
}
