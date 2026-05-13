"use client";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

// Database nav dropdown (added 2026-05-13 wave L). The single "Database"
// link became a dropdown with two items: Analyze List (the existing
// /database page) and Ban List (the new /banlist page). The URL stays
// at /database so existing deep links don't break.
function DatabaseDropdown() {
  const { t } = useT();
  const ts = t.nav.databaseDropdown;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape — same affordance as a native
  // <select>; nothing on the page should require the dropdown to
  // remain open when focus moves away.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:text-neutral-900 dark:hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-sm"
      >
        {ts.label} <span className="opacity-60 text-xs">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 min-w-[12rem] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg z-20"
          role="menu"
        >
          <Link
            href="/database"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 first:rounded-t-md"
            role="menuitem"
          >
            {ts.analyzeList}
          </Link>
          <Link
            href="/banlist"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 last:rounded-b-md border-t border-neutral-200 dark:border-neutral-800"
            role="menuitem"
          >
            {ts.banList}
          </Link>
        </div>
      )}
    </div>
  );
}

export function HeaderShell() {
  const { t } = useT();
  return (
    <header className="border-b dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70 backdrop-blur sticky top-0 z-10">
      {/* 3-column grid: brand left, nav centered, controls right.
          Using grid (vs flex+ml-auto) so the nav is truly centered in
          the viewport and doesn't drift left/right as the brand or
          controls change width. */}
      <div className="max-w-screen-2xl mx-auto px-6 py-3 grid grid-cols-3 items-center gap-6">
        <Link href="/" className="font-semibold justify-self-start">
          {t.appName}
        </Link>
        <nav className="text-sm flex gap-4 text-neutral-600 dark:text-neutral-300 justify-self-center">
          <Link href="/">{t.nav.dashboard}</Link>
          <Link href="/backlog">{t.nav.backlog}</Link>
          <Link href="/analyze">{t.nav.analyze}</Link>
          <Link href="/jobs">{t.nav.jobs}</Link>
          <DatabaseDropdown />
          <Link href="/errors">{t.nav.errors}</Link>
          <Link href="/settings">{t.nav.settings}</Link>
          <Link href="/docs">Документация</Link>
        </nav>
        <div className="flex items-center gap-2 justify-self-end">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
