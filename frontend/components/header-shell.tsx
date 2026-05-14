"use client";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

// Database nav hover-menu (added 2026-05-13 wave L; switched from
// click-dropdown to hover 2026-05-14 wave N because the button-based
// trigger was perturbing the flex-row baseline and shifting siblings
// upward). Trigger is now a plain <Link> to /database so default
// click-through behavior is preserved (matches every other nav item
// in shape and height); the menu opens on hover.
function DatabaseDropdown() {
  const { t } = useT();
  const ts = t.nav.databaseDropdown;
  const [open, setOpen] = useState(false);
  // Tiny close-delay so the cursor can travel from trigger to menu
  // without the menu vanishing. 120ms is short enough to feel
  // responsive and long enough to cover the gap.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNow = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const closeLater = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 120);
  };

  // Keyboard fallback: Escape closes immediately (otherwise a hover
  // user who tab-navigated here has no escape hatch).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Cleanup the timer if the component unmounts mid-delay.
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div
      className="relative"
      onMouseEnter={openNow}
      onMouseLeave={closeLater}
      onFocus={openNow}
      onBlur={closeLater}
    >
      <Link
        href="/database"
        className="hover:text-neutral-900 dark:hover:text-neutral-100"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {ts.label}
      </Link>
      {open && (
        <div
          className="absolute left-0 top-full pt-1 min-w-[12rem] z-20"
          role="menu"
        >
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg">
            <Link
              href="/database"
              className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 first:rounded-t-md"
              role="menuitem"
            >
              {ts.analyzeList}
            </Link>
            <Link
              href="/banlist"
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
