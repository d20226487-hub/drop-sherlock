"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";

export type Lang = "en" | "ru";

const STORAGE_KEY = "lang";

const messagesEn = {
  appName: "Drop Sherlock",
  langName: { en: "EN", ru: "RU" },
  langSwitchTitle: "Language",
  themeSwitchToLight: "Switch to light mode",
  themeSwitchToDark: "Switch to dark mode",
  common: {
    loading: "Loading…",
    save: "Save",
    saved: "Saved.",
    clear: "Clear",
    cleared: "Cleared.",
    test: "Test",
    cancel: "Cancel",
    error: "Error",
  },
  pagination: {
    searchPlaceholder: "Search…",
    perPage: "Per page",
    showingX: (start: number, end: number, total: number) =>
      `Showing ${start}–${end} of ${total}`,
    showingFiltered: (start: number, end: number, filtered: number, total: number) =>
      `Showing ${start}–${end} of ${filtered} (filtered from ${total})`,
    none: "Nothing matches your search.",
    prev: "Previous",
    next: "Next",
    page: (cur: number, total: number) => `Page ${cur} of ${total}`,
  },
  nav: {
    dashboard: "Dashboard",
    backlog: "Backlog",
    // `analyze` is the legacy nav label; kept for any pre-Wave-1
    // references in the codebase. Use `check` for the new pillar
    // dropdown trigger.
    analyze: "Analyze",
    check: "Check",
    jobs: "Jobs",
    database: "Database",
    shares: "Shares",
    errors: "Errors",
    settings: "Settings",
    databaseDropdown: {
      label: "Database",
      analyzeList: "Analyze List",
      banList: "Ban List",
      toggleAria: "Open Database menu",
    },
    // Wave 1 (2026-05-15) — Check / Jobs split into 3-pillar dropdowns.
    // Quality = current Wayback+Ahrefs pipeline; Whois History +
    // Availability ship in waves 2/3.
    checkDropdown: {
      quality: "Quality (Wayback + Ahrefs)",
      whoisHistory: "Whois History",
      availability: "Availability",
      ahrefsBatchAnalysis: "Ahrefs Batch Analysis",
      toggleAria: "Open Check menu",
    },
    jobsDropdown: {
      quality: "Quality",
      whoisHistory: "Whois History",
      availability: "Availability",
      ahrefsBatchAnalysis: "Ahrefs Batch Analysis",
      toggleAria: "Open Jobs menu",
    },
  },
  pages: {
    dashboard: {
      title: "Dashboard",
      intro: "Live status of all configured API integrations.",
      refresh: "Refresh",
      checkedAt: (when: string) => `Checked ${when}`,
      providerNames: {
        ahrefs: "Ahrefs",
        gemini: "Google Gemini",
        github_models: "GitHub Models",
        openrouter: "OpenRouter",
        vertex_ai: "Google Vertex AI",
        whoisfreaks: "WhoisFreaks",
      },
      whoisfreaksConfiguredHint:
        "API key configured. The Dashboard does NOT probe live (every WhoisFreaks request costs money). Use Settings → Whois History → Test to verify live (1 request per click).",
      states: {
        ok: "Working",
        unconfigured: "Not configured",
        error: "Error",
        unknown: "Checking…",
      },
      noKeyYet: "No credentials saved yet. Open Settings to add one.",
      openSettings: "Open Settings",
      elapsed: (ms: number) => `${ms} ms`,
      // Wave 2b (2026-05-15): default Dashboard load is now passive
      // (zero upstream calls). These strings cover the new two-button
      // UX + the mode banner explaining which view the user is on.
      refreshHint:
        "Re-read configured-state from the DB. No upstream requests — instant.",
      liveChecks: "Run live checks",
      liveChecksRunning: "Running…",
      liveChecksHint:
        "Probe every AI provider, Ahrefs, and Wayback for current liveness. Uses each provider's FREE test endpoint, so it costs you nothing. WhoisFreaks stays config-only (every request costs money — use Settings → Whois History → Test for a single explicit probe).",
      liveCheckedAt: (when: string) => `Live-checked ${when}`,
      lastLiveAt: (when: string) => `Last live check: ${when}`,
      modeBannerConfig:
        "Showing CONFIGURED state (no upstream requests). Click \"Run live checks\" to verify providers are responding right now.",
      modeBannerLive:
        "Showing LIVE state — providers were probed just now. Refresh re-reads configured-state without re-probing.",
    },
    analyze: {
      title: "Analyze",
      intro:
        "Paste or upload domains, pick criteria, kick off a job. Results show up below as a clean summary table.",
      domains: {
        heading: "Domains",
        help: "One per line. Schemes (https://) and paths are stripped automatically.",
        placeholder: "example.com\nanother.com\nthird-domain.io",
        count: (n: number) => `${n} domain${n === 1 ? "" : "s"}`,
        upload: "Upload file",
        uploadHint: ".txt or .csv — one domain per line",
      },
      criteria: {
        heading: "Criteria",
        help: "Toggle each criterion on or off. Per-criterion limit, filter, and sort rules apply only when the criterion is enabled.",
        backlinks: "Backlinks",
        refdomains: "Referring domains",
        anchors: "Anchors",
        keywords: "Organic keywords",
        wayback: "Wayback history",
        wayback_classify: "Language + theme + category",
        whois_history: "Whois history",
        availability: "Availability",
        waybackDiscoverHint:
          "Disabled cards are collapsed — click the chevron on a card to expand and enable it. Wayback adds a history signal; Wayback Classify auto-detects language, theme, and category.",
      },
      fields: {
        limit: "Limit",
        filters: "Filters",
        sort: "Sort by",
        addSort: "+ Add sort field",
        sortAsc: "Asc",
        sortDesc: "Desc",
        aggregation: "Aggregation",
        aggregationHelp:
          "Cost is the same for all modes (Ahrefs charges by limit, not rows returned). 'One per domain' gives the AI a wider link-graph view per row budget.",
      },
      aggregationLabels: {
        similar_links: "Similar links (default)",
        all: "All (no dedup)",
        "1_per_domain": "One per domain",
      },
      filterLabels: {
        dofollow: "dofollow",
        nofollow: "nofollow",
        non_spammy: "Non-spammy (is_spam=0)",
        noindexExclude: "Exclude noindex referring pages",
        noindexExcludeHint:
          "Drops backlinks whose referring page has <meta name=\"robots\" content=\"noindex\">. Sends is_noindex_source=0.",
        contentOnly: "Editorial / in-content links only",
        contentOnlyHint:
          "Restricts to article-body editorial links (is_content=1). Without this, footer / sidebar / sitewide / comment placements come back too.",
        rootOnly: "Root-domain referrers only",
        rootOnlyHint:
          "Drops backlinks whose referring URL is on a subdomain (e.g. blog.example.com/path). Sends is_root_source=1. Subdomain backlinks tend to be self-network footprints + weaker editorial signal; uncheck this if you specifically want to study subdomain link patterns.",
      },
      backlinksSections: {
        defaults: "Defaults",
        defaultsHint: "(applied automatically — open to override)",
        onePerDomain: "Aggregation: 1 per domain",
        onePerDomainHint:
          "Returns one backlink per referring domain. Reduces site-wide / boilerplate noise so the AI judges link diversity, not link count.",
        drLabel: "Domain Rating (DR)",
        urLabel: "URL Rating (UR)",
        keywordsLabel: "Source-page keywords (positions)",
        keywordsHint:
          "Filter by how many organic keywords the referring page ranks for. Either / both / neither.",
        trafficLabel: "Source-page traffic",
        trafficHint:
          "Estimated monthly organic visits to the referring page. Either / both / neither.",
        rangeHintBounded: "0–100. Either or both. Empty = unbounded.",
        region: "Region",
        domainContainsLabel: "Domain contains",
        domainContainsHint:
          "Comma- or pipe-separated. OR-matched against the referring root domain. Useful for keeping/dropping country-TLD groups.",
        languagesLabel: "Languages",
        languagesHint:
          "Empty = no language filter. Multiple = OR-matched against each row's languages array.",
      },
      keywords: {
        // Ahrefs organic-keywords `date_compared` (2026-05-17). Predefined
        // buckets mirror Ahrefs's own UI choices.
        dateComparedLabel: "Compare to",
        dateComparedHelp:
          "Optional. When set, Ahrefs adds prior-period `_prev` fields to each row so the AI judge sees keyword-footprint trend (growing vs decaying).",
        dateCompared: {
          off: "off (no comparison)",
          "3m": "3 months ago",
          "6m": "6 months ago",
          "1y": "1 year ago",
          "2y": "2 years ago",
          "5y": "5 years ago",
        },
      },
      wayback: {
        intro:
          "Free, unauthenticated. Pulls snapshot history from the Wayback CDX API — surfaces site age, recent activity, and 301/302 redirect tails. Strong signal for spotting dropped domains that already migrated elsewhere.",
        matchTypeLabel: "Match type",
        matchType: {
          exact: "exact (only the exact URL)",
          prefix: "prefix (URL starts with target)",
          host: "host (single host, no subdomains) — recommended for batch jobs",
          domain: "domain (host + all subdomains) — slow on CDX, use for deep single-domain triage",
        },
        fromYear: "From year",
        toYear: "To year",
        collapseLabel: "Collapse adjacent same-month rows",
        collapseHelp:
          "CDX `collapse=` value. \"timestamp:6\" ≈ collapse to one snapshot per month per URL — drops noise from densely-crawled sites without losing event-level signal. Empty = no collapsing.",
        v2Heading: "Page-content sampling (V2)",
        v2Intro:
          "Fetch a few archived HTML pages and extract title + headings + 150-char body excerpt. Lets the AI judge spot year-over-year theme drift (e.g. \"Pizza recipes 2018 → Casino bonuses 2024\"). Slow — adds 1–3s per pick.",
        samplePages: "Sample snapshot pages",
        samplePagesHint:
          "Off = CDX rows only (fast). On = additionally pull a handful of archived pages so the AI sees actual titles over time.",
        sampleCount: "Sample count",
        sampleCountHint: "How many archived pages to fetch per domain (1–15). 6 ≈ one per ~3 years on a 20-year history.",
        sampleStrategyLabel: "Pick strategy",
        sampleStrategy: {
          even: "Even — quantile-spaced across the timeline",
          anchor:
            "Anchor — around CDX anomaly events (status flips, mimetype flips, length jumps, big crawl gaps)",
        },
        samplePathLabel: "URL path",
        samplePath: {
          mixed: "Mixed — use whatever URL each chosen CDX row points at",
          root: "Root — always fetch the snapshot of /",
        },
      },
      waybackClassify: {
        title: "Language + theme + category",
        aiOnlyBadge: "AI-only · derived from Wayback samples",
        intro:
          "Detects the site's primary language and theme from archived Wayback page samples (titles + headings + body excerpts), then auto-classifies the theme into one of your predefined categories from Settings. Designed for triaging dropped domains: the most-recent state plus drift detection vs. the historical baseline.",
        languageModeLabel: "Language detection mode",
        languageMode: {
          ai: "AI — combined language + theme prompt (uses <html lang> as a hint)",
          library:
            "Library (lingua-language-detector) — deterministic; theme runs separately via AI",
        },
        languageModeHint: {
          ai: "Same AI call returns both language and theme. Faster, but language can be flaky on short non-Latin text.",
          library:
            "Lingua aggregates a primary language deterministically from sample text. AI runs theme-only afterward. More reliable on short text; ignores prompt edits to language behavior.",
        },
        autoEnableNote:
          "On submit: Wayback + page-content sampling will be auto-enabled (this criterion needs the V2 samples to work).",
      },
      sortFields: {
        domain_rating_source: "DR (source domain)",
        url_rating_source: "UR (source URL)",
        traffic_domain: "Domain Traffic",
        refdomains_source: "Referring Domains",
        positions: "Keywords",
        traffic: "Page Traffic",
        first_seen_link: "First Seen",
        links_to_target: "Links to Target",
        new_links: "New Links",
        first_seen: "First Seen",
        refdomains: "Ref. Domains",
        volume_mobile_pct: "Mobile Search Volume",
        sum_traffic: "Traffic",
        is_best_position_set_top_11_50: "Top 11–50",
      },
      preview: {
        heading: "API request preview",
        help: "Updated as you tweak the form. These are the exact GET URLs Drop Sherlock will hit per domain when the job runs.",
        empty: "Enable at least one criterion to see request previews.",
        domainNote: (d: string) => `Showing requests for: ${d}`,
        copy: "Copy",
        copied: "Copied",
        disabled: "(disabled)",
      },
      jobName: {
        label: "Job name (optional)",
        placeholder: "Leave blank to auto-name from the first domain + timestamp",
      },
      ai: {
        heading: "AI verdict",
        help: "Pick which AI provider judges each criterion. Models are picked from your registered list (manage in Settings). Set None to skip AI and only fetch Ahrefs data.",
        provider: "Provider",
        none: "None — skip AI",
        notConfigured: "(not configured)",
        modelLabel: (model: string) => `model: ${model}`,
        noModel: "no default model — set one in Settings",
        modelPickerLabel: "Model",
        modelDropdownDefaultOption: (model: string) =>
          `default · ${model}`,
        modelDropdownNoDefault: "default (none set)",
        noKnownModels: "no models registered for this provider — add some in",
        skippedWarning:
          "AI is currently off. The summary table will be empty for this run. Pick a provider above to enable verdicts.",
      },
      jobNotes: {
        label: "Notes (optional)",
        placeholder: "Anything you want to remember about this batch",
      },
      rerunBanner: {
        title: (jobName: string) => `Rerunning: ${jobName}`,
        help: "Edit the criteria and submit. A new run will be added to this job; the previous run stays as history.",
        clear: "Cancel rerun (start fresh)",
        useCacheLabel: "Reuse data from previous runs (when criteria match)",
        useCacheHelp:
          "When on, identical Ahrefs requests and identical AI prompts are copied from earlier runs of this job — saves Ahrefs units and AI tokens. Turn off to force fresh fetches.",
      },
      fromDatabaseBanner: {
        title: (n: number) =>
          `Analyzing ${n} domain${n === 1 ? "" : "s"} from Database`,
        help: "Pick which criteria to (re)run below. A new job will be created. The cross-job cache option below lets the runner reuse Ahrefs data and AI verdicts from any prior run anywhere in your workspace whose criteria match.",
        clear: "Clear (start fresh /analyze)",
        crossCacheLabel:
          "Reuse data from previous analyses across ALL jobs (cross-job cache)",
        crossCacheHelp:
          "When on, the runner looks across the entire database for any prior CR row whose criterion + filters/sort/limit hash matches what you're submitting now. Hits get copied forward — saves Ahrefs units and AI tokens. Untick to fetch everything fresh, even if you ran the same analysis before in another job.",
        prefilledFromJob: (name: string, jobId: number) =>
          `Criteria + AI pre-filled from "${name}" (job #${jobId}) — the job that produced the Wayback verdicts on these rows. Leave these settings as-is to maximize cache hits; any edit may change the params hash and cause fresh fetches.`,
      },
      submit: {
        cancel: "Cancel run",
        cancelConfirm:
          "Cancel this run? Already-fetched data is kept; pending domains will be skipped.",
        pause: "Pause",
        resume: "Resume",
        run: "Run analysis",
        rerunCta: "Save & rerun",
        running: "Submitting…",
        validation: {
          noDomains: "Add at least one domain.",
          noCriteria: "Enable at least one criterion.",
        },
        errors: {
          allBanned: (count: number, sample: string[], truncated: boolean) => {
            const head =
              count === 1
                ? "The submitted domain is on the Ban List"
                : `All ${count} submitted domains are on the Ban List`;
            if (sample.length === 0) return `${head}.`;
            const list = sample.join(", ");
            const tail = truncated ? `, … (${count} total)` : "";
            return `${head}: ${list}${tail}.`;
          },
        },
        progress: (done: number, total: number) =>
          `${done} / ${total} domains complete`,
        progressFailed: (n: number) => `· ${n} failed`,
        statusPending: "Queued",
        statusRunning: "Running",
        statusDone: "Done",
        statusFailed: "Failed",
        runLink: (runId: number) => `Run #${runId}`,
        finishedNote:
          "Raw Ahrefs data is in the DB. The AI summary table lands in the next step.",
        startNew: "Start a new analysis",
      },
      summaryTable: {
        heading: "Summary",
        placeholder: "Submit a job to see the AI-judged summary here. Detail per domain lives on the Jobs page.",
        cols: {
          domain: "Domain",
          backlinks: "Backlinks",
          refdomains: "Refdomains",
          anchors: "Anchors",
          keywords: "Keywords",
          final: "Final",
          wayback: "Wayback",
        },
        noAi: "(no AI)",
        loadingVerdicts: "Waiting for AI verdicts…",
        viewDetail: "Open",
      },
    },
    jobs: {
      title: "Jobs",
      intro: "All past analyses, with notes, runs, and per-domain detail pages.",
      empty: "No jobs yet — kick off your first analysis on the Analyze page.",
      emptyArchived: "No archived jobs.",
      goAnalyze: "Go to Analyze",
      tabs: {
        active: "Active",
        archived: "Archived",
        all: "All",
      },
      bulk: {
        selected: (n: number) => `${n} selected`,
        delete: "Delete",
        archive: "Archive",
        unarchive: "Unarchive",
        deleteConfirm: (n: number) =>
          `Delete ${n} job${n === 1 ? "" : "s"} and all their runs? This cannot be undone.`,
        deleting: "Deleting…",
        archiving: "Archiving…",
        unarchiving: "Unarchiving…",
      },
      archivedBadge: "archived",
      cols: {
        name: "Name",
        notes: "Notes",
        runs: "Runs",
        latestStatus: "Latest run",
        created: "Created",
      },
      latestRun: {
        none: "No runs yet",
        statusOk: (done: number, total: number) => `${done}/${total} done`,
        statusFailed: (failed: number, total: number) => `${failed}/${total} failed`,
      },
      detail: {
        backLink: "← All jobs",
        rename: "Rename",
        delete: "Delete",
        archive: "Archive",
        unarchive: "Unarchive",
        archivedBanner:
          "This job is archived — it stays out of the default Jobs list. Unarchive to bring it back.",
        cancel: "Cancel",
        cancelConfirm:
          "Cancel this run? Already-fetched data is kept; pending domains will be skipped.",
        pause: "Pause",
        resume: "Resume",
        compareRuns: "Compare runs",
        statusBadgePaused: "paused",
        renamePrompt: "New name?",
        deleteConfirm: (name: string) =>
          `Delete "${name}" and all its runs? This cannot be undone.`,
        deleteRun: "Delete",
        deleteRunConfirm: (runId: number, total: number) =>
          `Delete Run #${runId} and its ${total} domain row(s)? This cannot be undone.`,
        rerun: "Rerun with new criteria",
        editNotes: "Edit notes",
        saveNotes: "Save notes",
        cancelEdit: "Cancel",
        notesPlaceholder: "Add notes for this job…",
        notesEmpty: "(no notes)",
        runsHeading: "Runs",
        noRuns: "No runs yet.",
        pinsHeading: "Per-criterion pins",
        pinsHint:
          "Which Run feeds each criterion for this Job's Database rollup. Read-only here — pin/unpin from the Per-criterion pins panel on a Run page. Gaps fall through to the most recent Run that has data for that criterion.",
        pinsBadge: (pinned: number, total: number) =>
          `${pinned}/${total} pinned`,
        pinsUnpinned: "not pinned",
        runLabel: (id: number, name: string = "") =>
          name?.trim() || `Run #${id}`,
        renameRun: "Rename",
        // Per-job Run pin (added 2026-05-10). Pinned run = the canonical
        // run for the rollup pills at the top of the page. Pin button
        // only shows for `done` runs (or already-pinned runs you can
        // click to unpin).
        pinRun: "Pin",
        pinRunHint:
          "Pin this run as the canonical source for the verdict roll-up. Pinning replaces any other pin in this job.",
        unpinRun: "Unpin",
        unpinRunHint:
          "Unpin this run. Roll-up reverts to the latest run.",
        runPinnedBadge: "PINNED",
        runPinnedHint: "Roll-up at the top of this page counts domains from this run.",
        renameRunPrompt: (id: number) =>
          `New label for Run #${id}? (leave blank to clear)`,
        progress: (done: number, total: number, failed: number) => {
          const failedSuffix = failed > 0 ? ` · ${failed} failed` : "";
          return `${done}/${total} domains${failedSuffix}`;
        },
        startedAt: (when: string) => `Started ${when}`,
        finishedAt: (when: string) => `Finished ${when}`,
        meta: (created: string, updated: string) =>
          `Created ${created} · Updated ${updated}`,
        rollup: {
          // Source-of-truth pill prefix on the rollup pill row. Switches
          // between "Pinned: Run #N" and "Latest: Run #N" depending on
          // whether the user pinned a run for this job.
          fromPinnedRun: (runId: number) => `Pinned: Run #${runId}`,
          fromLatestRun: (runId: number) => `Latest: Run #${runId}`,
          pinnedSourceHint:
            "Counts come from the pinned run. Unpin to revert to the latest run.",
          latestSourceHint:
            "Counts come from the latest run. Pin a different run to lock the roll-up to it.",
          label: {
            good: "good",
            mixed: "mixed",
            low_quality: "low quality",
            partial: "partial",
            no_verdict: "no verdict",
          },
          // Pillar-native labels for the verdict rollup chips (added
          // 2026-05-16). Same bucket keys, different names so the
          // job-page pills match the pillar vocabulary instead of
          // forcing every job kind through the quality-pillar words.
          labelAvailability: {
            good: "available",
            mixed: "registered",
            low_quality: "low quality",
            // Double domain under a private multi-label suffix
            // (jcg.us.com) — availability can't be verified (2026-06-02).
            not_supported: "not supported",
            // 2026-05-16 split: distinct keys for the two non-terminal
            // outcomes. `unknown` = cascade ran, couldn't classify (no
            // retry helps); `error` = cascade itself failed (retryable).
            // `no_verdict` now only fires for runner-level anomalies
            // (missing CR, malformed data_json) and is typically zero.
            unknown: "unknown",
            error: "error",
            partial: "partial",
            no_verdict: "no verdict",
          },
          labelWhois: {
            good: "stable",
            mixed: "drift suspected",
            low_quality: "dropped/transferred",
            partial: "partial",
            no_verdict: "no verdict",
          },
          labelAhrefsBatch: {
            good: "fetched",
            error: "error",
            no_verdict: "no data",
          },
        },
      },
      run: {
        backToJob: (name: string) => `← ${name}`,
        title: (id: number, name: string = "") =>
          name?.trim() || `Run #${id}`,
        rename: "Rename",
        renamePrompt: (id: number) =>
          `New label for Run #${id}? (leave blank to clear)`,
        statusBadge: {
          pending: "queued",
          running: "running",
          done: "done",
          failed: "failed",
          canceled: "canceled",
        },
        domainsHeading: "Domains",
        cols: {
          domain: "Domain",
          status: "Status",
          criteria: "Criteria",
          ai: "AI",
          aiWayback: "AI Wayback",
          aiAhrefs: "AI Ahrefs",
          language: "Lang",
          theme: "Theme",
          category: "Category",
          finished: "Finished",
        },
        viewDomain: "Open",
        empty: "This run has no domains.",
        emptyFiltered:
          "No domains match the current filter. Clear it to see the rest.",
        clearFilter: "Clear filter",
        // Server-side batch paginator. The label functions take 1-based
        // indexes so the user-visible numbers match what they'd see in
        // a typical "showing 1–200 of 1000" pagination.
        serverBatchRange: (start: number, end: number, total: number) =>
          `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`,
        serverBatchUnfilteredHint: (total: number) =>
          `(filtered from ${total.toLocaleString()} total)`,
        serverBatchPage: (current: number, total: number) =>
          `Batch ${current} / ${total}`,
        serverBatchPrev: "← Prev",
        serverBatchNext: "Next →",
        reanalyze: "Reanalyze with AI",
        reanalyzeHint:
          "Re-judge every domain in this run with a fresh AI call. Bypasses the AI cache. Reuses existing Ahrefs data — no refetch.",
        reanalyzing: "Reanalyzing…",
        reanalyzeStarted: "Reanalysis started — verdicts will refresh below.",
        reanalyzeFailed: "Reanalyze failed",
        pause: "Pause",
        resume: "Resume",
        cancel: "Cancel",
        cancelConfirm:
          "Cancel this run? Domains already finished will keep their data; in-flight ones stop.",
        pinIndicator: "★ pinned",
        // Per-criterion pinning (added 2026-05-12)
        pinPerCriterionHeading: "Per-criterion pins",
        pinPerCriterionHint:
          "For each criterion this Job uses, choose which Run supplies its data on the Database page. Lets you stitch an iterative cascade — Wayback from one Run, Ahrefs from another.",
        pinAllCriteria: "Pin all populated",
        pinAllCriteriaHint:
          "Pin every criterion this Run has data for to this Run.",
        pinAllCriteriaResult: (pinned: number, replaced: number) =>
          replaced > 0
            ? `Pinned ${pinned} criterion${pinned === 1 ? "" : "s"} (replaced ${replaced} prior).`
            : `Pinned ${pinned} criterion${pinned === 1 ? "" : "s"}.`,
        pinCriterionHere: "★ pinned here",
        pinCriterionElsewhere: (runId: number) => `pinned to Run #${runId}`,
        pinCriterionNone: "not pinned",
        retryFailed: (n: number) =>
          n > 0 ? `Retry ${n} failed` : "Retry failed",
        retryFailedHint:
          "Re-run every failed Ahrefs/Wayback fetch and every failed AI verdict in this run. Refetches data where missing; re-judges where data exists. Disabled criteria are left alone.",
        retryFailedConfirm: (criteria: number, domains: number) =>
          `Retry ${criteria} failed criteria across ${domains} domain${domains === 1 ? "" : "s"}? This re-spends Ahrefs units for refetched criteria and AI tokens for re-judged ones.`,
        retryFailedRunning: "Dispatching…",
        retryFailedProgress: (inFlight: number, total: number) =>
          `Retrying ${inFlight} of ${total}…`,
        retryFailedProgressBanner: (inFlight: number, total: number) =>
          `Retrying — ${inFlight} of ${total} domain${total === 1 ? "" : "s"} still in flight…`,
        retryFailedDispatched: (criteria: number, domains: number) =>
          `Retry dispatched — ${criteria} criteria across ${domains} domain${domains === 1 ? "" : "s"}. Waiting for workers to start…`,
        retryFailedNone: "No failed criteria to retry.",
        retryFailedFailed: "Retry failed",
        // Cancel-retry (added 2026-05-24). Only rendered while a
        // Retry-failed dispatch is in flight.
        cancelRetry: "Cancel retry",
        cancelRetryBusy: "Canceling…",
        cancelRetryHint:
          "Stop the in-flight Retry-failed dispatch. Cancels worker tasks AND resets RDs left stuck in 'running' state.",
        cancelRetryConfirm:
          "Cancel the in-flight retry? Any work already done is preserved; in-flight criteria are aborted mid-fetch and RDs left in 'running' status are flipped to a sane terminal state.",
        cancelRetryDone: (canceled: number, flipped: number) =>
          `Retry canceled — ${canceled} task${canceled === 1 ? "" : "s"} aborted, ${flipped} RD${flipped === 1 ? "" : "s"} reset.`,
        cancelRetryFailed: "Cancel retry failed",
        // Filter + multi-select + bulk-retry (added 2026-05-12).
        filterStatusLabel: "Status",
        filterStatusAll: "all",
        filterStatusPending: "pending",
        filterStatusRunning: "running",
        filterStatusDone: "done",
        filterStatusFailed: "failed",
        filterStatusCanceled: "canceled",
        filterWaybackLabel: "Wayback CDX",
        filterWaybackAny: "any",
        filterWaybackZero: "0 rows",
        filterWaybackNonzero: "≥ 1 row",
        // Availability verdict filter (2026-05-16) — only rendered on
        // Availability-pillar runs.
        filterAvailabilityLabel: "Availability",
        filterAvailabilityAny: "any",
        filterAvailabilityAvailable: "available",
        filterAvailabilityRegistered: "registered",
        // Real `not_supported` verdict (2026-06-02): "double domains"
        // under a private multi-label suffix (e.g. jcg.us.com) the
        // cascade refuses to guess on. Distinct from `unknown` below.
        filterAvailabilityNotSupported: "not supported",
        // `unknown` = cascade ran but couldn't determine (no RDAP server
        // for the TLD + unparseable WHOIS). Was previously mislabeled
        // "not supported"; renamed back 2026-06-02 now that a real
        // not_supported status exists. Bucket key stays `unknown`.
        filterAvailabilityUnknown: "unknown",
        filterAvailabilityError: "error",
        // `filterAvailabilityNoVerdict` removed from the Run-page
        // filter 2026-05-17 (orphaned/missing CRs aren't actionable
        // from a filter). Key kept for backward-compat in case other
        // surfaces still reference it.
        filterAvailabilityNoVerdict: "no verdict",
        filterAvailabilityClear: "Clear selection",
        selectAllOnPage: "Select all on this page",
        selectAllMatching: (n: number) =>
          `Select all matching the current filter (${n})`,
        clearSelection: "Clear selection",
        bulkSelected: (n: number) =>
          `${n} domain${n === 1 ? "" : "s"} selected`,
        bulkRetry: (n: number) => `Retry selected (${n})`,
        bulkRetryRunning: "Retrying…",
        bulkRetryCriteriaHeading: "Criteria to retry",
        bulkRetryCriteriaHint:
          "Only criteria failed on the selected domains will be re-run. Unchecked criteria are left alone even if they failed.",
        bulkRetryClassifyAutoNote:
          "wayback_classify reads V2 page samples from the wayback row. Retrying wayback refetches those samples, so wayback_classify will be retried automatically alongside it to keep verdicts consistent — even though you unchecked it.",
        bulkRetryResampleLabel: "Re-sample V2 only (skip CDX refetch)",
        bulkRetryResampleHelp:
          "Use when wayback shows V1 rows but the V2 samples are missing or stale (e.g. classify failed with \"needs V2 samples\"). Reuses the existing CDX rows, re-collects V2, and re-judges both the wayback verdict and wayback_classify. Skips the slow CDX call.",
        bulkRetryConfirm: "Retry on selected",
        bulkRetryNothing:
          "Nothing to retry — none of the selected domains have failed criteria in the picked set.",
        bulkRetryResult: (domains: number, criteria: number) =>
          `Retrying ${criteria} criteria across ${domains} domain${domains === 1 ? "" : "s"}.`,
        retryOutcomeAllRecovered: (n: number) =>
          `All ${n} criteria recovered after retry.`,
        retryOutcomePartial: (recovered: number, stillFailed: number) =>
          `Recovered ${recovered}; ${stillFailed} criteria still failed.`,
        retryOutcomeAllStillFailed: (n: number) =>
          `All ${n} criteria still failed after retry.`,
        retryOutcomeViewErrors: "View on Errors page",
        exportVisible: (n: number) => `Export visible (${n})`,
        exportAll: (n: number) => `Export all (${n})`,
        exportVisibleHelp:
          "Download a CSV of the rows currently matching your search.",
        exportAllHelp: "Download every domain in this run.",
        // Score-weights override panel (added 2026-05-13 wave J).
        scoreWeightsHeading: "Score weights",
        scoreWeightsHint:
          "Recompute this run's final scores with custom criterion weights. The AI-written summary and recommendation stay untouched — only the numeric final + confidence are replaced. Partial rows (where a criterion failed at synth time) are skipped.",
        scoreWeightsOverrideActive: "Custom weights applied to this run",
        scoreWeightsOverrideGlobal: "Using global Settings weights",
        scoreWeightsExclude: "exclude",
        scoreWeightsSum: (s: number) => `Sum: ${s.toFixed(2)} / 1.00`,
        scoreWeightsSumOk: "OK",
        scoreWeightsSumOff: "should sum to 1.00",
        scoreWeightsNormalize: "Normalize to 1.0",
        scoreWeightsPreview: "Preview",
        scoreWeightsApply: "Apply to this run",
        scoreWeightsReset: "Reset to global",
        scoreWeightsResetDisabledHint:
          "No per-run override is active — nothing to reset.",
        scoreWeightsResetConfirm:
          "Clear the per-run override and recompute scores using the current global Settings weights?",
        scoreWeightsApplyConfirm:
          "Rewrite the final score of every non-partial domain in this run with these weights? The AI-written prose stays unchanged.",
        scoreWeightsBusyPreview: "Recomputing…",
        scoreWeightsBusyApply: "Applying…",
        scoreWeightsBusyReset: "Resetting…",
        scoreWeightsPreviewTitle: "Recomputed scores (preview)",
        scoreWeightsPreviewCount: (changed: number, total: number) =>
          `${changed} of ${total} domain${total === 1 ? "" : "s"} would change`,
        scoreWeightsColDomain: "Domain",
        scoreWeightsColOld: "Old",
        scoreWeightsColNew: "New",
        scoreWeightsColDelta: "Δ",
        scoreWeightsPartial: "—",
        scoreWeightsFailedToLoad: "Could not load global weights",
        scoreWeightsFailedPreview: "Preview failed",
        scoreWeightsFailedApply: "Apply failed",
      },
      compare: {
        backLink: "← All jobs",
        title: (jobName: string) => `Compare runs · ${jobName}`,
        intro:
          "Side-by-side AI verdicts for the same job. Cells with different verdicts between runs are highlighted.",
        notEnoughRuns:
          "This job needs at least 2 runs to compare. Rerun it with different criteria or a different model.",
        runA: "Run A",
        runB: "Run B",
        cols: {
          domain: "Domain",
          backlinks: "Backlinks",
          refdomains: "Refdomains",
          anchors: "Anchors",
          keywords: "Keywords",
          wayback: "Wayback",
          wayback_classify: "Classify",
          theme: "Theme",
          whois_history: "Whois",
          final: "Final",
        },
        // Per-band labels for the whois_history column. Distinct vocab
        // from labelWhois (which collapses to 3 buckets for rollup
        // chips) — Compare needs the 4-way distinction so "insufficient"
        // doesn't get hidden under "stable".
        whoisBand: {
          dropped: "dropped",
          mixed: "drift suspected",
          insufficient: "insufficient history",
          stable: "stable",
        },
        // Suffix shown next to the band chip when ownership_cycles > 1.
        // Hidden when N == 1 (no drop ever happened) to keep stable
        // rows uncluttered.
        whoisCycles: (n: number) => `× ${n} cycles`,
        legendDiff: "Different",
        legendSame: "Same",
        legendOnlyA: "Only in A",
        legendOnlyB: "Only in B",
        viewDomainA: "Open A",
        viewDomainB: "Open B",
        noSharedCriteria:
          "No criteria were run by both runs — only the Final column applies.",
      },
      domain: {
        backToRun: (id: number, name: string = "") =>
          `← ${name?.trim() || `Run #${id}`}`,
        title: (domain: string) => domain,
        intro: "Raw Ahrefs data fetched for this domain in this run.",
        augmentsBannerHeading: (runId: number) =>
          `↳ This run augments Run #${runId}`,
        augmentsBannerBody:
          "The current run enabled fewer criteria than the prior comprehensive run. Cells below are stitched: criteria absent from this run come from Run #N (linked above); criteria present in this run reflect this run's fresh data. Each verdict shows a small \"from Run #N\" badge when sourced from a prior run.",
        stitchedBannerHeading: "↳ Stitched view across runs",
        stitchedBannerBody:
          "At least one criterion below was sourced from a prior run for this domain. Each verdict shows a small \"from Run #N\" badge when stitched from elsewhere.",
        stitchedFromLabel: (runId: number) => `from Run #${runId}`,
        stitchedFromHint:
          "This criterion's data + AI verdict were sourced from a prior run that had this criterion. The current run did not re-fetch it. Click through to that run to reanalyze or refetch this specific criterion.",
        reanalyze: "Reanalyze with AI",
        reanalyzeHint:
          "Re-judge this domain's criteria with a fresh AI call. Bypasses cache. No Ahrefs refetch.",
        reanalyzing: "Reanalyzing…",
        reanalyzeStarted: "Reanalysis started — verdicts will refresh.",
        reanalyzeFailed: "Reanalyze failed",
        pin: "Pin as definitive",
        pinHint:
          "Make this run the definitive source for this domain on the Database page. Replaces any prior pin for this domain.",
        pinned: "Pinned ★",
        pinnedHint:
          "This run is the definitive source for this domain on the Database page. Click to unpin.",
        pinning: "Pinning…",
        unpinning: "Unpinning…",
        replacePin: "Replace pin",
        replacePinHint:
          "A different run is currently pinned for this domain. Click to switch the pin to this run.",
        pinFailed: "Pin failed",
        share: {
          button: "Share",
          buttonHint:
            "Create an unguessable view-only link to this domain page. Anyone with the link can view it without basic-auth — revoke from the Shares page.",
          modalTitle: "Create view-only link",
          expiryLabel: "Expires",
          expiryPresets: {
            never: "Never",
            d7: "In 7 days",
            d30: "In 30 days",
            d90: "In 90 days",
          },
          noteLabel: "Note (optional)",
          notePlaceholder: "e.g. demo for ClientCorp",
          warning:
            "Anyone with the link can view this analysis without entering your basic-auth password. Cost, AI provider, and internal IDs are stripped — but raw Ahrefs rows + AI verdicts are visible.",
          createButton: "Create link",
          creating: "Creating…",
          successHint: "Link created. Copy and share:",
          copyButton: "Copy link",
          copied: "Copied!",
          manageAll: "Manage all shares",
          expiresHint: "Expires:",
          done: "Done",
          failPrefix: "Couldn't create the share",
        },
        verdictsHeading: "AI verdicts per criterion",
        rawDataHeading: "Raw data",
        tabs: {
          backlinks: "Backlinks",
          refdomains: "Referring domains",
          anchors: "Anchors",
          keywords: "Organic keywords",
          wayback: "Wayback history",
          wayback_classify: "Language + theme",
        },
        criterionMissing: "This criterion was not enabled for this run.",
        criterionFailed: "Failed to fetch this criterion.",
        criterionEmpty: "No rows returned.",
        rowCount: (n: number) => `${n} row${n === 1 ? "" : "s"}`,
        showRaw: "Show raw row",
        hideRaw: "Hide raw row",
        viewRequest: "View request URL",
        verdict: {
          heading: "AI verdict",
          assessment: "Assessment",
          confidence: "Confidence",
          keyFindings: "Key findings",
          redFlags: "Red flags",
          empty: "No verdict produced.",
          failed: "AI verdict failed",
          inflight: "AI verdict in progress…",
          cachedFromRun: (runId: number) => `from cache · Run #${runId}`,
          reanalyzeButton: "Re-judge this",
          reanalyzeHint:
            "Re-judge only this criterion with the current AI provider/model. Other criteria's verdicts are kept; the final assessment is recomputed.",
          reanalyzing: "Re-judging…",
        },
        dataCachedFromRun: (runId: number) =>
          `data from cache · Run #${runId}`,
        units: {
          cached: "0 units (cached)",
          actual: (n: number) => `${n} unit${n === 1 ? "" : "s"}`,
          ahrefsCachedHint: (listPrice: number) =>
            `Ahrefs server-side cache hit · list price ${listPrice}`,
          perRow: (n: number) => `${n}/row`,
          tooltip:
            "Ahrefs unit cost for this request. 'Actual' is what Ahrefs billed; the gap from list price means Ahrefs's own cache returned a recent identical response.",
        },
        aiPreview: {
          show: "Preview AI input ▾",
          hide: "Hide AI input ▴",
          toggleHint:
            "Show exactly what the AI would receive if you reanalyzed this criterion — system prompt + the trimmed row payload.",
          provider: "Provider",
          rows: (n: number) =>
            `${n} row${n === 1 ? "" : "s"} sent`,
          fieldsSent: "Fields sent",
          fieldsHelp:
            "Only these fields make it into the user message. Others are dropped before the call to save tokens.",
          showPrompt: "Show system prompt ▾",
          hidePrompt: "Hide system prompt ▴",
          showMessage: "Show user message ▾",
          hideMessage: "Hide user message ▴",
          viewTable: "Table",
          viewJson: "JSON",
        },
        finalBanner: {
          heading: "Ahrefs final assessment",
          summary: "Summary",
          recommendation: "Recommendation",
          partialHeading: "Partial result",
          partialCount: (succeeded: number, total: number) =>
            `${succeeded} of ${total} criteria judged`,
          partialSucceeded: "Succeeded",
          partialFailed: "Failed",
          partialHint:
            "Score and summary are intentionally suppressed because some criteria failed. Click Reanalyze with AI to retry.",
          // Pending state — surfaced when this rd has no final yet AND
          // its status is still pending/running. Replaces the previous
          // silent-render that let stale finals from prior runs slip
          // through during live polling.
          pending: "Ahrefs final assessment pending — waiting for all criteria to finish…",
          // Provenance badge — shown when the final on screen was sourced
          // from a prior rd because this rd's own final is missing/partial
          // /unscorable. The id links to the source rd's domain page.
          fromPriorRun: (runId: number) => `Showing final from Run #${runId}`,
          fromPriorRunHint:
            "this run was partial. Reanalyze with AI to produce a fresh final.",
        },
        waybackTab: {
          cdxToggle: (n: number) =>
            `CDX rows table (${n} row${n === 1 ? "" : "s"})`,
        },
        waybackTimeline: {
          heading: "Snapshot timeline (V2)",
          intro:
            "Title + headings + body excerpt extracted from each archived page. The AI judge sees this alongside the CDX rows to spot year-over-year theme drift.",
          coverage: (ok: number, total: number) =>
            `${ok}/${total} samples returned usable HTML`,
          openSnapshot: "Open snapshot ↗",
          noTitle: "(no title in archived HTML)",
          moreItems: (n: number) => `+${n} more`,
          errorPrefix: "Sample error",
          redirectTo: "Redirect →",
          sortLabel: "Sort by date",
          sortNewest: "Newest first",
          sortOldest: "Oldest first",
          sortNewestHint: "Most recent snapshots at the top.",
          sortOldestHint: "Earliest snapshots at the top.",
        },
        notes: {
          heading: "Notes",
          placeholder:
            "Your judgment about this domain — survives reruns and re-judgments.",
          help:
            "Notes are domain-keyed (cross-run). Save with empty text to clear. Visible on the Database page in the Note column.",
          save: "Save",
          saving: "Saving…",
          edit: "Edit",
          cancel: "Cancel",
          updatedAt: (when: string) => `Saved ${when}`,
        },
      },
    },
    database: {
      title: "Database",
      intro:
        "Every domain you've analyzed. Each row's data comes from a manually-pinned run — pick a definitive run per domain (or pin an entire run from its detail page). Unpinned domains appear with empty cells until you choose a run.",
      empty: "No domains yet — kick off your first analysis on the Analyze page.",
      noMatch: "No domains match your filters.",
      searchPlaceholder: "Search domain, pinned run, or note…",
      cols: {
        // 2026-05-17: row-number column for "I'm on row N" orientation.
        rowNumber: "#",
        domain: "Domain",
        // 2026-05-23: Source column replaced by Max price (the
        // procurement signal is more useful at a glance than the
        // registrar string). `source` key kept for CSV export labels
        // that still surface it.
        source: "Source",
        maxPrice: "Max $",
        maxPriceSortHint:
          "Click to sort by Max price. Asc (cheapest first) → desc → default. Rows without a backlog max_price always sink to the bottom.",
        verdict: "Ahrefs",
        verdictSortHint:
          "Click to sort by score. Cycles desc → asc → default. Partial / no-verdict rows always sink to the bottom.",
        whois: "Whois",
        whoisSortHint:
          "Click to sort by Whois drop-confidence. Cycles asc (stable first) → desc → default. Rows without a Whois verdict always sink to the bottom.",
        wayback: "Wayback",
        language: "Lang",
        theme: "Theme",
        category: "Category",
        provider: "AI",
        note: "Note",
        criteria: "Criteria",
        availability: "Availability",
        runs: "Runs",
        pin: "Pinned run",
        backlog: "Backlog",
      },
      // 2026-05-24: per-row 1-click share icon. Resolves the domain's
      // canonical RunDomain (pinned → latest), reuses the most recent
      // active share for it, or mints a new one with the configured
      // default expiry. Result URL is copied to clipboard with a toast.
      quickShare: {
        iconTitle:
          "Copy a view-only share link for this domain (1-click). Manages duration in Shares → Default settings.",
        copying: "Generating link…",
        copiedNew: "Share link created and copied.",
        copiedReused: "Existing share link copied.",
        copyFailed: "Could not copy — paste manually:",
        noRd: "No analyzed run for this domain yet — share is unavailable.",
        failed: "Quick-share failed",
      },
      backlogActions: {
        order: "Order",
        orderHint:
          "Queue this domain for purchase (status = order). Updates the matching backlog row, or creates one if the domain isn't in Backlog yet. Mark it as Ordered manually from the Backlog page once the order is actually placed.",
        discard: "Discard",
        discardHint:
          "Mark this domain as discarded. Updates the matching backlog row, or creates one if the domain isn't in Backlog yet.",
        question: "Question",
        questionHint:
          "Flag this domain with a question (needs clarification before deciding). Updates the matching backlog row, or creates one if the domain isn't in Backlog yet.",
        currentStatus: (label: string) => `Current: ${label}`,
        notInBacklog: "not in Backlog",
        saving: "Saving…",
        saveFailed: "Action failed",
        // Bulk variants — used in the Database-page selection toolbar.
        bulkOrder: (n: number) => `Order ${n}`,
        bulkDiscard: (n: number) => `Discard ${n}`,
        bulkResult: (updated: number, created: number, status: string) => {
          const parts: string[] = [];
          if (updated > 0) parts.push(`${updated} updated`);
          if (created > 0) parts.push(`${created} created`);
          if (parts.length === 0) parts.push("nothing changed");
          return `${parts.join(" · ")} (status = ${status}).`;
        },
      },
      // Apruv export (added 2026-05-20). Bulk action that builds a CSV
      // for an approver, including auto-generated share URLs per row.
      apruv: {
        button: (n: number) => `Apruv (${n})`,
        buttonHint:
          "Export selected rows as a CSV for an approver, with auto-generated share URLs the approver can open without logging in.",
        modalTitle: "Apruv export",
        modalHelp: (n: number) =>
          `${n} selected row${n === 1 ? "" : "s"} will be exported. Pick the columns to include. A share URL is auto-generated for each row so the approver can open the analysis page without logging in.`,
        expiryLabel: "Share-link expiry",
        expiry7: "7 days",
        expiry30: "30 days",
        expiry90: "90 days",
        expiryNever: "Never expires",
        columnsLabel: "Columns to include",
        mandatoryHint:
          "Domain and Share URL are always included.",
        cols: {
          domain: "Domain",
          share_url: "Share URL",
          backlog_status: "Status",
          backlog_registrar: "Source",
          backlog_expiration_date: "Expiration date",
          backlog_desired_price: "Desired price",
          backlog_max_price: "Max price",
          backlog_ahrefs_dr: "Ahrefs DR",
          refdomains_dofollow: "Referring domains (follow)",
          backlinks_dofollow: "Backlinks (follow)",
          backlog_domain_age_years: "Age (years)",
          final_score: "Ahrefs score",
          final_confidence: "Confidence",
          wayback_verdict: "Wayback verdict",
          wayback_confidence: "Wayback confidence",
          whois_band: "Whois band",
          primary_language: "Language",
          primary_theme: "Theme",
          category: "Category",
          note: "Notes",
          ai_provider: "AI provider",
          ai_model: "AI model",
        },
        cancel: "Cancel",
        close: "Close",
        exportCsv: "Export CSV",
        exporting: "Exporting…",
        resultSummary: (inserted: number, skipped: number) =>
          skipped === 0
            ? `Downloaded ${inserted} row${inserted === 1 ? "" : "s"}.`
            : `Downloaded ${inserted} row${inserted === 1 ? "" : "s"} · skipped ${skipped} (no share URL).`,
      },
      // Ban-list bulk action + per-row badge (added 2026-05-13 wave L).
      bulkBan: (n: number) => `Add ${n} to Ban List`,
      bulkBanBusy: "Adding…",
      bulkBanHint:
        "Permanently exclude these domains from future analysis and Backlog imports. Existing Backlog rows (if any) are not affected.",
      bulkBanConfirm: (n: number) =>
        `Add ${n} domain${n === 1 ? "" : "s"} to the Ban List? They'll be silently rejected from future Analyze submissions, Backlog imports, and the availability-cascade auto-upsert. Banned rows are hidden from this list — review prior analyses via the Ban List page. Unbanning restores them.`,
      bulkBanResult: (added: number, already: number, invalid: number) =>
        `Banned ${added} · already banned ${already} · invalid ${invalid}.`,
      bulkBanFailed: "Bulk-ban failed",
      bannedBadge: "banned",
      bannedBadgeHint:
        "On the Ban List. Future Analyze submissions and Backlog imports for this domain are silently rejected.",
      pin: {
        notPinnedBadge: "not pinned",
        notPinnedHint:
          "No run pinned for this domain yet. Choose one from the dropdown to populate this row.",
        pickPlaceholder: "Pick a run to pin…",
        pinnedHeading: "Pinned",
        pinnedHint:
          "This row's data comes from this run. Pick another to swap, or unpin to clear.",
        unpin: "Unpin",
        unpinning: "Unpinning…",
        runOption: (runId: number, runName: string, status: string) =>
          `${runName ? runName : `Run #${runId}`} · ${status}`,
        pinFailed: "Pin failed",
        unpinFailed: "Unpin failed",
      },
      filters: {
        heading: "Filters",
        verdictAny: "Any verdict",
        verdictAhrefsAny: "Any Ahrefs verdict",
        verdictAhrefsLabel: "Ahrefs verdict",
        verdictAhrefsHint:
          "Filter by the aggregated 4-criterion (backlinks/refdomains/anchors/keywords) verdict.",
        verdictWaybackAny: "Any Wayback verdict",
        verdictWaybackLabel: "Wayback verdict",
        verdictWaybackNone: "(no Wayback verdict)",
        verdictWaybackHint:
          "Filter by the Wayback judge's per-criterion assessment (separate from the aggregated final score).",
        verdictWhoisAny: "Any Whois verdict",
        verdictWhoisLabel: "Whois verdict",
        verdictWhoisNone: "(no Whois verdict)",
        verdictWhoisHint:
          "Filter by the WHOIS-history judge's drop-confidence band. Stable = clean ownership; dropped = repeated drops (caution).",
        verdictWhoisStable: "stable (<30%)",
        verdictWhoisInsufficient: "insufficient (30–50%)",
        verdictWhoisMixed: "mixed (>50%)",
        verdictWhoisDropped: "dropped (>80%)",
        availabilityLabel: "Availability",
        availabilityAny: "Any availability",
        availabilityHint:
          "Filter by the latest availability-check result (RDAP / Domainr / WHOIS:43 cascade). Separate from the criterion filter — availability isn't a CR-row criterion.",
        availabilityAvailable: "available",
        availabilityRegistered: "registered",
        availabilityNotSupported: "not supported",
        availabilityUnknown: "unknown",
        availabilityError: "error",
        availabilityNeverChecked: "(never checked)",
        languageAny: "Any language",
        languageLabel: "Language",
        languageNone: "(no language)",
        languageHint:
          "Filter by the wayback_classify-detected primary language (ISO 639-1 code).",
        languageSearchPlaceholder: "Search languages…",
        categoryAny: "Any category",
        categoryLabel: "Category",
        categoryNone: "(no category)",
        categoryHint:
          "Filter by the auto-classified site category (matched to your predefined list in Settings).",
        categorySearchPlaceholder: "Search categories…",
        verdictPartial: "partial",
        verdictNone: "(no AI verdict)",
        providerAny: "Any provider",
        providerNone: "(no AI)",
        modelAny: "Any model",
        criterionAny: "Any criterion",
        criterionLabel: "Criterion",
        cacheAny: "Cache: any",
        cacheCached: "Cache: cached",
        cacheFresh: "Cache: fresh",
        notesAny: "Notes: any",
        notesWith: "Notes: with",
        notesWithout: "Notes: without",
        pinAny: "Pin: any",
        pinPinned: "Pin: pinned only",
        pinUnpinned: "Pin: unpinned only",
        // Source filter (2026-05-17) — multi-select on
        // BacklogDomain.registrar, mirrors the Backlog page.
        sourceLabel: "Source",
        sourceAny: "Any source",
        sourceSearchPlaceholder: "Search sources…",
        // Backlog-status filter (2026-05-20) — sits right after Source
        // on the Database page filter row. Chip labels for individual
        // statuses come from t.pages.backlog.statusLabels (shared
        // vocabulary across pages).
        statusLabel: "Status",
        statusAny: "Any status",
        minRecords: "Min records",
        minRecordsHelp:
          "Minimum row count in the chosen criterion (latest run).",
        waybackConfMin: "Wayback ≥",
        waybackConfMinHelp:
          "Slider: minimum Wayback-judge confidence. Drag to set the threshold; all the way left = off. Rows without a Wayback verdict are hidden once the threshold is above zero.",
        ahrefsConfMin: "Ahrefs ≥",
        ahrefsConfMinHelp:
          "Slider: minimum Ahrefs Final Assessment confidence. Drag to set the threshold; all the way left = off. Rows without a final (or with a partial) are hidden once the threshold is above zero.",
        confSliderOff: "off",
        drMin: "DR ≥",
        drMinHelp:
          "Minimum Domain Rating. Uses the pinned Ahrefs Batch Analysis DR (falls back to the imported backlog DR). Blank/0 = off; rows without a DR are hidden when set.",
        refDomainsMin: "RD (f) ≥",
        refDomainsMinHelp:
          "Minimum referring domains (dofollow) from the pinned Ahrefs Batch Analysis run. Blank/0 = off; rows without the metric are hidden when set.",
        numMinPlaceholder: "any",
        // Whois ownership-cycles filter. 2026-05-23: semantic flipped
        // from ">= N" (find dropped) to "< N" (find clean history) —
        // drop hunter's primary question is "which look freshest".
        // Key name kept as `whoisCyclesMax` since the value is now
        // an upper bound.
        whoisCyclesMax: "Whois cycles",
        whoisCyclesMaxHelp:
          "Filter by number of whois ownership cycles. <2 = the domain has never dropped (cycle = 1, immutable creation_date observed); <3 = at most one drop; <5 = at most three. Lower is cleaner history. Rows without whois analysis are hidden once any filter is active.",
        whoisCyclesAny: "Any",
        whoisCyclesLt2: "< 2 (never dropped)",
        whoisCyclesLt3: "< 3 (at most 1 drop)",
        whoisCyclesLt4: "< 4 (at most 2 drops)",
        whoisCyclesLt5: "< 5 (at most 3 drops)",
        // Max price range filter (paired inputs, replaced step-50
        // slider 2026-05-23 same day). Two independent USD bounds;
        // either or both can be empty.
        maxPriceRange: "Max $",
        maxPriceMaxHelp:
          "Keep only rows whose backlog Max price falls within this USD range. Leave either field blank for an open-ended bound. Rows without a backlog row or without a max_price set are hidden once either bound is filled (no price to compare against).",
        maxPriceMinPlaceholder: "from",
        maxPriceMaxPlaceholder: "to",
        maxPriceMinAria: "Max price lower bound (USD)",
        maxPriceMaxAria: "Max price upper bound (USD)",
        maxPriceClearAria: "Clear Max price filter",
        clear: "Clear filters",
        matchedCount: (filtered: number, total: number) =>
          `Filtered: ${filtered} of ${total} domain${total === 1 ? "" : "s"}`,
        matchedCountEmpty: "no rows match the current filters",
        showTaken: (n: number) => `Show taken (${n})`,
        showTakenHelp:
          "By default, domains whose only data is an Availability-job result that came back NOT available (registered / unknown / error / not supported) are hidden from this page so a bulk availability run doesn't bury it. Turn this on to show them too. Domains with any other analysis, inline rechecks, or a note are never hidden.",
      },
      verdictSpread: (counts: Record<string, number>) => {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(counts)) {
          parts.push(`${v}× ${k}`);
        }
        return parts.join(", ");
      },
      runsBadge: (n: number) => `${n} run${n === 1 ? "" : "s"}`,
      noVerdict: "—",
      partialBadge: "partial",
      partialTooltip:
        "Partial result — at least one criterion failed. Score not computed. Open the domain page and Reanalyze to retry.",
      // 2026-05-12: surfaced when partial-final comes from criteria
      // stitched across multiple pinned Runs.
      partialFromCriteria: (crits: string) =>
        `Partial — based on ${crits}. Pin remaining criteria from their Runs to get a full verdict.`,
      // 2026-05-14: partial → split into failed vs underweight.
      failedBadge: "failed",
      failedTooltip:
        "Failed — an enabled criterion errored at AI synth time. Open the domain page and Reanalyze to retry.",
      underweightBadge: "subset",
      underweightTooltip:
        "Subset — the score is derived from fewer signals than the scoring weights envision. Pin the missing criteria from their Runs.",
      underweightMissing: (crits: string) =>
        `Subset — missing ${crits}. Pin those criteria from their Runs to get a full-weight score.`,
      noProvider: "no AI",
      criteriaCell: (parts: string[]) =>
        parts.length === 0 ? "—" : parts.join(", "),
      criterionRowCount: (key: string, rows: number) => `${key} (${rows})`,
      cachedTag: "cached",
      latestRunLink: (jobName: string) => `Run in: ${jobName}`,
      selectAllOnPage: "Select all on this page",
      selectedCount: (n: number) =>
        `${n} domain${n === 1 ? "" : "s"} selected`,
      clearSelection: "Clear",
      deleteSelected: (n: number) =>
        `Delete ${n} domain${n === 1 ? "" : "s"}`,
      deleting: "Deleting…",
      deleteConfirmOne: (domain: string) =>
        `Permanently delete ${domain} and every run-domain row for it across all jobs? This cannot be undone.`,
      deleteConfirmMany: (n: number) =>
        `Permanently delete ${n} domains and every run-domain row for them across all jobs? This cannot be undone.`,
      deleteSummary: (rds: number, runs: number, jobs: number) => {
        const parts: string[] = [
          `Removed ${rds} domain row${rds === 1 ? "" : "s"}`,
        ];
        if (runs > 0) parts.push(`${runs} empty run${runs === 1 ? "" : "s"}`);
        if (jobs > 0) parts.push(`${jobs} empty job${jobs === 1 ? "" : "s"}`);
        return parts.join(" · ") + ".";
      },
      refresh: "Refresh",
      refreshing: "Refreshing…",
      refreshedAt: (time: string) => `Updated ${time}`,
      exportVisible: (n: number) => `Export visible (${n})`,
      exportAll: (n: number) => `Export all (${n})`,
      exportVisibleHelp:
        "Download a CSV of the rows currently matching your filters and search.",
      exportAllHelp: "Download every domain in the database.",
      analyzeSelected: (n: number) =>
        `Analyze ${n}${n === 1 ? " domain" : " domains"} →`,
      analyzeSelectedHint:
        "Open the Analyze page with these domains pre-filled and cross-job cache enabled — Drop Sherlock will reuse Ahrefs data and AI verdicts from any prior run whose criteria match. Pick which criteria to (re)run on the Analyze page.",
      bulkReanalyzeShow: (n: number) => `Reanalyze ${n}…`,
      bulkReanalyzeHide: "Hide reanalyze",
      bulkReanalyzePickerLabel: "AI:",
      bulkReanalyzeSubmit: (n: number) =>
        `Reanalyze ${n} domain${n === 1 ? "" : "s"}`,
      bulkReanalyzeRunning: "Dispatching…",
      bulkReanalyzeResult: (started: number, skipped: number) =>
        skipped === 0
          ? `Started ${started}.`
          : `Started ${started}, skipped ${skipped} (already running or no AI configured).`,
    },
    settings: {
      title: "Settings",
      intro:
        "Configure Ahrefs and AI provider credentials, test connections, and tune rate limits.",
      sections: {
        providers: "Providers",
        rateLimits: "Rate limits",
        scoring: "Final score weights & thresholds",
        pricing: "AI model pricing",
        waybackClassify: "Wayback classification (language + theme + category)",
        prompts: "AI prompts",
        classifyContext: "Wayback classify → Ahrefs judges (site context)",
      },
      tabs: {
        api: "API",
        brain: "Brain",
        wayback: "Wayback classification",
        availability: "Domain availability",
        whoisHistory: "Whois History",
        domainFilter: "Domain Filter",
        others: "Others",
      },
      domainFilter: {
        heading: "Domain Filter",
        intro:
          "Block domains from entering the backlog at import time. Today this filters country-level domains; more categories will land here over time.",
        bulkOpen: "Bulk paste",
        bulkClose: "Hide bulk paste",
        bulkHint:
          "One entry per line, or comma-separated. Whitespace and leading dots are ignored.",
        bulkAdd: "Add to filter",
        bulkAdding: "Adding…",
        add: "Add",
        adding: "Adding…",
        empty: "No entries yet — domains are not filtered until you add some.",
        clearAll: "Clear all",
        confirmClear:
          "Remove every entry from this category? This cannot be undone.",
        noCategories: "No filter categories configured.",
        removeAria: (v: string) => `Remove ${v}`,
        fallbackBody:
          "Domains matching any of these entries are skipped at backlog import.",
        categories: {
          cctld: {
            title: "Country-level TLDs (ccTLD)",
            body: "Excludes only domains whose TLD label matches AND that have exactly two labels — so `example.uk` is filtered, but `example.co.uk` and `bbc.co.uk` get through (open SLDs under ccTLDs stay registrable).",
            placeholder: "uk, de, fr",
            hint: "Just the TLD label (no leading dot). Lowercase. Press Enter to add.",
          },
        },
      },
      whoisHistory: {
        heading: "Whois History (drop detection)",
        intro:
          "Historical-WHOIS lookups via the configured provider. The AI judge reads the structured diff (creation_date changes, EPP drop-pipeline status codes, coverage gaps, owner/email/org changes) and emits a 'dropped vs transferred' confidence. Run this BEFORE the Quality pillar — domains with high drop confidence can skip Wayback + Ahrefs spend.",
        providerLabel: "Provider",
        providerHint: "Only WhoisFreaks is wired today; more in a future wave.",
        apiKeyLabel: "API key",
        apiKeyHint:
          "Encrypted at rest. Stored value is never returned — leave the field empty to keep the existing key, type a new value to replace, type nothing and click Clear to remove.",
        apiKeyStored: "(stored — leave blank to keep)",
        apiKeyMissing: "(not set yet)",
        saveApiKey: "Save key",
        clearApiKey: "Clear key",
        maxRecordsLabel: "Max history records",
        maxRecordsHint:
          "Cap on how many historical snapshots to keep per domain. The most-recent N are kept (drop-signal density is highest near the present). Range: 1–500.",
        coverageGapLabel: "Coverage-gap threshold (days)",
        coverageGapHint:
          "Days of \"no snapshots\" between consecutive records that the diff computer flags as a hard drop signal. Below this, normal polling-cadence variance dominates. Range: 1–365.",
        dropThresholdLabel: "Drop confidence threshold",
        dropThresholdHint:
          "AI verdicts whose dropped_confidence ≥ this value get the green \"high confidence: dropped\" chip in the UI and are eligible for the bulk \"send passers to Quality\" filter. Range: 0–1.",
        unitsPerRequestLabel: "Units per request (plan tier)",
        unitsPerRequestHint:
          "How many WhoisFreaks units one historical-WHOIS request consumes against your plan's monthly quota. Free tier = 1; paid tiers can be 2 or more — check the cost displayed on your WhoisFreaks dashboard. Range: 1–100.",
        testLabel: "Test connection",
        testHint:
          "Live probe — fetches one domain's history through the configured provider and shows the result inline. Costs 1 provider request (a few cents).",
        testButton: "Test",
        testing: "Testing…",
        testTooltip: "Probe the provider with this domain",
        testNeedsKey: "Save an API key first.",
        testOk: (count: number, domain: string) =>
          `OK — found ${count} historical record${count === 1 ? "" : "s"} for ${domain}.`,
        testOkHint: (provider: string) =>
          `via ${provider}. Latest snapshot preview below.`,
        testNoRecords: (domain: string) =>
          `Auth fine, but no history available for ${domain}.`,
        testNoRecordsHint:
          "The provider responded successfully with zero records. Try a longer-lived domain (e.g. google.com) to verify the integration works end-to-end.",
        testFailed: "Test failed",
        testFailedHint:
          "Most common causes: invalid API key, exhausted plan quota, network issue. Check the error verbatim above.",
        rateLimitsHeading: "Rate limits",
        rateLimitsHint:
          "Caps applied to every WhoisFreaks call (Test button, runner, dashboard probes). Set these BELOW your plan's ceiling — bursts above the cap surface as HTTP 429. Defaults work for the free tier; raise once you've confirmed your plan's actual limit.",
        rpmLabel: "Requests per minute",
        maxConcurrentLabel: "Max concurrent",
      },
      othersEmpty: "No settings here yet.",
      importLimit: {
        heading: "Backlog CSV import row cap",
        intro:
          "Maximum rows accepted per CSV import. The wizard truncates files larger than this before sending; a 413 is returned if you bypass the wizard. Raise it for big auction lists; lower it if you keep accidentally pasting huge spreadsheets.",
        currentLabel: "Max rows:",
        unit: "rows",
        save: "Save",
        saving: "Saving…",
        savedAt: (when: string) => `Saved ${when}`,
        loadFailed: "Couldn't load the import limit.",
        saveFailed: "Save failed.",
        notANumber: "Enter a whole number.",
        outOfRange: (min: number, max: number) =>
          `Must be between ${min} and ${max}.`,
        boundsHint: (min: number, max: number) =>
          `allowed: ${min}–${max}`,
      },
      retention: {
        heading: "Error log retention",
        intro:
          "Auto-delete dismissed errors older than the chosen window. Open errors are never auto-pruned — only ones you've explicitly dismissed age out. Pruning clears the original error trace from the source row too (analysis data stays).",
        currentLabel: "Auto-delete dismissed errors after:",
        optionDays: (n: number) => `${n} days`,
        optionNever: "Never",
        save: "Save",
        saving: "Saving…",
        savedAt: (when: string) => `Saved ${when}`,
        loadFailed: "Couldn't load retention setting.",
        saveFailed: "Save failed.",
      },
      backups: {
        heading: "Database backups",
        intro:
          "On-disk SQLite snapshots written via the online-backup API (no write-blocking). Older snapshots beyond the retention count are pruned automatically. Local schedule + retention are env-driven — set DROP_SHERLOCK_BACKUP_INTERVAL_HOURS / DROP_SHERLOCK_BACKUP_KEEP / DROP_SHERLOCK_BACKUP_ENABLED in your .env. Off-box upload (S3/B2/R2) is configured below and runs after each local snapshot.",
        statusLabel: "Status",
        statusEnabled: "Scheduled",
        statusDisabled: "Disabled",
        intervalLabel: "Interval",
        intervalHoursValue: (n: number) =>
          n === 1 ? "every 1 hour" : `every ${n} hours`,
        keepLabel: "Keep",
        keepValue: (n: number) =>
          n === 1 ? "1 snapshot" : `${n} snapshots`,
        dirLabel: "Directory",
        unsupported:
          "The configured database is not SQLite — built-in backup is disabled. Use pg_dump (or your provider's snapshot feature) on a separate cron.",
        runNow: "Backup now",
        runningLabel: "Backing up…",
        refresh: "Refresh",
        snapshotsHeading: "Snapshots",
        empty: "No snapshots yet — click 'Backup now' or wait for the scheduled run.",
        cols: { filename: "Filename", size: "Size", created: "Created" },
        loadFailed: "Couldn't load backup status.",
        restore: {
          button: "Restore",
          buttonHint:
            "Replace the live database with this snapshot. Takes a safety snapshot of the current state first.",
          modalTitle: "Restore database from snapshot",
          fileLabel: "File",
          sizeLabel: "Size",
          createdLabel: "Created",
          warning:
            "This replaces the entire current database with the snapshot's contents. The action is recoverable — a safety snapshot of the current state is taken automatically right before the restore. Restore is refused while any run is in flight (pause or cancel running runs first).",
          ackLabel:
            "I understand the current database will be replaced.",
          confirmButton: "Restore now",
          restoring: "Restoring…",
          successBanner: (from: string, prerestore: string) =>
            `Restored from ${from}. A pre-restore safety snapshot was saved as ${prerestore} — restore that one to undo.`,
          failPrefix: "Restore failed",
          prerestoreBadge: "pre-restore",
          prerestoreHint:
            "Safety snapshot taken automatically right before a restore. Capped at 7 most-recent by default (configurable via DROP_SHERLOCK_PRERESTORE_KEEP).",
        },
        // Per-row download + delete (added 2026-05-27).
        download: {
          button: "Download",
          buttonHint:
            "Save this snapshot to your computer for offsite backup. Streams the file directly — no in-memory buffering.",
        },
        deleteRow: {
          button: "Delete",
          buttonHint:
            "Permanently remove this snapshot from the server. Cannot be undone.",
          confirm: (filename: string) =>
            `Delete ${filename}? This frees disk space immediately and cannot be undone. Other snapshots are unaffected.`,
          done: (filename: string) => `Deleted ${filename}.`,
          failed: "Delete failed",
        },
        upload: {
          heading: "Import backup from file",
          intro:
            "Upload a .db.gz snapshot from your computer and restore the live database from it. The uploaded file is saved into the snapshots directory (so it shows up in the list below and can be re-restored later) and counts toward the rotation retention. A pre-restore safety snapshot of the current database is still taken automatically — the action is recoverable.",
          uploadAndRestore: "Upload & restore",
          uploading: "Uploading…",
          modalTitle: "Restore database from uploaded file",
          warning:
            "This replaces the entire current database with the uploaded snapshot's contents. The action is recoverable — a safety snapshot of the current state is taken automatically right before the restore. Restore is refused while any run is in flight (pause or cancel running runs first).",
          successBanner: (imported: string, prerestore: string) =>
            `Restored from uploaded file (saved as ${imported}). A pre-restore safety snapshot was saved as ${prerestore} — restore that one to undo.`,
          failPrefix: "Upload-restore failed",
        },
        remote: {
          heading: "Remote upload (S3-compatible)",
          intro:
            "After each local snapshot, optionally push the .db.gz to an S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO). Local rotation isn't affected — if the upload fails the local snapshot is still kept. Save your config, then 'Test connection' to verify before the first scheduled run uses it.",
          enabledLabel: "Enabled",
          providerLabel: "Provider label",
          providerHint: "Free-form note shown in the UI — e.g. 'Backblaze B2 / weekly'.",
          endpointLabel: "Endpoint URL",
          endpointHint:
            "Leave blank for AWS S3. For B2: https://s3.<region>.backblazeb2.com. For R2: https://<account-id>.r2.cloudflarestorage.com.",
          regionLabel: "Region",
          regionHint:
            "Required for AWS S3. For B2/R2/MinIO use whatever your provider expects (often 'auto' for R2).",
          bucketLabel: "Bucket",
          bucketHint: "Bucket must already exist; we don't auto-create it.",
          accessKeyLabel: "Access key ID",
          secretKeyLabel: "Secret access key",
          secretsHint:
            "Stored in the local DB. Re-typing is only needed when changing the value — leave blank to keep the existing one.",
          prefixLabel: "Prefix (optional)",
          prefixHint:
            "Path inside the bucket. e.g. 'drop-sherlock/' to namespace alongside other apps.",
          testBtn: "Test connection",
          testOk: (bucket: string) =>
            `Connected to bucket "${bucket}".`,
          testFail: "Connection failed",
          notSet: "Not set",
          unchangedHint: "leave blank to keep",
          charsSuffix: "chars",
        },
      },
      waybackClassify: {
        intro:
          "Settings for the wayback_classify criterion (Analyze page → Language + theme + category). Categories are used by the chained AI classification pass that runs after theme detection.",
        languageModeHeading: "Language detection mode",
        languageModeIntro:
          "How to derive the primary language from Wayback page samples. Both modes output ISO 639-1 codes so the Database language filter works regardless of which one produced the row.",
        languageModeOptions: {
          ai: {
            label: "AI (combined prompt)",
            help: "One AI call returns both language and theme. Faster but can be flaky on short non-Latin text.",
          },
          library: {
            label: "Library (lingua-language-detector)",
            help: "Lingua aggregates a primary language deterministically from sample text. AI runs theme-only afterward. More reliable on short text.",
          },
        },
        categoriesHeading: "Predefined categories",
        categoriesIntro:
          "The AI categorization step picks one category by name from this list. When no entry fits well, it outputs 'other'. Descriptions are optional but help the model match semantically (not just by keyword overlap). Categories are stored alphabetically.",
        empty: "No categories defined yet. Add one below or paste a bulk list.",
        addNameLabel: "Name",
        addNamePlaceholder: "e.g. E-commerce",
        addDescLabel: "Description (optional)",
        addDescPlaceholder: "e.g. Online retail / shopping carts / product catalogs",
        add: "Add",
        addBusy: "Adding…",
        bulkOpen: "Bulk paste…",
        bulkClose: "Close bulk paste",
        bulkHint:
          "One category per line. Optional description after `|` or `,` (e.g. `Casino | gambling sites`). Existing categories with the same name are kept (descriptions only fill blank ones).",
        bulkPlaceholder:
          "Casino | gambling sites and bookmakers\nE-commerce | online retail\nBlog | personal or editorial",
        bulkAdd: "Add all",
        bulkAdding: "Adding…",
        colName: "Name",
        colDescription: "Description (optional)",
        descPlaceholder: "Click to add a description (saves on blur or Enter)",
        remove: "Remove",
        confirmDelete: (name: string) => `Remove category "${name}"?`,
      },
      pricing: {
        help:
          "Per-(provider, model) token rates in $ per 1M tokens. Used to compute the Cost pill on each run page. Cost is locked in at the time of each AI call — editing a row here only affects future calls. Rows are auto-created for every model in your registry; fill in the rates from each provider's pricing page.",
        empty:
          "No models in the registry yet. Add models under Providers, then come back here to set their prices.",
        cols: {
          provider: "Provider",
          model: "Model",
          inputRate: "Input $/1M",
          outputRate: "Output $/1M",
        },
        save: "Save",
        delete: "Delete",
        deleteConfirm: (provider: string, model: string) =>
          `Remove pricing for ${provider} / ${model}? Future calls under this model will record cost = 0 until a row is added back.`,
        errInvalid: "Both rates must be non-negative numbers.",
      },
      classifyContext: {
        intro:
          "When enabled, the Ahrefs judges (Backlinks / Anchors / Organic keywords by default) receive a \"Site context\" block built from this domain's Wayback classify verdict (theme, category, language). Helps the AI flag PBN-style theme mismatches — e.g. backlinks from gambling domains pointing at a pet-care site.",
        masterToggle: "Pass Wayback classify context to Ahrefs judges",
        criteriaHeading: "Which judges receive the context",
        criteriaHelp:
          "Refdomains is OFF by default — without anchors or surrounding snippets, theme inference on a domain-only row tends to hallucinate.",
        fieldsHeading: "Which classify fields to include",
        fieldsHelp:
          "Field names match the wayback_classify verdict shape. Empty/missing fields are skipped at runtime.",
        cacheNote:
          "Changing criteria or fields invalidates the AI verdict cache for affected criteria. The next judging pass will re-call the AI.",
        criterionNames: {
          backlinks: "Backlinks",
          refdomains: "Refdomains",
          anchors: "Anchors",
          keywords: "Organic keywords",
        },
        save: "Save",
        saving: "Saving…",
        resetDefaults: "Reset to defaults",
        savedAt: (when: string) => `Saved ${when}`,
      },
      scoring: {
        intro:
          "Tune how per-criterion AI verdicts roll up into the 0–100 final score, where the bucket boundaries fall, and when the pill greys out for low confidence.",
        weightsHeading: "Per-criterion weights",
        weightsHelp:
          "Renormalized over enabled criteria — e.g. if only Backlinks + Anchors run, their weights re-scale so the score still spans 15–85.",
        weightsTotal: (sum: number) =>
          sum === 1
            ? `Total: ${sum} ✓`
            : `Total: ${sum} (does not need to equal 1; the runner renormalizes).`,
        bucketsHeading: "Bucket thresholds",
        bucketsHelp:
          "Score ≥ good → green pill. Score ≥ mixed (but < good) → amber. Below mixed → red.",
        goodThreshold: "Good ≥",
        mixedThreshold: "Mixed ≥",
        lowConfHeading: "Low-confidence threshold",
        lowConfHelp:
          "When the AI's mean confidence (0–1) falls below this, the score pill renders grey regardless of the bucket — a visual warning the verdict isn't trustworthy.",
        lowConfThreshold: "Grey out when confidence <",
        save: "Save",
        saving: "Saving…",
        resetDefaults: "Reset to defaults",
        savedAt: (when: string) => `Saved ${when}`,
      },
      prompts: {
        intro:
          "System prompts the AI uses to judge each criterion plus the final assessment. Edit to match your team's quality standards. Reset returns to the shipped default.",
        labels: {
          backlinks: "Backlinks judge",
          refdomains: "Referring domains judge",
          anchors: "Anchors judge",
          keywords: "Organic keywords judge",
          wayback: "Wayback history judge",
          wayback_classify_combined:
            "Wayback classify — combined language + theme (AI mode)",
          wayback_classify_theme_only:
            "Wayback classify — theme only (library mode)",
          wayback_category: "Wayback classify — category classification",
          whois_history_judge:
            "Whois History judge (drop vs transferred — Wave 2)",
          final: "Ahrefs final assessment",
          localize_ru:
            "Russian output directive (appended to every prompt on RU runs)",
        },
        custom: "Customized",
        default: "Default",
        save: "Save",
        reset: "Reset to default",
        resetConfirm: "Reset this prompt to the shipped default?",
      },
      providerNames: {
        ahrefs: "Ahrefs",
        gemini: "Google Gemini",
        github_models: "GitHub Models",
        openrouter: "OpenRouter",
        vertex_ai: "Google Vertex AI",
      },
      providerHelp: {
        ahrefs:
          "Ahrefs API v3 key. Used by Site Explorer to fetch backlinks, referring domains, anchors, and organic keywords per domain.",
        gemini:
          "Google AI Studio API key. The default model is used when no explicit model is selected on the Analyze page.",
        github_models:
          "GitHub PAT with the `models:read` scope. Browse model IDs at github.com/marketplace/models.",
        openrouter:
          "OpenRouter API key. The default model is the slug shown on openrouter.ai/models, e.g. `anthropic/claude-3.5-sonnet`.",
        vertex_ai:
          "Google Vertex AI. Paste a service-account JSON for enterprise mode (uses your GCP project + region), OR paste only an API key for Vertex Express mode. The service-account JSON takes precedence when both are set.",
      },
      fieldLabels: {
        api_key: "API key",
        token: "Token",
        default_model: "Default model",
        service_account_json: "Service-account JSON",
        project_id: "Project ID",
        location: "Location",
      },
      fieldPlaceholders: {
        api_key: "Paste API key…",
        token: "Paste token…",
        default_model: "e.g. gemini-2.5-flash",
        service_account_json:
          '{ "type": "service_account", "project_id": "...", "private_key": "...", "client_email": "...", ... }',
        project_id: "my-gcp-project",
        location: "us-central1",
      },
      savedSecret: (last4: string, length: number) =>
        `Saved: ••••${last4} (${length} chars)`,
      savedValue: (value: string) => `Saved: ${value}`,
      notSet: "Not set",
      clearConfirm: (provider: string) =>
        `Clear all stored credentials for ${provider}?`,
      modelDropdownPlaceholder: "Pick a model…",
      modelDropdownEmpty: "No models in registry — add some below.",
      modelRegistry: {
        heading: "Known models",
        count: (n: number) =>
          `${n} model${n === 1 ? "" : "s"}`,
        empty: "No models yet. Add one below or paste a list.",
        defaultBadge: "default",
        defaultTooltip: "Currently the default for this provider",
        makeDefault: "Set as default for this provider",
        remove: "Remove from registry",
        addSingle: "+ Add",
        adding: "Adding…",
        singlePlaceholder: "model id (e.g. gemini-2.5-flash)",
        bulkToggle: "Bulk paste…",
        bulkPlaceholder:
          "Paste model ids — one per line or comma-separated.\nExisting entries are kept (dedup).",
        bulkHelp: "Merged with the existing list (dedup, order preserved).",
        mergeCount: (n: number) =>
          `+ Merge ${n} model${n === 1 ? "" : "s"}`,
        merging: "Merging…",
      },
      testOk: "Connection works.",
      testFail: "Connection failed",
      rateLimitFields: {
        rpm: "Requests per minute",
        max_concurrent: "Max concurrent",
        retry_max: "Max retries",
      },
      rateLimitsHelp:
        "Applied per provider during job execution. The Ahrefs row also bounds how many domains are fetched in parallel within a single job.",
    },
    errors: {
      title: "Errors",
      intro:
        "Every error captured across the app — AI verdict failures, Ahrefs API errors, run / domain failures, and uncaught backend exceptions. Dismiss the ones you've handled; if a source row produces a different error later, it un-dismisses automatically.",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      exportVisible: (n: number) => `Export visible (${n})`,
      exportAll: (n: number) => `Export all (${n})`,
      exportSelected: (n: number) => `Export selected (${n})`,
      exportVisibleHint:
        "Download a CSV of the rows currently matching your category + status + search filters (across all pages).",
      exportAllHint: "Download every error in the database, ignoring filters.",
      tabs: {
        all: "All",
        ai: "AI",
        ahrefs: "Ahrefs",
        wayback: "Wayback",
        domain: "Domain",
        run: "Run",
        backend: "Backend",
      },
      statusOpen: (n: number) => `Open (${n})`,
      statusDismissed: (n: number) => `Dismissed (${n})`,
      statusAll: (n: number) => `All (${n})`,
      empty: "No errors match the current filters.",
      cols: {
        category: "Category",
        when: "When",
        message: "Message",
        context: "Context",
        actions: "Actions",
      },
      openSource: "Open source →",
      expandHint: "Click to expand the full message + traceback.",
      dismiss: "Dismiss",
      restore: "Restore",
      delete: "Delete",
      deleteLogHint:
        "Permanently remove this log row. Available only for backend-captured errors (sources with no underlying domain/run row to point back at).",
      confirmDeleteLog: "Permanently delete this log row?",
      selectedCount: (n: number) => `${n} error${n === 1 ? "" : "s"} selected`,
      selectAllOnPage: "Select all on this page",
      clearSelection: "Clear",
      bulkDismiss: (n: number) => `Dismiss ${n}`,
      bulkDismissing: "Dismissing…",
      confirmBulkDismiss: (n: number) =>
        `Dismiss ${n} selected error${n === 1 ? "" : "s"}? Already-dismissed rows will be touched (timestamp updated).`,
    },
    // Shared availability strings — used by the Analyze box, the
    // Database/Backlog Availability column, and the Settings tab.
    availability: {
      // Status pills
      statusAvailable: "available",
      statusRegistered: "registered",
      statusUnknown: "unknown",
      statusError: "error",
      statusNotSupported: "not supported",
      // Column hover
      checkedAt: (when: string) => `checked ${when}`,
      expiresOn: (date: string) => `expires ${date}`,
      registrar: (name: string) => `registrar: ${name}`,
      sourceProvider: (p: string) => `via ${p}`,
      // Actions
      recheck: "Recheck",
      rechecking: "Checking…",
      bulkRecheck: (n: number) =>
        `Recheck availability (${n} domain${n === 1 ? "" : "s"})`,
      bulkRecheckRunning: "Checking…",
      // Analyze page box
      analyzeBoxTitle: "Domain availability",
      analyzeBoxHint:
        "Check each domain's registration status before Ahrefs/Wayback. Settings → Domain availability controls providers, rate limits, and the skip-registered policy.",
      analyzeBoxToggle: "Check availability before analysis",
      // Settings tab
      settingsTabTitle: "Domain availability",
      settingsProvidersHeading: "Providers",
      settingsCascadeHeading: "Cascade order",
      settingsCascadeHint:
        "Providers are tried in this order. Disabled providers are skipped at runtime. RDAP is the authoritative source for .com / .net / .org; Domainr (RapidAPI) is a paid sanity check; WHOIS is a final fallback for TLDs without RDAP.",
      settingsRateLimitsHeading: "Rate limits",
      settingsRateLimitsHint:
        "Hard ceiling: 10 req/sec per provider regardless of value below.",
      settingsSkipHeading: "Skip-registered policy",
      settingsSkipHint:
        "When ON, registered domains whose expiration is beyond the horizon below are skipped during analysis — saves Ahrefs units. Domains about to drop still flow through.",
      settingsCacheHeading: "Cache TTL (hours)",
      settingsCacheHint:
        "Reuse cached availability results within this window. Drop-hunters near close-to-drop dates may want 1h instead of the 24h default.",
      settingsRetentionHeading: "Recent-checks retention",
      settingsRetentionHint:
        "Bounds the availability_checks history table. Daily prune + one-shot on every container restart. Defaults: 30 days, 20 rows per domain. Set either field to 0 to disable that cap.",
      settingsRetentionDaysLabel: "Retention (days):",
      settingsRetentionDaysHint: "0 = keep forever by age.",
      settingsPerDomainKeepLabel: "Keep per domain:",
      settingsPerDomainKeepHint: "0 = unlimited (within the age window).",
      settingsApiKeyHeading: "Domainr API key (RapidAPI)",
      settingsApiKeyHint:
        "Free Basic tier on RapidAPI gives 10,000 lookups/month. Encrypted at rest.",
      settingsStatsHeading: "Usage this month",
      settingsRecentHeading: "Recent checks",
      // Error categories
      errorCatDns: "DNS",
      errorCatRdap: "RDAP",
      errorCatDomainr: "Domainr",
      errorCatWhois: "WHOIS",
      errorCatQuota: "Quota",
      errorCatNetwork: "Network",
      errorCatParse: "Parse",
    },
    banlist: {
      title: "Ban List",
      hint:
        "Permanent filter — domains here are silently rejected at every ingestion point: Backlog imports, Database Order/Discard actions, the availability cascade, and Analyze submissions. Distinct from a Backlog 'discarded' status, which is a per-decision soft flag. Existing Backlog rows are not affected when you ban a domain — banning is a pure pre-filter.",
      searchPlaceholder: "Search by domain or note…",
      importOpen: "Import CSV",
      importClose: "Close import",
      importTitle: "Import from CSV",
      importHint:
        "One row per domain. Optional second column = note. Empty lines and #-prefixed lines are ignored. Already-banned domains are merged (note overwritten only when blank).",
      importPlaceholder:
        "example.com\nshady-pbn.net, suspicious anchors profile\n# comment lines are ignored",
      importSubmit: "Import",
      importBusy: "Importing…",
      importResult: (added: number, already: number, invalid: number) =>
        `Added ${added}, already banned ${already}, invalid ${invalid}.`,
      loading: "Loading…",
      emptyAll: "No domains on the ban list yet.",
      emptyFiltered: "No banned domains match the current search.",
      colDomain: "Domain",
      colNote: "Note",
      colAnalyses: "Analyses",
      colCreatedAt: "Banned at",
      colActions: "",
      analyses: {
        ahrefs: "Ahrefs",
        wayback: "Wayback",
        whois: "Whois",
        linkHint: (label: string) =>
          `Open the ${label} analysis for this domain — review why you banned it.`,
      },
      unbanOne: "Unban",
      unbanSelected: (n: number) => `Unban ${n} selected`,
      unbanSelectedConfirm: (n: number) =>
        `Remove ${n} domain${n === 1 ? "" : "s"} from the ban list? They'll be eligible for analysis and Backlog import again. Existing Backlog rows (if any) are unaffected either way.`,
      selectAll: "Select all visible",
      totalLine: (total: number, visible: number, selectedCount: number) =>
        `${total} banned · ${visible} visible · ${selectedCount} selected`,
    },
    shares: {
      title: "Share links",
      intro:
        "View-only links you've generated for specific domain analyses. Anyone with a link can view the page without basic-auth — revoke a link here to cut access immediately.",
      statusLabel: "Status",
      statusOptions: {
        all: "All",
        active: "Active",
        revoked: "Revoked",
        expired: "Expired",
      },
      searchLabel: "Search",
      searchPlaceholder: "domain or note…",
      perPageLabel: "Per page",
      refresh: "Refresh",
      bulkRevoke: "Revoke selected",
      revokingPlural: "Revoking…",
      clearSelection: "Clear selection",
      revokeAll: "Revoke all active",
      revokeAllHint:
        "Nuclear button — revokes EVERY currently-active share link in one click. Use if you suspect a leak.",
      revokeAllConfirm:
        "Revoke ALL currently-active share links? Recipients lose access immediately. This cannot be undone — they'd need new tokens.",
      bulkRevokeConfirm: (n: number) =>
        `Revoke ${n} selected share${n === 1 ? "" : "s"}? Recipients lose access immediately.`,
      bulkRevokeDone: (revoked: number, requested: number) =>
        `Revoked ${revoked} of ${requested} share${requested === 1 ? "" : "s"}.`,
      bulkRevokeFailed: "Bulk revoke failed",
      revokeAllDone: (n: number) =>
        `Revoked ${n} active share${n === 1 ? "" : "s"}.`,
      revokeOneConfirm:
        "Revoke this share? The recipient loses access immediately.",
      copied: "Copied to clipboard.",
      selectedCount: (n: number) => `${n} selected`,
      selectAllAria: "Select all visible",
      selectAria: (domain: string) => `Select share for ${domain}`,
      pageInfo: (start: number, end: number, total: number) =>
        `Showing ${start}–${end} of ${total}`,
      prev: "Previous",
      next: "Next",
      empty: "No share links yet. Open any domain page and click 'Share'.",
      never: "Never",
      cols: {
        domain: "Domain",
        status: "Status",
        note: "Note",
        job: "Job",
        created: "Created",
        expires: "Expires",
        views: "Views",
        actions: "Actions",
      },
      copy: "Copy link",
      open: "Open",
      revoke: "Revoke",
      // --- Added 2026-05-24: Delete + Activate + Settings panel ---
      activate: "Activate",
      activateConfirm:
        "Activate this share again? The recipient regains access (if it isn't past its expiry). The audit trail is preserved.",
      hardDelete: "Delete",
      hardDeleteConfirm:
        "Hard-delete this share row? The audit trail (view count, created IP) is lost. Use Revoke instead if you want to keep the trail.",
      deleteRevoked: "Delete revoked",
      deleteRevokedConfirm: (n: number) =>
        n > 0
          ? `Hard-delete all ${n} currently-revoked share${n === 1 ? "" : "s"}? Audit trail is lost. Active shares are untouched.`
          : "Hard-delete every currently-revoked share row? Audit trail is lost. Active shares are untouched.",
      deleteRevokedHint:
        "Permanently remove every revoked share row. Audit trail (view count, IP) is lost. Active shares are untouched.",
      deleteRevokedDone: (n: number) =>
        `Deleted ${n} revoked share${n === 1 ? "" : "s"}.`,
      deleteRevokedFailed: "Delete revoked failed",
      hardDeleteFailed: "Delete failed",
      activateFailed: "Activate failed",
      // Settings panel — collapsible, default open=false.
      settings: {
        title: "Default settings",
        toggle: "Default settings",
        intro:
          "Defaults applied to newly-minted share links. Set 0 to default to forever (no expiry).",
        defaultExpiresLabel: "Default expiry (days)",
        defaultExpiresHint:
          "Applied when no expiry is picked. 0 = never expires (recommended for internal links). Cap: 3650 days (10 years).",
        save: "Save",
        saving: "Saving…",
        saved: "Saved.",
        reset: "Reset to default",
        resetConfirm: "Reset share defaults to shipped values?",
        currentDefault: (days: number) =>
          days === 0
            ? "Currently: never expires (forever)."
            : `Currently: ${days} day${days === 1 ? "" : "s"} from creation.`,
      },
    },
    share: {
      // Recipient-facing labels (public /share/[token] page).
      viewOnlyBadge: "Drop Sherlock — shared analysis (view-only)",
      sharedOn: "Shared",
      expiresOn: "expires",
      finalAssessment: "Final assessment",
      verdictLabel: "Verdict",
      confidenceLabel: "Confidence",
      recommendationLabel: "Recommendation",
      notesHeading: "Notes",
      footer:
        "This is a view-only snapshot of one domain analysis. Powered by Drop Sherlock.",
      notFoundTitle: "Share not found",
      notFound:
        "This link is no longer valid. It may have been revoked, expired, or never existed.",
    },
    // Wave 1 (2026-05-15) — placeholder strings for the four pillar
    // stubs (Check/Jobs × Whois History/Availability). Replaced by
    // real page copy as each wave ships.
    pillarStub: {
      comingSoon: "Coming soon — this pillar isn't shipped yet.",
      wave2:
        "Planned for Wave 2: integrate WhoisFreaks Historical WHOIS API + AI judge for drop detection.",
      wave3:
        "Planned for Wave 3: promote the existing availability cascade (RDAP / Domainr / WHOIS:43) to a first-class Job kind so you can run availability checks as standalone jobs (today it's a sub-check of Quality runs and a button on Backlog rows).",
      architectureNote:
        "The Job → Run → Domain tree, cache, pagination, archive, notes, pin, export, and search infrastructure is already in place — each pillar just needs its kind-specific runner + UI added on top.",
      useQuality: "Use the Quality pillar instead",
    },
    checkWhoisHistory: {
      title: "Check — Whois History",
      subtitle:
        "Historical WHOIS drop-detection. Each domain gets one provider call (records fetched, diff computed) and one AI verdict (dropped vs transferred, with confidence and key signals). Use BEFORE the Quality pillar to skip Wayback + Ahrefs spend on domains the AI says clearly didn't drop.",
      pipelineHint:
        "Configure the provider key + rate limits in Settings → Whois History before submitting big jobs.",
      labelHeading: "Job label",
      labelHint:
        "Optional — defaults to `<first-domain> +N more · <yyyy-mm-dd HH:MM>` when blank.",
      nameLabel: "Name",
      namePlaceholder: "e.g. drop-watch batch 2026-05",
      notesLabel: "Notes",
      notesPlaceholder: "Why are we checking these?",
      submit: "Run Whois history check",
      submitting: "Submitting…",
      settingsLink: "Open Whois settings",
      summary: (n: number) => `${n} domain${n === 1 ? "" : "s"} ready`,
      skippedBanned: (n: number) =>
        `Skipped ${n} banned domain${n === 1 ? "" : "s"} from the input.`,
      allBannedError: (count: number, sample: string, truncated: boolean) =>
        `All submitted domains are on the ban list (${count} total): ${sample}${
          truncated ? "…" : ""
        }`,
      // Rerun banner (added 2026-05-21).
      rerunBannerTitle: "Rerun of",
      rerunBannerCancel: "Cancel rerun",
      rerunBannerHelp:
        "A new Run will be added to this Job. Edit the domain list or AI provider, then submit.",
    },
    checkAvailability: {
      title: "Availability",
      subtitle:
        "Run the domain-availability cascade (RDAP → Domainr → WHOIS:43) against a list of domains. Each domain produces one CriterionResult row holding the resolved status + the per-provider cascade trace.",
      pipelineHint:
        "No AI involved — the cascade gives a deterministic verdict. Cascade order, per-provider toggles, RPS/concurrency, and TTL live in Settings → Availability. This Job forces fresh state per run; per-row Recheck buttons on /database and /backlog stay on the cache-honoring path.",
      labelHeading: "Job label",
      labelHint:
        "Optional. The name shows on /jobs/availability and on the job detail page; the note is for free-form context.",
      nameLabel: "Name",
      namePlaceholder: "Auto-generated from the first domain if blank",
      notesLabel: "Notes",
      notesPlaceholder: "Why are you checking these?",
      submit: "Run availability",
      submitting: "Dispatching…",
      settingsLink: "Open Availability settings",
      summary: (n: number) => `${n} domain${n === 1 ? "" : "s"} ready`,
      skippedBanned: (n: number) =>
        `Skipped ${n} banned domain${n === 1 ? "" : "s"} from the input.`,
      allBannedError: (count: number, sample: string, truncated: boolean) =>
        `All submitted domains are on the ban list (${count} total): ${sample}${
          truncated ? "…" : ""
        }`,
      // Rerun banner (added 2026-05-21).
      rerunBannerTitle: "Rerun of",
      rerunBannerCancel: "Cancel rerun",
      rerunBannerHelp:
        "A new Run will be added to this Job. Edit the domain list, then submit.",
    },
    checkAhrefsBatch: {
      title: "Ahrefs Batch Analysis",
      subtitle:
        "Pull current-snapshot Ahrefs /batch-analysis metrics (DR, referring domains, backlinks, organic traffic + keywords) across a domain list. One CriterionResult row per domain holds the selected metrics. Resilient to 100,000 domains — fetched in batches of 100.",
      pipelineHint:
        "No AI involved — the metrics are the verdict. Cost ≈ 1 unit/domain/metric (a 50-unit floor per 100-domain batch). Configure the Ahrefs API key in Settings → Providers.",
      metricsHeading: "Metrics",
      metricsHint:
        "Pick which Ahrefs batch-analysis fields to fetch. DR only by default (cheapest). Each extra metric adds ~1 unit/domain.",
      selectAll: "Select all",
      clearAll: "Clear all",
      countryLabel: "Country (optional)",
      countryHint:
        "Scopes Organic traffic / keywords to one country. Worldwide when blank. ISO alpha-2 code, e.g. us, gb, de.",
      countryAny: "Worldwide",
      labelHeading: "Job label",
      labelHint:
        "Optional. The name shows on /jobs/ahrefs-batch-analysis and on the job detail page; the note is for free-form context.",
      nameLabel: "Name",
      namePlaceholder: "Auto-generated from the first domain if blank",
      notesLabel: "Notes",
      notesPlaceholder: "Why are you analyzing these?",
      submit: "Run batch analysis",
      submitting: "Dispatching…",
      settingsLink: "Open Ahrefs settings",
      noMetricsError: "Pick at least one metric.",
      summary: (n: number) => `${n} domain${n === 1 ? "" : "s"} ready`,
      skippedBanned: (n: number) =>
        `Skipped ${n} banned domain${n === 1 ? "" : "s"} from the input.`,
      allBannedError: (count: number, sample: string, truncated: boolean) =>
        `All submitted domains are on the ban list (${count} total): ${sample}${
          truncated ? "…" : ""
        }`,
      rerunBannerTitle: "Rerun of",
      rerunBannerCancel: "Cancel rerun",
      rerunBannerHelp:
        "A new Run will be added to this Job. Edit the domain list, then submit.",
    },
    ahrefsBatchDomain: {
      heading: "Ahrefs Batch Analysis metrics",
      metric: "Metric",
      value: "Value",
      noData:
        "No metrics yet — run pending, failed, or this domain's batch was rejected.",
      errorPrefix: "Fetch error",
    },
    jobsWhoisHistory: {
      title: "Whois History — Jobs",
      subtitle:
        "Past + ongoing WHOIS-history jobs. Same Job → Run → Domain tree as Quality, scoped to this pillar.",
    },
    jobsAvailability: {
      title: "Availability — Jobs",
      subtitle:
        "Past + ongoing availability-cascade jobs.",
    },
    // Per-pillar copy for the shared JobsListByKind component (Wave
    // 2b, 2026-05-15). The shape MUST mirror `pages.jobs.tabs` /
    // `pages.jobs.bulk` / `pages.jobs.cols` from the legacy pillar
    // (we keep those under pages.jobs for backward compat); only the
    // headings + empty-state CTA copy diverge per pillar.
    jobsByKind: {
      quality: {
        title: "Jobs — Quality",
        intro:
          "Submitted Quality (Wayback + Ahrefs) jobs. Click a job to see its runs + per-domain verdicts.",
        empty: "No Quality jobs yet — start one from Check → Quality.",
        goCheck: "Open Check → Quality",
      },
      whois_history: {
        title: "Jobs — Whois History",
        intro:
          "Submitted Whois History (drop-detection) jobs. Click a job to see its runs + per-domain WHOIS verdicts.",
        empty:
          "No Whois History jobs yet — start one from Check → Whois History.",
        goCheck: "Open Check → Whois History",
      },
      availability: {
        title: "Jobs — Availability",
        intro:
          "Submitted Availability (RDAP / Domainr / WHOIS-43 cascade) jobs.",
        empty: "No Availability jobs yet — Wave 3 ships the submit page.",
        goCheck: "Open Check → Availability",
      },
      ahrefs_batch_analysis: {
        title: "Jobs — Ahrefs Batch Analysis",
        intro:
          "Submitted Ahrefs Batch Analysis jobs (bulk /batch-analysis metrics). Click a job to see its runs + per-domain metrics.",
        empty:
          "No Ahrefs Batch Analysis jobs yet — start one from Check → Ahrefs Batch Analysis.",
        goCheck: "Open Check → Ahrefs Batch Analysis",
      },
    },
    // Wave 2b (2026-05-15) — per-domain page for whois_history-kind
    // runs (rendered via WhoisHistoryDomainView when job_kind matches).
    availabilityDomain: {
      verdictHeading: "Availability verdict",
      resolvedBy: "Resolved by",
      registrar: "Registrar",
      expiresOn: "Expires on",
      noVerdict:
        "No cascade verdict yet — run pending, failed, or skipped.",
      cascadeErrorPrefix: "Cascade error",
      traceHeading: "Cascade trace",
      traceHint:
        "One row per provider that was attempted. Newest-first. The cascade walks providers in the order configured in Settings → Availability and stops on the first terminal answer (available / registered).",
      traceEmpty: "No provider rows recorded for this run.",
      cols: {
        provider: "Provider",
        status: "Status",
        latency: "Latency",
        registrar: "Registrar",
        expires: "Expires",
        error: "Error",
        checkedAt: "Checked at",
      },
    },
    whoisDomain: {
      pending: "Whois History fetch / AI judge still pending for this domain.",
      errorHeading: "Whois History fetch failed",
      verdict: {
        heading: "AI verdict",
        dropConfidence: "dropped",
        transferredConfidence: "transferred",
        keySignals: "Key signals",
        recommendation: "Recommendation",
      },
      diff: {
        heading: "Diff signals",
        coverage: (count: number, first: string | null, last: string | null) =>
          first && last
            ? `${count} snapshots · ${first.slice(0, 10)} → ${last.slice(0, 10)}`
            : `${count} snapshots`,
        // 2026-05-17: small always-visible chip for drop-hunters —
        // raw count of distinct creation_date values in WhoisFreaks
        // history. NOT a "drops" count (registry data scrubs /
        // WHOIS-server migrations can also rewrite the field) — the
        // AI judge weighs this signal separately via dropped_confidence.
        creationDateChangesCount: (n: number) =>
          `Creation date changes: ${n}`,
        creationDateChangesCountHint:
          "Raw count of distinct creation_date values in WhoisFreaks history. NOT necessarily the same as 'times dropped' — registry data scrubs or WHOIS-server migrations can also rewrite this field. Use the AI dropped_confidence chip above for a weighted verdict.",
        hardSignals: "Hard signals",
        softSignals: "Soft signals",
        noHardSignals:
          "No hard signals (no creation-date change, no drop-pipeline status, no coverage gaps).",
        signals: {
          creation_date_changes: "Creation date changed (HARD — re-registered)",
          drop_pipeline_status_events:
            "Drop-pipeline status codes in history (HARD)",
          coverage_gaps_days: "Coverage gaps ≥ threshold (HARD)",
          owner_changes: "Registrant name changed",
          email_changes: "Registrant email changed",
          org_changes: "Registrant org / company changed",
          country_changes: "Registrant country changed",
          city_changes: "Registrant city changed",
          registrar_changes: "Registrar changed (weak — transfers happen)",
          ns_changes: "Nameserver family changed (weak — hosting moves)",
          dnssec_toggles: "DNSSEC toggled (weak)",
        },
      },
      currentState: {
        heading: "Current state (latest snapshot)",
        registrar: "Registrar",
        owner: "Owner",
        org: "Organization",
        country: "Country",
        creationDate: "Creation date",
        status: "Status codes",
        nameServers: "Nameservers",
        dnssec: "DNSSEC",
        dnssecOn: "enabled",
        dnssecOff: "disabled",
        inDropPipeline:
          "Latest snapshot shows this domain in the registry's drop pipeline.",
      },
      rawRecords: {
        toggle: (n: number) =>
          `Raw historical records (${n} snapshot${n === 1 ? "" : "s"})`,
        cols: {
          queryTime: "As of",
          creationDate: "Created",
          expiryDate: "Expires",
          registrar: "Registrar",
          registrant: "Registrant",
          country: "Country",
          status: "Status",
        },
      },
    },
    backlog: {
      title: "Backlog",
      intro:
        "Triage queue for raw domain candidates pulled from registrars and auctions. Filter, mark statuses, then send a subset to Analyze.",
      empty: "No domains in your backlog yet.",
      noMatch: "No domains match the current filters.",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      searchPlaceholder: "Search domain, project, or comment…",
      cols: {
        domain: "Domain",
        status: "Status",
        // 2026-05-17: renamed "Registrar" → "Source" at user request.
        // The underlying BacklogDomain.registrar field name unchanged;
        // this is a header label only. Same column also appears on the
        // Database page now under the same label.
        registrar: "Source",
        expirationDate: "Expiration",
        availability: "Availability",
        project: "Project",
        comments: "Comments",
        desiredPrice: "Desired $",
        maxPrice: "Max $",
      },
      statusLabels: {
        backlog: "Backlog",
        in_progress: "In progress",
        analyzed: "Analyzed",
        order: "Order",
        backordered: "Ordered",
        bought: "Bought",
        discarded: "Discarded",
        question: "Question",
        banned: "Banned",
      },
      filters: {
        heading: "Filters",
        clear: "Clear filters",
        statusLabel: "Status",
        statusAny: "Any status",
        // 2026-05-17: filter renamed "Registrar" → "Source" to match
        // the column header rename. Key name stays `registrarLabel`
        // since the underlying state is `registrarFilter` (which maps
        // to BacklogDomain.registrar) — label-only swap.
        registrarLabel: "Source",
        registrarAny: "Any source",
        registrarSearchPlaceholder: "Search sources…",
        expiryFrom: "Expires from",
        expiryTo: "Expires to",
        availabilityLabel: "Availability",
        availabilityAny: "Any availability",
        availabilityHint:
          "Filter by the latest availability-check result (RDAP / Domainr / WHOIS:43 cascade).",
        availabilityAvailable: "available",
        availabilityRegistered: "registered",
        availabilityNotSupported: "not supported",
        availabilityUnknown: "unknown",
        availabilityError: "error",
        availabilityNeverChecked: "(never checked)",
      },
      selectedCount: (n: number) =>
        `${n} domain${n === 1 ? "" : "s"} selected`,
      selectAllOnPage: "Select all on this page",
      clearSelection: "Clear",
      bulkChangeStatus: "Change status",
      bulkChangeStatusAllFiltered: (n: number) =>
        `Change status on all ${n} filtered…`,
      bulkChangeStatusTo: (label: string) => `Set to: ${label}`,
      confirmBulkStatusFiltered: (n: number, label: string) =>
        `Set status to "${label}" on all ${n} domain${n === 1 ? "" : "s"} matching the current filters? This cannot be undone with one click.`,
      sendToAnalyze: (n: number) =>
        `Send ${n} to Analyze`,
      sendAllFilteredToAnalyze: (n: number) =>
        `Send all ${n} filtered to Analyze`,
      confirmSendAllFiltered: (n: number) =>
        `Send all ${n} filtered domain${n === 1 ? "" : "s"} to Analyze? They'll be marked "in progress" automatically.`,
      sendToPicker: {
        label: (n: number) => `Send ${n} to:`,
        allFilteredLabel: (n: number) => `Send all ${n} filtered to:`,
        quality: "Quality",
        qualityHint:
          "Run Ahrefs criteria (backlinks / refdomains / anchors / keywords) + Wayback. The original pre-3-pillar 'Analyze' path.",
        whois: "Whois",
        whoisHint:
          "Run WHOIS history (drop-pipeline detection). Cheap per-domain — billed in WhoisFreaks units.",
        availability: "Availability",
        availabilityHint:
          "Run the availability cascade (RDAP / Domainr / WHOIS:43) to confirm what's currently registered.",
        ahrefsBatch: "Ahrefs Batch",
        ahrefsBatchHint:
          "Run Ahrefs Batch Analysis (DR, referring domains, backlinks, organic metrics) — the cheap bulk pre-filter before Wayback / full Ahrefs.",
      },
      analyzedHint: (n: number) =>
        `${n} backlog domain${n === 1 ? " has" : "s have"} been analyzed but ${n === 1 ? "isn't" : "aren't"} marked yet.`,
      analyzedHintMark: (n: number) =>
        `Mark ${n} as Analyzed`,
      analyzedHintDismiss: "Not now",
      openAnalyzed: "Open the analyzed domain page",
      bulkDelete: (n: number) => `Delete ${n}`,
      bulkDeleting: "Deleting…",
      bulkDeleteAllFiltered: (n: number) => `Delete all ${n} filtered`,
      bulkDeleteAllFilteredNoFilterHint:
        "Apply at least one filter first — this action would wipe the entire backlog otherwise.",
      confirmBulkDelete: (n: number) =>
        `Permanently delete ${n} backlog row${n === 1 ? "" : "s"}? This cannot be undone.`,
      confirmBulkDeleteFiltered: (n: number) =>
        `Permanently delete all ${n} backlog row${n === 1 ? "" : "s"} matching the current filters? This cannot be undone.`,
      totalHint: (filtered: number, total: number) =>
        filtered === total
          ? `${total} domain${total === 1 ? "" : "s"}`
          : `${filtered} of ${total} domain${total === 1 ? "" : "s"}`,
      importBtn: "Import CSV",
      exportFiltered: (n: number) => `Export filtered (${n})`,
      exportAll: (n: number) => `Export all (${n})`,
      exportFilteredHint:
        "Download a CSV of the rows currently matching your filters and search.",
      exportAllHint: "Download every domain in the backlog.",
      importDialog: {
        title: "Import domains from CSV",
        step1Heading: "1. Pick a file",
        fileHint: "CSV, TXT, or TSV. First row should be the column headers.",
        step2Heading: "2. Map columns",
        step2Intro: (n: number) =>
          `Detected ${n} columns. Map each to a backlog field, or pick "(skip)" to ignore it. Domain is required.`,
        sourceColLabel: "Source column",
        targetFieldLabel: "Map to",
        targetFields: {
          skip: "(skip)",
          domain: "Domain",
          status: "Status",
          registrar: "Registrar",
          expiration_date: "Expiration date",
          project: "Project",
          comments: "Comments",
          desired_price: "Desired price",
          max_price: "Max price",
          ahrefs_dr: "Ahrefs DR (stored, hidden)",
          domain_age_years: "Age, years (stored, hidden)",
        },
        previewHeading: "Preview (first 5 rows)",
        defaultsHeading: "3. Defaults for unmapped fields",
        defaultsHint:
          "Apply the same value to every imported row when the column isn't in the file.",
        defaultRegistrar: "Registrar (default for all rows)",
        defaultStatus: "Status (default for all rows)",
        dateFormatLabel: "Expiration date format",
        dateFormatOptions: {
          auto: "Auto-detect",
          iso: "YYYY-MM-DD (2026-05-09)",
          dmy_dot: "DD.MM.YYYY (09.05.2026)",
          dmy_slash: "DD/MM/YYYY (09/05/2026)",
          dmy_dash: "DD-MM-YYYY (09-05-2026)",
          mdy_slash: "MM/DD/YYYY (05/09/2026)",
          month_name: "Month name (Jan 15, 2026)",
        },
        importBtn: (n: number) => `Import ${n} row${n === 1 ? "" : "s"}`,
        importing: "Importing…",
        cancel: "Cancel",
        close: "Close",
        domainNotMapped: "Map a source column to Domain to continue.",
        emptyFile: "The file has no rows.",
        fileTruncated: (n: number) =>
          `File too large — only the first ${n} rows were loaded. Split the file and import the rest separately.`,
        result: {
          heading: "Import complete",
          inserted: (n: number) =>
            `Added ${n} new domain${n === 1 ? "" : "s"}.`,
          skippedDupes: (n: number) =>
            `Skipped ${n} duplicate${n === 1 ? "" : "s"} (already in backlog).`,
          skippedBanned: (n: number) =>
            `Skipped ${n} banned domain${n === 1 ? "" : "s"} (on the Ban List).`,
          skippedFilteredCctld: (n: number) =>
            `Skipped ${n} country-level domain${n === 1 ? "" : "s"} (Settings → Domain Filter).`,
          skippedFilteredOther: (cat: string, n: number) =>
            `Skipped ${n} domain${n === 1 ? "" : "s"} by filter "${cat}".`,
          skippedInvalid: (n: number) =>
            `Skipped ${n} invalid row${n === 1 ? "" : "s"}.`,
          errorsHeading: "Issues:",
          moreErrors: (n: number) => `… and ${n} more`,
        },
      },
      // Phase 3 placeholders are intentionally absent — the buttons that
      // would use them aren't on the page yet.
    },
  },
};

