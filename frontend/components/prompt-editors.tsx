"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api, AIPrompt } from "@/lib/api";

// Render order for the prompt cards. New prompts must be added here AND
// have a matching label in `i18n.tsx pages.settings.prompts.labels`.
// wayback_classify_combined / theme_only / category were added 2026-05-09
// for the new wayback_classify criterion (Analyze page → Language + theme
// + category) — see project memory for the full pipeline.
const KEYS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  "wayback",
  "wayback_classify_combined",
  "wayback_classify_theme_only",
  "wayback_category",
  // whois_history_judge (Wave 2b, 2026-05-15) — drives the AI verdict
  // on the whois_history pillar (dropped vs transferred). Editable here
  // so the operator can tweak the signal-hierarchy phrasing /
  // confidence calibration without a redeploy.
  "whois_history_judge",
  "final",
  // Output-language directive appended to every system prompt on RU
  // runs. Editing this here lets the user tighten/loosen the rule
  // without touching source. Listed last because it's a meta-prompt:
  // it doesn't drive a verdict on its own — it constrains the *other*
  // prompts' output language at runtime.
  "localize_ru",
] as const;

export function PromptEditors() {
  const { t } = useT();
  const ts = t.pages.settings.prompts;
  const labels = ts.labels;

  const [prompts, setPrompts] = useState<AIPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const list = await api.listPrompts();
      setPrompts(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  if (error) {
    return (
      <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (!prompts) {
    return <div className="text-sm text-neutral-500">{t.common.loading}</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>
      {KEYS.map((k) => {
        const p = prompts.find((x) => x.key === k);
        if (!p) return null;
        return (
          <PromptEditor
            key={k}
            prompt={p}
            label={labels[k as keyof typeof labels]}
            onSaved={async () => {
              await reload();
            }}
          />
        );
      })}
    </div>
  );
}

function PromptEditor({
  prompt,
  label,
  onSaved,
}: {
  prompt: AIPrompt;
  label: string;
  onSaved: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.prompts;
  const [open, setOpen] = useState(false);
  // Local draft, primed from `prompt.value`. Resync when the prompt prop
  // changes (e.g. after a Reset).
  const [draft, setDraft] = useState(prompt.value);
  useEffect(() => {
    setDraft(prompt.value);
  }, [prompt.value]);

  const [busy, setBusy] = useState<"idle" | "saving" | "resetting">("idle");
  const dirty = draft !== prompt.value;

  async function save() {
    if (!draft.trim()) return;
    setBusy("saving");
    try {
      await api.updatePrompt(prompt.key, draft);
      onSaved();
    } catch {
      // surfaced by reload error path; ignore here
    } finally {
      setBusy("idle");
    }
  }

  async function reset() {
    if (!window.confirm(ts.resetConfirm)) return;
    setBusy("resetting");
    try {
      await api.resetPrompt(prompt.key);
      onSaved();
    } finally {
      setBusy("idle");
    }
  }

  return (
    <section className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/40 rounded-md"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-neutral-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-neutral-500" />
        )}
        <span className="font-medium">{label}</span>
        <span
          className={
            "ml-2 text-xs px-2 py-0.5 rounded-full " +
            (prompt.is_custom
              ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400")
          }
        >
          {prompt.is_custom ? ts.custom : ts.default}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[260px] rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busy !== "idle" || !draft.trim()}
              className="text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === "saving" ? t.common.loading : ts.save}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={!prompt.is_custom || busy !== "idle"}
              className="text-sm px-3 py-1.5 rounded-md border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === "resetting" ? t.common.loading : ts.reset}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
