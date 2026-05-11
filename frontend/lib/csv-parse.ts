// Minimal RFC 4180-ish CSV parser. Handles:
// - comma OR tab OR semicolon delimiters (auto-detected from first line)
// - double-quoted fields with embedded delimiters / newlines / "" escapes
// - CRLF or LF line endings
// - trailing blank lines
//
// Bigger files (5k+ rows) parse fine in-browser since the work is one
// linear scan. We keep the implementation here rather than adding a
// PapaParse dependency — single-user app, no need for the bundle bloat.

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /** True when the parser hit MAX_ROWS and stopped early — the wizard
   * surfaces a "file truncated" warning so the user knows not all of
   * their data was loaded. */
  truncated: boolean;
};

// Defaults applied when the caller doesn't pass a limit. The Backlog
// import wizard fetches the user-configured cap from the backend and
// passes it explicitly. The default here is just the safety net for
// any other consumer of the parser. Cell cap (~256 KB) is huge enough
// for any realistic comment column but blocks a single-cell-with-100MB
// attack.
export const DEFAULT_MAX_ROWS = 50000;
const MAX_CELL_BYTES = 256 * 1024;

function detectDelimiter(firstLine: string): string {
  const counts = {
    ",": (firstLine.match(/,/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
  };
  // Pick the highest-count delimiter; default to comma if all zero.
  let best: string = ",";
  let bestN = -1;
  for (const [d, n] of Object.entries(counts)) {
    if (n > bestN) {
      bestN = n;
      best = d;
    }
  }
  return best;
}

export function parseCsv(
  text: string,
  opts: { maxRows?: number } = {},
): ParsedCsv {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Sniff delimiter from the first non-empty line.
  const firstNewline = text.search(/\r?\n/);
  const headerLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  const delimiter = detectDelimiter(headerLine);

  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let truncated = false;

  while (i < n) {
    // Bail before the array grows past maxRows. +1 for the header row
    // we'll slice off below — we can keep parsing until rows.length hits
    // maxRows+1.
    if (rows.length > maxRows) {
      truncated = true;
      break;
    }
    if (field.length > MAX_CELL_BYTES) {
      // A single cell larger than ~256 KB is almost certainly malformed
      // (unterminated quote → the parser thinks the rest of the file is
      // one field). Stop rather than burn memory.
      truncated = true;
      break;
    }
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          // Escaped double quote
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      cur.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // CRLF or lone CR — treat both as row terminator.
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush trailing field/row (no final newline).
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }

  // Drop trailing fully-empty rows.
  while (
    rows.length > 0 &&
    rows[rows.length - 1].every((c) => c.trim() === "")
  ) {
    rows.pop();
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], delimiter, truncated };
  }
  const headers = rows[0].map((h) => h.trim());
  // If we truncated, drop the partially-parsed final row to avoid
  // surfacing a half-row to the wizard.
  let dataRows = rows.slice(1);
  if (truncated && dataRows.length > maxRows) {
    dataRows = dataRows.slice(0, maxRows);
  }
  return { headers, rows: dataRows, delimiter, truncated };
}
