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

  return (
    <section className="rounded-md border dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3 max-w-xl">
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
  );
}
