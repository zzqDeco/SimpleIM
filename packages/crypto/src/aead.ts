import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildSignalingAad,
  ContractValidationError,
  MAX_RELAY_CHUNK_CIPHERTEXT_BYTES,
  MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES,
  parsePostAuthControlFrame,
  parseRelayEnvelopeInnerPayload,
  parseSignalingInnerPayload,
  RELAY_AEAD_OVERHEAD_BYTES,
  RELAY_NONCE_BYTES,
  SWARM_CHUNK_SIZE,
  type EncryptedEnvelope,
  type PostAuthControlFrame,
  type RelayEnvelopeInnerPayload,
  type SealedControlEnvelope,
  type SignalingInnerPayload,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  randomBytes,
  utf8ToBytes,
} from "./encoding.ts";

export function sealXChaCha(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): EncryptedEnvelope {
  if (key.byteLength !== 32) {
    throw new Error("XChaCha20-Poly1305 key must be 32 bytes");
  }
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export function openXChaCha(
  key: Uint8Array,
  envelope: EncryptedEnvelope,
  aad?: Uint8Array,
): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("XChaCha20-Poly1305 key must be 32 bytes");
  }
  const nonce = base64UrlToBytes(envelope.nonce);
  if (nonce.byteLength !== 24) {
    throw new Error("XChaCha20-Poly1305 nonce must be 24 bytes");
  }
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}

export function sealSignalingPayload(
  signalingKey: Uint8Array,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
  payload: SignalingInnerPayload,
): EncryptedEnvelope {
  const aad = buildSignalingAad(roomId, fromPeerId, toPeerId);
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  return sealXChaCha(signalingKey, plaintext, aad);
}

export function openSignalingPayload(
  signalingKey: Uint8Array,
  roomId: string,
  fromPeerId: string,
  toPeerId: string,
  envelope: EncryptedEnvelope,
  options?: { maxFrameBytes?: number },
): SignalingInnerPayload {
  const aad = buildSignalingAad(roomId, fromPeerId, toPeerId);
  const plaintext = openXChaCha(signalingKey, envelope, aad);
  return parseSignalingInnerPayload(bytesToUtf8(plaintext), options);
}

function buildControlAad(roomId: string): Uint8Array {
  return utf8ToBytes(`simpleim/v1/control:${roomId}`);
}

export function sealPostAuthControlFrame(
  roomAppKey: Uint8Array,
  roomId: string,
  frame: PostAuthControlFrame,
): SealedControlEnvelope {
  const plaintext = utf8ToBytes(JSON.stringify(frame));
  return {
    type: "control.sealed",
    envelope: sealXChaCha(roomAppKey, plaintext, buildControlAad(roomId)),
  };
}

export function openPostAuthControlFrame(
  roomAppKey: Uint8Array,
  roomId: string,
  sealed: SealedControlEnvelope,
): PostAuthControlFrame {
  const plaintext = openXChaCha(
    roomAppKey,
    sealed.envelope,
    buildControlAad(roomId),
  );
  return parsePostAuthControlFrame(bytesToUtf8(plaintext));
}

export type RelayEnvelopeIdKind = "chat" | "manifest" | "hash_page";

function hmacHex16(key: Uint8Array, message: string): string {
  if (key.byteLength !== 32) {
    throw new Error("Relay HMAC key must be 32 bytes");
  }
  const digest = hmac(sha256, key, utf8ToBytes(message));
  return bytesToHex(digest.subarray(0, 16));
}

export function deriveRelayEnvelopeBlobId(
  relayIdKey: Uint8Array,
  kind: RelayEnvelopeIdKind,
  logicalId: string,
): string {
  return hmacHex16(relayIdKey, `simpleim/v1/relay-id:${kind}:${logicalId}`);
}

export function deriveRelayFileTag(
  relayIdKey: Uint8Array,
  fileId: string,
): string {
  return hmacHex16(relayIdKey, `simpleim/v1/relay-file:${fileId}`);
}

