# SimpleIM Single-Host Production Deployment

`deploy/` provides a hardened single-host Docker Compose stack following SimpleIM's zero-knowledge central server architecture:

- **`caddy`** (`caddy:2.9-alpine`): Automatic TLS termination, HTTP/3 + HTTP/2, security headers, routing `/api/*`, `/ws/*`, and `/healthz` to `server:3000` and static SPA routes to `web:80`.
- **`server`** (`deploy/server.Dockerfile`, `oven/bun:1.4.4-alpine`): Runs `apps/server` as non-root `bun` on an `internal: true` Docker network with a single WAL-mode `bun:sqlite` volume (`/data/simpleim.sqlite`) storing exclusively `schema_migrations`, `users`, and `sessions`.
- **`web`** (`deploy/web.Dockerfile`, multi-stage `oven/bun:1.4.4-alpine` -> `nginx:1.28-alpine`): Serves the static React 19 + Web Worker (`Argon2id` + OPFS) bundle on the internal network.
- **`coturn`** (optional `--profile turn`): Ephemeral HMAC-SHA1 TURN relay for peers behind symmetric NATs. Note that TURN relays still carry only DTLS-SRTP/SCTP + `XChaCha20-Poly1305` ciphertext.

## Quick Start

1. Copy `.env.example` to `.env` (never commit `.env`):

   ```bash
   cp deploy/.env.example deploy/.env
   ```

2. Generate a persistent 32-byte `Ed25519` root signing seed for `SERVER_IDENTITY_PRIVATE_KEY`:

   ```bash
   openssl rand 32 | base64 | tr '+/' '-_' | tr -d '='
   ```

3. Set `SITE_ADDRESS` (e.g. `im.example.com`) and `ALLOWED_ORIGINS` (e.g. `https://im.example.com`) in `deploy/.env`.

4. Build and launch the stack:

   ```bash
   docker compose -f deploy/compose.production.yaml --env-file deploy/.env up -d --build
   ```

5. Optional: enable `coturn` if users connect across strict corporate symmetric NATs:

   ```bash
   cp deploy/turnserver.conf.example deploy/turnserver.conf
   # Edit deploy/turnserver.conf and deploy/.env with matching COTURN_SHARED_SECRET and COTURN_URLS
   docker compose -f deploy/compose.production.yaml --env-file deploy/.env --profile turn up -d
   ```

## SQLite Online Backup

Because `apps/server` runs `bun:sqlite` in `WAL` mode and stores only `users` and hashed `sessions` (`< 10 MiB` even for tens of thousands of accounts), back up safely without stopping the service using SQLite's online backup command:

```bash
docker run --rm -v simpleim_server_data:/data:ro -v "$PWD/backups:/backups" alpine:3.21 \
  sh -c "apk add --no-cache sqlite && sqlite3 /data/simpleim.sqlite '.backup /backups/simpleim-$(date +%Y%m%d-%H%M%S).sqlite'"
```
