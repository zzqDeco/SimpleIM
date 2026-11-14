import {
  isValidChatMessageEnvelope,
  isValidFileManifest,
  isValidRoomIdHex,
  type ChatMessageEnvelope,
  type FileManifest,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  randomBytes,
  utf8ToBytes,
  type DerivedRoomKeys,
} from "@simpleim/crypto";
import { mergeOrderedFiles, mergeOrderedMessages } from "../state/collections.ts";
import {
  MAX_ROOM_ALIAS_CHARS,
  sanitizeRoomAlias,
} from "../state/validation.ts";

export { MAX_ROOM_ALIAS_CHARS, sanitizeRoomAlias };

export const VAULT_DB_NAME = "simpleim_vault_v1";
const VAULT_DB_VERSION = 1;
const STORE_DEVICE_KEYS = "device_keys";
const STORE_ROOMS = "rooms";
const STORE_ROOM_MESSAGES = "room_messages";
const STORE_ROOM_FILES = "room_files";

export const MAX_VAULT_MESSAGES_PER_ROOM = 2_000;
export const MAX_VAULT_FILES_PER_ROOM = 200;

export interface EncryptedBlobRecord {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface VaultRoomMetadata {
  readonly roomId: string;
  readonly roomIdPrefix: string;
  readonly alias: string | null;
  readonly pinned: boolean;
  readonly joinedAt: number;
  readonly lastActiveAt: number;
  readonly lastReadAt: number;
}

export interface HydratedVaultRoom {
  readonly metadata: VaultRoomMetadata;
  readonly roomKeys: DerivedRoomKeys;
  readonly messages: ChatMessageEnvelope[];
  readonly files: FileManifest[];
}

interface SerializedVaultRoomPayload {
  v: 1;
  roomId: string;
  roomIdPrefix: string;
  signalingKeyB64: string;
  roomAuthKeyB64: string;
  roomAppKeyB64: string;
  alias: string | null;
  pinned: boolean;
  joinedAt: number;
  lastActiveAt: number;
  lastReadAt: number;
}

export interface VaultStorageBackend {
  getDeviceKey(userId: string): Promise<CryptoKey | null>;
  putDeviceKey(userId: string, key: CryptoKey): Promise<void>;
  listRoomEntries(
    userId: string,
  ): Promise<Array<{ roomId: string; record: EncryptedBlobRecord }>>;
  putRoomEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void>;
  getMessagesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null>;
  putMessagesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void>;
  getFilesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null>;
  putFilesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void>;
  deleteRoomAll(userId: string, roomId: string): Promise<void>;
  deleteUserAll(userId: string): Promise<void>;
}

function compositeKey(userId: string, roomId: string): string {
  return `${userId}:${roomId}`;
}

function parseRoomIdFromComposite(userId: string, key: string): string | null {
  const prefix = `${userId}:`;
  if (!key.startsWith(prefix)) return null;
  const roomId = key.slice(prefix.length);
  return isValidRoomIdHex(roomId) ? roomId : null;
}

export class InMemoryVaultBackend implements VaultStorageBackend {
  private readonly deviceKeys = new Map<string, CryptoKey>();
  private readonly rooms = new Map<string, EncryptedBlobRecord>();
  private readonly messages = new Map<string, EncryptedBlobRecord>();
  private readonly files = new Map<string, EncryptedBlobRecord>();

  async getDeviceKey(userId: string): Promise<CryptoKey | null> {
    return this.deviceKeys.get(userId) ?? null;
  }

  async putDeviceKey(userId: string, key: CryptoKey): Promise<void> {
    this.deviceKeys.set(userId, key);
  }

  async listRoomEntries(
    userId: string,
  ): Promise<Array<{ roomId: string; record: EncryptedBlobRecord }>> {
    const out: Array<{ roomId: string; record: EncryptedBlobRecord }> = [];
    for (const [k, v] of this.rooms.entries()) {
      const roomId = parseRoomIdFromComposite(userId, k);
      if (roomId) {
        out.push({
          roomId,
          record: {
            iv: v.iv.slice(),
            ciphertext: v.ciphertext.slice(),
          },
        });
      }
    }
    return out;
  }

