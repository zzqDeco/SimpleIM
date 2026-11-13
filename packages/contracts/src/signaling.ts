import { ContractValidationError, ERROR_CODES, type ErrorCode } from "./errors.ts";
import {
  isRecord,
  isValidBase64Url,
  isValidPeerId,
  isValidRoomIdHex,
} from "./http.ts";

export const MAX_SIGNAL_FRAME_BYTES = 32_768;

export interface EncryptedEnvelope {
  nonce: string;
  ciphertext: string;
}

export type SignalingInnerPayload =
  | {
      kind: "sdp-offer";
      sdp: string;
    }
  | {
      kind: "sdp-answer";
      sdp: string;
    }
  | {
      kind: "ice-candidate";
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    }
  | {
      kind: "ice-end";
    };

export type ClientSignalingFrame =
  | {
      type: "room.join";
      roomId: string;
    }
  | {
      type: "room.leave";
      roomId: string;
    }
  | {
      type: "signal.relay";
      roomId: string;
      toPeerId: string;
      envelope: EncryptedEnvelope;
    };

export type ServerSignalingFrame =
  | {
      type: "room.joined";
      roomId: string;
      selfPeerId: string;
      peers: string[];
    }
  | {
      type: "room.peer_joined";
      roomId: string;
      peerId: string;
    }
  | {
      type: "room.peer_left";
      roomId: string;
      peerId: string;
    }
  | {
      type: "signal.deliver";
      roomId: string;
      fromPeerId: string;
      envelope: EncryptedEnvelope;
    }
  | {
      type: "error";
      code: ErrorCode;
      message: string;
      roomId?: string;
    };

export function isValidEncryptedEnvelope(
  value: unknown,
  maxCiphertextChars = 40_000,
): value is EncryptedEnvelope {
  return (
    isRecord(value) &&
    isValidBase64Url(value.nonce, 32, 34) &&
    isValidBase64Url(value.ciphertext, 20, maxCiphertextChars)
  );
}

export function buildSignalingAad(
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
): Uint8Array {
  return new TextEncoder().encode(
    `simpleim/v1/signal:${roomId}:${fromPeerId}:${toPeerId}`,
  );
}

export function parseClientSignalingFrame(
  raw: unknown,
): ClientSignalingFrame {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_SIGNAL_FRAME_BYTES) {
      throw new ContractValidationError(
        "Signaling frame exceeds 32 KiB limit",
        "payload_too_large",
      );
    }
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ContractValidationError("Malformed JSON frame", "invalid_frame");
    }
  }
  if (!isRecord(obj) || typeof obj.type !== "string") {
    throw new ContractValidationError("Invalid signaling frame", "invalid_frame");
  }
  switch (obj.type) {
    case "room.join":
    case "room.leave": {
      if (!isValidRoomIdHex(obj.roomId)) {
        throw new ContractValidationError("Invalid roomId", "invalid_frame");
      }
      return { type: obj.type, roomId: obj.roomId };
    }
    case "signal.relay": {
      if (!isValidRoomIdHex(obj.roomId) || !isValidPeerId(obj.toPeerId)) {
        throw new ContractValidationError(
          "Invalid roomId or toPeerId",
          "invalid_frame",
        );
      }
      if (!isValidEncryptedEnvelope(obj.envelope)) {
        throw new ContractValidationError("Invalid AEAD envelope", "invalid_frame");
      }
      return {
        type: "signal.relay",
        roomId: obj.roomId,
        toPeerId: obj.toPeerId,
        envelope: obj.envelope,
      };
    }
    default:
      throw new ContractValidationError(
        "Unsupported client signaling frame type",
        "invalid_frame",
      );
  }
}

