"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { setScoringConfig } from "@/lib/score";

// One-shot bootstrap: fetch the persisted scoring config and seed the
// module-level cache in lib/score.ts. Renders nothing. Mounted in
// app/layout.tsx so it runs once per session, before any page that
// renders score buckets / low-confidence pills mounts. While the fetch
// is in flight (a few hundred ms locally) helpers fall back to the
// shipped defaults — same numbers, so the UI doesn't flicker.
//
// Skipped on /share/* pages: the public share viewer doesn't have
// basic-auth credentials, so a GET to /api/settings/scoring would 401
// with `WWW-Authenticate: Basic`, which the browser turns into an
// auth dialog — exactly what the view-only share feature is supposed
// to avoid. Score helpers fall back to the shipped defaults on those
// pages, which match what the backend used to compute the verdict in
// the first place.
export function ScoringConfigInit() {
  const pathname = usePathname() || "";
  const isPublicShare = pathname.startsWith("/share/");
  useEffect(() => {
    if (isPublicShare) return;
    let cancelled = false;
    api
      .getScoringConfig()
      .then((env) => {
        if (cancelled) return;
        setScoringConfig(env.config);
      })
      .catch(() => {
        // Network failure / first-boot before backend is ready — leave
        // defaults in place, the user gets a working UI either way.
      });
    return () => {
      cancelled = true;
    };
  }, [isPublicShare]);
  return null;
}
