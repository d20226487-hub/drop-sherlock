"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { RunDomainDetail } from "@/lib/api";
import { AiPreviewPanel } from "@/components/ai-preview-panel";

// Per-domain page for whois_history-kind runs (Wave 2b, 2026-05-15).
// Rendered INSTEAD of the Quality criterion tabs when
// `data.job_kind === 'whois_history'`. Single criterion ('whois_history')
// holds:
//   • data_json: { records: WhoisRecord[], diff: WhoisDiff, provider: str }
//   • ai_verdict_json: {
//       dropped_confidence, transferred_confidence,
//       summary, key_signals[], recommendation
//     }
// We surface them in this order: AI verdict → diff signals → current
// state → raw records table. That matches the operator's decision
// flow: "did it drop?" → "what signals?" → "what does the latest
// snapshot say?" → "raw audit if I want to verify".

type WhoisVerdict = {
  dropped_confidence?: number;
  transferred_confidence?: number;
  summary?: string;
  key_signals?: string[];
  recommendation?: string;
};

type DiffEvent = {
  from?: unknown;
  to?: unknown;
  at?: string;
  prev_at?: string | null;
};

type DropPipelineEvent = { at: string; codes: string[] };
type CoverageGap = { from: string; to: string; gap_days: number };

type WhoisDiff = {
  snapshot_count: number;
  first_seen: string | null;
  last_seen: string | null;
  drop_signals: {
    creation_date_changes: DiffEvent[];
    drop_pipeline_status_events: DropPipelineEvent[];
    coverage_gaps_days: CoverageGap[];
  };
  soft_signals: {
    owner_changes: DiffEvent[];
    org_changes: DiffEvent[];
    email_changes: DiffEvent[];
    country_changes: DiffEvent[];
    city_changes: DiffEvent[];
    registrar_changes: DiffEvent[];
    ns_changes: DiffEvent[];
    dnssec_toggles: DiffEvent[];
  };
  current_state: {
    registrar?: string;
    owner?: string;
    org?: string;
    country?: string;
    creation_date?: string | null;
    status?: string[];
    name_servers?: string[];
    dnssec_enabled?: boolean | null;
    is_in_drop_pipeline?: boolean;
  };
};

type WhoisRecord = {
  query_time?: string;
  creation_date?: string;
  update_date?: string;
  expiry_date?: string;
  registrar_name?: string;
  registrant_name?: string;
  registrant_org?: string;
  registrant_country?: string;
  registrant_city?: string;
  registrant_email?: string;
  name_servers?: string[];
  domain_status?: string[];
};

type WhoisCriterionDetail = {
  status?: string;
  error?: string;
  ai_verdict?: WhoisVerdict | null;
  ai_verdict_error?: string;
  // data_json content lands here on the frontend as `raw` (matches
  // the Quality CriterionDetail shape). We type-narrow inside the
  // component since the runtime shape is whois-specific.
  raw?: {
    records?: WhoisRecord[];
    diff?: WhoisDiff;
    provider?: string;
  } | null;
};

