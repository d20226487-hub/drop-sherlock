"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  api,
  BACKLOG_STATUSES,
  BacklogImportResult,
  BacklogImportRow,
  BacklogStatus,
} from "@/lib/api";
import { parseCsv } from "@/lib/csv-parse";
import { DateFormat, parseDate, sniffDateFormat } from "@/lib/dates";

// Wizard state machine: pick → map → result. Modal-style overlay; the
// parent decides when to mount/unmount via the `onClose` callback.

type TargetField =
  | "skip"
  | "domain"
  | "status"
  | "registrar"
  | "expiration_date"
  | "project"
  | "comments"
  | "desired_price"
  | "max_price"
  // Ahrefs DR (added 2026-05-20). Storage-only: nothing renders it in
  // the Backlog / Database UI; the field exists so an upload that
  // includes a DR column can carry that value into the DB for a future
  // procurement / order-list export.
  | "ahrefs_dr"
  // Domain age in years (added 2026-05-20). Same storage-only contract
  // as ahrefs_dr.
  | "domain_age_years"
  // Ahrefs Rank (added 2026-06-14). Same storage-only contract as
  // ahrefs_dr — mappable on import, persisted, not displayed yet.
  | "ahrefs_rank"
  // Dofollow referring domains (added 2026-06-18). Same storage-only
  // contract as ahrefs_dr — mappable on import, persisted, not displayed.
  | "dofollow_refdomains";

const TARGET_FIELDS: TargetField[] = [
  "skip",
  "domain",
  "status",
  "registrar",
  "expiration_date",
  "project",
  "comments",
  "desired_price",
  "max_price",
  "ahrefs_dr",
  "domain_age_years",
  "ahrefs_rank",
  "dofollow_refdomains",
];

const DATE_FORMAT_OPTIONS: DateFormat[] = [
  "auto",
  "iso",
  "dmy_dot",
  "dmy_slash",
  "dmy_dash",
  "mdy_slash",
  "month_name",
];

// Header-name → field guesses. Lowercase matched substring against the
// source header. The first field that matches wins, so order matters
// (longer / more specific terms first).
const HEADER_HINTS: { needle: string; field: TargetField }[] = [
  { needle: "expiration", field: "expiration_date" },
  { needle: "expires", field: "expiration_date" },
  { needle: "expiry", field: "expiration_date" },
  { needle: "expire", field: "expiration_date" },
  { needle: "registrar", field: "registrar" },
  { needle: "registry", field: "registrar" },
  { needle: "desired", field: "desired_price" },
  { needle: "max", field: "max_price" },
  { needle: "project", field: "project" },
  { needle: "campaign", field: "project" },
  { needle: "comment", field: "comments" },
  { needle: "note", field: "comments" },
  { needle: "status", field: "status" },
  // Ahrefs DR auto-map — needs to fire BEFORE the "domain" / "name"
  // hints below, because "domain rating" contains "domain" as a
  // substring and would otherwise win.
  { needle: "ahrefs dr", field: "ahrefs_dr" },
  { needle: "domain rating", field: "ahrefs_dr" },
  { needle: "domain_rating", field: "ahrefs_dr" },
  { needle: "dr", field: "ahrefs_dr" },
  // Domain age auto-map — same ordering reason: "domain age" contains
  // "domain" so age hints must precede the bare "domain" needle.
  { needle: "domain age", field: "domain_age_years" },
  { needle: "domain_age", field: "domain_age_years" },
  { needle: "site age", field: "domain_age_years" },
  { needle: "age", field: "domain_age_years" },
  // Ahrefs Rank auto-map. Listed AFTER the DR hints so a "Domain Rating"
  // header still wins DR (it contains no "rank"), and before "domain" so
  // a "Domain Rank" header maps to rank, not the domain column. "ar" is
  // deliberately NOT a needle — too short, it collides with "registrar".
  { needle: "ahrefs rank", field: "ahrefs_rank" },
  { needle: "ahrefs_rank", field: "ahrefs_rank" },
  { needle: "rank", field: "ahrefs_rank" },
  // Dofollow referring domains auto-map (added 2026-06-18). MUST precede
  // the bare "domain" needle below — these headers ("Dofollow ref domains",
  // "Ref domains dofollow") contain "domain". Specific phrases only: there
  // is deliberately NO bare "dofollow" needle, so a "Dofollow backlinks"
  // column can't hijack this. Placed after the rank hints so a plain "Rank"
  // header still maps to rank.
  { needle: "dofollow ref", field: "dofollow_refdomains" },
  { needle: "ref domains dofollow", field: "dofollow_refdomains" },
  { needle: "refdomains dofollow", field: "dofollow_refdomains" },
  { needle: "ref domains (follow)", field: "dofollow_refdomains" },
  { needle: "dofollow domains", field: "dofollow_refdomains" },
  { needle: "domain", field: "domain" },
  { needle: "name", field: "domain" },
];