  async putRoomEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    this.rooms.set(compositeKey(userId, roomId), {
      iv: record.iv.slice(),
      ciphertext: record.ciphertext.slice(),
    });
  }

  async getMessagesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    const rec = this.messages.get(compositeKey(userId, roomId));
    return rec
      ? { iv: rec.iv.slice(), ciphertext: rec.ciphertext.slice() }
      : null;
  }

  async putMessagesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    this.messages.set(compositeKey(userId, roomId), {
      iv: record.iv.slice(),
      ciphertext: record.ciphertext.slice(),
    });
  }

  async getFilesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    const rec = this.files.get(compositeKey(userId, roomId));
    return rec
      ? { iv: rec.iv.slice(), ciphertext: rec.ciphertext.slice() }
      : null;
  }

  async putFilesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    this.files.set(compositeKey(userId, roomId), {
      iv: record.iv.slice(),
      ciphertext: record.ciphertext.slice(),
    });
  }

  async deleteRoomAll(userId: string, roomId: string): Promise<void> {
    const k = compositeKey(userId, roomId);
    this.rooms.delete(k);
    this.messages.delete(k);
    this.files.delete(k);
  }

  async deleteUserAll(userId: string): Promise<void> {
    const prefix = `${userId}:`;
    this.deviceKeys.delete(userId);
    for (const store of [this.rooms, this.messages, this.files]) {
      for (const k of Array.from(store.keys())) {
        if (k.startsWith(prefix)) {
          store.delete(k);
        }
      }
    }
  }

  rawInspectRoomCiphertext(
    userId: string,
    roomId: string,
  ): EncryptedBlobRecord | undefined {
    return this.rooms.get(compositeKey(userId, roomId));
  }

  tamperMessagesCiphertext(userId: string, roomId: string): void {
    const k = compositeKey(userId, roomId);
    const existing = this.messages.get(k);
    if (!existing || existing.ciphertext.length === 0) return;
    const mutated = existing.ciphertext.slice();
    mutated[0] = ((mutated[0] ?? 0) ^ 0xff) & 0xff;
    this.messages.set(k, { iv: existing.iv, ciphertext: mutated });
  }
}