export function WhoisHistoryDomainView({ data }: { data: RunDomainDetail }) {
  const { t } = useT();
  const ts = t.pages.whoisDomain;
  const detail = (data.criteria?.whois_history ??
    {}) as unknown as WhoisCriterionDetail;
  const verdict: WhoisVerdict | null = detail.ai_verdict ?? null;
  const raw = detail.raw ?? null;
  const diff = raw?.diff;
  const records = raw?.records ?? [];

  return (
    <div className="space-y-6">
      {/* AI verdict box — the headline answer. */}
      {detail.error || detail.ai_verdict_error ? (
        <div className="rounded-md border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 p-4 text-sm text-rose-800 dark:text-rose-300 space-y-1">
          <div className="font-medium">{ts.errorHeading}</div>
          <div className="font-mono text-xs break-words">
            {detail.error || detail.ai_verdict_error}
          </div>
        </div>
      ) : verdict ? (
        <VerdictBox verdict={verdict} />
      ) : (
        <div className="rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-4 text-sm text-neutral-600 dark:text-neutral-400">
          {ts.pending}
        </div>
      )}

      {/* AI input preview — same component the Quality criterion tabs
          use. Renders the EXACT system prompt + user message the runner
          would send if you re-judged this domain right now (structured
          diff + raw records). Lazy-loaded on first expand so domains
          with hundreds of snapshots don't pay the bytes until inspected. */}
      <AiPreviewPanel runDomainId={data.id} criterion="whois_history" />

      {/* Diff signals — hard first, then soft. */}
      {diff && diff.snapshot_count > 0 && (
        <DiffSignalsPanel diff={diff} />
      )}

      {/* Current-state summary card. */}
      {diff?.current_state && Object.keys(diff.current_state).length > 0 && (
        <CurrentStateCard state={diff.current_state} />
      )}

      {/* Raw records — collapsed by default since most operators don't
          need to read every snapshot. */}
      {records.length > 0 && <RawRecordsTable records={records} />}
    </div>
  );
}

// --- AI verdict box --------------------------------------------------------

function dropTone(score: number | undefined): {
  bg: string;
  badge: string;
  accent: string;
} {
  // Color semantics (revised 2026-05-15 per user feedback): high
  // drop confidence is a CAUTION signal in drop-hunting context —
  // domains that have flipped owners repeatedly often carry SEO
  // baggage (penalties, spam history, PBN traces). Stable ownership
  // history is the "clean asset" outcome.
  //
  // Bands (against dropped_confidence ∈ [0, 1]):
  //   > 0.80              → red    (multiple drops / strong evidence)
  //   > 0.50, ≤ 0.80      → amber  (mixed signals)
  //   ≥ 0.30, ≤ 0.50      → grey   (insufficient evidence)
  //   < 0.30              → green  (stable ownership)
  //
  // Boundaries deliberately follow the user's spec exactly: 0.80
  // sits in amber (not red), 0.50 sits in grey (not amber), 0.30
  // sits in grey (not green). At-boundary domains pick the safer
  // (lower-severity) band so a borderline 80% doesn't get red unless
  // it's clearly past the threshold.
  const v = typeof score === "number" ? score : 0;
  if (v > 0.8)
    return {
      bg: "bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-700",
      badge:
        "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
      accent: "text-rose-700 dark:text-rose-300",
    };
  if (v > 0.5)
    return {
      bg: "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700",
      badge:
        "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      accent: "text-amber-700 dark:text-amber-300",
    };
  if (v >= 0.3)
    return {
      bg: "bg-neutral-50 dark:bg-neutral-900/40 border-neutral-300 dark:border-neutral-700",
      badge:
        "bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300",
      accent: "text-neutral-700 dark:text-neutral-300",
    };
  return {
    bg: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700",
    badge:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    accent: "text-emerald-700 dark:text-emerald-300",
  };
}

