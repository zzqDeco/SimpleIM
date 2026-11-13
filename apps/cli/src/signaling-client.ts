import {
  ContractValidationError,
  MAX_SIGNAL_FRAME_BYTES,
  parseClientSignalingFrame,
  parseServerSignalingFrame,
  type ClientSignalingFrame,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import { bytesToUtf8, utf8ToBytes } from "@simpleim/crypto";
import type { SignalingClientPort } from "@simpleim/peer-core";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => WebSocketLike;

const WS_READY_STATE_OPEN = 1;

export function buildSignalingWsUrl(serverUrl: string, peerId: string): string {
  const parsed = new URL(serverUrl.trim());
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported signaling server protocol: ${parsed.protocol}`);
  }
  const basePath = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  parsed.pathname = `${basePath}/ws/v1/signaling`;
  parsed.search = "";
  parsed.searchParams.set("peerId", peerId);
  parsed.hash = "";
  return parsed.toString();
}

function defaultBunWebSocketFactory(
  url: string,
  headers: Record<string, string>,
): WebSocketLike {
  // Bun's native WebSocket constructor accepts `{ headers }` as second argument
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  return ws as unknown as WebSocketLike;
}

export interface CliSignalingClientOptions {
  serverUrl: string;
  sessionToken: string;
  peerId: string;
  maxSignalPayloadBytes?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  autoReconnect?: boolean;
  createWebSocket?: WebSocketFactory;
  onProtocolError?: (err: Error) => void;
}

export class CliSignalingClient implements SignalingClientPort {
  readonly wsUrl: string;
  private readonly sessionToken: string;
  private readonly maxSignalPayloadBytes?: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly autoReconnect: boolean;
  private readonly createWebSocket: WebSocketFactory;
  private readonly onProtocolError?: (err: Error) => void;

  private ws: WebSocketLike | null = null;
  private connected = false;
  private desiredActive = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingPromise: Promise<void> | null = null;

  private readonly frameHandlers = new Set<(frame: ServerSignalingFrame) => void>();
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();

  constructor(options: CliSignalingClientOptions) {
    this.wsUrl = buildSignalingWsUrl(options.serverUrl, options.peerId);
    this.sessionToken = options.sessionToken;
    this.maxSignalPayloadBytes = options.maxSignalPayloadBytes;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 250;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 10_000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.createWebSocket = options.createWebSocket ?? defaultBunWebSocketFactory;
    this.onProtocolError = options.onProtocolError;
  }

  get isConnected(): boolean {
    return (
      this.connected &&
      this.ws !== null &&
      this.ws.readyState === WS_READY_STATE_OPEN
    );
  }

  onServerFrame(handler: (frame: ServerSignalingFrame) => void): void {
    this.frameHandlers.add(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.add(handler);
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.desiredActive = true;
    this.clearReconnectTimer();

    this.connectingPromise = this.openSocketOnce(true).finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  send(frame: ClientSignalingFrame): void {
    const validated = parseClientSignalingFrame(
      frame,
      this.maxSignalPayloadBytes !== undefined
        ? { maxFrameBytes: this.maxSignalPayloadBytes }
        : undefined,
    );
    const serialized = JSON.stringify(validated);
    const maxBytes = this.maxSignalPayloadBytes ?? MAX_SIGNAL_FRAME_BYTES;
    if (utf8ToBytes(serialized).byteLength > maxBytes) {
      throw new ContractValidationError(
        `Signaling frame exceeds ${maxBytes}-byte limit`,
        "payload_too_large",
      );
    }
    if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) {
      throw new Error("Signaling WebSocket is not connected");
    }
    this.ws.send(serialized);
  }

  disconnect(): void {
    this.desiredActive = false;
    this.clearReconnectTimer();

    const current = this.ws;
    this.ws = null;
    const wasConnected = this.connected;
    this.connected = false;

    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      try {
        current.close(1000, "client_disconnect");
      } catch {
        // Ignore socket close errors
      }
    }

    if (wasConnected) {
      this.emitConnectionChange(false);
    }
  }

  private openSocketOnce(isInitialConnect: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.desiredActive) {
        reject(new Error("Signaling client disconnected before connecting"));
        return;
      }

      let settled = false;
      let socket: WebSocketLike;
      try {
        socket = this.createWebSocket(this.wsUrl, {
          Authorization: `Bearer ${this.sessionToken}`,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket || !this.desiredActive) {
          try {
            socket.close(1000, "stale_socket");
          } catch {
            // Ignore
          }
          if (!settled) {
            settled = true;
            reject(new Error("Signaling connection cancelled"));
          }
          return;
        }

        this.reconnectAttempts = 0;
        const wasConnected = this.connected;
        this.connected = true;
        if (!settled) {
          settled = true;
          resolve();
        }
        if (!wasConnected) {
          this.emitConnectionChange(true);
        }
      };

      socket.onmessage = (ev) => {
        if (this.ws !== socket || !this.desiredActive) {
          return;
        }
        this.handleRawMessage(ev.data);
      };

      socket.onerror = () => {
        // Browser/Bun always follows error with close; initial rejection handled in onclose
      };

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
        }
        const wasConnected = this.connected;
        this.connected = false;

        if (!settled) {
          settled = true;
          if (isInitialConnect) {
            reject(new Error("Failed to establish signaling WebSocket connection"));
            return;
          }
          resolve();
        }

        if (wasConnected) {
          this.emitConnectionChange(false);
        }

        if (this.desiredActive && this.autoReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (!this.desiredActive || !this.autoReconnect || this.reconnectTimer !== null) {
      return;
    }
    const exp = Math.min(this.reconnectAttempts, 10);
    const baseDelay = Math.min(
      this.maxReconnectDelayMs,
      this.initialReconnectDelayMs * 2 ** exp,
    );
    const jitter = Math.floor(baseDelay * 0.15 * Math.random());
    const delayMs = baseDelay + jitter;
    this.reconnectAttempts++;

    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredActive) return;
      void this.openSocketOnce(false).catch(() => {
        if (this.desiredActive && this.autoReconnect) {
          this.scheduleReconnect();
        }
      });
    }, delayMs);

    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.reconnectTimer = timer;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleRawMessage(data: unknown): void {
    let rawText: string;
    try {
      if (typeof data === "string") {
        rawText = data;
      } else if (data instanceof ArrayBuffer) {
        rawText = bytesToUtf8(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        rawText = bytesToUtf8(data);
      } else {
        throw new Error("Unsupported WebSocket frame payload type");
      }
      const parsed = parseServerSignalingFrame(
        rawText,
        this.maxSignalPayloadBytes !== undefined
          ? { maxFrameBytes: this.maxSignalPayloadBytes }
          : undefined,
      );
      for (const handler of this.frameHandlers) {
        handler(parsed);
      }
    } catch (err) {
      this.onProtocolError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitConnectionChange(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}
