import {
  isRecord,
  type ApiErrorResponse,
  type ErrorCode,
  type MetaResponse,
  type PeerCertResponse,
  type PeerIdentityCert,
  type UserProfile,
  type WebAuthResponse,
} from "@simpleim/contracts";
import { createPopRequest, type Ed25519KeyPair } from "@simpleim/crypto";

export class HttpApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(message: string, status: number, code: ErrorCode = "internal_error") {
    super(message);
    this.name = "HttpApiError";
    this.status = status;
    this.code = code;
  }
}

type AuthBroadcastMessage =
  | {
      type: "auth.logout";
      tabId: string;
    }
  | {
      type: "auth.login";
      tabId: string;
      user: UserProfile;
      csrfToken: string;
    }
  | {
      type: "auth.csrf_request";
      tabId: string;
      userId: string;
    }
  | {
      type: "auth.csrf_sync";
      tabId: string;
      userId: string;
      csrfToken: string;
    };

export type CrossTabSessionResetListener = (nextUser: UserProfile | null) => void;

export interface HttpAuthClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  enableBroadcastChannel?: boolean;
  csrfSyncTimeoutMs?: number;
}

const AUTH_CHANNEL_NAME = "simpleim-auth";
const DEFAULT_CSRF_SYNC_TIMEOUT_MS = 50;

