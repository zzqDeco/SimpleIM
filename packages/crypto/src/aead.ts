import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  buildSignalingAad,
  parsePostAuthControlFrame,
  parseSignalingInnerPayload,
  type EncryptedEnvelope,
  type PostAuthControlFrame,
  type SealedControlEnvelope,
  type SignalingInnerPayload,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  bytesToBase64Url,
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
): SignalingInnerPayload {
  const aad = buildSignalingAad(roomId, fromPeerId, toPeerId);
  const plaintext = openXChaCha(signalingKey, envelope, aad);
  return parseSignalingInnerPayload(bytesToUtf8(plaintext));
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
