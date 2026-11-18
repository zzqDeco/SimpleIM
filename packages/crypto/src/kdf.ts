import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ContractValidationError } from "@simpleim/contracts";
import { bytesToHex, sha256Bytes, utf8ToBytes } from "./encoding.ts";

export const ARGON2_ROOM_DEFAULTS = {
  memoryKiB: 65_536, // 64 MiB
  iterations: 3,
  parallelism: 1,
} as const;

const MASTER_SALT = sha256Bytes("simpleim/v1/room-master-salt");
const EMPTY_HKDF_SALT = new Uint8Array(0);

const INFO_ROOM_ID = utf8ToBytes("simpleim/v1/room-id");
const INFO_SIGNALING_AEAD = utf8ToBytes("simpleim/v1/signaling-aead");
const INFO_ROOM_AUTH_HMAC = utf8ToBytes("simpleim/v1/room-auth-hmac");
const INFO_ROOM_APP_AEAD = utf8ToBytes("simpleim/v1/room-app-aead");
const INFO_RELAY_BOX_ID = utf8ToBytes("simpleim/v1/relay-box-id");
const INFO_RELAY_BLOB_AEAD = utf8ToBytes("simpleim/v1/relay-blob-aead");
const INFO_RELAY_ITEM_HMAC = utf8ToBytes("simpleim/v1/relay-item-hmac");

export interface DerivedRoomKeys {
  roomId: string;
  roomIdPrefix: string;
  signalingKey: Uint8Array;
  roomAuthKey: Uint8Array;
  roomAppKey: Uint8Array;
}

export interface DerivedRelayKeys {
  relayBoxId: string;
  relayBoxIdPrefix: string;
  relayKey: Uint8Array;
  relayIdKey: Uint8Array;
}

export interface DeriveRoomKeyOptions {
  memoryKiB?: number;
  iterations?: number;
}

export function normalizePassphrase(passphrase: string): Uint8Array {
  if (typeof passphrase !== "string") {
    throw new ContractValidationError("Passphrase must be a string");
  }
  const normalized = passphrase.normalize("NFC");
  if (normalized.includes("\x00")) {
    throw new ContractValidationError("Passphrase must not contain NUL bytes");
  }
  const bytes = utf8ToBytes(normalized);
  if (bytes.byteLength < 1 || bytes.byteLength > 256) {
    throw new ContractValidationError("Passphrase must be 1..256 UTF-8 bytes");
  }
  return bytes;
}

export function deriveRoomKeys(
  passphrase: string,
  options?: DeriveRoomKeyOptions,
): DerivedRoomKeys {
  const passBytes = normalizePassphrase(passphrase);
  const m = options?.memoryKiB ?? ARGON2_ROOM_DEFAULTS.memoryKiB;
  const t = options?.iterations ?? ARGON2_ROOM_DEFAULTS.iterations;

  const masterSeed = argon2id(passBytes, MASTER_SALT, {
    m,
    t,
    p: ARGON2_ROOM_DEFAULTS.parallelism,
    dkLen: 32,
  });

  try {
    const roomIdBytes = hkdf(sha256, masterSeed, EMPTY_HKDF_SALT, INFO_ROOM_ID, 32);
    const roomId = bytesToHex(roomIdBytes);
    const signalingKey = hkdf(
      sha256,
      masterSeed,
      EMPTY_HKDF_SALT,
      INFO_SIGNALING_AEAD,
      32,
    );
    const roomAuthKey = hkdf(
      sha256,
      masterSeed,
      EMPTY_HKDF_SALT,
      INFO_ROOM_AUTH_HMAC,
      32,
    );
    const roomAppKey = hkdf(
      sha256,
      masterSeed,
      EMPTY_HKDF_SALT,
      INFO_ROOM_APP_AEAD,
      32,
    );

    roomIdBytes.fill(0);
    return {
      roomId,
      roomIdPrefix: roomId.slice(0, 8),
      signalingKey,
      roomAuthKey,
      roomAppKey,
    };
  } finally {
    passBytes.fill(0);
    masterSeed.fill(0);
  }
}

export function wipeRoomKeys(keys: DerivedRoomKeys): void {
  keys.signalingKey.fill(0);
  keys.roomAuthKey.fill(0);
  keys.roomAppKey.fill(0);
}

export function deriveRelayKeys(roomAppKey: Uint8Array): DerivedRelayKeys {
  if (roomAppKey.byteLength !== 32) {
    throw new ContractValidationError("roomAppKey must be 32 bytes");
  }
  const boxBytes = hkdf(
    sha256,
    roomAppKey,
    EMPTY_HKDF_SALT,
    INFO_RELAY_BOX_ID,
    32,
  );
  const relayBoxId = bytesToHex(boxBytes);
  boxBytes.fill(0);

  const relayKey = hkdf(
    sha256,
    roomAppKey,
    EMPTY_HKDF_SALT,
    INFO_RELAY_BLOB_AEAD,
    32,
  );
  const relayIdKey = hkdf(
    sha256,
    roomAppKey,
    EMPTY_HKDF_SALT,
    INFO_RELAY_ITEM_HMAC,
    32,
  );
  return {
    relayBoxId,
    relayBoxIdPrefix: relayBoxId.slice(0, 8),
    relayKey,
    relayIdKey,
  };
}

export function wipeRelayKeys(keys: DerivedRelayKeys): void {
  keys.relayKey.fill(0);
  keys.relayIdKey.fill(0);
}
