"use client";
import {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, RunDomainDetail } from "@/lib/api";
import { useT } from "@/lib/i18n";

// LRU cache keyed by run_domain_id. Survives across rows (and unmounts
// of the trigger) so the second hover never re-fetches the same
// payload. Capped to keep an open Database tab from growing memory
// unboundedly when the user scrolls/hovers through hundreds of rows.
// Map's iteration-order = insertion-order; deleting and re-setting on
// access is the canonical JS idiom for LRU semantics.
const CACHE_MAX = 200;
const cache = new Map<number, RunDomainDetail>();

function cacheGet(id: number): RunDomainDetail | undefined {
  const v = cache.get(id);
  if (v !== undefined) {
    // Touch for recency — re-insert moves it to the end of iteration.
    cache.delete(id);
    cache.set(id, v);
  }
  return v;
}

function cachePut(id: number, value: RunDomainDetail): void {
  if (cache.has(id)) cache.delete(id);
  cache.set(id, value);
  if (cache.size > CACHE_MAX) {
    // Drop the oldest (first inserted) entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const HOVER_DELAY_MS = 250;
const HIDE_DELAY_MS = 200;

// "final" mode — Ahrefs column. Show the final summary + recommendation
// only (the aggregated prose). Per-criterion bullets are intentionally
// omitted: they bloat the popover and the user can click into the domain
// page for the full breakdown.
//
// "criterion" mode — per-criterion column (e.g. Wayback). Show that
// single criterion's assessment + key findings + red flags. The final
// summary is irrelevant here because the column doesn't represent the
// aggregated verdict.
type Mode =
  | { mode: "final" }
  | { mode: "criterion"; criterion: string };

type Props = {
  runDomainId: number;
  children: ReactNode;
} & Mode;

/** Wraps any element. On hover (after a short delay) lazy-fetches the
 * run-domain detail and shows a small popover.
 *
 * No backend changes required: the data already lives on
 * `getRunDomain(id)`. The fetch is one-shot per id (process-cached). */
export function VerdictHoverCard(props: Props) {
  const { runDomainId, children } = props;
  const { t } = useT();
  const [detail, setDetail] = useState<RunDomainDetail | null>(
    cacheGet(runDomainId) ?? null,
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  const cancelTimers = useCallback(() => {
    if (showTimer.current) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  useEffect(() => () => cancelTimers(), [cancelTimers]);

  const ensureFetched = useCallback(async () => {
    const cached = cacheGet(runDomainId);
    if (cached) {
      setDetail(cached);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRunDomain(runDomainId);
      cachePut(runDomainId, data);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runDomainId]);

  const positionPopover = useCallback(() => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_W = 360;
    const left = Math.max(
      8,
      Math.min(window.innerWidth - POP_W - 8, rect.left),
    );
    const top = rect.bottom + 6;
    setPopPos({ top, left });
  }, []);

  const handleEnter = useCallback(() => {
    cancelTimers();
    showTimer.current = window.setTimeout(() => {
      positionPopover();
      setOpen(true);
      void ensureFetched();
    }, HOVER_DELAY_MS);
  }, [cancelTimers, ensureFetched, positionPopover]);

  const handleLeave = useCallback(() => {
    cancelTimers();
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, [cancelTimers]);

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
      >
        {children}
      </span>
      {open && popPos && (
        <div
          role="tooltip"
          onMouseEnter={cancelTimers}
          onMouseLeave={handleLeave}
          style={{
            position: "fixed",
            top: popPos.top,
            left: popPos.left,
            width: 360,
            zIndex: 50,
          }}
          className="pointer-events-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl p-3 text-xs"
        >
          {loading && !detail && (
            <div className="text-neutral-500">{t.common.loading}</div>
          )}
          {error && (
            <div className="text-rose-600 dark:text-rose-400">
              {t.common.error}: {error}
            </div>
          )}
          {detail && props.mode === "final" && (
            <FinalBody detail={detail} />
          )}
          {detail && props.mode === "criterion" && (
            <CriterionBody detail={detail} criterion={props.criterion} />
          )}
        </div>
      )}
    </>
  );
}

function FinalBody({ detail }: { detail: RunDomainDetail }) {
  const { t } = useT();
  const fa = detail.final_assessment;
  if (!fa) {
    return (
      <div className="text-neutral-500">
        {t.pages.jobs.domain.verdict.empty}
      </div>
    );
  }
  if (fa.partial) {
    return (
      <div className="text-neutral-600 dark:text-neutral-300">
        <div className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
          {t.pages.jobs.domain.finalBanner.partialHeading}
        </div>
        <p>{t.pages.jobs.domain.finalBanner.partialHint}</p>
      </div>
    );
  }
  return (
    <>
      {fa.summary && (
        <div>
          <div className="font-semibold text-neutral-700 dark:text-neutral-200 mb-0.5">
            {t.pages.jobs.domain.finalBanner.summary}
          </div>
          <p className="text-neutral-600 dark:text-neutral-300 leading-snug">
            {fa.summary}
          </p>
        </div>
      )}
      {fa.recommendation && (
        <div className="mt-2">
          <div className="font-semibold text-neutral-700 dark:text-neutral-200 mb-0.5">
            {t.pages.jobs.domain.finalBanner.recommendation}
          </div>
          <p className="text-neutral-600 dark:text-neutral-300 leading-snug">
            {fa.recommendation}
          </p>
        </div>
      )}
    </>
  );
}

function CriterionBody({
  detail,
  criterion,
}: {
  detail: RunDomainDetail;
  criterion: string;
}) {
  const { t } = useT();
  const cr = detail.criteria[criterion];
  if (!cr) {
    return (
      <div className="text-neutral-500">
        {t.pages.jobs.domain.criterionMissing}
      </div>
    );
  }
  if (cr.error || cr.ai_verdict_error) {
    return (
      <div className="text-rose-600 dark:text-rose-400">
        {cr.ai_verdict_error || cr.error}
      </div>
    );
  }
  const v = cr.ai_verdict;
  if (!v) {
    return (
      <div className="text-neutral-500">
        {t.pages.jobs.domain.verdict.empty}
      </div>
    );
  }
  // wayback_classify has a different verdict shape (no assessment / no
  // key_findings); for now we only render the standard shape.
  const keyFindings = Array.isArray(v.key_findings)
    ? v.key_findings.filter((k): k is string => typeof k === "string" && !!k.trim())
    : [];
  const redFlags = Array.isArray(v.red_flags)
    ? v.red_flags.filter((k): k is string => typeof k === "string" && !!k.trim())
    : [];
  return (
    <>
      {v.assessment && (
        <div className="mb-2">
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">
            {t.pages.jobs.domain.verdict.assessment}:
          </span>{" "}
          <span className="text-neutral-600 dark:text-neutral-300">
            {v.assessment}
          </span>
          {typeof v.confidence === "number" && (
            <span className="ml-2 text-neutral-500">
              ({Math.round(v.confidence * 100)}%{" "}
              {t.pages.jobs.domain.verdict.confidence.toLowerCase()})
            </span>
          )}
        </div>
      )}
      {keyFindings.length > 0 && (
        <div>
          <div className="font-semibold text-emerald-700 dark:text-emerald-400 mb-0.5">
            {t.pages.jobs.domain.verdict.keyFindings}
          </div>
          <ul className="list-disc ml-4 text-neutral-600 dark:text-neutral-300 space-y-0.5">
            {keyFindings.slice(0, 4).map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {redFlags.length > 0 && (
        <div className="mt-2">
          <div className="font-semibold text-rose-700 dark:text-rose-400 mb-0.5">
            {t.pages.jobs.domain.verdict.redFlags}
          </div>
          <ul className="list-disc ml-4 text-neutral-600 dark:text-neutral-300 space-y-0.5">
            {redFlags.slice(0, 4).map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {keyFindings.length === 0 && redFlags.length === 0 && !v.assessment && (
        <div className="text-neutral-500">
          {t.pages.jobs.domain.verdict.empty}
        </div>
      )}
    </>
  );
}
