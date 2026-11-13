import type {
  ClientKind,
  ErrorCode,
  IceServerConfig,
  PeerCertRequest,
  PeerIdentityCert,
} from "@simpleim/contracts";
import type { Session, User } from "./entities.ts";

export interface ClockPort {
  nowMs(): number;
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