type Messages = typeof messagesEn;

// Russian translation. Service / provider names stay in English (Ahrefs,
// Google Gemini, GitHub Models, OpenRouter, Wayback). AI system prompts
// stay in English too — the runner appends a Russian-output directive to
// them at request time so the verdict text comes back in Russian without
// having to maintain a translated copy of every prompt. TypeScript
// enforces shape parity with messagesEn.
const messagesRu: Messages = {
  appName: "Drop Sherlock",
  langName: { en: "EN", ru: "RU" },
  langSwitchTitle: "Язык",
  themeSwitchToLight: "Переключить на светлую тему",
  themeSwitchToDark: "Переключить на тёмную тему",
  common: {
    loading: "Загрузка…",
    save: "Сохранить",
    saved: "Сохранено.",
    clear: "Очистить",
    cleared: "Очищено.",
    test: "Тест",
    cancel: "Отмена",
    error: "Ошибка",
  },
  pagination: {
    searchPlaceholder: "Поиск…",
    perPage: "На странице",
    showingX: (start, end, total) => `Показаны ${start}–${end} из ${total}`,
    showingFiltered: (start, end, filtered, total) =>
      `Показаны ${start}–${end} из ${filtered} (отфильтровано из ${total})`,
    none: "По вашему запросу ничего не найдено.",
    prev: "Назад",
    next: "Вперёд",
    page: (cur, total) => `Страница ${cur} из ${total}`,
  },
  nav: {
    dashboard: "Панель",
    backlog: "Очередь",
    analyze: "Анализ",
    check: "Проверка",
    jobs: "Задачи",
    database: "База",
    shares: "Ссылки",
    errors: "Ошибки",
    settings: "Настройки",
    databaseDropdown: {
      label: "База",
      analyzeList: "Список для анализа",
      banList: "Бан-лист",
      toggleAria: "Открыть меню Базы",
    },
    checkDropdown: {
      quality: "Качество (Wayback + Ahrefs)",
      whoisHistory: "История Whois",
      availability: "Доступность",
      ahrefsBatchAnalysis: "Ahrefs Batch Analysis",
      toggleAria: "Открыть меню Проверки",
    },
    jobsDropdown: {
      quality: "Качество",
      whoisHistory: "История Whois",
      availability: "Доступность",
      ahrefsBatchAnalysis: "Ahrefs Batch Analysis",
      toggleAria: "Открыть меню Задач",
    },
  },
  pages: {
    dashboard: {
      title: "Панель",
      intro: "Текущий статус всех настроенных API-интеграций.",
      refresh: "Обновить",
      checkedAt: (when) => `Проверено ${when}`,
      providerNames: {
        ahrefs: "Ahrefs",
        gemini: "Google Gemini",
        github_models: "GitHub Models",
        openrouter: "OpenRouter",
        vertex_ai: "Google Vertex AI",
        whoisfreaks: "WhoisFreaks",
      },
      whoisfreaksConfiguredHint:
        "API-ключ настроен. Панель не делает живой запрос (каждый запрос к WhoisFreaks стоит денег). Чтобы проверить вживую — Настройки → История Whois → Проверить (1 запрос на клик).",
      refreshHint:
        "Перечитать состояние из БД. Без запросов к провайдерам — мгновенно.",
      liveChecks: "Живая проверка",
      liveChecksRunning: "Проверка…",
      liveChecksHint:
        "Опросить все AI-провайдеры, Ahrefs и Wayback на актуальную живость. Использует бесплатные test-эндпоинты — стоит вам ничего. WhoisFreaks остаётся в режиме config-only (каждый запрос стоит денег — используйте Настройки → История Whois → Проверить для отдельного запроса).",
      liveCheckedAt: (when) => `Живая проверка: ${when}`,
      lastLiveAt: (when) => `Последняя живая проверка: ${when}`,
      modeBannerConfig:
        "Показано НАСТРОЕННОЕ состояние (без запросов к провайдерам). Нажмите «Живая проверка», чтобы убедиться, что провайдеры отвечают прямо сейчас.",
      modeBannerLive:
        "Показано ЖИВОЕ состояние — провайдеры опрошены только что. «Обновить» перечитает настройки без повторного опроса.",
      states: {
        ok: "Работает",
        unconfigured: "Не настроено",
        error: "Ошибка",
        unknown: "Проверка…",
      },
      noKeyYet:
        "Учётные данные ещё не сохранены. Откройте Настройки, чтобы добавить.",
      openSettings: "Открыть Настройки",
      elapsed: (ms) => `${ms} мс`,
    },
    analyze: {
      title: "Анализ",
      intro:
        "Вставьте или загрузите домены, выберите критерии, запустите задачу. Результаты появятся ниже в виде сводной таблицы.",
      domains: {
        heading: "Домены",
        help: "По одному в строке. Схемы (https://) и пути будут удалены автоматически.",
        placeholder: "example.com\nanother.com\nthird-domain.io",
        count: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          if (last2 >= 11 && last2 <= 14) return `${n} доменов`;
          if (last1 === 1) return `${n} домен`;
          if (last1 >= 2 && last1 <= 4) return `${n} домена`;
          return `${n} доменов`;
        },
        upload: "Загрузить файл",
        uploadHint: ".txt или .csv — по одному домену в строке",
      },
      criteria: {
        heading: "Критерии",
        help: "Включайте или выключайте каждый критерий. Лимит, фильтры и сортировка применяются только когда критерий включён.",
        backlinks: "Обратные ссылки",
        refdomains: "Ссылающиеся домены",
        anchors: "Анкоры",
        keywords: "Органические ключи",
        wayback: "История Wayback",
        wayback_classify: "Язык + тематика + категория",
        whois_history: "История Whois",
        availability: "Доступность",
        waybackDiscoverHint:
          "Выключенные карточки свёрнуты — кликните по шевр-стрелке на карточке, чтобы развернуть и включить её. Wayback добавляет сигнал по истории сайта; Wayback Classify автоопределяет язык, тематику и категорию.",
      },
      fields: {
        limit: "Лимит",
        filters: "Фильтры",
        sort: "Сортировать по",
        addSort: "+ Добавить поле сортировки",
        sortAsc: "По возр.",
        sortDesc: "По убыв.",
        aggregation: "Агрегация",
        aggregationHelp:
          "Стоимость одинакова для всех режимов (Ahrefs тарифицирует по лимиту, а не по числу строк). «По одному на домен» даёт ИИ более широкий обзор графа ссылок при том же бюджете.",
      },
      aggregationLabels: {
        similar_links: "Похожие ссылки (по умолчанию)",
        all: "Все (без дедупа)",
        "1_per_domain": "По одному на домен",
      },
      filterLabels: {
        dofollow: "dofollow",
        nofollow: "nofollow",
        non_spammy: "Не спамные (is_spam=0)",
        noindexExclude: "Исключить noindex-страницы",
        noindexExcludeHint:
          "Убирает беклинки, у чьей ссылающейся страницы есть <meta name=\"robots\" content=\"noindex\">. Отправляется is_noindex_source=0.",
        contentOnly: "Только редакционные / в-контенте",
        contentOnlyHint:
          "Ограничивает выдачу редакционными ссылками внутри статьи (is_content=1). Без этого попадают также футер / сайдбар / сквозные / комментарии.",
        rootOnly: "Только доноры-корни (без поддоменов)",
        rootOnlyHint:
          "Убирает беклинки, у которых ссылающийся URL находится на поддомене (например blog.example.com/path). Отправляется is_root_source=1. Беклинки с поддоменов часто оказываются собственной сеткой и слабее редакционно; снимите галочку, если хотите изучать именно поддоменный паттерн ссылок.",
      },
      backlinksSections: {
        defaults: "По умолчанию",
        defaultsHint: "(применяется автоматически — раскройте, чтобы изменить)",
        onePerDomain: "Агрегация: 1 на домен",
        onePerDomainHint:
          "Возвращает по одной ссылке на ссылающийся домен. Снижает шум от сквозных / шаблонных ссылок, чтобы ИИ оценивал разнообразие, а не количество.",
        drLabel: "Domain Rating (DR)",
        urLabel: "URL Rating (UR)",
        keywordsLabel: "Ключевые слова страницы (позиции)",
        keywordsHint:
          "Фильтр по числу органических ключей у ссылающейся страницы. Любое из / оба / ни одного.",
        trafficLabel: "Трафик страницы",
        trafficHint:
          "Оценочные ежемесячные органические визиты на ссылающуюся страницу. Любое из / оба / ни одного.",
        rangeHintBounded: "0–100. Любое из или оба. Пусто = без ограничения.",
        region: "Регион",
        domainContainsLabel: "Домен содержит",
        domainContainsHint:
          "Через запятую или вертикальную черту. ИЛИ-сравнение с корневым доменом ссылающегося. Удобно для отбора/исключения групп TLD по странам.",
        languagesLabel: "Языки",
        languagesHint:
          "Пусто = без фильтра по языку. Несколько = ИЛИ-сравнение с массивом языков каждой строки.",
      },
      keywords: {
        dateComparedLabel: "Сравнить с",
        dateComparedHelp:
          "Опционально. Если указать, Ahrefs добавит к каждой строке поля `_prev` за прошлый период — ИИ-судья видит тренд по ключам (рост или просадка).",
        dateCompared: {
          off: "выкл (без сравнения)",
          "3m": "3 месяца назад",
          "6m": "6 месяцев назад",
          "1y": "1 год назад",
          "2y": "2 года назад",
          "5y": "5 лет назад",
        },
      },
      wayback: {
        intro:
          "Бесплатно, без авторизации. Достаёт историю снимков из Wayback CDX API — показывает возраст сайта, недавнюю активность и хвост 301/302-редиректов. Сильный сигнал для дроп-доменов, которые уже мигрировали.",
        matchTypeLabel: "Тип совпадения",
        matchType: {
          exact: "exact (только точный URL)",
          prefix: "prefix (URL начинается с цели)",
          host: "host (один хост, без поддоменов) — рекомендуется для пакетных задач",
          domain: "domain (хост + все поддомены) — медленно в CDX, использовать для глубокого анализа одного домена",
        },
        fromYear: "С года",
        toYear: "По год",
        collapseLabel: "Схлопывать соседние строки одного месяца",
        collapseHelp:
          "Значение CDX `collapse=`. \"timestamp:6\" ≈ один снимок на месяц на URL — убирает шум плотно индексируемых сайтов, не теряя сигналы событий. Пусто = без схлопывания.",
        v2Heading: "Сэмплинг содержимого страниц (V2)",
        v2Intro:
          "Загружает несколько архивных HTML-страниц и извлекает заголовок + хедеры + 150-символьный фрагмент тела. Позволяет ИИ замечать смену тематики год к году (например «Рецепты пиццы 2018 → Бонусы казино 2024»). Медленно — добавляет 1–3 с на сэмпл.",
        samplePages: "Сэмплировать страницы снимков",
        samplePagesHint:
          "Выкл = только CDX-строки (быстро). Вкл = дополнительно подгружает несколько архивных страниц, чтобы ИИ видел реальные заголовки во времени.",
        sampleCount: "Количество сэмплов",
        sampleCountHint:
          "Сколько архивных страниц забирать на домен (1–15). 6 ≈ по одной на ~3 года при 20-летней истории.",
        sampleStrategyLabel: "Стратегия выбора",
        sampleStrategy: {
          even: "Равномерно — по квантилям таймлайна",
          anchor:
            "Аномалии — около CDX-событий (смены статуса, mimetype, скачки длины, большие пробелы краулинга)",
        },
        samplePathLabel: "Путь URL",
        samplePath: {
          mixed: "Смешанно — использовать URL, на который указывает каждая выбранная CDX-строка",
          root: "Корень — всегда брать снимок /",
        },
      },
      waybackClassify: {
        title: "Язык + тематика + категория",
        aiOnlyBadge: "Только ИИ · из Wayback-сэмплов",
        intro:
          "Определяет основной язык и тематику сайта по архивным сэмплам страниц Wayback (заголовки + хедеры + фрагменты тела) и автоматически классифицирует тематику в одну из ваших предопределённых категорий из Настроек. Создан для триажа дроп-доменов: текущее состояние плюс детектирование сдвига относительно исторической базовой линии.",
        languageModeLabel: "Режим определения языка",
        languageMode: {
          ai: "ИИ — общий промпт язык + тематика (использует <html lang> как подсказку)",
          library:
            "Библиотека (lingua-language-detector) — детерминированно; тематика отдельным AI-вызовом",
        },
        languageModeHint: {
          ai: "Один AI-вызов возвращает и язык, и тематику. Быстрее, но язык бывает нестабильным на коротком тексте на не-латинице.",
          library:
            "Lingua детерминированно агрегирует основной язык по тексту сэмплов. Тематика затем определяется ИИ отдельно. Надёжнее на коротком тексте; игнорирует правки промпта по поводу языка.",
        },
        autoEnableNote:
          "При отправке: Wayback + сэмплинг V2 будут включены автоматически (этот критерий требует V2-сэмплов).",
      },
      sortFields: {
        domain_rating_source: "DR (домен-источник)",
        url_rating_source: "UR (URL-источник)",
        traffic_domain: "Трафик домена",
        refdomains_source: "Ссылающиеся домены",
        positions: "Ключевые слова",
        traffic: "Трафик страницы",
        first_seen_link: "Первое обнаружение",
        links_to_target: "Ссылок на цель",
        new_links: "Новые ссылки",
        first_seen: "Первое обнаружение",
        refdomains: "Ссыл. домены",
        volume_mobile_pct: "Мобильный объём поиска",
        sum_traffic: "Трафик",
        is_best_position_set_top_11_50: "Топ 11–50",
      },
      preview: {
        heading: "Предпросмотр API-запросов",
        help: "Обновляется по мере правок формы. Это ровно те GET-URL, которые Drop Sherlock дёрнет на каждый домен при запуске задачи.",
        empty: "Включите хотя бы один критерий, чтобы увидеть предпросмотр запросов.",
        domainNote: (d) => `Запросы для: ${d}`,
        copy: "Копировать",
        copied: "Скопировано",
        disabled: "(отключён)",
      },
      jobName: {
        label: "Название задачи (опционально)",
        placeholder: "Оставьте пустым для авто-имени по первому домену + времени",
      },
      ai: {
        heading: "Вердикт ИИ",
        help: "Выберите AI-провайдера для оценки каждого критерия. Модели берутся из вашего реестра (управление в Настройках). Выберите None, чтобы пропустить ИИ и только тянуть данные Ahrefs.",
        provider: "Провайдер",
        none: "None — без ИИ",
        notConfigured: "(не настроено)",
        modelLabel: (model) => `модель: ${model}`,
        noModel: "модель по умолчанию не задана — задайте в Настройках",
        modelPickerLabel: "Модель",
        modelDropdownDefaultOption: (model) => `по умолчанию · ${model}`,
        modelDropdownNoDefault: "по умолчанию (не задана)",
        noKnownModels:
          "у этого провайдера нет зарегистрированных моделей — добавьте в",
        skippedWarning:
          "ИИ сейчас выключен. Сводная таблица будет пустой для этого запуска. Выберите провайдера выше, чтобы включить вердикты.",
      },
      jobNotes: {
        label: "Заметки (опционально)",
        placeholder: "Что-нибудь, что хотите запомнить про эту партию",
      },
      rerunBanner: {
        title: (jobName) => `Перезапуск: ${jobName}`,
        help: "Отредактируйте критерии и отправьте. К этой задаче будет добавлен новый запуск; предыдущий останется в истории.",
        clear: "Отменить перезапуск (начать заново)",
        useCacheLabel:
          "Переиспользовать данные из прошлых запусков (когда критерии совпадают)",
        useCacheHelp:
          "Когда включено, идентичные запросы Ahrefs и идентичные AI-промпты копируются из прошлых запусков этой задачи — экономит юниты Ahrefs и AI-токены. Выключите, чтобы принудительно тянуть свежие данные.",
      },
      fromDatabaseBanner: {
        title: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          let word = "доменов";
          if (last2 < 11 || last2 > 14) {
            if (last1 === 1) word = "домен";
            else if (last1 >= 2 && last1 <= 4) word = "домена";
          }
          return `Анализ ${n} ${word} из Базы`;
        },
        help: "Выберите ниже, какие критерии (пере)запустить. Будет создана новая задача. Опция кросс-задачного кэша ниже позволяет переиспользовать данные Ahrefs и вердикты ИИ из любого предыдущего запуска во всём вашем рабочем пространстве, чьи критерии совпадают.",
        clear: "Очистить (начать новый /analyze)",
        crossCacheLabel:
          "Переиспользовать данные из прошлых анализов по ВСЕМ задачам (кросс-задачный кэш)",
        crossCacheHelp:
          "Когда включено, раннер ищет по всей базе любую прошлую CR-строку, чей хэш критерия + фильтров/сортировки/лимита совпадает с тем, что вы отправляете. Совпадения копируются — экономит юниты Ahrefs и AI-токены. Снимите галочку, чтобы получить всё свежим, даже если вы запускали такой же анализ раньше в другой задаче.",
        prefilledFromJob: (name, jobId) =>
          `Критерии + ИИ предзаполнены из «${name}» (задача #${jobId}) — той самой задачи, что породила Wayback-вердикты для этих строк. Оставьте настройки как есть, чтобы кэш сработал по максимуму; любая правка может изменить хэш параметров и привести к свежим запросам.`,
      },
      submit: {
        cancel: "Отменить запуск",
        cancelConfirm:
          "Отменить этот запуск? Уже полученные данные сохранятся; ожидающие домены будут пропущены.",
        pause: "Пауза",
        resume: "Продолжить",
        run: "Запустить анализ",
        rerunCta: "Сохранить и перезапустить",
        running: "Отправка…",
        validation: {
          noDomains: "Добавьте хотя бы один домен.",
          noCriteria: "Включите хотя бы один критерий.",
        },
        errors: {
          allBanned: (count, sample, truncated) => {
            const last2 = count % 100;
            const last1 = count % 10;
            let word = "доменов";
            if (last2 < 11 || last2 > 14) {
              if (last1 === 1) word = "домен";
              else if (last1 >= 2 && last1 <= 4) word = "домена";
            }
            const head =
              count === 1
                ? "Отправленный домен находится в бан-листе"
                : `Все ${count} отправленных ${word} находятся в бан-листе`;
            if (sample.length === 0) return `${head}.`;
            const list = sample.join(", ");
            const tail = truncated ? `, … (всего ${count})` : "";
            return `${head}: ${list}${tail}.`;
          },
        },
        progress: (done, total) => `${done} / ${total} доменов готово`,
        progressFailed: (n) => `· ${n} с ошибкой`,
        statusPending: "В очереди",
        statusRunning: "Выполняется",
        statusDone: "Готово",
        statusFailed: "Ошибка",
        runLink: (runId) => `Запуск #${runId}`,
        finishedNote:
          "Сырые данные Ahrefs в БД. Сводная таблица ИИ появится на следующем шаге.",
        startNew: "Начать новый анализ",
      },
      summaryTable: {
        heading: "Сводка",
        placeholder:
          "Отправьте задачу, чтобы увидеть здесь оценку ИИ. Подробности по доменам — на странице Задачи.",
        cols: {
          domain: "Домен",
          backlinks: "Беклинки",
          refdomains: "Реф. домены",
          anchors: "Анкоры",
          keywords: "Ключи",
          final: "Итог",
          wayback: "Wayback",
        },
        noAi: "(без ИИ)",
        loadingVerdicts: "Ожидаем вердикты ИИ…",
        viewDetail: "Открыть",
      },
    },
    jobs: {
      title: "Задачи",
      intro:
        "Все прошлые анализы — с заметками, запусками и страницами по каждому домену.",
      empty:
        "Задач пока нет — запустите первый анализ на странице Анализ.",
      emptyArchived: "Архивных задач нет.",
      goAnalyze: "Перейти к Анализу",
      tabs: {
        active: "Активные",
        archived: "Архив",
        all: "Все",
      },
      bulk: {
        selected: (n) => `выбрано: ${n}`,
        delete: "Удалить",
        archive: "В архив",
        unarchive: "Из архива",
        deleteConfirm: (n) =>
          `Удалить ${n} задач(и) и все их запуски? Действие необратимо.`,
        deleting: "Удаление…",
        archiving: "Архивирование…",
        unarchiving: "Восстановление…",
      },
      archivedBadge: "в архиве",
      cols: {
        name: "Название",
        notes: "Заметки",
        runs: "Запуски",
        latestStatus: "Последний запуск",
        created: "Создано",
      },
      latestRun: {
        none: "Запусков пока нет",
        statusOk: (done, total) => `${done}/${total} готово`,
        statusFailed: (failed, total) => `${failed}/${total} с ошибкой`,
      },
      detail: {
        backLink: "← Все задачи",
        rename: "Переименовать",
        delete: "Удалить",
        archive: "В архив",
        unarchive: "Из архива",
        archivedBanner:
          "Эта задача в архиве — её не видно в списке Задач по умолчанию. Восстановите, чтобы вернуть.",
        cancel: "Отмена",
        cancelConfirm:
          "Отменить этот запуск? Уже полученные данные сохранятся; ожидающие домены будут пропущены.",
        pause: "Пауза",
        resume: "Продолжить",
        compareRuns: "Сравнить запуски",
        statusBadgePaused: "пауза",
        renamePrompt: "Новое название?",
        deleteConfirm: (name) =>
          `Удалить «${name}» и все её запуски? Действие необратимо.`,
        deleteRun: "Удалить",
        deleteRunConfirm: (runId, total) =>
          `Удалить запуск #${runId} и его ${total} строк(и) доменов? Действие необратимо.`,
        rerun: "Перезапустить с новыми критериями",
        editNotes: "Редактировать заметки",
        saveNotes: "Сохранить заметки",
        cancelEdit: "Отмена",
        notesPlaceholder: "Добавьте заметки для этой задачи…",
        notesEmpty: "(нет заметок)",
        runsHeading: "Запуски",
        noRuns: "Запусков пока нет.",
        pinsHeading: "Пины по критериям",
        pinsHint:
          "Какой Run даёт данные по каждому критерию для свёрнутого вида этой Задачи на странице Базы. Только для чтения — пин/анпин делается на странице Run, в панели «Пины по критериям». Пропуски берутся из самого свежего Run, где этот критерий есть.",
        pinsBadge: (pinned, total) => `${pinned}/${total} зафиксировано`,
        pinsUnpinned: "не зафиксирован",
        runLabel: (id, name = "") => name?.trim() || `Запуск #${id}`,
        renameRun: "Переименовать",
        renameRunPrompt: (id) =>
          `Новая метка для запуска #${id}? (пусто — очистить)`,
        pinRun: "Закрепить",
        pinRunHint:
          "Закрепить этот запуск как канонический источник для сводки оценок. Закрепление заменит другое закрепление в этой задаче.",
        unpinRun: "Открепить",
        unpinRunHint:
          "Открепить этот запуск. Сводка вернётся к последнему запуску.",
        runPinnedBadge: "ЗАКРЕПЛЁН",
        runPinnedHint:
          "Сводка вверху страницы считается по доменам этого запуска.",
        progress: (done, total, failed) => {
          const failedSuffix = failed > 0 ? ` · ${failed} с ошибкой` : "";
          return `${done}/${total} доменов${failedSuffix}`;
        },
        startedAt: (when) => `Начато ${when}`,
        finishedAt: (when) => `Завершено ${when}`,
        meta: (created, updated) =>
          `Создано ${created} · Обновлено ${updated}`,
        rollup: {
          fromPinnedRun: (runId) => `Закреплён: Запуск #${runId}`,
          fromLatestRun: (runId) => `Последний: Запуск #${runId}`,
          pinnedSourceHint:
            "Сводка считается по закреплённому запуску. Открепите, чтобы вернуться к последнему.",
          latestSourceHint:
            "Сводка считается по последнему запуску. Закрепите другой запуск, чтобы зафиксировать сводку на нём.",
          label: {
            good: "хорошо",
            mixed: "смешанно",
            low_quality: "низкое качество",
            partial: "частично",
            no_verdict: "без вердикта",
          },
          labelAvailability: {
            good: "свободен",
            mixed: "занят",
            low_quality: "низкое качество",
            // Двойной домен под приватным многоуровневым суффиксом
            // (jcg.us.com) — доступность не проверить (2026-06-02).
            not_supported: "не поддерживается",
            // 2026-05-16 split (см. EN labelAvailability).
            unknown: "неизвестно",
            error: "ошибка",
            partial: "частично",
            no_verdict: "без вердикта",
          },
          labelWhois: {
            good: "стабильный",
            mixed: "возможный дрифт",
            low_quality: "дроп/смена владельца",
            partial: "частично",
            no_verdict: "без вердикта",
          },
          labelAhrefsBatch: {
            good: "получено",
            error: "ошибка",
            no_verdict: "нет данных",
          },
        },
      },
      run: {
        backToJob: (name) => `← ${name}`,
        title: (id, name = "") => name?.trim() || `Запуск #${id}`,
        rename: "Переименовать",
        renamePrompt: (id) =>
          `Новая метка для запуска #${id}? (пусто — очистить)`,
        statusBadge: {
          pending: "в очереди",
          running: "выполняется",
          done: "готово",
          failed: "ошибка",
          canceled: "отменён",
        },
        domainsHeading: "Домены",
        cols: {
          domain: "Домен",
          status: "Статус",
          criteria: "Критерии",
          ai: "ИИ",
          aiWayback: "ИИ Wayback",
          aiAhrefs: "ИИ Ahrefs",
          language: "Язык",
          theme: "Тема",
          category: "Категория",
          finished: "Завершено",
        },
        viewDomain: "Открыть",
        empty: "В этом запуске нет доменов.",
        emptyFiltered:
          "Ни один домен не подходит под текущий фильтр. Снимите его, чтобы увидеть остальные.",
        clearFilter: "Снять фильтр",
        serverBatchRange: (start, end, total) =>
          `Показано ${start.toLocaleString()}–${end.toLocaleString()} из ${total.toLocaleString()}`,
        serverBatchUnfilteredHint: (total) =>
          `(отфильтровано из ${total.toLocaleString()} всего)`,
        serverBatchPage: (current, total) =>
          `Партия ${current} / ${total}`,
        serverBatchPrev: "← Назад",
        serverBatchNext: "Вперёд →",
        reanalyze: "Переоценить ИИ",
        reanalyzeHint:
          "Заново оценить все домены этого запуска свежим AI-вызовом. Игнорирует AI-кэш. Переиспользует существующие данные Ahrefs — без перезагрузки.",
        reanalyzing: "Переоценка…",
        reanalyzeStarted:
          "Переоценка запущена — вердикты ниже скоро обновятся.",
        reanalyzeFailed: "Переоценка не удалась",
        pause: "Пауза",
        resume: "Продолжить",
        cancel: "Отмена",
        cancelConfirm:
          "Отменить этот запуск? Уже завершённые домены сохранят данные; в работе — остановятся.",
        pinIndicator: "★ зафиксирован",
        // Per-criterion pinning (added 2026-05-12)
        pinPerCriterionHeading: "Пины по критериям",
        pinPerCriterionHint:
          "Для каждого критерия в этом задании выберите запуск, который даёт его данные на странице Базы. Позволяет собрать итеративный каскад — Wayback из одного запуска, Ahrefs из другого.",
        pinAllCriteria: "Зафиксировать все доступные",
        pinAllCriteriaHint:
          "Зафиксировать на этот запуск каждый критерий, по которому есть данные.",
        pinAllCriteriaResult: (pinned: number, replaced: number) =>
          replaced > 0
            ? `Зафиксировано критериев: ${pinned} (перезаписано прежних: ${replaced}).`
            : `Зафиксировано критериев: ${pinned}.`,
        pinCriterionHere: "★ зафиксирован здесь",
        pinCriterionElsewhere: (runId: number) => `зафиксирован на Run #${runId}`,
        pinCriterionNone: "не зафиксирован",
        retryFailed: (n) => (n > 0 ? `Повторить ${n} с ошибкой` : "Повторить с ошибкой"),
        retryFailedHint:
          "Перезапустить каждую неудачную загрузку Ahrefs/Wayback и каждый неудачный AI-вердикт в этом запуске. Перезагружает данные где их нет; пере-судит где данные есть. Отключённые критерии не трогает.",
        retryFailedConfirm: (criteria, domains) =>
          `Повторить ${criteria} неудачных критериев на ${domains} домене(ах)? Это снова потратит юниты Ahrefs на перезагрузки и AI-токены на повторные вердикты.`,
        retryFailedRunning: "Отправка…",
        retryFailedProgress: (inFlight, total) =>
          `Повторяем ${inFlight} из ${total}…`,
        retryFailedProgressBanner: (inFlight, total) =>
          `Повтор — ${inFlight} из ${total} домен(ов) ещё в работе…`,
        retryFailedDispatched: (criteria, domains) =>
          `Повтор отправлен — ${criteria} критериев на ${domains} домене(ах). Ждём, пока воркеры начнут…`,
        retryFailedNone: "Нет неудачных критериев для повтора.",
        retryFailedFailed: "Повтор не удался",
        cancelRetry: "Отменить повтор",
        cancelRetryBusy: "Отмена…",
        cancelRetryHint:
          "Остановить идущий Повтор неудачных. Отменяет фоновые задачи и сбрасывает RD, застрявшие в статусе «в работе».",
        cancelRetryConfirm:
          "Отменить идущий повтор? Уже выполненная работа сохраняется; запросы в полёте прерываются, RD в статусе «в работе» переводятся в терминальный.",
        cancelRetryDone: (canceled, flipped) =>
          `Повтор отменён — задач прервано: ${canceled}, RD сброшено: ${flipped}.`,
        cancelRetryFailed: "Отмена повтора не удалась",
        filterStatusLabel: "Статус",
        filterStatusAll: "все",
        filterStatusPending: "ожидание",
        filterStatusRunning: "в работе",
        filterStatusDone: "готово",
        filterStatusFailed: "с ошибкой",
        filterStatusCanceled: "отменено",
        filterWaybackLabel: "Wayback CDX",
        filterWaybackAny: "любое",
        filterWaybackZero: "0 строк",
        filterWaybackNonzero: "≥ 1 строки",
        // Availability verdict filter (2026-05-16) — only on Availability runs.
        filterAvailabilityLabel: "Доступность",
        filterAvailabilityAny: "любая",
        filterAvailabilityAvailable: "свободен",
        filterAvailabilityRegistered: "занят",
        filterAvailabilityNotSupported: "не поддерживается",
        filterAvailabilityUnknown: "неизвестно",
        filterAvailabilityError: "ошибка",
        // `filterAvailabilityNoVerdict` исключён из фильтра Run-страницы
        // 2026-05-17 (см. EN). Ключ сохранён на случай других ссылок.
        filterAvailabilityNoVerdict: "без вердикта",
        filterAvailabilityClear: "Очистить выбор",
        selectAllOnPage: "Выбрать все на этой странице",
        selectAllMatching: (n: number) =>
          `Выбрать все под фильтром (${n})`,
        clearSelection: "Очистить выбор",
        bulkSelected: (n: number) => `Выбрано: ${n}`,
        bulkRetry: (n: number) => `Повторить выбранные (${n})`,
        bulkRetryRunning: "Повтор…",
        bulkRetryCriteriaHeading: "Какие критерии повторить",
        bulkRetryCriteriaHint:
          "Будут перезапущены только критерии, которые упали на выбранных доменах. Неотмеченные не трогаем, даже если они тоже упали.",
        bulkRetryClassifyAutoNote:
          "wayback_classify читает V2-снимки страниц из строки wayback. Повтор wayback заново собирает эти снимки, поэтому wayback_classify будет перезапущен автоматически рядом с ним — даже если вы сняли с него галочку — чтобы вердикты остались согласованными.",
        bulkRetryResampleLabel: "Только пересобрать V2 (без перезапроса CDX)",
        bulkRetryResampleHelp:
          "Используйте, когда у wayback есть строки V1, но V2-снимки отсутствуют или устарели (например, classify упал с \"нужны V2-снимки\"). Переиспользует существующие CDX-строки, заново собирает V2 и пересудит как вердикт wayback, так и wayback_classify. Пропускает медленный CDX-запрос.",
        bulkRetryConfirm: "Повторить на выбранных",
        bulkRetryNothing:
          "Повторять нечего — ни на одном из выбранных доменов нет упавших критериев из отмеченного набора.",
        bulkRetryResult: (domains: number, criteria: number) =>
          `Повтор: ${criteria} критериев на ${domains} домене(ах).`,
        retryOutcomeAllRecovered: (n) =>
          `Все ${n} критериев восстановлены после повтора.`,
        retryOutcomePartial: (recovered, stillFailed) =>
          `Восстановлено: ${recovered}; ${stillFailed} критериев всё ещё с ошибкой.`,
        retryOutcomeAllStillFailed: (n) =>
          `Все ${n} критериев всё ещё с ошибкой после повтора.`,
        retryOutcomeViewErrors: "Открыть на странице Ошибок",
        exportVisible: (n) => `Экспорт видимых (${n})`,
        exportAll: (n) => `Экспорт всех (${n})`,
        exportVisibleHelp:
          "Скачать CSV строк, которые сейчас подходят под поиск.",
        exportAllHelp: "Скачать каждый домен этого запуска.",
        scoreWeightsHeading: "Веса итогового балла",
        scoreWeightsHint:
          "Пересчитать итоговые баллы этого запуска с другими весами критериев. Текст резюме и рекомендация от ИИ остаются без изменений — заменяется только числовой итог и доверие. Частичные строки (где критерий не прошёл синтез) пропускаются.",
        scoreWeightsOverrideActive: "На запуск применены свои веса",
        scoreWeightsOverrideGlobal: "Используются глобальные веса из Настроек",
        scoreWeightsExclude: "исключить",
        scoreWeightsSum: (s) => `Сумма: ${s.toFixed(2)} / 1.00`,
        scoreWeightsSumOk: "OK",
        scoreWeightsSumOff: "сумма должна быть 1.00",
        scoreWeightsNormalize: "Нормализовать до 1.0",
        scoreWeightsPreview: "Предпросмотр",
        scoreWeightsApply: "Применить к запуску",
        scoreWeightsReset: "Сбросить к глобальным",
        scoreWeightsResetDisabledHint:
          "Override для этого Run не задан — сбрасывать нечего.",
        scoreWeightsResetConfirm:
          "Снять переопределение и пересчитать баллы по текущим глобальным весам?",
        scoreWeightsApplyConfirm:
          "Переписать итоговый балл каждого непустого домена в этом запуске с этими весами? Текст ИИ останется прежним.",
        scoreWeightsBusyPreview: "Пересчёт…",
        scoreWeightsBusyApply: "Применение…",
        scoreWeightsBusyReset: "Сброс…",
        scoreWeightsPreviewTitle: "Пересчитанные баллы (предпросмотр)",
        scoreWeightsPreviewCount: (changed, total) =>
          `Изменятся ${changed} из ${total}`,
        scoreWeightsColDomain: "Домен",
        scoreWeightsColOld: "Было",
        scoreWeightsColNew: "Стало",
        scoreWeightsColDelta: "Δ",
        scoreWeightsPartial: "—",
        scoreWeightsFailedToLoad: "Не удалось загрузить глобальные веса",
        scoreWeightsFailedPreview: "Ошибка предпросмотра",
        scoreWeightsFailedApply: "Ошибка применения",
      },
      compare: {
        backLink: "← Все задачи",
        title: (jobName) => `Сравнение запусков · ${jobName}`,
        intro:
          "Бок о бок вердикты ИИ для одной задачи. Ячейки с разными вердиктами между запусками подсвечиваются.",
        notEnoughRuns:
          "Этой задаче нужно минимум 2 запуска для сравнения. Перезапустите её с другими критериями или другой моделью.",
        runA: "Запуск A",
        runB: "Запуск B",
        cols: {
          domain: "Домен",
          backlinks: "Беклинки",
          refdomains: "Реф. домены",
          anchors: "Анкоры",
          keywords: "Ключи",
          wayback: "Wayback",
          wayback_classify: "Классификация",
          theme: "Тематика",
          whois_history: "Whois",
          final: "Итог",
        },
        whoisBand: {
          dropped: "дропнут",
          mixed: "возможный дрифт",
          insufficient: "мало истории",
          stable: "стабильный",
        },
        whoisCycles: (n) => `× ${n} циклов`,
        legendDiff: "Разные",
        legendSame: "Одинаковые",
        legendOnlyA: "Только в A",
        legendOnlyB: "Только в B",
        viewDomainA: "Открыть A",
        viewDomainB: "Открыть B",
        noSharedCriteria:
          "Ни один критерий не был выполнен в обоих запусках — применима только колонка «Итог».",
      },
      domain: {
        backToRun: (id, name = "") =>
          `← ${name?.trim() || `Запуск #${id}`}`,
        title: (domain) => domain,
        intro: "Сырые данные Ahrefs, полученные для этого домена в этом запуске.",
        augmentsBannerHeading: (runId) =>
          `↳ Этот запуск дополняет Запуск #${runId}`,
        augmentsBannerBody:
          "В текущем запуске включено меньше критериев, чем в предыдущем комплексном запуске. Ячейки ниже сшиты: критерии, отсутствующие в этом запуске, берутся из Запуска #N (ссылка выше); присутствующие — отражают свежие данные этого запуска. У каждого вердикта показан небольшой бейдж «из Запуска #N», когда он взят из прошлого запуска.",
        stitchedBannerHeading: "↳ Сшитый вид по запускам",
        stitchedBannerBody:
          "По крайней мере один критерий ниже взят из прошлого запуска для этого домена. У каждого вердикта показан небольшой бейдж «из Запуска #N», когда он сшит из другого источника.",
        stitchedFromLabel: (runId) => `из Запуска #${runId}`,
        stitchedFromHint:
          "Данные и вердикт ИИ для этого критерия взяты из прошлого запуска, в котором он был. Текущий запуск не загружал его повторно. Перейдите в тот запуск, чтобы переоценить или перезагрузить именно этот критерий.",
        reanalyze: "Переоценить ИИ",
        reanalyzeHint:
          "Заново оценить критерии этого домена свежим AI-вызовом. Игнорирует кэш. Без перезагрузки Ahrefs.",
        reanalyzing: "Переоценка…",
        reanalyzeStarted: "Переоценка запущена — вердикты обновятся.",
        reanalyzeFailed: "Переоценка не удалась",
        pin: "Зафиксировать как основной",
        pinHint:
          "Сделать этот запуск основным источником данных для этого домена на странице Базы. Перезапишет любой прежний пин этого домена.",
        pinned: "Зафиксирован ★",
        pinnedHint:
          "Этот запуск — основной источник для этого домена на странице Базы. Кликните, чтобы снять.",
        pinning: "Фиксация…",
        unpinning: "Снятие…",
        replacePin: "Заменить пин",
        replacePinHint:
          "Сейчас для этого домена зафиксирован другой запуск. Кликните, чтобы переключить пин на этот запуск.",
        pinFailed: "Фиксация не удалась",
        share: {
          button: "Поделиться",
          buttonHint:
            "Создать неугадываемую ссылку «только просмотр» на эту страницу домена. Любой по ссылке откроет её без basic-auth — отозвать можно на странице «Ссылки».",
          modalTitle: "Создание ссылки «только просмотр»",
          expiryLabel: "Срок действия",
          expiryPresets: {
            never: "Бессрочно",
            d7: "7 дней",
            d30: "30 дней",
            d90: "90 дней",
          },
          noteLabel: "Заметка (необязательно)",
          notePlaceholder: "например, демо для КлиентКорп",
          warning:
            "Любой по ссылке увидит этот анализ без ввода пароля basic-auth. Стоимость, AI-провайдер и внутренние ID скрыты — но сырые строки Ahrefs и вердикты ИИ видны.",
          createButton: "Создать ссылку",
          creating: "Создание…",
          successHint: "Ссылка создана. Скопируйте и поделитесь:",
          copyButton: "Скопировать",
          copied: "Скопировано!",
          manageAll: "Управление ссылками",
          expiresHint: "Истекает:",
          done: "Готово",
          failPrefix: "Не удалось создать ссылку",
        },
        verdictsHeading: "Вердикты ИИ по критериям",
        rawDataHeading: "Сырые данные",
        tabs: {
          backlinks: "Беклинки",
          refdomains: "Ссылающиеся домены",
          anchors: "Анкоры",
          keywords: "Органические ключи",
          wayback: "История Wayback",
          wayback_classify: "Язык + тематика",
        },
        criterionMissing: "Этот критерий не был включён в этом запуске.",
        criterionFailed: "Не удалось получить этот критерий.",
        criterionEmpty: "Строки не возвращены.",
        rowCount: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          let word = "строк";
          if (last2 < 11 || last2 > 14) {
            if (last1 === 1) word = "строка";
            else if (last1 >= 2 && last1 <= 4) word = "строки";
          }
          return `${n} ${word}`;
        },
        showRaw: "Показать сырую строку",
        hideRaw: "Скрыть сырую строку",
        viewRequest: "Показать URL запроса",
        verdict: {
          heading: "Вердикт ИИ",
          assessment: "Оценка",
          confidence: "Уверенность",
          keyFindings: "Ключевые находки",
          redFlags: "Красные флаги",
          empty: "Вердикт не получен.",
          failed: "Вердикт ИИ не получен",
          inflight: "Вердикт ИИ в процессе…",
          cachedFromRun: (runId) => `из кэша · Запуск #${runId}`,
          reanalyzeButton: "Пере-судить",
          reanalyzeHint:
            "Заново оценить только этот критерий текущим AI-провайдером/моделью. Вердикты по другим критериям сохранятся; итоговая оценка будет пересчитана.",
          reanalyzing: "Пере-суждение…",
        },
        dataCachedFromRun: (runId) => `данные из кэша · Запуск #${runId}`,
        units: {
          cached: "0 юнитов (из кэша)",
          actual: (n) => {
            const last2 = n % 100;
            const last1 = n % 10;
            let word = "юнитов";
            if (last2 < 11 || last2 > 14) {
              if (last1 === 1) word = "юнит";
              else if (last1 >= 2 && last1 <= 4) word = "юнита";
            }
            return `${n} ${word}`;
          },
          ahrefsCachedHint: (listPrice) =>
            `Попадание в серверный кэш Ahrefs · цена по прайсу ${listPrice}`,
          perRow: (n) => `${n}/строка`,
          tooltip:
            "Стоимость в юнитах Ahrefs за этот запрос. «Фактическая» — то, что списал Ahrefs; разница с прайсом значит, что внутренний кэш Ahrefs вернул недавний идентичный ответ.",
        },
        aiPreview: {
          show: "Предпросмотр входа ИИ ▾",
          hide: "Скрыть вход ИИ ▴",
          toggleHint:
            "Показать ровно то, что получит ИИ при переоценке этого критерия — системный промпт + урезанный набор данных.",
          provider: "Провайдер",
          rows: (n) => {
            const last2 = n % 100;
            const last1 = n % 10;
            let word = "строк";
            if (last2 < 11 || last2 > 14) {
              if (last1 === 1) word = "строка";
              else if (last1 >= 2 && last1 <= 4) word = "строки";
            }
            return `отправлено ${n} ${word}`;
          },
          fieldsSent: "Передаваемые поля",
          fieldsHelp:
            "В пользовательское сообщение попадают только эти поля. Остальные отбрасываются перед вызовом — экономит токены.",
          showPrompt: "Показать системный промпт ▾",
          hidePrompt: "Скрыть системный промпт ▴",
          showMessage: "Показать сообщение пользователя ▾",
          hideMessage: "Скрыть сообщение пользователя ▴",
          viewTable: "Таблица",
          viewJson: "JSON",
        },
        finalBanner: {
          heading: "Итоговая оценка Ahrefs",
          summary: "Резюме",
          recommendation: "Рекомендация",
          partialHeading: "Частичный результат",
          partialCount: (succeeded, total) =>
            `${succeeded} из ${total} критериев оценено`,
          partialSucceeded: "Успешно",
          partialFailed: "С ошибкой",
          partialHint:
            "Балл и резюме намеренно не показаны, потому что часть критериев упала. Нажмите «Переоценить ИИ», чтобы повторить.",
          pending: "Итоговая оценка Ahrefs ожидается — ждём завершения всех критериев…",
          fromPriorRun: (runId) => `Показана оценка из запуска №${runId}`,
          fromPriorRunHint:
            "текущий запуск был частичным. Запустите «Переоценить ИИ», чтобы получить свежую итоговую оценку.",
        },
        waybackTab: {
          cdxToggle: (n) => {
            const last2 = n % 100;
            const last1 = n % 10;
            let word = "строк";
            if (last2 < 11 || last2 > 14) {
              if (last1 === 1) word = "строка";
              else if (last1 >= 2 && last1 <= 4) word = "строки";
            }
            return `Таблица CDX-строк (${n} ${word})`;
          },
        },
        waybackTimeline: {
          heading: "Лента снимков (V2)",
          intro:
            "Заголовок + хедеры + фрагмент тела, извлечённые с каждой архивной страницы. ИИ-судья видит это вместе с CDX-строками, чтобы заметить смену тематики год к году.",
          coverage: (ok, total) =>
            `${ok}/${total} сэмплов вернули пригодный HTML`,
          openSnapshot: "Открыть снимок ↗",
          noTitle: "(в архивном HTML нет заголовка)",
          moreItems: (n) => `+${n} ещё`,
          errorPrefix: "Ошибка сэмпла",
          redirectTo: "Редирект →",
          sortLabel: "Сортировка по дате",
          sortNewest: "Сначала новые",
          sortOldest: "Сначала старые",
          sortNewestHint: "Самые свежие снимки сверху.",
          sortOldestHint: "Самые ранние снимки сверху.",
        },
        notes: {
          heading: "Заметки",
          placeholder:
            "Ваше суждение об этом домене — переживает перезапуски и переоценки.",
          help:
            "Заметки привязаны к домену (между запусками). Сохраните пустое значение, чтобы очистить. Видны на странице Базы в колонке «Заметка».",
          save: "Сохранить",
          saving: "Сохранение…",
          edit: "Редактировать",
          cancel: "Отмена",
          updatedAt: (when) => `Сохранено ${when}`,
        },
      },
    },
    database: {
      title: "База",
      intro:
        "Каждый проанализированный домен. Данные строки берутся из вручную зафиксированного запуска — выберите основной запуск на домен (или зафиксируйте весь запуск с его страницы). Незафиксированные домены показаны с пустыми ячейками, пока вы не выберете запуск.",
      empty: "Доменов пока нет — запустите первый анализ на странице Анализ.",
      noMatch: "Нет доменов, подходящих под фильтры.",
      searchPlaceholder: "Поиск по домену, запуску или заметке…",
      cols: {
        // 2026-05-17: row-number column for "I'm on row N" orientation.
        rowNumber: "№",
        domain: "Домен",
        // 2026-05-23: Source column заменён на Max price.
        source: "Источник",
        maxPrice: "Макс $",
        maxPriceSortHint:
          "Клик для сортировки по Макс. цене. По возрастанию (сначала дешёвые) → по убыванию → по умолчанию. Строки без max_price в бэклоге всегда уходят в конец.",
        verdict: "Ahrefs",
        verdictSortHint:
          "Кликните для сортировки по баллу. Цикл: убыв → возр → по умолчанию. Частичные / без вердикта всегда уходят вниз.",
        whois: "Whois",
        whoisSortHint:
          "Кликните для сортировки по уверенности дропа Whois. Цикл: возр (стабильные сверху) → убыв → по умолчанию. Строки без Whois-вердикта всегда уходят вниз.",
        wayback: "Wayback",
        language: "Язык",
        theme: "Тема",
        category: "Категория",
        provider: "ИИ",
        note: "Заметка",
        criteria: "Критерии",
        availability: "Доступность",
        runs: "Запуски",
        pin: "Закреплённый запуск",
        backlog: "Очередь",
      },
      quickShare: {
        iconTitle:
          "Скопировать ссылку «только просмотр» для этого домена (1 клик). Срок действия настраивается в Ссылки → Настройки по умолчанию.",
        copying: "Создание ссылки…",
        copiedNew: "Ссылка создана и скопирована.",
        copiedReused: "Существующая ссылка скопирована.",
        copyFailed: "Не удалось скопировать — скопируйте вручную:",
        noRd: "Для этого домена пока нет проанализированного запуска — поделиться нечем.",
        failed: "Быстрая ссылка не удалась",
      },
      backlogActions: {
        order: "Заказать",
        orderHint:
          "Поставить домен в очередь на покупку (статус = order). Обновит соответствующую строку в Очереди или создаст новую, если домена там нет. После того как заказ действительно размещён, отметьте его как Заказан вручную на странице Очереди.",
        discard: "Отбросить",
        discardHint:
          "Отметить домен как отброшенный. Обновит соответствующую строку в Очереди или создаст новую, если домена там нет.",
        question: "Вопрос",
        questionHint:
          "Пометить домен как «вопрос» (требует уточнения перед решением). Обновит соответствующую строку в Очереди или создаст новую, если домена там нет.",
        currentStatus: (label) => `Сейчас: ${label}`,
        notInBacklog: "не в Очереди",
        saving: "Сохранение…",
        saveFailed: "Действие не удалось",
        bulkOrder: (n) => `Заказать ${n}`,
        bulkDiscard: (n) => `Отбросить ${n}`,
        bulkResult: (updated, created, status) => {
          const parts: string[] = [];
          if (updated > 0) parts.push(`обновлено ${updated}`);
          if (created > 0) parts.push(`создано ${created}`);
          if (parts.length === 0) parts.push("без изменений");
          return `${parts.join(" · ")} (статус = ${status}).`;
        },
      },
      // Apruv export (added 2026-05-20) — см. EN.
      apruv: {
        button: (n) => `Апрув (${n})`,
        buttonHint:
          "Экспортировать выбранные строки в CSV для согласующего, с автоматически сгенерированными ссылками-шарингами, которые согласующий открывает без авторизации.",
        modalTitle: "Апрув-экспорт",
        modalHelp: (n) => {
          const last2 = n % 100;
          const last = n % 10;
          let word = "строк";
          if (last2 < 11 || last2 > 14) {
            if (last === 1) word = "строка";
            else if (last >= 2 && last <= 4) word = "строки";
          }
          return `Будет экспортировано ${n} ${word}. Выберите колонки. Для каждой строки автоматически создаётся ссылка-шаринг, чтобы согласующий открыл страницу анализа без авторизации.`;
        },
        expiryLabel: "Срок действия ссылки",
        expiry7: "7 дней",
        expiry30: "30 дней",
        expiry90: "90 дней",
        expiryNever: "Бессрочно",
        columnsLabel: "Колонки в экспорте",
        mandatoryHint:
          "Домен и Share URL включены всегда.",
        cols: {
          domain: "Домен",
          share_url: "Ссылка-шаринг",
          backlog_status: "Статус",
          backlog_registrar: "Источник",
          backlog_expiration_date: "Дата истечения",
          backlog_desired_price: "Желаемая цена",
          backlog_max_price: "Макс. цена",
          backlog_ahrefs_dr: "Ahrefs DR",
          refdomains_dofollow: "Ссылающиеся домены (follow)",
          backlinks_dofollow: "Бэклинки (follow)",
          backlog_domain_age_years: "Возраст (лет)",
          final_score: "Ahrefs-балл",
          final_confidence: "Уверенность",
          wayback_verdict: "Вердикт Wayback",
          wayback_confidence: "Уверенность Wayback",
          whois_band: "Whois-полоса",
          primary_language: "Язык",
          primary_theme: "Тема",
          category: "Категория",
          note: "Заметки",
          ai_provider: "AI-провайдер",
          ai_model: "AI-модель",
        },
        cancel: "Отмена",
        close: "Закрыть",
        exportCsv: "Экспорт CSV",
        exporting: "Экспорт…",
        resultSummary: (inserted, skipped) =>
          skipped === 0
            ? `Скачано строк: ${inserted}.`
            : `Скачано строк: ${inserted} · пропущено: ${skipped} (нет ссылки-шаринга).`,
      },
      bulkBan: (n) => `В бан-лист (${n})`,
      bulkBanBusy: "Добавление…",
      bulkBanHint:
        "Навсегда исключить выбранные домены из будущих анализов и импортов в Очередь. Существующие записи в Очереди не меняются.",
      bulkBanConfirm: (n) =>
        `Добавить ${n} доменов в бан-лист? Они будут молча отклоняться при отправке в Анализ, импорте в Очередь и в авто-апсерте через проверку доступности. Забаненные строки скрываются из этого списка — историю анализов смотрите на странице Бан-лист. Разбан возвращает строки.`,
      bulkBanResult: (added, already, invalid) =>
        `Забанено ${added} · уже было ${already} · некорректных ${invalid}.`,
      bulkBanFailed: "Не удалось забанить",
      bannedBadge: "забанен",
      bannedBadgeHint:
        "В бан-листе. Будущие отправки в Анализ и импорты в Очередь для этого домена будут молча отклоняться.",
      pin: {
        notPinnedBadge: "не закреплён",
        notPinnedHint:
          "Для этого домена пока ни один запуск не закреплён. Выберите из списка, чтобы заполнить строку.",
        pickPlaceholder: "Выберите запуск для закрепления…",
        pinnedHeading: "Закреплён",
        pinnedHint:
          "Данные этой строки берутся из этого запуска. Выберите другой, чтобы заменить, или снимите, чтобы очистить.",
        unpin: "Снять",
        unpinning: "Снятие…",
        runOption: (runId, runName, status) =>
          `${runName ? runName : `Запуск #${runId}`} · ${status}`,
        pinFailed: "Закрепление не удалось",
        unpinFailed: "Снятие не удалось",
      },
      filters: {
        heading: "Фильтры",
        verdictAny: "Любой вердикт",
        verdictAhrefsAny: "Любой вердикт Ahrefs",
        verdictAhrefsLabel: "Вердикт Ahrefs",
        verdictAhrefsHint:
          "Фильтр по агрегированному вердикту 4-х критериев (беклинки/реф.домены/анкоры/ключи).",
        verdictWaybackAny: "Любой вердикт Wayback",
        verdictWaybackLabel: "Вердикт Wayback",
        verdictWaybackNone: "(без вердикта Wayback)",
        verdictWaybackHint:
          "Фильтр по покритериальной оценке судьи Wayback (отдельно от агрегированного итогового балла).",
        verdictWhoisAny: "Любой вердикт Whois",
        verdictWhoisLabel: "Вердикт Whois",
        verdictWhoisNone: "(без вердикта Whois)",
        verdictWhoisHint:
          "Фильтр по диапазону уверенности дропа судьи WHOIS-истории. Stable = чистая история владения; dropped = повторные дропы (осторожно).",
        verdictWhoisStable: "stable (<30%)",
        verdictWhoisInsufficient: "insufficient (30–50%)",
        verdictWhoisMixed: "mixed (>50%)",
        verdictWhoisDropped: "dropped (>80%)",
        availabilityLabel: "Доступность",
        availabilityAny: "Любая доступность",
        availabilityHint:
          "Фильтр по последнему результату проверки доступности (каскад RDAP / Domainr / WHOIS:43). Отдельно от фильтра критериев — доступность не является CR-критерием.",
        availabilityAvailable: "свободен",
        availabilityRegistered: "занят",
        availabilityNotSupported: "не поддерживается",
        availabilityUnknown: "неизвестно",
        availabilityError: "ошибка",
        availabilityNeverChecked: "(не проверялся)",
        languageAny: "Любой язык",
        languageLabel: "Язык",
        languageNone: "(без языка)",
        languageHint:
          "Фильтр по основному языку, определённому wayback_classify (код ISO 639-1).",
        languageSearchPlaceholder: "Поиск языков…",
        categoryAny: "Любая категория",
        categoryLabel: "Категория",
        categoryNone: "(без категории)",
        categoryHint:
          "Фильтр по авто-классифицированной категории сайта (по вашему предопределённому списку в Настройках).",
        categorySearchPlaceholder: "Поиск категорий…",
        verdictPartial: "частично",
        verdictNone: "(без вердикта ИИ)",
        providerAny: "Любой провайдер",
        providerNone: "(без ИИ)",
        modelAny: "Любая модель",
        criterionAny: "Любой критерий",
        criterionLabel: "Критерий",
        cacheAny: "Кэш: любой",
        cacheCached: "Кэш: из кэша",
        cacheFresh: "Кэш: свежие",
        notesAny: "Заметки: любые",
        notesWith: "Заметки: с заметками",
        notesWithout: "Заметки: без заметок",
        pinAny: "Пин: любой",
        pinPinned: "Пин: только закреплённые",
        pinUnpinned: "Пин: только незакреплённые",
        // Source filter (2026-05-17) — см. EN.
        sourceLabel: "Источник",
        sourceAny: "Любой источник",
        sourceSearchPlaceholder: "Поиск источников…",
        // Backlog-status filter (2026-05-20) — см. EN.
        statusLabel: "Статус",
        statusAny: "Любой статус",
        minRecords: "Мин. записей",
        minRecordsHelp:
          "Минимальное число строк в выбранном критерии (последний запуск).",
        waybackConfMin: "Wayback ≥",
        waybackConfMinHelp:
          "Ползунок: минимальная уверенность судьи Wayback. Тащите вправо для более строгого порога; до упора влево — фильтр выключен. Строки без Wayback-вердикта скрываются, как только порог становится больше нуля.",
        ahrefsConfMin: "Ahrefs ≥",
        ahrefsConfMinHelp:
          "Ползунок: минимальная уверенность Итоговой оценки Ahrefs. Тащите вправо для более строгого порога; до упора влево — фильтр выключен. Строки без итоговой оценки (или с частичной) скрываются, как только порог становится больше нуля.",
        confSliderOff: "выкл",
        drMin: "DR ≥",
        drMinHelp:
          "Минимальный Domain Rating. Берётся DR из закреплённого запуска Ahrefs Batch Analysis (если нет — импортированный DR из бэклога). Пусто/0 — выкл; строки без DR скрываются.",
        refDomainsMin: "RD (f) ≥",
        refDomainsMinHelp:
          "Минимум ссылающихся доменов (dofollow) из закреплённого запуска Ahrefs Batch Analysis. Пусто/0 — выкл; строки без метрики скрываются.",
        numMinPlaceholder: "любое",
        // Фильтр циклов whois — см. EN (флип "<N" вместо ">=N").
        whoisCyclesMax: "Циклы whois",
        whoisCyclesMaxHelp:
          "Фильтр по числу циклов владения по whois. <2 = домен никогда не дропался (цикл = 1, стабильная creation_date); <3 = максимум один дроп; <5 = максимум три. Меньше — чище история. Строки без whois-анализа скрываются при любом активном фильтре.",
        whoisCyclesAny: "Любое",
        whoisCyclesLt2: "< 2 (без дропа)",
        whoisCyclesLt3: "< 3 (макс. 1 дроп)",
        whoisCyclesLt4: "< 4 (макс. 2 дропа)",
        whoisCyclesLt5: "< 5 (макс. 3 дропа)",
        maxPriceRange: "Макс $",
        maxPriceMaxHelp:
          "Оставить только строки, у которых Макс. цена из бэклога попадает в этот диапазон USD. Оставьте любое поле пустым, чтобы убрать соответствующую границу. Строки без бэклог-записи или без max_price скрываются, как только заполнено хотя бы одно поле.",
        maxPriceMinPlaceholder: "от",
        maxPriceMaxPlaceholder: "до",
        maxPriceMinAria: "Макс. цена — нижняя граница (USD)",
        maxPriceMaxAria: "Макс. цена — верхняя граница (USD)",
        maxPriceClearAria: "Сбросить фильтр Макс. цены",
        clear: "Очистить фильтры",
        matchedCount: (filtered, total) =>
          `Отфильтровано: ${filtered} из ${total}`,
        matchedCountEmpty: "ни одна строка не подходит под текущие фильтры",
        showTaken: (n) => `Показать занятые (${n})`,
        showTakenHelp:
          "По умолчанию домены, у которых есть только результат Availability-задачи со статусом НЕ available (registered / unknown / error / not supported), скрыты с этой страницы, чтобы массовая проверка доступности её не переполняла. Включите, чтобы показать и их. Домены с любым другим анализом, ручными перепроверками или заметкой не скрываются никогда.",
      },
      verdictSpread: (counts) => {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(counts)) {
          parts.push(`${v}× ${k}`);
        }
        return parts.join(", ");
      },
      runsBadge: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "запусков";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "запуск";
          else if (last1 >= 2 && last1 <= 4) word = "запуска";
        }
        return `${n} ${word}`;
      },
      noVerdict: "—",
      partialBadge: "частично",
      partialTooltip:
        "Частичный результат — хотя бы один критерий упал. Балл не вычислен. Откройте страницу домена и нажмите «Переоценить», чтобы повторить.",
      partialFromCriteria: (crits: string) =>
        `Частично — на основе ${crits}. Зафиксируйте остальные критерии из их запусков, чтобы получить полный вердикт.`,
      // 2026-05-14: partial → split into failed vs underweight.
      failedBadge: "ошибка",
      failedTooltip:
        "Ошибка — один из включённых критериев упал на этапе AI-синтеза. Откройте страницу домена и нажмите «Переоценить», чтобы повторить.",
      underweightBadge: "подмножество",
      underweightTooltip:
        "Подмножество — балл рассчитан по меньшему числу сигналов, чем предполагают веса. Зафиксируйте недостающие критерии из их запусков.",
      underweightMissing: (crits) =>
        `Подмножество — не хватает ${crits}. Зафиксируйте эти критерии из их запусков, чтобы получить балл с полным весом.`,
      noProvider: "без ИИ",
      criteriaCell: (parts) => (parts.length === 0 ? "—" : parts.join(", ")),
      criterionRowCount: (key, rows) => `${key} (${rows})`,
      cachedTag: "из кэша",
      latestRunLink: (jobName) => `Запуск в: ${jobName}`,
      selectAllOnPage: "Выбрать все на этой странице",
      selectedCount: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return `выбрано ${n} ${word}`;
      },
      clearSelection: "Очистить",
      deleteSelected: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return `Удалить ${n} ${word}`;
      },
      deleting: "Удаление…",
      deleteConfirmOne: (domain) =>
        `Окончательно удалить ${domain} и все строки run-domain для него по всем задачам? Действие необратимо.`,
      deleteConfirmMany: (n) =>
        `Окончательно удалить ${n} доменов и все строки run-domain для них по всем задачам? Действие необратимо.`,
      deleteSummary: (rds, runs, jobs) => {
        const parts: string[] = [`Удалено строк доменов: ${rds}`];
        if (runs > 0) parts.push(`пустых запусков: ${runs}`);
        if (jobs > 0) parts.push(`пустых задач: ${jobs}`);
        return parts.join(" · ") + ".";
      },
      refresh: "Обновить",
      refreshing: "Обновление…",
      refreshedAt: (time) => `Обновлено ${time}`,
      exportVisible: (n) => `Экспорт видимых (${n})`,
      exportAll: (n) => `Экспорт всех (${n})`,
      exportVisibleHelp:
        "Скачать CSV строк, которые сейчас подходят под фильтры и поиск.",
      exportAllHelp: "Скачать каждый домен из базы.",
      analyzeSelected: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return `Анализировать ${n} ${word} →`;
      },
      analyzeSelectedHint:
        "Открыть страницу Анализ с этими доменами и включённым кросс-задачным кэшем — Drop Sherlock переиспользует данные Ahrefs и вердикты ИИ из любого прошлого запуска, чьи критерии совпадают. Выберите критерии для (пере)запуска на странице Анализ.",
      bulkReanalyzeShow: (n) => `Переоценить ${n}…`,
      bulkReanalyzeHide: "Скрыть переоценку",
      bulkReanalyzePickerLabel: "ИИ:",
      bulkReanalyzeSubmit: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return `Переоценить ${n} ${word}`;
      },
      bulkReanalyzeRunning: "Отправка…",
      bulkReanalyzeResult: (started, skipped) =>
        skipped === 0
          ? `Запущено: ${started}.`
          : `Запущено: ${started}, пропущено: ${skipped} (уже выполняются или не настроен ИИ).`,
    },
    settings: {
      title: "Настройки",
      intro:
        "Настройте учётные данные Ahrefs и AI-провайдеров, проверьте подключения и подкрутите лимиты запросов.",
      sections: {
        providers: "Провайдеры",
        rateLimits: "Лимиты запросов",
        scoring: "Веса итогового балла и пороги",
        pricing: "Цены AI-моделей",
        waybackClassify: "Классификация Wayback (язык + тематика + категория)",
        prompts: "Промпты ИИ",
        classifyContext: "Wayback classify → судьи Ahrefs (контекст сайта)",
      },
      tabs: {
        api: "API",
        brain: "Мозг",
        wayback: "Классификация Wayback",
        availability: "Доступность домена",
        whoisHistory: "История Whois",
        domainFilter: "Фильтр доменов",
        others: "Прочее",
      },
      domainFilter: {
        heading: "Фильтр доменов",
        intro:
          "Блокирует домены при импорте в очередь. Сейчас фильтруются страновые домены; со временем сюда добавятся другие категории.",
        bulkOpen: "Массовая вставка",
        bulkClose: "Скрыть вставку",
        bulkHint:
          "Одна запись на строку или через запятую. Пробелы и ведущие точки игнорируются.",
        bulkAdd: "Добавить в фильтр",
        bulkAdding: "Добавление…",
        add: "Добавить",
        adding: "Добавление…",
        empty: "Пока пусто — домены не фильтруются, пока вы не добавите хотя бы одну запись.",
        clearAll: "Очистить",
        confirmClear:
          "Удалить все записи в этой категории? Это действие необратимо.",
        noCategories: "Категории фильтра не настроены.",
        removeAria: (v: string) => `Удалить ${v}`,
        fallbackBody:
          "Домены, совпадающие с любой из записей, пропускаются при импорте в очередь.",
        categories: {
          cctld: {
            title: "Страновые TLD (ccTLD)",
            body: "Исключает только домены, у которых TLD из списка И ровно два уровня — `example.uk` будет отфильтрован, а `example.co.uk` и `bbc.co.uk` пройдут (открытые SLD под ccTLD остаются регистрируемыми).",
            placeholder: "uk, de, fr",
            hint: "Только метка TLD (без ведущей точки), в нижнем регистре. Enter — добавить.",
          },
        },
      },
      whoisHistory: {
        heading: "История Whois (выявление дропов)",
        intro:
          "Запросы исторических WHOIS через выбранный провайдер. ИИ-судья читает структурированный diff (изменения creation_date, EPP-статусы из drop-pipeline, пробелы покрытия, смену владельца/email/организации) и выдаёт уверенность «дроп vs трансфер». Запускайте ПЕРЕД пиллар «Качество» — домены с высокой уверенностью дропа могут пропустить Wayback + Ahrefs.",
        providerLabel: "Провайдер",
        providerHint: "Сегодня поддерживается только WhoisFreaks; больше — позже.",
        apiKeyLabel: "API-ключ",
        apiKeyHint:
          "Шифруется на хранении. Сохранённое значение никогда не возвращается — оставьте поле пустым, чтобы сохранить текущий ключ, введите новое значение, чтобы заменить, или ничего не вводите и нажмите «Очистить», чтобы удалить.",
        apiKeyStored: "(сохранён — оставьте пустым, чтобы оставить)",
        apiKeyMissing: "(пока не задан)",
        saveApiKey: "Сохранить ключ",
        clearApiKey: "Очистить ключ",
        maxRecordsLabel: "Максимум исторических записей",
        maxRecordsHint:
          "Ограничение на число снимков, хранимых для одного домена. Оставляются N последних (плотность drop-сигналов выше у недавних). Диапазон: 1–500.",
        coverageGapLabel: "Порог пробела покрытия (дни)",
        coverageGapHint:
          "Дни «без снимков» между последовательными записями, которые diff-вычислитель считает жёстким drop-сигналом. Ниже этого значения преобладает обычная вариация частоты опроса. Диапазон: 1–365.",
        dropThresholdLabel: "Порог уверенности «дроп»",
        dropThresholdHint:
          "Вердикты ИИ с dropped_confidence ≥ этого значения получают зелёный чип «высокая уверенность: дроп» в интерфейсе и попадают в фильтр массового действия «отправить прошедших в Качество». Диапазон: 0–1.",
        unitsPerRequestLabel: "Юнитов за запрос (тариф)",
        unitsPerRequestHint:
          "Сколько юнитов WhoisFreaks стоит один запрос исторического WHOIS против месячной квоты вашего плана. Free = 1; платные тарифы — 2 и более. Сверьтесь с дашбордом WhoisFreaks. Диапазон: 1–100.",
        testLabel: "Проверка соединения",
        testHint:
          "Живой запрос — получает историю одного домена через выбранного провайдера и показывает результат тут же. Стоит 1 запрос (несколько центов).",
        testButton: "Проверить",
        testing: "Проверка…",
        testTooltip: "Запросить провайдера с этим доменом",
        testNeedsKey: "Сначала сохраните API-ключ.",
        testOk: (count, domain) =>
          `OK — найдено ${count} историческ${count === 1 ? "ая запись" : "их записей"} для ${domain}.`,
        testOkHint: (provider) =>
          `через ${provider}. Предпросмотр последнего снимка ниже.`,
        testNoRecords: (domain) =>
          `Авторизация прошла, но истории для ${domain} нет.`,
        testNoRecordsHint:
          "Провайдер ответил успешно, но без записей. Попробуйте более долгоживущий домен (например, google.com), чтобы убедиться, что интеграция работает end-to-end.",
        testFailed: "Проверка не удалась",
        testFailedHint:
          "Самые частые причины: неверный API-ключ, исчерпана квота плана, проблема с сетью. Текст ошибки указан выше дословно.",
        rateLimitsHeading: "Ограничения частоты",
        rateLimitsHint:
          "Лимиты применяются к каждому запросу WhoisFreaks (кнопка «Проверить», runner, проверки в панели). Ставьте НИЖЕ потолка вашего плана — всплески выше лимита приводят к HTTP 429. По умолчанию настроено под бесплатный тариф; поднимайте, когда подтвердите реальный лимит плана.",
        rpmLabel: "Запросов в минуту",
        maxConcurrentLabel: "Максимум одновременно",
      },
      othersEmpty: "Пока здесь нет настроек.",
      importLimit: {
        heading: "Лимит строк CSV-импорта в очередь",
        intro:
          "Максимум строк, принимаемых за один CSV-импорт. Мастер обрезает файлы крупнее этого перед отправкой; если обойти мастер — вернётся 413. Поднимите для больших аукционных списков; снизьте, если случайно вставляете огромные таблицы.",
        currentLabel: "Макс. строк:",
        unit: "строк",
        save: "Сохранить",
        saving: "Сохранение…",
        savedAt: (when) => `Сохранено ${when}`,
        loadFailed: "Не удалось загрузить лимит импорта.",
        saveFailed: "Сохранение не удалось.",
        notANumber: "Введите целое число.",
        outOfRange: (min, max) => `Должно быть от ${min} до ${max}.`,
        boundsHint: (min, max) => `допустимо: ${min}–${max}`,
      },
      retention: {
        heading: "Хранение журнала ошибок",
        intro:
          "Авто-удаление отклонённых ошибок старше выбранного окна. Открытые ошибки никогда не чистятся автоматически — устаревают только те, которые вы явно отклонили. Очистка также удаляет исходный traceback из строки-источника (данные анализа сохраняются).",
        currentLabel: "Авто-удалять отклонённые ошибки через:",
        optionDays: (n) => `${n} дней`,
        optionNever: "Никогда",
        save: "Сохранить",
        saving: "Сохранение…",
        savedAt: (when) => `Сохранено ${when}`,
        loadFailed: "Не удалось загрузить настройку хранения.",
        saveFailed: "Сохранение не удалось.",
      },
      backups: {
        heading: "Бэкапы базы",
        intro:
          "Локальные снимки SQLite через online-backup API (без блокировки записи). Старые снимки сверх лимита хранения удаляются автоматически. Расписание и хранение настраиваются переменными окружения — DROP_SHERLOCK_BACKUP_INTERVAL_HOURS / DROP_SHERLOCK_BACKUP_KEEP / DROP_SHERLOCK_BACKUP_ENABLED в .env. Загрузка вне коробки (S3/B2/R2) настраивается ниже и запускается после каждого локального снимка.",
        statusLabel: "Статус",
        statusEnabled: "По расписанию",
        statusDisabled: "Отключено",
        intervalLabel: "Интервал",
        intervalHoursValue: (n) =>
          n === 1 ? "каждый 1 час" : `каждые ${n} ч`,
        keepLabel: "Хранить",
        keepValue: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          let word = "снимков";
          if (last2 < 11 || last2 > 14) {
            if (last1 === 1) word = "снимок";
            else if (last1 >= 2 && last1 <= 4) word = "снимка";
          }
          return `${n} ${word}`;
        },
        dirLabel: "Папка",
        unsupported:
          "Текущая база — не SQLite, встроенный бэкап отключён. Используйте pg_dump (или снимки вашего провайдера) отдельным cron.",
        runNow: "Сделать бэкап сейчас",
        runningLabel: "Бэкап…",
        refresh: "Обновить",
        snapshotsHeading: "Снимки",
        empty:
          "Снимков пока нет — нажмите «Сделать бэкап сейчас» или дождитесь расписания.",
        cols: { filename: "Файл", size: "Размер", created: "Создан" },
        loadFailed: "Не удалось загрузить статус бэкапов.",
        restore: {
          button: "Восстановить",
          buttonHint:
            "Заменить текущую базу данных этим снимком. Перед заменой автоматически делается страховочный снимок текущего состояния.",
          modalTitle: "Восстановление базы из снимка",
          fileLabel: "Файл",
          sizeLabel: "Размер",
          createdLabel: "Создан",
          warning:
            "Это заменит всю текущую базу данных содержимым снимка. Действие обратимо — прямо перед восстановлением автоматически создаётся страховочный снимок текущего состояния. Восстановление будет отклонено, если идут запуски (сначала поставьте на паузу или отмените их).",
          ackLabel:
            "Я понимаю, что текущая база будет заменена.",
          confirmButton: "Восстановить",
          restoring: "Восстановление…",
          successBanner: (from, prerestore) =>
            `Восстановлено из ${from}. Страховочный снимок текущего состояния сохранён как ${prerestore} — восстановите его, чтобы откатить.`,
          failPrefix: "Восстановление не удалось",
          prerestoreBadge: "страховочный",
          prerestoreHint:
            "Страховочный снимок, создаётся автоматически перед восстановлением. По умолчанию хранятся 7 последних (настраивается через DROP_SHERLOCK_PRERESTORE_KEEP).",
        },
        download: {
          button: "Скачать",
          buttonHint:
            "Скачать этот снимок на ваш компьютер для офлайн-копии. Файл стримится напрямую — без буферизации в памяти.",
        },
        deleteRow: {
          button: "Удалить",
          buttonHint:
            "Безвозвратно удалить этот снимок с сервера. Действие нельзя отменить.",
          confirm: (filename) =>
            `Удалить ${filename}? Место освободится немедленно, действие необратимо. Другие снимки не затрагиваются.`,
          done: (filename) => `Удалено: ${filename}.`,
          failed: "Удаление не удалось",
        },
        upload: {
          heading: "Импорт бэкапа из файла",
          intro:
            "Загрузите снимок .db.gz с вашего компьютера и восстановите рабочую базу из него. Загруженный файл сохраняется в каталог снимков (появится в списке ниже и сможет быть восстановлен повторно), учитывается ротацией. Страховочный снимок текущей базы создаётся автоматически — операция обратима.",
          uploadAndRestore: "Загрузить и восстановить",
          uploading: "Загрузка…",
          modalTitle: "Восстановление базы из загруженного файла",
          warning:
            "Это полностью заменит текущую базу содержимым загруженного снимка. Операция обратима — прямо перед восстановлением создаётся страховочный снимок текущего состояния. Восстановление отклоняется, пока есть незавершённые запуски (сначала поставьте на паузу или отмените их).",
          successBanner: (imported, prerestore) =>
            `Восстановлено из загруженного файла (сохранён как ${imported}). Страховочный снимок текущего состояния сохранён как ${prerestore} — восстановите его, чтобы откатить.`,
          failPrefix: "Импорт/восстановление не удалось",
        },
        remote: {
          heading: "Удалённая загрузка (S3-совместимо)",
          intro:
            "После каждого локального снимка опционально загружать .db.gz в S3-совместимое хранилище (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO). На локальную ротацию не влияет — если загрузка не удалась, локальный снимок всё равно остаётся. Сохраните конфигурацию и нажмите «Тест подключения», чтобы проверить до первого автозапуска.",
          enabledLabel: "Включено",
          providerLabel: "Метка провайдера",
          providerHint:
            "Свободная подпись для UI — например «Backblaze B2 / еженедельно».",
          endpointLabel: "Endpoint URL",
          endpointHint:
            "Пусто для AWS S3. Для B2: https://s3.<region>.backblazeb2.com. Для R2: https://<account-id>.r2.cloudflarestorage.com.",
          regionLabel: "Регион",
          regionHint:
            "Обязательно для AWS S3. Для B2/R2/MinIO — то, что ожидает ваш провайдер (часто «auto» для R2).",
          bucketLabel: "Бакет",
          bucketHint: "Бакет должен уже существовать; мы его не создаём.",
          accessKeyLabel: "Access key ID",
          secretKeyLabel: "Secret access key",
          secretsHint:
            "Хранится в локальной БД. Перевводить нужно только при смене — оставьте пусто, чтобы сохранить текущее.",
          prefixLabel: "Префикс (опционально)",
          prefixHint:
            "Путь внутри бакета. Например «drop-sherlock/» для разделения с другими приложениями.",
          testBtn: "Тест подключения",
          testOk: (bucket) => `Подключение к бакету «${bucket}» работает.`,
          testFail: "Подключение не удалось",
          notSet: "Не задано",
          unchangedHint: "пусто = оставить как есть",
          charsSuffix: "симв",
        },
      },
      waybackClassify: {
        intro:
          "Настройки для критерия wayback_classify (страница Анализ → Язык + тематика + категория). Категории используются цепочечной AI-классификацией, которая запускается после определения тематики.",
        languageModeHeading: "Режим определения языка",
        languageModeIntro:
          "Как извлекать основной язык из сэмплов страниц Wayback. Оба режима выдают коды ISO 639-1, чтобы фильтр по языку в Базе работал независимо от режима.",
        languageModeOptions: {
          ai: {
            label: "ИИ (общий промпт)",
            help: "Один AI-вызов возвращает и язык, и тематику. Быстрее, но язык бывает нестабильным на коротком тексте на не-латинице.",
          },
          library: {
            label: "Библиотека (lingua-language-detector)",
            help: "Lingua детерминированно агрегирует основной язык по тексту сэмплов. Тематика затем определяется ИИ отдельно. Надёжнее на коротком тексте.",
          },
        },
        categoriesHeading: "Предопределённые категории",
        categoriesIntro:
          "Шаг AI-категоризации выбирает одну категорию по имени из этого списка. Когда ничего не подходит, выводится «other». Описания опциональны, но помогают модели сопоставлять семантически (а не только по совпадению ключевых слов). Категории сохраняются по алфавиту.",
        empty: "Категорий пока нет. Добавьте ниже или вставьте список массово.",
        addNameLabel: "Название",
        addNamePlaceholder: "напр. E-commerce",
        addDescLabel: "Описание (опционально)",
        addDescPlaceholder:
          "напр. Онлайн-ритейл / корзины / каталоги товаров",
        add: "Добавить",
        addBusy: "Добавление…",
        bulkOpen: "Массовая вставка…",
        bulkClose: "Закрыть массовую вставку",
        bulkHint:
          "По одной категории в строке. Опциональное описание после `|` или `,` (напр. `Casino | сайты гемблинга`). Существующие категории с тем же именем сохраняются (описания заполняются только пустые).",
        bulkPlaceholder:
          "Casino | сайты гемблинга и букмекеры\nE-commerce | онлайн-ритейл\nBlog | личные или редакционные",
        bulkAdd: "Добавить все",
        bulkAdding: "Добавление…",
        colName: "Название",
        colDescription: "Описание (опционально)",
        descPlaceholder:
          "Кликните, чтобы добавить описание (сохраняется при потере фокуса или Enter)",
        remove: "Удалить",
        confirmDelete: (name) => `Удалить категорию «${name}»?`,
      },
      pricing: {
        help:
          "Тарифы по токенам на (провайдер, модель) в $ за 1М токенов. Используются для расчёта пилюли «Стоимость» на каждой странице запуска. Стоимость фиксируется в момент каждого AI-вызова — правка строки здесь влияет только на будущие вызовы. Строки авто-создаются для каждой модели в реестре; заполните тарифы со страницы цен провайдера.",
        empty:
          "В реестре пока нет моделей. Добавьте модели в Провайдерах, потом возвращайтесь сюда задать цены.",
        cols: {
          provider: "Провайдер",
          model: "Модель",
          inputRate: "Вход $/1M",
          outputRate: "Выход $/1M",
        },
        save: "Сохранить",
        delete: "Удалить",
        deleteConfirm: (provider, model) =>
          `Удалить цену для ${provider} / ${model}? Будущие вызовы по этой модели будут записывать стоимость = 0, пока строку не вернут.`,
        errInvalid: "Оба тарифа должны быть неотрицательными числами.",
      },
      classifyContext: {
        intro:
          "Когда включено, судьи Ahrefs (Беклинки / Анкоры / Органические ключевые слова по умолчанию) получают блок «Контекст сайта», собранный из вердикта Wayback classify по этому домену (тематика, категория, язык). Помогает AI отмечать PBN-подобные несоответствия тематик — например, беклинки с гэмблинг-доменов на сайт о домашних животных.",
        masterToggle: "Передавать контекст Wayback classify судьям Ahrefs",
        criteriaHeading: "Какие судьи получают контекст",
        criteriaHelp:
          "Реф. домены отключены по умолчанию — без анкоров и окружающих сниппетов вывод тематики на строке домена часто галлюцинирует.",
        fieldsHeading: "Какие поля classify включать",
        fieldsHelp:
          "Названия полей совпадают с формой вердикта wayback_classify. Пустые/отсутствующие поля пропускаются во время выполнения.",
        cacheNote:
          "Изменение критериев или полей сбрасывает кэш AI-вердиктов для затронутых критериев. Следующий проход судейства пересчитает AI.",
        criterionNames: {
          backlinks: "Беклинки",
          refdomains: "Реф. домены",
          anchors: "Анкоры",
          keywords: "Органические ключевые слова",
        },
        save: "Сохранить",
        saving: "Сохранение…",
        resetDefaults: "Сбросить к значениям по умолчанию",
        savedAt: (when) => `Сохранено: ${when}`,
      },
      scoring: {
        intro:
          "Настройте, как покритериальные вердикты ИИ сворачиваются в итоговый балл 0–100, где проходят границы корзин и когда пилюля сереет из-за низкой уверенности.",
        weightsHeading: "Веса по критериям",
        weightsHelp:
          "Перенормируются по включённым критериям — напр. если работают только Беклинки + Анкоры, их веса перешкалируются, чтобы балл всё равно покрывал 15–85.",
        weightsTotal: (sum) =>
          sum === 1
            ? `Сумма: ${sum} ✓`
            : `Сумма: ${sum} (равняться 1 необязательно; раннер перенормирует).`,
        bucketsHeading: "Пороги корзин",
        bucketsHelp:
          "Балл ≥ хорошо → зелёная пилюля. Балл ≥ смешанно (но < хорошо) → янтарная. Ниже смешанно → красная.",
        goodThreshold: "Хорошо ≥",
        mixedThreshold: "Смешанно ≥",
        lowConfHeading: "Порог низкой уверенности",
        lowConfHelp:
          "Когда средняя уверенность ИИ (0–1) падает ниже этого, пилюля балла рендерится серой независимо от корзины — визуальное предупреждение, что вердикту нельзя доверять.",
        lowConfThreshold: "Серить, когда уверенность <",
        save: "Сохранить",
        saving: "Сохранение…",
        resetDefaults: "Сбросить к умолчаниям",
        savedAt: (when) => `Сохранено ${when}`,
      },
      prompts: {
        intro:
          "Системные промпты, которыми ИИ оценивает каждый критерий и итоговую оценку. Редактируйте под стандарты качества вашей команды. «Сбросить» возвращает к промпту из коробки.",
        labels: {
          backlinks: "Судья беклинков",
          refdomains: "Судья ссылающихся доменов",
          anchors: "Судья анкоров",
          keywords: "Судья органических ключей",
          wayback: "Судья истории Wayback",
          wayback_classify_combined:
            "Wayback classify — общий язык + тематика (режим ИИ)",
          wayback_classify_theme_only:
            "Wayback classify — только тематика (режим библиотеки)",
          wayback_category: "Wayback classify — классификация категории",
          whois_history_judge:
            "Судья Whois History (дроп vs трансфер — Волна 2)",
          final: "Итоговая оценка Ahrefs",
          localize_ru:
            "Директива русского вывода (добавляется к каждому промпту в RU-запусках)",
        },
        custom: "Кастомизирован",
        default: "По умолчанию",
        save: "Сохранить",
        reset: "Сбросить к умолчанию",
        resetConfirm: "Сбросить этот промпт к версии из коробки?",
      },
      providerNames: {
        ahrefs: "Ahrefs",
        gemini: "Google Gemini",
        github_models: "GitHub Models",
        openrouter: "OpenRouter",
        vertex_ai: "Google Vertex AI",
      },
      providerHelp: {
        ahrefs:
          "Ключ Ahrefs API v3. Используется Site Explorer для получения беклинков, ссылающихся доменов, анкоров и органических ключей по доменам.",
        gemini:
          "Ключ Google AI Studio API. Модель по умолчанию используется, если на странице Анализ модель не выбрана явно.",
        github_models:
          "GitHub PAT со скоупом `models:read`. ID моделей — на github.com/marketplace/models.",
        openrouter:
          "Ключ OpenRouter API. Модель по умолчанию — слаг с openrouter.ai/models, напр. `anthropic/claude-3.5-sonnet`.",
        vertex_ai:
          "Google Vertex AI. Вставьте JSON сервис-аккаунта для enterprise-режима (использует ваш проект и регион GCP) ИЛИ только API-ключ для режима Vertex Express. JSON сервис-аккаунта имеет приоритет, если заданы оба.",
      },
      fieldLabels: {
        api_key: "API-ключ",
        token: "Токен",
        default_model: "Модель по умолчанию",
        service_account_json: "JSON сервис-аккаунта",
        project_id: "Project ID",
        location: "Регион",
      },
      fieldPlaceholders: {
        api_key: "Вставьте API-ключ…",
        token: "Вставьте токен…",
        default_model: "напр. gemini-2.5-flash",
        service_account_json:
          '{ "type": "service_account", "project_id": "...", "private_key": "...", "client_email": "...", ... }',
        project_id: "my-gcp-project",
        location: "us-central1",
      },
      savedSecret: (last4, length) =>
        `Сохранено: ••••${last4} (${length} симв.)`,
      savedValue: (value) => `Сохранено: ${value}`,
      notSet: "Не задано",
      clearConfirm: (provider) =>
        `Очистить все сохранённые учётные данные для ${provider}?`,
      modelDropdownPlaceholder: "Выберите модель…",
      modelDropdownEmpty: "В реестре нет моделей — добавьте ниже.",
      modelRegistry: {
        heading: "Известные модели",
        count: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          let word = "моделей";
          if (last2 < 11 || last2 > 14) {
            if (last1 === 1) word = "модель";
            else if (last1 >= 2 && last1 <= 4) word = "модели";
          }
          return `${n} ${word}`;
        },
        empty: "Моделей пока нет. Добавьте ниже или вставьте список.",
        defaultBadge: "по умолчанию",
        defaultTooltip: "Сейчас по умолчанию для этого провайдера",
        makeDefault: "Сделать по умолчанию для этого провайдера",
        remove: "Удалить из реестра",
        addSingle: "+ Добавить",
        adding: "Добавление…",
        singlePlaceholder: "id модели (напр. gemini-2.5-flash)",
        bulkToggle: "Массовая вставка…",
        bulkPlaceholder:
          "Вставьте id моделей — по одному в строке или через запятую.\nСуществующие записи сохраняются (дедуп).",
        bulkHelp:
          "Объединяется с существующим списком (дедуп, порядок сохраняется).",
        mergeCount: (n) => {
          const last2 = n % 100;
          const last1 = n % 10;
          let word = "моделей";
          if (last2 < 11 || last2 > 14) {
            if (last1 === 1) word = "модель";
            else if (last1 >= 2 && last1 <= 4) word = "модели";
          }
          return `+ Объединить ${n} ${word}`;
        },
        merging: "Объединение…",
      },
      testOk: "Подключение работает.",
      testFail: "Подключение не удалось",
      rateLimitFields: {
        rpm: "Запросов в минуту",
        max_concurrent: "Макс. параллельно",
        retry_max: "Макс. повторов",
      },
      rateLimitsHelp:
        "Применяется на провайдера во время выполнения задачи. Строка Ahrefs также ограничивает, сколько доменов параллельно тянутся в одной задаче.",
    },
    errors: {
      title: "Ошибки",
      intro:
        "Все ошибки, пойманные в приложении — провалы вердиктов ИИ, ошибки Ahrefs API, провалы запусков / доменов и непойманные исключения бэкенда. Отклоняйте те, что обработали; если строка-источник позже выдаст другую ошибку, она авто-восстановится.",
      refresh: "Обновить",
      refreshing: "Обновление…",
      exportVisible: (n) => `Экспорт видимых (${n})`,
      exportAll: (n) => `Экспорт всех (${n})`,
      exportSelected: (n) => `Экспорт выбранных (${n})`,
      exportVisibleHint:
        "Скачать CSV строк, сейчас подходящих под фильтры категории + статуса + поиска (по всем страницам).",
      exportAllHint:
        "Скачать каждую ошибку из базы, игнорируя фильтры.",
      tabs: {
        all: "Все",
        ai: "AI",
        ahrefs: "Ahrefs",
        wayback: "Wayback",
        domain: "Домен",
        run: "Запуск",
        backend: "Backend",
      },
      statusOpen: (n) => `Открытые (${n})`,
      statusDismissed: (n) => `Отклонённые (${n})`,
      statusAll: (n) => `Все (${n})`,
      empty: "Нет ошибок, подходящих под текущие фильтры.",
      cols: {
        category: "Категория",
        when: "Когда",
        message: "Сообщение",
        context: "Контекст",
        actions: "Действия",
      },
      openSource: "Открыть источник →",
      expandHint: "Кликните, чтобы развернуть полное сообщение + traceback.",
      dismiss: "Отклонить",
      restore: "Восстановить",
      delete: "Удалить",
      deleteLogHint:
        "Окончательно удалить эту строку лога. Доступно только для ошибок, пойманных бэкендом (источники без нижележащей строки домена/запуска, на которую можно сослаться).",
      confirmDeleteLog: "Окончательно удалить эту строку лога?",
      selectedCount: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "ошибок";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "ошибка";
          else if (last1 >= 2 && last1 <= 4) word = "ошибки";
        }
        return `выбрано ${n} ${word}`;
      },
      selectAllOnPage: "Выбрать все на этой странице",
      clearSelection: "Очистить",
      bulkDismiss: (n) => `Отклонить ${n}`,
      bulkDismissing: "Отклонение…",
      confirmBulkDismiss: (n) =>
        `Отклонить ${n} выбранных ошибок? У уже отклонённых обновится метка времени.`,
    },
    availability: {
      statusAvailable: "свободен",
      statusRegistered: "занят",
      statusUnknown: "неизвестно",
      statusError: "ошибка",
      statusNotSupported: "не поддерживается",
      checkedAt: (when: string) => `проверено ${when}`,
      expiresOn: (date: string) => `истекает ${date}`,
      registrar: (name: string) => `регистратор: ${name}`,
      sourceProvider: (p: string) => `источник: ${p}`,
      recheck: "Проверить",
      rechecking: "Проверка…",
      bulkRecheck: (n: number) => `Проверить доступность (${n})`,
      bulkRecheckRunning: "Проверка…",
      analyzeBoxTitle: "Доступность домена",
      analyzeBoxHint:
        "Проверять регистрационный статус каждого домена перед Ahrefs/Wayback. Настройки → Доступность домена управляют провайдерами, лимитами и политикой «пропускать зарегистрированные».",
      analyzeBoxToggle: "Проверять доступность перед анализом",
      settingsTabTitle: "Доступность домена",
      settingsProvidersHeading: "Провайдеры",
      settingsCascadeHeading: "Порядок каскада",
      settingsCascadeHint:
        "Провайдеры опрашиваются по очереди. Отключённые пропускаются. RDAP — авторитетный источник для .com / .net / .org; Domainr (RapidAPI) — платная подстраховка; WHOIS — последний резерв для TLD без RDAP.",
      settingsRateLimitsHeading: "Лимиты",
      settingsRateLimitsHint:
        "Жёсткий потолок: 10 запросов/сек на провайдера независимо от значения ниже.",
      settingsSkipHeading: "Политика «пропускать зарегистрированные»",
      settingsSkipHint:
        "Когда ВКЛ, зарегистрированные домены с истечением дальше горизонта ниже пропускаются при анализе — экономит юниты Ahrefs. Домены, скоро освобождающиеся, проходят анализ.",
      settingsCacheHeading: "TTL кэша (часов)",
      settingsCacheHint:
        "Использовать кэшированный результат проверки в этом окне. Охотникам за дропами с близкими датами выпадения может понадобиться 1 час вместо 24.",
      settingsRetentionHeading: "Хранение недавних проверок",
      settingsRetentionHint:
        "Ограничивает рост таблицы availability_checks. Ежедневная очистка + одноразовый проход при перезапуске контейнера. По умолчанию: 30 дней, 20 строк на домен. Поставьте 0 в любом поле, чтобы отключить этот лимит.",
      settingsRetentionDaysLabel: "Хранить (дней):",
      settingsRetentionDaysHint: "0 = по возрасту не чистить.",
      settingsPerDomainKeepLabel: "На домен оставлять:",
      settingsPerDomainKeepHint: "0 = без лимита (в пределах окна по возрасту).",
      settingsApiKeyHeading: "API-ключ Domainr (RapidAPI)",
      settingsApiKeyHint:
        "Бесплатный Basic-тариф на RapidAPI даёт 10 000 запросов/мес. Шифруется в БД.",
      settingsStatsHeading: "Использование в этом месяце",
      settingsRecentHeading: "Недавние проверки",
      errorCatDns: "DNS",
      errorCatRdap: "RDAP",
      errorCatDomainr: "Domainr",
      errorCatWhois: "WHOIS",
      errorCatQuota: "Квота",
      errorCatNetwork: "Сеть",
      errorCatParse: "Разбор",
    },
    banlist: {
      title: "Бан-лист",
      hint:
        "Постоянный фильтр — домены отсюда молча отклоняются на каждой точке загрузки: импорт в Очередь, действия Order/Discard на странице Базы, цепочка проверки доступности и отправка Анализа. Это не то же самое, что Backlog-статус «discarded» — тот ставится для разовых решений. Существующие строки в Очереди не меняются при добавлении домена в бан-лист — это чисто предварительный фильтр.",
      searchPlaceholder: "Поиск по домену или примечанию…",
      importOpen: "Импорт CSV",
      importClose: "Закрыть импорт",
      importTitle: "Импорт из CSV",
      importHint:
        "Одна строка — один домен. Опциональная вторая колонка = примечание. Пустые строки и строки с # игнорируются. Уже забаненные домены пропускаются (примечание перезаписывается, только если было пустым).",
      importPlaceholder:
        "example.com\nshady-pbn.net, подозрительный анкор-профиль\n# строки с # игнорируются",
      importSubmit: "Импортировать",
      importBusy: "Импорт…",
      importResult: (added, already, invalid) =>
        `Добавлено ${added}, уже было в бане ${already}, некорректных ${invalid}.`,
      loading: "Загрузка…",
      emptyAll: "В бан-листе пока пусто.",
      emptyFiltered: "По текущему поиску забаненных доменов нет.",
      colDomain: "Домен",
      colNote: "Примечание",
      colAnalyses: "Анализы",
      colCreatedAt: "Забанен",
      colActions: "",
      analyses: {
        ahrefs: "Ahrefs",
        wayback: "Wayback",
        whois: "Whois",
        linkHint: (label) =>
          `Открыть анализ ${label} для этого домена — посмотреть, почему он забанен.`,
      },
      unbanOne: "Снять бан",
      unbanSelected: (n) => `Снять бан с ${n}`,
      unbanSelectedConfirm: (n) =>
        `Убрать ${n} доменов из бан-листа? Они снова смогут попасть в анализ и в Очередь через импорт. На существующие записи в Очереди это не влияет.`,
      selectAll: "Выбрать все видимые",
      totalLine: (total, visible, selectedCount) =>
        `${total} забанено · ${visible} видно · ${selectedCount} выбрано`,
    },
    shares: {
      title: "Ссылки для просмотра",
      intro:
        "Ссылки «только просмотр», которые вы создали для отдельных анализов доменов. Любой по ссылке откроет страницу без basic-auth — отзовите ссылку здесь, чтобы немедленно закрыть доступ.",
      statusLabel: "Статус",
      statusOptions: {
        all: "Все",
        active: "Активные",
        revoked: "Отозванные",
        expired: "Истёкшие",
      },
      searchLabel: "Поиск",
      searchPlaceholder: "домен или заметка…",
      perPageLabel: "На страницу",
      refresh: "Обновить",
      bulkRevoke: "Отозвать выбранные",
      revokingPlural: "Отзыв…",
      clearSelection: "Снять выбор",
      revokeAll: "Отозвать все активные",
      revokeAllHint:
        "Аварийная кнопка — отзывает ВСЕ активные ссылки одним кликом. Используйте при подозрении на утечку.",
      revokeAllConfirm:
        "Отозвать ВСЕ активные ссылки? Получатели потеряют доступ немедленно. Действие необратимо — нужны будут новые токены.",
      bulkRevokeConfirm: (n) =>
        `Отозвать ${n} выбранных ссылок? Получатели потеряют доступ немедленно.`,
      bulkRevokeDone: (revoked, requested) =>
        `Отозвано ${revoked} из ${requested}.`,
      bulkRevokeFailed: "Массовый отзыв не удался",
      revokeAllDone: (n) => `Отозвано активных ссылок: ${n}.`,
      revokeOneConfirm:
        "Отозвать эту ссылку? Получатель потеряет доступ немедленно.",
      copied: "Скопировано в буфер обмена.",
      selectedCount: (n) => `Выбрано: ${n}`,
      selectAllAria: "Выбрать все видимые",
      selectAria: (domain) => `Выбрать ссылку для ${domain}`,
      pageInfo: (start, end, total) =>
        `Показано ${start}–${end} из ${total}`,
      prev: "Назад",
      next: "Вперёд",
      empty:
        "Ссылок пока нет. Откройте любую страницу домена и нажмите «Поделиться».",
      never: "Бессрочно",
      cols: {
        domain: "Домен",
        status: "Статус",
        note: "Заметка",
        job: "Задача",
        created: "Создано",
        expires: "Истекает",
        views: "Просмотры",
        actions: "Действия",
      },
      copy: "Скопировать",
      open: "Открыть",
      revoke: "Отозвать",
      activate: "Активировать",
      activateConfirm:
        "Активировать ссылку снова? Получатель снова получит доступ (если срок ещё не истёк). История просмотров сохраняется.",
      hardDelete: "Удалить",
      hardDeleteConfirm:
        "Удалить запись о ссылке безвозвратно? История (просмотры, IP создателя) будет потеряна. Если важна история — используйте Отозвать.",
      deleteRevoked: "Удалить отозванные",
      deleteRevokedConfirm: (n) =>
        n > 0
          ? `Безвозвратно удалить ${n} отозванных ссылок? История просмотров будет потеряна. Активные ссылки не затрагиваются.`
          : "Безвозвратно удалить ВСЕ отозванные ссылки? История просмотров будет потеряна. Активные ссылки не затрагиваются.",
      deleteRevokedHint:
        "Удалить безвозвратно все отозванные ссылки. История (просмотры, IP) будет потеряна. Активные ссылки не затрагиваются.",
      deleteRevokedDone: (n) => `Удалено отозванных ссылок: ${n}.`,
      deleteRevokedFailed: "Удаление отозванных не удалось",
      hardDeleteFailed: "Удаление не удалось",
      activateFailed: "Активация не удалась",
      settings: {
        title: "Настройки по умолчанию",
        toggle: "Настройки по умолчанию",
        intro:
          "Значения по умолчанию для новых ссылок. Поставьте 0, чтобы по умолчанию ссылки были бессрочными.",
        defaultExpiresLabel: "Срок действия по умолчанию (дней)",
        defaultExpiresHint:
          "Применяется, когда срок не выбран явно. 0 = бессрочно (рекомендуется для внутренних ссылок). Максимум: 3650 дней (10 лет).",
        save: "Сохранить",
        saving: "Сохранение…",
        saved: "Сохранено.",
        reset: "Сбросить к значениям по умолчанию",
        resetConfirm: "Сбросить настройки ссылок к стандартным значениям?",
        currentDefault: (days) =>
          days === 0
            ? "Сейчас: бессрочно (никогда не истекает)."
            : `Сейчас: ${days} дней с момента создания.`,
      },
    },
    share: {
      viewOnlyBadge: "Drop Sherlock — общий анализ (только просмотр)",
      sharedOn: "Создано",
      expiresOn: "истекает",
      finalAssessment: "Итоговая оценка",
      verdictLabel: "Вердикт",
      confidenceLabel: "Уверенность",
      recommendationLabel: "Рекомендация",
      notesHeading: "Заметки",
      footer:
        "Это снимок анализа одного домена «только для просмотра». Сделано в Drop Sherlock.",
      notFoundTitle: "Ссылка не найдена",
      notFound:
        "Эта ссылка больше недействительна. Возможно, она отозвана, истекла или никогда не существовала.",
    },
    pillarStub: {
      comingSoon: "Скоро — этот раздел пока не запущен.",
      wave2:
        "Запланировано во Волне 2: интеграция WhoisFreaks Historical WHOIS API + ИИ-судья для выявления дропов.",
      wave3:
        "Запланировано во Волне 3: вывести существующий каскад доступности (RDAP / Domainr / WHOIS:43) в отдельный тип Job, чтобы можно было запускать проверки доступности как самостоятельные задачи (сейчас это под-шаг в Quality-запусках и кнопка на строке Очереди).",
      architectureNote:
        "Дерево Job → Run → Domain, кеш, пагинация, архив, заметки, пин, экспорт и поиск уже на месте — каждому разделу остаётся только добавить kind-специфичный runner и UI.",
      useQuality: "Перейти в раздел Качество",
    },
    checkWhoisHistory: {
      title: "Проверка — История Whois",
      subtitle:
        "Анализ исторических WHOIS-записей для выявления дропов. Каждый домен — один запрос к провайдеру (получение записей, вычисление diff) и один вердикт ИИ (дроп vs трансфер, с уверенностью и ключевыми сигналами). Запускайте ПЕРЕД пиллар «Качество», чтобы пропустить Wayback и Ahrefs для доменов, которые точно не дропались.",
      pipelineHint:
        "Перед большими задачами настройте ключ провайдера и лимиты частоты в Настройки → История Whois.",
      labelHeading: "Метка задачи",
      labelHint:
        "Необязательно — по умолчанию `<первый-домен> +N ещё · <yyyy-mm-dd HH:MM>`.",
      nameLabel: "Название",
      namePlaceholder: "напр. drop-watch партия 2026-05",
      notesLabel: "Заметки",
      notesPlaceholder: "Зачем проверяем?",
      submit: "Запустить проверку Whois history",
      submitting: "Отправка…",
      settingsLink: "Открыть настройки Whois",
      summary: (n) => `${n} домен${n === 1 ? "" : ""} готов${n === 1 ? "" : "ы"} к запуску`,
      skippedBanned: (n) =>
        `Пропущено забаненных доменов: ${n}.`,
      allBannedError: (count, sample, truncated) =>
        `Все указанные домены в бан-листе (${count} всего): ${sample}${
          truncated ? "…" : ""
        }`,
      // Баннер перезапуска (добавлено 2026-05-21).
      rerunBannerTitle: "Перезапуск",
      rerunBannerCancel: "Отменить перезапуск",
      rerunBannerHelp:
        "Будет добавлен новый Run в эту задачу. Отредактируйте список доменов или AI-провайдер и нажмите отправить.",
    },
    checkAvailability: {
      title: "Доступность",
      subtitle:
        "Запустить каскад проверки доступности доменов (RDAP → Domainr → WHOIS:43) для списка доменов. На каждый домен создаётся одна CriterionResult-запись с итоговым статусом и трассой по провайдерам.",
      pipelineHint:
        "ИИ не используется — каскад выдаёт детерминированный вердикт. Порядок каскада, тумблеры провайдеров, RPS/конкуренция и TTL живут в Настройках → Доступность. Этот запуск всегда берёт свежее состояние; кнопки «Перепроверить» в /database и /backlog продолжают использовать кэш.",
      labelHeading: "Метка задачи",
      labelHint:
        "Необязательно. Имя видно в /jobs/availability и на странице задачи; заметка — свободный контекст.",
      nameLabel: "Название",
      namePlaceholder: "Автогенерация по первому домену, если пусто",
      notesLabel: "Заметки",
      notesPlaceholder: "Зачем проверяем?",
      submit: "Запустить проверку доступности",
      submitting: "Отправка…",
      settingsLink: "Открыть настройки Доступности",
      summary: (n) => `${n} домен${n === 1 ? "" : ""} готов${n === 1 ? "" : "ы"} к запуску`,
      skippedBanned: (n) =>
        `Пропущено забаненных доменов: ${n}.`,
      allBannedError: (count, sample, truncated) =>
        `Все указанные домены в бан-листе (${count} всего): ${sample}${
          truncated ? "…" : ""
        }`,
      // Баннер перезапуска (добавлено 2026-05-21).
      rerunBannerTitle: "Перезапуск",
      rerunBannerCancel: "Отменить перезапуск",
      rerunBannerHelp:
        "Будет добавлен новый Run в эту задачу. Отредактируйте список доменов и нажмите отправить.",
    },
    checkAhrefsBatch: {
      title: "Ahrefs Batch Analysis",
      subtitle:
        "Получить текущие метрики Ahrefs /batch-analysis (DR, ссылающиеся домены, бэклинки, органический трафик и ключи) для списка доменов. На каждый домен — одна CriterionResult-запись с выбранными метриками. Выдерживает 100 000 доменов — выборка партиями по 100.",
      pipelineHint:
        "ИИ не используется — метрики и есть вердикт. Стоимость ≈ 1 юнит/домен/метрика (минимум 50 юнитов на партию из 100). Ключ Ahrefs API настраивается в Настройки → Провайдеры.",
      metricsHeading: "Метрики",
      metricsHint:
        "Выберите, какие поля batch-analysis запрашивать. По умолчанию только DR (дешевле всего). Каждая доп. метрика добавляет ~1 юнит/домен.",
      selectAll: "Выбрать все",
      clearAll: "Снять все",
      countryLabel: "Страна (необязательно)",
      countryHint:
        "Ограничивает Органический трафик / ключи одной страной. Пусто — весь мир. ISO alpha-2, напр. us, gb, de.",
      countryAny: "Весь мир",
      labelHeading: "Метка задачи",
      labelHint:
        "Необязательно. Имя видно в /jobs/ahrefs-batch-analysis и на странице задачи; заметка — свободный контекст.",
      nameLabel: "Название",
      namePlaceholder: "Автогенерация по первому домену, если пусто",
      notesLabel: "Заметки",
      notesPlaceholder: "Зачем анализируем?",
      submit: "Запустить batch-анализ",
      submitting: "Отправка…",
      settingsLink: "Открыть настройки Ahrefs",
      noMetricsError: "Выберите хотя бы одну метрику.",
      summary: (n) => `${n} домен${n === 1 ? "" : ""} готов${n === 1 ? "" : "ы"} к запуску`,
      skippedBanned: (n) => `Пропущено забаненных доменов: ${n}.`,
      allBannedError: (count, sample, truncated) =>
        `Все указанные домены в бан-листе (${count} всего): ${sample}${
          truncated ? "…" : ""
        }`,
      rerunBannerTitle: "Перезапуск",
      rerunBannerCancel: "Отменить перезапуск",
      rerunBannerHelp:
        "Будет добавлен новый Run в эту задачу. Отредактируйте список доменов и нажмите отправить.",
    },
    ahrefsBatchDomain: {
      heading: "Метрики Ahrefs Batch Analysis",
      metric: "Метрика",
      value: "Значение",
      noData:
        "Метрик пока нет — запуск в очереди, упал, или партия этого домена отклонена.",
      errorPrefix: "Ошибка запроса",
    },
    jobsWhoisHistory: {
      title: "История Whois — Задачи",
      subtitle:
        "Прошлые и текущие задачи по истории WHOIS. То же дерево Job → Run → Domain, что и в Quality, отфильтровано по этому разделу.",
    },
    jobsAvailability: {
      title: "Доступность — Задачи",
      subtitle:
        "Прошлые и текущие задачи каскада доступности.",
    },
    jobsByKind: {
      quality: {
        title: "Задачи — Качество",
        intro:
          "Отправленные задачи раздела Качество (Wayback + Ahrefs). Кликните на задачу, чтобы увидеть её запуски и вердикты по доменам.",
        empty: "Пока нет задач Качества — начните в Проверка → Качество.",
        goCheck: "Открыть Проверка → Качество",
      },
      whois_history: {
        title: "Задачи — История Whois",
        intro:
          "Отправленные задачи раздела История Whois (выявление дропов). Кликните на задачу, чтобы увидеть её запуски и WHOIS-вердикты по доменам.",
        empty:
          "Пока нет задач Истории Whois — начните в Проверка → История Whois.",
        goCheck: "Открыть Проверка → История Whois",
      },
      availability: {
        title: "Задачи — Доступность",
        intro:
          "Отправленные задачи раздела Доступность (RDAP / Domainr / WHOIS-43 каскад).",
        empty: "Пока нет задач Доступности — отправка появится в Волне 3.",
        goCheck: "Открыть Проверка → Доступность",
      },
      ahrefs_batch_analysis: {
        title: "Задачи — Ahrefs Batch Analysis",
        intro:
          "Отправленные задачи Ahrefs Batch Analysis (массовые метрики /batch-analysis). Кликните на задачу, чтобы увидеть её запуски и метрики по доменам.",
        empty:
          "Пока нет задач Ahrefs Batch Analysis — начните в Проверка → Ahrefs Batch Analysis.",
        goCheck: "Открыть Проверка → Ahrefs Batch Analysis",
      },
    },
    availabilityDomain: {
      verdictHeading: "Вердикт доступности",
      resolvedBy: "Определил",
      registrar: "Регистратор",
      expiresOn: "Истекает",
      noVerdict: "Вердикта каскада ещё нет — запуск в работе, упал или был пропущен.",
      cascadeErrorPrefix: "Ошибка каскада",
      traceHeading: "Трасса каскада",
      traceHint:
        "По одной строке на каждого попытанного провайдера, новые сверху. Каскад идёт по провайдерам в порядке, заданном в Настройках → Доступность, и останавливается на первом терминальном ответе (available / registered).",
      traceEmpty: "Для этого запуска не записано ни одной строки провайдера.",
      cols: {
        provider: "Провайдер",
        status: "Статус",
        latency: "Задержка",
        registrar: "Регистратор",
        expires: "Истекает",
        error: "Ошибка",
        checkedAt: "Проверен",
      },
    },
    whoisDomain: {
      pending: "Запрос Whois и/или вердикт ИИ для этого домена ещё в работе.",
      errorHeading: "Получение Whois history не удалось",
      verdict: {
        heading: "Вердикт ИИ",
        dropConfidence: "дроп",
        transferredConfidence: "трансфер",
        keySignals: "Ключевые сигналы",
        recommendation: "Рекомендация",
      },
      diff: {
        heading: "Сигналы из diff",
        coverage: (count, first, last) =>
          first && last
            ? `${count} снимков · ${first.slice(0, 10)} → ${last.slice(0, 10)}`
            : `${count} снимков`,
        creationDateChangesCount: (n: number) =>
          `Изменений creation_date: ${n}`,
        creationDateChangesCountHint:
          "Кол-во разных значений creation_date в истории WhoisFreaks. НЕ равно «сколько раз дроп» — реестр иногда переписывает поле при чистке данных или миграции WHOIS-сервера. Взвешенный вердикт берите из чипа dropped_confidence выше.",
        hardSignals: "Жёсткие сигналы",
        softSignals: "Мягкие сигналы",
        noHardSignals:
          "Жёстких сигналов нет (нет изменения creation_date, drop-pipeline статусов, провалов покрытия).",
        signals: {
          creation_date_changes:
            "Изменилась дата создания (ЖЁСТКИЙ — перерегистрация)",
          drop_pipeline_status_events:
            "Drop-pipeline статусы в истории (ЖЁСТКИЙ)",
          coverage_gaps_days: "Провалы покрытия ≥ порога (ЖЁСТКИЙ)",
          owner_changes: "Изменилось имя владельца",
          email_changes: "Изменился email владельца",
          org_changes: "Изменилась организация/компания",
          country_changes: "Изменилась страна владельца",
          city_changes: "Изменился город владельца",
          registrar_changes:
            "Изменился регистратор (слабый — трансферы бывают)",
          ns_changes:
            "Изменилось семейство нэймсерверов (слабый — переезд хостинга)",
          dnssec_toggles: "DNSSEC включён/выключен (слабый)",
        },
      },
      currentState: {
        heading: "Текущее состояние (последний снимок)",
        registrar: "Регистратор",
        owner: "Владелец",
        org: "Организация",
        country: "Страна",
        creationDate: "Дата создания",
        status: "Статусы",
        nameServers: "Нэймсерверы",
        dnssec: "DNSSEC",
        dnssecOn: "включён",
        dnssecOff: "выключен",
        inDropPipeline:
          "Последний снимок показывает, что домен в drop-pipeline реестра.",
      },
      rawRecords: {
        toggle: (n) => `Сырые исторические записи (${n} снимков)`,
        cols: {
          queryTime: "На дату",
          creationDate: "Создан",
          expiryDate: "Истекает",
          registrar: "Регистратор",
          registrant: "Владелец",
          country: "Страна",
          status: "Статус",
        },
      },
    },
    backlog: {
      title: "Очередь",
      intro:
        "Очередь триажа сырых кандидатов-доменов из регистраторов и аукционов. Фильтруйте, проставляйте статусы, потом отправляйте подмножество в Анализ.",
      empty: "В очереди пока нет доменов.",
      noMatch: "Нет доменов, подходящих под текущие фильтры.",
      refresh: "Обновить",
      refreshing: "Обновление…",
      searchPlaceholder: "Поиск по домену, проекту или комментарию…",
      cols: {
        domain: "Домен",
        status: "Статус",
        // 2026-05-17: переименовано из "Регистратор" по запросу
        // пользователя. То же поле теперь и в Базе под этим же
        // заголовком.
        registrar: "Источник",
        expirationDate: "Истечение",
        availability: "Доступность",
        project: "Проект",
        comments: "Комментарии",
        desiredPrice: "Желаемая $",
        maxPrice: "Макс $",
      },
      statusLabels: {
        backlog: "Очередь",
        in_progress: "В работе",
        analyzed: "Проанализирован",
        order: "Заказать",
        backordered: "Заказан",
        bought: "Куплен",
        discarded: "Отброшен",
        question: "Вопрос",
        banned: "Забанен",
      },
      filters: {
        heading: "Фильтры",
        clear: "Очистить фильтры",
        statusLabel: "Статус",
        statusAny: "Любой статус",
        // 2026-05-17: см. EN — label-only swap "Регистратор" → "Источник".
        registrarLabel: "Источник",
        registrarAny: "Любой источник",
        registrarSearchPlaceholder: "Поиск источников…",
        expiryFrom: "Истекает с",
        expiryTo: "Истекает по",
        availabilityLabel: "Доступность",
        availabilityAny: "Любая доступность",
        availabilityHint:
          "Фильтр по последнему результату проверки доступности (каскад RDAP / Domainr / WHOIS:43).",
        availabilityAvailable: "свободен",
        availabilityRegistered: "занят",
        availabilityNotSupported: "не поддерживается",
        availabilityUnknown: "неизвестно",
        availabilityError: "ошибка",
        availabilityNeverChecked: "(не проверялся)",
      },
      selectedCount: (n) => {
        const last2 = n % 100;
        const last1 = n % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return `выбрано ${n} ${word}`;
      },
      selectAllOnPage: "Выбрать все на этой странице",
      clearSelection: "Очистить",
      bulkChangeStatus: "Сменить статус",
      bulkChangeStatusAllFiltered: (n) =>
        `Сменить статус всем ${n} отфильтрованным…`,
      bulkChangeStatusTo: (label) => `Установить: ${label}`,
      confirmBulkStatusFiltered: (n, label) =>
        `Установить статус «${label}» всем ${n} доменам, подходящим под текущие фильтры? Это нельзя откатить одним кликом.`,
      sendToAnalyze: (n) => `Отправить ${n} в Анализ`,
      sendAllFilteredToAnalyze: (n) =>
        `Отправить все ${n} отфильтрованных в Анализ`,
      confirmSendAllFiltered: (n) =>
        `Отправить все ${n} отфильтрованных доменов в Анализ? Им автоматически проставится статус «в работе».`,
      sendToPicker: {
        label: (n) => `Отправить ${n} в:`,
        allFilteredLabel: (n) => `Отправить все ${n} отфильтрованных в:`,
        quality: "Quality",
        qualityHint:
          "Запустить критерии Ahrefs (беклинки / реф.домены / анкоры / ключи) + Wayback. Прежний путь «Анализ» до разделения на пилары.",
        whois: "Whois",
        whoisHint:
          "Запустить историю WHOIS (детектор пайплайна дропа). Дёшево по доменам — тарификация в юнитах WhoisFreaks.",
        availability: "Availability",
        availabilityHint:
          "Запустить каскад доступности (RDAP / Domainr / WHOIS:43), чтобы подтвердить регистрацию.",
        ahrefsBatch: "Ahrefs Batch",
        ahrefsBatchHint:
          "Запустить Ahrefs Batch Analysis (DR, реф.домены, беклинки, органические метрики) — дешёвый массовый префильтр перед Wayback / полным Ahrefs.",
      },
      analyzedHint: (n) =>
        n === 1
          ? `${n} домен из очереди уже проанализирован, но ещё не отмечен.`
          : `${n} доменов из очереди уже проанализированы, но ещё не отмечены.`,
      analyzedHintMark: (n) => `Отметить ${n} как Проанализирован`,
      analyzedHintDismiss: "Не сейчас",
      openAnalyzed: "Открыть страницу проанализированного домена",
      bulkDelete: (n) => `Удалить ${n}`,
      bulkDeleting: "Удаление…",
      bulkDeleteAllFiltered: (n) => `Удалить все ${n} отфильтрованных`,
      bulkDeleteAllFilteredNoFilterHint:
        "Сначала примените хотя бы один фильтр — иначе это действие сотрёт всю очередь.",
      confirmBulkDelete: (n) =>
        `Окончательно удалить ${n} строк(и) очереди? Действие необратимо.`,
      confirmBulkDeleteFiltered: (n) =>
        `Окончательно удалить все ${n} строк очереди, подходящих под текущие фильтры? Действие необратимо.`,
      totalHint: (filtered, total) => {
        const last2 = total % 100;
        const last1 = total % 10;
        let word = "доменов";
        if (last2 < 11 || last2 > 14) {
          if (last1 === 1) word = "домен";
          else if (last1 >= 2 && last1 <= 4) word = "домена";
        }
        return filtered === total
          ? `${total} ${word}`
          : `${filtered} из ${total} ${word}`;
      },
      importBtn: "Импорт CSV",
      exportFiltered: (n) => `Экспорт отфильтрованных (${n})`,
      exportAll: (n) => `Экспорт всех (${n})`,
      exportFilteredHint:
        "Скачать CSV строк, сейчас подходящих под фильтры и поиск.",
      exportAllHint: "Скачать каждый домен из очереди.",
      importDialog: {
        title: "Импорт доменов из CSV",
        step1Heading: "1. Выберите файл",
        fileHint: "CSV, TXT или TSV. Первая строка — заголовки колонок.",
        step2Heading: "2. Сопоставьте колонки",
        step2Intro: (n) =>
          `Найдено ${n} колонок. Сопоставьте каждую с полем очереди или выберите «(пропустить)». Домен обязателен.`,
        sourceColLabel: "Колонка источника",
        targetFieldLabel: "Сопоставить с",
        targetFields: {
          skip: "(пропустить)",
          domain: "Домен",
          status: "Статус",
          registrar: "Регистратор",
          expiration_date: "Дата истечения",
          project: "Проект",
          comments: "Комментарии",
          desired_price: "Желаемая цена",
          max_price: "Макс. цена",
          ahrefs_dr: "Ahrefs DR (сохраняется, скрыт)",
          domain_age_years: "Возраст, лет (сохраняется, скрыт)",
        },
        previewHeading: "Предпросмотр (первые 5 строк)",
        defaultsHeading: "3. Значения по умолчанию для несопоставленных полей",
        defaultsHint:
          "Подставлять одно и то же значение в каждую импортируемую строку, когда колонки нет в файле.",
        defaultRegistrar: "Регистратор (для всех строк)",
        defaultStatus: "Статус (для всех строк)",
        dateFormatLabel: "Формат даты истечения",
        dateFormatOptions: {
          auto: "Автоопределение",
          iso: "YYYY-MM-DD (2026-05-09)",
          dmy_dot: "DD.MM.YYYY (09.05.2026)",
          dmy_slash: "DD/MM/YYYY (09/05/2026)",
          dmy_dash: "DD-MM-YYYY (09-05-2026)",
          mdy_slash: "MM/DD/YYYY (05/09/2026)",
          month_name: "Название месяца (Jan 15, 2026)",
        },
        importBtn: (n) => `Импортировать ${n} строк(и)`,
        importing: "Импорт…",
        cancel: "Отмена",
        close: "Закрыть",
        domainNotMapped:
          "Сопоставьте колонку источника с Доменом, чтобы продолжить.",
        emptyFile: "В файле нет строк.",
        fileTruncated: (n) =>
          `Файл слишком большой — загружены только первые ${n} строк. Разбейте файл и импортируйте остальное отдельно.`,
        result: {
          heading: "Импорт завершён",
          inserted: (n) => `Добавлено новых доменов: ${n}.`,
          skippedDupes: (n) => `Пропущено дубликатов (уже в очереди): ${n}.`,
          skippedBanned: (n) => `Пропущено забаненных доменов: ${n}.`,
          skippedFilteredCctld: (n) =>
            `Пропущено страновых доменов: ${n} (Настройки → Фильтр доменов).`,
          skippedFilteredOther: (cat, n) =>
            `Пропущено доменов фильтром «${cat}»: ${n}.`,
          skippedInvalid: (n) => `Пропущено некорректных строк: ${n}.`,
          errorsHeading: "Замечания:",
          moreErrors: (n) => `… и ещё ${n}`,
        },
      },
    },
  },
};

const messages = { en: messagesEn, ru: messagesRu };

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Messages;
};

const LangContext = createContext<Ctx | null>(null);

export function LangProvider({
  children,
  initial = "en",
}: {
  children: ReactNode;
  initial?: Lang;
}) {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    const fromHtml = document.documentElement.lang;
    if (fromHtml === "ru" || fromHtml === "en") {
      setLangState(fromHtml);
    }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {}
    document.documentElement.lang = l;
  }, []);

  const value: Ctx = { lang, setLang, t: messages[lang] };
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT(): Ctx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useT must be used inside <LangProvider>");
  return ctx;
}
