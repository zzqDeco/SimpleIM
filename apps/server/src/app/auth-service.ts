import {
  ContractValidationError,
  MAX_PEERS_PER_ROOM,
  MAX_SIGNAL_FRAME_BYTES,
  parseLoginRequest,
  parsePeerCertRequest,
  parseRegisterRequest,
  type ClientKind,
  type IceServerConfig,
  type MetaResponse,
  type PeerIdentityCert,
  type ServerLimits,
  type UserProfile,
} from "@simpleim/contracts";
import {
  DomainError,
  toUserProfile,
  type AuthenticatedSession,
  type ClockPort,
  type IdentitySignerPort,
  type PasswordHasherPort,
  type RateLimiterPort,
  type RateLimitRule,
  type Session,
  type SessionRepositoryPort,
  type User,
  type UserRepositoryPort,
} from "../domain/index.ts";

export const DEFAULT_STUN_URLS: readonly string[] = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
];

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_PEER_CERT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_POP_MAX_SKEW_MS = 60_000; // 60 seconds

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxPeersPerRoom: MAX_PEERS_PER_ROOM,
  maxRoomsPerConnection: 8,
  maxSignalPayloadBytes: MAX_SIGNAL_FRAME_BYTES,
};

export const DEFAULT_AUTH_RATE_LIMIT: RateLimitRule = {
  capacity: 15,
  refillPerSecond: 0.5,
};

export const DEFAULT_PEER_CERT_RATE_LIMIT: RateLimitRule = {
  capacity: 20,
  refillPerSecond: 1,
};

export interface AuthServiceDependencies {
  readonly userRepo: UserRepositoryPort;
  readonly sessionRepo: SessionRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly identitySigner: IdentitySignerPort;
  readonly rateLimiter: RateLimiterPort;
  readonly clock: ClockPort;
  readonly stunUrls?: readonly string[];
  readonly limits?: ServerLimits;
  readonly sessionTtlMs?: number;
  readonly peerCertTtlMs?: number;
  readonly popMaxSkewMs?: number;
  readonly authRateLimit?: RateLimitRule;
  readonly peerCertRateLimit?: RateLimitRule;
}