function autoMap(headers: string[]): TargetField[] {
  const used = new Set<TargetField>();
  return headers.map((h) => {
    const low = h.toLowerCase();
    for (const hint of HEADER_HINTS) {
      if (low.includes(hint.needle) && !used.has(hint.field)) {
        used.add(hint.field);
        return hint.field;
      }
    }
    return "skip";
  });
}

function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Ahrefs DR (Domain Rating). Same input shape as price (numeric, may
// have stray symbols / commas) but constrained to 0–100. Out-of-range
// or unparseable cells become null — the importer treats DR as
// optional metadata and won't fail the row.
function parseDr(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

// Domain age in years. Float (Spamzilla / Ahrefs / ExpiredDomains.net
// surface decimals like "5.2"). Sanity bounds 0–100: rejects negative
// noise and >100 "thousand-of-days-misread-as-years" outliers while
// staying generous enough for any real domain.
function parseAge(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

// Ahrefs Rank. Whole-number position (rank #1 = strongest) with no upper
// bound — so, unlike DR, no 0-100 clamp and we round to an integer.
// Anything < 1 or unparseable becomes null (treated as optional metadata,
// never fails the row). Strip thousands separators ("1,234,567" → 1234567).
function parseRank(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Math.round(parseFloat(cleaned));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

// Dofollow referring domains. Whole-number count with no upper bound (big
// sites have tens of thousands). Mirrors parseRank but allows 0 — "0
// dofollow refdomains" is a real value, unlike Rank's 1-based position.
// Optional metadata: unparseable / negative cells become null, never
// failing the row. Strips thousands separators ("1,234" → 1234).
function parseRefdomains(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Math.round(parseFloat(cleaned));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function BacklogImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.backlog.importDialog;

  const [step, setStep] = useState<"pick" | "map" | "result">("pick");
  const [error, setError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<TargetField[]>([]);
  const [defaultRegistrar, setDefaultRegistrar] = useState<string>("");
  const [defaultStatus, setDefaultStatus] = useState<BacklogStatus>("backlog");
  const [dateFormat, setDateFormat] = useState<DateFormat>("auto");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BacklogImportResult | null>(null);
  // Live import-row cap fetched from Settings → Others. Null = still
  // loading; the parser falls back to its built-in default if the fetch
  // fails so the wizard isn't bricked by a transient API blip.
  const [maxRows, setMaxRows] = useState<number | null>(null);

  function reset() {
    setStep("pick");
    setError(null);
    setHeaders([]);
    setRows([]);
    setMapping([]);
    setDefaultRegistrar("");
    setDefaultStatus("backlog");
    setDateFormat("auto");
    setResult(null);
  }

  // "Safe to dismiss without warning?" — yes on the file-picker step
  // (nothing entered yet) and yes on the result screen (work already
  // committed). On `map` the user has invested time in column mapping +
  // defaults, so a stray backdrop click or Escape press shouldn't wipe
  // it — we require an explicit Cancel/X click there.
  const safeToDismiss = step === "pick" || step === "result";

  // Close-on-Escape — convenient on the safe-to-dismiss steps; on `map`
  // it's blocked so the user doesn't lose their mapping work.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy && safeToDismiss) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, safeToDismiss, onClose]);

  // Fetch the live import-row cap on mount. Cheap (3-key JSON) and lets
  // the user change the cap in Settings → Others without a page reload.
  useEffect(() => {
    let cancelled = false;
    api
      .getBacklogImportLimit()
      .then((d) => {
        if (!cancelled) setMaxRows(d.rows);
      })
      .catch(() => {
        // Silent — parser default kicks in.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCsv(text, maxRows ? { maxRows } : undefined);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError(ts.emptyFile);
        return;
      }
      if (parsed.truncated) {
        setError(ts.fileTruncated(parsed.rows.length));
      }
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      const auto = autoMap(parsed.headers);
      setMapping(auto);
      // Sniff date format from the column auto-mapped to expiration_date.
      const expIdx = auto.indexOf("expiration_date");
      if (expIdx >= 0) {
        const samples = parsed.rows.slice(0, 50).map((r) => r[expIdx] || "");
        setDateFormat(sniffDateFormat(samples));
      }
      setStep("map");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Each target field can be mapped at most once — picking a field on one
  // column auto-resets any other column that already had it (silently).
  function setColumnMapping(colIdx: number, target: TargetField) {
    setMapping((prev) => {
      const next = [...prev];
      if (target !== "skip") {
        for (let i = 0; i < next.length; i++) {
          if (i !== colIdx && next[i] === target) next[i] = "skip";
        }
      }
      next[colIdx] = target;
      return next;
    });
  }

  const domainColIdx = mapping.indexOf("domain");
  const canImport = domainColIdx >= 0 && rows.length > 0;
  const previewRows = rows.slice(0, 5);

  // Build the final payload by walking each row and applying the mapping.
  // Done inside the import handler so we don't hold a giant in-memory copy
  // during the editing step.
  function buildPayload(): BacklogImportRow[] {
    const payload: BacklogImportRow[] = [];
    for (const row of rows) {
      const out: BacklogImportRow = { domain: "" };
      for (let i = 0; i < mapping.length; i++) {
        const target = mapping[i];
        const cell = (row[i] ?? "").trim();
        if (target === "skip") continue;
        if (target === "domain") out.domain = cell;
        else if (target === "status") {
          const s = cell.toLowerCase().replace(/\s+/g, "_");
          if (BACKLOG_STATUSES.includes(s as BacklogStatus)) {
            out.status = s as BacklogStatus;
          }
        } else if (target === "registrar") out.registrar = cell;
        else if (target === "project") out.project = cell;
        else if (target === "comments") out.comments = cell;
        else if (target === "expiration_date") {
          const iso = parseDate(cell, dateFormat);
          out.expiration_date = iso;
        } else if (target === "desired_price") {
          out.desired_price = parsePrice(cell);
        } else if (target === "max_price") {
          out.max_price = parsePrice(cell);
        } else if (target === "ahrefs_dr") {
          out.ahrefs_dr = parseDr(cell);
        } else if (target === "domain_age_years") {
          out.domain_age_years = parseAge(cell);
        } else if (target === "ahrefs_rank") {
          out.ahrefs_rank = parseRank(cell);
        } else if (target === "dofollow_refdomains") {
          out.dofollow_refdomains = parseRefdomains(cell);
        }
      }
      // Apply defaults for unmapped fields.
      if (out.registrar === undefined && defaultRegistrar.trim()) {
        out.registrar = defaultRegistrar.trim();
      }
      if (out.status === undefined) out.status = defaultStatus;
      payload.push(out);
    }
    return payload;
  }

  async function handleImport() {
    if (!canImport) return;
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload();
      const res = await api.importBacklog(payload);
      setResult(res);
      setStep("result");
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dateColIdx = mapping.indexOf("expiration_date");
  const dateColumnSample = useMemo(() => {
    if (dateColIdx < 0) return null;
    return previewRows.map((r) => r[dateColIdx] || "");
  }, [previewRows, dateColIdx]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/50 overflow-y-auto"
      onMouseDown={(e) => {
        // Backdrop click only dismisses when there's no in-progress
        // work to lose. On the `map` step the user has already picked
        // a file + entered column mappings — protect that. The X
        // button and Cancel button still work; this only blocks the
        // accidental-click-outside path.
        if (e.target === e.currentTarget && !busy && safeToDismiss) onClose();
      }}
    >
      <div className="w-full max-w-3xl rounded-lg border dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl mt-12 mb-12">
        <div className="px-5 py-3 border-b dark:border-neutral-800 flex items-center justify-between">
          <h2 className="text-base font-semibold">{ts.title}</h2>
          <button
            type="button"
            onClick={() => (busy ? null : onClose())}
            disabled={busy}
            aria-label={ts.close}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-4 text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}

        {step === "pick" && (
          <div className="p-5 space-y-3">
            <h3 className="text-sm font-semibold">{ts.step1Heading}</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.fileHint}
            </p>
            <input
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="block text-sm"
            />
          </div>
        )}

        {step === "map" && (
          <div className="p-5 space-y-5">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{ts.step2Heading}</h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.step2Intro(headers.length)}
              </p>
              <div className="grid grid-cols-1 gap-2">
                {headers.map((h, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-md border dark:border-neutral-800 px-3 py-2"
                  >
                    <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300 flex-1 truncate">
                      {h || `(column ${i + 1})`}
                    </span>
                    <span className="text-xs text-neutral-400">→</span>
                    <select
                      value={mapping[i] || "skip"}
                      onChange={(e) =>
                        setColumnMapping(i, e.target.value as TargetField)
                      }
                      className="text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none"
                    >
                      {TARGET_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {ts.targetFields[f]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {domainColIdx < 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {ts.domainNotMapped}
                </p>
              )}
            </div>

            {/* Date format dropdown — only shown when a column is mapped to expiration_date. */}
            {dateColIdx >= 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {ts.dateFormatLabel}
                </label>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                  className="text-sm rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none w-full"
                >
                  {DATE_FORMAT_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {ts.dateFormatOptions[f]}
                    </option>
                  ))}
                </select>
                {dateColumnSample && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {dateColumnSample
                      .filter(Boolean)
                      .slice(0, 3)
                      .map((s) => {
                        const parsed = parseDate(s, dateFormat);
                        return parsed ? `${s} → ${parsed}` : `${s} → ?`;
                      })
                      .join("  ·  ")}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{ts.defaultsHeading}</h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {ts.defaultsHint}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {ts.defaultRegistrar}
                  </span>
                  <input
                    type="text"
                    value={defaultRegistrar}
                    onChange={(e) => setDefaultRegistrar(e.target.value)}
                    disabled={mapping.includes("registrar")}
                    placeholder="GoDaddy"
                    className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {ts.defaultStatus}
                  </span>
                  <select
                    value={defaultStatus}
                    onChange={(e) =>
                      setDefaultStatus(e.target.value as BacklogStatus)
                    }
                    disabled={mapping.includes("status")}
                    className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 outline-none disabled:opacity-50"
                  >
                    {BACKLOG_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t.pages.backlog.statusLabels[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{ts.previewHeading}</h3>
              <div className="overflow-x-auto rounded-md border dark:border-neutral-800">
                <table className="w-full text-xs">
                  <thead className="bg-neutral-100 dark:bg-neutral-900">
                    <tr>
                      {headers.map((h, i) => (
                        <th
                          key={i}
                          className="px-2 py-1 text-left font-medium font-mono"
                        >
                          {h || `(col ${i + 1})`}
                          <div className="text-[10px] font-normal text-neutral-500">
                            {ts.targetFields[mapping[i] || "skip"]}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r, ri) => (
                      <tr
                        key={ri}
                        className="border-t dark:border-neutral-800"
                      >
                        {headers.map((_, ci) => (
                          <td
                            key={ci}
                            className="px-2 py-1 align-top whitespace-nowrap"
                          >
                            {(r[ci] ?? "").slice(0, 60)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
              >
                {ts.cancel}
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={!canImport || busy}
                className="text-sm px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? ts.importing : ts.importBtn(rows.length)}
              </button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="p-5 space-y-3">
            <h3 className="text-sm font-semibold">{ts.result.heading}</h3>
            <ul className="text-sm space-y-1">
              <li className="text-green-700 dark:text-green-400">
                {ts.result.inserted(result.inserted)}
              </li>
              {result.skipped_duplicates > 0 && (
                <li className="text-neutral-600 dark:text-neutral-400">
                  {ts.result.skippedDupes(result.skipped_duplicates)}
                </li>
              )}
              {(result.skipped_banned ?? 0) > 0 && (
                <li className="text-rose-700 dark:text-rose-400">
                  {ts.result.skippedBanned(result.skipped_banned ?? 0)}
                </li>
              )}
              {result.skipped_filtered &&
                Object.entries(result.skipped_filtered)
                  .filter(([, n]) => n > 0)
                  .map(([cat, n]) => (
                    <li
                      key={cat}
                      className="text-violet-700 dark:text-violet-400"
                    >
                      {cat === "cctld"
                        ? ts.result.skippedFilteredCctld(n)
                        : ts.result.skippedFilteredOther(cat, n)}
                    </li>
                  ))}
              {result.skipped_invalid > 0 && (
                <li className="text-amber-700 dark:text-amber-400">
                  {ts.result.skippedInvalid(result.skipped_invalid)}
                </li>
              )}
            </ul>
            {result.errors.length > 0 && (
              <div className="text-xs space-y-1">
                <div className="font-medium">{ts.result.errorsHeading}</div>
                <ul className="list-disc list-inside text-neutral-600 dark:text-neutral-400">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      row {e.row_index + 2}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  reset();
                }}
                className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {t.pages.backlog.importBtn}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-sm px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                {ts.close}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
