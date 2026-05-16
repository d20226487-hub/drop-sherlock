# Drop Sherlock

AI-assisted dropped-domain triage. Ahrefs (4 criteria) + Wayback CDX + AI judges (Gemini / GitHub Models / OpenRouter) for verdicting; backlog queue + manual definitive-run pinning + per-domain pages on top.

Single-user-design tool used by 2-5 colleagues on LAN. Stack: FastAPI 0.115 + SQLAlchemy 2.0 + APScheduler 3.10 + SQLite on the backend, Next.js 15.5 + Tailwind 3.4 on the frontend, custom en/ru i18n layer.

## Layout

```
backend/    FastAPI app (config, db, scheduler, providers, routers, tests)
frontend/   Next.js app (pages, components, lib)
data/       SQLite DB (mounted volume — gitignored)
Caddyfile   Reverse proxy + security headers
docker-compose.yml
.env.example
```

## First-time setup

```bash
cd drop-sherlock
cp .env.example .env

# REQUIRED: generate a bcrypt hash for the basic-auth password.
# (Caddy enforces auth on every request — without these, it won't start.)
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOUR-PASS'

# Paste the output (starts with $2a$) as BASIC_AUTH_PASSWORD_HASH in .env.
# IMPORTANT: escape every $ as $$ in the .env value, e.g.:
#   BASIC_AUTH_PASSWORD_HASH=$$2a$$14$$abc...
# (Docker Compose interpolates $VAR in env_file values; $$ is literal $.)

# Optional: also set CORS_ALLOW_ORIGINS to your deploy URL,
# and any API keys (those can also be set later in the Settings UI).

docker compose up -d --build
```

On first hit you'll get a browser auth prompt. Same credential is shared by the team — there's no per-user account model. To rotate, regenerate the hash and restart Caddy: `docker compose restart caddy`.

Open **http://localhost:8081** (Caddy reverse-proxy entry point).

First boot creates the SQLite DB at `data/drop_sherlock.db` and runs all migrations idempotently. Subsequent boots are instant.

### Host ports (chosen to avoid conflicts with other tools on the same host)

| service              | host port | notes                                |
|----------------------|-----------|--------------------------------------|
| Caddy (entry)        | **8081**  | the only port your colleagues hit    |
| Caddy HTTPS          | 8444      | unused locally                       |
| Backend uvicorn      | 8001      | direct API access (debug only)       |
| Frontend Next dev    | 3001      | for `npm run dev` outside Docker     |

Inside Docker, the api+web containers use 8000/3000; only Caddy is host-bound.

## Configuration

All settings have sensible defaults. The few you'll likely touch:

| env var                | default                     | meaning                                                              |
|------------------------|-----------------------------|----------------------------------------------------------------------|
| `CORS_ALLOW_ORIGINS`   | `http://localhost:8081,...` | Comma-separated list of origins allowed to call the API. **Set this to your actual deploy URL** before pointing colleagues at it. Leave default for local dev. |
| `SITE_HOST`            | (Caddy default)             | Domain Caddy listens on. For LAN, e.g. `drop-sherlock.lan:8081`.     |
| `AHREFS_API_KEY`, etc. | empty                       | Bootstrap credentials. The Settings UI override always wins at runtime — recommended path is to leave these empty in `.env` and configure via the UI. |

Other knobs (rate limits, AI defaults, error retention, scoring weights, etc.) live in the Settings UI under **API**, **Brain**, **Wayback classification**, and **Others** tabs.

Per-criterion deep-dives live inside the app under **/docs** — sidebar-navigable, Russian-only by design (single source of truth regardless of UI language).

## Deploying / updating on the VPS

```bash
# Pull latest from GitHub
git pull

# Rebuild and recreate containers (preserves data/)
docker compose up -d --build

# Watch the logs (api + web combined)
docker compose logs -f api web
```

Migrations run automatically on `lifespan` startup. In-flight runs that were `running` at restart get auto-paused with a "Process restarted" message — click **Resume** in the UI to pick them back up (cached criteria + AI verdicts are reused).

## Backup

The SQLite DB at `data/drop_sherlock.db` holds everything (jobs, runs, AI verdicts, backlog, settings, error log). One file → one rsync away from a full restore.

**Recommended: nightly cron on the host.**

```bash
# /etc/cron.daily/drop-sherlock-backup
#!/bin/bash
set -euo pipefail
BACKUP_DIR=/var/backups/drop-sherlock
DB=/path/to/drop-sherlock/data/drop_sherlock.db
mkdir -p "$BACKUP_DIR"
# `.backup` uses SQLite's online backup API — safe to run while the
# app is writing. Don't `cp` the .db file directly while WAL is active.
sqlite3 "$DB" ".backup '$BACKUP_DIR/drop_sherlock-$(date +%F).db'"
# Keep 14 days of dailies.
find "$BACKUP_DIR" -name 'drop_sherlock-*.db' -mtime +14 -delete
```

Restore is just `cp` the backup file over `data/drop_sherlock.db` and restart the api container.

If `data/` ever fills the disk while a job is running, the DB write fails and the run is marked failed; restarting the api container is safe once you've freed space. WAL mode (enabled by default) keeps writes recoverable even on hard crashes.

## Tests

```bash
docker compose exec api pytest
```

Currently covers the deterministic final-score math (the area most likely to silently produce wrong numbers if anyone messes with the weight-renormalization). Other layers are tested by hand-driving the UI.

## Bare-metal dev (without Docker)

```bash
# Backend on 8001
cd backend
python -m venv .venv
.venv\Scripts\activate           # Windows; or `source .venv/bin/activate` on *nix
pip install -r requirements.txt
mkdir -p data
uvicorn app.main:app --reload --port 8001

# Frontend on 3001 (separate terminal)
cd frontend
npm install
npm run dev
```

Frontend dev server expects the API at `http://localhost:8001/api` — set `NEXT_PUBLIC_API_BASE=http://localhost:8001` in `.env.local` if you're not using the Caddy reverse-proxy path.

## Status

All planned features shipped. See [`memory/project_drop_sherlock.md`](../memory/project_drop_sherlock.md) (in the user's local notes, not the repo) for the running feature ledger.
