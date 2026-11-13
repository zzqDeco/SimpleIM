import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildHashPageSignInput,
  buildPopSignMessage,
  canonicalizeChatSignInput,
  canonicalizeFileManifestSignInput,
  canonicalizePeerCertPayload,
  isValidChatMessageEnvelope,
  isValidFileManifest,
  isValidPeerIdentityCert,
  MAX_SWARM_FILE_CHUNKS,
  sanitizeFileName,
  SWARM_CHUNK_SIZE,
  SWARM_HASH_PAGE_CHUNKS,
  type ChatMessageEnvelope,
  type ClientKind,
  type FileManifest,
  type HelloProveFrame,
  type PeerCertRequest,
  type PeerIdentityCert,
  type PeerIdentityCertPayload,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  generateUuidV7,
  randomBytes,
  sha256Bytes,
  sha256Hex,
  utf8ToBytes,
} from "./encoding.ts";

export interface Ed25519KeyPair {
  publicKeyBytes: Uint8Array;
  privateKeyBytes: Uint8Array;
  publicKeyBase64Url: string;
  privateKeyBase64Url: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  return {
    publicKeyBytes,
    privateKeyBytes,
    publicKeyBase64Url: bytesToBase64Url(publicKeyBytes),
    privateKeyBase64Url: bytesToBase64Url(privateKeyBytes),
  };
}

export function ed25519KeyPairFromPrivateKey(
  privateKeyBase64Url: string,
): Ed25519KeyPair {
  const privateKeyBytes = base64UrlToBytes(privateKeyBase64Url);
  if (privateKeyBytes.byteLength !== 32) {
    throw new Error("Ed25519 private key must be 32 bytes");
  }
  const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
  return {
    publicKeyBytes,
    privateKeyBytes,
    publicKeyBase64Url: bytesToBase64Url(publicKeyBytes),
    privateKeyBase64Url: bytesToBase64Url(privateKeyBytes),
  };
}

export function signEd25519(
  privateKey: Uint8Array | string,
  message: Uint8Array,
): string {
  const privBytes =
    typeof privateKey === "string" ? base64UrlToBytes(privateKey) : privateKey;
  const sig = ed25519.sign(message, privBytes);
  return bytesToBase64Url(sig);
}

export function verifyEd25519(
  publicKey: Uint8Array | string,
  message: Uint8Array,
  signatureBase64Url: string,
): boolean {
  try {
    const pubBytes =
      typeof publicKey === "string" ? base64UrlToBytes(publicKey) : publicKey;
    const sigBytes = base64UrlToBytes(signatureBase64Url);
    if (pubBytes.byteLength !== 32 || sigBytes.byteLength !== 64) {
      return false;
    }
    return ed25519.verify(sigBytes, message, pubBytes);
  } catch {
    return false;
  }
}

export function createPopRequest(params: {
  userId: string;
  peerId: string;
  peerSignKeyPair: Ed25519KeyPair;
  timestamp?: number;
}): PeerCertRequest {
  const timestamp = params.timestamp ?? Date.now();
  const msg = buildPopSignMessage(params.userId, params.peerId, timestamp);
  const popSignature = signEd25519(params.peerSignKeyPair.privateKeyBytes, msg);
  return {
    peerId: params.peerId,
    peerSignPubKey: params.peerSignKeyPair.publicKeyBase64Url,
    timestamp,
    popSignature,
  };
}

