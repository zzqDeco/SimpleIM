import { ContractValidationError } from "./errors.ts";
import {
  isRecord,
  isValidBase64Url,
  isValidPeerIdentityCert,
  isValidRoomIdHex,
  type PeerIdentityCert,
} from "./http.ts";
import { isValidEncryptedEnvelope, type EncryptedEnvelope } from "./signaling.ts";

export const CONTROL_CHANNEL_ID = 0;
export const CONTROL_CHANNEL_LABEL = "control-chat";
export const SWARM_CHANNEL_ID = 1;
export const SWARM_CHANNEL_LABEL = "file-swarm";

export const SWARM_CHUNK_SIZE = 65_536; // 64 KiB
export const SWARM_MAX_BUFFERED_AMOUNT = 1_048_576; // 1 MiB
export const SWARM_BUFFERED_LOW_THRESHOLD = 262_144; // 256 KiB
export const SWARM_HEADER_BYTES = 26;
export const SWARM_PROTOCOL_VERSION = 1;

export const HELLO_AUTH_TIMEOUT_MS = 10_000;
export const MAX_CHAT_BODY_BYTES = 16_384;
export const MAX_CHAT_LAMPORT = 9_007_199_253_700_000;
export const MAX_SYNC_MESSAGES = 500;
export const MAX_PEERS_PER_ROOM = 16;
export const MAX_POISON_STRIKES = 3;

export const SWARM_HASH_PAGE_CHUNKS = 512; // 32 MiB inline hash threshold
export const MAX_SWARM_FILE_CHUNKS = 32_768; // 2 GiB maximum single-file chunks
export const MAX_SWARM_HASH_PAGES = Math.ceil(
  MAX_SWARM_FILE_CHUNKS / SWARM_HASH_PAGE_CHUNKS,
); // 64 pages max

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isValidSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

export interface HelloChallengeFrame {
  type: "hello.challenge";
  nonce: string;
}

export interface HelloProveFrame {
  type: "hello.prove";
  cert: PeerIdentityCert;
  roomMac: string;
  peerSig: string;
}

export interface HelloAckFrame {
  type: "hello.ack";
}

export type PreAuthControlFrame =
  | HelloChallengeFrame
  | HelloProveFrame
  | HelloAckFrame;

export interface SealedControlEnvelope {
  type: "control.sealed";
  envelope: EncryptedEnvelope;
}

export interface PresencePingFrame {
  type: "presence.ping";
  sentAt: number;
}

export interface PresencePongFrame {
  type: "presence.pong";
  sentAt: number;
}

export interface ChatMessageEnvelope {
  msgId: string;
  roomId: string;
  lamport: number;
  createdAt: number;
  body: string;
  replyToMsgId: string | null;
  authorCert: PeerIdentityCert;
  authorSig: string;
}

export interface ChatMessageFrame {
  type: "chat.message";
  message: ChatMessageEnvelope;
}

export interface FileManifest {
  fileId: string;
  roomId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  chunkHashes: string[];
  hashPageHashes?: string[];
  senderCert: PeerIdentityCert;
  senderSig: string;
}

export interface FileAnnounceFrame {
  type: "file.announce";
  manifest: FileManifest;
}

export interface FileHashPageRequestFrame {
  type: "file.hash_page_request";
  fileId: string;
  pageIndices: number[];
}

export interface FileHashPageFrame {
  type: "file.hash_page";
  fileId: string;
  pageIndex: number;
  chunkHashes: string[];
}

export interface SyncSummaryFrame {
  type: "sync.summary";
  knownMsgIds: string[];
  knownFileIds: string[];
}

export interface SyncRequestFrame {
  type: "sync.request";
  wantMsgIds: string[];
  wantFileIds: string[];
}

export interface SyncBatchFrame {
  type: "sync.batch";
  messages: ChatMessageEnvelope[];
  files: FileManifest[];
}

export type PostAuthControlFrame =
  | PresencePingFrame
  | PresencePongFrame
  | ChatMessageFrame
  | FileAnnounceFrame
  | FileHashPageRequestFrame
  | FileHashPageFrame
  | SyncSummaryFrame
  | SyncRequestFrame
  | SyncBatchFrame;

