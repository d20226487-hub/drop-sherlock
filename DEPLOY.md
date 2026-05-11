# Deploying Drop Sherlock to an internal VPS

A single-tenant Docker stack (api + web + Caddy). Designed for a LAN-grade box
behind a perimeter, not for the open internet. This runbook is the path you
should follow the first time, and the recipes you'll come back to for
updates, restores, and migrations.

> The user-facing Russian documentation lives at `/docs` inside the running app.
> This file is the **ops** runbook — it stays in the repo and is for whoever
> deploys / maintains the box. English by convention.

---

## 1. Prerequisites

### VPS sizing

| Resource | Minimum  | Comfortable |
| -------- | -------- | ----------- |
| vCPU     | 2        | 2–4         |
| RAM      | 2 GB     | 4 GB        |
| Disk     | 10 GB    | 20–50 GB    |
| Network  | LAN/VPN  | LAN/VPN     |

Reality check: Drop Sherlock is I/O-bound (HTTP to Ahrefs + AI providers, SQLite
writes). 2 vCPU / 2 GB handles single-user load just fine. Disk grows with
Ahrefs JSON snapshots — budget ~100 KB per analyzed domain × however many you
plan to keep in history.

### Software

- **Docker Engine 24+** with **Docker Compose v2** (the `docker compose` plugin,
  not the legacy `docker-compose` binary).
- A non-root user with `docker` group membership.
- Outbound HTTPS access to: Ahrefs API, your chosen AI providers (OpenAI,
  Anthropic, Google, etc.), `web.archive.org` (Wayback CDX + V2 sampling),
  optionally your S3-compatible backup endpoint.

### Network

- The box must NOT expose ports `8000` (api) or `3000` (web) to anything
  outside the Docker network. Only Caddy's port (8081/HTTP or 8444/HTTPS by
  default; configurable) should be reachable.
- For a real DNS name + TLS, point an internal record (`drop-sherlock.lan` or
  similar) at the box. Caddy can auto-issue from your internal CA if you wire
  it; otherwise plain HTTP on the VPN is acceptable for an internal tool.

---

## 2. One-time deploy

### 2.1. Get the code on the box

```bash
# pick one
ssh vps "mkdir -p /opt/drop-sherlock"
rsync -avz --exclude data --exclude node_modules --exclude .next \
  drop-sherlock/ vps:/opt/drop-sherlock/

# or, if it's in a private git remote:
ssh vps "git clone <repo-url> /opt/drop-sherlock"
```

### 2.2. Build `.env`

```bash
ssh vps
cd /opt/drop-sherlock
cp .env.example .env
```

Edit `.env`. **Required** values to fill:

#### `BASIC_AUTH_USERNAME` + `BASIC_AUTH_PASSWORD_HASH`

Generate a fresh bcrypt hash (DO NOT reuse the dev password):

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOUR-STRONG-PASSWORD'
# pastes a line like: $2a$14$abc...
```

Paste into `.env` **with every `$` doubled to `$$`** — Compose interpolates
`$VAR` references inside `env_file` values:

```env
BASIC_AUTH_USERNAME=admin
BASIC_AUTH_PASSWORD_HASH=$$2a$$14$$abc...
```

#### `FERNET_KEYS`

Encrypts provider API keys + S3 credentials at rest in SQLite. Generate one:

```bash
docker run --rm python:3.12-slim sh -c \
  "pip install -q cryptography && python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
