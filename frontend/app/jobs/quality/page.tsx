"use client";
// Wave 2b (2026-05-15): thin wrapper over the shared JobsListByKind
// component. The full implementation lives in
// `components/jobs-list-by-kind.tsx` so /jobs/whois-history and the
// future /jobs/availability page share the same archive / search /
// bulk-select / delete plumbing without duplication.
import { JobsListByKind } from "@/components/jobs-list-by-kind";

export default function JobsQualityListPage() {
  return <JobsListByKind kind="quality" />;
}
