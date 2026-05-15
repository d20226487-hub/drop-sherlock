// Wave 1 (2026-05-15): /analyze moved to /check/quality as part of the
// 3-pillar restructure. This thin server-side redirect preserves old
// bookmarks and any in-app links that pre-date the rename. Server
// component (no "use client") so it runs at request time without a
// client bundle — and Next.js's `redirect()` handles it as a 307.
// searchParams come straight from page props so query strings are
// preserved without needing `useSearchParams` + Suspense.
import { redirect } from "next/navigation";

export default async function AnalyzeRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, x);
    else qs.append(k, v);
  }
  const q = qs.toString();
  redirect(q ? `/check/quality?${q}` : "/check/quality");
}
