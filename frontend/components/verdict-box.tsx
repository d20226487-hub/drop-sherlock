"use client";
import { useT } from "@/lib/i18n";
import { CriterionVerdict } from "@/lib/api";
import { isLowConfidence } from "@/lib/score";

// Dark mode: neutral background + colored LEFT STRIPE only. See score.ts
// BUCKET_BANNER_TONE for the design rationale (3-iteration tuneup).
// Surface uses neutral-800 (slate `#1b2026`) at 80% opacity — clearly
// lifted off the body bg `#0b0d10` so the box reads as a distinct surface.
const VERDICT_TONE: Record<string, string> = {
  high_quality: "bg-emerald-50 text-emerald-900 border-emerald-200 border-l-4 border-l-emerald-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-emerald-500/70",
  mixed: "bg-amber-50 text-amber-900 border-amber-200 border-l-4 border-l-amber-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-amber-500/70",
  low_quality: "bg-red-50 text-red-900 border-red-200 border-l-4 border-l-red-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-red-500/70",
};

const ACCENT_TONE: Record<string, string> = {
  high_quality: "text-emerald-700 dark:text-emerald-300",
  mixed: "text-amber-700 dark:text-amber-300",
  low_quality: "text-red-700 dark:text-red-300",
};

const ACCENT_DOT: Record<string, string> = {
  high_quality: "bg-emerald-500 dark:bg-emerald-400",
  mixed: "bg-amber-500 dark:bg-amber-400",
  low_quality: "bg-red-500 dark:bg-red-400",
};