function VerdictBox({ verdict }: { verdict: WhoisVerdict }) {
  const { t } = useT();
  const ts = t.pages.whoisDomain.verdict;
  const drop = verdict.dropped_confidence;
  const xfer = verdict.transferred_confidence;
  const tone = dropTone(drop);

  return (
    <section
      className={`rounded-lg border-l-4 border p-4 space-y-3 ${tone.bg}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">{ts.heading}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${tone.badge}`}>
          {ts.dropConfidence}: <strong>{Math.round((drop ?? 0) * 100)}%</strong>
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
          {ts.transferredConfidence}:{" "}
          <strong>{Math.round((xfer ?? 0) * 100)}%</strong>
        </span>
      </div>
      {verdict.summary && (
        <p className="text-sm leading-relaxed">{verdict.summary}</p>
      )}
      {verdict.key_signals && verdict.key_signals.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
            {ts.keySignals}
          </p>
          <ul className="list-disc list-inside text-sm space-y-0.5">
            {verdict.key_signals.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.recommendation && (
        <p className={`text-sm font-medium ${tone.accent}`}>
          <span className="opacity-70 mr-1">{ts.recommendation}:</span>
          {verdict.recommendation}
        </p>
      )}
    </section>
  );
}

// --- Structured diff signals ----------------------------------------------

function DiffSignalsPanel({ diff }: { diff: WhoisDiff }) {
  const { t } = useT();
  const ts = t.pages.whoisDomain.diff;
  const hard = diff.drop_signals;
  const soft = diff.soft_signals;
  const hardCount =
    hard.creation_date_changes.length +
    hard.drop_pipeline_status_events.length +
    hard.coverage_gaps_days.length;
  const softCount =
    soft.owner_changes.length +
    soft.org_changes.length +
    soft.email_changes.length +
    soft.country_changes.length +
    soft.city_changes.length +
    soft.registrar_changes.length +
    soft.ns_changes.length +
    soft.dnssec_toggles.length;

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">{ts.heading}</h2>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.coverage(diff.snapshot_count, diff.first_seen, diff.last_seen)}
        </span>
      </header>

      {hardCount > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">
            {ts.hardSignals} ({hardCount})
          </h3>
          {hard.creation_date_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.creation_date_changes}
              tone="hard"
              events={hard.creation_date_changes}
            />
          )}
          {hard.drop_pipeline_status_events.length > 0 && (
            <div className="rounded border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/20 px-3 py-2">
              <div className="text-xs font-medium text-rose-800 dark:text-rose-300">
                {ts.signals.drop_pipeline_status_events}
              </div>
              <ul className="text-xs mt-1 space-y-0.5">
                {hard.drop_pipeline_status_events.map((e, i) => (
                  <li key={i} className="font-mono">
                    {e.at}: [{e.codes.join(", ")}]
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hard.coverage_gaps_days.length > 0 && (
            <div className="rounded border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/20 px-3 py-2">
              <div className="text-xs font-medium text-rose-800 dark:text-rose-300">
                {ts.signals.coverage_gaps_days}
              </div>
              <ul className="text-xs mt-1 space-y-0.5">
                {hard.coverage_gaps_days.map((g, i) => (
                  <li key={i} className="font-mono">
                    {g.from} → {g.to} ({g.gap_days}d)
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 italic">
          {ts.noHardSignals}
        </p>
      )}

      {softCount > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            {ts.softSignals} ({softCount})
          </h3>
          {soft.owner_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.owner_changes}
              tone="soft"
              events={soft.owner_changes}
            />
          )}
          {soft.email_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.email_changes}
              tone="soft"
              events={soft.email_changes}
            />
          )}
          {soft.org_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.org_changes}
              tone="soft"
              events={soft.org_changes}
            />
          )}
          {soft.country_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.country_changes}
              tone="soft"
              events={soft.country_changes}
            />
          )}
          {soft.city_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.city_changes}
              tone="weak"
              events={soft.city_changes}
            />
          )}
          {soft.registrar_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.registrar_changes}
              tone="weak"
              events={soft.registrar_changes}
            />
          )}
          {soft.ns_changes.length > 0 && (
            <SignalGroup
              label={ts.signals.ns_changes}
              tone="weak"
              events={soft.ns_changes}
            />
          )}
          {soft.dnssec_toggles.length > 0 && (
            <SignalGroup
              label={ts.signals.dnssec_toggles}
              tone="weak"
              events={soft.dnssec_toggles}
            />
          )}
        </div>
      )}
    </section>
  );
}