export function deriveRelayChunkBlobId(
  relayIdKey: Uint8Array,
  fileId: string,
  chunkIndex: number,
): string {
  return hmacHex16(
    relayIdKey,
    `simpleim/v1/relay-chunk:${fileId}:${chunkIndex}`,
  );
}

export function sealBinaryXChaCha(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("XChaCha20-Poly1305 key must be 32 bytes");
  }
  const nonce = randomBytes(RELAY_NONCE_BYTES);
  const cipher = xchacha20poly1305(key, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);
  const out = new Uint8Array(RELAY_NONCE_BYTES + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, RELAY_NONCE_BYTES);
  return out;
}

export function openBinaryXChaCha(
  key: Uint8Array,
  wireBytes: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("XChaCha20-Poly1305 key must be 32 bytes");
  }
  if (wireBytes.byteLength < RELAY_AEAD_OVERHEAD_BYTES) {
    throw new ContractValidationError(
      "Relay AEAD payload is shorter than overhead",
      "invalid_frame",
    );
  }
  const nonce = wireBytes.subarray(0, RELAY_NONCE_BYTES);
  const ciphertext = wireBytes.subarray(RELAY_NONCE_BYTES);
  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}

function buildRelayEnvelopeAad(relayBoxId: string, blobId: string): Uint8Array {
  return utf8ToBytes(`simpleim/v1/relay-env:${relayBoxId}:${blobId}`);
}

function buildRelayChunkAad(
  relayBoxId: string,
  fileTag: string,
  chunkBlobId: string,
): Uint8Array {
  return utf8ToBytes(
    `simpleim/v1/relay-chk:${relayBoxId}:${fileTag}:${chunkBlobId}`,
  );
}

export function sealRelayEnvelopeBinary(
  relayKey: Uint8Array,
  relayBoxId: string,
  blobId: string,
  payload: RelayEnvelopeInnerPayload,
): Uint8Array {
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const wire = sealBinaryXChaCha(
    relayKey,
    plaintext,
    buildRelayEnvelopeAad(relayBoxId, blobId),
  );
  if (wire.byteLength > MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES) {
    throw new ContractValidationError(
      "Sealed relay envelope exceeds maximum size",
      "payload_too_large",
    );
  }
  return wire;
}

export function openRelayEnvelopeBinary(
  relayKey: Uint8Array,
  relayBoxId: string,
  blobId: string,
  wireBytes: Uint8Array,
): RelayEnvelopeInnerPayload {
  if (wireBytes.byteLength > MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES) {
    throw new ContractValidationError(
      "Relay envelope exceeds maximum size",
      "payload_too_large",
    );
  }
  const plaintext = openBinaryXChaCha(
    relayKey,
    wireBytes,
    buildRelayEnvelopeAad(relayBoxId, blobId),
  );
  return parseRelayEnvelopeInnerPayload(bytesToUtf8(plaintext));
}

export function sealRelayChunkBinary(
  relayKey: Uint8Array,
  relayBoxId: string,
  fileTag: string,
  chunkBlobId: string,
  chunkPlaintext: Uint8Array,
): Uint8Array {
  if (chunkPlaintext.byteLength > SWARM_CHUNK_SIZE) {
    throw new ContractValidationError(
      "Relay chunk plaintext exceeds 64 KiB",
      "payload_too_large",
    );
  }
  return sealBinaryXChaCha(
    relayKey,
    chunkPlaintext,
    buildRelayChunkAad(relayBoxId, fileTag, chunkBlobId),
  );
}

export function openRelayChunkBinary(
  relayKey: Uint8Array,
  relayBoxId: string,
  fileTag: string,
  chunkBlobId: string,
  wireBytes: Uint8Array,
): Uint8Array {
  if (wireBytes.byteLength > MAX_RELAY_CHUNK_CIPHERTEXT_BYTES) {
    throw new ContractValidationError(
      "Relay chunk ciphertext exceeds maximum size",
      "payload_too_large",
    );
  }
  return openBinaryXChaCha(
    relayKey,
    wireBytes,
    buildRelayChunkAad(relayBoxId, fileTag, chunkBlobId),
  );
}
