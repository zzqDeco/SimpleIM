import {
  DEFAULT_RELAY_MAX_FILE_BYTES,
  isRecord,
  isValidPeerIdentityCert,
  isValidRelayListEnvelopesResponse,
  type CliAuthResponse,
  type ErrorCode,
  type MeResponse,
  type MetaResponse,
  type PeerCertRequest,
  type PeerCertResponse,
  type PeerIdentityCert,
  type RelayListEnvelopesResponse,
  type RelayMetaConfig,
  type RelayPutChunkResponse,
  type RelayPutEnvelopeResponse,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  createPopRequest,
  generateEd25519KeyPair,
  generatePrefixedId,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import type { BlindRelayClientPort } from "@simpleim/peer-core";

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

  private async requestBinaryPutJson<T>(
    path: string,
    sessionToken: string,
    payload: Uint8Array,
  ): Promise<T> {
    const bodyCopy = new Uint8Array(payload.byteLength);
    bodyCopy.set(payload);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: bodyCopy,
      });
    } catch (err) {
      throw new CliApiError(
        "network_error",
        err instanceof Error ? err.message : "Failed to reach server",
        0,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CliApiError(
        "invalid_response",
        `Server returned non-JSON response (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!response.ok || (isRecord(parsed) && parsed.ok === false)) {
      const errObj =
        isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
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

    return parsed as T;
  }

  private async requestBinaryGet(
    path: string,
    sessionToken: string,
  ): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/octet-stream, application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
      });
    } catch (err) {
      throw new CliApiError(
        "network_error",
        err instanceof Error ? err.message : "Failed to reach server",
        0,
      );
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      const errObj =
        isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
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

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  createBlindRelayClient(
    sessionToken: string,
    relayMeta?: RelayMetaConfig,
  ): BlindRelayClientPort {
    const enabled = relayMeta?.enabled ?? false;
    const maxFileBytes = relayMeta?.maxFileBytes ?? DEFAULT_RELAY_MAX_FILE_BYTES;

    return {
      enabled,
      maxFileBytes,
      putEnvelope: async ({ boxId, blobId, payload }) => {
        const res = await this.requestBinaryPutJson<RelayPutEnvelopeResponse>(
          `/api/v1/relay/${encodeURIComponent(boxId)}/envelopes/${encodeURIComponent(blobId)}`,
          sessionToken,
          payload,
        );
        if (
          !isRecord(res) ||
          res.ok !== true ||
          typeof res.seq !== "number" ||
          typeof res.expiresAt !== "number"
        ) {
          throw new CliApiError(
            "invalid_response",
            "Malformed relay putEnvelope response",
            200,
          );
        }
        return { seq: res.seq, expiresAt: res.expiresAt };
      },
      listEnvelopes: async ({ boxId, afterSeq, limit }) => {
        const qs = new URLSearchParams({
          afterSeq: String(Math.max(0, Math.floor(afterSeq))),
        });
        if (limit !== undefined) {
          qs.set("limit", String(Math.max(1, Math.floor(limit))));
        }
        const res = await this.requestJson<RelayListEnvelopesResponse>(
          `/api/v1/relay/${encodeURIComponent(boxId)}/envelopes?${qs.toString()}`,
          {
            method: "GET",
            sessionToken,
          },
        );
        if (!isValidRelayListEnvelopesResponse(res)) {
          throw new CliApiError(
            "invalid_response",
            "Malformed relay listEnvelopes response",
            200,
          );
        }
        return {
          items: res.items.map((item) => ({
            seq: item.seq,
            blobId: item.blobId,
            payload: base64UrlToBytes(item.payloadB64),
            expiresAt: item.expiresAt,
          })),
          nextCursor: res.nextCursor,
          hasMore: res.hasMore,
          ...(res.cursorReset ? { cursorReset: true } : {}),
        };
      },
      putChunk: async ({ boxId, fileTag, chunkBlobId, payload }) => {
        const res = await this.requestBinaryPutJson<RelayPutChunkResponse>(
          `/api/v1/relay/${encodeURIComponent(boxId)}/files/${encodeURIComponent(fileTag)}/chunks/${encodeURIComponent(chunkBlobId)}`,
          sessionToken,
          payload,
        );
        if (
          !isRecord(res) ||
          res.ok !== true ||
          typeof res.expiresAt !== "number"
        ) {
          throw new CliApiError(
            "invalid_response",
            "Malformed relay putChunk response",
            200,
          );
        }
        return { expiresAt: res.expiresAt };
      },
      getChunk: async ({ boxId, fileTag, chunkBlobId }) => {
        return this.requestBinaryGet(
          `/api/v1/relay/${encodeURIComponent(boxId)}/files/${encodeURIComponent(fileTag)}/chunks/${encodeURIComponent(chunkBlobId)}`,
          sessionToken,
        );
      },
    };
  }
}
