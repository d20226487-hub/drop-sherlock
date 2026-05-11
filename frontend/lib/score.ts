// Final-assessment helpers.
//
// Final score (0–100) is computed deterministically in the runner from
// per-criterion (assessment, confidence) verdicts (see backend
// scoring.py). Bucket → tone:
//   80–100  → good      (green)
//   60–80   → mixed     (amber)
//    < 60   → low_quality (red)
//
// Confidence override: if the AI's confidence in a verdict is below the
// LOW_CONFIDENCE_THRESHOLD, the pill renders GREY regardless of value.
// Signals "don't trust this number yet, the model wasn't sure." Same rule
// applies to per-criterion pills so the table stays consistent.

// --- Runtime-mutable scoring config ---------------------------------------
//
// The backend holds the source-of-truth scoring config (weights + bucket
// thresholds + low-confidence threshold). On app mount, ScoringConfigInit
// fetches it via api.getScoringConfig() and calls setScoringConfig(...).
// All helpers below read from this cache. While not yet loaded, the
// fallback defaults below match the original locked values from project
// memory — same numbers we used before this became configurable.

type ScoringConfigCache = {
  goodThreshold: number;
  mixedThreshold: number;
  lowConfidenceThreshold: number;
};

const DEFAULT_CACHE: ScoringConfigCache = {
  goodThreshold: 80,
  mixedThreshold: 60,
  lowConfidenceThreshold: 0.5,
};

let currentConfig: ScoringConfigCache = { ...DEFAULT_CACHE };

export function setScoringConfig(cfg: {
  good_threshold?: number;
  mixed_threshold?: number;
  low_confidence_threshold?: number;
}): void {
  if (typeof cfg.good_threshold === "number") {
    currentConfig.goodThreshold = cfg.good_threshold;
  }
  if (typeof cfg.mixed_threshold === "number") {
    currentConfig.mixedThreshold = cfg.mixed_threshold;
  }
  if (typeof cfg.low_confidence_threshold === "number") {
    currentConfig.lowConfidenceThreshold = cfg.low_confidence_threshold;
  }
}

/** Below this, both criterion verdicts and the aggregated final score
 * render grey instead of the bucketed color. Default 0.5 — under that
 * the model is "less sure than a coin flip." Configurable via the
 * Settings page; the persisted value is loaded into `currentConfig`
 * on app mount. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

// Dark-mode tones intentionally use the deepest -950 color shade with low
// opacity so they read as muted accents instead of saturated 90s-website
// blocks. Light-mode unchanged — the -100/-800 pairing is already gentle.
// Low-confidence pill: bg solidified (was /60 → opaque) and text lifted
// from neutral-400 to neutral-300 — the prior combo was illegible against
// the table background.
const LOW_CONFIDENCE_PILL_TONE =
  "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
const LOW_CONFIDENCE_BANNER_TONE =
  "bg-neutral-50 text-neutral-700 border-neutral-200 border-l-4 border-l-neutral-400 dark:bg-neutral-800/80 dark:text-neutral-400 dark:border-neutral-700 dark:border-l-neutral-600";

export function isLowConfidence(
  confidence: number | null | undefined,
): boolean {
  return (
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence < currentConfig.lowConfidenceThreshold
  );
}

export type FinalBucket = "good" | "mixed" | "low_quality";

export function parseFinalScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const m = value.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function scoreToBucket(score: number): FinalBucket {
  if (score >= currentConfig.goodThreshold) return "good";
  if (score >= currentConfig.mixedThreshold) return "mixed";
  return "low_quality";
}

/** Map a legacy text label onto the new bucket vocabulary. Returns null
 * if the input isn't a recognized label. */
export function labelToBucket(value: unknown): FinalBucket | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (s === "good" || s === "quality" || s === "high_quality") return "good";
  if (s === "mixed") return "mixed";
  if (s === "low_quality" || s === "low") return "low_quality";
  return null;
}

const BUCKET_TONE: Record<FinalBucket, string> = {
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  // Amber needs a slightly stronger bg + lighter text than the others —
  // amber-950 is the brownest -950 shade and amber-300 on it reads flat.
  // bg-amber-900/40 is a touch more present; text-amber-200 lifts contrast
  // without venturing into neon territory.
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  low_quality: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
};

// Dark mode: barely-there bg tint (neutral, NOT bucket-colored) + a colored
// LEFT STRIPE that carries the bucket signal. Body text neutral. This was a
// 3-iteration design — saturated `dark:bg-{c}-900/40` was "90s look",
// reducing to `-950/30` was still too colored. The stripe pattern matches
// GitHub callouts and Linear annotations: instant recognition without
// flooding the section with color.
const BUCKET_BANNER_TONE: Record<FinalBucket, string> = {
  good: "bg-emerald-50 text-emerald-900 border-emerald-300 border-l-4 border-l-emerald-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-emerald-500/70",
  mixed: "bg-amber-50 text-amber-900 border-amber-300 border-l-4 border-l-amber-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-amber-500/70",
  low_quality: "bg-red-50 text-red-900 border-red-300 border-l-4 border-l-red-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-red-500/70",
};

/** Bucket-keyed accent text class — for the small heading word ("Final
 * assessment", "AI verdict") and the bucket-label badges. Dark mode uses
 * `-300` (not `-400`) because the small text needs higher contrast against
 * the muted neutral banner background to stay readable. The colored dots
 * (rendered as 6px solid blocks) stay at `-400`/`-500` since saturation
 * doesn't matter at that size. */
const BUCKET_ACCENT_TONE: Record<FinalBucket, string> = {
  good: "text-emerald-700 dark:text-emerald-300",
  mixed: "text-amber-700 dark:text-amber-300",
  low_quality: "text-red-700 dark:text-red-300",
};

export function bucketAccentTone(bucket: FinalBucket): string {
  return BUCKET_ACCENT_TONE[bucket];
}

export function bucketPillTone(bucket: FinalBucket): string {
  return BUCKET_TONE[bucket];
}

export function bucketBannerTone(bucket: FinalBucket): string {
  return BUCKET_BANNER_TONE[bucket];
}

/** Bucket-tone with the grey-on-low-confidence override applied. Use this
 * for any pill that has an associated AI confidence — when the model
 * wasn't sure, the user shouldn't trust the color either. */
export function pillToneWithConfidence(
  bucket: FinalBucket,
  confidence: number | null | undefined,
): string {
  return isLowConfidence(confidence)
    ? LOW_CONFIDENCE_PILL_TONE
    : BUCKET_TONE[bucket];
}

export function bannerToneWithConfidence(
  bucket: FinalBucket,
  confidence: number | null | undefined,
): string {
  return isLowConfidence(confidence)
    ? LOW_CONFIDENCE_BANNER_TONE
    : BUCKET_BANNER_TONE[bucket];
}

/** Per-criterion verdict pill tone — same rule applies. Maps the legacy
 * assessment label ("high_quality"/"mixed"/"low_quality") to a tone via
 * `labelToBucket`, then applies the grey override. */
export function criterionPillTone(
  assessment: string | null,
  confidence: number | null | undefined,
): string {
  const bucket = labelToBucket(assessment);
  if (!bucket) {
    return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300";
  }
  return pillToneWithConfidence(bucket, confidence);
}

/** Format a final score as a percentage string for display. */
export function formatScore(score: number): string {
  return `${Math.round(score)}%`;
}
