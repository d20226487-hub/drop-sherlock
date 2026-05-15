// Wave 1 (2026-05-15): /jobs (list) moved to /jobs/quality. Per-job
// detail pages (/jobs/[id], /jobs/[id]/runs/[runId]/...) stay at their
// original paths and are kind-agnostic — they look up the job and
// render based on its `kind`. Only the LIST route was forked per
// pillar. This redirect preserves any external bookmarks.
import { redirect } from "next/navigation";

export default async function JobsRedirect({
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
  redirect(q ? `/jobs/quality?${q}` : "/jobs/quality");
}