export function VerdictBox({
  verdict,
  error,
  cachedFromRunId,
  aiProvider,
  aiModel,
  criterionLabel,
  onReanalyze,
  reanalyzing,
}: {
  verdict: CriterionVerdict | null;
  error: string;
  cachedFromRunId?: number | null;
  aiProvider?: string;
  aiModel?: string;
  // Optional sub-label appended to the box heading. Used by the stacked-
  // verdicts section on the domain page so each of the 4 boxes is
  // self-identifying ("AI verdict · Backlinks"). Tab-mode callsites omit
  // it because the active tab already names the criterion.
  criterionLabel?: string;
  // When provided, renders a small "Re-judge this" button in the header.
  // The parent owns the actual API call + polling state — this is a thin
  // visual hook into the existing per-domain reanalyzing-state machinery.
  onReanalyze?: () => void;
  reanalyzing?: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.verdict;

  if (error) {
    return (
      <div className="rounded-md border border-red-200 border-l-4 border-l-red-500 dark:border-neutral-700 dark:border-l-red-500/70 bg-red-50 dark:bg-neutral-800/80 p-4 text-sm text-red-800 dark:text-neutral-200 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <strong className="text-red-700 dark:text-red-400">
              {ts.failed}
              {criterionLabel ? ` · ${criterionLabel}` : ""}:
            </strong>{" "}
            {error}
          </div>
          {onReanalyze && (
            <button
              type="button"
              onClick={onReanalyze}
              disabled={reanalyzing}
              className="text-xs px-2 py-0.5 rounded-md border border-red-300 dark:border-neutral-700 hover:bg-red-100 dark:hover:bg-neutral-700 text-red-700 dark:text-neutral-200 disabled:opacity-50 whitespace-nowrap"
              title={ts.reanalyzeHint}
            >
              {reanalyzing ? ts.reanalyzing : ts.reanalyzeButton}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!verdict) {
    return null;
  }

  // wayback_classify has no `assessment` field — it carries language +
  // theme + category instead. Detect shape via primary_theme/language
  // presence and render a different header (per-field confidences) +
  // structured body. Same wrapper styling so the box still looks like
  // every other verdict at a glance.
  const isClassify =
    verdict.primary_theme !== undefined || verdict.primary_language !== undefined;
  if (isClassify) {
    return (
      <ClassifyVerdictBox
        verdict={verdict}
        cachedFromRunId={cachedFromRunId}
        aiProvider={aiProvider}
        aiModel={aiModel}
        criterionLabel={criterionLabel}
        onReanalyze={onReanalyze}
        reanalyzing={reanalyzing}
      />
    );
  }

  const assessmentKey = verdict.assessment || "";
  const tone =
    VERDICT_TONE[assessmentKey] ||
    "bg-neutral-50 text-neutral-900 border-neutral-200 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700";
  const accent =
    ACCENT_TONE[assessmentKey] || "text-neutral-700 dark:text-neutral-300";
  const dot =
    ACCENT_DOT[assessmentKey] || "bg-neutral-400 dark:bg-neutral-500";
  const conf = Math.round((verdict.confidence ?? 0) * 100);

  return (
    <div className={`rounded-md border p-4 space-y-3 ${tone}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`font-semibold inline-flex items-center gap-2 ${accent}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
          {ts.heading}
          {criterionLabel && (
            <span className="opacity-70 font-normal">· {criterionLabel}</span>
          )}
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200">
          {ts.assessment}: <strong className={accent}>{verdict.assessment}</strong>
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200">
          {ts.confidence}: <strong className="text-neutral-900 dark:text-neutral-100">{conf}%</strong>
        </span>
        {cachedFromRunId != null && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100"
            title="Reused from a prior run with matching criteria + prompt"
          >
            {ts.cachedFromRun(cachedFromRunId)}
          </span>
        )}
        {(aiProvider || aiModel) && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200"
            title={`Verdict produced by ${aiProvider || "?"}${aiModel ? " / " + aiModel : ""}`}
          >
            {aiProvider}
            {aiModel ? ` · ${aiModel}` : ""}
          </span>
        )}
        {onReanalyze && (
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="ml-auto text-xs px-2 py-0.5 rounded-md border dark:border-neutral-700 hover:bg-white/60 dark:hover:bg-neutral-600 text-neutral-700 dark:text-neutral-200 disabled:opacity-50 whitespace-nowrap"
            title={ts.reanalyzeHint}
          >
            {reanalyzing ? ts.reanalyzing : ts.reanalyzeButton}
          </button>
        )}
      </div>
      {verdict.key_findings && verdict.key_findings.length > 0 && (
        <div>
          <p className="text-base font-semibold uppercase tracking-wide mb-2 text-neutral-700 dark:text-neutral-200">
            {ts.keyFindings}
          </p>
          <ul className="list-disc list-inside text-[15px] leading-relaxed space-y-1">
            {verdict.key_findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.red_flags && verdict.red_flags.length > 0 && (
        <div>
          <p className="text-base font-semibold uppercase tracking-wide mb-2 text-neutral-700 dark:text-neutral-200">
            {ts.redFlags}
          </p>
          <ul className="list-disc list-inside text-[15px] leading-relaxed space-y-1">
            {verdict.red_flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// wayback_classify VerdictBox variant. Same outer styling as the standard
// verdict box (so the row of 5 boxes on the domain page reads coherently)
// but the header carries per-field confidences (language + theme) instead
// of a single assessment/confidence pair, and the body is structured
// (Language / Theme / Category) instead of key_findings/red_flags lists.
function ClassifyVerdictBox({
  verdict,
  cachedFromRunId,
  aiProvider,
  aiModel,
  criterionLabel,
  onReanalyze,
  reanalyzing,
}: {
  verdict: CriterionVerdict;
  cachedFromRunId?: number | null;
  aiProvider?: string;
  aiModel?: string;
  criterionLabel?: string;
  onReanalyze?: () => void;
  reanalyzing?: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.verdict;
  const lang = verdict.primary_language || "";
  const theme = verdict.primary_theme || "";
  const langConf = verdict.language_confidence;
  const themeConf = verdict.theme_confidence;
  const drift = !!verdict.drift_detected;
  // 4-bucket tone scheme (2026-05-18) — matches the Database C chip:
  //   grey  → theme_confidence missing or below threshold
  //   red   → drift detected (site changed topics; SEO baggage)
  //   yellow → no drift, but multi-topic (≥1 secondary theme)
  //   green → no drift, single primary theme, high confidence
  // Yellow uses `yellow-*` (not amber) so the chip + box stay clearly
  // yellow in light mode — amber reads as orange there.
  const _secondaryThemesAll = (verdict.secondary_themes ?? []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const hasSecondaryThemes = _secondaryThemesAll.length > 0;
  const lowConf = themeConf == null || isLowConfidence(themeConf);
  type ClassifyBucket = "grey" | "good" | "mixed" | "bad";
  const bucket: ClassifyBucket = lowConf
    ? "grey"
    : drift
      ? "bad"
      : hasSecondaryThemes
        ? "mixed"
        : "good";
  const TONES: Record<ClassifyBucket, string> = {
    grey: "bg-neutral-50 text-neutral-700 border-neutral-200 border-l-4 border-l-neutral-400 dark:bg-neutral-800/80 dark:text-neutral-300 dark:border-neutral-700 dark:border-l-neutral-500",
    good: "bg-emerald-50 text-emerald-900 border-emerald-200 border-l-4 border-l-emerald-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-emerald-500/70",
    mixed: "bg-yellow-50 text-yellow-900 border-yellow-200 border-l-4 border-l-yellow-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-yellow-500/70",
    bad: "bg-red-50 text-red-900 border-red-200 border-l-4 border-l-red-500 dark:bg-neutral-800/80 dark:text-neutral-200 dark:border-neutral-700 dark:border-l-red-500/70",
  };
  const ACCENTS: Record<ClassifyBucket, string> = {
    grey: "text-neutral-600 dark:text-neutral-400",
    good: "text-emerald-700 dark:text-emerald-300",
    mixed: "text-yellow-700 dark:text-yellow-400",
    bad: "text-red-700 dark:text-red-300",
  };
  const DOTS: Record<ClassifyBucket, string> = {
    grey: "bg-neutral-400 dark:bg-neutral-500",
    good: "bg-emerald-500 dark:bg-emerald-400",
    mixed: "bg-yellow-500 dark:bg-yellow-400",
    bad: "bg-red-500 dark:bg-red-400",
  };
  const tone = TONES[bucket];
  const accent = ACCENTS[bucket];
  const dot = DOTS[bucket];
  const fmtConf = (c: number | undefined) =>
    typeof c === "number" ? `${Math.round(c * 100)}%` : "—";
  const secondaries = (verdict.secondary_languages ?? []).filter(Boolean);
  const secThemes = (verdict.secondary_themes ?? []).filter(Boolean);

  return (
    <div className={`rounded-md border p-4 space-y-3 ${tone}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`font-semibold inline-flex items-center gap-2 ${accent}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
          {ts.heading}
          {criterionLabel && (
            <span className="opacity-70 font-normal">· {criterionLabel}</span>
          )}
          {bucket !== "good" && (
            <span className="opacity-90 font-normal">
              · {
                bucket === "bad"
                  ? "drift detected"
                  : bucket === "mixed"
                    ? "multi-topic"
                    : "low confidence"
              }
            </span>
          )}
        </span>
        {lang && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200">
            Lang: <strong className="font-mono">{lang}</strong>{" "}
            <span className="opacity-70">({fmtConf(langConf)})</span>
          </span>
        )}
        {theme && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200">
            Theme: <strong>{theme}</strong>{" "}
            <span className="opacity-70">({fmtConf(themeConf)})</span>
          </span>
        )}
        {verdict.category && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100">
            Cat: <strong>{verdict.category}</strong>{" "}
            {verdict.category_confidence != null && (
              <span className="opacity-70">({fmtConf(verdict.category_confidence)})</span>
            )}
          </span>
        )}
        {cachedFromRunId != null && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-[#1a1030] dark:text-violet-100"
            title="Reused from a prior run with matching criteria + prompt"
          >
            {ts.cachedFromRun(cachedFromRunId)}
          </span>
        )}
        {(aiProvider || aiModel) && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-white/80 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-200"
            title={`Verdict produced by ${aiProvider || "?"}${aiModel ? " / " + aiModel : ""}`}
          >
            {aiProvider}
            {aiModel ? ` · ${aiModel}` : ""}
          </span>
        )}
        {onReanalyze && (
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="ml-auto text-xs px-2 py-0.5 rounded-md border dark:border-neutral-700 hover:bg-white/60 dark:hover:bg-neutral-600 text-neutral-700 dark:text-neutral-200 disabled:opacity-50 whitespace-nowrap"
            title={ts.reanalyzeHint}
          >
            {reanalyzing ? ts.reanalyzing : ts.reanalyzeButton}
          </button>
        )}
      </div>
      {(secondaries.length > 0 || secThemes.length > 0) && (
        <div className="text-[13px] text-neutral-700 dark:text-neutral-300 space-y-0.5">
          {secondaries.length > 0 && (
            <p>
              <span className="opacity-70">Also detected (lang):</span>{" "}
              <span className="font-mono">{secondaries.join(", ")}</span>
            </p>
          )}
          {secThemes.length > 0 && (
            <p>
              <span className="opacity-70">Also detected (theme):</span>{" "}
              {secThemes.join(", ")}
            </p>
          )}
        </div>
      )}
      {verdict.key_findings && verdict.key_findings.length > 0 && (
        <div>
          <p className="text-base font-semibold uppercase tracking-wide mb-2 text-neutral-700 dark:text-neutral-200">
            {ts.keyFindings}
          </p>
          <ul className="list-disc list-inside text-[15px] leading-relaxed space-y-1">
            {verdict.key_findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.red_flags && verdict.red_flags.length > 0 && (
        <div>
          <p className="text-base font-semibold uppercase tracking-wide mb-2 text-neutral-700 dark:text-neutral-200">
            {ts.redFlags}
          </p>
          <ul className="list-disc list-inside text-[15px] leading-relaxed space-y-1">
            {verdict.red_flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
