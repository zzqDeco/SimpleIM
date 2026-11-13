import {
  isRecord,
  isValidPeerIdentityCert,
  type CliAuthResponse,
  type ErrorCode,
  type MeResponse,
  type MetaResponse,
  type PeerCertRequest,
  type PeerCertResponse,
  type PeerIdentityCert,
} from "@simpleim/contracts";
import {
  createPopRequest,
  generateEd25519KeyPair,
  generatePrefixedId,
  type Ed25519KeyPair,
} from "@simpleim/crypto";

export class CliApiError extends Error {
  readonly code: ErrorCode | "network_error" | "invalid_response";
  readonly status: number;

  constructor(
    code: ErrorCode | "network_error" | "invalid_response",
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "CliApiError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeServerUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid server URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Server URL must use http:// or https:// (received ${parsed.protocol})`,
    );
  }
  parsed.hash = "";
  parsed.search = "";
  const formatted = parsed.toString();
  return formatted.endsWith("/") ? formatted.slice(0, -1) : formatted;
}

export interface CliApiClientOptions {
  serverUrl: string;
  fetchImpl?: typeof fetch;
}

export class CliApiClient {
  readonly serverUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CliApiClientOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async requestJson<T>(
    path: string,
    init: {
      method: "GET" | "POST";
      sessionToken?: string;
      body?: unknown;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (init.sessionToken) {
      headers.Authorization = `Bearer ${init.sessionToken}`;
    }
    let serializedBody: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      serializedBody = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method: init.method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      });
    } catch (err) {
      throw new CliApiError(
        "network_error",
        err instanceof Error ? err.message : "Failed to reach server",
        0,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CliApiError(
        "invalid_response",
        `Server returned non-JSON response (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!response.ok || (isRecord(payload) && payload.ok === false)) {
      const errObj = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      const code =
        errObj && typeof errObj.code === "string"
          ? (errObj.code as ErrorCode)
          : "internal_error";
      const message =
        errObj && typeof errObj.message === "string"
          ? errObj.message
          : `HTTP ${response.status}`;
      throw new CliApiError(code, message, response.status);
    }

    return payload as T;
  }

  async getMeta(sessionToken?: string): Promise<MetaResponse> {
    const res = await this.requestJson<MetaResponse>("/api/v1/meta", {
      method: "GET",
      ...(sessionToken ? { sessionToken } : {}),
    });
    if (
      !isRecord(res) ||
      res.ok !== true ||
      typeof res.serverSignPubKey !== "string" ||
      !Array.isArray(res.iceServers)
    ) {
      throw new CliApiError(
        "invalid_response",
        "Malformed /api/v1/meta response",
        200,
      );
    }
    return res;
  }

  async register(params: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<CliAuthResponse> {
    const res = await this.requestJson<CliAuthResponse>("/api/v1/auth/register", {
      method: "POST",
      body: {
        username: params.username,
        password: params.password,
        ...(params.displayName !== undefined
          ? { displayName: params.displayName }
          : {}),
        clientKind: "cli",
      },
    });
    if (
      !isRecord(res) ||
      res.ok !== true ||
      typeof res.sessionToken !== "string" ||
      typeof res.expiresAt !== "number"
    ) {
      throw new CliApiError(
        "invalid_response",
        "Malformed /api/v1/auth/register CLI response",
        200,
      );
    }
    return res;
  }

  async login(params: {
    username: string;
    password: string;
  }): Promise<CliAuthResponse> {
    const res = await this.requestJson<CliAuthResponse>("/api/v1/auth/login", {
      method: "POST",
      body: {
        username: params.username,
        password: params.password,
        clientKind: "cli",
      },
    });
    if (
      !isRecord(res) ||
      res.ok !== true ||
      typeof res.sessionToken !== "string" ||
      typeof res.expiresAt !== "number"
    ) {
      throw new CliApiError(
        "invalid_response",
        "Malformed /api/v1/auth/login CLI response",
        200,
      );
    }
    return res;
  }

  async logout(sessionToken: string): Promise<void> {
    await this.requestJson<{ ok: true }>("/api/v1/auth/logout", {
      method: "POST",
      sessionToken,
      body: {},
    });
  }

  async getMe(sessionToken: string): Promise<MeResponse> {
    const res = await this.requestJson<MeResponse>("/api/v1/auth/me", {
      method: "GET",
      sessionToken,
    });
    if (!isRecord(res) || res.ok !== true || !isRecord(res.user)) {
      throw new CliApiError(
        "invalid_response",
        "Malformed /api/v1/auth/me response",
        200,
      );
    }
    return res;
  }

  async issuePeerCert(
    sessionToken: string,
    request: PeerCertRequest,
  ): Promise<PeerCertResponse> {
    const res = await this.requestJson<PeerCertResponse>("/api/v1/auth/peer-cert", {
      method: "POST",
      sessionToken,
      body: request,
    });
    if (!isRecord(res) || res.ok !== true || !isValidPeerIdentityCert(res.cert)) {
      throw new CliApiError(
        "invalid_response",
        "Malformed PeerIdentityCert returned by server",
        200,
      );
    }
    return res;
  }

  async requestFreshPeerIdentity(params: {
    sessionToken: string;
    userId: string;
    peerId?: string;
    keyPair?: Ed25519KeyPair;
  }): Promise<{
    peerId: string;
    keyPair: Ed25519KeyPair;
    cert: PeerIdentityCert;
  }> {
    const peerId = params.peerId ?? generatePrefixedId("peer");
    const keyPair = params.keyPair ?? generateEd25519KeyPair();
    const popRequest = createPopRequest({
      userId: params.userId,
      peerId,
      peerSignKeyPair: keyPair,
    });
    const { cert } = await this.issuePeerCert(params.sessionToken, popRequest);
    return { peerId, keyPair, cert };
  }
}
