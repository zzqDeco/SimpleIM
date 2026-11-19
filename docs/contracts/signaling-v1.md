# Central Identity & Ephemeral Signaling Contract (v1)

All HTTP endpoints are JSON-encoded (`Content-Type: application/json; charset=utf-8`) with a `64 KiB` maximum request body. Error responses use a uniform envelope:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid username or password"
  }
}
```

---

## 1. Metadata & ICE Configuration

### `GET /healthz` & `GET /api/v1/version`
- `GET /healthz` returns `{ "ok": true }` for container and reverse-proxy liveness probes.
- `GET /api/v1/version` returns `{ "ok": true, "version": "v0.1.0", "sha": "<commit-sha>" }` so immutable release verification can assert the exact deployed container revision.

### `GET /api/v1/meta`
Public endpoint returning the server's `Ed25519` identity public key and ICE bootstrap configuration. When called with an authenticated session and `COTURN_SHARED_SECRET` is configured, includes short-lived HMAC TURN credentials.

```json
{
  "ok": true,
  "serverKeyId": "srvk_2026_01",
  "serverSignPubKey": "<base64url-32B-ed25519-pub>",
  "iceServers": [
    { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
  ],
  "limits": {
    "maxPeersPerRoom": 16,
    "maxRoomsPerConnection": 8,
    "maxSignalPayloadBytes": 32768
  },
  "relay": {
    "enabled": true,
    "ttlMs": 86400000,
    "maxFileBytes": 104857600,
    "maxTotalBytes": 2147483648
  }
}
```

---

## 2. Authentication & Session Lifecycle

### `POST /api/v1/auth/register`
Open self-service registration guarded by per-IP token-bucket rate limiting.
- **Request**:
  - `username`: `string` matching `^[a-z0-9_-]{3,24}$` (case-insensitive unique)
  - `password`: `string` (`8..128` UTF-8 chars, no `\x00`)
  - `displayName?`: `string` (`1..32` Unicode scalar values; defaults to `username`)
  - `clientKind`: `"web" | "cli"`
- **Response (`201 Created`)**:
  - `clientKind === "web"`: sets `HttpOnly; Secure; SameSite=Strict; Path=/` session cookie and returns `{ ok: true, user, csrfToken }`.
  - `clientKind === "cli"`: returns `{ ok: true, user, sessionToken, expiresAt }`.

### `POST /api/v1/auth/login`
- **Request**: `{ username, password, clientKind: "web" | "cli" }`
- Performs constant-time Argon2id verification (including dummy verification when `username` is absent) and issues a new session identical to `/register`.

### `POST /api/v1/auth/logout`
Requires valid session (`Cookie` + `X-CSRF-Token` for `web`, `Authorization: Bearer <sessionToken>` for `cli`). Deletes the `sessions` row immediately.

### `GET /api/v1/auth/me`
Returns `{ ok: true, user: { id, username, displayName, createdAt }, csrfToken? }` or `401 unauthorized`. When authenticated via the browser `HttpOnly` session cookie (`clientKind === "web"`), `csrfToken` is included so single-tab page reloads can recover `X-CSRF-Token` for state-changing requests (`POST /api/v1/auth/peer-cert`, `POST /api/v1/auth/logout`).

---

## 3. Offline-Verifiable Peer Identity Certificate

### `POST /api/v1/auth/peer-cert`
Binds the authenticated user to a client-generated ephemeral `Ed25519` keypair for P2P verification.

- **Request**:
  ```json
  {
    "peerId": "peer_01jb...",
    "peerSignPubKey": "<base64url-32B-ed25519-pub>",
    "timestamp": 1763047200000,
    "popSignature": "<base64url-64B-ed25519-sig>"
  }
  ```
  `popSignature` signs UTF-8 bytes of `"simpleim/v1/pop:" + userId + ":" + peerId + ":" + timestamp` (`|now - timestamp| <= 60_000 ms`).

- **Response (`200 OK`)**:
  ```json
  {
    "ok": true,
    "cert": {
      "payload": {
        "v": 1,
        "iss": "simpleim-server",
        "kid": "srvk_2026_01",
        "userId": "usr_01jb...",
        "username": "alice",
        "displayName": "Alice",
        "peerId": "peer_01jb...",
        "peerSignPubKey": "<base64url-32B>",
        "clientKind": "web",
        "iat": 1763047200000,
        "exp": 1763133600000
      },
      "serverSig": "<base64url-64B-ed25519-sig>"
    }
  }
  ```
  `serverSig` signs the canonical UTF-8 serialization of `payload` (`"simpleim/v1/peer-cert\0" + canonicalJson(payload)`).

---

## 4. Stateless WebSocket Signaling (`GET /ws/v1/signaling?peerId=<peerId>`)

- **Upgrade Auth**: Session cookie + validated `Origin` (`web`) or `Authorization: Bearer <sessionToken>` (`cli`). Max inbound frame size: `limits.maxSignalPayloadBytes` (`32 KiB` default).
- **In-Memory State Only**: `roomId` (`64` lowercase hex chars) maps exclusively to active `peerId` sockets. No usernames or display names are emitted in signaling membership events.

### Client → Server Frames
1. `room.join`: `{ "type": "room.join", "roomId": "<64-hex>" }`
2. `room.leave`: `{ "type": "room.leave", "roomId": "<64-hex>" }`
3. `signal.relay`:
   ```json
   {
     "type": "signal.relay",
     "roomId": "<64-hex>",
     "toPeerId": "peer_01jc...",
     "envelope": {
       "nonce": "<base64url-24B>",
       "ciphertext": "<base64url-xchacha20poly1305>"
     }
   }
   ```

### Server → Client Frames
1. `room.joined`: `{ "type": "room.joined", "roomId": "<64-hex>", "selfPeerId": "peer_01jb...", "peers": ["peer_01jc..."] }`
2. `room.peer_joined`: `{ "type": "room.peer_joined", "roomId": "<64-hex>", "peerId": "peer_01jd..." }`
3. `room.peer_left`: `{ "type": "room.peer_left", "roomId": "<64-hex>", "peerId": "peer_01jc..." }`
4. `signal.deliver`: `{ "type": "signal.deliver", "roomId": "<64-hex>", "fromPeerId": "peer_01jb...", "envelope": { "nonce": "...", "ciphertext": "..." } }`
5. `error`: `{ "type": "error", "code": "room_full | rate_limited | invalid_frame", "roomId": "<64-hex>?" }`

---

## 5. Zero-Knowledge Ephemeral Blind Ciphertext Relay (`/api/v1/relay/*`)

All `/api/v1/relay/*` endpoints require an authenticated session (`Cookie` + validated `Origin` + `X-CSRF-Token` for `web` mutations; `Authorization: Bearer <sessionToken>` for `cli`). The server SQLite database remains strictly untouched (`users` and `sessions` only); encrypted blobs live in an isolated filesystem cache directory governed by `relay.ttlMs` (`24h` default), `relay.maxFileBytes` (`100 MiB` default per blinded `fileTag`), an isolated envelope LRU pool `relay.maxEnvelopeTotalBytes` (`128 MiB` default, so heavy file transfers can never evict chat/manifest envelopes), and `relay.maxTotalBytes` (`2 GiB` default file chunk LRU cap).

- `PUT /api/v1/relay/:boxId/envelopes/:blobId` (`application/octet-stream`, `41..65,536 B`): Idempotently stores an `XChaCha20-Poly1305` encrypted chat/manifest/hash-page envelope under `boxId` (`64-hex`) and `blobId` (`32-hex`). Returns `{ "ok": true, "seq": 1, "created": true, "expiresAt": 1763133600000 }`.
- `GET /api/v1/relay/:boxId/envelopes/:blobId`: Streams a single non-expired encrypted envelope (`application/octet-stream`) by deterministic `(boxId, blobId)` independently of `afterSeq` pagination (used e.g. to refetch `relay.hash_page` envelopes for `> 32 MiB` paged files after reload), or `404 not_found` if absent/expired/evicted.
- `GET /api/v1/relay/:boxId/envelopes?afterSeq=<n>&limit=<1..100>`: Lists non-expired encrypted envelopes in `boxId` with `seq > afterSeq`. If a persisted `afterSeq` exceeds the server's highest issued sequence for `boxId` (for example after an empty box expires across a server restart), the server automatically resets the effective cursor to `0` and sets `"cursorReset": true`. Returns `{ "ok": true, "items": [{ "seq": 1, "blobId": "<32-hex>", "payloadB64": "<base64url-raw-aead>", "expiresAt": 1763133600000 }], "nextCursor": 1, "hasMore": false, "cursorReset": false }`.
- `PUT /api/v1/relay/:boxId/files/:fileTag/chunks/:chunkBlobId` (`application/octet-stream`, `40..65,576 B`): Idempotently stores an `XChaCha20-Poly1305` encrypted `<= 64 KiB` Swarm chunk. Rejects with `413 payload_too_large` if cumulative unique encrypted chunk bytes (`fileSize + totalChunks * 40 B`) for `(boxId, fileTag)` exceed `relay.maxFileBytes`. Returns `{ "ok": true, "created": true, "expiresAt": 1763133600000 }`.
- `GET /api/v1/relay/:boxId/files/:fileTag/chunks/:chunkBlobId`: Streams the raw binary AEAD chunk (`application/octet-stream`) or `404 not_found` if absent/expired/evicted.
