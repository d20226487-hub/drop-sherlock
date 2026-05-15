"use client";
// Wave 2b (2026-05-15): real Jobs list for the whois_history pillar.
// Replaces the "Coming soon" stub. Shares the JobsListByKind component
// with /jobs/quality — same archive / bulk / search machinery, kind
// filter applied to api.listJobs.
import { JobsListByKind } from "@/components/jobs-list-by-kind";

export default function JobsWhoisHistoryListPage() {
  return <JobsListByKind kind="whois_history" />;
}
