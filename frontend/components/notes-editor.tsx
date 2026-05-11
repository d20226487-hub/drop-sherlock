"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";

/** Per-domain note editor — domain-keyed, cross-run.
 *
 * Two visual modes:
 * - **View mode** (when a saved note exists) — heading + the saved text +
 *   "Edit" button + "Saved {time}". The textarea is hidden so the section
 *   doesn't take up vertical space once a note is in place.
 * - **Edit mode** (when blank, or after the user clicks Edit) — full
 *   textarea with Save/Cancel. Empty + Save = DELETE so the Database
 *   page's "with notes" filter behaves cleanly.
 *
 * Save lands → flip back to view mode automatically. */
export function NotesEditor({
  domain,
  initialNote,
  initialUpdatedAt,
  onSaved,
}: {
  domain: string;
  initialNote: string;
  initialUpdatedAt: string | null;
  onSaved?: (note: string, updatedAt: string | null) => void;
}) {
  const { t } = useT();
  const ts = t.pages.jobs.domain.notes;

  const [value, setValue] = useState(initialNote);
  const [savedValue, setSavedValue] = useState(initialNote);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialUpdatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Edit mode is auto-on for blank notes (so the textarea is the prompt to
  // write something); auto-off once a saved note exists. Toggled by the
  // Edit / Cancel buttons.
  const [editing, setEditing] = useState(initialNote === "");

  // If the parent reloads with a different domain or fresh data, sync.
  const lastDomain = useRef(domain);
  useEffect(() => {
    if (lastDomain.current !== domain) {
      lastDomain.current = domain;
      setValue(initialNote);
      setSavedValue(initialNote);
      setUpdatedAt(initialUpdatedAt);
      setEditing(initialNote === "");
      setError(null);
    }
  }, [domain, initialNote, initialUpdatedAt]);

  const dirty = value !== savedValue;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = value.trim();
      if (trimmed === "") {
        await api.deleteDomainNote(domain);
        setSavedValue("");
        setUpdatedAt(null);
        onSaved?.("", null);
        // No saved note now → stay in edit mode (the textarea IS the
        // empty-state prompt).
        setEditing(true);
      } else {
        const r = await api.putDomainNote(domain, value);
        setSavedValue(value);
        setUpdatedAt(r.updated_at);
        onSaved?.(value, r.updated_at);
        // Saved successfully → collapse to view mode.
        setEditing(false);
      }
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setValue(savedValue);
    setEditing(false);
    setError(null);
  }

  const hasSavedNote = savedValue !== "";

  return (
    <section className="space-y-2 rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold">{ts.heading}</h2>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.updatedAt(new Date(updatedAt).toLocaleString())}
            </span>
          )}
          {editing ? (
            <>
              {hasSavedNote && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={busy}
                  className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
                >
                  {ts.cancel}
                </button>
              )}
              <button
                type="button"
                onClick={save}
                disabled={!dirty || busy}
                className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? ts.saving : ts.save}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs px-3 py-1 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {ts.edit}
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={ts.placeholder}
            rows={3}
            autoFocus={hasSavedNote}
            className="w-full text-sm rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {ts.help}
          </p>
        </>
      ) : (
        <p className="text-sm whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200">
          {savedValue}
        </p>
      )}
      {error && (
        <p className="text-xs rounded-md px-2 py-1 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
