"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

// Generic pillar dropdown for the Check + Jobs nav entries (Wave 1,
// 2026-05-15). Same hover-with-grace + click-toggle + outside-click
// behavior as DatabaseDropdown above. The trigger is a Link to the
// `quality` route (the default pillar) so a plain click on the label
// keeps the legacy /analyze + /jobs UX; the chevron button opens the
// menu for users who want to switch pillars.
//
// Kept separate from DatabaseDropdown rather than refactored into one
// shared component — the Database one has a slightly different item
// shape (Database vs Ban List, no pillar discriminator) and merging the
// two would just bury the simple shape behind a config blob.
function NavDropdown({
  triggerHref,
  triggerLabel,
  toggleAria,
  items,
}: {
  triggerHref: string;
  triggerLabel: string;
  toggleAria: string;
  // Each item gets its own line in the dropdown body. Order matters —
  // Quality first (the default/most-used), then the two newer pillars.
  items: { href: string; label: string }[];
}) {
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
  const closeLater = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 120);
  };

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
        href={triggerHref}
        className="hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        {triggerLabel}
      </Link>
      <button
        type="button"
        onClick={() => (open ? closeNow() : openNow())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={toggleAria}
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
            {items.map((it, i) => (
              <Link
                key={it.href}
                href={it.href}
                onClick={closeNow}
                className={
                  "block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 " +
                  (i === 0 ? "first:rounded-t-md " : "") +
                  (i === items.length - 1
                    ? "last:rounded-b-md border-t border-neutral-200 dark:border-neutral-800 "
                    : i > 0
                      ? "border-t border-neutral-200 dark:border-neutral-800 "
                      : "")
                }
                role="menuitem"
              >
                {it.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function HeaderShell() {
  const { t } = useT();
  // Public share pages render their own minimal header (no operator
  // nav). Detect by path prefix so the basic-auth-free pages don't
  // leak the operator surface area to recipients — even though clicking
  // those links would prompt for basicauth, the mere presence of
  // "Settings" / "Errors" / etc. would be confusing on a "view this
  // analysis" page meant for a client.
  const pathname = usePathname() || "";
  if (pathname.startsWith("/share/")) return null;
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
          {/* Wave 1 (2026-05-15): single Analyze + Jobs links are now
              dropdowns that switch between the three pillars (Quality
              today; Whois History + Availability ship in waves 2/3).
              Trigger label clicks go to /check/quality and
              /jobs/quality respectively, preserving the most-common
              path the user already hits. */}
          <NavDropdown
            triggerHref="/check/quality"
            triggerLabel={t.nav.check}
            toggleAria={t.nav.checkDropdown.toggleAria}
            items={[
              { href: "/check/quality", label: t.nav.checkDropdown.quality },
              {
                href: "/check/whois-history",
                label: t.nav.checkDropdown.whoisHistory,
              },
              {
                href: "/check/availability",
                label: t.nav.checkDropdown.availability,
              },
            ]}
          />
          <NavDropdown
            triggerHref="/jobs/quality"
            triggerLabel={t.nav.jobs}
            toggleAria={t.nav.jobsDropdown.toggleAria}
            items={[
              { href: "/jobs/quality", label: t.nav.jobsDropdown.quality },
              {
                href: "/jobs/whois-history",
                label: t.nav.jobsDropdown.whoisHistory,
              },
              {
                href: "/jobs/availability",
                label: t.nav.jobsDropdown.availability,
              },
            ]}
          />
          <DatabaseDropdown />
          <Link href="/shares">{t.nav.shares}</Link>
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
