# Traefik-fronted deployment

Slots Drop Sherlock into a shared Traefik proxy that already handles
TLS, IP whitelisting (VPN-only), and routing for other tools on the
same VPS. This mode does NOT expose host ports — only Traefik is
reachable from outside.

Mirrors the `tool-1` (nginx-backed) pattern in the existing Traefik
config, except Drop Sherlock's internal reverse proxy is **Caddy**
(already part of the stack), not nginx.

```
client → Traefik (TLS + IP whitelist) → Caddy (basicauth + headers) → api + web
```

---

## Prerequisites

- A working Traefik instance on the VPS with:
  - `websecure` entryPoint terminating TLS for public clients.
  - `allow-vpn-only` middleware (IP whitelist).
  - `insecure-backend` serversTransport (`insecureSkipVerify: true`).
  - An external Docker network named `traefik_proxy` that Traefik joins.
- DNS for the subdomain pointed at the VPS.

## Steps

### 1. Generate the self-signed cert for the Caddy ↔ Traefik hop

```bash
cd /opt/drop-sherlock
mkdir -p caddy-certs
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout caddy-certs/selfsigned.key \
  -out   caddy-certs/selfsigned.crt \
  -subj  "/CN=drop-sherlock.mrba-stage1.xyz"
chmod 600 caddy-certs/selfsigned.key
```

CN can be whatever you want — Traefik talks to this with
`insecureSkipVerify`, so it never validates. The 10-year expiry
(`-days 3650`) just means you won't have to regenerate often.

### 2. Configure `.env`

Same `.env` as the standalone deploy (see root `.env.example`), with
two tweaks:

```env
# Match the public URL Traefik routes to this stack. Caddy doesn't use
# SITE_HOST in Traefik mode (it listens on :443 unconditionally), but
# the value is read by some scripts and the `.env` sanity check.
SITE_HOST=drop-sherlock.mrba-stage1.xyz

# Tell the API which Origin headers to accept from the browser. Match
# the public Traefik hostname (https only — Traefik redirects from
# http if you have the redirect middleware).
CORS_ALLOW_ORIGINS=https://drop-sherlock.mrba-stage1.xyz
```

`HTTP_PORT` / `HTTPS_PORT` are ignored in this mode (no host port
mappings); you can leave them at their defaults.

### 3. Bring the stack up with the Traefik override

```bash
cd /opt/drop-sherlock
docker compose \
  -f docker-compose.yml \
  -f docker-compose.traefik.yml \
  up -d --build
```

The override:

- removes the `ports:` mapping on Caddy (no host ports);
- swaps the `Caddyfile` volume for `Caddyfile.traefik`;
- mounts `./caddy-certs` into the container at `/certs`;
- adds Caddy to the external `traefik_proxy` network so Traefik can
  reach `https://drop-sherlock-caddy:443`.

### 4. Add the router to Traefik

Append the snippet from
[`traefik-router.yml`](./traefik-router.yml) to your existing dynamic
Traefik config (the file that already defines `tool-1`,
`allow-vpn-only`, `insecure-backend`). Traefik picks it up
automatically.

Replace the placeholder `drop-sherlock.mrba-stage1.xyz` with the real
hostname.

### 5. Verify

From inside the VPN:

```bash
curl -u 'admin:YOUR-PASSWORD' -I https://drop-sherlock.mrba-stage1.xyz
# expected: 200 OK
```

From outside the VPN:

```bash
curl -I https://drop-sherlock.mrba-stage1.xyz
# expected: 403 Forbidden (Traefik's allow-vpn-only blocks)
# OR Connection timeout, depending on your edge config.
```

Inside the container, sanity-check that Caddy got the new config and
sees the certs:

```bash
docker compose logs --tail 50 caddy | grep -i error
docker compose exec caddy ls -l /certs
docker compose exec caddy cat /etc/caddy/Caddyfile | head -5
```

---

## Going back to standalone Caddy (host ports)

Just drop the `-f docker-compose.traefik.yml` flag and bring up again:

```bash
docker compose up -d
```

The base `Caddyfile` (with `{$SITE_HOST}` + auto-https) and host ports
are restored. The certs in `./caddy-certs/` and `Caddyfile.traefik`
sit unused — no cleanup needed.

---

## Updating the subdomain later

Three places to update if you rename the hostname:

1. **DNS** — repoint the A record.
2. **Traefik router** — `Host(\`new-name.example\`)` in
   `traefik-router.yml`.
3. **`.env`** — `SITE_HOST` (informational) and `CORS_ALLOW_ORIGINS`
   (functional — wrong value here will block browser fetches).

The self-signed cert's CN doesn't need to match — Traefik never
validates it. Regenerate only if you want the CN to look right when
inspecting the certificate manually.