export function parseServerSignalingFrame(
  raw: unknown,
): ServerSignalingFrame {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ContractValidationError("Malformed JSON frame", "invalid_frame");
    }
  }
  if (!isRecord(obj) || typeof obj.type !== "string") {
    throw new ContractValidationError("Invalid server frame", "invalid_frame");
  }
  switch (obj.type) {
    case "room.joined": {
      if (
        !isValidRoomIdHex(obj.roomId) ||
        !isValidPeerId(obj.selfPeerId) ||
        !Array.isArray(obj.peers) ||
        !obj.peers.every(isValidPeerId)
      ) {
        throw new ContractValidationError("Invalid room.joined frame", "invalid_frame");
      }
      return {
        type: "room.joined",
        roomId: obj.roomId,
        selfPeerId: obj.selfPeerId,
        peers: obj.peers,
      };
    }
    case "room.peer_joined":
    case "room.peer_left": {
      if (!isValidRoomIdHex(obj.roomId) || !isValidPeerId(obj.peerId)) {
        throw new ContractValidationError("Invalid peer event frame", "invalid_frame");
      }
      return {
        type: obj.type,
        roomId: obj.roomId,
        peerId: obj.peerId,
      };
    }
    case "signal.deliver": {
      if (
        !isValidRoomIdHex(obj.roomId) ||
        !isValidPeerId(obj.fromPeerId) ||
        !isValidEncryptedEnvelope(obj.envelope)
      ) {
        throw new ContractValidationError("Invalid signal.deliver frame", "invalid_frame");
      }
      return {
        type: "signal.deliver",
        roomId: obj.roomId,
        fromPeerId: obj.fromPeerId,
        envelope: obj.envelope,
      };
    }
    case "error": {
      if (
        typeof obj.code !== "string" ||
        !(ERROR_CODES as readonly string[]).includes(obj.code) ||
        typeof obj.message !== "string"
      ) {
        throw new ContractValidationError("Invalid error frame", "invalid_frame");
      }
      if (obj.roomId !== undefined && !isValidRoomIdHex(obj.roomId)) {
        throw new ContractValidationError("Invalid error roomId", "invalid_frame");
      }
      return {
        type: "error",
        code: obj.code as ErrorCode,
        message: obj.message,
        ...(obj.roomId !== undefined ? { roomId: obj.roomId } : {}),
      };
    }
    default:
      throw new ContractValidationError(
        "Unsupported server signaling frame type",
        "invalid_frame",
      );
  }
}

export function parseSignalingInnerPayload(
  raw: unknown,
): SignalingInnerPayload {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ContractValidationError("Malformed inner signaling JSON", "invalid_frame");
    }
  }
  if (!isRecord(obj) || typeof obj.kind !== "string") {
    throw new ContractValidationError("Invalid inner signaling payload", "invalid_frame");
  }
  switch (obj.kind) {
    case "sdp-offer":
    case "sdp-answer": {
      if (typeof obj.sdp !== "string" || obj.sdp.length < 1 || obj.sdp.length > 28_000) {
        throw new ContractValidationError("Invalid SDP body", "invalid_frame");
      }
      return { kind: obj.kind, sdp: obj.sdp };
    }
    case "ice-candidate": {
      if (typeof obj.candidate !== "string" || obj.candidate.length > 4_096) {
        throw new ContractValidationError("Invalid ICE candidate", "invalid_frame");
      }
      const sdpMid =
        typeof obj.sdpMid === "string" || obj.sdpMid === null ? obj.sdpMid : undefined;
      const sdpMLineIndex =
        typeof obj.sdpMLineIndex === "number" || obj.sdpMLineIndex === null
          ? obj.sdpMLineIndex
          : undefined;
      return {
        kind: "ice-candidate",
        candidate: obj.candidate,
        ...(sdpMid !== undefined ? { sdpMid } : {}),
        ...(sdpMLineIndex !== undefined ? { sdpMLineIndex } : {}),
      };
    }
    case "ice-end":
      return { kind: "ice-end" };
    default:
      throw new ContractValidationError("Unknown inner signaling kind", "invalid_frame");
  }
}
