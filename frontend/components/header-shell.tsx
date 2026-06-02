"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

// One nav-dropdown component for all three uses (Check / Jobs /
// Database). Wave-15 rewrite (2026-05-15): replaces the prior two
// near-identical components (DatabaseDropdown + NavDropdown) with
// one reusable surface that ALSO upgrades the interaction:
//
//   • Active highlight on both the trigger and the currently-active
//     item when the URL matches one of the items.
//   • Real keyboard navigation: Down/Up walks items, Enter activates,
//     Home/End jumps, Esc closes + restores focus to the trigger.
//   • SVG chevron that rotates on open (vs the prior Unicode glyph
//     with `-my-1` layout hacks).
//   • Single trigger affordance (chevron baked into the trigger), no
//     more "two clickable spots" awkwardness.
//   • Click trigger → primary destination (e.g. /jobs/quality). Hover
//     OR focus → open menu. Chevron click toggles. Same gestures all
//     mouse + touch + keyboard.
//   • Items deduped: if `triggerHref` matches an item.href, the
//     menu drops that item (no more "Database / Database" repeat).
//   • 120ms hover-out grace so the cursor can travel from trigger to
//     menu without the menu vanishing.

type NavDropdownItem = { href: string; label: string };

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      aria-hidden
      className={
        "transition-transform duration-100 ease-out " +
        (open ? "rotate-180" : "")
      }
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function NavDropdown({
  triggerLabel,
  toggleAria,
  items,
}: {
  triggerLabel: string;
  toggleAria: string;
  items: NavDropdownItem[];
}) {
  const pathname = usePathname() || "";
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The trigger is a menu button — clicking it just opens the menu so
  // the user always picks from all N items (no implicit default
  // route, no item duplicating the trigger). Pre-2026-05-15 the
  // trigger was also a navigable Link to the most-common item; we
  // removed that because it confused the gesture ("did I want to go
  // there, or just open the menu?") and forced a dedupe of the
  // matching item.
  const visibleItems = items;

  // Per-item + per-trigger active match. Active when the current path
  // equals the href OR starts with `${href}/` so deep pages light up
  // their pillar (e.g. /jobs/whois-history/42 lights up the "Whois
  // history" item AND tints the Jobs trigger).
  const matches = useCallback(
    (href: string) =>
      pathname === href || pathname.startsWith(`${href}/`),
    [pathname],
  );
  const triggerActive = items.some((it) => matches(it.href));

  const openNow = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }, []);
  const closeNow = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(false);
  }, []);
  const closeLater = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 120);
  }, []);

  // Outside-click + Escape both dismiss. Escape also restores focus
  // back to the trigger so keyboard users don't lose their place.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Keyboard nav within the open menu. Down/Up walk items, Home/End
  // jump to the edges, Tab closes (let focus exit naturally).
  const handleItemKey = (
    e: ReactKeyboardEvent<HTMLAnchorElement>,
    index: number,
  ) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (index + 1) % visibleItems.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (index - 1 + visibleItems.length) % visibleItems.length;
      itemRefs.current[prev]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemRefs.current[visibleItems.length - 1]?.focus();
    } else if (e.key === "Tab") {
      // Let Tab move focus out naturally and close the menu so it
      // doesn't linger over content the user has tabbed past.
      setOpen(false);
    }
  };

  // Trigger key handler: Down arrow opens the menu and focuses item 0;
  // Up arrow opens and focuses the last item. Enter/Space toggle is
  // handled by the native button.
  const handleTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => itemRefs.current[0]?.focus());
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        const last = itemRefs.current[visibleItems.length - 1];
        last?.focus();
      });
    }
  };

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={openNow}
      onMouseLeave={closeLater}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeNow() : openNow())}
        onFocus={openNow}
        onKeyDown={handleTriggerKey}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={triggerActive ? "page" : undefined}
        className={
          "inline-flex items-center gap-1 px-1 py-0.5 rounded-md transition-colors " +
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 " +
          "cursor-pointer bg-transparent border-0 text-sm font-[inherit] " +
          (triggerActive
            ? "text-neutral-900 dark:text-neutral-100 font-medium"
            : "text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100")
        }
      >
        <span>{triggerLabel}</span>
        {/* Chevron rotates 180° on open so the trigger always tells
            you whether the menu is showing. */}
        <ChevronIcon open={open} />
        <span className="sr-only">{toggleAria}</span>
      </button>
      {/* Invisible bridge between trigger and menu so the cursor can
          travel without leaving the wrapper's hover area. `pt-1.5`
          renders as space the menu rounded-rect doesn't occupy. */}
      {open && (
        <div
          className="absolute left-0 top-full pt-1.5 min-w-[12rem] z-20"
          role="menu"
        >
          <div
            className={
              "rounded-lg border border-neutral-200 dark:border-neutral-800 " +
              "bg-white dark:bg-neutral-900 shadow-lg shadow-black/5 dark:shadow-black/20 " +
              "py-1 divide-y divide-neutral-100 dark:divide-neutral-800/60"
            }
          >
            {visibleItems.map((it, i) => {
              const isActive = matches(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  onClick={closeNow}
                  onKeyDown={(e) => handleItemKey(e, i)}
                  role="menuitem"
                  aria-current={isActive ? "page" : undefined}
                  className={
                    "flex items-center justify-between px-3 py-2 text-sm transition-colors " +
                    (isActive
                      ? "text-blue-700 dark:text-blue-300 font-medium bg-blue-50/60 dark:bg-blue-950/30"
                      : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800/70")
                  }
                >
                  <span>{it.label}</span>
                  {isActive && (
                    <span
                      aria-hidden
                      className="ml-3 text-[0.7em] text-blue-700/80 dark:text-blue-300/80"
                    >
                      ●
                    </span>
                  )}
                </Link>
              );
            })}
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
  // leak the operator surface area to recipients.
  const pathname = usePathname() || "";
  if (pathname.startsWith("/share/")) return null;

  // Highlight non-dropdown nav links when the current path matches
  // them (or is nested under them). Same active-state semantic as
  // the dropdowns so everything in the nav looks consistent.
  const isActiveLink = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const linkClass = (href: string) =>
    "px-1 py-0.5 rounded-md transition-colors " +
    (isActiveLink(href)
      ? "text-neutral-900 dark:text-neutral-100 font-medium"
      : "text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100");

  return (
    <header className="border-b dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/70 backdrop-blur sticky top-0 z-10">
      {/* 3-column grid: brand left, nav centered, controls right.
          Using grid (vs flex+ml-auto) so the nav is truly centered in
          the viewport and doesn't drift as the brand or controls
          change width. */}
      <div className="max-w-screen-2xl mx-auto px-6 py-3 grid grid-cols-3 items-center gap-6">
        <Link
          href="/"
          className={
            "font-semibold justify-self-start transition-colors " +
            (pathname === "/"
              ? "text-neutral-900 dark:text-neutral-100"
              : "hover:text-neutral-900 dark:hover:text-neutral-100")
          }
        >
          {t.appName}
        </Link>
        <nav className="text-sm flex items-center gap-3 justify-self-center">
          <Link href="/" className={linkClass("/")}>
            {t.nav.dashboard}
          </Link>
          <Link href="/backlog" className={linkClass("/backlog")}>
            {t.nav.backlog}
          </Link>
          <NavDropdown
            triggerLabel={t.nav.check}
            toggleAria={t.nav.checkDropdown.toggleAria}
            items={[
              {
                href: "/check/availability",
                label: t.nav.checkDropdown.availability,
              },
              {
                href: "/check/ahrefs-batch-analysis",
                label: t.nav.checkDropdown.ahrefsBatchAnalysis,
              },
              {
                href: "/check/whois-history",
                label: t.nav.checkDropdown.whoisHistory,
              },
              { href: "/check/quality", label: t.nav.checkDropdown.quality },
            ]}
          />
          <NavDropdown
            triggerLabel={t.nav.jobs}
            toggleAria={t.nav.jobsDropdown.toggleAria}
            items={[
              {
                href: "/jobs/availability",
                label: t.nav.jobsDropdown.availability,
              },
              {
                href: "/jobs/ahrefs-batch-analysis",
                label: t.nav.jobsDropdown.ahrefsBatchAnalysis,
              },
              {
                href: "/jobs/whois-history",
                label: t.nav.jobsDropdown.whoisHistory,
              },
              { href: "/jobs/quality", label: t.nav.jobsDropdown.quality },
            ]}
          />
          <NavDropdown
            triggerLabel={t.nav.databaseDropdown.label}
            toggleAria={t.nav.databaseDropdown.toggleAria}
            items={[
              {
                href: "/database",
                label: t.nav.databaseDropdown.analyzeList,
              },
              { href: "/banlist", label: t.nav.databaseDropdown.banList },
            ]}
          />
          <Link href="/shares" className={linkClass("/shares")}>
            {t.nav.shares}
          </Link>
          {/* Tools — ad-hoc experimentation surface, not wired into
              the Job/Run/CR pipeline. Two tools today:
                - Ahrefs (/tools/ahrefs-batch-analysis) — bulk
                  /batch-analysis metrics + /keywords-history probe
                - Wayback (added 2026-05-23) — bulk total-capture-count
                  via the sparkline endpoint at ~0.5s/domain
              Both are DEV/operator-only so labels are hardcoded
              (no i18n entry yet). */}
          <NavDropdown
            triggerLabel="Tools"
            toggleAria="Open Tools menu"
            items={[
              { href: "/tools/ahrefs-batch-analysis", label: "Ahrefs" },
              { href: "/tools/wayback", label: "Wayback" },
            ]}
          />
          <Link href="/errors" className={linkClass("/errors")}>
            {t.nav.errors}
          </Link>
          <Link href="/settings" className={linkClass("/settings")}>
            {t.nav.settings}
          </Link>
          <Link href="/docs" className={linkClass("/docs")}>
            Документация
          </Link>
        </nav>
        <div className="flex items-center gap-2 justify-self-end">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
