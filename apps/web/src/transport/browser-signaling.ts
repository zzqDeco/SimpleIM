import {
  ContractValidationError,
  MAX_SIGNAL_FRAME_BYTES,
  parseClientSignalingFrame,
  parseServerSignalingFrame,
  type ClientSignalingFrame,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import type { SignalingClientPort } from "@simpleim/peer-core";

export interface BrowserSignalingClientOptions {
  peerId: string;
  wsUrl?: string;
  maxSignalPayloadBytes?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
}

export function buildSignalingWebSocketUrl(
  peerId: string,
  explicitWsUrl?: string,
): string {
  if (explicitWsUrl) {
    const u = new URL(explicitWsUrl);
    u.searchParams.set("peerId", peerId);
    return u.toString();
  }
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws/v1/signaling?peerId=${encodeURIComponent(peerId)}`;
}

export class BrowserSignalingClient implements SignalingClientPort {
  private readonly wsUrl: string;
  private readonly maxSignalPayloadBytes?: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly createWebSocket: (url: string) => WebSocket;

  private ws: WebSocket | null = null;
  private connected = false;
  private active = false;
  private hasConnectedOnce = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly frameHandlers = new Set<(frame: ServerSignalingFrame) => void>();
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();

  constructor(options: BrowserSignalingClientOptions) {
    this.wsUrl = buildSignalingWebSocketUrl(options.peerId, options.wsUrl);
    this.maxSignalPayloadBytes = options.maxSignalPayloadBytes;
    this.initialBackoffMs = options.initialBackoffMs ?? 400;
    this.maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.createWebSocket =
      options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.clearReconnectTimer();
    this.active = true;

    return new Promise<void>((resolve, reject) => {
      this.openSocket({
        onInitialOpen: resolve,
        onInitialError: (err) => {
          this.active = false;
          reject(err);
        },
      });
    });
  }

  send(frame: ClientSignalingFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const validated = parseClientSignalingFrame(
      frame,
      this.maxSignalPayloadBytes !== undefined
        ? { maxFrameBytes: this.maxSignalPayloadBytes }
        : undefined,
    );
    const serialized = JSON.stringify(validated);
    const maxBytes = this.maxSignalPayloadBytes ?? MAX_SIGNAL_FRAME_BYTES;
    if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
      throw new ContractValidationError(
        `Signaling frame exceeds ${maxBytes}-byte limit`,
        "payload_too_large",
      );
    }
    this.ws.send(serialized);
  }

  disconnect(): void {
    this.active = false;
    this.clearReconnectTimer();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close(1000, "client disconnect");
        }
      } catch {
        // Ignore close errors
      }
    }
    if (this.connected) {
      this.connected = false;
      this.emitConnectionChange(false);
    }
  }

  onServerFrame(handler: (frame: ServerSignalingFrame) => void): void {
    this.frameHandlers.add(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.add(handler);
  }

  private openSocket(initialCallbacks?: {
    onInitialOpen: () => void;
    onInitialError: (err: Error) => void;
  }): void {
    if (!this.active) {
      return;
    }

    let settledInitial = false;
    let socket: WebSocket;
    try {
      socket = this.createWebSocket(this.wsUrl);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (initialCallbacks && !settledInitial) {
        settledInitial = true;
        initialCallbacks.onInitialError(error);
      } else {
        this.scheduleReconnect();
      }
      return;
    }

    socket.binaryType = "arraybuffer";
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket || !this.active) {
        try {
          socket.close();
        } catch {
          // Ignore
        }
        return;
      }
      this.hasConnectedOnce = true;
      this.reconnectAttempt = 0;
      const wasConnected = this.connected;
      this.connected = true;
      if (!wasConnected) {
        this.emitConnectionChange(true);
      }
      if (initialCallbacks && !settledInitial) {
        settledInitial = true;
        initialCallbacks.onInitialOpen();
      }
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.ws !== socket) return;
      let rawText: string | null = null;
      if (typeof event.data === "string") {
        rawText = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        rawText = new TextDecoder().decode(new Uint8Array(event.data));
      }
      if (rawText === null) return;

      try {
        const frame = parseServerSignalingFrame(
          rawText,
          this.maxSignalPayloadBytes !== undefined
            ? { maxFrameBytes: this.maxSignalPayloadBytes }
            : undefined,
        );
        for (const handler of this.frameHandlers) {
          handler(frame);
        }
      } catch {
        // Drop malformed inbound signaling frame safely
      }
    };

    socket.onerror = () => {
      // Handled uniformly in onclose so state transitions occur once
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.ws === socket) {
        this.ws = null;
      }
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.emitConnectionChange(false);
      }

      if (initialCallbacks && !settledInitial) {
        settledInitial = true;
        initialCallbacks.onInitialError(
          new Error(
            `Signaling WebSocket closed before open (code ${event.code || 1006})`,
          ),
        );
        return;
      }

      if (this.active && this.hasConnectedOnce) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer !== null) {
      return;
    }
    const expDelay = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    const jitter = Math.floor(Math.random() * 150);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, expDelay + jitter);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emitConnectionChange(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}
