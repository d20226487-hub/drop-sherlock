"use client";
import { useCallback, useEffect, useState } from "react";
import { api, AvailabilitySettings } from "@/lib/api";
import { useT } from "@/lib/i18n";

const PROVIDERS = ["dns", "rdap", "domainr", "whois", "whoisfreaks"] as const;
type Provider = (typeof PROVIDERS)[number];

export function AvailabilityEditor() {
  const { t } = useT();
  const a = t.pages.availability;
  const [cfg, setCfg] = useState<AvailabilitySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.getAvailabilitySettings();
      setCfg(r);
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
    try {
      await api.setAvailabilitySetting(key, value);
      await reload();
    } catch (e) {
      setError((e as Error).message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <div className="text-sm text-neutral-500 dark:text-neutral-400">
        {error ? error : "Loading…"}
      </div>
    );
  }

  const cascadeOrder = (cfg.availability__cascade_order || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Provider => (PROVIDERS as readonly string[]).includes(s));

  function move(provider: Provider, delta: -1 | 1) {
    const idx = cascadeOrder.indexOf(provider);
    if (idx < 0) return;
    const next = [...cascadeOrder];
    const swap = idx + delta;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setOne("availability__cascade_order", next.join(","));
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-md px-3 py-2 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Providers + cascade order */}
      <section className="space-y-3">
        <header>
          <h3 className="text-base font-semibold">
            {a.settingsCascadeHeading}
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsCascadeHint}
          </p>
        </header>
        <div className="space-y-1">
          {cascadeOrder.map((p, i) => {
            const enabled = cfg[`availability__${p}__enabled`] === "true";
            return (
              <div
                key={p}
                className="flex items-center gap-2 px-3 py-2 rounded-md border dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/40"
              >
                <span className="w-6 text-xs text-neutral-500 tabular-nums">
                  {i + 1}.
                </span>
                <span className="font-mono text-sm w-24 uppercase">{p}</span>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) =>
                      setOne(
                        `availability__${p}__enabled`,
                        e.target.checked ? "true" : "false",
                      )
                    }
                  />
                  enabled
                </label>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => move(p, -1)}
                  disabled={busy || i === 0}
                  className="text-xs px-1.5 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(p, 1)}
                  disabled={busy || i === cascadeOrder.length - 1}
                  className="text-xs px-1.5 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30"
                  title="Move down"
                >
                  ↓
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Domainr API key */}
      <section className="space-y-2">
        <header>
          <h3 className="text-base font-semibold">{a.settingsApiKeyHeading}</h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsApiKeyHint}
          </p>
        </header>
        <ApiKeyEditor
          isSet={cfg.availability__domainr__api_key__set}
          busy={busy}
          onSave={(v) => setOne("availability__domainr__api_key", v)}
        />
      </section>

      {/* Rate limits */}
      <section className="space-y-3">
        <header>
          <h3 className="text-base font-semibold">
            {a.settingsRateLimitsHeading}
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsRateLimitsHint}
          </p>
        </header>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">
            {a.settingsOuterConcurrencyLabel}
          </span>
          <NumberInput
            value={cfg.availability__outer_concurrency}
            disabled={busy}
            onSave={(v) => setOne("availability__outer_concurrency", v)}
          />
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {a.settingsOuterConcurrencyHint}
        </p>
        <table className="text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase text-neutral-500 dark:text-neutral-400">
              <th className="pr-4 pb-1">provider</th>
              <th className="pr-4 pb-1">RPS</th>
              <th className="pr-4 pb-1">max concurrent</th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((p) => (
              <tr key={p}>
                <td className="pr-4 py-1 font-mono uppercase">{p}</td>
                <td className="pr-4 py-1">
                  <NumberInput
                    value={cfg[`availability__${p}__rps`]}
                    disabled={busy}
                    onSave={(v) => setOne(`availability__${p}__rps`, v)}
                  />
                </td>
                <td className="pr-4 py-1">
                  <NumberInput
                    value={cfg[`availability__${p}__max_concurrent`]}
                    disabled={busy}
                    onSave={(v) =>
                      setOne(`availability__${p}__max_concurrent`, v)
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* RDAP egress proxies */}
      <section className="space-y-2">
        <header>
          <h3 className="text-base font-semibold">
            {a.settingsRdapProxiesHeading}
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsRdapProxiesHint}
          </p>
        </header>
        <ProxiesEditor
          value={cfg.availability__rdap__proxies || ""}
          busy={busy}
          onSave={(v) => setOne("availability__rdap__proxies", v)}
        />
      </section>

      {/* Cache TTL */}
      <section className="space-y-2">
        <header>
          <h3 className="text-base font-semibold">{a.settingsCacheHeading}</h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsCacheHint}
          </p>
        </header>
        <NumberInput
          value={cfg.availability__cache_ttl_hours}
          disabled={busy}
          onSave={(v) => setOne("availability__cache_ttl_hours", v)}
        />
      </section>

      {/* Skip policy */}
      <section className="space-y-2">
        <header>
          <h3 className="text-base font-semibold">{a.settingsSkipHeading}</h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsSkipHint}
          </p>
        </header>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.availability__skip_registered === "true"}
            disabled={busy}
            onChange={(e) =>
              setOne(
                "availability__skip_registered",
                e.target.checked ? "true" : "false",
              )
            }
          />
          enabled
        </label>
        <div className="flex items-center gap-2 text-sm">
          <span>horizon (days):</span>
          <NumberInput
            value={cfg.availability__skip_horizon_days}
            disabled={busy}
            onSave={(v) => setOne("availability__skip_horizon_days", v)}
          />
        </div>
      </section>

      {/* Retention prune — added 2026-05-14. Bounds the
          availability_checks history table so the DB file doesn't grow
          forever. Daily APScheduler job + one-shot on boot. 0 in either
          field disables that cap. */}
      <section className="space-y-2">
        <header>
          <h3 className="text-base font-semibold">{a.settingsRetentionHeading}</h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {a.settingsRetentionHint}
          </p>
        </header>
        <div className="flex items-center gap-2 text-sm">
          <span>{a.settingsRetentionDaysLabel}</span>
          <NumberInput
            value={cfg.availability__retention_days}
            disabled={busy}
            onSave={(v) => setOne("availability__retention_days", v)}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {a.settingsRetentionDaysHint}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span>{a.settingsPerDomainKeepLabel}</span>
          <NumberInput
            value={cfg.availability__per_domain_keep}
            disabled={busy}
            onSave={(v) => setOne("availability__per_domain_keep", v)}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {a.settingsPerDomainKeepHint}
          </span>
        </div>
      </section>

      {/* Usage stats + recent log */}
      <UsageSection />
    </div>
  );
}

