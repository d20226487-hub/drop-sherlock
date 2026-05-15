"use client";
// Wave 3 (2026-05-15): real Jobs list for the availability pillar.
// Replaces the "Coming soon" stub. Same JobsListByKind shared
// component the Whois pillar uses — kind filter applied to
// api.listJobs.
import { JobsListByKind } from "@/components/jobs-list-by-kind";

export default function JobsAvailabilityListPage() {
  return <JobsListByKind kind="availability" />;
}