# prints a base64 string like: aB7..._=
```

Two options:

- **Recommended for VPS** — set `FERNET_KEYS=<the-key>` in `.env`. The key lives
  in env (or your secret manager), separate from the DB on disk.
- **Or do nothing** — leave `FERNET_KEYS=` blank. On first boot the app
  auto-generates a key at `/data/.fernet_key` (mode 600). Simpler, but the key
  ends up in the same volume as the DB; off-box backups of the volume must be
  treated as confidential.

**Critical:** whichever you pick, **back the key up separately** from the DB.
Lose both and the encrypted secrets are gone.

#### `SITE_HOST`

For LAN HTTP: `:80` (default).
For a real hostname with TLS: `drop-sherlock.lan` (Caddy will try to auto-issue;
needs DNS pointing at the box and outbound 443 for ACME if using a real CA).

#### `HTTP_PORT` / `HTTPS_PORT`

Defaults `8081` / `8444` were chosen for dev coexistence with other projects.
On a dedicated VPS, use `80` / `443`.

#### `CORS_ALLOW_ORIGINS`

Comma-separated. Set to your real URL. Examples:

```env
CORS_ALLOW_ORIGINS=https://drop-sherlock.lan
# or
CORS_ALLOW_ORIGINS=http://drop-sherlock.lan,https://drop-sherlock.lan
```

Do NOT leave `*` in production.

#### Optional bootstrap API keys

`AHREFS_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_MODELS_TOKEN`
can be set here for first-run convenience. They're used as a fallback ONLY when
no value is set in the Settings UI. Once you enter keys in the UI, they're
stored encrypted in SQLite and the env values become inert.

### 2.3. Build + start

```bash
docker compose build
docker compose up -d
docker compose ps    # all three should be "Up (healthy)" within ~60 s
```

### 2.4. First-time setup in the UI

Visit `https://drop-sherlock.lan` (or whatever URL you set). Browser will
prompt for basic auth — use `BASIC_AUTH_USERNAME` and the plaintext password
you hashed in 2.2.

Then in the running app:

1. **Settings → API** — enter Ahrefs API token and at least one AI provider
   key. Each save writes the encrypted value to SQLite immediately.
2. **Settings → API → Pricing** — for each model you'll use, set
   input/output prices per million tokens. Without these, the $ totals on
   runs will show "missing pricing" warnings.
3. **Settings → Brain** — optional. Default prompts and scoring weights ship
   sane; tune only if you have a reason.
4. **Settings → Wayback** — if you'll use Wayback Classify, set up your
   pre-defined categories list.
5. **Settings → Other → Backups** — see §4 below.

---

## 3. Verification checklist

After 2.3, before letting users in:

```bash
# 1. healthcheck (inside the box)
curl -u 'admin:YOUR-PASSWORD' http://localhost/api/health
# expected: {"ok":true}

# 2. encrypted secrets in DB (after you enter at least one provider key in
#    Settings UI). Should see Fernet token prefixes, never raw keys.
docker exec drop-sherlock-api-1 python -c "
import sqlite3
con = sqlite3.connect('/data/drop_sherlock.db')
for r in con.execute('SELECT key, substr(value,1,12) FROM app_settings WHERE key LIKE \"%api_key%\" OR key LIKE \"%token%\"'):
    print(r)"
# Each non-empty value should start with 'gAAAAABr…'.

# 3. fernet key actually exists somewhere
docker exec drop-sherlock-api-1 sh -c \
  'env | grep FERNET_KEYS || ls -la /data/.fernet_key'

# 4. external port check (FROM A DIFFERENT BOX on the same network)
curl -u 'admin:YOUR-PASSWORD' -I https://drop-sherlock.lan/api/health

# 5. port 8000 and 3000 must be UNREACHABLE from outside the docker network
curl --max-time 3 http://drop-sherlock.lan:8000/api/health
# expected: Connection refused / timeout. If you get a response, your
# firewall is wrong — fix immediately.
```

Smoke test the UI: open `/analyze`, submit one cheap domain, watch it
complete. The run should appear under `/jobs`. If the AI verdict comes back
empty, check `/errors` for clues (usually a wrong API key or no pricing row).

---

## 4. Backups

### 4.1. Local rotation (in-app)

`Settings → Other → Backups`. Enable, set:

- **Schedule** — daily is sane.
- **Local path** — defaults to `/data/backups/` (inside container, lives on
  the host volume).
- **Rotation** — keep last N. 7–14 is reasonable.

### 4.2. Off-box (S3-compatible)