// Multi-line editor for the RDAP egress proxy list. One proxy URL per
// line; explicit Save (not blur) since blur-to-save is surprising on a
// textarea. The Save button is disabled until the text differs from the
// persisted value.
function ProxiesEditor({
  value,
  busy,
  onSave,
}: {
  value: string;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  const dirty = local !== value;
  return (
    <div className="space-y-2">
      <textarea
        value={local}
        disabled={busy}
        rows={4}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={
          "http://user:pass@host:port\nhost:port\nsocks5://host:1080"
        }
        className="w-full max-w-xl px-2 py-1 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono"
      />
      <button
        type="button"
        disabled={busy || !dirty}
        onClick={() => onSave(local)}
        className="text-xs px-3 py-1 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function NumberInput({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <input
      type="number"
      value={local}
      disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onSave(local);
      }}
      className="w-20 px-2 py-0.5 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950"
    />
  );
}

function ApiKeyEditor({
  isSet,
  busy,
  onSave,
}: {
  isSet: boolean;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState("");
  const [editing, setEditing] = useState(!isSet);
  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono text-neutral-500">••••••••</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs px-2 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => onSave("")}
          className="text-xs px-2 py-0.5 rounded border dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
        >
          Clear
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Fastly API token…"
        className="flex-1 max-w-md px-2 py-1 text-sm rounded border dark:border-neutral-700 bg-white dark:bg-neutral-950 font-mono"
      />
      <button
        type="button"
        onClick={() => {
          onSave(v);
          setV("");
          setEditing(false);
        }}
        disabled={busy || v.length === 0}
        className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function UsageSection() {
  const { t } = useT();
  const a = t.pages.availability;
  const [stats, setStats] = useState<
    { provider: string; sent: number; succeeded: number; failed: number }[]
  >([]);
  const [recent, setRecent] = useState<
    {
      id: number;
      domain: string;
      provider: string;
      status: string;
      checked_at: string;
      latency_ms: number | null;
      error_category: string;
    }[]
  >([]);

  useEffect(() => {
    api
      .availabilityStats()
      .then((r) => setStats(r.providers))
      .catch(() => {});
    api
      .availabilityRecent(50)
      .then((rows) =>
        setRecent(
          rows.map((r) => ({
            id: r.id,
            domain: r.domain,
            provider: r.provider,
            status: r.status,
            checked_at: r.checked_at,
            latency_ms: r.latency_ms,
            error_category: r.error_category,
          })),
        ),
      )
      .catch(() => {});
  }, []);

  return (
    <>
      <section className="space-y-2">
        <h3 className="text-base font-semibold">{a.settingsStatsHeading}</h3>
        {stats.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">—</p>
        ) : (
          <table className="text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500 dark:text-neutral-400">
                <th className="pr-4 pb-1">provider</th>
                <th className="pr-4 pb-1">sent</th>
                <th className="pr-4 pb-1">ok</th>
                <th className="pr-4 pb-1">failed</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.provider}>
                  <td className="pr-4 py-1 font-mono uppercase">{s.provider}</td>
                  <td className="pr-4 py-1 tabular-nums">{s.sent}</td>
                  <td className="pr-4 py-1 tabular-nums text-emerald-700 dark:text-emerald-400">
                    {s.succeeded}
                  </td>
                  <td className="pr-4 py-1 tabular-nums text-rose-700 dark:text-rose-400">
                    {s.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold">{a.settingsRecentHeading}</h3>
        {recent.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500 dark:text-neutral-400">
                  <th className="pr-4 pb-1">when</th>
                  <th className="pr-4 pb-1">domain</th>
                  <th className="pr-4 pb-1">provider</th>
                  <th className="pr-4 pb-1">status</th>
                  <th className="pr-4 pb-1">ms</th>
                  <th className="pr-4 pb-1">err</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="pr-4 py-0.5 whitespace-nowrap">
                      {new Date(r.checked_at).toLocaleString()}
                    </td>
                    <td className="pr-4 py-0.5 font-mono">{r.domain}</td>
                    <td className="pr-4 py-0.5 uppercase">{r.provider}</td>
                    <td className="pr-4 py-0.5">{r.status}</td>
                    <td className="pr-4 py-0.5 tabular-nums">
                      {r.latency_ms ?? ""}
                    </td>
                    <td className="pr-4 py-0.5">{r.error_category || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