export type WireControlFrame = PreAuthControlFrame | SealedControlEnvelope;

export function sanitizeFileName(rawName: string): string {
  const normalized = rawName.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  // Strip ASCII control characters and path traversal remnants
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (
    cleaned.length === 0 ||
    cleaned === "." ||
    cleaned === ".." ||
    new TextEncoder().encode(cleaned).byteLength > 255
  ) {
    throw new ContractValidationError("Invalid fileName");
  }
  return cleaned;
}

export function canonicalizeChatSignInput(input: {
  roomId: string;
  msgId: string;
  lamport: number;
  createdAt: number;
  body: string;
  replyToMsgId: string | null;
}): Uint8Array {
  const canonical = JSON.stringify({
    roomId: input.roomId,
    msgId: input.msgId,
    lamport: input.lamport,
    createdAt: input.createdAt,
    body: input.body,
    replyToMsgId: input.replyToMsgId,
  });
  return new TextEncoder().encode(`simpleim/v1/chat-msg\0${canonical}`);
}

export function buildHashPageSignInput(
  fileId: string,
  pageIndex: number,
  chunkHashes: readonly string[],
): Uint8Array {
  return new TextEncoder().encode(
    `simpleim/v1/hash-page\0${fileId}:${pageIndex}\0${chunkHashes.join(",")}`,
  );
}

export function canonicalizeFileManifestSignInput(input: {
  fileId: string;
  roomId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  chunkHashes: string[];
  hashPageHashes?: string[];
}): Uint8Array {
  const payloadObj: Record<string, unknown> = {
    fileId: input.fileId,
    roomId: input.roomId,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    chunkSize: input.chunkSize,
    totalChunks: input.totalChunks,
    fileSha256: input.fileSha256,
    chunkHashes: input.chunkHashes,
  };
  if (input.hashPageHashes !== undefined) {
    payloadObj.hashPageHashes = input.hashPageHashes;
  }
  const canonical = JSON.stringify(payloadObj);
  return new TextEncoder().encode(`simpleim/v1/file-manifest\0${canonical}`);
}

export function isValidChatMessageEnvelope(
  value: unknown,
): value is ChatMessageEnvelope {
  if (!isRecord(value)) return false;
  if (
    !isValidUuid(value.msgId) ||
    !isValidRoomIdHex(value.roomId) ||
    typeof value.lamport !== "number" ||
    !Number.isSafeInteger(value.lamport) ||
    value.lamport < 1 ||
    value.lamport > MAX_CHAT_LAMPORT ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0 ||
    typeof value.body !== "string"
  ) {
    return false;
  }
  const bodyBytes = new TextEncoder().encode(value.body).byteLength;
  if (bodyBytes < 1 || bodyBytes > MAX_CHAT_BODY_BYTES) return false;
  if (value.replyToMsgId !== null && !isValidUuid(value.replyToMsgId)) {
    return false;
  }
  return (
    isValidPeerIdentityCert(value.authorCert) &&
    isValidBase64Url(value.authorSig, 84, 90)
  );
}

