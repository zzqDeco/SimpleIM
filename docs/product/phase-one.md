# First release scope and acceptance

This release delivers a usable, self-hostable hybrid-P2P instant messaging and distributed file-sharing tool across **Web browsers** and **Bun CLI**, tracked in [Issue #1](https://github.com/zzqDeco/SimpleIM/issues/1).

## Included in v1

- **Minimal Center (`apps/server`)**: Open self-service registration/login (`Bun.password` `argon2id`), session management (`bun:sqlite` WAL mode storing `token_sha256` only), short-lived `Ed25519` `PeerIdentityCert` issuance, optional HMAC TURN credential generation, rate limiting, and stateless in-memory WebSocket signaling relay.
- **Passphrase-Scoped Encrypted Groups (`packages/crypto` & `packages/peer-core`)**: Client-side `Argon2id` + `HKDF-SHA256` room derivation, `XChaCha20-Poly1305` encrypted SDP/ICE signaling, deterministic full-mesh WebRTC connection management (up to 16 concurrent peers per room), and DTLS-bound `HELLO_AUTH` mutual verification.
- **Peer-to-Peer Group Chat**: Dual `RTCDataChannel` isolation (`"control-chat"` vs `"file-swarm"`), Markdown text messages with reply quotes, `Ed25519` per-message signatures, Lamport causal ordering, and online catch-up sync from any active peer.
- **Swarm Distributed File Transfer**: `64 KiB` binary chunking, signed `FileManifest`, `SHA-256` per-chunk verification, Rarest-First + Endgame multi-peer pulling, immediate chunk re-seeding (`HAVE`), Web Worker OPFS storage in `apps/web`, and `.part` resumable disk storage in `apps/cli`.
- **Dual-Mode Bun CLI (`apps/cli`)**: Interactive terminal chat/file UI (`simpleim join`) and headless daemon (`simpleim seed`) compilable into a standalone binary via `bun build --compile`.

## Explicitly Deferred (Non-Goals for v1)

- Server-stored offline message queues or cloud object-storage file relays (offline retention is intentionally solved via optional peer-operated `simpleim seed` nodes).
- Voice/video media streaming (`MediaStreamTrack`), screen sharing, or SFU servers.
- Large rooms (`> 16` simultaneous peers requiring gossip overlays rather than full mesh).
- Account password recovery emails, OAuth/SSO providers, or multi-node clustered signaling state.

## Acceptance Criteria

Code builds, static typechecks, unit tests, server integration tests, and cross-runtime E2E tests are verified and reported separately:

1. **Zero Server Data Residue**: Inspect `apps/server` SQLite tables after multi-user chat and file transfers; confirm only `schema_migrations`, `users`, and `sessions` exist.
2. **Cryptographic & Identity Enforcement**: Verify two distinct accounts authenticate each other offline via `PeerIdentityCert`; confirm expired certs, wrong passphrases, forged signatures, and simulated SDP fingerprint MITM attempts fail `HELLO_AUTH` and close the connection.
3. **Cross-Runtime Interop Matrix**: Verify **Web ↔ Web**, **CLI ↔ CLI**, and **Web ↔ CLI** join the same passphrase room and exchange signed messages in `< 1s`.
4. **Center-Detached Resilience**: Terminate `apps/server` after peers establish `RTCDataChannel`s; verify active chat and ongoing file transfers complete cleanly.
5. **Swarm Multi-Peer Seeding & Poison Rejection**: Transfer a `>= 100 MiB` file across a 4-peer mesh; verify concurrent multi-source chunk pulling, `100%` `SHA-256` output fidelity, constant browser main-thread memory via OPFS, and automatic rejection/re-fetch when a corrupted chunk is injected.
6. **Headless Seed Catch-Up**: Run `simpleim seed` in a room, disconnect the original sender, join with a fresh client using the same passphrase, and verify full sync of signed chat history and seeded files.
