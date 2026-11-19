import type { Database } from "bun:sqlite";
import type { RelayMetaConfig, ServerLimits } from "@simpleim/contracts";
import {
  HttpHandler,
  normalizeAllowedOrigins,
  WsHandler,
  type WsConnectionData,
} from "./adapter/index.ts";
import {
  AuthService,
  DEFAULT_RELAY_CONFIG,
  DEFAULT_SERVER_LIMITS,
  RelayService,
  SignalingService,
} from "./app/index.ts";
import type {
  BlindRelayStorePort,
  ClockPort,
  LoggerPort,
  RateLimitRule,
  RelayConfig,
} from "./domain/index.ts";
import {
  BunPasswordHasher,
  FsBlindRelayStore,
  InMemoryBlindRelayStore,
  InMemoryRateLimiter,
  JsonBoundaryLogger,
  openAndMigrateSqliteDb,
  ServerIdentitySigner,
  SqliteSessionRepository,
  SqliteUserRepository,
  SystemClock,
} from "./infra/index.ts";

export interface SimpleImRelayOptions extends Partial<RelayMetaConfig> {
  readonly cacheDir?: string;
  readonly sweepIntervalMs?: number;
}

export interface SimpleImServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly sqlitePath?: string;
  readonly serverIdentityPrivateKey?: string;
  readonly serverKeyId?: string;
  readonly nodeEnv?: string;
  readonly version?: string;
  readonly commitSha?: string;
  readonly allowedOrigins?: readonly string[];
  readonly stunUrls?: readonly string[];
  readonly coturnUrls?: readonly string[];
  readonly coturnSharedSecret?: string;
  readonly turnTtlSeconds?: number;
  readonly secureCookies?: boolean;
  readonly trustProxy?: boolean;
  readonly passwordHashMemoryCost?: number;
  readonly passwordHashTimeCost?: number;
  readonly sessionTtlMs?: number;
  readonly peerCertTtlMs?: number;
  readonly popMaxSkewMs?: number;
  readonly limits?: Partial<ServerLimits>;
  readonly relay?: SimpleImRelayOptions;
  readonly authRateLimit?: RateLimitRule;
  readonly peerCertRateLimit?: RateLimitRule;
  readonly wsFrameRateLimit?: RateLimitRule;
  readonly relayEnvelopeRateLimit?: RateLimitRule;
  readonly relayChunkRateLimit?: RateLimitRule;
  readonly logger?: LoggerPort;
  readonly logSink?: (jsonLine: string) => void;
  readonly clock?: ClockPort;
}