Same settings panel, S3 section. Works with AWS S3, Backblaze B2, Cloudflare R2,
Wasabi, MinIO. Fill: endpoint URL, region, bucket, access key, secret key,
prefix.

The S3 upload sends ONLY the `.db` snapshot — the Fernet key file is NOT
uploaded. That's the intended protection: an attacker who steals the backup
gets an encrypted DB but no key to decrypt the provider credentials in it. So
**do not** ad-hoc rsync the whole `/data` volume to the same S3 bucket — that
would defeat the encryption.

### 4.3. Restore drill (do this once before you need it)

```bash
# 1. on the VPS, snapshot a current backup as the "good known"
ls -lt /opt/drop-sherlock/data/backups/   # pick the newest .db

# 2. on a SEPARATE test box (not prod):
mkdir -p /tmp/ds-restore/data
cp /path/to/drop_sherlock-2026-05-11T03-00-00Z.db /tmp/ds-restore/data/drop_sherlock.db
cp /opt/drop-sherlock/data/.fernet_key /tmp/ds-restore/data/    # if using file-key mode
cp -r /opt/drop-sherlock/{docker-compose.yml,Caddyfile,backend,frontend,.env.example} /tmp/ds-restore/
cp /opt/drop-sherlock/.env /tmp/ds-restore/    # or build a new one
cd /tmp/ds-restore
docker compose up -d --build

# 3. log in via basicauth, verify provider keys decrypt (UI shows masked but
#    valid status, test-connection works), spot-check a job + domain.
```

If you skipped step 2's `.fernet_key` copy and `.env` doesn't have
`FERNET_KEYS`, the app boots but provider keys come back blank (decryption
failed silently per crypto.py:decrypt) — re-enter via UI.

---

## 5. Updates and redeploys

### 5.1. Code update

```bash
ssh vps
cd /opt/drop-sherlock

# preserve data/ and .env — never overwrite them
rsync -avz --exclude data --exclude .env --exclude node_modules --exclude .next \
  --delete --delete-excluded \
  local-path/drop-sherlock/ vps:/opt/drop-sherlock/

# rebuild only what changed
docker compose up -d --build api web
# 10–30 s downtime per service while the new image swaps in.
# DB migrations run automatically at api startup (see main.py:lifespan).
```

### 5.2. Dependency-only update

Same as 5.1; the Dockerfiles re-pull on rebuild. Don't run `npm install` or
`pip install` directly on the host — keep everything inside the containers.

### 5.3. Validate after redeploy

```bash
docker compose ps                                  # all healthy
docker compose logs --tail 100 api | grep -i error # nothing fresh
curl -u 'admin:PASS' http://localhost/api/health   # 200
```

---

## 6. Rollback

If a redeploy goes bad:

```bash
ssh vps
cd /opt/drop-sherlock

# Option A: revert the code + rebuild
git checkout <previous-good-commit>     # if you deployed via git
docker compose up -d --build api web

# Option B: if you replaced the code via rsync and don't have the old tree,
# restore from the most recent local backup (covers the DB; the code you have
# to redeploy separately):
docker compose stop api
cp data/backups/drop_sherlock-<TIMESTAMP>.db data/drop_sherlock.db
docker compose start api
```

**DB schema is forward-compatible by design**: starting an older `api` against
a newer DB usually works, because the migration runner only adds columns —
it doesn't drop them. Going the other direction (newer api, older DB) is also
safe — the same migrations re-run idempotently. But if you've made
schema-breaking changes manually outside the migration runner, your mileage
will vary.

---

## 7. Migration to a new VPS

The whole stack is in:

- `docker-compose.yml`, `Caddyfile`, `backend/`, `frontend/`, `.env.example`
  (code — version-controlled).
- `data/drop_sherlock.db` (DB — backed up).
- `data/.fernet_key` (encryption key — backed up separately, if using file-key
  mode).
- `.env` (your basicauth hash + FERNET_KEYS + CORS + ports — back this up
  somewhere safe, or rebuild from scratch following §2.2).

Migration sequence:

```bash
# on the OLD box
cd /opt/drop-sherlock
docker compose stop api                # quiesce writes
tar czf /tmp/ds-migrate.tar.gz \
  docker-compose.yml Caddyfile backend frontend .env.example .env \
  data/drop_sherlock.db data/.fernet_key
# scp /tmp/ds-migrate.tar.gz new-vps:/tmp/

# on the NEW box
mkdir -p /opt/drop-sherlock
tar xzf /tmp/ds-migrate.tar.gz -C /opt/drop-sherlock
cd /opt/drop-sherlock
# (review .env — fix CORS_ALLOW_ORIGINS if hostname changes)
docker compose up -d --build
docker compose ps                       # all healthy
```

If `.fernet_key` was lost in transit, the new box boots with a fresh
auto-generated key — your encrypted provider keys can't decrypt. You'll have
to re-enter them via the Settings UI (one-time inconvenience, not data loss).

---

## 8. Troubleshooting

| Symptom                                        | Likely cause                                       | Fix                                                                                       |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Browser shows Caddy "Authentication required" loop | wrong username or password                         | Re-check that you hashed the right password. The `$$` escaping in `.env` is a common gotcha. |
| `api` container restarts in a loop             | likely SQLite locked or migration crash            | `docker compose logs api` — look for the exception just before the restart.               |
| `web` container healthy, but pages show "Failed to fetch" | CORS or basic auth misconfigured             | Verify `CORS_ALLOW_ORIGINS` matches the URL the browser is hitting (including scheme).    |
| Provider keys come back empty in Settings UI    | Fernet key changed and old data is unreadable      | Re-enter keys via UI. They'll be encrypted with the new key.                              |
| Long boot time after `docker compose up`        | first run: building frontend (`next build`) is slow | Normal. Subsequent boots reuse the image — ~10 s.                                         |
| Ahrefs requests fail with 401                  | invalid or expired API token                       | Update in Settings → API → Ahrefs.                                                        |
| AI judges fail with 429                        | provider rate limit                                | Wait, then `Retry failed` on the run page. Provider RPM is per-provider in Settings.       |
| Long-running run shows no progress in UI       | SSE blocked by something between browser and Caddy | App falls back to polling automatically, but if both fail, check your reverse-proxy chain.|

Logs:

```bash
docker compose logs -f api          # backend errors, AI/provider issues
docker compose logs -f web          # Next.js / frontend build issues
docker compose logs -f caddy        # auth and TLS issues
```

In-app errors:

- `/errors` page captures all stack traces and provider errors with full
  context. First place to check after any run failure.

---

## 9. Day-2 hygiene

- **Rotate the Fernet key** every 6–12 months. Steps in
  [/docs/backups](http://your-host/docs/backups#безопасность) (visible in the
  running app).
- **Rotate the basicauth password** when staff changes.
- **Audit `/errors`** weekly — recurring AI parse errors usually mean a
  provider quietly changed response format and the prompt needs a tweak.
- **Backup verify** monthly — actually restore one to a scratch directory and
  log in to it. The S3 upload working ≠ the file being intact.
- **Disk usage** — watch `/opt/drop-sherlock/data/` size. If you keep
  unlimited history, this grows. `Settings → Other → Retention` lets you
  prune old runs.

---

## 10. What's deliberately not included

So you don't go hunting:

- **Multi-user auth** — basic auth is the only authentication layer. There are
  no per-user accounts, roles, or audit logs.
- **Horizontal scaling** — single SQLite file. Migrating to Postgres would
  unlock multi-writer, but isn't supported out of the box.
- **CI/CD** — no GitHub Actions or similar in the repo. Deploys are manual
  (`rsync + docker compose up -d --build`). For a single-user tool that ships
  weekly, that's a feature, not a bug — but if you want CI, add it.
- **Metrics / observability** — no Prometheus, no Sentry, no centralized
  logs. Stdout from containers only.

If you find yourself wanting any of these, the question to ask first is "am I
still the only user?" — these all become important the moment you're not.
