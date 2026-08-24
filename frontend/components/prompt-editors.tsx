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
// Render-order driver. New prompts must be added here AND have a
// matching label in `i18n.tsx pages.settings.prompts.labels`.
// wayback_classify_combined / theme_only / category were added 2026-05-09
// for the new wayback_classify criterion (Analyze page → Language + theme
// + category) — see project memory for the full pipeline.
// `_white` keys (added 2026-06-07) are SENTINEL slots — when iterating
// we render the grouped `WhiteGreyPromptCard` here that handles both
// `<key>_white` AND `<key>_grey` under a single collapsible card with a
// White | Grey tab strip. The `_grey` keys are intentionally absent
// from this list so they don't render twice; they're fetched by key
// from the `prompts` list inside the grouped card. Sentinels in this
// wave: wayback (Quality judge), wayback_classify_combined, wayback_
// classify_theme_only, wayback_category — every prompt the grey-niche
// workflow touches.
const KEYS = [
  "backlinks",
  "refdomains",
  "anchors",
  "keywords",
  // Stop Words judge (2026-08-24). Single prompt — no white/grey split:
  // the grey-niche case is expressed by the operator's word list itself,
  // so it sits in the flat section rather than the tabbed one.
  "stop_words",
  "wayback_white",
  "wayback_classify_combined_white",
  "wayback_classify_theme_only_white",
  "wayback_category_white",
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

// Map sentinel `_white` key → (grey key, i18n meta key under
// `pages.settings.prompts`). Drives the grouped-card dispatch below.
// Adding a new white/grey pair = add a sentinel to KEYS + an entry
// here + an i18n block.
const WHITE_GREY_DISPATCH: Record<
  string,
  { greyKey: string; metaKey: "wayback" | "classify_combined" | "classify_theme_only" | "category" }
> = {
  wayback_white: { greyKey: "wayback_grey", metaKey: "wayback" },
  wayback_classify_combined_white: {
    greyKey: "wayback_classify_combined_grey",
    metaKey: "classify_combined",
  },
  wayback_classify_theme_only_white: {
    greyKey: "wayback_classify_theme_only_grey",
    metaKey: "classify_theme_only",
  },
  wayback_category_white: {
    greyKey: "wayback_category_grey",
    metaKey: "category",
  },
};

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
        // White|Grey grouped editor slot — see WHITE_GREY_DISPATCH.
        const dispatch = WHITE_GREY_DISPATCH[k];
        if (dispatch) {
          const white = prompts.find((x) => x.key === k);
          const grey = prompts.find((x) => x.key === dispatch.greyKey);
          if (!white || !grey) return null;
          return (
            <WhiteGreyPromptCard
              key={k}
              white={white}
              grey={grey}
              metaKey={dispatch.metaKey}
              onSaved={async () => {
                await reload();
              }}
            />
          );
        }
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

// Generic White | Grey grouped prompt card (was `WaybackPromptCard` in
// the first wave; renamed + parameterised 2026-06-07 to cover the CLS
// prompts too). Holds two underlying prompts (one `_white`, one `_grey`)
// under a single collapsible card. Each tab has its own draft state +
// Save/Reset, so switching tabs preserves unsaved edits on the other
// tab until the user explicitly saves. Default open tab = white.
//
// Header/labels/help come from
// `t.pages.settings.prompts.whiteGreyMeta[metaKey]` — adding a new pair
// = add an entry there (en + ru). Avoids per-card boilerplate.
function WhiteGreyPromptCard({
  white,
  grey,
  metaKey,
  onSaved,
}: {
  white: AIPrompt;
  grey: AIPrompt;
  metaKey: "wayback" | "classify_combined" | "classify_theme_only" | "category";
  onSaved: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.prompts;
  const wb = ts.whiteGreyMeta[metaKey];
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"white" | "grey">("white");
  const [whiteDraft, setWhiteDraft] = useState(white.value);
  const [greyDraft, setGreyDraft] = useState(grey.value);
  // Resync drafts when the upstream prompt changes (after a Save / Reset
  // round-trip the parent reloads and feeds new `white.value` / `grey.
  // value` in; without this the textarea would keep showing the stale
  // pre-save draft).
  useEffect(() => {
    setWhiteDraft(white.value);
  }, [white.value]);
  useEffect(() => {
    setGreyDraft(grey.value);
  }, [grey.value]);
  const [busy, setBusy] = useState<"idle" | "saving" | "resetting">("idle");

  const active = tab === "white" ? white : grey;
  const draft = tab === "white" ? whiteDraft : greyDraft;
  const setDraft = tab === "white" ? setWhiteDraft : setGreyDraft;
  const dirty = draft !== active.value;

  async function save() {
    if (!draft.trim()) return;
    setBusy("saving");
    try {
      await api.updatePrompt(active.key, draft);
      onSaved();
    } catch {
      // surfaced by the parent's reload path; nothing to do here
    } finally {
      setBusy("idle");
    }
  }

  async function reset() {
    if (!window.confirm(ts.resetConfirm)) return;
    setBusy("resetting");
    try {
      await api.resetPrompt(active.key);
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
        <span className="font-medium">{wb.heading}</span>
        {/* Two badges side-by-side — one per variant — so the user can
            tell at a glance which slots they've customised without
            expanding the card. */}
        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
          {wb.whiteLabel}:
        </span>
        <span
          className={
            "text-xs px-2 py-0.5 rounded-full " +
            (white.is_custom
              ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400")
          }
        >
          {white.is_custom ? ts.custom : ts.default}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {wb.greyLabel}:
        </span>
        <span
          className={
            "text-xs px-2 py-0.5 rounded-full " +
            (grey.is_custom
              ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400")
          }
        >
          {grey.is_custom ? ts.custom : ts.default}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {wb.help}
          </p>
          {/* Tab strip. Each tab carries its own dirty/clean state so
              switching tabs doesn't drop unsaved edits on the other. */}
          <div
            role="tablist"
            aria-label={wb.heading}
            className="flex gap-1 border-b dark:border-neutral-800 -mb-px"
          >
            {(["white", "grey"] as const).map((k) => {
              const isActive = tab === k;
              const label = k === "white" ? wb.whiteLabel : wb.greyLabel;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setTab(k)}
                  className={
                    "px-3 py-1.5 text-xs font-medium -mb-px border-b-2 transition-colors " +
                    (isActive
                      ? "border-blue-500 text-blue-600 dark:text-blue-400"
                      : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200")
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
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
              disabled={!active.is_custom || busy !== "idle"}
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
