// sessionStorage key for the Backlog → Analyze handover. The Backlog
// page writes the resolved domain list under this key right before
// navigating to /analyze?from_backlog=1; the Analyze page reads + clears
// it on mount. URL params can't carry thousands of domains.
export const BACKLOG_HANDOFF_KEY = "backlogToAnalyzeDomains";
