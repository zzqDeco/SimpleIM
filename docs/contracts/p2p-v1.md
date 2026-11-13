# Peer-to-Peer Mesh, E2EE & Swarm File Contract (v1)

## 1. Passphrase Key Derivation (Client-Only)

Given a room passphrase normalized via `passphrase.normalize("NFC")` (`1..256` UTF-8 bytes):

```text
masterSalt = SHA256("simpleim/v1/room-master-salt")
masterSeed = Argon2id(password = UTF8(passphrase), salt = masterSalt, t = 3, m = 65536, p = 1, dkLen = 32)

roomId       = Hex(HKDF_SHA256(masterSeed, salt = "", info = "simpleim/v1/room-id",        len = 32))
signalingKey =     HKDF_SHA256(masterSeed, salt = "", info = "simpleim/v1/signaling-aead", len = 32)
roomAuthKey  =     HKDF_SHA256(masterSeed, salt = "", info = "simpleim/v1/room-auth-hmac", len = 32)
roomAppKey   =     HKDF_SHA256(masterSeed, salt = "", info = "simpleim/v1/room-app-aead",  len = 32)
```

### Encrypted Signaling Envelope
Plaintext JSON `{ kind: "sdp-offer" | "sdp-answer" | "ice-candidate" | "ice-end", payload }` is encrypted with `XChaCha20-Poly1305(key = signalingKey, nonce = random(24), aad = UTF8("simpleim/v1/signal:" + roomId + ":" + fromPeerId + ":" + toPeerId))`.

---

## 2. Deterministic Mesh & Negotiated DataChannels

Between any two peers in `roomId`, the peer with `localPeerId < remotePeerId` acts as the WebRTC **Offerer**. Both sides pre-bind two negotiated `RTCDataChannel`s (`negotiated: true`):

| ID | Label | Mode | Payload Encoding | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `"control-chat"` | `ordered: true` (reliable) | UTF-8 JSON (`XChaCha20-Poly1305` under `roomAppKey` after `HELLO_AUTH`) | `HELLO_AUTH` handshake, presence/RTT pings, signed chat messages, catch-up sync, and `FileManifest` announcements |
| `1` | `"file-swarm"` | `ordered: false` (reliable unordered) | Big-Endian Binary (`ArrayBuffer`) | Bitfields, `HAVE` announcements, chunk `REQUEST`/`CANCEL`, and `64 KiB` `CHUNK` transfers |

---

## 3. Post-DTLS Mutual Authentication (`HELLO_AUTH`)

Connections remain in `UNVERIFIED` quarantine on open (`10s` timeout). All non-handshake frames are dropped.

1. Both peers exchange `{ type: "hello.challenge", nonce: "<base64url-32B>" }` on `"control-chat"`.
2. Let `minPeer = min(localPeerId, remotePeerId)` and `maxPeer = max(localPeerId, remotePeerId)`. Each side extracts the SHA-256 certificate fingerprints from the active `RTCPeerConnection` SDP/DTLS transport (`fp(minPeer)`, `fp(maxPeer)`) and computes:
   ```text
   transcript = SHA256(
     "simpleim/v1/channel-binding\0" ||
     roomId || "\0" ||
     minPeer || ":" || maxPeer || "\0" ||
     fp(minPeer) || ":" || fp(maxPeer) || "\0" ||
     nonce(minPeer) || ":" || nonce(maxPeer)
   )
   ```
3. Both peers send `{ type: "hello.prove", cert: PeerIdentityCert, roomMac: HMAC_SHA256(roomAuthKey, transcript), peerSig: Ed25519.sign(peerSignPrivKey, transcript) }`.
4. A peer transitions to `VERIFIED` iff:
   - `cert.serverSig` verifies under `serverSignPubKey` and `cert.payload.exp > now`;
   - `cert.payload.peerId === remotePeerId`;
   - `roomMac` matches in constant time;
   - `peerSig` verifies under `cert.payload.peerSignPubKey`.
   Any mismatch immediately closes the `RTCPeerConnection`.

---

## 4. Signed Chat & Online Catch-Up Frames (`dc:0 "control-chat"`)

All post-auth frames on `"control-chat"` are sealed in `{ nonce: "<24B>", ciphertext: "<XChaCha20-Poly1305 under roomAppKey>" }`:

- `chat.message`:
  ```json
  {
    "type": "chat.message",
    "msgId": "019a...",
    "roomId": "<64-hex>",
    "lamport": 42,
    "createdAt": 1763047215000,
    "body": "Hello from CLI!",
    "replyToMsgId": null,
    "authorCert": { "...": "..." },
    "authorSig": "<base64url-64B-ed25519-sig>"
  }
  ```
- `sync.summary`: `{ "type": "sync.summary", "knownMsgIds": ["..."], "knownFileIds": ["..."] }` (bounded to latest `500` messages)
- `sync.request`: `{ "type": "sync.request", "wantMsgIds": ["..."], "wantFileIds": ["..."] }`
- `sync.batch`: `{ "type": "sync.batch", "messages": [...], "files": [...] }` (every relayed item must carry and pass original `authorCert` + `authorSig` verification)
- `file.announce`:
  ```json
  {
    "type": "file.announce",
    "manifest": {
      "fileId": "019a...",
      "roomId": "<64-hex>",
      "fileName": "archive.tar.zst",
      "fileSize": 104857600,
      "mimeType": "application/zstd",
      "chunkSize": 65536,
      "totalChunks": 1600,
      "fileSha256": "<64-hex>",
      "chunkHashes": ["<64-hex>", "..."],
      "senderCert": { "...": "..." },
      "senderSig": "<base64url-64B-ed25519-sig>"
    }
  }
  ```
  *(For files exceeding `512` chunks, `chunkHashes` may be paged via `file.hash_page` keyed by Merkle root `fileSha256`.)*

---

## 5. Binary Swarm Chunk Frame (`dc:1 "file-swarm"`)

Every message on `"file-swarm"` is a `Uint8Array` with a fixed **26-byte big-endian header**:

| Byte Offset | Size | Field | Description |
| :--- | :--- | :--- | :--- |
| `0` | `1 B` | `version` | Protocol version (`0x01`) |
| `1` | `1 B` | `frameType` | `0x01=BITFIELD`, `0x02=HAVE`, `0x03=REQUEST`, `0x04=CHUNK`, `0x05=CANCEL` |
| `2..17` | `16 B` | `fileId` | Raw 128-bit UUID bytes of `FileManifest.fileId` |
| `18..21` | `4 B` | `chunkIndex` | Unsigned 32-bit BE chunk index (`0` for whole-file `BITFIELD`) |
| `22..25` | `4 B` | `payloadLen` | Unsigned 32-bit BE payload byte length (`0..65536`) |
| `26..` | `payloadLen` | `payload` | Bitfield bytes (`0x01`) or raw `<= 64 KiB` chunk data (`0x04`) |

### Flow Control & Integrity Rules
- **Chunk Size**: `65,536 B` (`64 KiB`) for all chunks `0 .. totalChunks - 2`; final chunk `1 .. 65,536 B`.
- **Backpressure**: Pause outbound `CHUNK` transmission on a channel whenever `dc.bufferedAmount >= 1_048_576` (`1 MiB`), resuming on `bufferedamountlow` (`threshold = 262_144`).
- **Verification**: Compute `SHA-256(payload)` before persisting to OPFS or disk. Drop mismatched chunks immediately and increment peer `strikeCount` (disconnect peer at `3` strikes). Immediately broadcast `HAVE(fileId, chunkIndex)` to connected room peers upon verified commit.