export class HttpAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tabId: string;
  private readonly csrfSyncTimeoutMs: number;
  private csrfToken: string | null = null;
  private currentUser: UserProfile | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly resetListeners = new Set<CrossTabSessionResetListener>();
  private readonly csrfSyncWaiters = new Set<() => void>();

  constructor(options?: HttpAuthClientOptions) {
    this.baseUrl = (options?.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = options?.fetchImpl ?? ((input, init) => fetch(input, init));
    this.csrfSyncTimeoutMs =
      options?.csrfSyncTimeoutMs ?? DEFAULT_CSRF_SYNC_TIMEOUT_MS;
    this.tabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    const shouldOpenChannel = options?.enableBroadcastChannel ?? true;
    if (shouldOpenChannel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        this.handleBroadcastMessage(event.data);
      };
    }
  }

  getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  hasCsrfToken(): boolean {
    return this.csrfToken !== null && this.csrfToken.length > 0;
  }

  onCrossTabSessionReset(listener: CrossTabSessionResetListener): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  dispose(): void {
    this.resetListeners.clear();
    for (const waiter of this.csrfSyncWaiters) {
      waiter();
    }
    this.csrfSyncWaiters.clear();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  private notifyCsrfWaiters(): void {
    for (const waiter of this.csrfSyncWaiters) {
      waiter();
    }
    this.csrfSyncWaiters.clear();
  }

  private async requestCrossTabCsrfToken(userId: string): Promise<void> {
    if (!this.channel || this.hasCsrfToken()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.csrfSyncWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.csrfSyncTimeoutMs);
      this.csrfSyncWaiters.add(done);
      this.postBroadcast({
        type: "auth.csrf_request",
        tabId: this.tabId,
        userId,
      });
    });
  }

  async getMeta(): Promise<MetaResponse> {
    return this.requestJson<MetaResponse>("GET", "/api/v1/meta");
  }

  async getMe(): Promise<UserProfile | null> {
    try {
      const res = await this.requestJson<{
        ok: true;
        user: UserProfile;
        csrfToken?: string;
      }>("GET", "/api/v1/auth/me");
      this.currentUser = res.user;
      if (typeof res.csrfToken === "string" && res.csrfToken.length > 0) {
        this.csrfToken = res.csrfToken;
        this.notifyCsrfWaiters();
      } else if (!this.hasCsrfToken() && this.channel) {
        await this.requestCrossTabCsrfToken(res.user.id);
      }

      if (!this.hasCsrfToken()) {
        this.currentUser = null;
        this.csrfToken = null;
        return null;
      }
      return res.user;
    } catch (err) {
      if (err instanceof HttpApiError && err.status === 401) {
        this.currentUser = null;
        this.csrfToken = null;
        return null;
      }
      throw err;
    }
  }

  async register(params: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<UserProfile> {
    const body: Record<string, unknown> = {
      username: params.username.trim().toLowerCase(),
      password: params.password,
      clientKind: "web",
    };
    if (params.displayName && params.displayName.trim().length > 0) {
      body.displayName = params.displayName.trim();
    }

    const res = await this.requestJson<WebAuthResponse>(
      "POST",
      "/api/v1/auth/register",
      body,
    );
    this.currentUser = res.user;
    this.csrfToken = res.csrfToken;
    this.postBroadcast({
      type: "auth.login",
      tabId: this.tabId,
      user: res.user,
      csrfToken: res.csrfToken,
    });
    return res.user;
  }

  async login(params: { username: string; password: string }): Promise<UserProfile> {
    const res = await this.requestJson<WebAuthResponse>(
      "POST",
      "/api/v1/auth/login",
      {
        username: params.username.trim().toLowerCase(),
        password: params.password,
        clientKind: "web",
      },
    );
    this.currentUser = res.user;
    this.csrfToken = res.csrfToken;
    this.postBroadcast({
      type: "auth.login",
      tabId: this.tabId,
      user: res.user,
      csrfToken: res.csrfToken,
    });
    return res.user;
  }

  async logout(): Promise<void> {
    try {
      await this.requestJson<{ ok: true }>(
        "POST",
        "/api/v1/auth/logout",
        {},
        { includeCsrf: true },
      );
    } catch (err) {
      if (
        !(
          err instanceof HttpApiError &&
          (err.status === 401 || err.status === 403)
        )
      ) {
        throw err;
      }
    } finally {
      this.currentUser = null;
      this.csrfToken = null;
      this.postBroadcast({
        type: "auth.logout",
        tabId: this.tabId,
      });
    }
  }

  async issuePeerCert(params: {
    userId: string;
    peerId: string;
    peerSignKeyPair: Ed25519KeyPair;
  }): Promise<PeerIdentityCert> {
    const popReq = createPopRequest({
      userId: params.userId,
      peerId: params.peerId,
      peerSignKeyPair: params.peerSignKeyPair,
    });
    const res = await this.requestJson<PeerCertResponse>(
      "POST",
      "/api/v1/auth/peer-cert",
      popReq,
      { includeCsrf: true },
    );
    return res.cert;
  }

  private postBroadcast(message: AuthBroadcastMessage): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // Ignore closed channel errors during teardown
    }
  }

  private handleBroadcastMessage(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== "string" || typeof raw.tabId !== "string") {
      return;
    }
    if (raw.tabId === this.tabId) {
      return;
    }

    switch (raw.type) {
      case "auth.logout": {
        this.currentUser = null;
        this.csrfToken = null;
        for (const listener of this.resetListeners) {
          listener(null);
        }
        break;
      }
      case "auth.login": {
        if (!isRecord(raw.user) || typeof raw.csrfToken !== "string") {
          return;
        }
        const incomingUser = raw.user as unknown as UserProfile;
        const prevUser = this.currentUser;
        this.currentUser = incomingUser;
        this.csrfToken = raw.csrfToken;
        this.notifyCsrfWaiters();

        if (!prevUser || prevUser.id !== incomingUser.id) {
          for (const listener of this.resetListeners) {
            listener(incomingUser);
          }
        }
        break;
      }
      case "auth.csrf_request": {
        if (
          typeof raw.userId === "string" &&
          this.currentUser?.id === raw.userId &&
          this.csrfToken
        ) {
          this.postBroadcast({
            type: "auth.csrf_sync",
            tabId: this.tabId,
            userId: this.currentUser.id,
            csrfToken: this.csrfToken,
          });
        }
        break;
      }
      case "auth.csrf_sync": {
        if (
          typeof raw.userId === "string" &&
          typeof raw.csrfToken === "string" &&
          raw.csrfToken.length > 0 &&
          this.currentUser?.id === raw.userId &&
          !this.csrfToken
        ) {
          this.csrfToken = raw.csrfToken;
          this.notifyCsrfWaiters();
        }
        break;
      }
    }
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { includeCsrf?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    if (options?.includeCsrf && this.csrfToken) {
      headers["X-CSRF-Token"] = this.csrfToken;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      credentials: "include",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const headerCsrf = response.headers.get("x-csrf-token");
    if (headerCsrf && headerCsrf.length > 0) {
      this.csrfToken = headerCsrf;
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      throw new HttpApiError(
        `Unexpected non-JSON response (${response.status})`,
        response.status,
        "internal_error",
      );
    }

    if (!response.ok || (isRecord(parsed) && parsed.ok === false)) {
      const errEnv = parsed as Partial<ApiErrorResponse>;
      const code =
        isRecord(errEnv.error) && typeof errEnv.error.code === "string"
          ? (errEnv.error.code as ErrorCode)
          : response.status === 401
            ? "unauthorized"
            : "internal_error";
      const message =
        isRecord(errEnv.error) && typeof errEnv.error.message === "string"
          ? errEnv.error.message
          : `Request failed with status ${response.status}`;
      throw new HttpApiError(message, response.status, code);
    }

    return parsed as T;
  }
}