function SignalGroup({
  label,
  tone,
  events,
}: {
  label: string;
  tone: "hard" | "soft" | "weak";
  events: DiffEvent[];
}) {
  const cls =
    tone === "hard"
      ? "border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/20"
      : tone === "soft"
        ? "border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20"
        : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40";
  const heading =
    tone === "hard"
      ? "text-rose-800 dark:text-rose-300"
      : tone === "soft"
        ? "text-amber-800 dark:text-amber-300"
        : "text-neutral-700 dark:text-neutral-300";
  return (
    <div className={`rounded border px-3 py-2 ${cls}`}>
      <div className={`text-xs font-medium ${heading}`}>{label}</div>
      <ul className="text-xs mt-1 space-y-0.5 font-mono">
        {events.map((e, i) => (
          <li key={i} className="break-all">
            {e.at}: {String(e.from)} → {String(e.to)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Current-state card ---------------------------------------------------

function CurrentStateCard({
  state,
}: {
  state: WhoisDiff["current_state"];
}) {
  const { t } = useT();
  const ts = t.pages.whoisDomain.currentState;
  return (
    <section className="rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-2">
      <h2 className="text-lg font-semibold">{ts.heading}</h2>
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {state.registrar && (
          <Row label={ts.registrar} value={state.registrar} />
        )}
        {state.owner && <Row label={ts.owner} value={state.owner} />}
        {state.org && <Row label={ts.org} value={state.org} />}
        {state.country && <Row label={ts.country} value={state.country} />}
        {state.creation_date && (
          <Row label={ts.creationDate} value={state.creation_date} />
        )}
        {state.status && state.status.length > 0 && (
          <Row label={ts.status} value={state.status.join(", ")} />
        )}
        {state.name_servers && state.name_servers.length > 0 && (
          <Row label={ts.nameServers} value={state.name_servers.join(", ")} />
        )}
        {state.dnssec_enabled !== undefined &&
          state.dnssec_enabled !== null && (
            <Row
              label={ts.dnssec}
              value={state.dnssec_enabled ? ts.dnssecOn : ts.dnssecOff}
            />
          )}
      </dl>
      {state.is_in_drop_pipeline && (
        <p className="text-xs text-rose-700 dark:text-rose-300 mt-1 font-medium">
          ⚠ {ts.inDropPipeline}
        </p>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
        {label}:
      </dt>
      <dd className="font-mono text-sm break-all">{value}</dd>
    </div>
  );
}

// --- Raw records table ----------------------------------------------------

function RawRecordsTable({ records }: { records: WhoisRecord[] }) {
  const { t } = useT();
  const ts = t.pages.whoisDomain.rawRecords;
  const [open, setOpen] = useState(false);
  // Newest first for the table view — same convention as the Wayback
  // timeline default (operators usually scan recent history first).
  const sorted = [...records].sort((a, b) => {
    const at = a.query_time ?? "";
    const bt = b.query_time ?? "";
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium inline-flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>{ts.toggle(records.length)}</span>
      </button>
      {open && (
        <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50 dark:bg-neutral-900/60 text-left text-neutral-500 dark:text-neutral-400">
              <tr>
                <th className="px-2 py-1.5">{ts.cols.queryTime}</th>
                <th className="px-2 py-1.5">{ts.cols.creationDate}</th>
                <th className="px-2 py-1.5">{ts.cols.expiryDate}</th>
                <th className="px-2 py-1.5">{ts.cols.registrar}</th>
                <th className="px-2 py-1.5">{ts.cols.registrant}</th>
                <th className="px-2 py-1.5">{ts.cols.country}</th>
                <th className="px-2 py-1.5">{ts.cols.status}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr
                  key={i}
                  className="border-t dark:border-neutral-800 align-top"
                >
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {r.query_time ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {r.creation_date ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {r.expiry_date ?? "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.registrar_name || (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.registrant_name ||
                      r.registrant_org ||
                      r.registrant_email || (
                        <span className="text-neutral-400">—</span>
                      )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.registrant_country || (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.domain_status && r.domain_status.length > 0 ? (
                      <span className="font-mono text-[11px]">
                        {r.domain_status.join(", ")}
                      </span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