export function verifyPopRequest(params: {
  userId: string;
  request: PeerCertRequest;
  nowMs?: number;
  maxSkewMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const maxSkewMs = params.maxSkewMs ?? 60_000;
  if (Math.abs(nowMs - params.request.timestamp) > maxSkewMs) {
    return false;
  }
  const msg = buildPopSignMessage(
    params.userId,
    params.request.peerId,
    params.request.timestamp,
  );
  return verifyEd25519(
    params.request.peerSignPubKey,
    msg,
    params.request.popSignature,
  );
}

export const DEFAULT_PEER_CERT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function issuePeerIdentityCert(params: {
  serverKeyId: string;
  serverSignPrivKey: Uint8Array | string;
  userId: string;
  username: string;
  displayName: string;
  peerId: string;
  peerSignPubKey: string;
  clientKind: ClientKind;
  nowMs?: number;
  ttlMs?: number;
}): PeerIdentityCert {
  const iat = params.nowMs ?? Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_PEER_CERT_TTL_MS;
  const payload: PeerIdentityCertPayload = {
    v: 1,
    iss: "simpleim-server",
    kid: params.serverKeyId,
    userId: params.userId,
    username: params.username,
    displayName: params.displayName,
    peerId: params.peerId,
    peerSignPubKey: params.peerSignPubKey,
    clientKind: params.clientKind,
    iat,
    exp: iat + ttlMs,
  };
  const serverSig = signEd25519(
    params.serverSignPrivKey,
    canonicalizePeerCertPayload(payload),
  );
  return { payload, serverSig };
}

export function verifyPeerIdentityCert(
  cert: PeerIdentityCert,
  serverSignPubKey: Uint8Array | string,
  options?: { nowMs?: number; checkExpiry?: boolean },
): { ok: true } | { ok: false; reason: "invalid_cert" | "cert_expired" } {
  if (!isValidPeerIdentityCert(cert)) {
    return { ok: false, reason: "invalid_cert" };
  }
  const sigValid = verifyEd25519(
    serverSignPubKey,
    canonicalizePeerCertPayload(cert.payload),
    cert.serverSig,
  );
  if (!sigValid) {
    return { ok: false, reason: "invalid_cert" };
  }
  const checkExpiry = options?.checkExpiry ?? true;
  if (checkExpiry) {
    const nowMs = options?.nowMs ?? Date.now();
    if (cert.payload.exp <= nowMs) {
      return { ok: false, reason: "cert_expired" };
    }
  }
  return { ok: true };
}

const SDP_SHA256_FP_RE = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]{95})\s*$/m;

export function extractSdpSha256Fingerprint(sdp: string): string {
  const match = SDP_SHA256_FP_RE.exec(sdp);
  const fp = match?.[1];
  if (!fp) {
    throw new Error("SDP missing sha-256 DTLS fingerprint");
  }
  return normalizeDtlsFingerprint(fp);
}

export function normalizeDtlsFingerprint(fingerprint: string): string {
  const upper = fingerprint.trim().toUpperCase();
  const parts = upper.split(":");
  if (parts.length !== 32 || parts.some((p) => !/^[0-9A-F]{2}$/.test(p))) {
    throw new Error("Invalid SHA-256 DTLS fingerprint format");
  }
  return parts.join(":");
}

export function computeChannelBindingTranscript(params: {
  roomId: string;
  localPeerId: string;
  remotePeerId: string;
  localFingerprint: string;
  remoteFingerprint: string;
  localNonce: string;
  remoteNonce: string;
}): Uint8Array {
  if (params.localPeerId === params.remotePeerId) {
    throw new Error("localPeerId and remotePeerId must differ");
  }
  const normLocalFp = normalizeDtlsFingerprint(params.localFingerprint);
  const normRemoteFp = normalizeDtlsFingerprint(params.remoteFingerprint);
  const localIsMin = params.localPeerId < params.remotePeerId;

  const minPeerId = localIsMin ? params.localPeerId : params.remotePeerId;
  const maxPeerId = localIsMin ? params.remotePeerId : params.localPeerId;
  const minFp = localIsMin ? normLocalFp : normRemoteFp;
  const maxFp = localIsMin ? normRemoteFp : normLocalFp;
  const minNonce = localIsMin ? params.localNonce : params.remoteNonce;
  const maxNonce = localIsMin ? params.remoteNonce : params.localNonce;

  const raw =
    `simpleim/v1/channel-binding\0` +
    `${params.roomId}\0` +
    `${minPeerId}:${maxPeerId}\0` +
    `${minFp}:${maxFp}\0` +
    `${minNonce}:${maxNonce}`;
  return sha256Bytes(raw);
}

