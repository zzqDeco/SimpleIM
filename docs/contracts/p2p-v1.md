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

### Canonical KDF Test Vector (`m = 65536, t = 3, p = 1`)
- `passphrase` (NFC): `"カフェ-secret-群密码"`
- `roomId`: `68d57aed4ebb086382c54380ee3b7e842feede8605919d496aeac6146c3bdf9b`
- `signalingKey` (hex): `efb3ae2f02d5571c0d16539affa974798d77c87f170e80865c3f37fd844f9af1`
- `roomAuthKey` (hex): `b8989272e6cb440ac6857f05bcecb890260c0cb2eff0b2ea3120fe89bd3112fa`
- `roomAppKey` (hex): `5c0767a429ce874cb771a47fdf54bb0d3d354634987c7e60fa6d281ffe73745a`

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

Connections start in `UNVERIFIED` quarantine; once `"control-chat"` (`dc:0`) opens, peers must complete `HELLO_AUTH` within `10s`. All non-handshake frames are dropped while `UNVERIFIED`.

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

All post-auth frames on `"control-chat"` are sealed in `{ type: "control.sealed", envelope: { nonce: "<24B>", ciphertext: "<XChaCha20-Poly1305 under roomAppKey>" } }`:

- `chat.message` (`1 <= lamport <= 9_007_199_253_700_000`; parsers also normalize legacy flat `chat.message` payloads into `{ type: "chat.message", message }`):
  ```json
  {
    "type": "chat.message",
    "message": {
      "msgId": "019a...",
      "roomId": "<64-hex>",
      "lamport": 42,
      "createdAt": 1763047215000,
      "body": "Hello from CLI!",
      "replyToMsgId": null,
      "authorCert": { "...": "..." },
      "authorSig": "<base64url-64B-ed25519-sig>"
    }
  }
  ```
- `sync.summary`: `{ "type": "sync.summary", "knownMsgIds": ["..."], "knownFileIds": ["..."] }` (bounded to latest `500` messages/files)
- `sync.request`: `{ "type": "sync.request", "wantMsgIds": ["..."], "wantFileIds": ["..."] }`
- `sync.batch`: `{ "type": "sync.batch", "messages": [...], "files": [...] }` (every relayed chat message must carry and pass original `authorCert` + `authorSig` verification, and every relayed file manifest must carry and pass original `senderCert` + `senderSig` verification)
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
      "chunkHashes": [],
      "hashPageHashes": ["<64-hex-page-0>", "<64-hex-page-1>", "<64-hex-page-2>", "<64-hex-page-3>"],
      "senderCert": { "...": "..." },
      "senderSig": "<base64url-64B-ed25519-sig>"
    }
  }
  ```
  - For `totalChunks <= 512` (`<= 32 MiB`), `chunkHashes` contains all `totalChunks` per-chunk SHA-256 digests inline and `hashPageHashes` is omitted.
  - For `512 < totalChunks <= 32,768` (`<= 2 GiB`), `chunkHashes` is `[]` and `hashPageHashes` contains `ceil(totalChunks / 512)` page digests signed under `senderSig`, where each page (`<= 512` chunk hashes) has digest `SHA256_HEX("simpleim/v1/hash-page\0" + fileId + ":" + pageIndex + "\0" + pageChunkHashes.join(","))`.
- `file.hash_page_request`: `{ "type": "file.hash_page_request", "fileId": "019a...", "pageIndices": [0, 1] }`
- `file.hash_page`: `{ "type": "file.hash_page", "fileId": "019a...", "pageIndex": 0, "chunkHashes": ["<64-hex>", "..."] }` (verified against `manifest.hashPageHashes[pageIndex]` before chunk scheduling)

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