export function isValidFileManifest(value: unknown): value is FileManifest {
  if (!isRecord(value)) return false;
  if (
    !isValidUuid(value.fileId) ||
    !isValidRoomIdHex(value.roomId) ||
    typeof value.fileName !== "string" ||
    typeof value.fileSize !== "number" ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize < 0 ||
    typeof value.mimeType !== "string" ||
    value.mimeType.length > 128 ||
    value.chunkSize !== SWARM_CHUNK_SIZE ||
    typeof value.totalChunks !== "number" ||
    !Number.isSafeInteger(value.totalChunks) ||
    value.totalChunks < 0 ||
    value.totalChunks > MAX_SWARM_FILE_CHUNKS ||
    !isValidSha256Hex(value.fileSha256) ||
    !Array.isArray(value.chunkHashes)
  ) {
    return false;
  }
  const expectedChunks =
    value.fileSize === 0 ? 0 : Math.ceil(value.fileSize / SWARM_CHUNK_SIZE);
  if (value.totalChunks !== expectedChunks) return false;

  if (value.totalChunks <= SWARM_HASH_PAGE_CHUNKS) {
    if (
      value.hashPageHashes !== undefined ||
      value.chunkHashes.length !== value.totalChunks ||
      !value.chunkHashes.every(isValidSha256Hex)
    ) {
      return false;
    }
  } else {
    const expectedPages = Math.ceil(value.totalChunks / SWARM_HASH_PAGE_CHUNKS);
    if (
      value.chunkHashes.length !== 0 ||
      !Array.isArray(value.hashPageHashes) ||
      value.hashPageHashes.length !== expectedPages ||
      !value.hashPageHashes.every(isValidSha256Hex)
    ) {
      return false;
    }
  }

  try {
    if (sanitizeFileName(value.fileName) !== value.fileName) return false;
  } catch {
    return false;
  }
  return (
    isValidPeerIdentityCert(value.senderCert) &&
    isValidBase64Url(value.senderSig, 84, 90)
  );
}

export function parseWireControlFrame(raw: string): WireControlFrame {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ContractValidationError("Malformed control JSON", "invalid_frame");
  }
  if (!isRecord(obj) || typeof obj.type !== "string") {
    throw new ContractValidationError("Invalid control frame", "invalid_frame");
  }
  switch (obj.type) {
    case "hello.challenge": {
      if (!isValidBase64Url(obj.nonce, 42, 46)) {
        throw new ContractValidationError("Invalid hello.challenge nonce", "invalid_frame");
      }
      return { type: "hello.challenge", nonce: obj.nonce };
    }
    case "hello.prove": {
      if (
        !isValidPeerIdentityCert(obj.cert) ||
        !isValidBase64Url(obj.roomMac, 42, 46) ||
        !isValidBase64Url(obj.peerSig, 84, 90)
      ) {
        throw new ContractValidationError("Invalid hello.prove frame", "invalid_frame");
      }
      return {
        type: "hello.prove",
        cert: obj.cert,
        roomMac: obj.roomMac,
        peerSig: obj.peerSig,
      };
    }
    case "hello.ack":
      return { type: "hello.ack" };
    case "control.sealed": {
      if (!isValidEncryptedEnvelope(obj.envelope, 2_097_152)) {
        throw new ContractValidationError("Invalid control.sealed envelope", "invalid_frame");
      }
      return { type: "control.sealed", envelope: obj.envelope };
    }
    default:
      throw new ContractValidationError("Unknown wire control frame", "invalid_frame");
  }
}

