import {
  ContractValidationError,
  isRecord,
  isValidPeerId,
  isValidRoomIdHex,
  MAX_SIGNAL_FRAME_BYTES,
  parseClientSignalingFrame,
  type ClientKind,
  type ErrorCode,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import type { AuthService, SignalingService } from "../app/index.ts";
import {
  DomainError,
  type ClockPort,
  type LoggerPort,
  type SignalingConnectionHandle,
} from "../domain/index.ts";
import {
  buildCorsHeaders,
  extractAuthCredentials,
  isOriginAllowed,
  resolveCorrelationId,
} from "./origin.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface WsConnectionData {
  readonly connectionId: string;
  readonly corrId: string;
  readonly peerId: string;
  readonly userId: string;
  readonly clientKind: ClientKind;
  readonly connectedAt: number;
}

export interface WsUpgradeCapableServer {
  upgrade(req: Request, options: { data: WsConnectionData }): boolean;
}

export interface WsSocketLike {
  readonly data: WsConnectionData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
}

const MAX_CONSECUTIVE_RATE_LIMITED_FRAMES = 16;

export interface WsHandlerDependencies {
  readonly authService: AuthService;
  readonly signalingService: SignalingService;
  readonly logger: LoggerPort;
  readonly clock: ClockPort;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly maxSignalPayloadBytes?: number;
}

export class WsHandler {
  private readonly authService: AuthService;
  private readonly signalingService: SignalingService;
  private readonly logger: LoggerPort;
  private readonly clock: ClockPort;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly maxSignalPayloadBytes: number;
  private readonly consecutiveRateLimits = new Map<string, number>();

  constructor(deps: WsHandlerDependencies) {
    this.authService = deps.authService;
    this.signalingService = deps.signalingService;
    this.logger = deps.logger;
    this.clock = deps.clock;
    this.allowedOrigins = deps.allowedOrigins;
    this.maxSignalPayloadBytes =
      deps.maxSignalPayloadBytes ?? MAX_SIGNAL_FRAME_BYTES;
  }