export interface SimpleImServerInstance {
  readonly server: Bun.Server<WsConnectionData>;
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly wsUrl: string;
  readonly serverKeyId: string;
  readonly serverSignPubKey: string;
  readonly sqliteDb: Database;
  readonly signalingService: SignalingService;
  readonly relayService: RelayService;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export function createSimpleImServer(
  options: SimpleImServerOptions = {},
): SimpleImServerInstance {
  const host = options.host ?? "127.0.0.1";
  const sqlitePath = options.sqlitePath ?? ":memory:";
  const clock = options.clock ?? new SystemClock();
  const logger =
    options.logger ??
    new JsonBoundaryLogger({
      clock,
      sink: options.logSink,
    });

  const sqliteDb = openAndMigrateSqliteDb(sqlitePath, clock.nowMs());
  const userRepo = new SqliteUserRepository(sqliteDb);
  const sessionRepo = new SqliteSessionRepository(sqliteDb);

  const passwordHasher = new BunPasswordHasher({
    memoryCost: options.passwordHashMemoryCost,
    timeCost: options.passwordHashTimeCost,
  });

  const effectiveNodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const requireExplicitKey = effectiveNodeEnv === "production";
  const isPersistentSqlite =
    sqlitePath !== ":memory:" && !sqlitePath.startsWith("file::memory:");
  const persistedKeyPath =
    !options.serverIdentityPrivateKey && !requireExplicitKey && isPersistentSqlite
      ? `${sqlitePath}.identity.key`
      : undefined;

  const identitySigner = new ServerIdentitySigner({
    serverKeyId: options.serverKeyId,
    privateKeyBase64Url: options.serverIdentityPrivateKey,
    persistedKeyPath,
    requireExplicitKey,
    coturnUrls: options.coturnUrls,
    coturnSharedSecret: options.coturnSharedSecret,
    turnTtlSeconds: options.turnTtlSeconds,
  });

  const rateLimiter = new InMemoryRateLimiter();

  const limits: ServerLimits = {
    maxPeersPerRoom:
      options.limits?.maxPeersPerRoom ?? DEFAULT_SERVER_LIMITS.maxPeersPerRoom,
    maxRoomsPerConnection:
      options.limits?.maxRoomsPerConnection ??
      DEFAULT_SERVER_LIMITS.maxRoomsPerConnection,
    maxSignalPayloadBytes:
      options.limits?.maxSignalPayloadBytes ??
      DEFAULT_SERVER_LIMITS.maxSignalPayloadBytes,
  };

  if (
    !Number.isInteger(limits.maxSignalPayloadBytes) ||
    limits.maxSignalPayloadBytes < 1_024 ||
    limits.maxSignalPayloadBytes > 262_144
  ) {
    throw new Error(
      `Invalid limits.maxSignalPayloadBytes (${limits.maxSignalPayloadBytes}); expected 1024..262144`,
    );
  }

  const relayConfig: RelayConfig = {
    enabled: options.relay?.enabled ?? DEFAULT_RELAY_CONFIG.enabled,
    ttlMs: options.relay?.ttlMs ?? DEFAULT_RELAY_CONFIG.ttlMs,
    maxFileBytes:
      options.relay?.maxFileBytes ?? DEFAULT_RELAY_CONFIG.maxFileBytes,
    maxTotalBytes:
      options.relay?.maxTotalBytes ?? DEFAULT_RELAY_CONFIG.maxTotalBytes,
    maxEnvelopeTotalBytes:
      options.relay?.maxEnvelopeTotalBytes ??
      DEFAULT_RELAY_CONFIG.maxEnvelopeTotalBytes,
  };

  if (!Number.isSafeInteger(relayConfig.ttlMs) || relayConfig.ttlMs <= 0) {
    throw new Error(`Invalid relay.ttlMs (${relayConfig.ttlMs}); expected > 0`);
  }
  if (
    !Number.isSafeInteger(relayConfig.maxFileBytes) ||
    relayConfig.maxFileBytes <= 0
  ) {
    throw new Error(
      `Invalid relay.maxFileBytes (${relayConfig.maxFileBytes}); expected > 0`,
    );
  }
  if (
    !Number.isSafeInteger(relayConfig.maxTotalBytes) ||
    relayConfig.maxTotalBytes <= 0
  ) {
    throw new Error(
      `Invalid relay.maxTotalBytes (${relayConfig.maxTotalBytes}); expected > 0`,
    );
  }
  if (
    !Number.isSafeInteger(relayConfig.maxEnvelopeTotalBytes) ||
    relayConfig.maxEnvelopeTotalBytes <= 0
  ) {
    throw new Error(
      `Invalid relay.maxEnvelopeTotalBytes (${relayConfig.maxEnvelopeTotalBytes}); expected > 0`,
    );
  }

  const rawRelayCacheDir = options.relay?.cacheDir?.trim();
  const relayStore: BlindRelayStorePort =
    rawRelayCacheDir && rawRelayCacheDir !== ":memory:"
      ? new FsBlindRelayStore({
          cacheDir: rawRelayCacheDir,
          maxTotalBytes: relayConfig.maxTotalBytes,
          maxEnvelopeTotalBytes: relayConfig.maxEnvelopeTotalBytes,
          clock,
          sweepIntervalMs: options.relay?.sweepIntervalMs,
        })
      : new InMemoryBlindRelayStore({
          maxTotalBytes: relayConfig.maxTotalBytes,
          maxEnvelopeTotalBytes: relayConfig.maxEnvelopeTotalBytes,
          clock,
          sweepIntervalMs: options.relay?.sweepIntervalMs,
        });

  const authService = new AuthService({
    userRepo,
    sessionRepo,
    passwordHasher,
    identitySigner,
    rateLimiter,
    clock,
    stunUrls: options.stunUrls,
    limits,
    relay: relayConfig,
    sessionTtlMs: options.sessionTtlMs,
    peerCertTtlMs: options.peerCertTtlMs,
    popMaxSkewMs: options.popMaxSkewMs,
    authRateLimit: options.authRateLimit,
    peerCertRateLimit: options.peerCertRateLimit,
  });

  const relayService = new RelayService({
    store: relayStore,
    rateLimiter,
    clock,
    config: relayConfig,
    envelopeRateLimit: options.relayEnvelopeRateLimit,
    chunkRateLimit: options.relayChunkRateLimit,
  });

  const signalingService = new SignalingService({
    rateLimiter,
    clock,
    maxPeersPerRoom: limits.maxPeersPerRoom,
    maxRoomsPerConnection: limits.maxRoomsPerConnection,
    wsFrameRateLimit: options.wsFrameRateLimit,
  });

  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const secureCookies = options.secureCookies ?? false;
  const trustProxy = options.trustProxy ?? false;

  const httpHandler = new HttpHandler({
    authService,
    relayService,
    logger,
    clock,
    allowedOrigins,
    secureCookies,
    trustProxy,
    version: options.version,
    commitSha: options.commitSha,
  });

  const wsHandler = new WsHandler({
    authService,
    signalingService,
    logger,
    clock,
    allowedOrigins,
    maxSignalPayloadBytes: limits.maxSignalPayloadBytes,
  });

  let server: Bun.Server<WsConnectionData>;
  try {
    server = Bun.serve<WsConnectionData>({
      port: options.port ?? 3000,
      hostname: host,
      maxRequestBodySize: 1_048_576,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws/v1/signaling") {
          return wsHandler.handleUpgrade(req, url, srv);
        }
        const directIp = srv.requestIP(req)?.address;
        return httpHandler.handle(req, url, directIp);
      },
      websocket: {
        maxPayloadLength: Math.min(
          524_288,
          Math.max(limits.maxSignalPayloadBytes + 4_096, 65_536),
        ),
        idleTimeout: 120,
        open(ws) {
          wsHandler.onOpen(ws);
        },
        message(ws, message) {
          wsHandler.onMessage(ws, message);
        },
        close(ws) {
          wsHandler.onClose(ws);
        },
      },
    });
  } catch (err) {
    relayStore.close();
    try {
      sqliteDb.close(false);
    } catch {
      // Ignore SQLite close errors during failed startup.
    }
    throw err;
  }

  const boundPort = server.port;
  if (boundPort === undefined) {
    relayStore.close();
    throw new Error("Expected TCP port on SimpleIM server");
  }

  const connectHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${connectHost}:${boundPort}`;
  const wsUrl = `ws://${connectHost}:${boundPort}/ws/v1/signaling`;

  let stopped = false;

  return {
    server,
    port: boundPort,
    host,
    url,
    wsUrl,
    serverKeyId: identitySigner.serverKeyId,
    serverSignPubKey: identitySigner.serverSignPubKey,
    sqliteDb,
    signalingService,
    relayService,
    async stop(closeActiveConnections = true): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      relayStore.close();
      await server.stop(closeActiveConnections);
      if (sqlitePath !== ":memory:" && !sqlitePath.startsWith("file:")) {
        try {
          sqliteDb.exec("PRAGMA wal_checkpoint(PASSIVE);");
        } catch {
          // Ignore checkpoint errors if database was closed externally.
        }
      }
    },
  };
}