export function createHelloChallengeNonce(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function createHelloProveFrame(params: {
  roomId: string;
  roomAuthKey: Uint8Array;
  cert: PeerIdentityCert;
  peerSignPrivKey: Uint8Array | string;
  localPeerId: string;
  remotePeerId: string;
  localFingerprint: string;
  remoteFingerprint: string;
  localNonce: string;
  remoteNonce: string;
}): HelloProveFrame {
  const transcript = computeChannelBindingTranscript({
    roomId: params.roomId,
    localPeerId: params.localPeerId,
    remotePeerId: params.remotePeerId,
    localFingerprint: params.localFingerprint,
    remoteFingerprint: params.remoteFingerprint,
    localNonce: params.localNonce,
    remoteNonce: params.remoteNonce,
  });
  const macBytes = hmac(sha256, params.roomAuthKey, transcript);
  const roomMac = bytesToBase64Url(macBytes);
  const peerSig = signEd25519(params.peerSignPrivKey, transcript);
  return {
    type: "hello.prove",
    cert: params.cert,
    roomMac,
    peerSig,
  };
}

export function verifyHelloProveFrame(params: {
  frame: HelloProveFrame;
  expectedRemotePeerId: string;
  serverSignPubKey: Uint8Array | string;
  roomId: string;
  roomAuthKey: Uint8Array;
  localPeerId: string;
  localFingerprint: string;
  remoteFingerprint: string;
  localNonce: string;
  remoteNonce: string;
  nowMs?: number;
}):
  | { ok: true; cert: PeerIdentityCert }
  | {
      ok: false;
      reason:
        | "invalid_cert"
        | "cert_expired"
        | "peer_id_mismatch"
        | "room_mac_mismatch"
        | "channel_binding_sig_mismatch";
    } {
  const certCheck = verifyPeerIdentityCert(
    params.frame.cert,
    params.serverSignPubKey,
    { nowMs: params.nowMs, checkExpiry: true },
  );
  if (!certCheck.ok) {
    return certCheck;
  }
  if (params.frame.cert.payload.peerId !== params.expectedRemotePeerId) {
    return { ok: false, reason: "peer_id_mismatch" };
  }

  let transcript: Uint8Array;
  try {
    transcript = computeChannelBindingTranscript({
      roomId: params.roomId,
      localPeerId: params.localPeerId,
      remotePeerId: params.expectedRemotePeerId,
      localFingerprint: params.localFingerprint,
      remoteFingerprint: params.remoteFingerprint,
      localNonce: params.localNonce,
      remoteNonce: params.remoteNonce,
    });
  } catch {
    return { ok: false, reason: "channel_binding_sig_mismatch" };
  }

  const expectedMac = hmac(sha256, params.roomAuthKey, transcript);
  let receivedMac: Uint8Array;
  try {
    receivedMac = base64UrlToBytes(params.frame.roomMac);
  } catch {
    return { ok: false, reason: "room_mac_mismatch" };
  }
  if (!constantTimeEqual(expectedMac, receivedMac)) {
    return { ok: false, reason: "room_mac_mismatch" };
  }

  const sigValid = verifyEd25519(
    params.frame.cert.payload.peerSignPubKey,
    transcript,
    params.frame.peerSig,
  );
  if (!sigValid) {
    return { ok: false, reason: "channel_binding_sig_mismatch" };
  }
  return { ok: true, cert: params.frame.cert };
}

export function signChatMessage(params: {
  roomId: string;
  lamport: number;
  body: string;
  replyToMsgId?: string | null;
  authorCert: PeerIdentityCert;
  peerSignPrivKey: Uint8Array | string;
  msgId?: string;
  createdAt?: number;
}): ChatMessageEnvelope {
  const createdAt = params.createdAt ?? Date.now();
  const msgId = params.msgId ?? generateUuidV7(createdAt);
  const replyToMsgId = params.replyToMsgId ?? null;
  const signBytes = canonicalizeChatSignInput({
    roomId: params.roomId,
    msgId,
    lamport: params.lamport,
    createdAt,
    body: params.body,
    replyToMsgId,
  });
  const authorSig = signEd25519(params.peerSignPrivKey, signBytes);
  return {
    msgId,
    roomId: params.roomId,
    lamport: params.lamport,
    createdAt,
    body: params.body,
    replyToMsgId,
    authorCert: params.authorCert,
    authorSig,
  };
}

export function verifyChatMessage(
  message: ChatMessageEnvelope,
  serverSignPubKey: Uint8Array | string,
  expectedRoomId: string,
): boolean {
  if (!isValidChatMessageEnvelope(message) || message.roomId !== expectedRoomId) {
    return false;
  }
  // Relayed catch-up messages verify the server's root signature on authorCert
  // even if the original session cert later expired, as long as createdAt fell within [iat, exp].
  const certValid = verifyPeerIdentityCert(message.authorCert, serverSignPubKey, {
    checkExpiry: false,
  });
  if (!certValid.ok) {
    return false;
  }
  if (
    message.createdAt < message.authorCert.payload.iat - 60_000 ||
    message.createdAt > message.authorCert.payload.exp + 60_000
  ) {
    return false;
  }
  const signBytes = canonicalizeChatSignInput({
    roomId: message.roomId,
    msgId: message.msgId,
    lamport: message.lamport,
    createdAt: message.createdAt,
    body: message.body,
    replyToMsgId: message.replyToMsgId,
  });
  return verifyEd25519(
    message.authorCert.payload.peerSignPubKey,
    signBytes,
    message.authorSig,
  );
}

export function computeHashPageDigest(
  fileId: string,
  pageIndex: number,
  pageChunkHashes: readonly string[],
): string {
  return sha256Hex(buildHashPageSignInput(fileId, pageIndex, pageChunkHashes));
}

export function verifyHashPage(
  fileId: string,
  pageIndex: number,
  pageChunkHashes: readonly string[],
  expectedPageDigestHex: string,
): boolean {
  const actual = computeHashPageDigest(fileId, pageIndex, pageChunkHashes);
  return constantTimeEqual(
    utf8ToBytes(actual),
    utf8ToBytes(expectedPageDigestHex.toLowerCase()),
  );
}

export async function createSignedFileManifestWithPages(params: {
  roomId: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  readChunk: (chunkIndex: number, offset: number, length: number) => Promise<Uint8Array>;
  senderCert: PeerIdentityCert;
  peerSignPrivKey: Uint8Array | string;
  fileId?: string;
}): Promise<{ manifest: FileManifest; chunkHashPages: string[][] }> {
  const safeName = sanitizeFileName(params.fileName);
  const totalChunks =
    params.fileSize === 0 ? 0 : Math.ceil(params.fileSize / SWARM_CHUNK_SIZE);
  if (totalChunks > MAX_SWARM_FILE_CHUNKS) {
    throw new Error(
      `File exceeds maximum Swarm limit (${MAX_SWARM_FILE_CHUNKS} chunks / 2 GiB)`,
    );
  }
  const allChunkHashes: string[] = [];
  const wholeHasher = sha256.create();

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * SWARM_CHUNK_SIZE;
    const len = Math.min(SWARM_CHUNK_SIZE, params.fileSize - offset);
    const bytes = await params.readChunk(i, offset, len);
    if (bytes.byteLength !== len) {
      throw new Error(`Chunk ${i} length mismatch: expected ${len}, got ${bytes.byteLength}`);
    }
    allChunkHashes.push(sha256Hex(bytes));
    wholeHasher.update(bytes);
  }

  const finalFileSha256 =
    params.fileSize === 0
      ? sha256Hex(new Uint8Array(0))
      : Array.from(wholeHasher.digest())
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

  const fileId = params.fileId ?? generateUuidV7();
  const mimeType = params.mimeType || "application/octet-stream";

  const chunkHashPages: string[][] = [];
  for (let i = 0; i < allChunkHashes.length; i += SWARM_HASH_PAGE_CHUNKS) {
    chunkHashPages.push(allChunkHashes.slice(i, i + SWARM_HASH_PAGE_CHUNKS));
  }

  const isPaged = totalChunks > SWARM_HASH_PAGE_CHUNKS;
  const inlineChunkHashes = isPaged ? [] : allChunkHashes;
  const hashPageHashes = isPaged
    ? chunkHashPages.map((pageHashes, pageIndex) =>
        computeHashPageDigest(fileId, pageIndex, pageHashes),
      )
    : undefined;

  const signBytes = canonicalizeFileManifestSignInput({
    fileId,
    roomId: params.roomId,
    fileName: safeName,
    fileSize: params.fileSize,
    mimeType,
    chunkSize: SWARM_CHUNK_SIZE,
    totalChunks,
    fileSha256: finalFileSha256,
    chunkHashes: inlineChunkHashes,
    ...(hashPageHashes !== undefined ? { hashPageHashes } : {}),
  });
  const senderSig = signEd25519(params.peerSignPrivKey, signBytes);

  const manifest: FileManifest = {
    fileId,
    roomId: params.roomId,
    fileName: safeName,
    fileSize: params.fileSize,
    mimeType,
    chunkSize: SWARM_CHUNK_SIZE,
    totalChunks,
    fileSha256: finalFileSha256,
    chunkHashes: inlineChunkHashes,
    ...(hashPageHashes !== undefined ? { hashPageHashes } : {}),
    senderCert: params.senderCert,
    senderSig,
  };

  return { manifest, chunkHashPages };
}

