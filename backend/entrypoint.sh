#!/bin/sh
# Entrypoint for the Drop Sherlock API container.
#
# Runs as root long enough to ensure /data (host-mounted SQLite volume) is
# writable by the app user, then drops to UID 10001 via gosu before exec'ing
# the real command. Same pattern as serp-monitor — keeps the long-lived
# uvicorn process unprivileged.

set -e

if [ -d /data ]; then
    chown -R app:app /data 2>/dev/null || true
fi

exec gosu app "$@"
