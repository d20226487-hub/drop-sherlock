"use client";
// Shared placeholder body for the four pillar pages that haven't shipped
// yet (Wave 1 plumbing — Wave 2 builds WHOIS history, Wave 3 builds
// Availability as a first-class pillar). Centralized here so all four
// stubs stay in sync visually and label-wise; the per-route files just
// pass the title + which wave it lands in.
import Link from "next/link";
import { useT } from "@/lib/i18n";

export function PillarStubPage({
  title,
  // Short noun phrase shown under the title — e.g.
  // "Historical WHOIS drop detection".
  subtitle,
  // Which build wave will ship this page. Surfaces an honest "ETA-ish"
  // signal — vague enough to be true, concrete enough to be useful.
  wave,
}: {
  title: string;
  subtitle: string;
  wave: "wave_2" | "wave_3";
}) {
  const { t } = useT();
  const ts = t.pages.pillarStub;
  return (
    <div className="max-w-xl mx-auto py-16 text-center space-y-4">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {subtitle}
      </p>
      <div className="rounded-md border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        {ts.comingSoon}
        <div className="text-xs mt-1 opacity-80">
          {wave === "wave_2" ? ts.wave2 : ts.wave3}
        </div>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.architectureNote}
      </p>
      <Link
        href="/check/quality"
        className="inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {ts.useQuality} →
      </Link>
    </div>
  );
}
