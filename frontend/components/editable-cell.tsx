"use client";
import { useEffect, useRef, useState } from "react";

// Inline-editable table cell. Click to enter edit mode, blur or Enter to
// save, Escape to cancel. Saves are optimistic — the parent updates its
// row state before the network call so the cell stays responsive on
// chained edits; if the save fails, we revert and surface the error.

type CommonProps = {
  /** Save handler. Returning a rejected promise reverts the cell. */
  onSave: (value: string | number | null) => Promise<unknown>;
  /** Optional placeholder when the cell is empty in display mode. */
  placeholder?: string;
  className?: string;
};

export function EditableTextCell({
  value,
  multiline = false,
  onSave,
  placeholder,
  className,
}: CommonProps & { value: string; multiline?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Sync down when the parent's value changes (e.g. after a reload).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function commit() {
    if (busy) return;
    if (draft === value) {
      setEditing(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || "save failed");
      // Stay in edit mode so the user can retry without retyping.
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={
          "text-left w-full min-h-[1.25rem] hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded px-1 -mx-1 " +
          (className || "")
        }
        title="Click to edit"
      >
        {value ? (
          <span className="whitespace-pre-wrap break-words">{value}</span>
        ) : (
          <span className="text-neutral-400">{placeholder || "—"}</span>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-1">
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          rows={2}
          disabled={busy}
          className={
            "w-full text-xs rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50 " +
            (className || "")
          }
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          disabled={busy}
          className={
            "w-full text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50 " +
            (className || "")
          }
        />
      )}
      {error && (
        <p className="text-[10px] text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

export function EditablePriceCell({
  value,
  onSave,
  className,
}: CommonProps & { value: number | null }) {
  const display = value == null ? "" : String(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  async function commit() {
    if (busy) return;
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === "") {
      next = null;
    } else {
      // Accept comma decimal separator (CIS convention) by normalizing
      // before parseFloat.
      const cleaned = trimmed.replace(",", ".");
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n) || n < 0) {
        setError("must be a non-negative number");
        return;
      }
      next = n;
    }
    if (next === value) {
      setEditing(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(display);
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={
          "text-right w-full min-h-[1.25rem] hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded px-1 -mx-1 " +
          (className || "")
        }
        title="Click to edit"
      >
        {value != null ? (
          <span>{value}</span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        disabled={busy}
        className={
          "w-full text-sm text-right rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50 " +
          (className || "")
        }
      />
      {error && (
        <p className="text-[10px] text-red-600 dark:text-red-400 text-right">
          {error}
        </p>
      )}
    </div>
  );
}
