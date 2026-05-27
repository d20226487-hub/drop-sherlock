"use client";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  BackupSnapshot,
  BackupStatus,
  RemoteBackupConfig,
  RemoteBackupSetPayload,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function BackupsEditor() {
  const { t } = useT();
  const ts = t.pages.settings.backups;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.getBackupStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.runBackupNow();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="text-sm text-neutral-500">{t.common.loading}</div>
    );
  }

  if (!status) {
    return (
      <div className="text-sm text-rose-600 dark:text-rose-400">
        {error ?? ts.loadFailed}
      </div>
    );
  }

  return (
    <div className="space-y-6 text-sm">
      <p className="text-neutral-600 dark:text-neutral-400">{ts.intro}</p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-neutral-500">{ts.statusLabel}:</span>{" "}
          {status.enabled ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              {ts.statusEnabled}
            </span>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              {ts.statusDisabled}
            </span>
          )}
        </div>
        <div>
          <span className="text-neutral-500">{ts.intervalLabel}:</span>{" "}
          {ts.intervalHoursValue(status.interval_hours)}
        </div>
        <div>
          <span className="text-neutral-500">{ts.keepLabel}:</span>{" "}
          {ts.keepValue(status.keep)}
        </div>
        <div>
          <span className="text-neutral-500">{ts.dirLabel}:</span>{" "}
          <code className="text-neutral-700 dark:text-neutral-300">
            {status.backup_dir}
          </code>
        </div>
      </div>

      {!status.supported && (
        <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {ts.unsupported}
        </div>
      )}

      {error && (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          {t.common.error}: {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={runNow}
          disabled={running || !status.supported}
          className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          {running ? ts.runningLabel : ts.runNow}
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          {ts.refresh}
        </button>
      </div>

      <RemoteBackupSection
        initial={status.remote}
        onSaved={() => void load()}
      />

      <UploadRestoreSection
        supported={status.supported}
        onImported={() => void load()}
      />

      <SnapshotsTable
        snapshots={status.snapshots}
        onRestored={() => void load()}
      />
    </div>
  );
}

// --- Upload an external .db.gz and restore from it ----------------------

function UploadRestoreSection({
  supported,
  onImported,
}: {
  supported: boolean;
  onImported: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.backups.upload;
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  return (
    <div className="space-y-2 rounded border border-neutral-200 dark:border-neutral-700 p-3">
      <h3 className="text-sm font-semibold">{ts.heading}</h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>
      {result && (
        <div
          className={`text-xs px-2 py-1 rounded border ${
            result.ok
              ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
              : "border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300"
          }`}
        >
          {result.message}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="file"
          accept=".gz,application/gzip,application/x-gzip"
          disabled={!supported}
          onChange={(e) => {
            setResult(null);
            setFile(e.target.files?.[0] ?? null);
          }}
          className="text-xs file:mr-2 file:px-2 file:py-1 file:rounded file:border file:border-neutral-300 dark:file:border-neutral-600 file:bg-white dark:file:bg-neutral-800 file:text-xs"
        />
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          disabled={!file || !supported}
          className="px-3 py-1.5 text-xs rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {ts.uploadAndRestore}
        </button>
        {file && (
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {file.name} ({formatBytes(file.size)})
          </span>
        )}
      </div>
      {confirming && file && (
        <UploadRestoreConfirmModal
          file={file}
          onCancel={() => setConfirming(false)}
          onDone={(r) => {
            setConfirming(false);
            setResult(r);
            if (r.ok) {
              setFile(null);
              onImported();
            }
          }}
        />
      )}
    </div>
  );
}

function UploadRestoreConfirmModal({
  file,
  onCancel,
  onDone,
}: {
  file: File;
  onCancel: () => void;
  onDone: (result: { ok: boolean; message: string }) => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.backups.upload;
  const tr = t.pages.settings.backups.restore;
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.uploadAndRestoreBackup(file);
      onDone({
        ok: true,
        message: ts.successBanner(
          r.imported_filename,
          r.prerestore_snapshot,
        ),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          {ts.modalTitle}
        </h3>
        <div className="text-xs text-neutral-700 dark:text-neutral-300 space-y-1">
          <div>
            <span className="text-neutral-500">{tr.fileLabel}:</span>{" "}
            <code className="font-mono break-all">{file.name}</code>
          </div>
          <div>
            <span className="text-neutral-500">{tr.sizeLabel}:</span>{" "}
            {formatBytes(file.size)}
          </div>
        </div>
        <div className="text-xs text-neutral-600 dark:text-neutral-300 leading-snug border-l-4 border-amber-400 pl-2 py-1 bg-amber-50/40 dark:bg-amber-950/20">
          {ts.warning}
        </div>
        <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>{tr.ackLabel}</span>
        </label>
        {error && (
          <div className="text-xs text-rose-600 dark:text-rose-400 break-words">
            {ts.failPrefix}: {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!acknowledged || busy}
            className="text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? ts.uploading : ts.uploadAndRestore}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Snapshots table + Restore action ----------------------------------

function SnapshotsTable({
  snapshots,
  onRestored,
}: {
  snapshots: BackupSnapshot[];
  onRestored: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.backups;
  const [confirming, setConfirming] = useState<BackupSnapshot | null>(null);
  const [restoreResult, setRestoreResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  return (
    <div>
      <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 mb-1">
        {ts.snapshotsHeading}
      </h3>
      {restoreResult && (
        <div
          className={`text-xs mb-2 px-2 py-1 rounded border ${
            restoreResult.ok
              ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
              : "border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300"
          }`}
        >
          {restoreResult.message}
        </div>
      )}
      {snapshots.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {ts.empty}
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-neutral-500 dark:text-neutral-400">
            <tr>
              <th className="py-1 pr-3 font-medium">{ts.cols.filename}</th>
              <th className="py-1 pr-3 font-medium">{ts.cols.size}</th>
              <th className="py-1 pr-3 font-medium">{ts.cols.created}</th>
              <th className="py-1 pr-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.filename} className="border-t dark:border-neutral-800">
                <td className="py-1 pr-3 font-mono">
                  {s.filename}
                  {s.prerestore && (
                    <span
                      className="ml-2 px-1 py-0.5 rounded text-[10px] bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
                      title={ts.restore.prerestoreHint}
                    >
                      {ts.restore.prerestoreBadge}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3">{formatBytes(s.size_bytes)}</td>
                <td className="py-1 pr-3 text-neutral-500">
                  {formatAge(s.age_seconds)}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {/* Download (added 2026-05-27). Direct browser
                      navigation rather than an XHR — the file streams
                      through Caddy without a multi-MB in-memory blob.
                      Same basic-auth gate as the rest of /api so
                      anyone who can see this table can pull the file.
                      Filename pre-validated server-side via the
                      `_FILENAME_RE`, but encodeURIComponent here too
                      for belt-and-braces. */}
                  <a
                    href={api.backupDownloadUrl(s.filename)}
                    download={s.filename}
                    title={ts.download.buttonHint}
                    className="mr-2 px-2 py-0.5 text-[11px] rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 inline-block"
                  >
                    {ts.download.button}
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setRestoreResult(null);
                      setConfirming(s);
                    }}
                    title={ts.restore.buttonHint}
                    className="mr-2 px-2 py-0.5 text-[11px] rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                  >
                    {ts.restore.button}
                  </button>
                  {/* Manual delete (added 2026-05-27). Confirms
                      inline (no modal) since the action is reversible-
                      ish: the snapshot is gone, but other snapshots
                      remain. The native confirm() is sufficient
                      friction for the "did I really mean that file?"
                      check. */}
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          ts.deleteRow.confirm(s.filename),
                        )
                      ) {
                        return;
                      }
                      try {
                        await api.deleteBackup(s.filename);
                        setRestoreResult({
                          ok: true,
                          message: ts.deleteRow.done(s.filename),
                        });
                        onRestored(); // reuse the parent's reload hook
                      } catch (e) {
                        const msg =
                          e instanceof Error ? e.message : String(e);
                        setRestoreResult({
                          ok: false,
                          message: `${ts.deleteRow.failed}: ${msg}`,
                        });
                      }
                    }}
                    title={ts.deleteRow.buttonHint}
                    className="px-2 py-0.5 text-[11px] rounded border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  >
                    {ts.deleteRow.button}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirming && (
        <RestoreConfirmModal
          snapshot={confirming}
          onCancel={() => setConfirming(null)}
          onDone={(result) => {
            setConfirming(null);
            setRestoreResult(result);
            if (result.ok) onRestored();
          }}
        />
      )}
    </div>
  );
}

function RestoreConfirmModal({
  snapshot,
  onCancel,
  onDone,
}: {
  snapshot: BackupSnapshot;
  onCancel: () => void;
  onDone: (result: { ok: boolean; message: string }) => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.backups.restore;
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.restoreBackup(snapshot.filename);
      onDone({
        ok: true,
        message: ts.successBanner(r.restored_from, r.prerestore_snapshot),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Stay open so the user can read the error and retry/cancel.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          {ts.modalTitle}
        </h3>
        <div className="text-xs text-neutral-700 dark:text-neutral-300 space-y-1">
          <div>
            <span className="text-neutral-500">{ts.fileLabel}:</span>{" "}
            <code className="font-mono">{snapshot.filename}</code>
          </div>
          <div>
            <span className="text-neutral-500">{ts.sizeLabel}:</span>{" "}
            {(snapshot.size_bytes / 1024 / 1024).toFixed(1)} MB
          </div>
          <div>
            <span className="text-neutral-500">{ts.createdLabel}:</span>{" "}
            {new Date(snapshot.created_at).toLocaleString()}
          </div>
        </div>
        <div className="text-xs text-neutral-600 dark:text-neutral-300 leading-snug border-l-4 border-amber-400 pl-2 py-1 bg-amber-50/40 dark:bg-amber-950/20">
          {ts.warning}
        </div>
        <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>{ts.ackLabel}</span>
        </label>
        {error && (
          <div className="text-xs text-rose-600 dark:text-rose-400 break-words">
            {ts.failPrefix}: {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!acknowledged || busy}
            className="text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? ts.restoring : ts.confirmButton}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Remote (S3/B2/R2) sub-form ------------------------------------------

type RemoteFormState = {
  enabled: boolean;
  provider_label: string;
  endpoint_url: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  prefix: string;
};

function RemoteBackupSection({
  initial,
  onSaved,
}: {
  initial: RemoteBackupConfig;
  onSaved: () => void;
}) {
  const { t } = useT();
  const ts = t.pages.settings.backups.remote;

  const [form, setForm] = useState<RemoteFormState>({
    enabled: initial.enabled,
    provider_label: initial.provider_label,
    endpoint_url: initial.endpoint_url,
    region: initial.region,
    bucket: initial.bucket,
    // Empty strings on the inputs mean "unchanged" on submit (the
    // backend respects this convention so we don't have to round-trip
    // the secret to the browser).
    access_key_id: "",
    secret_access_key: "",
    prefix: initial.prefix,
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [maskedKey, setMaskedKey] = useState(initial.access_key_id);
  const [maskedSecret, setMaskedSecret] = useState(initial.secret_access_key);

  function set<K extends keyof RemoteFormState>(k: K, v: RemoteFormState[K]) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const patch: Partial<RemoteBackupSetPayload> = {
        enabled: form.enabled,
        provider_label: form.provider_label,
        endpoint_url: form.endpoint_url,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix,
        // Empty strings mean "leave unchanged" on the backend; only
        // include the secret fields when the user actually typed a value
        // so a save that doesn't touch them keeps the stored value.
        ...(form.access_key_id ? { access_key_id: form.access_key_id } : {}),
        ...(form.secret_access_key
          ? { secret_access_key: form.secret_access_key }
          : {}),
      };
      const updated = await api.setRemoteBackup(patch);
      setMaskedKey(updated.access_key_id);
      setMaskedSecret(updated.secret_access_key);
      setForm((s) => ({ ...s, access_key_id: "", secret_access_key: "" }));
      setSavedAt(new Date().toLocaleTimeString());
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const r = await api.testRemoteBackup();
      setTestResult(ts.testOk(r.bucket));
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  const placeholderForKey = maskedKey.set
    ? `••••${maskedKey.last4} (${maskedKey.length} ${ts.charsSuffix}) — ${ts.unchangedHint}`
    : ts.notSet;
  const placeholderForSecret = maskedSecret.set
    ? `••••${maskedSecret.last4} (${maskedSecret.length} ${ts.charsSuffix}) — ${ts.unchangedHint}`
    : ts.notSet;

  return (
    <div className="space-y-3 rounded border border-neutral-200 dark:border-neutral-700 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{ts.heading}</h3>
        <label className="inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          {ts.enabledLabel}
        </label>
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        {ts.intro}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label={ts.providerLabel} hint={ts.providerHint}>
          <input
            type="text"
            value={form.provider_label}
            onChange={(e) => set("provider_label", e.target.value)}
            placeholder="e.g. Backblaze B2"
            className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.endpointLabel} hint={ts.endpointHint}>
          <input
            type="text"
            value={form.endpoint_url}
            onChange={(e) => set("endpoint_url", e.target.value)}
            placeholder="https://s3.us-east-005.backblazeb2.com"
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.regionLabel} hint={ts.regionHint}>
          <input
            type="text"
            value={form.region}
            onChange={(e) => set("region", e.target.value)}
            placeholder="us-east-005"
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.bucketLabel} hint={ts.bucketHint}>
          <input
            type="text"
            value={form.bucket}
            onChange={(e) => set("bucket", e.target.value)}
            placeholder="my-drop-sherlock-backups"
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.accessKeyLabel} hint={ts.secretsHint}>
          <input
            type="text"
            autoComplete="off"
            value={form.access_key_id}
            onChange={(e) => set("access_key_id", e.target.value)}
            placeholder={placeholderForKey}
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.secretKeyLabel} hint={ts.secretsHint}>
          <input
            type="password"
            autoComplete="new-password"
            value={form.secret_access_key}
            onChange={(e) => set("secret_access_key", e.target.value)}
            placeholder={placeholderForSecret}
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
        <Field label={ts.prefixLabel} hint={ts.prefixHint}>
          <input
            type="text"
            value={form.prefix}
            onChange={(e) => set("prefix", e.target.value)}
            placeholder="drop-sherlock/"
            className="w-full px-2 py-1 text-xs font-mono rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          {saving ? t.common.loading : t.common.save}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          {testing ? t.common.loading : ts.testBtn}
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            {t.common.saved} ({savedAt})
          </span>
        )}
        {testResult && (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            {testResult}
          </span>
        )}
        {testError && (
          <span className="text-xs text-rose-600 dark:text-rose-400">
            {ts.testFail}: {testError}
          </span>
        )}
        {saveError && (
          <span className="text-xs text-rose-600 dark:text-rose-400">
            {t.common.error}: {saveError}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <div className="font-medium text-neutral-700 dark:text-neutral-300 mb-0.5">
        {label}
      </div>
      {children}
      {hint && (
        <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
          {hint}
        </div>
      )}
    </label>
  );
}
