import { ContractValidationError } from "./errors.ts";
import { isRecord, isValidBase64Url } from "./http.ts";
import {
  isValidChatMessageEnvelope,
  isValidFileManifest,
  isValidSha256Hex,
  isValidUuid,
  MAX_SWARM_HASH_PAGES,
  SWARM_CHUNK_SIZE,
  SWARM_HASH_PAGE_CHUNKS,
  type ChatMessageEnvelope,
  type FileManifest,
} from "./p2p.ts";

export const DEFAULT_RELAY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_RELAY_MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_RELAY_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB (file chunk pool)
export const DEFAULT_RELAY_MAX_ENVELOPE_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MiB (isolated envelope pool)

export const RELAY_NONCE_BYTES = 24;
export const RELAY_TAG_BYTES = 16;
export const RELAY_AEAD_OVERHEAD_BYTES = RELAY_NONCE_BYTES + RELAY_TAG_BYTES; // 40 B
export const MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES = 65_536; // 64 KiB
export const MAX_RELAY_CHUNK_CIPHERTEXT_BYTES =
  SWARM_CHUNK_SIZE + RELAY_AEAD_OVERHEAD_BYTES; // 65,576 B
export const MAX_RELAY_LIST_LIMIT = 100;

export function computeRelayFileWireBytes(
  fileSize: number,
  totalChunks: number,
): number {
  if (
    !Number.isFinite(fileSize) ||
    fileSize <= 0 ||
    !Number.isFinite(totalChunks) ||
    totalChunks <= 0
  ) {
    return 0;
  }
  return fileSize + totalChunks * RELAY_AEAD_OVERHEAD_BYTES;
}

const RELAY_BOX_ID_RE = /^[0-9a-f]{64}$/;
const RELAY_BLOB_ID_RE = /^[0-9a-f]{32}$/;

export function isValidRelayBoxId(value: unknown): value is string {
  return typeof value === "string" && RELAY_BOX_ID_RE.test(value);
}

export function isValidRelayBlobId(value: unknown): value is string {
  return typeof value === "string" && RELAY_BLOB_ID_RE.test(value);
}

export interface RelayMetaConfig {
  enabled: boolean;
  ttlMs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEnvelopeTotalBytes?: number;
}

export type RelayEnvelopeInnerPayload =
  | {
      type: "relay.chat";
      message: ChatMessageEnvelope;
    }
  | {
      type: "relay.manifest";
      manifest: FileManifest;
    }
  | {
      type: "relay.hash_page";
      fileId: string;
      pageIndex: number;
      chunkHashes: string[];
    };

export interface RelayPutEnvelopeResponse {
  ok: true;
  seq: number;
  created: boolean;
  expiresAt: number;
}

export interface RelayListedEnvelopeItem {
  seq: number;
  blobId: string;
  payloadB64: string;
  expiresAt: number;
}

export interface RelayListEnvelopesResponse {
  ok: true;
  items: RelayListedEnvelopeItem[];
  nextCursor: number;
  hasMore: boolean;
  cursorReset?: boolean;
}

export interface RelayPutChunkResponse {
  ok: true;
  created: boolean;
  expiresAt: number;
}

export function parseRelayEnvelopeInnerPayload(
  rawJson: string,
): RelayEnvelopeInnerPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    throw new ContractValidationError(
      "Malformed decrypted relay envelope JSON",
      "invalid_frame",
    );
  }
  if (!isRecord(obj) || typeof obj.type !== "string") {
    throw new ContractValidationError(
      "Invalid relay envelope payload",
      "invalid_frame",
    );
  }
  switch (obj.type) {
    case "relay.chat": {
      if (!isValidChatMessageEnvelope(obj.message)) {
        throw new ContractValidationError(
          "Invalid relay.chat message",
          "invalid_frame",
        );
      }
      return { type: "relay.chat", message: obj.message };
    }
    case "relay.manifest": {
      if (!isValidFileManifest(obj.manifest)) {
        throw new ContractValidationError(
          "Invalid relay.manifest payload",
          "invalid_frame",
        );
      }
      return { type: "relay.manifest", manifest: obj.manifest };
    }
    case "relay.hash_page": {
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
          "Invalid relay.hash_page payload",
          "invalid_frame",
        );
      }
      return {
        type: "relay.hash_page",
        fileId: obj.fileId,
        pageIndex: obj.pageIndex,
        chunkHashes: obj.chunkHashes,
      };
    }
    default:
      throw new ContractValidationError(
        "Unknown relay envelope payload type",
        "invalid_frame",
      );
  }
}

export function isValidRelayListEnvelopesResponse(
  value: unknown,
): value is RelayListEnvelopesResponse {
  if (!isRecord(value) || value.ok !== true) return false;
  if (
    !Array.isArray(value.items) ||
    typeof value.nextCursor !== "number" ||
    !Number.isSafeInteger(value.nextCursor) ||
    value.nextCursor < 0 ||
    typeof value.hasMore !== "boolean" ||
    (value.cursorReset !== undefined && typeof value.cursorReset !== "boolean")
  ) {
    return false;
  }
  return value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.seq === "number" &&
      Number.isSafeInteger(item.seq) &&
      item.seq >= 1 &&
      isValidRelayBlobId(item.blobId) &&
      isValidBase64Url(item.payloadB64, 54, 90_000) &&
      typeof item.expiresAt === "number" &&
      Number.isSafeInteger(item.expiresAt),
  );
}
