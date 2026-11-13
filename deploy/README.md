# SimpleIM Production Delivery & Deployment

`deploy/` and `ops/` provide an immutable single-host Docker Compose delivery stack aligned with `zzqDeco/teamie`:

- **One persistent environment (`production`)**: `main` is the sole ongoing development branch; `release/vMAJOR.MINOR.PATCH` branches and `vMAJOR.MINOR.PATCH` tags are permanent immutable archives. Fixes land on `main` and cut a new semantic version.
- **`caddy`** (`caddy:2.11.7-alpine`): Public HTTPS + HTTP/3 termination (`default_sni` for IP-HTTPS clients without SNI), security headers, routing `/api/*`, `/ws/*`, and `/healthz` to `server:3000` and static SPA routes to `web:80`. Supports domain ACME (`deploy/tls/acme-domain.caddy`), Let's Encrypt short-lived public IP ACME (`deploy/tls/acme-ip.caddy`), and host-synced certificate files (`deploy/tls/certificate-files.caddy`, e.g., synced from `teamie-caddy-1` on `:8444` without touching ports `:80`/`:443`).
- **`server`** (`deploy/server.Dockerfile`, `oven/bun:1.4.4-alpine`): Runs `apps/server` as non-root `bun` on an `internal: true` Docker network with a single WAL-mode `bun:sqlite` volume (`/data/simpleim.sqlite`) storing exclusively `schema_migrations`, `users`, and `sessions`.
- **`web`** (`deploy/web.Dockerfile`, multi-stage `oven/bun:1.4.4-alpine` -> `nginx:1.28-alpine`): Serves the static React 19 + Web Worker (`Argon2id` + OPFS) bundle on the internal network, plus `/version.json` for release SHA verification.
- **`coturn`** (`coturn/coturn:4.6-alpine`, `--profile turn`): Self-hosted STUN (`:3478` UDP/TCP) + ephemeral HMAC-SHA1 TURN relay (`49152-49407/udp`, RFC1918 peer-IP denied, non-root `65534:65534`, read-only rootfs). TURN relays carry only DTLS-SRTP/SCTP + `HELLO_AUTH` fingerprint-pinned ciphertext.

## Automated Release Flow (`release/vX.Y.Z`)

1. Merge reviewed changes into `main` and ensure CI passes.
2. Push a new immutable semantic release branch pointing to `main`:
   ```bash
   git push origin main:refs/heads/release/v0.1.0
   ```
3. `.github/workflows/release.yml` executes:
   - **`validate`**: Verifies `release/vX.Y.Z` is newly created, non-forced, matches `main` SHA, and has no pre-existing tag.
   - **`verify`**: Runs the full CI suite (7 TypeScript project checks, Clean Architecture boundaries, 65 unit/mesh/Swarm tests, Playwright Chromium <-> `werift` CLI E2E, and Docker/Caddy/Compose validation).
   - **`images`**: Publishes images to Aliyun ACR (when `ACR_*` variables + `ACR_PUSH_PASSWORD` are configured) or GHCR + portable offline image bundle (`simpleim-images.tar.gz` for Mainland China ECS hosts without Docker Hub/GHCR pull dependencies), and compiles standalone `simpleim-linux-x64` CLI binary.
   - **`manifest`**: Writes `release-manifest.json` pinning version, 40-char commit SHA, SQLite schema version, and image references.
   - **`deploy`**: Connects over pinned-host SSH (`simpleim-deploy` user, `StrictHostKeyChecking=yes`) to `/srv/simpleim`, syncs TLS certificates, takes a pre-deploy online SQLite backup, rolls out Compose, verifies container health + `/api/v1/version` + `/version.json` + zero-room-persistence SQLite tables + trusted public HTTPS probes, and atomically flips `/srv/simpleim/current` (or auto-restores `previous` on failure).
   - **`publish`**: Creates permanent tag `vX.Y.Z` and GitHub Release attaching `release-manifest.json`, `simpleim-linux-x64`, and `SHA256SUMS`.

## Rollback

Trigger **Roll back production images** (`.github/workflows/rollback.yml`) via `workflow_dispatch` on `main` with `version` (`vX.Y.Z`) and `expected_current_sha`. Rollback activates only previously verified manifests in `/srv/simpleim/archives/` with compatible `sqliteSchemaVersion`.

## Host Bootstrap & SQLite Online Backup

On a new Debian/Ubuntu x86_64 host, run once as `root`:

```bash
sudo PUBLIC_HOST_IP=<ECS_PUBLIC_IP> PUBLIC_HTTPS_PORT=8444 ENABLE_COTURN=true bash ops/bootstrap.sh
```

Online WAL-safe SQLite backups run automatically before every replacement deployment and on demand via:

```bash
bash /srv/simpleim/current/ops/backup.sh
```
