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
    analyze: "Analyze",
    jobs: "Jobs",
    database: "Database",
    errors: "Errors",
    settings: "Settings",
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
      },
      states: {
        ok: "Working",
        unconfigured: "Not configured",
        error: "Error",
        unknown: "Checking…",
      },
      noKeyYet: "No credentials saved yet. Open Settings to add one.",
      openSettings: "Open Settings",
      elapsed: (ms: number) => `${ms} ms`,
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
          final: "Final",
        },
        legendDiff: "Different",
        legendSame: "Same",
        legendOnlyA: "Only in A",
        legendOnlyB: "Only in B",
        viewDomainA: "Open A",
        viewDomainB: "Open B",
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
      cols: {
        domain: "Domain",
        verdict: "Ahrefs",
        verdictSortHint:
          "Click to sort by score. Cycles desc → asc → default. Partial / no-verdict rows always sink to the bottom.",
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
      backlogActions: {
        order: "Order",
        orderHint:
          "Queue this domain for purchase (status = order). Updates the matching backlog row, or creates one if the domain isn't in Backlog yet. Mark it as Ordered manually from the Backlog page once the order is actually placed.",
        discard: "Discard",
        discardHint:
          "Mark this domain as discarded. Updates the matching backlog row, or creates one if the domain isn't in Backlog yet.",
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
        minRecords: "Min records",
        minRecordsHelp:
          "Minimum row count in the chosen criterion (latest run).",
        waybackConfMin: "Wayback conf ≥",
        waybackConfMinHelp:
          "Show only rows whose Wayback AI verdict confidence is at least this value (0..1). Rows without a Wayback verdict are hidden when this is > 0.",
        ahrefsConfMin: "Ahrefs conf ≥",
        ahrefsConfMinHelp:
          "Show only rows whose Ahrefs Final Assessment confidence is at least this value (0..1). Rows without a final (or with a partial) are hidden when this is > 0.",
        clear: "Clear filters",
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
        others: "Others",
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
            "Safety snapshot taken automatically right before a restore. Exempt from auto-rotation.",
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
      },
      fieldLabels: {
        api_key: "API key",
        token: "Token",
        default_model: "Default model",
      },
      fieldPlaceholders: {
        api_key: "Paste API key…",
        token: "Paste token…",
        default_model: "e.g. gemini-2.5-flash",
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
    backlog: {
      title: "Backlog",
      intro:
        "Triage queue for raw domain candidates pulled from registrars and auctions. Filter, mark statuses, then send a subset to Analyze.",
      empty: "No domains in your backlog yet.",
      noMatch: "No domains match the current filters.",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      cols: {
        domain: "Domain",
        status: "Status",
        registrar: "Registrar",
        expirationDate: "Expiration",
        availability: "Availability",
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
      },
      filters: {
        heading: "Filters",
        clear: "Clear filters",
        statusLabel: "Status",
        statusAny: "Any status",
        registrarLabel: "Registrar",
        registrarAny: "Any registrar",
        registrarSearchPlaceholder: "Search registrars…",
        expiryFrom: "Expires from",
        expiryTo: "Expires to",
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
      analyzedHint: (n: number) =>
        `${n} backlog domain${n === 1 ? " has" : "s have"} been analyzed but ${n === 1 ? "isn't" : "aren't"} marked yet.`,
      analyzedHintMark: (n: number) =>
        `Mark ${n} as Analyzed`,
      analyzedHintDismiss: "Not now",
      openAnalyzed: "Open the analyzed domain page",
      bulkDelete: (n: number) => `Delete ${n}`,
      bulkDeleting: "Deleting…",
      confirmBulkDelete: (n: number) =>
        `Permanently delete ${n} backlog row${n === 1 ? "" : "s"}? This cannot be undone.`,
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
          comments: "Comments",
          desired_price: "Desired price",
          max_price: "Max price",
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
    jobs: "Задачи",
    database: "База",
    errors: "Ошибки",
    settings: "Настройки",
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
      },
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
          final: "Итог",
        },
        legendDiff: "Разные",
        legendSame: "Одинаковые",
        legendOnlyA: "Только в A",
        legendOnlyB: "Только в B",
        viewDomainA: "Открыть A",
        viewDomainB: "Открыть B",
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
      cols: {
        domain: "Домен",
        verdict: "Ahrefs",
        verdictSortHint:
          "Кликните для сортировки по баллу. Цикл: убыв → возр → по умолчанию. Частичные / без вердикта всегда уходят вниз.",
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
      backlogActions: {
        order: "Заказать",
        orderHint:
          "Поставить домен в очередь на покупку (статус = order). Обновит соответствующую строку в Очереди или создаст новую, если домена там нет. После того как заказ действительно размещён, отметьте его как Заказан вручную на странице Очереди.",
        discard: "Отбросить",
        discardHint:
          "Отметить домен как отброшенный. Обновит соответствующую строку в Очереди или создаст новую, если домена там нет.",
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
        minRecords: "Мин. записей",
        minRecordsHelp:
          "Минимальное число строк в выбранном критерии (последний запуск).",
        waybackConfMin: "Wayback увер. ≥",
        waybackConfMinHelp:
          "Показывать только строки, где уверенность AI-вердикта Wayback не меньше этого значения (0..1). Строки без Wayback-вердикта скрываются, когда значение > 0.",
        ahrefsConfMin: "Ahrefs увер. ≥",
        ahrefsConfMinHelp:
          "Показывать только строки, где уверенность Итоговой оценки Ahrefs не меньше этого значения (0..1). Строки без итоговой оценки (или с частичной) скрываются, когда значение > 0.",
        clear: "Очистить фильтры",
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
        others: "Прочее",
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
            "Страховочный снимок, созданный автоматически перед восстановлением. Не подлежит автоудалению.",
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
      },
      fieldLabels: {
        api_key: "API-ключ",
        token: "Токен",
        default_model: "Модель по умолчанию",
      },
      fieldPlaceholders: {
        api_key: "Вставьте API-ключ…",
        token: "Вставьте токен…",
        default_model: "напр. gemini-2.5-flash",
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
    backlog: {
      title: "Очередь",
      intro:
        "Очередь триажа сырых кандидатов-доменов из регистраторов и аукционов. Фильтруйте, проставляйте статусы, потом отправляйте подмножество в Анализ.",
      empty: "В очереди пока нет доменов.",
      noMatch: "Нет доменов, подходящих под текущие фильтры.",
      refresh: "Обновить",
      refreshing: "Обновление…",
      cols: {
        domain: "Домен",
        status: "Статус",
        registrar: "Регистратор",
        expirationDate: "Истечение",
        availability: "Доступность",
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
      },
      filters: {
        heading: "Фильтры",
        clear: "Очистить фильтры",
        statusLabel: "Статус",
        statusAny: "Любой статус",
        registrarLabel: "Регистратор",
        registrarAny: "Любой регистратор",
        registrarSearchPlaceholder: "Поиск регистраторов…",
        expiryFrom: "Истекает с",
        expiryTo: "Истекает по",
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
      analyzedHint: (n) =>
        n === 1
          ? `${n} домен из очереди уже проанализирован, но ещё не отмечен.`
          : `${n} доменов из очереди уже проанализированы, но ещё не отмечены.`,
      analyzedHintMark: (n) => `Отметить ${n} как Проанализирован`,
      analyzedHintDismiss: "Не сейчас",
      openAnalyzed: "Открыть страницу проанализированного домена",
      bulkDelete: (n) => `Удалить ${n}`,
      bulkDeleting: "Удаление…",
      confirmBulkDelete: (n) =>
        `Окончательно удалить ${n} строк(и) очереди? Действие необратимо.`,
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
          comments: "Комментарии",
          desired_price: "Желаемая цена",
          max_price: "Макс. цена",
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
