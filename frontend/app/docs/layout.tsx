"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

// Sidebar navigation for the documentation section. Articles live under
// `/docs/<slug>`; this map drives both the sidebar and the index page's
// TOC. Russian-only by design — the user wants a single source of truth
// for documentation regardless of UI language.
const SECTIONS: { title: string; items: { slug: string; title: string }[] }[] = [
  {
    title: "Начало",
    items: [
      { slug: "", title: "Обзор" },
      { slug: "workflow", title: "Рабочий процесс drop-hunter" },
    ],
  },
  {
    title: "Разделы интерфейса",
    items: [
      { slug: "backlog", title: "Очередь (Backlog)" },
      { slug: "analyze", title: "Анализ" },
      { slug: "jobs", title: "Задачи" },
      { slug: "run", title: "Страница запуска" },
      { slug: "domain", title: "Страница домена" },
      { slug: "database", title: "База" },
      { slug: "banlist", title: "Ban List" },
      { slug: "errors", title: "Ошибки" },
      { slug: "settings", title: "Настройки" },
    ],
  },
  {
    // Per-pillar deep-dives (Wave 2 + Wave 3, added 2026-05-15). Each
    // page covers cost, data shape, settings, and per-domain view for
    // its pillar. Quality is documented across multiple existing pages
    // (run / domain / database / ahrefs-criteria), so it doesn't need
    // a dedicated entry here.
    title: "Пилары",
    items: [
      { slug: "whois-history", title: "Whois History" },
      { slug: "availability", title: "Availability" },
    ],
  },
  {
    title: "Концепции",
    items: [
      { slug: "ahrefs-criteria", title: "Ahrefs-критерии (B / D / A / K)" },
      { slug: "brain", title: "Brain — Scoring и Prompts" },
      { slug: "cache", title: "Кэш" },
      { slug: "pinning", title: "Закрепление (Pinning)" },
      { slug: "ai", title: "ИИ: провайдеры, модели, стоимость" },
      { slug: "wayback", title: "Wayback History" },
      { slug: "wayback-classify", title: "Wayback Classify" },
      { slug: "reanalyze", title: "Переоценка (Reanalyze)" },
    ],
  },
  {
    title: "Дополнительно",
    items: [
      { slug: "csv", title: "CSV: импорт и экспорт" },
      { slug: "backups", title: "Резервные копии" },
      { slug: "augmentation", title: "Augmentation chain" },
    ],
  },
];

export default function DocsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <aside className="lg:w-64 lg:shrink-0">
        <nav className="lg:sticky lg:top-20 space-y-5 text-sm">
          <div className="font-semibold text-base">Документация</div>
          {SECTIONS.map((section) => (
            <div key={section.title} className="space-y-1.5">
              <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
                {section.title}
              </div>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const href = item.slug ? `/docs/${item.slug}` : "/docs";
                  const active =
                    pathname === href ||
                    (item.slug && pathname === `/docs/${item.slug}`);
                  return (
                    <li key={item.slug || "index"}>
                      <Link
                        href={href}
                        className={
                          "block px-2 py-1 rounded -mx-2 " +
                          (active
                            ? "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 font-medium"
                            : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/60")
                        }
                      >
                        {item.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 max-w-4xl docs-content">
        {children}
      </main>
    </div>
  );
}
