import { describe, expect, test } from "bun:test";
import { SWARM_CHUNK_SIZE, SWARM_HASH_PAGE_CHUNKS } from "@simpleim/contracts";
import {
  bytesToHex,
  createHelloChallengeNonce,
  createHelloProveFrame,
  createPopRequest,
  createSignedFileManifestFromChunks,
  createSignedFileManifestWithPages,
  deriveRoomKeys,
  extractSdpSha256Fingerprint,
  generateEd25519KeyPair,
  generatePrefixedId,
  issuePeerIdentityCert,
  openPostAuthControlFrame,
  openSignalingPayload,
  sealPostAuthControlFrame,
  sealSignalingPayload,
  signChatMessage,
  verifyChatMessage,
  verifyChunkSha256,
  verifyFileManifest,
  verifyHashPage,
  verifyHelloProveFrame,
  verifyPeerIdentityCert,
  verifyPopRequest,
  wipeRoomKeys,
} from "../src/index.ts";

describe("@simpleim/crypto", () => {
  test("deriveRoomKeys produces deterministic NFC-normalized orthogonal subkeys", () => {
    // Use production 64 MiB Argon2id once to prove real production parameters execute cleanly
    const prodA = deriveRoomKeys("カフェ-secret-群密码");
    // Decomposed NFD equivalent must yield identical room keys
    const prodB = deriveRoomKeys("カフェ-secret-群密码".normalize("NFD"));
    expect(prodA.roomId).toBe(prodB.roomId);
    expect(prodA.roomId).toHaveLength(64);
    expect(bytesToHex(prodA.signalingKey)).toBe(bytesToHex(prodB.signalingKey));
    expect(bytesToHex(prodA.roomAuthKey)).toBe(bytesToHex(prodB.roomAuthKey));
    expect(bytesToHex(prodA.roomAppKey)).toBe(bytesToHex(prodB.roomAppKey));

    // Subkeys must all be mutually distinct
    const distinct = new Set([
      prodA.roomId,
      bytesToHex(prodA.signalingKey),
      bytesToHex(prodA.roomAuthKey),
      bytesToHex(prodA.roomAppKey),
    ]);
    expect(distinct.size).toBe(4);

    // Pinned production 64 MiB (m=65536, t=3, p=1) vector from docs/contracts/p2p-v1.md
    expect(prodA.roomId).toBe(
      "68d57aed4ebb086382c54380ee3b7e842feede8605919d496aeac6146c3bdf9b",
    );
    expect(prodA.roomIdPrefix).toBe("68d57aed");
    expect(bytesToHex(prodA.signalingKey)).toBe(
      "efb3ae2f02d5571c0d16539affa974798d77c87f170e80865c3f37fd844f9af1",
    );
    expect(bytesToHex(prodA.roomAuthKey)).toBe(
      "b8989272e6cb440ac6857f05bcecb890260c0cb2eff0b2ea3120fe89bd3112fa",
    );
    expect(bytesToHex(prodA.roomAppKey)).toBe(
      "5c0767a429ce874cb771a47fdf54bb0d3d354634987c7e60fa6d281ffe73745a",
    );

    // Pinned fast test-tier (m=1024, t=1, p=1) vector
    const fast = deriveRoomKeys("simpleim-vector-passphrase-1", {
      memoryKiB: 1024,
      iterations: 1,
    });
    expect(fast.roomId).toBe(
      "b06ed3f9d8e8bc3a0245f3d3f5aa13cee5ad6698e39b11c683953a3f48ab6f38",
    );
    expect(fast.roomIdPrefix).toBe("b06ed3f9");
    expect(bytesToHex(fast.signalingKey)).toBe(
      "957014399f882fb0bd14f77deb37d40cd3d9aed7608f001d1dfcba3c0313046f",
    );
    expect(bytesToHex(fast.roomAuthKey)).toBe(
      "f36541ecb0393743e1b5b9168d179b8a19579065db328527f8aef14cce38ecdb",
    );
    expect(bytesToHex(fast.roomAppKey)).toBe(
      "824e08bbb6c94bfb40ba686f71a92be45fe63e457a81f9e130fb1a680c72d34c",
    );

    wipeRoomKeys(prodA);
    expect(Array.from(prodA.signalingKey).every((b) => b === 0)).toBe(true);
  });

  test("XChaCha20-Poly1305 signaling AEAD binds roomId, fromPeerId, and toPeerId as AAD", () => {
    const keys = deriveRoomKeys("room-pass-1", { memoryKiB: 1024, iterations: 1 });
    const peerA = generatePrefixedId("peer");
    const peerB = generatePrefixedId("peer");

    const env = sealSignalingPayload(keys.signalingKey, keys.roomId, peerA, peerB, {
      kind: "sdp-offer",
      sdp: "v=0\r\na=fingerprint:sha-256 AA:BB\r\n",
    });

    const opened = openSignalingPayload(
      keys.signalingKey,
      keys.roomId,
      peerA,
      peerB,
      env,
    );
    expect(opened.kind).toBe("sdp-offer");

    // Replay with swapped peers or wrong roomId must fail AEAD tag check
    expect(() =>
      openSignalingPayload(keys.signalingKey, keys.roomId, peerB, peerA, env),
    ).toThrow();
    expect(() =>
      openSignalingPayload(
        keys.signalingKey,
        "f".repeat(64),
        peerA,
        peerB,
        env,
      ),
    ).toThrow();
  });

  test("PeerIdentityCert + PoP + HELLO_AUTH mutual DTLS channel binding & MITM rejection", () => {
    const serverKeys = generateEd25519KeyPair();
    const aliceKeys = generateEd25519KeyPair();
    const bobKeys = generateEd25519KeyPair();

    const aliceUserId = generatePrefixedId("usr");
    const bobUserId = generatePrefixedId("usr");
    const alicePeerId = "peer_01930000000070008000000000000001";
    const bobPeerId = "peer_01930000000070008000000000000002";
    const now = 1_763_047_200_000;

    // Proof of Possession check
    const popReq = createPopRequest({
      userId: aliceUserId,
      peerId: alicePeerId,
      peerSignKeyPair: aliceKeys,
      timestamp: now,
    });
    expect(verifyPopRequest({ userId: aliceUserId, request: popReq, nowMs: now })).toBe(
      true,
    );
    expect(
      verifyPopRequest({
        userId: bobUserId,
        request: popReq,
        nowMs: now,
      }),
    ).toBe(false);

    const aliceCert = issuePeerIdentityCert({
      serverKeyId: "srvk_1",
      serverSignPrivKey: serverKeys.privateKeyBytes,
      userId: aliceUserId,
      username: "alice",
      displayName: "Alice",
      peerId: alicePeerId,
      peerSignPubKey: aliceKeys.publicKeyBase64Url,
      clientKind: "web",
      nowMs: now,
    });
    const bobCert = issuePeerIdentityCert({
      serverKeyId: "srvk_1",
      serverSignPrivKey: serverKeys.privateKeyBytes,
      userId: bobUserId,
      username: "bob",
      displayName: "Bob",
      peerId: bobPeerId,
      peerSignPubKey: bobKeys.publicKeyBase64Url,
      clientKind: "cli",
      nowMs: now,
    });

    expect(
      verifyPeerIdentityCert(aliceCert, serverKeys.publicKeyBase64Url, {
        nowMs: now + 1000,
      }).ok,
    ).toBe(true);
    expect(
      verifyPeerIdentityCert(aliceCert, serverKeys.publicKeyBase64Url, {
        nowMs: now + 48 * 3600 * 1000,
      }),
    ).toEqual({ ok: false, reason: "cert_expired" });

    const roomKeys = deriveRoomKeys("shared-room-secret", {
      memoryKiB: 1024,
      iterations: 1,
    });
    const wrongRoomKeys = deriveRoomKeys("wrong-room-secret", {
      memoryKiB: 1024,
      iterations: 1,
    });

    const sdpAlice =
      "v=0\r\na=fingerprint:sha-256 " +
      Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(":") +
      "\r\n";
    const sdpBob =
      "v=0\r\na=fingerprint:sha-256 " +
      Array.from({ length: 32 }, (_, i) =>
        (255 - i).toString(16).padStart(2, "0"),
      ).join(":") +
      "\r\n";
    const fpAlice = extractSdpSha256Fingerprint(sdpAlice);
    const fpBob = extractSdpSha256Fingerprint(sdpBob);

    const nonceAlice = createHelloChallengeNonce();
    const nonceBob = createHelloChallengeNonce();

    const aliceProve = createHelloProveFrame({
      roomId: roomKeys.roomId,
      roomAuthKey: roomKeys.roomAuthKey,
      cert: aliceCert,
      peerSignPrivKey: aliceKeys.privateKeyBytes,
      localPeerId: alicePeerId,
      remotePeerId: bobPeerId,
      localFingerprint: fpAlice,
      remoteFingerprint: fpBob,
      localNonce: nonceAlice,
      remoteNonce: nonceBob,
    });

    // Bob verifies Alice legitimately
    const bobVerifiesAlice = verifyHelloProveFrame({
      frame: aliceProve,
      expectedRemotePeerId: alicePeerId,
      serverSignPubKey: serverKeys.publicKeyBase64Url,
      roomId: roomKeys.roomId,
      roomAuthKey: roomKeys.roomAuthKey,
      localPeerId: bobPeerId,
      localFingerprint: fpBob,
      remoteFingerprint: fpAlice,
      localNonce: nonceBob,
      remoteNonce: nonceAlice,
      nowMs: now + 500,
    });
    expect(bobVerifiesAlice.ok).toBe(true);

    // Simulated MITM: signaling server substituted DTLS fingerprint
    const fpMitm = Array.from({ length: 32 }, () => "AA").join(":");
    const mitmCheck = verifyHelloProveFrame({
      frame: aliceProve,
      expectedRemotePeerId: alicePeerId,
      serverSignPubKey: serverKeys.publicKeyBase64Url,
      roomId: roomKeys.roomId,
      roomAuthKey: roomKeys.roomAuthKey,
      localPeerId: bobPeerId,
      localFingerprint: fpBob,
      remoteFingerprint: fpMitm,
      localNonce: nonceBob,
      remoteNonce: nonceAlice,
      nowMs: now + 500,
    });
    expect(mitmCheck.ok).toBe(false);

    // Wrong passphrase check
    const wrongPassCheck = verifyHelloProveFrame({
      frame: aliceProve,
      expectedRemotePeerId: alicePeerId,
      serverSignPubKey: serverKeys.publicKeyBase64Url,
      roomId: roomKeys.roomId,
      roomAuthKey: wrongRoomKeys.roomAuthKey,
      localPeerId: bobPeerId,
      localFingerprint: fpBob,
      remoteFingerprint: fpAlice,
      localNonce: nonceBob,
      remoteNonce: nonceAlice,
      nowMs: now + 500,
    });
    expect(wrongPassCheck).toEqual({ ok: false, reason: "room_mac_mismatch" });
  });

  test("Signed chat messages, post-auth control AEAD, and multi-chunk FileManifest verification", async () => {
    const serverKeys = generateEd25519KeyPair();
    const peerKeys = generateEd25519KeyPair();
    const now = 1_763_047_200_000;
    const cert = issuePeerIdentityCert({
      serverKeyId: "srvk_1",
      serverSignPrivKey: serverKeys.privateKeyBytes,
      userId: generatePrefixedId("usr"),
      username: "charlie",
      displayName: "Charlie",
      peerId: generatePrefixedId("peer"),
      peerSignPubKey: peerKeys.publicKeyBase64Url,
      clientKind: "cli",
      nowMs: now,
    });
    const roomKeys = deriveRoomKeys("swarm-room", { memoryKiB: 1024, iterations: 1 });

    const chatMsg = signChatMessage({
      roomId: roomKeys.roomId,
      lamport: 1,
      body: "Hello **P2P**!",
      authorCert: cert,
      peerSignPrivKey: peerKeys.privateKeyBytes,
      createdAt: now + 1000,
    });
    expect(
      verifyChatMessage(chatMsg, serverKeys.publicKeyBase64Url, roomKeys.roomId),
    ).toBe(true);
    expect(
      verifyChatMessage(
        { ...chatMsg, body: "Tampered!" },
        serverKeys.publicKeyBase64Url,
        roomKeys.roomId,
      ),
    ).toBe(false);

    const sealed = sealPostAuthControlFrame(roomKeys.roomAppKey, roomKeys.roomId, {
      type: "chat.message",
      message: chatMsg,
    });
    const opened = openPostAuthControlFrame(
      roomKeys.roomAppKey,
      roomKeys.roomId,
      sealed,
    );
    expect(opened.type).toBe("chat.message");

    // 100 KiB synthetic file (2 chunks: 64 KiB + 36 KiB)
    const fileData = new Uint8Array(100 * 1024);
    for (let i = 0; i < fileData.byteLength; i++) {
      fileData[i] = i & 0xff;
    }
    const manifest = await createSignedFileManifestFromChunks({
      roomId: roomKeys.roomId,
      fileName: "../secret/demo.bin",
      fileSize: fileData.byteLength,
      readChunk: async (_idx, offset, length) =>
        fileData.subarray(offset, offset + length),
      senderCert: cert,
      peerSignPrivKey: peerKeys.privateKeyBytes,
    });

    expect(manifest.fileName).toBe("demo.bin");
    expect(manifest.totalChunks).toBe(2);
    expect(
      verifyFileManifest(manifest, serverKeys.publicKeyBase64Url, roomKeys.roomId),
    ).toBe(true);
    expect(
      verifyChunkSha256(
        fileData.subarray(0, SWARM_CHUNK_SIZE),
        manifest.chunkHashes[0]!,
      ),
    ).toBe(true);
    // Poisoned byte must fail chunk verification
    const poisoned = fileData.slice(0, SWARM_CHUNK_SIZE);
    poisoned[10] = (poisoned[10] ?? 0) ^ 0xff;
    expect(verifyChunkSha256(poisoned, manifest.chunkHashes[0]!)).toBe(false);

    // > 512 chunks (520 chunks) switches to compact signed hashPageHashes
    const pagedChunks = SWARM_HASH_PAGE_CHUNKS + 8;
    const dummyChunk = new Uint8Array(SWARM_CHUNK_SIZE).fill(0x42);
    const pagedRes = await createSignedFileManifestWithPages({
      roomId: roomKeys.roomId,
      fileName: "large-paged.bin",
      fileSize: pagedChunks * SWARM_CHUNK_SIZE,
      readChunk: async () => dummyChunk,
      senderCert: cert,
      peerSignPrivKey: peerKeys.privateKeyBytes,
    });
    expect(pagedRes.manifest.chunkHashes).toHaveLength(0);
    expect(pagedRes.manifest.hashPageHashes).toHaveLength(2);
    expect(pagedRes.chunkHashPages).toHaveLength(2);
    expect(pagedRes.chunkHashPages[0]).toHaveLength(SWARM_HASH_PAGE_CHUNKS);
    expect(pagedRes.chunkHashPages[1]).toHaveLength(8);
    expect(
      verifyFileManifest(
        pagedRes.manifest,
        serverKeys.publicKeyBase64Url,
        roomKeys.roomId,
      ),
    ).toBe(true);
    // Sealed announce frame stays tiny (< 4 KiB) well within SCTP 256 KiB limits
    const sealedPagedAnnounce = sealPostAuthControlFrame(
      roomKeys.roomAppKey,
      roomKeys.roomId,
      { type: "file.announce", manifest: pagedRes.manifest },
    );
    expect(JSON.stringify(sealedPagedAnnounce).length).toBeLessThan(4096);
    expect(
      verifyHashPage(
        pagedRes.manifest.fileId,
        0,
        pagedRes.chunkHashPages[0]!,
        pagedRes.manifest.hashPageHashes![0]!,
      ),
    ).toBe(true);
    expect(
      verifyHashPage(
        pagedRes.manifest.fileId,
        1,
        pagedRes.chunkHashPages[0]!,
        pagedRes.manifest.hashPageHashes![1]!,
      ),
    ).toBe(false);
  });
});
