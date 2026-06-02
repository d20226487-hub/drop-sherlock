"use client";
// Jobs list for the Ahrefs Batch Analysis pillar (2026-06-02). Same
// shared JobsListByKind component the other pillars use — kind filter
// applied to api.listJobs.
import { JobsListByKind } from "@/components/jobs-list-by-kind";

export default function JobsAhrefsBatchAnalysisListPage() {
  return <JobsListByKind kind="ahrefs_batch_analysis" />;
}
