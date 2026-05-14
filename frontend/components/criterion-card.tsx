"use client";
import { ReactNode, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { BacklinksAggregation, SortField, SortRule } from "@/lib/api";

// Curated short-list of common ISO 639-1 codes. Custom codes can still be
// typed via the open input. Order roughly by usage volume in the user's
// niche (Eastern Europe / CIS skew) — the Ahrefs UI uses similar pickers.
const COMMON_LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "kk", name: "Kazakh" },
  { code: "uz", name: "Uzbek" },
  { code: "az", name: "Azerbaijani" },
  { code: "tr", name: "Turkish" },
  { code: "de", name: "German" },
  { code: "fr", name: "French" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "pl", name: "Polish" },
  { code: "nl", name: "Dutch" },
];

/** Comma- or pipe-separated list input. Holds raw string state locally so
 * partially-typed entries don't get parsed-and-rejoined mid-keystroke;
 * commits the parsed array up via onChange whenever the string changes. */
function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  // If the parent rehydrates with a different array (e.g. spec prefilled
  // from a job rerun), sync the draft. Compare on join'd form to avoid
  // overwriting in-progress typing.
  useEffect(() => {
    const incoming = value.join(", ");
    if (
      draft.split(/[,|]/g).map((s) => s.trim()).filter(Boolean).join(", ") !==
      incoming
    ) {
      setDraft(incoming);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  function commit(s: string) {
    setDraft(s);
    const arr = s
      .split(/[,|]/g)
      .map((t) => t.trim())
      .filter(Boolean);
    onChange(arr);
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => commit(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
    />
  );
}

/** Generic min/max integer range input. Either side empty = unbounded.
 * Used for DR / UR / Page Traffic / Keywords (positions) on Backlinks. */
function NumRange({
  label,
  min,
  max,
  hardMin = 0,
  hardMax,
  hint,
  onChange,
  placeholderMin = "min",
  placeholderMax = "max",
}: {
  label: string;
  min: number | null;
  max: number | null;
  /** Lower clamp; defaults to 0. */
  hardMin?: number;
  /** Upper clamp; omit for unbounded (e.g. traffic, positions). */
  hardMax?: number;
  hint?: string;
  onChange: (next: { min: number | null; max: number | null }) => void;
  placeholderMin?: string;
  placeholderMax?: string;
}) {
  function parse(v: string): number | null {
    const t = v.trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    if (Number.isNaN(n)) return null;
    let clamped = Math.max(hardMin, n);
    if (hardMax != null) clamped = Math.min(hardMax, clamped);
    return clamped;
  }
  const inputCls =
    "w-24 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40";
  return (
    <div className="space-y-1">
      <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
        {label}
      </label>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500 dark:text-neutral-400">≥</span>
        <input
          type="number"
          min={hardMin}
          max={hardMax}
          value={min ?? ""}
          onChange={(e) => onChange({ min: parse(e.target.value), max })}
          placeholder={placeholderMin}
          className={inputCls}
        />
        <span className="text-neutral-500 dark:text-neutral-400">≤</span>
        <input
          type="number"
          min={hardMin}
          max={hardMax}
          value={max ?? ""}
          onChange={(e) => onChange({ min, max: parse(e.target.value) })}
          placeholder={placeholderMax}
          className={inputCls}
        />
      </div>
      {hint && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Language multi-select with a chip row of common picks plus a freeform
 * fallback for codes not in the curated list. Stored as a flat string[]. */
function LanguageMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const selected = new Set(value);
  function toggle(code: string) {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    // Preserve order: known-curated first (in COMMON_LANGUAGES order),
    // then any custom codes that aren't in the curated list.
    const known: string[] = [];
    for (const { code: c } of COMMON_LANGUAGES) {
      if (next.has(c)) known.push(c);
    }
    const custom = value.filter(
      (c) => !COMMON_LANGUAGES.some((l) => l.code === c) && next.has(c),
    );
    onChange([...known, ...custom]);
  }
  // Custom codes = anything in `value` not in the curated list.
  const customCodes = value.filter(
    (c) => !COMMON_LANGUAGES.some((l) => l.code === c),
  );
  function setCustom(arr: string[]) {
    const known = value.filter((c) =>
      COMMON_LANGUAGES.some((l) => l.code === c),
    );
    onChange([...known, ...arr]);
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {COMMON_LANGUAGES.map(({ code, name }) => {
          const on = selected.has(code);
          return (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              title={name}
              className={
                "text-xs px-2 py-0.5 rounded-full border transition-colors " +
                (on
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800")
              }
            >
              {code}
            </button>
          );
        })}
      </div>
      <ListInput
        value={customCodes}
        onChange={setCustom}
        placeholder="custom codes (optional, comma-separated)"
      />
    </div>
  );
}

const BACKLINKS_AGGREGATION_VALUES: BacklinksAggregation[] = [
  "similar_links",
  "all",
  "1_per_domain",
];

// Per-criterion sort fields. Each criterion exposes only the Ahrefs columns
// that are sortable for its endpoint — UI never offers an invalid combination.
const SORT_FIELDS_BACKLINKS: SortField[] = [
  "domain_rating_source",
  "url_rating_source",
  "traffic_domain",
  "refdomains_source",
  "positions",
  "traffic",
  "first_seen_link",
];

const SORT_FIELDS_REFDOMAINS: SortField[] = [
  "links_to_target",
  "new_links",
  "first_seen",
];

const SORT_FIELDS_ANCHORS: SortField[] = [
  "refdomains",
  "links_to_target",
  "new_links",
  "first_seen",
];

const SORT_FIELDS_KEYWORDS: SortField[] = [
  "volume_mobile_pct",
  "sum_traffic",
  "is_best_position_set_top_11_50",
];

// --- Generic shell -----------------------------------------------------------

function CriterionShell({
  title,
  enabled,
  onEnabledChange,
  limit,
  onLimitChange,
  limitMax = 1000,
  children,
}: {
  title: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  limit: number;
  onLimitChange: (v: number) => void;
  // Per-criterion cap. Defaults to 1000 (matches Ahrefs criteria);
  // Wayback overrides to 200 because CDX's free backend chokes on
  // larger queries — the schema enforces the same cap.
  limitMax?: number;
  children?: ReactNode;
}) {
  const { t } = useT();
  const ts = t.pages.analyze;
  // Disabled cards collapse to header-only by default (added 2026-05-14
  // wave M). When the user toggles a card on, it auto-expands; toggling
  // off auto-collapses. The chevron lets the user manually peek inside
  // a disabled card without flipping the on/off — useful when cloning a
  // job spec and verifying knobs before enabling. The useEffect below
  // is the auto-sync; setOpen inside the chevron handler short-circuits
  // it for the manual-peek case.
  const [open, setOpen] = useState(enabled);
  useEffect(() => {
    setOpen(enabled);
  }, [enabled]);

  return (
    <section
      className={`rounded-lg border dark:border-neutral-800 p-5 space-y-4 transition-opacity ${
        enabled
          ? "bg-white dark:bg-neutral-900"
          : "bg-neutral-50 dark:bg-neutral-900/40 opacity-70"
      }`}
    >
      <header className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left flex-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-sm"
        >
          <span
            className="text-xs text-neutral-500 dark:text-neutral-400 select-none"
            aria-hidden
          >
            {open ? "▾" : "▸"}
          </span>
          <h3 className="font-semibold">{title}</h3>
        </button>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="rounded border-neutral-300 dark:border-neutral-700"
          />
          <span className="text-sm text-neutral-600 dark:text-neutral-300">
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </header>

      {open && (
        <>
          <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2 text-sm">
            <label className="text-neutral-600 dark:text-neutral-400">
              {ts.fields.limit}
            </label>
            <input
              type="number"
              min={1}
              max={limitMax}
              value={limit}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) onLimitChange(n);
              }}
              disabled={!enabled}
              className="w-28 rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
            />
          </div>

          {enabled && children}
        </>
      )}
    </section>
  );
}

// --- Filter checkbox group --------------------------------------------------

function FilterRow({
  filters,
  showNonSpammy,
  showBacklinksExtras,
  onChange,
}: {
  filters: {
    dofollow: boolean;
    nofollow: boolean;
    non_spammy?: boolean;
    noindex_exclude?: boolean;
    content_only?: boolean;
  };
  showNonSpammy: boolean;
  // Backlinks-only toggles: noindex-exclude + content-only. Hidden on
  // refdomains/anchors because those endpoints don't expose the same
  // is_noindex_source / is_content fields.
  showBacklinksExtras?: boolean;
  onChange: (next: typeof filters) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze;
  const set = (k: keyof typeof filters, v: boolean) =>
    onChange({ ...filters, [k]: v });
  const checkbox = "rounded border-neutral-300 dark:border-neutral-700";
  return (
    <div className="space-y-2">
      <div className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.fields.filters}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.dofollow}
            onChange={(e) => set("dofollow", e.target.checked)}
            className={checkbox}
          />
          {ts.filterLabels.dofollow}
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.nofollow}
            onChange={(e) => set("nofollow", e.target.checked)}
            className={checkbox}
          />
          {ts.filterLabels.nofollow}
        </label>
        {showNonSpammy && (
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!filters.non_spammy}
              onChange={(e) => set("non_spammy", e.target.checked)}
              className={checkbox}
            />
            {ts.filterLabels.non_spammy}
          </label>
        )}
        {showBacklinksExtras && (
          <>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer"
              title={ts.filterLabels.noindexExcludeHint}
            >
              <input
                type="checkbox"
                checked={!!filters.noindex_exclude}
                onChange={(e) => set("noindex_exclude", e.target.checked)}
                className={checkbox}
              />
              {ts.filterLabels.noindexExclude}
            </label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer"
              title={ts.filterLabels.contentOnlyHint}
            >
              <input
                type="checkbox"
                checked={!!filters.content_only}
                onChange={(e) => set("content_only", e.target.checked)}
                className={checkbox}
              />
              {ts.filterLabels.contentOnly}
            </label>
          </>
        )}
      </div>
    </div>
  );
}

