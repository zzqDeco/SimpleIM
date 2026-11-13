import type { Database } from "bun:sqlite";
import type { ServerLimits } from "@simpleim/contracts";
import {
  HttpHandler,
  normalizeAllowedOrigins,
  WsHandler,
  type WsConnectionData,
} from "./adapter/index.ts";
import {
  AuthService,
  DEFAULT_SERVER_LIMITS,
  SignalingService,
} from "./app/index.ts";
import type {
  ClockPort,
  LoggerPort,
  RateLimitRule,
} from "./domain/index.ts";
import {
  BunPasswordHasher,
  InMemoryRateLimiter,
  JsonBoundaryLogger,
  openAndMigrateSqliteDb,
  ServerIdentitySigner,
  SqliteSessionRepository,
  SqliteUserRepository,
  SystemClock,
} from "./infra/index.ts";

export interface SimpleImServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly sqlitePath?: string;
  readonly serverIdentityPrivateKey?: string;
  readonly serverKeyId?: string;
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
  readonly authRateLimit?: RateLimitRule;
  readonly peerCertRateLimit?: RateLimitRule;
  readonly wsFrameRateLimit?: RateLimitRule;
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

  const identitySigner = new ServerIdentitySigner({
    serverKeyId: options.serverKeyId,
    privateKeyBase64Url: options.serverIdentityPrivateKey,
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

  const authService = new AuthService({
    userRepo,
    sessionRepo,
    passwordHasher,
    identitySigner,
    rateLimiter,
    clock,
    stunUrls: options.stunUrls,
    limits,
    sessionTtlMs: options.sessionTtlMs,
    peerCertTtlMs: options.peerCertTtlMs,
    popMaxSkewMs: options.popMaxSkewMs,
    authRateLimit: options.authRateLimit,
    peerCertRateLimit: options.peerCertRateLimit,
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
    logger,
    clock,
    allowedOrigins,
    secureCookies,
    trustProxy,
  });

  const wsHandler = new WsHandler({
    authService,
    signalingService,
    logger,
    clock,
    allowedOrigins,
  });

  const server = Bun.serve<WsConnectionData>({
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
      maxPayloadLength: 262_144,
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

  const boundPort = server.port;
  if (boundPort === undefined) {
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
    async stop(closeActiveConnections = true): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
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