  handleUpgrade(
    req: Request,
    url: URL,
    server: WsUpgradeCapableServer,
  ): Response | undefined {
    const startMs = this.clock.nowMs();
    const corrId = resolveCorrelationId(req);
    const originHeader = req.headers.get("origin");
    const corsHeaders = buildCorsHeaders(
      originHeader,
      url,
      this.allowedOrigins,
    );

    try {
      if (req.method.toUpperCase() !== "GET") {
        throw new DomainError(
          "invalid_arguments",
          "WebSocket signaling upgrade requires GET",
          400,
        );
      }

      const creds = extractAuthCredentials(req);
      if (!creds) {
        throw new DomainError("unauthorized", "Authentication required", 401);
      }

      if (creds.method === "cookie") {
        if (!isOriginAllowed(originHeader, url, this.allowedOrigins)) {
          throw new DomainError(
            "csrf_invalid",
            "Missing or disallowed Origin for cookie WebSocket upgrade",
            403,
          );
        }
      }

      const auth = this.authService.authenticateSession(creds.rawToken);

      const peerId = url.searchParams.get("peerId");
      if (!isValidPeerId(peerId)) {
        throw new DomainError(
          "invalid_arguments",
          "Invalid or missing peerId query parameter",
          400,
        );
      }

      if (!this.signalingService.canClaimPeerId(peerId, auth.user.id)) {
        throw new DomainError(
          "unauthorized",
          "peerId is already bound to another active user",
          403,
        );
      }

      const data: WsConnectionData = {
        connectionId: crypto.randomUUID(),
        corrId,
        peerId,
        userId: auth.user.id,
        clientKind: auth.session.clientKind,
        connectedAt: this.clock.nowMs(),
      };

      const upgraded = server.upgrade(req, { data });
      if (!upgraded) {
        throw new DomainError(
          "invalid_arguments",
          "WebSocket upgrade rejected",
          400,
        );
      }

      this.logger.info("ws.upgrade", {
        corrId,
        method: "GET",
        path: url.pathname,
        status: 101,
        peerId,
        userId: auth.user.id,
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
      return undefined;
    } catch (err) {
      const domainErr =
        err instanceof DomainError
          ? err
          : new DomainError("internal_error", "Internal server error", 500);

      this.logger.warn("ws.upgrade.rejected", {
        corrId,
        method: req.method.toUpperCase(),
        path: url.pathname,
        status: domainErr.httpStatus,
        errorCode: domainErr.code,
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });

      const headers = new Headers(corsHeaders);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(JSON.stringify(domainErr.toApiErrorResponse()), {
        status: domainErr.httpStatus,
        headers,
      });
    }
  }

  onOpen(ws: WsSocketLike): void {
    const startMs = this.clock.nowMs();
    const { connectionId, corrId, peerId, userId, clientKind } = ws.data;

    const handle: SignalingConnectionHandle = {
      connectionId,
      peerId,
      userId,
      clientKind,
      send(frame: ServerSignalingFrame): void {
        ws.send(JSON.stringify(frame));
      },
      close(code?: number, reason?: string): void {
        ws.close(code, reason);
      },
    };

    try {
      this.signalingService.registerConnection(handle);
      this.logger.info("ws.open", {
        corrId,
        peerId,
        userId,
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
    } catch (err) {
      const code: ErrorCode =
        err instanceof DomainError ? err.code : "internal_error";
      this.logger.warn("ws.open.rejected", {
        corrId,
        peerId,
        userId,
        errorCode: code,
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
      ws.close(1008, "Connection registration rejected");
    }
  }

  onMessage(ws: WsSocketLike, rawMessage: string | Uint8Array): void {
    const startMs = this.clock.nowMs();
    const { connectionId, corrId, peerId, userId } = ws.data;

    const byteLength =
      typeof rawMessage === "string"
        ? textEncoder.encode(rawMessage).byteLength
        : rawMessage.byteLength;

    if (byteLength > this.maxSignalPayloadBytes) {
      this.logger.warn("ws.frame.oversized", {
        corrId,
        peerId,
        userId,
        errorCode: "payload_too_large",
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
      ws.close(
        1009,
        `Signaling frame exceeds ${this.maxSignalPayloadBytes}-byte limit`,
      );
      return;
    }

    try {
      this.signalingService.consumeInboundFrameBudget(connectionId);
      this.consecutiveRateLimits.delete(connectionId);
    } catch (err) {
      const code: ErrorCode =
        err instanceof DomainError ? err.code : "rate_limited";
      const message =
        err instanceof DomainError
          ? err.message
          : "Signaling frame rate limit exceeded";
      const consecutive =
        (this.consecutiveRateLimits.get(connectionId) ?? 0) + 1;
      this.consecutiveRateLimits.set(connectionId, consecutive);
      this.sendErrorFrame(ws, code, message);
      this.logger.warn("ws.frame.error", {
        corrId,
        peerId,
        userId,
        errorCode: code,
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
      if (consecutive >= MAX_CONSECUTIVE_RATE_LIMITED_FRAMES) {
        ws.close(1008, "Signaling rate limit exceeded");
      }
      return;
    }

    let textFrame: string;
    if (typeof rawMessage === "string") {
      textFrame = rawMessage;
    } else {
      try {
        textFrame = textDecoder.decode(rawMessage);
      } catch {
        this.sendErrorFrame(
          ws,
          "invalid_frame",
          "Signaling frame must be valid UTF-8 JSON",
        );
        this.logger.warn("ws.frame.error", {
          corrId,
          peerId,
          userId,
          errorCode: "invalid_frame",
          durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
        });
        return;
      }
    }

    let maybeRoomId: string | undefined;
    try {
      const parsedJson: unknown = JSON.parse(textFrame);
      if (isRecord(parsedJson) && isValidRoomIdHex(parsedJson.roomId)) {
        maybeRoomId = parsedJson.roomId;
      }

      const frame = parseClientSignalingFrame(parsedJson, {
        maxFrameBytes: this.maxSignalPayloadBytes,
      });
      maybeRoomId = frame.roomId;

      switch (frame.type) {
        case "room.join":
          this.signalingService.joinRoom(connectionId, frame.roomId, {
            rateLimitAlreadyChecked: true,
          });
          break;
        case "room.leave":
          this.signalingService.leaveRoom(connectionId, frame.roomId, {
            rateLimitAlreadyChecked: true,
          });
          break;
        case "signal.relay":
          this.signalingService.relaySignal(
            connectionId,
            frame.roomId,
            frame.toPeerId,
            frame.envelope,
            { rateLimitAlreadyChecked: true },
          );
          break;
      }

      this.logger.info("ws.frame", {
        corrId,
        peerId,
        userId,
        frameType: frame.type,
        roomIdPrefix: frame.roomId.slice(0, 8),
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
    } catch (err) {
      let code: ErrorCode = "invalid_frame";
      let message = "Malformed signaling frame";

      if (err instanceof ContractValidationError) {
        code = err.code;
        message = err.message;
      } else if (err instanceof DomainError) {
        code = err.code;
        message = err.message;
      } else if (!(err instanceof SyntaxError)) {
        code = "internal_error";
        message = "Internal signaling error";
      }

      this.sendErrorFrame(ws, code, message, maybeRoomId);
      this.logger.warn("ws.frame.error", {
        corrId,
        peerId,
        userId,
        errorCode: code,
        ...(maybeRoomId ? { roomIdPrefix: maybeRoomId.slice(0, 8) } : {}),
        durationMs: Math.max(0, Math.round(this.clock.nowMs() - startMs)),
      });
    }
  }

  onClose(ws: WsSocketLike): void {
    const { connectionId, corrId, peerId, userId, connectedAt } = ws.data;
    this.consecutiveRateLimits.delete(connectionId);
    this.signalingService.disconnectPeer(connectionId);
    this.logger.info("ws.close", {
      corrId,
      peerId,
      userId,
      durationMs: Math.max(0, Math.round(this.clock.nowMs() - connectedAt)),
    });
  }

  private sendErrorFrame(
    ws: WsSocketLike,
    code: ErrorCode,
    message: string,
    roomId?: string,
  ): void {
    const errFrame: ServerSignalingFrame = {
      type: "error",
      code,
      message,
      ...(roomId ? { roomId } : {}),
    };
    try {
      ws.send(JSON.stringify(errFrame));
    } catch {
      // Ignore send failures on closing sockets.
    }
  }
}