export function parsePostAuthControlFrame(raw: string): PostAuthControlFrame {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ContractValidationError("Malformed decrypted control JSON", "invalid_frame");
  }
  if (!isRecord(obj) || typeof obj.type !== "string") {
    throw new ContractValidationError("Invalid post-auth frame", "invalid_frame");
  }
  switch (obj.type) {
    case "presence.ping":
    case "presence.pong": {
      if (typeof obj.sentAt !== "number" || !Number.isSafeInteger(obj.sentAt)) {
        throw new ContractValidationError("Invalid presence timestamp", "invalid_frame");
      }
      return { type: obj.type, sentAt: obj.sentAt };
    }
    case "chat.message": {
      const candidate = obj.message !== undefined ? obj.message : obj;
      if (!isValidChatMessageEnvelope(candidate)) {
        throw new ContractValidationError("Invalid chat.message envelope", "invalid_frame");
      }
      return {
        type: "chat.message",
        message: {
          msgId: candidate.msgId,
          roomId: candidate.roomId,
          lamport: candidate.lamport,
          createdAt: candidate.createdAt,
          body: candidate.body,
          replyToMsgId: candidate.replyToMsgId,
          authorCert: candidate.authorCert,
          authorSig: candidate.authorSig,
        },
      };
    }
    case "file.announce": {
      if (!isValidFileManifest(obj.manifest)) {
        throw new ContractValidationError("Invalid file.announce manifest", "invalid_frame");
      }
      return { type: "file.announce", manifest: obj.manifest };
    }
    case "file.hash_page_request": {
      if (
        !isValidUuid(obj.fileId) ||
        !Array.isArray(obj.pageIndices) ||
        obj.pageIndices.length < 1 ||
        obj.pageIndices.length > MAX_SWARM_HASH_PAGES ||
        !obj.pageIndices.every(
          (idx): idx is number =>
            typeof idx === "number" &&
            Number.isInteger(idx) &&
            idx >= 0 &&
            idx < MAX_SWARM_HASH_PAGES,
        )
      ) {
        throw new ContractValidationError(
          "Invalid file.hash_page_request",
          "invalid_frame",
        );
      }
      return {
        type: "file.hash_page_request",
        fileId: obj.fileId,
        pageIndices: Array.from(new Set(obj.pageIndices)),
      };
    }
    case "file.hash_page": {
      if (
        !isValidUuid(obj.fileId) ||
        typeof obj.pageIndex !== "number" ||
        !Number.isInteger(obj.pageIndex) ||
        obj.pageIndex < 0 ||
        obj.pageIndex >= MAX_SWARM_HASH_PAGES ||
        !Array.isArray(obj.chunkHashes) ||
        obj.chunkHashes.length < 1 ||
        obj.chunkHashes.length > SWARM_HASH_PAGE_CHUNKS ||
        !obj.chunkHashes.every(isValidSha256Hex)
      ) {
        throw new ContractValidationError(
          "Invalid file.hash_page",
          "invalid_frame",
        );
      }
      return {
        type: "file.hash_page",
        fileId: obj.fileId,
        pageIndex: obj.pageIndex,
        chunkHashes: obj.chunkHashes,
      };
    }
    case "sync.summary": {
      if (
        !Array.isArray(obj.knownMsgIds) ||
        obj.knownMsgIds.length > MAX_SYNC_MESSAGES ||
        !obj.knownMsgIds.every(isValidUuid) ||
        !Array.isArray(obj.knownFileIds) ||
        obj.knownFileIds.length > MAX_SYNC_MESSAGES ||
        !obj.knownFileIds.every(isValidUuid)
      ) {
        throw new ContractValidationError("Invalid sync.summary", "invalid_frame");
      }
      return {
        type: "sync.summary",
        knownMsgIds: obj.knownMsgIds,
        knownFileIds: obj.knownFileIds,
      };
    }
    case "sync.request": {
      if (
        !Array.isArray(obj.wantMsgIds) ||
        obj.wantMsgIds.length > MAX_SYNC_MESSAGES ||
        !obj.wantMsgIds.every(isValidUuid) ||
        !Array.isArray(obj.wantFileIds) ||
        obj.wantFileIds.length > MAX_SYNC_MESSAGES ||
        !obj.wantFileIds.every(isValidUuid)
      ) {
        throw new ContractValidationError("Invalid sync.request", "invalid_frame");
      }
      return {
        type: "sync.request",
        wantMsgIds: obj.wantMsgIds,
        wantFileIds: obj.wantFileIds,
      };
    }
    case "sync.batch": {
      if (
        !Array.isArray(obj.messages) ||
        obj.messages.length > MAX_SYNC_MESSAGES ||
        !obj.messages.every(isValidChatMessageEnvelope) ||
        !Array.isArray(obj.files) ||
        obj.files.length > MAX_SYNC_MESSAGES ||
        !obj.files.every(isValidFileManifest)
      ) {
        throw new ContractValidationError("Invalid sync.batch", "invalid_frame");
      }
      return {
        type: "sync.batch",
        messages: obj.messages,
        files: obj.files,
      };
    }
    default:
      throw new ContractValidationError("Unknown post-auth frame", "invalid_frame");
  }
}

export const SwarmFrameType = {
  BITFIELD: 0x01,
  HAVE: 0x02,
  REQUEST: 0x03,
  CHUNK: 0x04,
  CANCEL: 0x05,
} as const;

export type SwarmFrameTypeCode =
  (typeof SwarmFrameType)[keyof typeof SwarmFrameType];

export interface SwarmBinaryFrame {
  version: 1;
  frameType: SwarmFrameTypeCode;
  fileId: string;
  chunkIndex: number;
  payload: Uint8Array;
}

