import { describe, expect, test } from "bun:test";
import {
  countChunksInBitfield,
  createBitfield,
  decodeSwarmFrame,
  encodeSwarmFrame,
  hasChunkInBitfield,
  isValidFileManifest,
  MAX_CHAT_LAMPORT,
  parseClientSignalingFrame,
  parsePostAuthControlFrame,
  parseRegisterRequest,
  parseServerSignalingFrame,
  parseSignalingInnerPayload,
  sanitizeFileName,
  setChunkInBitfield,
  SWARM_CHUNK_SIZE,
  SWARM_HASH_PAGE_CHUNKS,
  SWARM_HEADER_BYTES,
  SwarmFrameType,
  type ChatMessageEnvelope,
  type PeerIdentityCert,
} from "../src/index.ts";

describe("@simpleim/contracts", () => {
  test("parseRegisterRequest normalizes username and validates bounds", () => {
    const req = parseRegisterRequest({
      username: "  Alice_01  ",
      password: "correct-horse-battery",
      displayName: "  Alice  ",
      clientKind: "web",
    });
    expect(req).toEqual({
      username: "alice_01",
      password: "correct-horse-battery",
      displayName: "Alice",
      clientKind: "web",
    });

    expect(() =>
      parseRegisterRequest({
        username: "ab",
        password: "correct-horse-battery",
        clientKind: "cli",
      }),
    ).toThrow();

    expect(() =>
      parseRegisterRequest({
        username: "alice",
        password: "short",
        clientKind: "cli",
      }),
    ).toThrow();
  });

  test("sanitizeFileName strips path traversal and control bytes", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\alice\\report.pdf")).toBe("report.pdf");
    expect(() => sanitizeFileName("..")).toThrow();
    expect(() => sanitizeFileName("   ")).toThrow();
  });

  test("parseClientSignalingFrame validates room.join and signal.relay", () => {
    const roomId = "a".repeat(64);
    expect(
      parseClientSignalingFrame(JSON.stringify({ type: "room.join", roomId })),
    ).toEqual({ type: "room.join", roomId });

    expect(() =>
      parseClientSignalingFrame(
        JSON.stringify({ type: "room.join", roomId: "not-hex" }),
      ),
    ).toThrow();
  });

  test("Swarm binary frame encodes and decodes 26-byte big-endian header lossless", () => {
    const fileId = "01932c7f-8a1e-7b23-9d4c-112233445566";
    const payload = new Uint8Array([1, 2, 3, 254, 255]);
    const encoded = encodeSwarmFrame({
      frameType: SwarmFrameType.CHUNK,
      fileId,
      chunkIndex: 1599,
      payload,
    });
    expect(encoded.byteLength).toBe(SWARM_HEADER_BYTES + payload.byteLength);

    const decoded = decodeSwarmFrame(encoded);
    expect(decoded.version).toBe(1);
    expect(decoded.frameType).toBe(SwarmFrameType.CHUNK);
    expect(decoded.fileId).toBe(fileId);
    expect(decoded.chunkIndex).toBe(1599);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 254, 255]);

    // Truncated payload should fail
    expect(() => decodeSwarmFrame(encoded.subarray(0, encoded.byteLength - 1))).toThrow();
  });

  test("Bitfield manipulation tracks chunk indices accurately", () => {
    const bf = createBitfield(10);
    expect(bf.byteLength).toBe(2);
    expect(countChunksInBitfield(bf, 10)).toBe(0);
    setChunkInBitfield(bf, 0);
    setChunkInBitfield(bf, 7);
    setChunkInBitfield(bf, 9);
    expect(hasChunkInBitfield(bf, 0)).toBe(true);
    expect(hasChunkInBitfield(bf, 7)).toBe(true);
    expect(hasChunkInBitfield(bf, 8)).toBe(false);
    expect(hasChunkInBitfield(bf, 9)).toBe(true);
    expect(countChunksInBitfield(bf, 10)).toBe(3);
  });

  test("parsePostAuthControlFrame accepts both nested and flat chat.message and bounds lamport", () => {
    const dummyCert: PeerIdentityCert = {
      payload: {
        v: 1,
        iss: "simpleim-server",
        kid: "srvk_1",
        userId: "usr_019300000000",
        username: "alice",
        displayName: "Alice",
        peerId: "peer_019300000000",
        peerSignPubKey: "A".repeat(43),
        clientKind: "web",
        iat: 1_763_000_000_000,
        exp: 1_763_086_400_000,
      },
      serverSig: "B".repeat(86),
    };
    const msg: ChatMessageEnvelope = {
      msgId: "01932c7f-8a1e-7b23-9d4c-112233445566",
      roomId: "a".repeat(64),
      lamport: 42,
      createdAt: 1_763_000_010_000,
      body: "Hello wire shape!",
      replyToMsgId: null,
      authorCert: dummyCert,
      authorSig: "C".repeat(86),
    };

    const nested = parsePostAuthControlFrame(
      JSON.stringify({ type: "chat.message", message: msg }),
    );
    const flat = parsePostAuthControlFrame(
      JSON.stringify({ type: "chat.message", ...msg }),
    );
    expect(nested).toEqual({ type: "chat.message", message: msg });
    expect(flat).toEqual({ type: "chat.message", message: msg });

    // Overflowing Lamport value must be rejected
    expect(() =>
      parsePostAuthControlFrame(
        JSON.stringify({
          type: "chat.message",
          message: { ...msg, lamport: MAX_CHAT_LAMPORT + 1 },
        }),
      ),
    ).toThrow();
  });

  test("paged FileManifest and file.hash_page / file.hash_page_request validate up to 2 GiB", () => {
    const dummyCert: PeerIdentityCert = {
      payload: {
        v: 1,
        iss: "simpleim-server",
        kid: "srvk_1",
        userId: "usr_019300000000",
        username: "alice",
        displayName: "Alice",
        peerId: "peer_019300000000",
        peerSignPubKey: "A".repeat(43),
        clientKind: "cli",
        iat: 1_763_000_000_000,
        exp: 1_763_086_400_000,
      },
      serverSig: "B".repeat(86),
    };
    const fileId = "01932c7f-8a1e-7b23-9d4c-112233445566";
    const twoGiBChunks = 32_768;
    const expectedPages = Math.ceil(twoGiBChunks / SWARM_HASH_PAGE_CHUNKS); // 64
    const pagedManifest = {
      fileId,
      roomId: "b".repeat(64),
      fileName: "dataset-2gib.tar.zst",
      fileSize: twoGiBChunks * SWARM_CHUNK_SIZE,
      mimeType: "application/zstd",
      chunkSize: SWARM_CHUNK_SIZE,
      totalChunks: twoGiBChunks,
      fileSha256: "d".repeat(64),
      chunkHashes: [],
      hashPageHashes: Array.from({ length: expectedPages }, () => "e".repeat(64)),
      senderCert: dummyCert,
      senderSig: "C".repeat(86),
    };
    expect(isValidFileManifest(pagedManifest)).toBe(true);
    // Reject inline chunkHashes when totalChunks > 512
    expect(
      isValidFileManifest({
        ...pagedManifest,
        totalChunks: 513,
        fileSize: 513 * SWARM_CHUNK_SIZE,
        chunkHashes: Array.from({ length: 513 }, () => "e".repeat(64)),
        hashPageHashes: undefined,
      }),
    ).toBe(false);

    const reqFrame = parsePostAuthControlFrame(
      JSON.stringify({
        type: "file.hash_page_request",
        fileId,
        pageIndices: [0, 1, 1],
      }),
    );
    expect(reqFrame).toEqual({
      type: "file.hash_page_request",
      fileId,
      pageIndices: [0, 1],
    });

    const pageFrame = parsePostAuthControlFrame(
      JSON.stringify({
        type: "file.hash_page",
        fileId,
        pageIndex: 0,
        chunkHashes: ["f".repeat(64)],
      }),
    );
    expect(pageFrame).toEqual({
      type: "file.hash_page",
      fileId,
      pageIndex: 0,
      chunkHashes: ["f".repeat(64)],
    });
  });

  test("parseServerSignalingFrame and parseSignalingInnerPayload honor configurable maxFrameBytes", () => {
    const roomId = "c".repeat(64);
    const largeDeliverRaw = JSON.stringify({
      type: "signal.deliver",
      roomId,
      fromPeerId: "peer_019300000001",
      envelope: {
        nonce: "A".repeat(32),
        ciphertext: "B".repeat(50_000),
      },
    });
    const largeSdpRaw = JSON.stringify({
      kind: "sdp-offer",
      sdp: `v=0\r\na=ext:${"x".repeat(35_000)}\r\n`,
    });

    // Rejected under default 32 KiB limit
    expect(() => parseServerSignalingFrame(largeDeliverRaw)).toThrow();
    expect(() => parseSignalingInnerPayload(largeSdpRaw)).toThrow();

    // Accepted when server meta raises maxSignalPayloadBytes to 64 KiB
    const parsedDeliver = parseServerSignalingFrame(largeDeliverRaw, {
      maxFrameBytes: 65_536,
    });
    expect(parsedDeliver.type).toBe("signal.deliver");
    const parsedInner = parseSignalingInnerPayload(largeSdpRaw, {
      maxFrameBytes: 65_536,
    });
    expect(parsedInner.kind).toBe("sdp-offer");

    // Lowered limit (e.g. 8 KiB) rejects 12 KiB envelopes and 10 KiB SDPs
    const mediumDeliverRaw = JSON.stringify({
      type: "signal.deliver",
      roomId,
      fromPeerId: "peer_019300000001",
      envelope: {
        nonce: "A".repeat(32),
        ciphertext: "B".repeat(12_000),
      },
    });
    const mediumSdpRaw = JSON.stringify({
      kind: "sdp-answer",
      sdp: "y".repeat(10_000),
    });
    expect(() =>
      parseServerSignalingFrame(mediumDeliverRaw, { maxFrameBytes: 8_192 }),
    ).toThrow();
    expect(() =>
      parseSignalingInnerPayload(mediumSdpRaw, { maxFrameBytes: 8_192 }),
    ).toThrow();
  });
});
