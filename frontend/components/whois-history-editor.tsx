"use client";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  WhoisHistorySettings,
  WhoisHistoryTestResult,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

// Whois History settings tab (Wave 2b, 2026-05-15). Mirrors the
// shape of the AvailabilityEditor / BackupsEditor pattern: load on
// mount, render each knob as a controlled input, PUT on blur or
// Save click, surface validation errors inline.
//
// The API key is a write-only field — the backend exposes
// `api_key_set: boolean` for state but never round-trips the value.
// We render an empty input with a placeholder that says whether one
// is stored; submitting an empty string clears the credential
// (matches the backend `set_whois_history_api_key("")` semantics).

export function WhoisHistoryEditor() {
  const { t } = useT();
  const ts = t.pages.settings.whoisHistory;

  const [cfg, setCfg] = useState<WhoisHistorySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Local draft state for non-secret knobs so the user can type
  // without firing a save on every keystroke. Committed via setOne()
  // on blur/Enter.
  const [maxRecords, setMaxRecords] = useState("");
  const [gapDays, setGapDays] = useState("");
  const [dropThreshold, setDropThreshold] = useState("");

  // API key — string input, never pre-filled with the stored value.
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  // Test-button state — domain to probe + last result. Separate from
  // the main `error`/`savedAt` channel so a failed test doesn't blow
  // away a successful save indicator, and a successful test doesn't
  // pretend a save happened.
  const [testDomain, setTestDomain] = useState("example.com");
  const [testResult, setTestResult] = useState<WhoisHistoryTestResult | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  // Rate-limit drafts (Wave 2b, 2026-05-15).
  const [rpm, setRpm] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("");

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await api.getWhoisHistorySettings();
      setCfg(r);
      setMaxRecords(String(r.max_records));
      setGapDays(String(r.coverage_gap_threshold_days));
      setDropThreshold(String(r.drop_confidence_threshold));
      setRpm(String(r.rate_limits.rpm));
      setMaxConcurrent(String(r.rate_limits.max_concurrent));
    } catch (e) {
      setError((e as Error).message || "load failed");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function setOne(key: string, value: string) {
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      await api.setWhoisHistorySetting(key, value);
      await reload();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveApiKey() {
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      await api.setWhoisHistoryApiKey(apiKeyDraft);
      setApiKeyDraft("");
      await reload();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveRateLimit(field: "rpm" | "max_concurrent", value: string) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      setError("must be a positive integer");
      return;
    }
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      await api.setWhoisHistoryRateLimits({ [field]: n });
      await reload();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testWhoisHistory(testDomain || undefined);
      setTestResult(r);
    } catch (e) {
      // Network / 4xx / 5xx surfacing as a synthetic failure result so
      // the result-render branch below handles it uniformly.
      setTestResult({
        ok: false,
        domain: testDomain || "example.com",
        error: (e as Error).message || "test failed",
      });
    } finally {
      setTesting(false);
    }
  }

  if (!cfg) {
    return (
      <div className="text-sm text-neutral-500 dark:text-neutral-400">
        {error ? error : t.common.loading}
      </div>
    );
  }

  const apiKeyPlaceholder = cfg.api_key_set
    ? ts.apiKeyStored
    : ts.apiKeyMissing;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{ts.heading}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1 leading-relaxed">
          {ts.intro}
        </p>
      </div>

      {/* Provider — read-only for Wave 2; only WhoisFreaks is wired. */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.providerLabel}
        </label>
        <div className="text-sm font-mono">
          {cfg.provider}{" "}
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            ({ts.providerHint})
          </span>
        </div>
      </section>

      {/* API key — write-only. */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.apiKeyLabel}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.apiKeyHint}
        </p>
        <div className="flex items-stretch gap-2">
          <input
            type="password"
            autoComplete="new-password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={apiKeyPlaceholder}
            className="flex-1 max-w-md text-sm font-mono rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            type="button"
            onClick={saveApiKey}
            disabled={busy}
            className="text-sm px-3 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
          >
            {apiKeyDraft.length === 0 && cfg.api_key_set
              ? ts.clearApiKey
              : ts.saveApiKey}
          </button>
        </div>
      </section>

      {/* Test connection — costs the operator 1 provider request.
          Hidden behind a small section so it's not the first thing the
          user clicks; surfacing a clear "1 request to the provider"
          subhint deters accidental quota burn. */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.testLabel}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.testHint}
        </p>
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={testDomain}
            onChange={(e) => setTestDomain(e.target.value)}
            placeholder="example.com"
            className="flex-1 max-w-xs text-sm font-mono rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            type="button"
            onClick={runTest}
            disabled={testing || !cfg.api_key_set}
            title={
              !cfg.api_key_set ? ts.testNeedsKey : ts.testTooltip
            }
            className="text-sm px-3 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? ts.testing : ts.testButton}
          </button>
        </div>
        {testResult && <TestResultBox result={testResult} />}
      </section>

      {/* Max records */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.maxRecordsLabel}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.maxRecordsHint}
        </p>
        <input
          type="number"
          min={1}
          max={500}
          value={maxRecords}
          onChange={(e) => setMaxRecords(e.target.value)}
          onBlur={() =>
            maxRecords !== String(cfg.max_records) &&
            setOne("whois_history__max_records", maxRecords)
          }
          disabled={busy}
          className="w-32 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
        />
      </section>

      {/* Coverage gap threshold */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.coverageGapLabel}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.coverageGapHint}
        </p>
        <input
          type="number"
          min={1}
          max={365}
          value={gapDays}
          onChange={(e) => setGapDays(e.target.value)}
          onBlur={() =>
            gapDays !== String(cfg.coverage_gap_threshold_days) &&
            setOne("whois_history__coverage_gap_threshold_days", gapDays)
          }
          disabled={busy}
          className="w-32 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
        />
      </section>

      {/* Rate limits — added Wave 2b after a 429 surfaced from a
          burst of Test-button clicks. Keeping the controls right
          alongside Test makes the trade-off obvious. */}
      <section className="space-y-2 rounded-md border border-neutral-200 dark:border-neutral-800 p-3">
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {ts.rateLimitsHeading}
        </h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.rateLimitsHint}
        </p>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <label className="text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
            <span className="block">{ts.rpmLabel}</span>
            <input
              type="number"
              min={1}
              max={6000}
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
              onBlur={() =>
                rpm !== String(cfg.rate_limits.rpm) &&
                saveRateLimit("rpm", rpm)
              }
              disabled={busy}
              className="w-full text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
            />
          </label>
          <label className="text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
            <span className="block">{ts.maxConcurrentLabel}</span>
            <input
              type="number"
              min={1}
              max={32}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
              onBlur={() =>
                maxConcurrent !== String(cfg.rate_limits.max_concurrent) &&
                saveRateLimit("max_concurrent", maxConcurrent)
              }
              disabled={busy}
              className="w-full text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
            />
          </label>
        </div>
      </section>

      {/* Drop confidence threshold */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300 block">
          {ts.dropThresholdLabel}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.dropThresholdHint}
        </p>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={dropThreshold}
          onChange={(e) => setDropThreshold(e.target.value)}
          onBlur={() =>
            dropThreshold !== String(cfg.drop_confidence_threshold) &&
            setOne(
              "whois_history__drop_confidence_threshold",
              dropThreshold,
            )
          }
          disabled={busy}
          className="w-32 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50"
        />
      </section>

      {(error || savedAt) && (
        <div className="text-xs">
          {error && (
            <span className="text-rose-600 dark:text-rose-400">
              {error}
            </span>
          )}
          {!error && savedAt && (
            <span className="text-emerald-700 dark:text-emerald-400">
              {t.common.saved} ({savedAt})
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Three-state result renderer: green (records found), amber (auth OK
// but no history available for THIS domain — try a different one),
// rose (provider error / config issue). Pulled out of the main
// component body to keep the form readable.
function TestResultBox({ result }: { result: WhoisHistoryTestResult }) {
  const { t } = useT();
  const ts = t.pages.settings.whoisHistory;

  if (!result.ok) {
    return (
      <div className="rounded-md border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-800 dark:text-rose-300 space-y-1">
        <div className="font-medium">{ts.testFailed}</div>
        <div className="font-mono break-all">{result.error}</div>
        <div className="text-rose-700/70 dark:text-rose-400/70">
          {ts.testFailedHint}
        </div>
      </div>
    );
  }

  if (result.records_found === 0) {
    // Provider responded fine but had nothing for this domain. The
    // operator typically wants to try a different domain.
    return (
      <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-1">
        <div className="font-medium">{ts.testNoRecords(result.domain)}</div>
        <div className="text-amber-700/70 dark:text-amber-400/70">
          {ts.testNoRecordsHint}
        </div>
      </div>
    );
  }

  const p = result.latest_record_preview;
  return (
    <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
      <div className="font-medium">
        {ts.testOk(result.records_found, result.domain)}
      </div>
      {p && (
        <ul className="text-emerald-700 dark:text-emerald-300/90 font-mono space-y-0.5 mt-1">
          {p.query_time && <li>query_time: {p.query_time}</li>}
          {p.creation_date && <li>creation_date: {p.creation_date}</li>}
          {p.expiry_date && <li>expiry_date: {p.expiry_date}</li>}
          {p.registrar_name && (
            <li>registrar: {p.registrar_name}</li>
          )}
          {p.registrant_country && (
            <li>registrant country: {p.registrant_country}</li>
          )}
          {p.domain_status && p.domain_status.length > 0 && (
            <li>status: [{p.domain_status.join(", ")}]</li>
          )}
        </ul>
      )}
      <div className="text-emerald-700/70 dark:text-emerald-400/70 mt-1">
        {ts.testOkHint(result.provider)}
      </div>
    </div>
  );
}