interface StoredIdbRecord {
  key: string;
  userId: string;
  roomId: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function idbRequestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTxComplete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function toUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export class IndexedDbVaultBackend implements VaultStorageBackend {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = VAULT_DB_NAME) {
    this.dbName = dbName;
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(this.dbName, VAULT_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_DEVICE_KEYS)) {
            db.createObjectStore(STORE_DEVICE_KEYS);
          }
          for (const storeName of [
            STORE_ROOMS,
            STORE_ROOM_MESSAGES,
            STORE_ROOM_FILES,
          ]) {
            if (!db.objectStoreNames.contains(storeName)) {
              const store = db.createObjectStore(storeName, { keyPath: "key" });
              store.createIndex("by_user", "userId", { unique: false });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () =>
          reject(req.error ?? new Error("Failed to open IndexedDB vault"));
      });
    }
    return this.dbPromise;
  }

  async getDeviceKey(userId: string): Promise<CryptoKey | null> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_DEVICE_KEYS, "readonly");
    const store = tx.objectStore(STORE_DEVICE_KEYS);
    const val = await idbRequestToPromise<unknown>(store.get(userId));
    return val && typeof val === "object" && "type" in val
      ? (val as CryptoKey)
      : null;
  }

  async putDeviceKey(userId: string, key: CryptoKey): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_DEVICE_KEYS, "readwrite");
    tx.objectStore(STORE_DEVICE_KEYS).put(key, userId);
    await idbTxComplete(tx);
  }

  async listRoomEntries(
    userId: string,
  ): Promise<Array<{ roomId: string; record: EncryptedBlobRecord }>> {
    const db = await this.openDb();
    const tx = db.transaction(STORE_ROOMS, "readonly");
    const idx = tx.objectStore(STORE_ROOMS).index("by_user");
    const rows = await idbRequestToPromise<StoredIdbRecord[]>(
      idx.getAll(IDBKeyRange.only(userId)),
    );
    const out: Array<{ roomId: string; record: EncryptedBlobRecord }> = [];
    for (const row of rows ?? []) {
      const iv = toUint8Array(row?.iv);
      const ciphertext = toUint8Array(row?.ciphertext);
      if (row && isValidRoomIdHex(row.roomId) && iv && ciphertext) {
        out.push({ roomId: row.roomId, record: { iv, ciphertext } });
      }
    }
    return out;
  }

  async putRoomEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    await this.putScopedEntry(STORE_ROOMS, userId, roomId, record);
  }

  async getMessagesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    return this.getScopedEntry(STORE_ROOM_MESSAGES, userId, roomId);
  }

  async putMessagesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    await this.putScopedEntry(STORE_ROOM_MESSAGES, userId, roomId, record);
  }

  async getFilesEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    return this.getScopedEntry(STORE_ROOM_FILES, userId, roomId);
  }

  async putFilesEntry(
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    await this.putScopedEntry(STORE_ROOM_FILES, userId, roomId, record);
  }

  async deleteRoomAll(userId: string, roomId: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(
      [STORE_ROOMS, STORE_ROOM_MESSAGES, STORE_ROOM_FILES],
      "readwrite",
    );
    const k = compositeKey(userId, roomId);
    tx.objectStore(STORE_ROOMS).delete(k);
    tx.objectStore(STORE_ROOM_MESSAGES).delete(k);
    tx.objectStore(STORE_ROOM_FILES).delete(k);
    await idbTxComplete(tx);
  }

  async deleteUserAll(userId: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(
      [STORE_DEVICE_KEYS, STORE_ROOMS, STORE_ROOM_MESSAGES, STORE_ROOM_FILES],
      "readwrite",
    );
    tx.objectStore(STORE_DEVICE_KEYS).delete(userId);
    for (const storeName of [
      STORE_ROOMS,
      STORE_ROOM_MESSAGES,
      STORE_ROOM_FILES,
    ]) {
      const store = tx.objectStore(storeName);
      const keysReq = store
        .index("by_user")
        .getAllKeys(IDBKeyRange.only(userId));
      keysReq.onsuccess = () => {
        for (const k of keysReq.result ?? []) {
          store.delete(k);
        }
      };
    }
    await idbTxComplete(tx);
  }

  private async getScopedEntry(
    storeName: string,
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    const db = await this.openDb();
    const tx = db.transaction(storeName, "readonly");
    const row = await idbRequestToPromise<StoredIdbRecord | undefined>(
      tx.objectStore(storeName).get(compositeKey(userId, roomId)),
    );
    if (!row) return null;
    const iv = toUint8Array(row.iv);
    const ciphertext = toUint8Array(row.ciphertext);
    return iv && ciphertext ? { iv, ciphertext } : null;
  }

  private async putScopedEntry(
    storeName: string,
    userId: string,
    roomId: string,
    record: EncryptedBlobRecord,
  ): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(storeName, "readwrite");
    const payload: StoredIdbRecord = {
      key: compositeKey(userId, roomId),
      userId,
      roomId,
      iv: record.iv,
      ciphertext: record.ciphertext,
    };
    tx.objectStore(storeName).put(payload);
    await idbTxComplete(tx);
  }
}

