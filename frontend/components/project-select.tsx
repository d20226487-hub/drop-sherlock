"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { api, ProjectOption } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Searchable project dropdown for the Quality job form (2026-11-09). Only
// projects from Settings → Projects can be picked, so spend is always
// booked to a real, consistently named project. Type to filter; ↑/↓ and
// Enter to pick; Esc or a click outside closes.
export function ProjectSelect({
  value,
  onChange,
  id,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  id?: string;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.jobProject;
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.allProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const selected = projects?.find((p) => p.id === value) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const all = projects ?? [];
    return q ? all.filter((p) => p.name.toLocaleLowerCase().includes(q)) : all;
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(p: ProjectOption) {
    onChange(p.id);
    setOpen(false);
    setQuery("");
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active]) pick(matches[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm text-left outline-none focus:ring-2 focus:ring-blue-500/40 inline-flex items-center gap-2"
      >
        <span className={"flex-1 truncate " + (selected ? "" : "text-neutral-400")}>
          {selected ? selected.name : ts.placeholder}
        </span>
        {selected && (
          <X
            className="w-3.5 h-3.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            aria-label={ts.clear}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          />
        )}
        <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg">
          <div className="relative border-b dark:border-neutral-800">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              placeholder={ts.search}
              className="w-full bg-transparent pl-7 pr-3 py-2 text-sm outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
            {projects === null ? (
              <li className="px-3 py-2 text-sm text-neutral-500">{t.common.loading}</li>
            ) : matches.length === 0 ? (
              <li className="px-3 py-2 text-sm text-neutral-500">
                {projects.length === 0 ? ts.none : ts.noMatch}
              </li>
            ) : (
              matches.map((p, i) => (
                <li
                  key={p.id}
                  role="option"
                  aria-selected={p.id === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                  className={
                    "px-3 py-1.5 text-sm cursor-pointer truncate " +
                    (i === active ? "bg-blue-50 dark:bg-blue-950/40 " : "") +
                    (p.id === value ? "font-semibold" : "")
                  }
                >
                  {p.name}
                </li>
              ))
            )}
          </ul>
          <div className="border-t dark:border-neutral-800 px-3 py-1.5 text-xs">
            <Link href="/settings?tab=projects" className="text-blue-700 dark:text-blue-300 hover:underline">
              {ts.manage}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
