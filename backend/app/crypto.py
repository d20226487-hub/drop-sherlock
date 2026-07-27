"""At-rest encryption for sensitive `app_settings` rows.

Provider API keys, AI tokens, and S3 backup credentials live in SQLite —
which is fine for a single-user LAN deploy, but means anyone who
exfiltrates `data/drop_sherlock.db` gets those keys directly. Fernet
encrypts them at rest so the DB file alone isn't enough.

Key bootstrap (first match wins):

1. `FERNET_KEYS` env var — comma-separated; first key is primary
   (used for new writes), the rest decrypt legacy data so a rotation
   doesn't break access mid-flight.
2. `/data/.fernet_key` — single-line key file. Persists across container
   restarts (same volume as the DB). Auto-generated on first boot if
   neither (1) nor (2) is set; a warning is logged with backup
   instructions.

Why a key file inside `/data/`:
- Zero-config first boot — the user doesn't need to set env vars to get
  started, but encryption is still in place.
- The same persistent volume holds both the DB and the key, so a volume
  backup is either all-or-nothing — no "encrypted DB / missing key"
  half-state where data is permanently lost.
- S3 backups (see `remote_backup.py`) upload only the `.db` snapshot,
  NOT the key file. So an off-box leak of the backup is protected
  against — exactly the threat model we wanted to fix.
- Production deploys can override with `FERNET_KEYS` for stricter
  separation (key in env / secret manager, DB on disk).

Token format: Fernet outputs URL-safe base64 starting with `gAAAAA`.
We use that prefix to distinguish encrypted values from legacy plaintext
during the one-shot startup migration and during reads. Plaintext
values are returned as-is — the migration encrypts them lazily.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from .config import settings

log = logging.getLogger(__name__)

# Fernet tokens always start with this prefix (URL-safe base64 of the
# Fernet header byte 0x80). Used to distinguish encrypted values from
# legacy plaintext without trial-and-error decrypt.
_FERNET_PREFIX = "gAAAAA"

# Path on the persistent volume where the bootstrap key is stashed if
# `FERNET_KEYS` env is unset. The api container mounts `/data` as a
# volume — see docker-compose.yml. On host filesystems (dev runs) the
# parent should be created by the caller.
_KEY_FILE_PATH = Path("/data/.fernet_key")

_init_lock = threading.Lock()
_fernet: MultiFernet | None = None


def _read_key_file() -> str | None:
    """Read the key file if present and non-empty. Returns None when
    missing (caller decides whether to generate one)."""
    try:
        if not _KEY_FILE_PATH.exists():
            return None
        key = _KEY_FILE_PATH.read_text().strip()
        return key or None
    except OSError as e:
        log.warning("Could not read %s: %s", _KEY_FILE_PATH, e)
        return None


def _write_key_file(key: str) -> None:
    """Write a freshly-generated key to the bootstrap file. Parent dir
    must exist (it does in the docker container — `/data` is the
    volume mount root)."""
    try:
        _KEY_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _KEY_FILE_PATH.write_text(key + "\n")
        # Restrict perms — even on a shared host, this should be 600.
        # Best-effort; on Windows-mounted volumes chmod is a no-op.
        try:
            os.chmod(_KEY_FILE_PATH, 0o600)
        except OSError:
            pass
    except OSError as e:
        log.error("Could not write %s: %s", _KEY_FILE_PATH, e)
        raise


def _bootstrap_keys() -> list[bytes]:
    """Resolve the active Fernet key list. Returns at least one key.

    Raises RuntimeError only when all three sources fail (env unset AND
    key file unreadable AND auto-generation failed)."""
    # 1. Env wins. Supports rotation: comma-separated keys, primary first.
    env_csv = (settings.fernet_keys or "").strip()
    if env_csv:
        keys = [k.strip().encode() for k in env_csv.split(",") if k.strip()]
        if keys:
            log.info("Fernet: using %d key(s) from FERNET_KEYS env", len(keys))
            return keys

    # 2. Bootstrap key file.
    file_key = _read_key_file()
    if file_key:
        log.info("Fernet: using key from %s", _KEY_FILE_PATH)
        return [file_key.encode()]

    # 3. Auto-generate. First-boot path. Log loudly so the user knows to
    # back this up alongside DB snapshots.
    new_key = Fernet.generate_key().decode()
    _write_key_file(new_key)
    log.warning(
        "Fernet: generated a new key at %s (first boot). BACK THIS FILE UP "
        "alongside data/drop_sherlock.db — without it, encrypted provider "
        "secrets in the DB cannot be recovered. To use an env-managed key "
        "instead, copy the key into FERNET_KEYS=<key> and delete this file.",
        _KEY_FILE_PATH,
    )
    return [new_key.encode()]


def _get_fernet() -> MultiFernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    with _init_lock:
        if _fernet is not None:
            return _fernet
        keys = _bootstrap_keys()
        _fernet = MultiFernet([Fernet(k) for k in keys])
        return _fernet


def is_encrypted(value: str | None) -> bool:
    """True when the value looks like a Fernet token (was produced by
    `encrypt`)."""
    return isinstance(value, str) and value.startswith(_FERNET_PREFIX)


def encrypt(plaintext: str) -> str:
    """Encrypt with the primary key. Empty strings are passed through
    unchanged — they have nothing to protect and would otherwise be
    indistinguishable from "not set" after a round-trip."""
    if not plaintext:
        return plaintext
    token = _get_fernet().encrypt(plaintext.encode("utf-8"))
    return token.decode("utf-8")


def decrypt(value: str | None) -> str:
    """Inverse of encrypt. Legacy plaintext (not Fernet-prefixed) is
    returned as-is so the migration can run incrementally.

    On InvalidToken (most often: the key that originally encrypted this
    value is no longer in FERNET_KEYS) — we log and return empty
    string. Callers treat empty as "not set", which surfaces in the UI
    as a re-enter-credentials prompt — better than crashing the whole
    process on a missing key."""
    if not value:
        return value or ""
    if not is_encrypted(value):
        return value
    try:
        return _get_fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        log.error(
            "Fernet decrypt failed for token prefix %s... — the key that "
            "encrypted this value is not present in FERNET_KEYS (or the "
            "/data/.fernet_key file). Returning empty string; re-enter the "
            "credential in Settings to overwrite.",
            value[:16],
        )
        return ""


# --- Which app_settings keys carry secrets ---------------------------------
#
# Encryption is applied automatically by `app_settings._set` whenever the
# stored key ends with one of these suffixes. Adding a new suffix here is
# the only change needed to extend coverage to a new credential.

_SECRET_KEY_SUFFIXES: tuple[str, ...] = (
    "__api_key",         # gemini__api_key, openrouter__api_key, ahrefs__api_key, ...
    "__token",           # github_models__token, ...
    "__password",        # future provider that uses basic-auth-style creds
    "__access_key_id",   # remote_backup__access_key_id (S3)
    "__secret_access_key",  # remote_backup__secret_access_key (S3)
    "__proxy_list_url",     # webshare__proxy_list_url (embeds a Webshare download token)
)


def key_is_secret(key: str) -> bool:
    """Used by `_set` to decide whether to encrypt before persisting."""
    return any(key.endswith(s) for s in _SECRET_KEY_SUFFIXES)
