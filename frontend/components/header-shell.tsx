"use client";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

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
          <Link href="/database">{t.nav.database}</Link>
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
