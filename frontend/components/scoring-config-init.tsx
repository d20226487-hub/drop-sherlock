"use client";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { setScoringConfig } from "@/lib/score";

// One-shot bootstrap: fetch the persisted scoring config and seed the
// module-level cache in lib/score.ts. Renders nothing. Mounted in
// app/layout.tsx so it runs once per session, before any page that
// renders score buckets / low-confidence pills mounts. While the fetch
// is in flight (a few hundred ms locally) helpers fall back to the
// shipped defaults — same numbers, so the UI doesn't flicker.
export function ScoringConfigInit() {
  useEffect(() => {
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
  }, []);
  return null;
}
