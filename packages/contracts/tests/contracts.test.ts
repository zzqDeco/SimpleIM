import { describe, expect, test } from "bun:test";
import {
  countChunksInBitfield,
  createBitfield,
  decodeSwarmFrame,
  encodeSwarmFrame,
  hasChunkInBitfield,
  parseClientSignalingFrame,
  parseRegisterRequest,
  sanitizeFileName,
  setChunkInBitfield,
  SWARM_HEADER_BYTES,
  SwarmFrameType,
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
});
