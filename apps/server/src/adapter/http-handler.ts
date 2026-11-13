import type {
  ApiErrorResponse,
  CliAuthResponse,
  ErrorCode,
  MeResponse,
  PeerCertResponse,
  VersionResponse,
  WebAuthResponse,
} from "@simpleim/contracts";
import type { AuthService, IssuedAuthSession } from "../app/index.ts";
import {
  DomainError,
  toUserProfile,
  type AuthenticatedSession,
  type ClockPort,
  type LoggerPort,
} from "../domain/index.ts";
import {
  buildCorsHeaders,
  CSRF_HEADER_NAME,
  extractAuthCredentials,
  extractClientIp,
  formatClearSessionCookie,
  formatSessionSetCookie,
  isOriginAllowed,
  resolveCorrelationId,
} from "./origin.ts";

export const MAX_HTTP_BODY_BYTES = 65_536; // 64 KiB

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface HttpHandlerDependencies {
  readonly authService: AuthService;
  readonly logger: LoggerPort;
  readonly clock: ClockPort;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
  readonly version?: string;
  readonly commitSha?: string;
}

export class HttpHandler {
  private readonly authService: AuthService;
  private readonly logger: LoggerPort;
  private readonly clock: ClockPort;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly secureCookies: boolean;
  private readonly trustProxy: boolean;
  private readonly version: string;
  private readonly commitSha: string;

  constructor(deps: HttpHandlerDependencies) {
    this.authService = deps.authService;
    this.logger = deps.logger;
    this.clock = deps.clock;
    this.allowedOrigins = deps.allowedOrigins;
    this.secureCookies = deps.secureCookies;
    this.trustProxy = deps.trustProxy;
    this.version = deps.version ?? "0.1.0";
    this.commitSha = deps.commitSha ?? "unknown";
  }