function buildVaultAad(
  recordKind: "room" | "messages" | "files",
  userId: string,
  roomId: string,
): ArrayBuffer {
  const bytes = utf8ToBytes(`simpleim/v1/vault:${recordKind}:${userId}:${roomId}`);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function toArrayBufferSlice(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class RoomVault {
  private readonly backend: VaultStorageBackend;
  private readonly keyCache = new Map<string, Promise<CryptoKey>>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(backend?: VaultStorageBackend) {
    if (backend) {
      this.backend = backend;
    } else if (typeof indexedDB !== "undefined") {
      this.backend = new IndexedDbVaultBackend();
    } else {
      this.backend = new InMemoryVaultBackend();
    }
  }

  private getOrCreateDeviceKey(userId: string): Promise<CryptoKey> {
    let pending = this.keyCache.get(userId);
    if (!pending) {
      pending = (async () => {
        const existing = await this.backend.getDeviceKey(userId);
        if (existing) return existing;
        const created = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        await this.backend.putDeviceKey(userId, created);
        return created;
      })();
      this.keyCache.set(userId, pending);
    }
    return pending;
  }

  private async encryptJson(
    userId: string,
    roomId: string,
    recordKind: "room" | "messages" | "files",
    value: unknown,
  ): Promise<EncryptedBlobRecord> {
    const key = await this.getOrCreateDeviceKey(userId);
    const iv = randomBytes(12);
    const plaintext = utf8ToBytes(JSON.stringify(value));
    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBufferSlice(iv),
        additionalData: buildVaultAad(recordKind, userId, roomId),
      },
      key,
      toArrayBufferSlice(plaintext),
    );
    return {
      iv,
      ciphertext: new Uint8Array(cipherBuf),
    };
  }

  private async decryptJson(
    userId: string,
    roomId: string,
    recordKind: "room" | "messages" | "files",
    record: EncryptedBlobRecord,
  ): Promise<unknown> {
    const key = await this.getOrCreateDeviceKey(userId);
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBufferSlice(record.iv),
        additionalData: buildVaultAad(recordKind, userId, roomId),
      },
      key,
      toArrayBufferSlice(record.ciphertext),
    );
    return JSON.parse(bytesToUtf8(new Uint8Array(plainBuf)));
  }

  private enqueueWrite(op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async loadWorkspace(userId: string): Promise<HydratedVaultRoom[]> {
    await this.flush();
    const existingKey = await this.backend.getDeviceKey(userId);
    if (!existingKey) {
      return [];
    }
    this.keyCache.set(userId, Promise.resolve(existingKey));

    const roomEntries = await this.backend.listRoomEntries(userId);
    const hydrated: HydratedVaultRoom[] = [];

    for (const { roomId, record } of roomEntries) {
      try {
        const rawRoom = (await this.decryptJson(
          userId,
          roomId,
          "room",
          record,
        )) as Partial<SerializedVaultRoomPayload>;
        if (
          rawRoom?.v !== 1 ||
          rawRoom.roomId !== roomId ||
          typeof rawRoom.roomIdPrefix !== "string" ||
          typeof rawRoom.signalingKeyB64 !== "string" ||
          typeof rawRoom.roomAuthKeyB64 !== "string" ||
          typeof rawRoom.roomAppKeyB64 !== "string"
        ) {
          continue;
        }

        const signalingKey = base64UrlToBytes(rawRoom.signalingKeyB64);
        const roomAuthKey = base64UrlToBytes(rawRoom.roomAuthKeyB64);
        const roomAppKey = base64UrlToBytes(rawRoom.roomAppKeyB64);
        if (
          signalingKey.byteLength !== 32 ||
          roomAuthKey.byteLength !== 32 ||
          roomAppKey.byteLength !== 32
        ) {
          continue;
        }

        const roomKeys: DerivedRoomKeys = {
          roomId,
          roomIdPrefix: rawRoom.roomIdPrefix.slice(0, 8),
          signalingKey,
          roomAuthKey,
          roomAppKey,
        };

        const metadata: VaultRoomMetadata = {
          roomId,
          roomIdPrefix: roomKeys.roomIdPrefix,
          alias: sanitizeRoomAlias(rawRoom.alias),
          pinned: Boolean(rawRoom.pinned),
          joinedAt:
            typeof rawRoom.joinedAt === "number" &&
            Number.isFinite(rawRoom.joinedAt)
              ? rawRoom.joinedAt
              : Date.now(),
          lastActiveAt:
            typeof rawRoom.lastActiveAt === "number" &&
            Number.isFinite(rawRoom.lastActiveAt)
              ? rawRoom.lastActiveAt
              : Date.now(),
          lastReadAt:
            typeof rawRoom.lastReadAt === "number" &&
            Number.isFinite(rawRoom.lastReadAt)
              ? rawRoom.lastReadAt
              : 0,
        };

        let messages: ChatMessageEnvelope[] = [];
        const msgEntry = await this.backend.getMessagesEntry(userId, roomId);
        if (msgEntry) {
          try {
            const rawMsgs = await this.decryptJson(
              userId,
              roomId,
              "messages",
              msgEntry,
            );
            if (Array.isArray(rawMsgs)) {
              const validMsgs = rawMsgs.filter(
                (m): m is ChatMessageEnvelope =>
                  isValidChatMessageEnvelope(m) && m.roomId === roomId,
              );
              messages = mergeOrderedMessages([], validMsgs).slice(
                -MAX_VAULT_MESSAGES_PER_ROOM,
              );
            }
          } catch {
            // Tampered or unreadable message blob is rejected cleanly without breaking room load
            messages = [];
          }
        }

        let files: FileManifest[] = [];
        const filesEntry = await this.backend.getFilesEntry(userId, roomId);
        if (filesEntry) {
          try {
            const rawFiles = await this.decryptJson(
              userId,
              roomId,
              "files",
              filesEntry,
            );
            if (Array.isArray(rawFiles)) {
              const validFiles = rawFiles.filter(
                (f): f is FileManifest =>
                  isValidFileManifest(f) && f.roomId === roomId,
              );
              files = mergeOrderedFiles([], validFiles).slice(
                -MAX_VAULT_FILES_PER_ROOM,
              );
            }
          } catch {
            files = [];
          }
        }

        hydrated.push({ metadata, roomKeys, messages, files });
      } catch {
        // Reject tampered room ciphertext
      }
    }

    return hydrated;
  }

  saveRoom(
    userId: string,
    metadata: VaultRoomMetadata,
    roomKeys: DerivedRoomKeys,
  ): Promise<void> {
    const payload: SerializedVaultRoomPayload = {
      v: 1,
      roomId: metadata.roomId,
      roomIdPrefix: metadata.roomIdPrefix,
      signalingKeyB64: bytesToBase64Url(roomKeys.signalingKey),
      roomAuthKeyB64: bytesToBase64Url(roomKeys.roomAuthKey),
      roomAppKeyB64: bytesToBase64Url(roomKeys.roomAppKey),
      alias: sanitizeRoomAlias(metadata.alias),
      pinned: metadata.pinned,
      joinedAt: metadata.joinedAt,
      lastActiveAt: metadata.lastActiveAt,
      lastReadAt: metadata.lastReadAt,
    };
    return this.enqueueWrite(async () => {
      const encrypted = await this.encryptJson(
        userId,
        metadata.roomId,
        "room",
        payload,
      );
      await this.backend.putRoomEntry(userId, metadata.roomId, encrypted);
    });
  }

  saveRoomMessages(
    userId: string,
    roomId: string,
    messages: readonly ChatMessageEnvelope[],
  ): Promise<void> {
    const bounded = messages.slice(-MAX_VAULT_MESSAGES_PER_ROOM);
    return this.enqueueWrite(async () => {
      const encrypted = await this.encryptJson(
        userId,
        roomId,
        "messages",
        bounded,
      );
      await this.backend.putMessagesEntry(userId, roomId, encrypted);
    });
  }

  saveRoomFiles(
    userId: string,
    roomId: string,
    files: readonly FileManifest[],
  ): Promise<void> {
    const bounded = files.slice(-MAX_VAULT_FILES_PER_ROOM);
    return this.enqueueWrite(async () => {
      const encrypted = await this.encryptJson(userId, roomId, "files", bounded);
      await this.backend.putFilesEntry(userId, roomId, encrypted);
    });
  }

  destroyRoom(userId: string, roomId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.backend.deleteRoomAll(userId, roomId);
    });
  }

  wipeUserVault(userId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.keyCache.delete(userId);
      await this.backend.deleteUserAll(userId);
    });
  }
}