export async function createSignedFileManifestFromChunks(params: {
  roomId: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  readChunk: (chunkIndex: number, offset: number, length: number) => Promise<Uint8Array>;
  senderCert: PeerIdentityCert;
  peerSignPrivKey: Uint8Array | string;
  fileId?: string;
}): Promise<FileManifest> {
  const { manifest } = await createSignedFileManifestWithPages(params);
  return manifest;
}

export function verifyFileManifest(
  manifest: FileManifest,
  serverSignPubKey: Uint8Array | string,
  expectedRoomId: string,
): boolean {
  if (!isValidFileManifest(manifest) || manifest.roomId !== expectedRoomId) {
    return false;
  }
  const certValid = verifyPeerIdentityCert(manifest.senderCert, serverSignPubKey, {
    checkExpiry: false,
  });
  if (!certValid.ok) {
    return false;
  }
  const signBytes = canonicalizeFileManifestSignInput({
    fileId: manifest.fileId,
    roomId: manifest.roomId,
    fileName: manifest.fileName,
    fileSize: manifest.fileSize,
    mimeType: manifest.mimeType,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    fileSha256: manifest.fileSha256,
    chunkHashes: manifest.chunkHashes,
    ...(manifest.hashPageHashes !== undefined
      ? { hashPageHashes: manifest.hashPageHashes }
      : {}),
  });
  return verifyEd25519(
    manifest.senderCert.payload.peerSignPubKey,
    signBytes,
    manifest.senderSig,
  );
}

export function verifyChunkSha256(
  chunkBytes: Uint8Array,
  expectedSha256Hex: string,
): boolean {
  return constantTimeEqual(
    utf8ToBytes(sha256Hex(chunkBytes)),
    utf8ToBytes(expectedSha256Hex.toLowerCase()),
  );
}
