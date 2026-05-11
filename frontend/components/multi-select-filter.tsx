"use client";
import { useEffect, useRef, useState } from "react";

export type MultiSelectOption = {
  value: string;
  label: string;
  /** "tail" options (e.g. __none__, __partial__) render at the bottom of the
   * popover, separated by a thin divider. Defaults to "main". */
  group?: "main" | "tail";
};

export function MultiSelectFilter({
  label,
  anyLabel,
  value,
  onChange,
  options,
  disabled,
  title,
  searchable,
  searchPlaceholder,
}: {
  /** Short prefix shown before the selection summary, e.g. "Verdict". */
  label: string;
  /** Shown when nothing is selected, e.g. "Any verdict". */
  anyLabel: string;
  value: string[];
  onChange: (v: string[]) => void;
  options: MultiSelectOption[];
  disabled?: boolean;
  title?: string;
  /** When true, render an in-popover search box that filters options by
   * case-insensitive substring against label. Use for filters with many
   * options (registrars, languages, categories) — overkill for short
   * lists like status/verdict. */
  searchable?: boolean;
  /** Placeholder for the search box; defaults to "Search…". */
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-focus the search box when the popover opens; reset the query when
  // it closes so the next open starts clean.
  useEffect(() => {
    if (open && searchable) {
      // Defer one tick so the input exists in the DOM after the popover
      // mounts; otherwise focus() runs on an unrendered element.
      const id = window.setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    if (!open) setSearch("");
  }, [open, searchable]);

  const selected = new Set(value);
  function toggle(v: string) {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Preserve the option-list order in the output array so the summary text
    // stays stable as users tick boxes in arbitrary order.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  }

  let summary: string;
  if (value.length === 0) {
    summary = anyLabel;
  } else if (value.length <= 2) {
    const labels = value.map(
      (v) => options.find((o) => o.value === v)?.label ?? v,
    );
    summary = `${label}: ${labels.join(", ")}`;
  } else {
    summary = `${label}: ${value.length} selected`;
  }

  // Apply the in-popover search (case-insensitive substring on label).
  // Search affects only the displayed list — selection state, "X selected"
  // counter and Clear-all are unaffected. Selected options that fall out
  // of search results still count and can be cleared from below.
  const q = search.trim().toLowerCase();
  const matchesSearch = (o: MultiSelectOption) =>
    !searchable || !q || o.label.toLowerCase().includes(q);
  const main = options.filter(
    (o) => (o.group ?? "main") === "main" && matchesSearch(o),
  );
  const tail = options.filter(
    (o) => o.group === "tail" && matchesSearch(o),
  );

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          "w-full flex items-center justify-between gap-2 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none text-left disabled:opacity-50 " +
          (value.length > 0
            ? "border-blue-400 dark:border-blue-700"
            : "")
        }
      >
        <span className="truncate">{summary}</span>
        <span className="text-neutral-400 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 min-w-full max-w-[20rem] max-h-72 overflow-auto rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 shadow-lg p-1">
          {searchable && (
            <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 px-1 pt-1 pb-1.5 border-b dark:border-neutral-800 -m-1 mb-1">
              <input
                ref={searchInputRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder ?? "Search…"}
                onKeyDown={(e) => {
                  // Stop Escape from bubbling to onKey above (which would
                  // close the popover) when there's an active query.
                  // Pressing Esc on an empty search still closes — matches
                  // typical browser dropdown behavior.
                  if (e.key === "Escape" && search) {
                    e.stopPropagation();
                    setSearch("");
                  }
                }}
                className="w-full text-sm px-2 py-1.5 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            </div>
          )}
          <div className="flex items-center justify-between px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
            <span>{value.length} selected</span>
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          {main.length === 0 && tail.length === 0 && (
            <div className="px-2 py-2 text-xs text-neutral-500">
              {searchable && q ? "No matches" : "No options available"}
            </div>
          )}
          {main.map((o) => (
            <OptionRow
              key={o.value}
              option={o}
              checked={selected.has(o.value)}
              onToggle={() => toggle(o.value)}
            />
          ))}
          {tail.length > 0 && main.length > 0 && (
            <div className="my-1 border-t dark:border-neutral-800" />
          )}
          {tail.map((o) => (
            <OptionRow
              key={o.value}
              option={o}
              checked={selected.has(o.value)}
              onToggle={() => toggle(o.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  option,
  checked,
  onToggle,
}: {
  option: MultiSelectOption;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="rounded border-neutral-300 dark:border-neutral-700"
      />
      <span className="truncate text-sm">{option.label}</span>
    </label>
  );
}