export function uuidToBytes16(uuid: string): Uint8Array {
  if (!isValidUuid(uuid)) {
    throw new ContractValidationError(`Invalid UUID: ${uuid}`);
  }
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytes16ToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) {
    throw new ContractValidationError("UUID bytes must be 16 bytes");
  }
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function encodeSwarmFrame(frame: Omit<SwarmBinaryFrame, "version">): Uint8Array {
  const payload = frame.payload;
  // CHUNK frames carry AEAD nonce (24B) + ciphertext (<= 65536B) + tag (16B) <= 65576B,
  // or raw <= 65536B; cap binary payload at 65,600 bytes to reject memory abuse while allowing optional AEAD seal.
  if (payload.byteLength > SWARM_CHUNK_SIZE + 64) {
    throw new ContractValidationError("Swarm frame payload exceeds maximum chunk envelope");
  }
  if (!Number.isInteger(frame.chunkIndex) || frame.chunkIndex < 0 || frame.chunkIndex > 0xffff_ffff) {
    throw new ContractValidationError("Invalid chunkIndex");
  }
  const uuidBytes = uuidToBytes16(frame.fileId);
  const out = new Uint8Array(SWARM_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = SWARM_PROTOCOL_VERSION;
  out[1] = frame.frameType;
  out.set(uuidBytes, 2);
  view.setUint32(18, frame.chunkIndex, false);
  view.setUint32(22, payload.byteLength, false);
  out.set(payload, SWARM_HEADER_BYTES);
  return out;
}

export function decodeSwarmFrame(buffer: ArrayBuffer | Uint8Array): SwarmBinaryFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < SWARM_HEADER_BYTES) {
    throw new ContractValidationError("Swarm binary frame truncated", "invalid_frame");
  }
  const version = bytes[0];
  if (version !== SWARM_PROTOCOL_VERSION) {
    throw new ContractValidationError("Unsupported swarm frame version", "invalid_frame");
  }
  const frameType = bytes[1];
  if (
    frameType !== SwarmFrameType.BITFIELD &&
    frameType !== SwarmFrameType.HAVE &&
    frameType !== SwarmFrameType.REQUEST &&
    frameType !== SwarmFrameType.CHUNK &&
    frameType !== SwarmFrameType.CANCEL
  ) {
    throw new ContractValidationError("Unknown swarm frameType", "invalid_frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkIndex = view.getUint32(18, false);
  const payloadLen = view.getUint32(22, false);
  if (
    payloadLen > SWARM_CHUNK_SIZE + 64 ||
    bytes.byteLength !== SWARM_HEADER_BYTES + payloadLen
  ) {
    throw new ContractValidationError("Swarm frame payload length mismatch", "invalid_frame");
  }
  const fileId = bytes16ToUuid(bytes.subarray(2, 18));
  const payload = bytes.slice(SWARM_HEADER_BYTES, SWARM_HEADER_BYTES + payloadLen);
  return {
    version: 1,
    frameType,
    fileId,
    chunkIndex,
    payload,
  };
}

export function createBitfield(totalChunks: number): Uint8Array {
  return new Uint8Array(Math.ceil(totalChunks / 8));
}

export function hasChunkInBitfield(bitfield: Uint8Array, chunkIndex: number): boolean {
  const byteIndex = chunkIndex >>> 3;
  const bitMask = 1 << (7 - (chunkIndex & 7));
  const byteVal = bitfield[byteIndex];
  return byteVal !== undefined && (byteVal & bitMask) !== 0;
}

export function setChunkInBitfield(bitfield: Uint8Array, chunkIndex: number): void {
  const byteIndex = chunkIndex >>> 3;
  if (byteIndex >= bitfield.byteLength) return;
  const bitMask = 1 << (7 - (chunkIndex & 7));
  bitfield[byteIndex] = (bitfield[byteIndex] ?? 0) | bitMask;
}

export function countChunksInBitfield(bitfield: Uint8Array, totalChunks: number): number {
  let count = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (hasChunkInBitfield(bitfield, i)) count++;
  }
  return count;
}