// --- Sort builder (backlinks only) ------------------------------------------

function SortBuilder({
  sort,
  onChange,
  fields,
}: {
  sort: SortRule[];
  onChange: (next: SortRule[]) => void;
  fields: SortField[];
}) {
  const { t } = useT();
  const ts = t.pages.analyze;
  const usedFields = new Set(sort.map((r) => r.field));
  const remaining = fields.filter((f) => !usedFields.has(f));

  function addField() {
    const next = remaining[0];
    if (!next) return;
    onChange([...sort, { field: next, direction: "desc" }]);
  }

  function updateAt(idx: number, patch: Partial<SortRule>) {
    onChange(sort.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function removeAt(idx: number) {
    onChange(sort.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-neutral-600 dark:text-neutral-400">
        {ts.fields.sort}
      </div>
      <div className="space-y-2">
        {sort.map((rule, idx) => (
          <div key={idx} className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value={rule.field}
              onChange={(e) =>
                updateAt(idx, { field: e.target.value as SortField })
              }
              className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none"
            >
              {fields
                .filter((f) => f === rule.field || !usedFields.has(f))
                .map((f) => (
                  <option key={f} value={f}>
                    {ts.sortFields[f]}
                  </option>
                ))}
            </select>
            <div
              role="group"
              className="inline-flex items-center rounded-md border dark:border-neutral-700 overflow-hidden"
            >
              {(["desc", "asc"] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => updateAt(idx, { direction: dir })}
                  className={
                    "px-2 py-1 text-xs " +
                    (rule.direction === dir
                      ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100"
                      : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800")
                  }
                >
                  {dir === "desc" ? ts.fields.sortDesc : ts.fields.sortAsc}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              ✕
            </button>
          </div>
        ))}
        {remaining.length > 0 && (
          <button
            type="button"
            onClick={addField}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {ts.fields.addSort}
          </button>
        )}
      </div>
    </div>
  );
}

// --- Public per-criterion components ----------------------------------------

import { CriteriaSpec } from "@/lib/api";

export function BacklinksCard({
  cfg,
  onChange,
}: {
  cfg: CriteriaSpec["backlinks"];
  onChange: (next: CriteriaSpec["backlinks"]) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze;
  const setFilters = (patch: Partial<typeof cfg.filters>) =>
    onChange({ ...cfg, filters: { ...cfg.filters, ...patch } });
  const checkbox = "rounded border-neutral-300 dark:border-neutral-700";
  const summaryCls =
    "cursor-pointer select-none text-sm font-medium text-neutral-700 dark:text-neutral-200 list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden";
  const chevron = (
    <span className="text-neutral-400 dark:text-neutral-500 group-open:rotate-90 transition-transform">
      ▶
    </span>
  );
  return (
    <CriterionShell
      title={t.pages.analyze.criteria.backlinks}
      enabled={cfg.enabled}
      onEnabledChange={(v) => onChange({ ...cfg, enabled: v })}
      limit={cfg.limit}
      onLimitChange={(v) => onChange({ ...cfg, limit: v })}
    >
      {/* 1. Defaults — collapsed by default. Holds the toggles most users
          never need to flip on a per-run basis. The card-level defaults
          (in app/analyze/page.tsx) and BacklinksFilters defaults are kept
          in sync; opening this section is for the "this one's different"
          case. */}
      <details className="group rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60 px-3 py-2">
        <summary className={summaryCls}>
          {chevron}
          <span>{ts.backlinksSections.defaults}</span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-1">
            {ts.backlinksSections.defaultsHint}
          </span>
        </summary>
        <div className="pt-3 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.filters.dofollow}
                onChange={(e) => setFilters({ dofollow: e.target.checked })}
                className={checkbox}
              />
              {ts.filterLabels.dofollow}
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.filters.nofollow}
                onChange={(e) => setFilters({ nofollow: e.target.checked })}
                className={checkbox}
              />
              {ts.filterLabels.nofollow}
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={!!cfg.filters.non_spammy}
                onChange={(e) =>
                  setFilters({ non_spammy: e.target.checked })
                }
                className={checkbox}
              />
              {ts.filterLabels.non_spammy}
            </label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer"
              title={ts.filterLabels.noindexExcludeHint}
            >
              <input
                type="checkbox"
                checked={!!cfg.filters.noindex_exclude}
                onChange={(e) =>
                  setFilters({ noindex_exclude: e.target.checked })
                }
                className={checkbox}
              />
              {ts.filterLabels.noindexExclude}
            </label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer"
              title={ts.filterLabels.contentOnlyHint}
            >
              <input
                type="checkbox"
                checked={!!cfg.filters.content_only}
                onChange={(e) =>
                  setFilters({ content_only: e.target.checked })
                }
                className={checkbox}
              />
              {ts.filterLabels.contentOnly}
            </label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer"
              title={ts.backlinksSections.onePerDomainHint}
            >
              {/* Aggregation simplified to a single checkbox. Checked =
                  "1_per_domain" (the new default — reduces site-wide link
                  noise for the AI judge). Unchecked = "similar_links"
                  (the old default). The third spec value "all" stays
                  valid in the schema but is not surfaced here. */}
              <input
                type="checkbox"
                checked={cfg.aggregation === "1_per_domain"}
                onChange={(e) =>
                  onChange({
                    ...cfg,
                    aggregation: e.target.checked
                      ? "1_per_domain"
                      : "similar_links",
                  })
                }
                className={checkbox}
              />
              {ts.backlinksSections.onePerDomain}
            </label>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Always sent: <code className="font-mono">link_type=text</code>{" "}
            · drops image, redirect, canonical, frame links.
          </p>
        </div>
      </details>

      {/* 2. Domain Rating — left at top level, the most-used range filter. */}
      <NumRange
        label={ts.backlinksSections.drLabel}
        min={cfg.filters.dr_min ?? null}
        max={cfg.filters.dr_max ?? null}
        hardMax={100}
        hint={ts.backlinksSections.rangeHintBounded}
        onChange={(v) => setFilters({ dr_min: v.min, dr_max: v.max })}
      />

      {/* 3. New range filters: # keywords / URL Rating / Page Traffic. */}
      <NumRange
        label={ts.backlinksSections.keywordsLabel}
        min={cfg.filters.positions_min ?? null}
        max={cfg.filters.positions_max ?? null}
        hint={ts.backlinksSections.keywordsHint}
        onChange={(v) =>
          setFilters({ positions_min: v.min, positions_max: v.max })
        }
      />
      <NumRange
        label={ts.backlinksSections.urLabel}
        min={cfg.filters.ur_min ?? null}
        max={cfg.filters.ur_max ?? null}
        hardMax={100}
        hint={ts.backlinksSections.rangeHintBounded}
        onChange={(v) => setFilters({ ur_min: v.min, ur_max: v.max })}
      />
      <NumRange
        label={ts.backlinksSections.trafficLabel}
        min={cfg.filters.traffic_min ?? null}
        max={cfg.filters.traffic_max ?? null}
        hint={ts.backlinksSections.trafficHint}
        onChange={(v) =>
          setFilters({ traffic_min: v.min, traffic_max: v.max })
        }
      />

      {/* 4. Region — collapsed by default. Domain-name substring match +
          language ISO codes both narrow by geography/locale. */}
      <details className="group rounded-md border dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60 px-3 py-2">
        <summary className={summaryCls}>
          {chevron}
          <span>{ts.backlinksSections.region}</span>
        </summary>
        <div className="pt-3 space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
              {ts.backlinksSections.domainContainsLabel}
            </label>
            <ListInput
              value={cfg.filters.domain_contains || []}
              onChange={(v) => setFilters({ domain_contains: v })}
              placeholder="kz, uz, ru"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.backlinksSections.domainContainsHint}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
              {ts.backlinksSections.languagesLabel}
            </label>
            <LanguageMultiSelect
              value={cfg.filters.languages || []}
              onChange={(langs) => setFilters({ languages: langs })}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {ts.backlinksSections.languagesHint}
            </p>
          </div>
        </div>
      </details>

      {/* 5. Sort — kept as-is. */}
      <SortBuilder
        sort={cfg.sort}
        onChange={(s) => onChange({ ...cfg, sort: s })}
        fields={SORT_FIELDS_BACKLINKS}
      />
    </CriterionShell>
  );
}

function AggregationRow({
  value,
  onChange,
}: {
  value: BacklinksAggregation;
  onChange: (v: BacklinksAggregation) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze;
  return (
    <div className="space-y-1">
      <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
        {ts.fields.aggregation}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BacklinksAggregation)}
        className="rounded-md border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none w-full"
      >
        {BACKLINKS_AGGREGATION_VALUES.map((v) => (
          <option key={v} value={v}>
            {ts.aggregationLabels[v]}
          </option>
        ))}
      </select>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.fields.aggregationHelp}
      </p>
    </div>
  );
}

export function RefdomainsCard({
  cfg,
  onChange,
}: {
  cfg: CriteriaSpec["refdomains"];
  onChange: (next: CriteriaSpec["refdomains"]) => void;
}) {
  const { t } = useT();
  return (
    <CriterionShell
      title={t.pages.analyze.criteria.refdomains}
      enabled={cfg.enabled}
      onEnabledChange={(v) => onChange({ ...cfg, enabled: v })}
      limit={cfg.limit}
      onLimitChange={(v) => onChange({ ...cfg, limit: v })}
    >
      <FilterRow
        filters={cfg.filters}
        showNonSpammy
        onChange={(f) =>
          onChange({
            ...cfg,
            filters: {
              ...cfg.filters,
              ...f,
            } as typeof cfg.filters,
          })
        }
      />
      <NumRange
        label="Domain Rating (DR)"
        min={cfg.filters.dr_min ?? null}
        max={cfg.filters.dr_max ?? null}
        hardMax={100}
        hint="Either or both. Empty = unbounded."
        onChange={(v) =>
          onChange({
            ...cfg,
            filters: { ...cfg.filters, dr_min: v.min, dr_max: v.max },
          })
        }
      />
      <div className="space-y-1">
        <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
          Domain contains
        </label>
        <ListInput
          value={cfg.filters.domain_contains || []}
          onChange={(v) =>
            onChange({
              ...cfg,
              filters: { ...cfg.filters, domain_contains: v },
            })
          }
          placeholder="kz, uz, ru"
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Comma- or pipe-separated. OR-matched against the refdomain name.
        </p>
      </div>
      <SortBuilder
        sort={cfg.sort}
        onChange={(s) => onChange({ ...cfg, sort: s })}
        fields={SORT_FIELDS_REFDOMAINS}
      />
    </CriterionShell>
  );
}

export function AnchorsCard({
  cfg,
  onChange,
}: {
  cfg: CriteriaSpec["anchors"];
  onChange: (next: CriteriaSpec["anchors"]) => void;
}) {
  const { t } = useT();
  return (
    <CriterionShell
      title={t.pages.analyze.criteria.anchors}
      enabled={cfg.enabled}
      onEnabledChange={(v) => onChange({ ...cfg, enabled: v })}
      limit={cfg.limit}
      onLimitChange={(v) => onChange({ ...cfg, limit: v })}
    >
      <FilterRow
        filters={cfg.filters}
        showNonSpammy={false}
        onChange={(f) =>
          onChange({
            ...cfg,
            filters: {
              ...cfg.filters,
              ...f,
            } as typeof cfg.filters,
          })
        }
      />
      <SortBuilder
        sort={cfg.sort}
        onChange={(s) => onChange({ ...cfg, sort: s })}
        fields={SORT_FIELDS_ANCHORS}
      />
    </CriterionShell>
  );
}

export function KeywordsCard({
  cfg,
  onChange,
}: {
  cfg: CriteriaSpec["keywords"];
  onChange: (next: CriteriaSpec["keywords"]) => void;
}) {
  const { t } = useT();
  return (
    <CriterionShell
      title={t.pages.analyze.criteria.keywords}
      enabled={cfg.enabled}
      onEnabledChange={(v) => onChange({ ...cfg, enabled: v })}
      limit={cfg.limit}
      onLimitChange={(v) => onChange({ ...cfg, limit: v })}
    >
      <SortBuilder
        sort={cfg.sort}
        onChange={(s) => onChange({ ...cfg, sort: s })}
        fields={SORT_FIELDS_KEYWORDS}
      />
    </CriterionShell>
  );
}

// Wayback CDX criterion. Default-off (opt-in). Limit defaults higher
// (200) than Ahrefs criteria because CDX rows are tiny + snapshot count
// itself is informative — too low a limit lies about activity.
export function WaybackCard({
  cfg,
  onChange,
}: {
  cfg: CriteriaSpec["wayback"];
  onChange: (next: CriteriaSpec["wayback"]) => void;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.wayback;
  const inputCls =
    "w-24 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none";
  return (
    <CriterionShell
      title={t.pages.analyze.criteria.wayback}
      enabled={cfg.enabled}
      onEnabledChange={(v) => onChange({ ...cfg, enabled: v })}
      limit={cfg.limit}
      onLimitChange={(v) => onChange({ ...cfg, limit: v })}
      limitMax={200}
    >
      <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-1">
        {ts.intro}
      </p>
      <div className="space-y-2">
        <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
          {ts.matchTypeLabel}
        </label>
        <select
          value={cfg.filters.match_type}
          onChange={(e) =>
            onChange({
              ...cfg,
              filters: {
                ...cfg.filters,
                match_type: e.target.value as typeof cfg.filters.match_type,
              },
            })
          }
          className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none"
        >
          <option value="exact">{ts.matchType.exact}</option>
          <option value="prefix">{ts.matchType.prefix}</option>
          <option value="host">{ts.matchType.host}</option>
          <option value="domain">{ts.matchType.domain}</option>
        </select>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-neutral-600 dark:text-neutral-400 inline-flex items-center gap-2">
          {ts.fromYear}
          <input
            type="number"
            min={1996}
            max={2100}
            value={cfg.filters.from_year ?? ""}
            onChange={(e) =>
              onChange({
                ...cfg,
                filters: {
                  ...cfg.filters,
                  from_year: e.target.value
                    ? parseInt(e.target.value, 10)
                    : null,
                },
              })
            }
            className={inputCls}
          />
        </label>
        <label className="text-sm text-neutral-600 dark:text-neutral-400 inline-flex items-center gap-2">
          {ts.toYear}
          <input
            type="number"
            min={1996}
            max={2100}
            value={cfg.filters.to_year ?? ""}
            onChange={(e) =>
              onChange({
                ...cfg,
                filters: {
                  ...cfg.filters,
                  to_year: e.target.value
                    ? parseInt(e.target.value, 10)
                    : null,
                },
              })
            }
            className={inputCls}
          />
        </label>
      </div>
      <div className="space-y-2">
        <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
          {ts.collapseLabel}
        </label>
        <input
          type="text"
          value={cfg.filters.collapse}
          onChange={(e) =>
            onChange({
              ...cfg,
              filters: { ...cfg.filters, collapse: e.target.value },
            })
          }
          placeholder="timestamp:6"
          className="w-40 rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none font-mono"
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.collapseHelp}
        </p>
      </div>
      <div className="pt-3 mt-3 border-t dark:border-neutral-800 space-y-3">
        <div>
          <h4 className="text-sm font-medium">{ts.v2Heading}</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {ts.v2Intro}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.sample_pages}
            onChange={(e) =>
              onChange({ ...cfg, sample_pages: e.target.checked })
            }
          />
          <span>{ts.samplePages}</span>
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-1">
          {ts.samplePagesHint}
        </p>
        {cfg.sample_pages ? (
          <div className="space-y-3 pl-6">
            <label className="text-sm text-neutral-600 dark:text-neutral-400 inline-flex items-center gap-2">
              {ts.sampleCount}
              <input
                type="number"
                min={1}
                max={15}
                value={cfg.sample_count}
                onChange={(e) =>
                  onChange({
                    ...cfg,
                    sample_count: Math.max(
                      1,
                      Math.min(15, parseInt(e.target.value, 10) || 6)
                    ),
                  })
                }
                className={inputCls}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-2">
              {ts.sampleCountHint}
            </p>
            <div className="space-y-1">
              <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
                {ts.sampleStrategyLabel}
              </label>
              <select
                value={cfg.sample_strategy}
                onChange={(e) =>
                  onChange({
                    ...cfg,
                    sample_strategy: e.target.value as
                      | "even"
                      | "anchor",
                  })
                }
                className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none w-full max-w-md"
              >
                <option value="even">{ts.sampleStrategy.even}</option>
                <option value="anchor">{ts.sampleStrategy.anchor}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
                {ts.samplePathLabel}
              </label>
              <select
                value={cfg.sample_path_mode}
                onChange={(e) =>
                  onChange({
                    ...cfg,
                    sample_path_mode: e.target.value as "mixed" | "root",
                  })
                }
                className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none w-full max-w-md"
              >
                <option value="mixed">{ts.samplePath.mixed}</option>
                <option value="root">{ts.samplePath.root}</option>
              </select>
            </div>
          </div>
        ) : null}
      </div>
    </CriterionShell>
  );
}

// wayback_classify (added 2026-05-09): combined language + theme + auto-
// chained category. Doesn't fetch — derives from the wayback CR's V2
// samples. Auto-enables wayback + sample_pages on submit if the user
// hasn't done so themselves; the card surfaces this as a clear hint
// rather than a hard validation error.
export function WaybackClassifyCard({
  cfg,
  onChange,
  waybackEnabled,
  waybackSamplingEnabled,
}: {
  cfg: CriteriaSpec["wayback_classify"];
  onChange: (next: CriteriaSpec["wayback_classify"]) => void;
  // Sibling state — read-only — so we can warn when this card will
  // auto-flip them on submit.
  waybackEnabled: boolean;
  waybackSamplingEnabled: boolean;
}) {
  const { t } = useT();
  const ts = t.pages.analyze.waybackClassify;
  const willAutoEnable =
    cfg.enabled && (!waybackEnabled || !waybackSamplingEnabled);
  // Same collapse-when-disabled treatment as `CriterionShell` (added
  // 2026-05-14 wave M). Default state mirrors `cfg.enabled`; auto-syncs
  // when the user toggles, but the chevron lets them peek inside a
  // disabled card without flipping the on/off.
  const [open, setOpen] = useState(cfg.enabled);
  useEffect(() => {
    setOpen(cfg.enabled);
  }, [cfg.enabled]);

  return (
    <div className="rounded-md border dark:border-neutral-700 p-4 bg-white dark:bg-neutral-900/60 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-sm select-none"
          aria-label={open ? "collapse" : "expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => onChange({ ...cfg, enabled: e.target.checked })}
          />
          {ts.title}
        </label>
        <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {ts.aiOnlyBadge}
        </span>
      </div>
      {open && (
        <>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {ts.intro}
      </p>
      {cfg.enabled && (
        <>
          <div className="space-y-1">
            <label className="text-sm text-neutral-600 dark:text-neutral-400 block">
              {ts.languageModeLabel}
            </label>
            <select
              value={cfg.language_mode}
              onChange={(e) =>
                onChange({
                  ...cfg,
                  language_mode: e.target.value as "ai" | "library",
                })
              }
              className="rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm outline-none w-full max-w-md"
            >
              <option value="ai">{ts.languageMode.ai}</option>
              <option value="library">{ts.languageMode.library}</option>
            </select>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {cfg.language_mode === "ai"
                ? ts.languageModeHint.ai
                : ts.languageModeHint.library}
            </p>
          </div>
          {willAutoEnable && (
            <div className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {ts.autoEnableNote}
            </div>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}
