"use client";
import { useRef } from "react";
import { Upload } from "lucide-react";
import { useT } from "@/lib/i18n";

export function DomainInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.domains;
  const fileRef = useRef<HTMLInputElement>(null);

  function lineCount(text: string): number {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean).length;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    // Append rather than replace — uploading on top of pasted content
    // shouldn't silently nuke what's already there.
    const next = (value.trim() ? value.trim() + "\n" : "") + text.trim();
    onChange(next);
    if (fileRef.current) fileRef.current.value = "";
  }

  const count = lineCount(value);

  return (
    <section className="space-y-2">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{ts.heading}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {ts.help}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {ts.count(count)}
          </span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="text-sm px-2.5 py-1 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 inline-flex items-center gap-1.5"
            title={ts.uploadHint}
          >
            <Upload className="w-3.5 h-3.5" />
            {ts.upload}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={handleFile}
            className="hidden"
          />
        </div>
      </header>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={ts.placeholder}
        spellCheck={false}
        className="w-full min-h-[140px] rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
      />
    </section>
  );
}
