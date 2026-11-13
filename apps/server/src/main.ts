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

if (import.meta.main) {
  const logger = new JsonBoundaryLogger();
  const port = parsePortEnv(process.env.PORT, 3000);
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const sqlitePath =
    process.env.SQLITE_PATH?.trim() || ".runtime/simpleim.sqlite";
  const serverIdentityPrivateKey =
    process.env.SERVER_IDENTITY_PRIVATE_KEY?.trim() || undefined;
  const serverKeyId = process.env.SERVER_KEY_ID?.trim() || "srvk_2026_01";
  const allowedOrigins = parseCsvEnv(process.env.ALLOWED_ORIGINS);
  const coturnUrls = parseCsvEnv(process.env.COTURN_URLS);
  const coturnSharedSecret =
    process.env.COTURN_SHARED_SECRET?.trim() || undefined;
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
    allowedOrigins,
    coturnUrls,
    coturnSharedSecret,
    secureCookies,
    trustProxy,
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
