"""Off-box upload of SQLite snapshots to S3-compatible storage.

Works with anything that speaks the S3 API:
- AWS S3 (leave endpoint_url blank, set region)
- Backblaze B2 — endpoint like `https://s3.us-east-005.backblazeb2.com`
- Cloudflare R2 — endpoint like
  `https://<account_id>.r2.cloudflarestorage.com`
- Wasabi, MinIO, Ceph, etc.

Config lives in app_settings under the `remote_backup__*` namespace,
edited via Settings → Others UI. The secret key is masked when read
back to the browser (last4 + length only) so a screen-share doesn't
leak it.

Why we don't use boto3's session caching: backups run on a 24h cron in
the same process and the underlying httpx-based stack already pools
connections. Building a fresh boto3 client per upload (~100 ms) is
trivial against the multi-second snapshot + gzip cost, and avoids
having to invalidate cached clients when the user updates credentials
in Settings.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .app_settings import _get, _set
from .db import SessionLocal

log = logging.getLogger(__name__)

# All knobs are stored under this prefix. Listed explicitly here so the
# masking + setter loops have a single source of truth.
FIELDS = (
    "enabled",
    "provider_label",   # human-readable label like "Backblaze B2" — UI only
    "endpoint_url",     # blank for plain AWS S3
    "region",           # e.g. "us-east-1", "eu-central-003" (B2)
    "bucket",
    "access_key_id",
    "secret_access_key",
    "prefix",           # optional path inside the bucket, e.g. "drop-sherlock/"
)
SECRET_FIELDS = {"access_key_id", "secret_access_key"}


def _key(field: str) -> str:
    return f"remote_backup__{field}"


def get_config() -> dict[str, str]:
    """Raw config (full secrets included). Use only on the server side —
    never return this dict directly to the browser without masking."""
    db = SessionLocal()
    try:
        out: dict[str, str] = {}
        for f in FIELDS:
            out[f] = (_get(db, _key(f)) or "").strip()
        return out
    finally:
        db.close()


def get_config_masked() -> dict[str, Any]:
    """Browser-safe view: secrets are replaced by `{set: bool, last4: str,
    length: int}` so the UI can render "••••abcd (40 chars)" without
    knowing the secret. Non-secret fields are echoed in full."""
    raw = get_config()
    out: dict[str, Any] = {}
    for f in FIELDS:
        v = raw.get(f, "")
        if f in SECRET_FIELDS:
            out[f] = (
                {"set": True, "last4": v[-4:], "length": len(v)}
                if v
                else {"set": False, "last4": "", "length": 0}
            )
        elif f == "enabled":
            out[f] = v.lower() in ("1", "true", "yes", "on")
        else:
            out[f] = v
    return out


def set_config(values: dict[str, Any]) -> dict[str, Any]:
    """Persist any subset of `values`. Empty string for a secret field
    means "leave the existing value alone" (so the UI can submit the
    whole form without re-typing the secret); pass `null` (None) to
    explicitly clear it. Booleans for `enabled` are normalized to
    "true"/"false" strings."""
    db = SessionLocal()
    try:
        for f, v in values.items():
            if f not in FIELDS:
                # Silently ignore unknown keys — keeps the API forgiving
                # if the frontend ships a field the backend doesn't know.
                continue
            if f == "enabled":
                if v is None:
                    _set(db, _key(f), "")
                else:
                    _set(db, _key(f), "true" if bool(v) else "false")
                continue
            if f in SECRET_FIELDS:
                if v is None:
                    _set(db, _key(f), "")
                elif isinstance(v, str) and v.strip() == "":
                    # Empty string = no change (don't clobber existing secret).
                    continue
                else:
                    _set(db, _key(f), str(v).strip())
                continue
            # Plain string fields.
            if v is None:
                _set(db, _key(f), "")
            else:
                _set(db, _key(f), str(v).strip())
    finally:
        db.close()
    return get_config_masked()


def is_enabled() -> bool:
    """True only when the toggle is on AND we have at least the minimum
    fields needed to attempt an upload. Avoids the embarrassment of the
    cron firing with half-configured creds and posting an error every day."""
    cfg = get_config()
    if cfg.get("enabled", "").lower() not in ("1", "true", "yes", "on"):
        return False
    required = ("bucket", "access_key_id", "secret_access_key")
    return all(cfg.get(f) for f in required)


def _build_client():
    """Construct a fresh boto3 S3 client from the current config. Imports
    boto3 lazily so the module is importable even when boto3 isn't
    installed (which shouldn't happen given requirements.txt, but keeps
    the failure mode obvious)."""
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError as e:
        raise RuntimeError(
            f"boto3 is not installed; cannot upload backups: {e}"
        ) from e
    cfg = get_config()
    if not cfg.get("bucket"):
        raise RuntimeError("remote backup: bucket is not configured")
    if not cfg.get("access_key_id") or not cfg.get("secret_access_key"):
        raise RuntimeError("remote backup: credentials are not configured")

    boto_cfg = BotoConfig(
        # Path-style is safer for non-AWS providers (B2, R2, MinIO) where
        # virtual-hosted-style requires DNS support that the user might
        # not have set up. AWS S3 also accepts path-style.
        s3={"addressing_style": "path"},
        retries={"max_attempts": 3, "mode": "standard"},
    )
    kwargs: dict[str, Any] = {
        "service_name": "s3",
        "config": boto_cfg,
        "aws_access_key_id": cfg["access_key_id"],
        "aws_secret_access_key": cfg["secret_access_key"],
    }
    if cfg.get("region"):
        kwargs["region_name"] = cfg["region"]
    if cfg.get("endpoint_url"):
        kwargs["endpoint_url"] = cfg["endpoint_url"]
    return boto3.client(**kwargs), cfg


def _object_key(filename: str) -> str:
    cfg = get_config()
    prefix = cfg.get("prefix", "").strip("/")
    if prefix:
        return f"{prefix}/{filename}"
    return filename


def upload_snapshot(local_path: str, *, filename: str | None = None) -> dict:
    """Upload a single file to the configured bucket. Returns a result
    dict with `bucket`, `key`, `size_bytes`. Raises RuntimeError on any
    failure (boto3 / botocore exceptions are wrapped to keep the public
    API single-purpose)."""
    client, cfg = _build_client()
    if filename is None:
        filename = os.path.basename(local_path)
    key = _object_key(filename)
    try:
        client.upload_file(local_path, cfg["bucket"], key)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"remote upload failed: {e}") from e
    size = os.path.getsize(local_path) if os.path.exists(local_path) else 0
    log.info(
        "uploaded backup to %s/%s (%d bytes)", cfg["bucket"], key, size,
    )
    return {"bucket": cfg["bucket"], "key": key, "size_bytes": size}


def test_connection() -> dict:
    """Try a no-op `head_bucket` against the configured target. Returns
    `{ok: True, bucket: ...}` on success; raises RuntimeError on auth /
    network / permission failures with a useful message in the exception."""
    client, cfg = _build_client()
    try:
        client.head_bucket(Bucket=cfg["bucket"])
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"connection test failed: {e}") from e
    return {"ok": True, "bucket": cfg["bucket"], "region": cfg.get("region", "")}
