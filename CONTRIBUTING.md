# Contributing to SimpleIM

Before changing behavior, cryptography, or wire protocols, read:
- [`AGENTS.md`](AGENTS.md) — non-negotiable engineering, security, and privacy invariants
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — hybrid-P2P topology, trust boundaries, and delivery guarantees
- [`docs/contracts/signaling-v1.md`](docs/contracts/signaling-v1.md) — central HTTP identity & ephemeral WebSocket signaling contracts
- [`docs/contracts/p2p-v1.md`](docs/contracts/p2p-v1.md) — client KDF, DTLS-bound `HELLO_AUTH`, chat sync, and binary Swarm file contracts

---

## 1. Workspace Ownership & Dependency Boundaries

SimpleIM is structured as a homogeneous **Bun + TypeScript** workspace monorepo:

```text
apps/{web,cli} ──► packages/peer-core ──► packages/crypto ──► packages/contracts
apps/server   ──────────────────────────► packages/crypto ──► packages/contracts
```

| Package / App | Responsibility | Forbidden Imports (Enforced by `arch.test.ts`) |
| :--- | :--- | :--- |
| `packages/contracts` | Single source of truth for HTTP DTOs, WebSocket signaling envelopes, P2P control frames, binary chunk headers, and runtime validators | Any `packages/*`, `apps/*`, `DOM`, `bun:*`, or `node:*` APIs |
| `packages/crypto` | Isomorphic cryptographic primitives: `Argon2id` + `HKDF-SHA256` room derivation, `XChaCha20-Poly1305` AEAD, `Ed25519` `PeerIdentityCert` & message signing | `packages/peer-core`, `apps/*`, `DOM`, `bun:*`, or `node:fs` |
| `packages/peer-core` | Platform-agnostic P2P mesh state machine, `HELLO_AUTH` channel binding, signed chat catch-up, and Rarest-First Swarm chunk scheduler | `apps/*`, browser globals (`window`, `RTCPeerConnection`), `werift`, `bun:*`, or `node:fs` (all I/O enters via ports) |
| `apps/server` | Minimal `Bun.serve()` center: self-service identity, `PeerIdentityCert` signing, and stateless in-memory WebSocket signaling | `packages/peer-core`, `apps/{web,cli}`, `werift`, or browser APIs |
| `apps/web` | React 19 SPA with native browser WebRTC adapter and Web Worker OPFS chunk storage | `apps/{server,cli}`, `werift`, `bun:*`, or `node:*` |
| `apps/cli` | Bun CLI (`join` interactive TUI + `seed` headless daemon) with pure-TS `werift` WebRTC adapter and native filesystem chunk storage | `apps/{server,web}` or browser DOM APIs |

---

## 2. Clean 4-Layer Server Architecture

`apps/server` follows an inward-pointing 4-layer Hexagonal Clean Architecture:

```text
src/main.ts ──► adapter/{http,ws} ──► app ──► domain ◄── infra/{sqlite,crypto,ratelimit,clock}
```

| Layer | Responsibility | Allowed Imports |
| :--- | :--- | :--- |
| `domain/` | Entities (`User`, `Session`, `SignalingRoom`), coded `DomainError`, invariants, and outbound port interfaces | TypeScript standard built-ins and `packages/contracts` only |
| `app/` | Use-case orchestration (`RegisterUser`, `IssuePeerCert`, `RelayEncryptedSignal`) | `domain/` and `packages/contracts` only |
| `adapter/` | `Bun.serve` HTTP route handlers and WebSocket lifecycle handlers mapping DTOs and `DomainError` codes | `app/`, `domain/`, `packages/contracts` (**never imports `infra/`**) |
| `infra/` | `bun:sqlite` repositories, `Bun.password` / `Ed25519` signer, in-memory token buckets, structured logger | `domain/`, `packages/{contracts,crypto}`, `bun:sqlite`, Bun runtime APIs (**never imports `app/` or `adapter/`**) |

- **Zero Room/Chat Persistence**: `infra/sqlite` migrations may define only `schema_migrations`, `users`, and `sessions`. Persisting room hashes, membership history, chat messages, or file metadata on the server is strictly prohibited.
- **Architecture Gate (`arch.test.ts`)**: AST import checks fail `bun test` whenever any workspace package or `apps/server` layer violates its allowed import boundary.

---

## 3. Contract-First Protocol Discipline

All wire formats live in `packages/contracts` and mirror [`docs/contracts/signaling-v1.md`](docs/contracts/signaling-v1.md) and [`docs/contracts/p2p-v1.md`](docs/contracts/p2p-v1.md):

1. Validate every untrusted inbound HTTP body, WebSocket frame, and DataChannel control message through `packages/contracts` schemas before dispatching to `app/` or `peer-core` state machines.
2. Binary `"file-swarm"` frames must be parsed with explicit bounds checks (`byteLength >= 26`, `payloadLength <= 65536`) before allocating buffers.
3. Update `packages/contracts`, protocol documentation under `docs/contracts/`, and all affected adapters in the same pull request.

---

## 4. Cryptography, Privacy & Secret Hygiene

- **Constant-Time Verification**: Compare MACs and password hashes using constant-time primitives; perform dummy password verification on unknown usernames during login to prevent timing enumeration.
- **Session Isolation**: Logout or account switching in `apps/web` and `apps/cli` must immediately tear down active `RTCPeerConnection`s, wipe in-memory room keys and message buffers, and purge temporary OPFSchunk handles.
- **Strict Log Redaction**: Never log plaintext passwords, session tokens, room passphrases, derived keys, SDP/ICE payloads, chat bodies, file names, or chunk bytes. Log `roomId` values only as truncated 8-hex prefixes.
- **No Committed Secrets**: Never commit `.env*`, server `Ed25519` private keys, SQLite files, or `.runtime/` data.

---

## 5. Verification Matrix

Passing typechecks, unit suites, server integration tests, and cross-runtime WebRTC E2E checks are distinct claims—always verify and report the exact commands executed:

```sh
# Install workspace dependencies with frozen lockfile
bun install --frozen-lockfile

# Static typecheck, lint & architectural import-boundary gate
bun run typecheck
bun run lint
bun test packages/

# Server SQLite & WebSocket signaling integration tests
bun test apps/server

# CLI build & standalone binary verification
bun test apps/cli
bun run --cwd apps/cli build:bin

# Web build, unit tests & cross-runtime (Web <-> CLI) Playwright acceptance
bun run --cwd apps/web build
bun run test:e2e
```

---

## 6. Branching, Pull Requests & Releases

1. **Trunk-Based Development**: `main` is the only ongoing development branch. Do not introduce `dev` or `staging` branches.
2. **Focused Pull Requests**: Develop in scoped `feat/*`, `fix/*`, `refactor/*`, or `chore/*` branches referencing the tracking GitHub Issue (`#N`) and squash-merge into `main` once CI passes.
3. **Forward-Only SQLite Migrations**: `apps/server` SQLite schema changes must be forward-compatible and guarded by monotonic `schema_migrations` versions.
4. **Immutable Releases**: Cut releases by pushing an immutable `release/vMAJOR.MINOR.PATCH` branch and tag from a verified `main` commit. Never force-push, delete, or append commits to published `release/v*` branches; land fixes on `main` and cut a new version.

---

## 7. License

SimpleIM is licensed under the [Functional Source License, Version 1.1, MIT Future License (`FSL-1.1-MIT`)](LICENSE) (Copyright (c) 2026 Ziqian Zhao). By submitting a contribution, you agree that your contribution is provided under the terms of [`LICENSE`](LICENSE).
