// Display + parsing helpers for the Backlog page. Internal storage is
// always ISO YYYY-MM-DD (SQLite-friendly + sortable); UI shows DD.MM.YYYY
// per the user's preferred CIS-style format.

export function isoToDisplay(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Parse a `<input type="date">` value (always ISO YYYY-MM-DD) into the
 * same shape the backend expects. Returns "" for empty input. */
export function dateInputToIso(value: string): string {
  return value.trim();
}

// --- Import-wizard date parsing --------------------------------------------
//
// Registrar exports use wildly different date formats. The wizard lets the
// user pick the source format explicitly (or leave on Auto) — here we
// implement each format and a sniff routine that picks one when possible.

export type DateFormat =
  | "auto"
  | "iso" // 2026-05-09
  | "dmy_dot" // 09.05.2026
  | "dmy_slash" // 09/05/2026
  | "dmy_dash" // 09-05-2026
  | "mdy_slash" // 05/09/2026 (US)
  | "month_name"; // "Jan 15, 2026" / "January 15, 2026"

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildIso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d))
    return null;
  if (y < 1900 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  // Construct + reflect to validate (catches Feb 30 etc.).
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parse a date string under the named format. Returns ISO YYYY-MM-DD on
 * success, null on failure. "auto" tries every format and returns the
 * first successful parse; if multiple formats parse but disagree (DMY vs
 * MDY ambiguity for 03/04/2026), prefers DMY since the user's stated
 * locale is CIS. */
export function parseDate(raw: string, format: DateFormat): string | null {
  const s = raw.trim();
  if (!s) return null;

  if (format === "iso" || format === "auto") {
    // Accept either a bare date (`2026-06-12`) or an ISO-8601 datetime
    // with a time portion + optional timezone (`2026-06-12T15:00:00Z`,
    // `2026-06-12T15:00:00.123+02:00`, `2026-06-12 15:00:00`). The
    // datetime variant shows up in RDAP / WHOIS / API exports — we
    // care only about the calendar date because the backlog stores
    // dates, not timestamps, so we strip the time component on parse.
    // The optional trailer is constrained to `[T ]\d{2}:...` so we
    // don't accidentally accept random garbage after a valid date.
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (m) {
      const iso = buildIso(+m[1], +m[2], +m[3]);
      if (iso) return iso;
    }
  }
  if (format === "dmy_dot" || format === "auto") {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (m) {
      const iso = buildIso(+m[3], +m[2], +m[1]);
      if (iso) return iso;
    }
  }
  if (format === "dmy_slash" || format === "auto") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) {
      // For "auto", prefer DMY interpretation (user's CIS preference).
      // If DMY would produce a valid date, use it; otherwise fall through
      // to MDY.
      const dmy = buildIso(+m[3], +m[2], +m[1]);
      if (dmy) return dmy;
      if (format === "auto") {
        const mdy = buildIso(+m[3], +m[1], +m[2]);
        if (mdy) return mdy;
      }
    }
  }
  if (format === "dmy_dash" || format === "auto") {
    const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
    if (m) {
      const iso = buildIso(+m[3], +m[2], +m[1]);
      if (iso) return iso;
    }
  }
  if (format === "mdy_slash") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) {
      const iso = buildIso(+m[3], +m[1], +m[2]);
      if (iso) return iso;
    }
  }
  if (format === "month_name" || format === "auto") {
    // "Jan 15, 2026" / "January 15, 2026" / "15 Jan 2026"
    const m1 = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (m1) {
      const month = MONTH_NAMES[m1[1].toLowerCase()];
      if (month) {
        const iso = buildIso(+m1[3], month, +m1[2]);
        if (iso) return iso;
      }
    }
    const m2 = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s);
    if (m2) {
      const month = MONTH_NAMES[m2[2].toLowerCase()];
      if (month) {
        const iso = buildIso(+m2[3], month, +m2[1]);
        if (iso) return iso;
      }
    }
  }
  return null;
}

/** Sniff the most likely format from a sample of values. Returns "auto"
 * if no single format matches a clear majority of samples (the wizard
 * shows the dropdown so the user can pick). */
export function sniffDateFormat(samples: string[]): DateFormat {
  const candidates: DateFormat[] = [
    "iso", "dmy_dot", "dmy_slash", "dmy_dash", "month_name",
  ];
  const cleaned = samples.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return "auto";
  let best: { fmt: DateFormat; hits: number } = { fmt: "auto", hits: 0 };
  for (const fmt of candidates) {
    const hits = cleaned.filter((s) => parseDate(s, fmt) != null).length;
    if (hits > best.hits) {
      best = { fmt, hits };
    }
  }
  // Need at least half the samples to parse cleanly to commit to a format.
  return best.hits >= Math.ceil(cleaned.length / 2) ? best.fmt : "auto";
}
