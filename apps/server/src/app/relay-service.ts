import {
  DEFAULT_RELAY_MAX_ENVELOPE_TOTAL_BYTES,
  DEFAULT_RELAY_MAX_FILE_BYTES,
  DEFAULT_RELAY_MAX_TOTAL_BYTES,
  DEFAULT_RELAY_TTL_MS,
  isValidRelayBlobId,
  isValidRelayBoxId,
  MAX_RELAY_CHUNK_CIPHERTEXT_BYTES,
  MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_RELAY_LIST_LIMIT,
  RELAY_AEAD_OVERHEAD_BYTES,
  type RelayListEnvelopesResponse,
  type RelayPutChunkResponse,
  type RelayPutEnvelopeResponse,
} from "@simpleim/contracts";
import { bytesToBase64Url } from "@simpleim/crypto";
import {
  DomainError,
  type BlindRelayStorePort,
  type ClockPort,
  type RateLimiterPort,
  type RateLimitRule,
  type RelayConfig,
} from "../domain/index.ts";

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  enabled: true,
  ttlMs: DEFAULT_RELAY_TTL_MS,
  maxFileBytes: DEFAULT_RELAY_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_RELAY_MAX_TOTAL_BYTES,
  maxEnvelopeTotalBytes: DEFAULT_RELAY_MAX_ENVELOPE_TOTAL_BYTES,
};

export const DEFAULT_RELAY_ENVELOPE_RATE_LIMIT: RateLimitRule = {
  capacity: 300,
  refillPerSecond: 100,
};

export const DEFAULT_RELAY_CHUNK_RATE_LIMIT: RateLimitRule = {
  capacity: 2_000,
  refillPerSecond: 500,
};

export interface RelayServiceDependencies {
  readonly store: BlindRelayStorePort;
  readonly rateLimiter: RateLimiterPort;
  readonly clock: ClockPort;
  readonly config?: RelayConfig;
  readonly envelopeRateLimit?: RateLimitRule;
  readonly chunkRateLimit?: RateLimitRule;
}

export class RelayService {
  private readonly store: BlindRelayStorePort;
  private readonly rateLimiter: RateLimiterPort;
  private readonly clock: ClockPort;
  private readonly config: RelayConfig;
  private readonly envelopeRateLimit: RateLimitRule;
  private readonly chunkRateLimit: RateLimitRule;

  constructor(deps: RelayServiceDependencies) {
    this.store = deps.store;
    this.rateLimiter = deps.rateLimiter;
    this.clock = deps.clock;
    this.config = deps.config ?? DEFAULT_RELAY_CONFIG;
    this.envelopeRateLimit =
      deps.envelopeRateLimit ?? DEFAULT_RELAY_ENVELOPE_RATE_LIMIT;
    this.chunkRateLimit = deps.chunkRateLimit ?? DEFAULT_RELAY_CHUNK_RATE_LIMIT;
  }

  getConfig(): RelayConfig {
    return { ...this.config };
  }

  assertEnabled(): void {
    if (!this.config.enabled) {
      throw new DomainError("not_found", "Blind relay is disabled", 404);
    }
  }

  putEnvelope(params: {
    userId: string;
    clientIp: string;
    boxId: string;
    blobId: string;
    payload: Uint8Array;
  }): RelayPutEnvelopeResponse {
    this.assertEnabled();
    const nowMs = this.clock.nowMs();
    this.consumeEnvelopeBudget(params.userId, params.clientIp, nowMs);

    if (!isValidRelayBoxId(params.boxId)) {
      throw new DomainError("invalid_arguments", "Invalid relay boxId", 400);
    }
    if (!isValidRelayBlobId(params.blobId)) {
      throw new DomainError("invalid_arguments", "Invalid relay blobId", 400);
    }
    if (params.payload.byteLength < RELAY_AEAD_OVERHEAD_BYTES) {
      throw new DomainError(
        "invalid_arguments",
        `Relay envelope must be at least ${RELAY_AEAD_OVERHEAD_BYTES} bytes`,
        400,
      );
    }
    if (params.payload.byteLength > MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES) {
      throw new DomainError(
        "payload_too_large",
        `Relay envelope exceeds ${MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES} byte limit`,
        413,
      );
    }
    if (params.payload.byteLength > this.config.maxEnvelopeTotalBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay envelope exceeds envelope cache capacity",
        413,
      );
    }

    const result = this.store.putEnvelope({
      boxId: params.boxId,
      blobId: params.blobId,
      payload: params.payload,
      nowMs,
      ttlMs: this.config.ttlMs,
    });

