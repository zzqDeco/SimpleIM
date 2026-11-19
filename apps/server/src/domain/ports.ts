import type {
  ClientKind,
  ErrorCode,
  IceServerConfig,
  PeerCertRequest,
  PeerIdentityCert,
  RelayMetaConfig,
} from "@simpleim/contracts";
import type { Session, User } from "./entities.ts";

export interface ClockPort {
  nowMs(): number;
}

export interface RelayConfig extends RelayMetaConfig {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEnvelopeTotalBytes: number;
}

export interface StoredRelayEnvelope {
  readonly seq: number;
  readonly blobId: string;
  readonly payload: Uint8Array;
  readonly expiresAt: number;
}

export interface PutRelayEnvelopeResult {
  readonly seq: number;
  readonly created: boolean;
  readonly expiresAt: number;
}

export interface ListRelayEnvelopesResult {
  readonly items: readonly StoredRelayEnvelope[];
  readonly hasMore: boolean;
  readonly cursorReset?: boolean;
}

export interface PutRelayChunkResult {
  readonly created: boolean;
  readonly expiresAt: number;
}

export interface BlindRelayStorePort {
  putEnvelope(params: {
    boxId: string;
    blobId: string;
    payload: Uint8Array;
    nowMs: number;
    ttlMs: number;
  }): PutRelayEnvelopeResult;
  listEnvelopes(params: {
    boxId: string;
    afterSeq: number;
    limit: number;
    nowMs: number;
  }): ListRelayEnvelopesResult;
  putChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    payload: Uint8Array;
    nowMs: number;
    ttlMs: number;
    maxFileBytes: number;
  }): PutRelayChunkResult;
  getChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    nowMs: number;
  }): Uint8Array | null;
  sweepExpired(nowMs: number): number;
  close(): void;
}

export interface UserRepositoryPort {
  findById(id: string): User | null;
  findByUsername(username: string): User | null;
  create(user: User): User;
}

export interface SessionRepositoryPort {
  create(session: Session): void;
  findByTokenSha256(tokenSha256: Uint8Array): Session | null;
  touchLastSeen(sessionId: string, lastSeenAt: number): void;
  deleteById(sessionId: string): void;
  deleteExpired(nowMs: number): number;
}

export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
  verifyDummy(password: string): Promise<void>;
}

export interface IdentitySignerPort {
  readonly serverKeyId: string;
  readonly serverSignPubKey: string;
  generateUserId(nowMs: number): string;
  generateSessionId(nowMs: number): string;
  generateSessionToken(): { rawToken: string; tokenSha256: Uint8Array };
  hashSessionToken(rawToken: string): Uint8Array;
  deriveCsrfToken(rawSessionToken: string): string;
  verifyCsrfToken(
    rawSessionToken: string,
    candidateCsrfToken: string,
  ): boolean;
  verifyPop(params: {
    userId: string;
    request: PeerCertRequest;
    nowMs: number;
    maxSkewMs: number;
  }): boolean;
  signPeerCert(params: {
    userId: string;
    username: string;
    displayName: string;
    peerId: string;
    peerSignPubKey: string;
    clientKind: ClientKind;
    nowMs: number;
    ttlMs: number;
  }): PeerIdentityCert;
  buildTurnCredentials(userId: string, nowMs: number): IceServerConfig | null;
}

export interface RateLimitRule {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimiterPort {
  consume(key: string, rule: RateLimitRule, nowMs?: number): boolean;
  resetKey(key: string): void;
}

export type LogLevel = "info" | "warn" | "error";

export interface BoundaryLogFields {
  readonly corrId: string;
  readonly durationMs?: number;
  readonly roomIdPrefix?: string;
  readonly errorCode?: ErrorCode;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  readonly peerId?: string;
  readonly userId?: string;
  readonly frameType?: string;
}

export interface LoggerPort {
  info(event: string, fields: BoundaryLogFields): void;
  warn(event: string, fields: BoundaryLogFields): void;
  error(event: string, fields: BoundaryLogFields): void;
}