export interface IssuedAuthSession {
  readonly user: UserProfile;
  readonly clientKind: ClientKind;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export class AuthService {
  private readonly userRepo: UserRepositoryPort;
  private readonly sessionRepo: SessionRepositoryPort;
  private readonly passwordHasher: PasswordHasherPort;
  private readonly identitySigner: IdentitySignerPort;
  private readonly rateLimiter: RateLimiterPort;
  private readonly clock: ClockPort;
  private readonly stunUrls: readonly string[];
  private readonly limits: ServerLimits;
  private readonly sessionTtlMs: number;
  private readonly peerCertTtlMs: number;
  private readonly popMaxSkewMs: number;
  private readonly authRateLimit: RateLimitRule;
  private readonly peerCertRateLimit: RateLimitRule;

  constructor(deps: AuthServiceDependencies) {
    this.userRepo = deps.userRepo;
    this.sessionRepo = deps.sessionRepo;
    this.passwordHasher = deps.passwordHasher;
    this.identitySigner = deps.identitySigner;
    this.rateLimiter = deps.rateLimiter;
    this.clock = deps.clock;
    this.stunUrls = deps.stunUrls ?? DEFAULT_STUN_URLS;
    this.limits = deps.limits ?? DEFAULT_SERVER_LIMITS;
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.peerCertTtlMs = deps.peerCertTtlMs ?? DEFAULT_PEER_CERT_TTL_MS;
    this.popMaxSkewMs = deps.popMaxSkewMs ?? DEFAULT_POP_MAX_SKEW_MS;
    this.authRateLimit = deps.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT;
    this.peerCertRateLimit =
      deps.peerCertRateLimit ?? DEFAULT_PEER_CERT_RATE_LIMIT;
  }

  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.sessionTtlMs / 1000);
  }

  getMeta(isAuthenticated: boolean, userId?: string): MetaResponse {
    const iceServers: IceServerConfig[] = [];
    if (this.stunUrls.length > 0) {
      iceServers.push({ urls: [...this.stunUrls] });
    }
    if (isAuthenticated && userId) {
      const turn = this.identitySigner.buildTurnCredentials(
        userId,
        this.clock.nowMs(),
      );
      if (turn) {
        iceServers.push(turn);
      }
    }
    return {
      ok: true,
      serverKeyId: this.identitySigner.serverKeyId,
      serverSignPubKey: this.identitySigner.serverSignPubKey,
      iceServers,
      limits: { ...this.limits },
    };
  }

  async register(rawBody: unknown, clientIp: string): Promise<IssuedAuthSession> {
    const now = this.clock.nowMs();
    if (
      !this.rateLimiter.consume(
        `auth:register:${clientIp}`,
        this.authRateLimit,
        now,
      )
    ) {
      throw new DomainError("rate_limited", "Too many registration attempts");
    }

    const req = wrapContractParse(() => parseRegisterRequest(rawBody));

    const existing = this.userRepo.findByUsername(req.username);
    if (existing) {
      throw new DomainError("username_taken", "Username is already taken");
    }

    const passwordHash = await this.passwordHasher.hash(req.password);
    const createdAt = this.clock.nowMs();
    const user: User = {
      id: this.identitySigner.generateUserId(createdAt),
      username: req.username,
      displayName: req.displayName ?? req.username,
      passwordHash,
      createdAt,
    };

    const createdUser = this.userRepo.create(user);
    return this.createSessionForUser(createdUser, req.clientKind, createdAt);
  }

  async login(rawBody: unknown, clientIp: string): Promise<IssuedAuthSession> {
    const now = this.clock.nowMs();
    if (
      !this.rateLimiter.consume(
        `auth:login:${clientIp}`,
        this.authRateLimit,
        now,
      )
    ) {
      throw new DomainError("rate_limited", "Too many login attempts");
    }

    const req = wrapContractParse(() => parseLoginRequest(rawBody));

    const user = this.userRepo.findByUsername(req.username);
    if (!user) {
      await this.passwordHasher.verifyDummy(req.password);
      throw new DomainError(
        "invalid_credentials",
        "Invalid username or password",
      );
    }

    const passwordOk = await this.passwordHasher.verify(
      req.password,
      user.passwordHash,
    );
    if (!passwordOk) {
      throw new DomainError(
        "invalid_credentials",
        "Invalid username or password",
      );
    }

    const issuedAt = this.clock.nowMs();
    return this.createSessionForUser(user, req.clientKind, issuedAt);
  }

  authenticateSession(rawToken: string): AuthenticatedSession {
    if (
      typeof rawToken !== "string" ||
      rawToken.length < 16 ||
      rawToken.length > 256
    ) {
      throw new DomainError("unauthorized", "Invalid session token");
    }

    const tokenSha256 = this.identitySigner.hashSessionToken(rawToken);
    const session = this.sessionRepo.findByTokenSha256(tokenSha256);
    if (!session) {
      throw new DomainError("unauthorized", "Invalid or expired session");
    }

    const now = this.clock.nowMs();
    if (session.expiresAt <= now) {
      this.sessionRepo.deleteById(session.id);
      throw new DomainError("unauthorized", "Session has expired");
    }

    const user = this.userRepo.findById(session.userId);
    if (!user) {
      this.sessionRepo.deleteById(session.id);
      throw new DomainError("unauthorized", "Session user not found");
    }

    this.sessionRepo.touchLastSeen(session.id, now);
    const expectedCsrfToken = this.identitySigner.deriveCsrfToken(rawToken);

    return {
      session: {
        ...session,
        lastSeenAt: now,
      },
      user,
      rawToken,
      expectedCsrfToken,
    };
  }

  verifyCsrf(rawSessionToken: string, candidateCsrfToken: string | null): void {
    if (
      !candidateCsrfToken ||
      !this.identitySigner.verifyCsrfToken(rawSessionToken, candidateCsrfToken)
    ) {
      throw new DomainError("csrf_invalid", "Missing or invalid CSRF token");
    }
  }

  logout(sessionId: string): void {
    this.sessionRepo.deleteById(sessionId);
  }

  issuePeerCert(
    sessionUser: User,
    clientKind: ClientKind,
    rawBody: unknown,
    clientIp: string,
  ): PeerIdentityCert {
    const now = this.clock.nowMs();
    if (
      !this.rateLimiter.consume(
        `auth:peer-cert:${sessionUser.id}:${clientIp}`,
        this.peerCertRateLimit,
        now,
      )
    ) {
      throw new DomainError(
        "rate_limited",
        "Too many peer certificate requests",
      );
    }

    const req = wrapContractParse(() => parsePeerCertRequest(rawBody));

    const popValid = this.identitySigner.verifyPop({
      userId: sessionUser.id,
      request: req,
      nowMs: now,
      maxSkewMs: this.popMaxSkewMs,
    });
    if (!popValid) {
      throw new DomainError(
        "invalid_pop",
        "Invalid or expired proof-of-possession signature",
      );
    }

    return this.identitySigner.signPeerCert({
      userId: sessionUser.id,
      username: sessionUser.username,
      displayName: sessionUser.displayName,
      peerId: req.peerId,
      peerSignPubKey: req.peerSignPubKey,
      clientKind,
      nowMs: now,
      ttlMs: this.peerCertTtlMs,
    });
  }

  private createSessionForUser(
    user: User,
    clientKind: ClientKind,
    nowMs: number,
  ): IssuedAuthSession {
    this.sessionRepo.deleteExpired(nowMs);

    const { rawToken, tokenSha256 } =
      this.identitySigner.generateSessionToken();
    const expiresAt = nowMs + this.sessionTtlMs;
    const session: Session = {
      id: this.identitySigner.generateSessionId(nowMs),
      userId: user.id,
      tokenSha256,
      clientKind,
      createdAt: nowMs,
      expiresAt,
      lastSeenAt: nowMs,
    };

    this.sessionRepo.create(session);
    const csrfToken = this.identitySigner.deriveCsrfToken(rawToken);

    return {
      user: toUserProfile(user),
      clientKind,
      sessionToken: rawToken,
      csrfToken,
      expiresAt,
    };
  }
}

function wrapContractParse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ContractValidationError) {
      throw new DomainError(err.code, err.message);
    }
    throw err;
  }
}