  async handle(
    req: Request,
    url: URL,
    directIp: string | undefined,
  ): Promise<Response> {
    const startMs = this.clock.nowMs();
    const corrId = resolveCorrelationId(req);
    const method = req.method.toUpperCase();
    const path = url.pathname;
    const originHeader = req.headers.get("origin");
    const corsHeaders = buildCorsHeaders(
      originHeader,
      url,
      this.allowedOrigins,
    );

    if (method === "OPTIONS") {
      if (
        originHeader !== null &&
        !isOriginAllowed(originHeader, url, this.allowedOrigins)
      ) {
        return this.jsonError(
          new DomainError("csrf_invalid", "Origin not allowed", 403),
          {},
          corrId,
          method,
          path,
          startMs,
        );
      }
      const headers = new Headers(corsHeaders);
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set(
        "access-control-allow-headers",
        "Content-Type, Authorization, X-CSRF-Token, X-Correlation-Id",
      );
      headers.set("access-control-max-age", "600");
      this.logBoundary("info", "http.preflight", {
        corrId,
        method,
        path,
        status: 204,
        durationMs: this.clock.nowMs() - startMs,
      });
      return new Response(null, { status: 204, headers });
    }

    let loggedUserId: string | undefined;

    try {
      const clientIp = extractClientIp(req, directIp, this.trustProxy);

      if (method === "GET" && path === "/healthz") {
        const res = this.jsonResponse(200, { ok: true }, corsHeaders);
        this.logBoundary("info", "http.request", {
          corrId,
          method,
          path,
          status: 200,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "GET" && path === "/api/v1/version") {
        const payload: VersionResponse = {
          ok: true,
          version: this.version,
          sha: this.commitSha,
        };
        const res = this.jsonResponse(200, payload, corsHeaders);
        this.logBoundary("info", "http.request", {
          corrId,
          method,
          path,
          status: 200,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "GET" && path === "/api/v1/meta") {
        const optionalAuth = this.tryAuthenticateOptional(req);
        loggedUserId = optionalAuth?.user.id;
        const meta = this.authService.getMeta(
          optionalAuth !== null,
          optionalAuth?.user.id,
        );
        const res = this.jsonResponse(200, meta, corsHeaders);
        this.logBoundary("info", "http.request", {
          corrId,
          method,
          path,
          status: 200,
          userId: loggedUserId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "POST" && path === "/api/v1/auth/register") {
        this.enforceOriginIfPresent(originHeader, url);
        const body = await readBoundedJsonBody(req, MAX_HTTP_BODY_BYTES);
        const issued = await this.authService.register(body, clientIp);
        loggedUserId = issued.user.id;
        const res = this.buildAuthSuccessResponse(201, issued, corsHeaders);
        this.logBoundary("info", "auth.register", {
          corrId,
          method,
          path,
          status: 201,
          userId: loggedUserId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "POST" && path === "/api/v1/auth/login") {
        this.enforceOriginIfPresent(originHeader, url);
        const body = await readBoundedJsonBody(req, MAX_HTTP_BODY_BYTES);
        const issued = await this.authService.login(body, clientIp);
        loggedUserId = issued.user.id;
        const res = this.buildAuthSuccessResponse(200, issued, corsHeaders);
        this.logBoundary("info", "auth.login", {
          corrId,
          method,
          path,
          status: 200,
          userId: loggedUserId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "POST" && path === "/api/v1/auth/logout") {
        const { auth, authMethod } = this.requireAuthenticated(
          req,
          url,
          originHeader,
          true,
        );
        loggedUserId = auth.user.id;
        this.authService.logout(auth.session.id);

        const extraHeaders: Record<string, string> = { ...corsHeaders };
        if (authMethod === "cookie") {
          extraHeaders["set-cookie"] = formatClearSessionCookie(
            this.secureCookies,
          );
        }
        const res = this.jsonResponse(200, { ok: true }, extraHeaders);
        this.logBoundary("info", "auth.logout", {
          corrId,
          method,
          path,
          status: 200,
          userId: loggedUserId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "GET" && path === "/api/v1/auth/me") {
        const { auth, authMethod } = this.requireAuthenticated(
          req,
          url,
          originHeader,
          false,
        );
        loggedUserId = auth.user.id;
        const payload: MeResponse = {
          ok: true,
          user: toUserProfile(auth.user),
          ...(authMethod === "cookie"
            ? { csrfToken: auth.expectedCsrfToken }
            : {}),
        };
        const res = this.jsonResponse(200, payload, corsHeaders);
        this.logBoundary("info", "auth.me", {
          corrId,
          method,
          path,
          status: 200,
          userId: loggedUserId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      if (method === "POST" && path === "/api/v1/auth/peer-cert") {
        const { auth } = this.requireAuthenticated(
          req,
          url,
          originHeader,
          true,
        );
        loggedUserId = auth.user.id;
        const body = await readBoundedJsonBody(req, MAX_HTTP_BODY_BYTES);
        const cert = this.authService.issuePeerCert(
          auth.user,
          auth.session.clientKind,
          body,
          clientIp,
        );
        const payload: PeerCertResponse = { ok: true, cert };
        const res = this.jsonResponse(200, payload, corsHeaders);
        this.logBoundary("info", "auth.peer_cert", {
          corrId,
          method,
          path,
          status: 200,
          userId: loggedUserId,
          peerId: cert.payload.peerId,
          durationMs: this.clock.nowMs() - startMs,
        });
        return res;
      }

      throw new DomainError("not_found", "Route not found", 404);
    } catch (err) {
      if (err instanceof DomainError) {
        return this.jsonError(
          err,
          corsHeaders,
          corrId,
          method,
          path,
          startMs,
          loggedUserId,
        );
      }

      const internal = new DomainError(
        "internal_error",
        "Internal server error",
        500,
      );
      return this.jsonError(
        internal,
        corsHeaders,
        corrId,
        method,
        path,
        startMs,
        loggedUserId,
      );
    }
  }

  private tryAuthenticateOptional(req: Request): AuthenticatedSession | null {
    try {
      const creds = extractAuthCredentials(req);
      if (!creds) {
        return null;
      }
      return this.authService.authenticateSession(creds.rawToken);
    } catch {
      return null;
    }
  }

  private requireAuthenticated(
    req: Request,
    url: URL,
    originHeader: string | null,
    requireCsrfOnCookie: boolean,
  ): { auth: AuthenticatedSession; authMethod: "bearer" | "cookie" } {
    const creds = extractAuthCredentials(req);
    if (!creds) {
      throw new DomainError("unauthorized", "Authentication required");
    }

    const auth = this.authService.authenticateSession(creds.rawToken);

    if (creds.method === "cookie") {
      this.enforceOriginIfPresent(originHeader, url);
      if (requireCsrfOnCookie) {
        const csrfHeader = req.headers.get(CSRF_HEADER_NAME);
        this.authService.verifyCsrf(creds.rawToken, csrfHeader);
      }
    }

    return { auth, authMethod: creds.method };
  }

  private enforceOriginIfPresent(originHeader: string | null, url: URL): void {
    if (
      originHeader !== null &&
      !isOriginAllowed(originHeader, url, this.allowedOrigins)
    ) {
      throw new DomainError("csrf_invalid", "Origin is not allowed", 403);
    }
  }

  private buildAuthSuccessResponse(
    status: 200 | 201,
    issued: IssuedAuthSession,
    corsHeaders: Record<string, string>,
  ): Response {
    if (issued.clientKind === "web") {
      const body: WebAuthResponse = {
        ok: true,
        user: issued.user,
        csrfToken: issued.csrfToken,
      };
      const headers: Record<string, string> = {
        ...corsHeaders,
        "set-cookie": formatSessionSetCookie(
          issued.sessionToken,
          this.authService.sessionMaxAgeSeconds,
          this.secureCookies,
        ),
      };
      return this.jsonResponse(status, body, headers);
    }

    const body: CliAuthResponse = {
      ok: true,
      user: issued.user,
      sessionToken: issued.sessionToken,
      expiresAt: issued.expiresAt,
    };
    return this.jsonResponse(status, body, corsHeaders);
  }

  private jsonResponse(
    status: number,
    payload: unknown,
    extraHeaders: Record<string, string>,
  ): Response {
    const headers = new Headers(extraHeaders);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(payload), { status, headers });
  }

  private jsonError(
    err: DomainError,
    extraHeaders: Record<string, string>,
    corrId: string,
    method: string,
    path: string,
    startMs: number,
    userId?: string,
  ): Response {
    const payload: ApiErrorResponse = err.toApiErrorResponse();
    const level = err.httpStatus >= 500 ? "error" : "warn";
    this.logBoundary(level, "http.error", {
      corrId,
      method,
      path,
      status: err.httpStatus,
      errorCode: err.code as ErrorCode,
      userId,
      durationMs: this.clock.nowMs() - startMs,
    });
    return this.jsonResponse(err.httpStatus, payload, extraHeaders);
  }

  private logBoundary(
    level: "info" | "warn" | "error",
    event: string,
    fields: {
      corrId: string;
      durationMs: number;
      status: number;
      method: string;
      path: string;
      errorCode?: ErrorCode;
      userId?: string;
      peerId?: string;
    },
  ): void {
    const clean = {
      corrId: fields.corrId,
      durationMs: Math.max(0, Math.round(fields.durationMs)),
      status: fields.status,
      method: fields.method,
      path: fields.path,
      ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
      ...(fields.userId ? { userId: fields.userId } : {}),
      ...(fields.peerId ? { peerId: fields.peerId } : {}),
    };
    if (level === "error") {
      this.logger.error(event, clean);
    } else if (level === "warn") {
      this.logger.warn(event, clean);
    } else {
      this.logger.info(event, clean);
    }
  }
}

async function readBoundedJsonBody(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new DomainError(
        "payload_too_large",
        `Request body exceeds ${maxBytes} byte limit`,
        413,
      );
    }
  }

  if (!req.body) {
    throw new DomainError(
      "invalid_arguments",
      "Request body must be a JSON object",
      400,
    );
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DomainError(
            "payload_too_large",
            `Request body exceeds ${maxBytes} byte limit`,
            413,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new DomainError(
      "invalid_arguments",
      "Request body must not be empty",
      400,
    );
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let rawText: string;
  try {
    rawText = textDecoder.decode(merged);
  } catch {
    throw new DomainError(
      "invalid_arguments",
      "Request body must be valid UTF-8",
      400,
    );
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new DomainError(
      "invalid_arguments",
      "Request body must be valid JSON",
      400,
    );
  }
}