    return {
      ok: true,
      seq: result.seq,
      created: result.created,
      expiresAt: result.expiresAt,
    };
  }

  getEnvelope(params: {
    userId: string;
    clientIp: string;
    boxId: string;
    blobId: string;
  }): Uint8Array {
    this.assertEnabled();
    const nowMs = this.clock.nowMs();
    this.consumeEnvelopeBudget(params.userId, params.clientIp, nowMs);

    if (!isValidRelayBoxId(params.boxId)) {
      throw new DomainError("invalid_arguments", "Invalid relay boxId", 400);
    }
    if (!isValidRelayBlobId(params.blobId)) {
      throw new DomainError("invalid_arguments", "Invalid relay blobId", 400);
    }

    const bytes = this.store.getEnvelope({
      boxId: params.boxId,
      blobId: params.blobId,
      nowMs,
    });
    if (!bytes) {
      throw new DomainError(
        "not_found",
        "Relay envelope not found or expired",
        404,
      );
    }
    return bytes;
  }

  listEnvelopes(params: {
    userId: string;
    clientIp: string;
    boxId: string;
    afterSeq?: number;
    limit?: number;
  }): RelayListEnvelopesResponse {
    this.assertEnabled();
    const nowMs = this.clock.nowMs();
    this.consumeEnvelopeBudget(params.userId, params.clientIp, nowMs);

    if (!isValidRelayBoxId(params.boxId)) {
      throw new DomainError("invalid_arguments", "Invalid relay boxId", 400);
    }

    const afterSeq = params.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new DomainError(
        "invalid_arguments",
        "afterSeq must be a non-negative integer",
        400,
      );
    }

    const limit = params.limit ?? MAX_RELAY_LIST_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RELAY_LIST_LIMIT
    ) {
      throw new DomainError(
        "invalid_arguments",
        `limit must be an integer between 1 and ${MAX_RELAY_LIST_LIMIT}`,
        400,
      );
    }

    const listed = this.store.listEnvelopes({
      boxId: params.boxId,
      afterSeq,
      limit,
      nowMs,
    });

    const items = listed.items.map((item) => ({
      seq: item.seq,
      blobId: item.blobId,
      payloadB64: bytesToBase64Url(item.payload),
      expiresAt: item.expiresAt,
    }));

    const nextCursor =
      items.length > 0
        ? items[items.length - 1]!.seq
        : listed.cursorReset
          ? 0
          : afterSeq;

    return {
      ok: true,
      items,
      nextCursor,
      hasMore: listed.hasMore,
      ...(listed.cursorReset ? { cursorReset: true } : {}),
    };
  }

  putChunk(params: {
    userId: string;
    clientIp: string;
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    payload: Uint8Array;
  }): RelayPutChunkResponse {
    this.assertEnabled();
    const nowMs = this.clock.nowMs();
    this.consumeChunkBudget(params.userId, params.clientIp, nowMs);

    if (!isValidRelayBoxId(params.boxId)) {
      throw new DomainError("invalid_arguments", "Invalid relay boxId", 400);
    }
    if (!isValidRelayBlobId(params.fileTag)) {
      throw new DomainError("invalid_arguments", "Invalid relay fileTag", 400);
    }
    if (!isValidRelayBlobId(params.chunkBlobId)) {
      throw new DomainError(
        "invalid_arguments",
        "Invalid relay chunkBlobId",
        400,
      );
    }
    if (params.payload.byteLength < RELAY_AEAD_OVERHEAD_BYTES) {
      throw new DomainError(
        "invalid_arguments",
        `Relay chunk must be at least ${RELAY_AEAD_OVERHEAD_BYTES} bytes`,
        400,
      );
    }
    if (params.payload.byteLength > MAX_RELAY_CHUNK_CIPHERTEXT_BYTES) {
      throw new DomainError(
        "payload_too_large",
        `Relay chunk exceeds ${MAX_RELAY_CHUNK_CIPHERTEXT_BYTES} byte limit`,
        413,
      );
    }
    if (params.payload.byteLength > this.config.maxFileBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay file quota exceeded",
        413,
      );
    }
    if (params.payload.byteLength > this.config.maxTotalBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay chunk exceeds total cache capacity",
        413,
      );
    }

    const result = this.store.putChunk({
      boxId: params.boxId,
      fileTag: params.fileTag,
      chunkBlobId: params.chunkBlobId,
      payload: params.payload,
      nowMs,
      ttlMs: this.config.ttlMs,
      maxFileBytes: this.config.maxFileBytes,
    });

    return {
      ok: true,
      created: result.created,
      expiresAt: result.expiresAt,
    };
  }

  getChunk(params: {
    userId: string;
    clientIp: string;
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
  }): Uint8Array {
    this.assertEnabled();
    const nowMs = this.clock.nowMs();
    this.consumeChunkBudget(params.userId, params.clientIp, nowMs);

    if (!isValidRelayBoxId(params.boxId)) {
      throw new DomainError("invalid_arguments", "Invalid relay boxId", 400);
    }
    if (!isValidRelayBlobId(params.fileTag)) {
      throw new DomainError("invalid_arguments", "Invalid relay fileTag", 400);
    }
    if (!isValidRelayBlobId(params.chunkBlobId)) {
      throw new DomainError(
        "invalid_arguments",
        "Invalid relay chunkBlobId",
        400,
      );
    }

    const bytes = this.store.getChunk({
      boxId: params.boxId,
      fileTag: params.fileTag,
      chunkBlobId: params.chunkBlobId,
      nowMs,
    });

    if (!bytes) {
      throw new DomainError(
        "not_found",
        "Relay chunk not found or expired",
        404,
      );
    }

    return bytes;
  }

  private consumeEnvelopeBudget(
    userId: string,
    clientIp: string,
    nowMs: number,
  ): void {
    const allowed = this.rateLimiter.consume(
      `relay:envelope:${userId}:${clientIp}`,
      this.envelopeRateLimit,
      nowMs,
    );
    if (!allowed) {
      throw new DomainError(
        "rate_limited",
        "Relay envelope rate limit exceeded",
        429,
      );
    }
  }

  private consumeChunkBudget(
    userId: string,
    clientIp: string,
    nowMs: number,
  ): void {
    const allowed = this.rateLimiter.consume(
      `relay:chunk:${userId}:${clientIp}`,
      this.chunkRateLimit,
      nowMs,
    );
    if (!allowed) {
      throw new DomainError(
        "rate_limited",
        "Relay chunk rate limit exceeded",
        429,
      );
    }
  }
}
