import { ContractValidationError } from "./errors.ts";

export type ClientKind = "web" | "cli";

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ServerLimits {
  maxPeersPerRoom: number;
  maxRoomsPerConnection: number;
  maxSignalPayloadBytes: number;
}

export interface MetaResponse {
  ok: true;
  serverKeyId: string;
  serverSignPubKey: string;
  iceServers: IceServerConfig[];
  limits: ServerLimits;
}

export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
  clientKind: ClientKind;
}

export interface LoginRequest {
  username: string;
  password: string;
  clientKind: ClientKind;
}

export interface WebAuthResponse {
  ok: true;
  user: UserProfile;
  csrfToken: string;
}

export interface CliAuthResponse {
  ok: true;
  user: UserProfile;
  sessionToken: string;
  expiresAt: number;
}

export type AuthResponse = WebAuthResponse | CliAuthResponse;

export interface MeResponse {
  ok: true;
  user: UserProfile;
  csrfToken?: string;
}

export interface PeerIdentityCertPayload {
  v: 1;
  iss: "simpleim-server";
  kid: string;
  userId: string;
  username: string;
  displayName: string;
  peerId: string;
  peerSignPubKey: string;
  clientKind: ClientKind;
  iat: number;
  exp: number;
}

export interface PeerIdentityCert {
  payload: PeerIdentityCertPayload;
  serverSig: string;
}

export interface PeerCertRequest {
  peerId: string;
  peerSignPubKey: string;
  timestamp: number;
  popSignature: string;
}

export interface PeerCertResponse {
  ok: true;
  cert: PeerIdentityCert;
}

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const PEER_ID_RE = /^peer_[a-zA-Z0-9_-]{8,64}$/;
const USER_ID_RE = /^usr_[a-zA-Z0-9_-]{8,64}$/;
const ROOM_ID_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidUsername(username: unknown): username is string {
  return typeof username === "string" && USERNAME_RE.test(username);
}

export function isValidPassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 128 &&
    !password.includes("\x00")
  );
}

export function isValidClientKind(kind: unknown): kind is ClientKind {
  return kind === "web" || kind === "cli";
}

export function isValidPeerId(peerId: unknown): peerId is string {
  return typeof peerId === "string" && PEER_ID_RE.test(peerId);
}

export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === "string" && USER_ID_RE.test(userId);
}

export function isValidRoomIdHex(roomId: unknown): roomId is string {
  return typeof roomId === "string" && ROOM_ID_HEX_RE.test(roomId);
}

export function isValidBase64Url(
  value: unknown,
  minLen = 1,
  maxLen = 65_536,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLen &&
    value.length <= maxLen &&
    BASE64URL_RE.test(value)
  );
}

export function normalizeDisplayName(
  displayName: unknown,
  fallbackUsername: string,
): string {
  if (displayName === undefined || displayName === null || displayName === "") {
    return fallbackUsername;
  }
  if (typeof displayName !== "string") {
    throw new ContractValidationError("displayName must be a string");
  }
  const trimmed = displayName.trim().normalize("NFC");
  const runeCount = Array.from(trimmed).length;
  if (runeCount < 1 || runeCount > 32 || trimmed.includes("\x00")) {
    throw new ContractValidationError("displayName must be 1..32 characters");
  }
  return trimmed;
}

export function parseRegisterRequest(input: unknown): RegisterRequest {
  if (!isRecord(input)) {
    throw new ContractValidationError("Request body must be a JSON object");
  }
  const rawUsername =
    typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  if (!isValidUsername(rawUsername)) {
    throw new ContractValidationError(
      "username must match ^[a-z0-9_-]{3,24}$",
    );
  }
  if (!isValidPassword(input.password)) {
    throw new ContractValidationError("password must be 8..128 characters");
  }
  if (!isValidClientKind(input.clientKind)) {
    throw new ContractValidationError("clientKind must be 'web' or 'cli'");
  }
  const displayName = normalizeDisplayName(input.displayName, rawUsername);
  return {
    username: rawUsername,
    password: input.password,
    displayName,
    clientKind: input.clientKind,
  };
}

export function parseLoginRequest(input: unknown): LoginRequest {
  if (!isRecord(input)) {
    throw new ContractValidationError("Request body must be a JSON object");
  }
  const rawUsername =
    typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  if (!isValidUsername(rawUsername)) {
    throw new ContractValidationError("Invalid username format");
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < 1 ||
    input.password.length > 256 ||
    input.password.includes("\x00")
  ) {
    throw new ContractValidationError("Invalid password format");
  }
  if (!isValidClientKind(input.clientKind)) {
    throw new ContractValidationError("clientKind must be 'web' or 'cli'");
  }
  return {
    username: rawUsername,
    password: input.password,
    clientKind: input.clientKind,
  };
}

export function parsePeerCertRequest(input: unknown): PeerCertRequest {
  if (!isRecord(input)) {
    throw new ContractValidationError("Request body must be a JSON object");
  }
  if (!isValidPeerId(input.peerId)) {
    throw new ContractValidationError("Invalid peerId");
  }
  if (!isValidBase64Url(input.peerSignPubKey, 42, 46)) {
    throw new ContractValidationError("Invalid peerSignPubKey");
  }
  if (
    typeof input.timestamp !== "number" ||
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp <= 0
  ) {
    throw new ContractValidationError("Invalid timestamp");
  }
  if (!isValidBase64Url(input.popSignature, 84, 90)) {
    throw new ContractValidationError("Invalid popSignature");
  }
  return {
    peerId: input.peerId,
    peerSignPubKey: input.peerSignPubKey,
    timestamp: input.timestamp,
    popSignature: input.popSignature,
  };
}

export function isValidPeerIdentityCert(
  value: unknown,
): value is PeerIdentityCert {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return false;
  }
  const p = value.payload;
  return (
    p.v === 1 &&
    p.iss === "simpleim-server" &&
    typeof p.kid === "string" &&
    p.kid.length >= 1 &&
    p.kid.length <= 64 &&
    isValidUserId(p.userId) &&
    isValidUsername(p.username) &&
    typeof p.displayName === "string" &&
    p.displayName.length >= 1 &&
    p.displayName.length <= 64 &&
    isValidPeerId(p.peerId) &&
    isValidBase64Url(p.peerSignPubKey, 42, 46) &&
    isValidClientKind(p.clientKind) &&
    typeof p.iat === "number" &&
    Number.isSafeInteger(p.iat) &&
    typeof p.exp === "number" &&
    Number.isSafeInteger(p.exp) &&
    p.exp > p.iat &&
    isValidBase64Url(value.serverSig, 84, 90)
  );
}

export function buildPopSignMessage(
  userId: string,
  peerId: string,
  timestamp: number,
): Uint8Array {
  return new TextEncoder().encode(
    `simpleim/v1/pop:${userId}:${peerId}:${timestamp}`,
  );
}

export function canonicalizePeerCertPayload(
  payload: PeerIdentityCertPayload,
): Uint8Array {
  const canonical = JSON.stringify({
    v: payload.v,
    iss: payload.iss,
    kid: payload.kid,
    userId: payload.userId,
    username: payload.username,
    displayName: payload.displayName,
    peerId: payload.peerId,
    peerSignPubKey: payload.peerSignPubKey,
    clientKind: payload.clientKind,
    iat: payload.iat,
    exp: payload.exp,
  });
  return new TextEncoder().encode(`simpleim/v1/peer-cert\0${canonical}`);
}
