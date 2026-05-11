"use client";
// Settings editor for the wayback_classify criterion (added 2026-05-09).
// Two surfaces:
//   1. Language detection mode toggle (ai vs library).
//   2. Categories list — alphabetical, with bulk-paste + add/edit/delete.
//      Optional one-line description per category.

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, WaybackClassifyCategory } from "@/lib/api";

export function WaybackClassifyEditor() {
  const { t } = useT();
  const ts = t.pages.settings.waybackClassify;
  const [mode, setMode] = useState<"ai" | "library">("ai");
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [categories, setCategories] = useState<WaybackClassifyCategory[]>([]);
  const [loadingCats, setLoadingCats] = useState(true);
  const [catError, setCatError] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const [m, c] = await Promise.all([
        api.getLanguageMode(),
        api.listCategories(),
      ]);
      setMode(m.mode);
      setCategories(c.categories);
      setLoadingCats(false);
    } catch (e) {
      setCatError((e as Error).message || "load failed");
      setLoadingCats(false);
    }
  }

  async function changeMode(next: "ai" | "library") {
    setModeBusy(true);
    setModeError(null);
    try {
      await api.setLanguageMode(next);
      setMode(next);
    } catch (e) {
      setModeError((e as Error).message || "save failed");
    } finally {
      setModeBusy(false);
    }
  }

  async function addOne() {
    const name = addName.trim();
    if (!name) return;
    setAddBusy(true);
    setCatError(null);
    try {
      const r = await api.addCategories([
        { name, description: addDesc.trim() || "" },
      ]);
      setCategories(r.categories);
      setAddName("");
      setAddDesc("");
    } catch (e) {
      setCatError((e as Error).message || "add failed");
    } finally {
      setAddBusy(false);
    }
  }

  async function removeOne(name: string) {
    if (!window.confirm(ts.confirmDelete(name))) return;
    setCatError(null);
    const next = categories.filter((c) => c.name !== name);
    try {
      const r = await api.replaceCategories(next);
      setCategories(r.categories);
    } catch (e) {
      setCatError((e as Error).message || "delete failed");
    }
  }

  async function updateDescription(name: string, description: string) {
    setCatError(null);
    const next = categories.map((c) =>
      c.name === name ? { ...c, description } : c,
    );
    try {
      const r = await api.replaceCategories(next);
      setCategories(r.categories);
    } catch (e) {
      setCatError((e as Error).message || "save failed");
    }
  }

  // Bulk paste: parse lines like "Name | description" or just "Name".
  // Comma-only separators (Name, description) also work. Lines split by
  // newlines first; if a single line has no newline + multiple commas
  // we treat the first comma as name|description boundary.
  function parseBulk(text: string): WaybackClassifyCategory[] {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out: WaybackClassifyCategory[] = [];
    for (const line of lines) {
      let name = line;
      let description = "";
      const pipe = line.indexOf("|");
      const comma = line.indexOf(",");
      const sep =
        pipe >= 0 && (comma < 0 || pipe < comma)
          ? pipe
          : comma >= 0
            ? comma
            : -1;
      if (sep > 0) {
        name = line.slice(0, sep).trim();
        description = line.slice(sep + 1).trim();
      }
      if (name) out.push({ name, description });
    }
    return out;
  }

  async function handleBulk() {
    const items = parseBulk(bulkText);
    if (items.length === 0) return;
    setBulkBusy(true);
    setCatError(null);
    try {
      const r = await api.addCategories(items);
      setCategories(r.categories);
      setBulkText("");
      setBulkOpen(false);
    } catch (e) {
      setCatError((e as Error).message || "bulk add failed");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>

      <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
        <h3 className="text-sm font-semibold">{ts.languageModeHeading}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.languageModeIntro}
        </p>
        <div className="flex gap-2 flex-wrap">
          {(["ai", "library"] as const).map((m) => (
            <label
              key={m}
              className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border cursor-pointer ${
                mode === m
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                  : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              } ${modeBusy ? "opacity-50 pointer-events-none" : ""}`}
            >
              <input
                type="radio"
                name="language_mode"
                value={m}
                checked={mode === m}
                onChange={() => changeMode(m)}
                disabled={modeBusy}
              />
              <div>
                <div className="font-medium">{ts.languageModeOptions[m].label}</div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {ts.languageModeOptions[m].help}
                </div>
              </div>
            </label>
          ))}
        </div>
        {modeError && (
          <p className="text-sm text-red-700 dark:text-red-300">{modeError}</p>
        )}
      </div>

      <div className="rounded-md border dark:border-neutral-700 p-4 space-y-3 bg-white dark:bg-neutral-900/60">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold">{ts.categoriesHeading}</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {ts.categoriesIntro}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBulkOpen((v) => !v)}
            className="text-xs px-2 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {bulkOpen ? ts.bulkClose : ts.bulkOpen}
          </button>
        </div>
        {bulkOpen && (
          <div className="space-y-2 rounded-md border dark:border-neutral-700 p-3">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.bulkHint}
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={ts.bulkPlaceholder}
              rows={6}
              className="w-full font-mono text-xs rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={handleBulk}
                disabled={bulkBusy || !bulkText.trim()}
                className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkBusy ? ts.bulkAdding : ts.bulkAdd}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex-1 min-w-[12rem]">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
              {ts.addNameLabel}
            </label>
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={ts.addNamePlaceholder}
              className="w-full text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && addName.trim()) addOne();
              }}
            />
          </div>
          <div className="flex-1 min-w-[18rem]">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
              {ts.addDescLabel}
            </label>
            <input
              value={addDesc}
              onChange={(e) => setAddDesc(e.target.value)}
              placeholder={ts.addDescPlaceholder}
              className="w-full text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && addName.trim()) addOne();
              }}
            />
          </div>
          <button
            type="button"
            onClick={addOne}
            disabled={addBusy || !addName.trim()}
            className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {addBusy ? ts.addBusy : ts.add}
          </button>
        </div>

        {catError && (
          <p className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {catError}
          </p>
        )}
        {loadingCats ? (
          <p className="text-sm text-neutral-500">{t.common.loading}</p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {ts.empty}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 dark:bg-neutral-900 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">{ts.colName}</th>
                  <th className="px-3 py-2 font-medium">{ts.colDescription}</th>
                  <th className="px-3 py-2 w-1" />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.name} className="border-t dark:border-neutral-800">
                    <td className="px-3 py-2 font-medium">{c.name}</td>
                    <td className="px-3 py-2">
                      <DescriptionEditor
                        initial={c.description}
                        onSave={(v) => updateDescription(c.name, v)}
                        placeholder={ts.descPlaceholder}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeOne(c.name)}
                        className="text-xs text-red-600 dark:text-red-400 hover:underline"
                      >
                        {ts.remove}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function DescriptionEditor({
  initial,
  onSave,
  placeholder,
}: {
  initial: string;
  onSave: (v: string) => Promise<void> | void;
  placeholder: string;
}) {
  const [value, setValue] = useState(initial);
  const dirty = value !== initial;
  return (
    <div className="flex gap-2 items-center">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="flex-1 text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none"
        onBlur={() => {
          if (dirty) onSave(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
