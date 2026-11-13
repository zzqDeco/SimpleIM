import { DomainError } from "../domain/index.ts";

export const SESSION_COOKIE_NAME = "simpleim_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

const SAFE_CORR_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export type ExtractedCredentials =
  | { readonly method: "bearer"; readonly rawToken: string }
  | { readonly method: "cookie"; readonly rawToken: string };

export function normalizeAllowedOrigins(
  origins?: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (!origins) {
    return out;
  }
  for (const raw of origins) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      out.add("*");
      continue;
    }
    try {
      out.add(new URL(trimmed).origin);
    } catch {
      // Ignore malformed configured origins.
    }
  }
  return out;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  );
}

export function isOriginAllowed(
  originHeader: string | null,
  requestUrl: URL,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!originHeader || originHeader === "null") {
    return false;
  }
  if (allowedOrigins.has("*")) {
    return true;
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsedOrigin.origin === requestUrl.origin) {
    return true;
  }
  if (
    parsedOrigin.protocol === requestUrl.protocol &&
    parsedOrigin.port === requestUrl.port &&
    isLoopbackHost(parsedOrigin.hostname) &&
    isLoopbackHost(requestUrl.hostname)
  ) {
    return true;
  }
  return allowedOrigins.has(parsedOrigin.origin);
}

export function buildCorsHeaders(
  originHeader: string | null,
  requestUrl: URL,
  allowedOrigins: ReadonlySet<string>,
): Record<string, string> {
  if (!originHeader || !isOriginAllowed(originHeader, requestUrl, allowedOrigins)) {
    return {};
  }
  return {
    "access-control-allow-origin": originHeader,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    if (!rawValue) {
      return null;
    }
    try {
      const decoded = decodeURIComponent(rawValue);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function extractAuthCredentials(
  req: Request,
): ExtractedCredentials | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    const token = match?.[1];
    if (!token) {
      throw new DomainError("unauthorized", "Malformed Authorization header");
    }
    return { method: "bearer", rawToken: token };
  }

  const cookieToken = parseSessionCookie(req.headers.get("cookie"));
  if (cookieToken !== null) {
    return { method: "cookie", rawToken: cookieToken };
  }

  return null;
}

export function formatSessionSetCookie(
  rawToken: string,
  maxAgeSeconds: number,
  secureCookies: boolean,
): string {
  const base = `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  return secureCookies ? `${base}; Secure` : base;
}

export function formatClearSessionCookie(secureCookies: boolean): string {
  const base = `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return secureCookies ? `${base}; Secure` : base;
}

export function extractClientIp(
  req: Request,
  directAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
  }
  return directAddress ?? "127.0.0.1";
}

export function resolveCorrelationId(req: Request): string {
  const incoming =
    req.headers.get("x-correlation-id") ?? req.headers.get("x-request-id");
  if (incoming && SAFE_CORR_ID_RE.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}
