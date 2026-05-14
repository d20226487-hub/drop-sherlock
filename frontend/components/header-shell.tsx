"use client";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

// Database nav menu. History: started as click-dropdown (wave L), moved
// to hover (wave N — button trigger was shifting the flex baseline),
// now hybrid (2026-05-14): plain <Link> trigger for navigation +
// adjacent chevron BUTTON that toggles the menu on click. Hover still
// opens it for mouse users; the chevron makes touch + keyboard work.
// Outside-click closes.
function DatabaseDropdown() {
  const { t } = useT();
  const ts = t.nav.databaseDropdown;
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const openNow = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const closeNow = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(false);
  };
  // 120ms hover-leave grace so the cursor can travel from trigger to
  // menu without the menu vanishing.
  const closeLater = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 120);
  };

  // Escape closes immediately; outside-click closes too (click outside
  // is the universal "dismiss" expectation for click-opened menus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative inline-flex items-center gap-0.5"
      onMouseEnter={openNow}
      onMouseLeave={closeLater}
    >
      <Link
        href="/database"
        className="hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        {ts.label}
      </Link>
      <button
        type="button"
        onClick={() => (open ? closeNow() : openNow())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ts.toggleAria}
        className="leading-none px-0.5 -my-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
      >
        <span aria-hidden className="text-[0.7em] select-none">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full pt-1 min-w-[12rem] z-20"
          role="menu"
        >
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg">
            <Link
              href="/database"
              onClick={closeNow}
              className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 first:rounded-t-md"
              role="menuitem"
            >
              {ts.analyzeList}
            </Link>
            <Link
              href="/banlist"
              onClick={closeNow}
              className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 last:rounded-b-md border-t border-neutral-200 dark:border-neutral-800"
              role="menuitem"
            >
              {ts.banList}
            </Link>
          </div>
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
