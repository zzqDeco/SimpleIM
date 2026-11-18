import { dirname, join } from "node:path";
import {
  DEFAULT_RELAY_MAX_FILE_BYTES,
  DEFAULT_RELAY_MAX_TOTAL_BYTES,
  DEFAULT_RELAY_TTL_MS,
} from "@simpleim/contracts";
import { JsonBoundaryLogger } from "./infra/logger.ts";
import { createSimpleImServer } from "./server.ts";

export const SERVER_VERSION = "0.1.0";
export * from "./server.ts";

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePortEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT environment variable: ${raw}`);
  }
  return parsed;
}

function parseBooleanEnv(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed === "true" || trimmed === "1") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0") {
    return false;
  }
  throw new Error(`Invalid ${name} environment variable: ${raw}`);
}

function parsePositiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name} environment variable: ${raw}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} environment variable: ${raw}`);
  }
  return parsed;
}

if (import.meta.main) {
  const logger = new JsonBoundaryLogger();
  const port = parsePortEnv(process.env.PORT, 3000);
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const sqlitePath =
    process.env.SQLITE_PATH?.trim() || ".runtime/simpleim.sqlite";
  const defaultRelayCacheDir =
    sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")
      ? ":memory:"
      : join(dirname(sqlitePath), "relay-cache");
  const relayEnabled = parseBooleanEnv(
    "RELAY_ENABLED",
    process.env.RELAY_ENABLED,
    true,
  );
  const relayCacheDir =
    process.env.RELAY_CACHE_DIR?.trim() || defaultRelayCacheDir;
  const relayTtlMs = parsePositiveIntEnv(
    "RELAY_TTL_MS",
    process.env.RELAY_TTL_MS,
    DEFAULT_RELAY_TTL_MS,
  );
  const relayMaxFileBytes = parsePositiveIntEnv(
    "RELAY_MAX_FILE_BYTES",
    process.env.RELAY_MAX_FILE_BYTES,
    DEFAULT_RELAY_MAX_FILE_BYTES,
  );
  const relayMaxTotalBytes = parsePositiveIntEnv(
    "RELAY_MAX_TOTAL_BYTES",
    process.env.RELAY_MAX_TOTAL_BYTES,
    DEFAULT_RELAY_MAX_TOTAL_BYTES,
  );
  const serverIdentityPrivateKey =
    process.env.SERVER_IDENTITY_PRIVATE_KEY?.trim() || undefined;
  const serverKeyId = process.env.SERVER_KEY_ID?.trim() || "srvk_2026_01";
  const allowedOrigins = parseCsvEnv(process.env.ALLOWED_ORIGINS);
  const stunUrls =
    process.env.STUN_URLS !== undefined
      ? parseCsvEnv(process.env.STUN_URLS)
      : undefined;
  const coturnUrls = parseCsvEnv(process.env.COTURN_URLS);
  const coturnSharedSecret =
    process.env.COTURN_SHARED_SECRET?.trim() || undefined;
  const version = process.env.APP_VERSION?.trim() || SERVER_VERSION;
  const commitSha = process.env.COMMIT_SHA?.trim() || "unknown";
  const secureCookies =
    process.env.SECURE_COOKIES === "true" ||
    (process.env.SECURE_COOKIES === undefined &&
      process.env.NODE_ENV === "production");
  const trustProxy = process.env.TRUST_PROXY === "true";

  const instance = createSimpleImServer({
    port,
    host,
    sqlitePath,
    serverIdentityPrivateKey,
    serverKeyId,
    version,
    commitSha,
    allowedOrigins,
    stunUrls,
    coturnUrls,
    coturnSharedSecret,
    secureCookies,
    trustProxy,
    relay: {
      enabled: relayEnabled,
      cacheDir: relayCacheDir,
      ttlMs: relayTtlMs,
      maxFileBytes: relayMaxFileBytes,
      maxTotalBytes: relayMaxTotalBytes,
    },
    logger,
  });

  logger.info("server.started", {
    corrId: "startup",
    durationMs: 0,
    status: 200,
    path: instance.url,
  });

  const shutdown = async (): Promise<void> => {
    logger.info("server.stopping", {
      corrId: "shutdown",
      durationMs: 0,
    });
    await instance.stop(true);
    try {
      instance.sqliteDb.close(false);
    } catch {
      // Ignore close error on exit.
    }
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}
