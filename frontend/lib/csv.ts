// RFC 4180-ish CSV escaping: wrap in quotes if the value contains a comma,
// quote, or newline; double internal quotes. Empty strings emitted as-is so
// columns don't collapse — Excel/Sheets handle blank cells fine.

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export type CsvColumn<T> = {
  header: string;
  get: (row: T) => unknown;
};

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const lines = rows.map((r) =>
    columns.map((c) => escapeCell(c.get(r))).join(","),
  );
  // Excel on Windows prefers CRLF; Sheets accepts either. CRLF for
  // maximum-compatibility downloads.
  return [head, ...lines].join("\r\n");
}

/** Trigger a browser download for a string blob. Caller controls the
 * filename and mime type. Cleans up the object URL after the click fires. */
export function downloadBlob(
  contents: string,
  filename: string,
  mime: string = "text/csv;charset=utf-8",
): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/** Build a timestamped filename like "drop-sherlock-database-2026-05-06.csv". */
export function csvFilename(stem: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${stem}-${stamp}.csv`;
}
