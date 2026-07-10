"use client";

// Settings → SERP Overview: the duplicate-ignore window for the SERP
// Overview tool. A keyword whose exact (keyword, country, top-positions)
// triple completed within this many days is skipped at submit time unless
// "Recheck keywords" is ticked on the tool. Backend:
//   GET/PUT /api/settings/serp-overview → { dedup_window_days, default_days }

import { useEffect, useState } from "react";

export function SerpOverviewEditor() {
  const [days, setDays] = useState("");
  const [defaultDays, setDefaultDays] = useState(30);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tldsText, setTldsText] = useState("");
  const [tldsCount, setTldsCount] = useState(0);
  const [defaultCount, setDefaultCount] = useState(0);
  const [tldsLoaded, setTldsLoaded] = useState(false);
  const [tldsBusy, setTldsBusy] = useState(false);
  const [tldsMsg, setTldsMsg] = useState<string | null>(null);
  const [tldsError, setTldsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/serp-overview");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (cancelled) return;
        setDays(String(d.dedup_window_days));
        setDefaultDays(d.default_days ?? 30);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Allowed-TLDs allowlist (shared by Linked Domains fetch filter + SERP
  // domain exports). Loaded separately so a failure here doesn't block
  // the dedup-window editor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/allowed-tlds");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (cancelled) return;
        setTldsText((d.tlds || []).join("\n"));
        setTldsCount(d.count ?? 0);
        setDefaultCount(d.default_count ?? 0);
        setTldsLoaded(true);
      } catch (e) {
        if (!cancelled) setTldsError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveTlds(body: { tlds?: string[]; reset?: boolean }) {
    setTldsBusy(true);
    setTldsMsg(null);
    setTldsError(null);
    try {
      const res = await fetch("/api/settings/allowed-tlds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const d = await res.json();
      setTldsText((d.tlds || []).join("\n"));
      setTldsCount(d.count ?? 0);
      setTldsMsg("Saved");
      setTimeout(() => setTldsMsg(null), 2000);
    } catch (e) {
      setTldsError((e as Error).message);
    } finally {
      setTldsBusy(false);
    }
  }

  async function save() {
    setError(null);
    setMsg(null);
    const n = Number(days);
    if (Number.isNaN(n) || n < 1 || n > 3650) {
      setError("Enter a number of days between 1 and 3650");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/serp-overview", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dedup_window_days: n }),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const d = await res.json();
      setDays(String(d.dedup_window_days));
      setMsg("Saved");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const parsedTldCount = tldsText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  return (
    <div className="space-y-6 max-w-xl">
    <section className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">
          Duplicate ignore window
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          A keyword checked with the same country and result count within
          this many days is skipped on submit — no Ahrefs call, no credits
          spent. The &quot;Recheck keywords&quot; toggle on the SERP
          Overview tool bypasses this per run.
        </p>
      </div>
      <label className="block max-w-xs">
        <span className="text-sm font-medium block mb-1">
          Ignore duplicates for (days)
        </span>
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          disabled={!loaded || busy}
          className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400 block mt-1">
          Default: {defaultDays} days
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!loaded || busy}
          className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span className="text-sm text-green-700 dark:text-green-400">
            {msg}
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </div>
    </section>

    <section className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Allowed TLDs</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          Shared allowlist of TLD suffixes (one per line, or space/comma
          separated). Used by the Linked Domains &quot;allowed TLDs
          only&quot; fetch filter and the SERP Overview domain exports.
          Suffix match — an entry <code>uk</code> also covers{" "}
          <code>co.uk</code> domains. Default: the Domain Spam
          Filter&apos;s openly-registrable list.
        </p>
      </div>
      <textarea
        value={tldsText}
        onChange={(e) => setTldsText(e.target.value)}
        rows={10}
        disabled={!tldsLoaded || tldsBusy}
        className="w-full rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono outline-none"
      />
      <div className="text-xs text-neutral-500 dark:text-neutral-400">
        {parsedTldCount} entr{parsedTldCount === 1 ? "y" : "ies"} in the box
        · saved: {tldsCount} · default list: {defaultCount}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            saveTlds({
              tlds: tldsText
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          disabled={!tldsLoaded || tldsBusy}
          className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {tldsBusy ? "Saving…" : "Save TLDs"}
        </button>
        <button
          type="button"
          onClick={() => saveTlds({ reset: true })}
          disabled={!tldsLoaded || tldsBusy}
          className="rounded border dark:border-neutral-700 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Reset to default
        </button>
        {tldsMsg && (
          <span className="text-sm text-green-700 dark:text-green-400">
            {tldsMsg}
          </span>
        )}
        {tldsError && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {tldsError}
          </span>
        )}
      </div>
    </section>
    </div>
  );
}
