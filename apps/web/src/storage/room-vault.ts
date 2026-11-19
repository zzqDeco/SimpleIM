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

export interface VaultWebLocksLike {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared" },
    callback: (lock: object | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface RoomVaultOptions {
  readonly locksProvider?: () => VaultWebLocksLike | undefined;
}

export interface HydratedVaultRoom {
  readonly metadata: VaultRoomMetadata;
  readonly roomKeys: DerivedRoomKeys;
  readonly messages: ChatMessageEnvelope[];
  readonly files: FileManifest[];
  readonly pendingRelayMsgIds: string[];
  readonly relayCursor: number;
}

export interface CommitRoomStateParams {
  readonly userId: string;
  readonly metadata: VaultRoomMetadata;
  readonly roomKeys: DerivedRoomKeys;
  readonly messages?: readonly ChatMessageEnvelope[];
  readonly files?: readonly FileManifest[];
  readonly addPendingRelayMsgIds?: readonly string[];
  readonly removePendingRelayMsgIds?: readonly string[];
  readonly replacePendingRelayMsgIds?: readonly string[];
  readonly relayCursor?: number;
  readonly cursorReset?: boolean;
  readonly mergeWithExisting?: boolean;
}

export interface CommittedRoomStateResult {
  readonly metadata: VaultRoomMetadata;
  readonly messages?: ChatMessageEnvelope[];
  readonly files?: FileManifest[];
  readonly pendingRelayMsgIds: string[];
  readonly relayCursor: number;
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
  pendingRelayMsgIds?: string[];
  relayCursor?: number;
}

export interface RoomBundleRecords {
  readonly room?: EncryptedBlobRecord;
  readonly messages?: EncryptedBlobRecord;
  readonly files?: EncryptedBlobRecord;
}

export interface VaultStorageBackend {
  getDeviceKey(userId: string): Promise<CryptoKey | null>;
  putDeviceKey(userId: string, key: CryptoKey): Promise<void>;
  listRoomEntries(
    userId: string,
  ): Promise<Array<{ roomId: string; record: EncryptedBlobRecord }>>;
  getRoomEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null>;
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
  commitRoomBundle(
    userId: string,
    roomId: string,
    records: RoomBundleRecords,
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
  public bundleCommitCount = 0;
  public onBeforeCommitBundle?: (
    userId: string,
    roomId: string,
    records: RoomBundleRecords,
  ) => Promise<void> | void;

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

  async getRoomEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    const rec = this.rooms.get(compositeKey(userId, roomId));
    return rec
      ? { iv: rec.iv.slice(), ciphertext: rec.ciphertext.slice() }
      : null;
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

  async commitRoomBundle(
    userId: string,
    roomId: string,
    records: RoomBundleRecords,
  ): Promise<void> {
    if (this.onBeforeCommitBundle) {
      await this.onBeforeCommitBundle(userId, roomId, records);
    }
    const k = compositeKey(userId, roomId);
    if (records.room) {
      this.rooms.set(k, {
        iv: records.room.iv.slice(),
        ciphertext: records.room.ciphertext.slice(),
      });
    }
    if (records.messages) {
      this.messages.set(k, {
        iv: records.messages.iv.slice(),
        ciphertext: records.messages.ciphertext.slice(),
      });
    }
    if (records.files) {
      this.files.set(k, {
        iv: records.files.iv.slice(),
        ciphertext: records.files.ciphertext.slice(),
      });
    }
    this.bundleCommitCount += 1;
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
      }).catch((err) => {
        this.dbPromise = null;
        throw err;
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

  async getRoomEntry(
    userId: string,
    roomId: string,
  ): Promise<EncryptedBlobRecord | null> {
    return this.getScopedEntry(STORE_ROOMS, userId, roomId);
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

  async commitRoomBundle(
    userId: string,
    roomId: string,
    records: RoomBundleRecords,
  ): Promise<void> {
    const stores: string[] = [];
    if (records.room) stores.push(STORE_ROOMS);
    if (records.messages) stores.push(STORE_ROOM_MESSAGES);
    if (records.files) stores.push(STORE_ROOM_FILES);
    if (stores.length === 0) {
      return;
    }

    const db = await this.openDb();
    const tx = db.transaction(stores, "readwrite");
    const key = compositeKey(userId, roomId);
    if (records.room) {
      tx.objectStore(STORE_ROOMS).put({
        key,
        userId,
        roomId,
        iv: records.room.iv,
        ciphertext: records.room.ciphertext,
      } satisfies StoredIdbRecord);
    }
    if (records.messages) {
      tx.objectStore(STORE_ROOM_MESSAGES).put({
        key,
        userId,
        roomId,
        iv: records.messages.iv,
        ciphertext: records.messages.ciphertext,
      } satisfies StoredIdbRecord);
    }
    if (records.files) {
      tx.objectStore(STORE_ROOM_FILES).put({
        key,
        userId,
        roomId,
        iv: records.files.iv,
        ciphertext: records.files.ciphertext,
      } satisfies StoredIdbRecord);
    }
    await idbTxComplete(tx);
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

function isNonZero32ByteKey(bytes: Uint8Array): boolean {
  return bytes.byteLength === 32 && bytes.some((b) => b !== 0);
}

function hasValidNonZeroRoomKeys(roomKeys: DerivedRoomKeys): boolean {
  return (
    isValidRoomIdHex(roomKeys.roomId) &&
    isNonZero32ByteKey(roomKeys.signalingKey) &&
    isNonZero32ByteKey(roomKeys.roomAuthKey) &&
    isNonZero32ByteKey(roomKeys.roomAppKey)
  );
}

function sanitizePendingRelayMsgIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
      seen.add(item);
      out.push(item);
      if (out.length >= MAX_VAULT_MESSAGES_PER_ROOM) {
        break;
      }
    }
  }
  return out;
}

function sanitizeRelayCursor(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : 0;
}

export class RoomVault {
  private readonly backend: VaultStorageBackend;
  private readonly locksProvider: () => VaultWebLocksLike | undefined;
  private readonly keyCache = new Map<string, Promise<CryptoKey>>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(backend?: VaultStorageBackend, options?: RoomVaultOptions) {
    if (backend) {
      this.backend = backend;
    } else if (typeof indexedDB !== "undefined") {
      this.backend = new IndexedDbVaultBackend();
    } else {
      this.backend = new InMemoryVaultBackend();
    }
    this.locksProvider =
      options?.locksProvider ??
      (() =>
        typeof navigator !== "undefined" &&
        "locks" in navigator &&
        navigator.locks &&
        typeof navigator.locks.request === "function"
          ? (navigator.locks as unknown as VaultWebLocksLike)
          : undefined);
  }

  private async withVaultLock<T>(
    lockName: string,
    op: () => Promise<T>,
  ): Promise<T> {
    const locks = this.locksProvider();
    if (!locks) {
      return op();
    }
    return locks.request(lockName, { mode: "exclusive" }, () => op());
  }

  private withRoomLock<T>(
    userId: string,
    roomId: string,
    op: () => Promise<T>,
  ): Promise<T> {
    return this.withVaultLock(`simpleim-vault:room:${userId}:${roomId}`, op);
  }

  private withUserLock<T>(userId: string, op: () => Promise<T>): Promise<T> {
    return this.withVaultLock(`simpleim-vault:user:${userId}`, op);
  }

  private getOrCreateDeviceKey(userId: string): Promise<CryptoKey> {
    let pending = this.keyCache.get(userId);
    if (!pending) {
      const createdPromise = (async () => {
        const existing = await this.backend.getDeviceKey(userId);
        if (existing) return existing;
        const created = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        await this.backend.putDeviceKey(userId, created);
        return created;
      })().catch((err) => {
        if (this.keyCache.get(userId) === createdPromise) {
          this.keyCache.delete(userId);
        }
        throw err;
      });
      pending = createdPromise;
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

  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async readExistingRoomPayload(
    userId: string,
    roomId: string,
  ): Promise<Partial<SerializedVaultRoomPayload> | null> {
    const existingRecord = await this.backend.getRoomEntry(userId, roomId);
    if (!existingRecord) return null;
    try {
      const raw = (await this.decryptJson(
        userId,
        roomId,
        "room",
        existingRecord,
      )) as Partial<SerializedVaultRoomPayload>;
      return raw && raw.v === 1 && raw.roomId === roomId ? raw : null;
    } catch {
      return null;
    }
  }

  private async readExistingMessages(
    userId: string,
    roomId: string,
  ): Promise<ChatMessageEnvelope[]> {
    const existingRecord = await this.backend.getMessagesEntry(userId, roomId);
    if (!existingRecord) return [];
    try {
      const rawMsgs = await this.decryptJson(
        userId,
        roomId,
        "messages",
        existingRecord,
      );
      if (!Array.isArray(rawMsgs)) return [];
      const valid = rawMsgs.filter(
        (m): m is ChatMessageEnvelope =>
          isValidChatMessageEnvelope(m) && m.roomId === roomId,
      );
      return mergeOrderedMessages([], valid).slice(-MAX_VAULT_MESSAGES_PER_ROOM);
    } catch {
      return [];
    }
  }

  private async readExistingFiles(
    userId: string,
    roomId: string,
  ): Promise<FileManifest[]> {
    const existingRecord = await this.backend.getFilesEntry(userId, roomId);
    if (!existingRecord) return [];
    try {
      const rawFiles = await this.decryptJson(
        userId,
        roomId,
        "files",
        existingRecord,
      );
      if (!Array.isArray(rawFiles)) return [];
      const valid = rawFiles.filter(
        (f): f is FileManifest =>
          isValidFileManifest(f) && f.roomId === roomId,
      );
      return mergeOrderedFiles([], valid).slice(-MAX_VAULT_FILES_PER_ROOM);
    } catch {
      return [];
    }
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
          !isNonZero32ByteKey(signalingKey) ||
          !isNonZero32ByteKey(roomAuthKey) ||
          !isNonZero32ByteKey(roomAppKey)
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

        const pendingRelayMsgIds = sanitizePendingRelayMsgIds(
          rawRoom.pendingRelayMsgIds,
        );
        const relayCursor = sanitizeRelayCursor(rawRoom.relayCursor);

        hydrated.push({
          metadata,
          roomKeys,
          messages,
          files,
          pendingRelayMsgIds,
          relayCursor,
        });
      } catch {
        // Reject tampered room ciphertext
      }
    }

    return hydrated;
  }

  commitRoomState(
    params: CommitRoomStateParams,
  ): Promise<CommittedRoomStateResult> {
    const { userId, metadata, roomKeys } = params;
    if (
      !hasValidNonZeroRoomKeys(roomKeys) ||
      roomKeys.roomId !== metadata.roomId
    ) {
      return Promise.reject(
        new Error("Refusing to persist wiped or invalid room keys"),
      );
    }

    const roomId = metadata.roomId;
    // Snapshot key bytes synchronously before entering the write queue so later
    // wipeRoomKeys() during teardown cannot corrupt an in-flight commit.
    const signalingKeyB64 = bytesToBase64Url(roomKeys.signalingKey);
    const roomAuthKeyB64 = bytesToBase64Url(roomKeys.roomAuthKey);
    const roomAppKeyB64 = bytesToBase64Url(roomKeys.roomAppKey);
    const incomingMessages =
      params.messages !== undefined ? [...params.messages] : undefined;
    const incomingFiles =
      params.files !== undefined ? [...params.files] : undefined;
    const addPending = params.addPendingRelayMsgIds
      ? [...params.addPendingRelayMsgIds]
      : undefined;
    const removePending = params.removePendingRelayMsgIds
      ? [...params.removePendingRelayMsgIds]
      : undefined;
    const replacePending = params.replacePendingRelayMsgIds
      ? [...params.replacePendingRelayMsgIds]
      : undefined;
    const mergeWithExisting = params.mergeWithExisting ?? true;

    return this.enqueueWrite(() =>
      this.withRoomLock(userId, roomId, async () => {
        const existingRoom = await this.readExistingRoomPayload(userId, roomId);

        const mergedMetadata: VaultRoomMetadata = {
          roomId,
          roomIdPrefix: metadata.roomIdPrefix,
          alias: sanitizeRoomAlias(metadata.alias),
          pinned: metadata.pinned,
          joinedAt:
            existingRoom && typeof existingRoom.joinedAt === "number"
              ? Math.min(existingRoom.joinedAt, metadata.joinedAt)
              : metadata.joinedAt,
          lastActiveAt:
            existingRoom && typeof existingRoom.lastActiveAt === "number"
              ? Math.max(existingRoom.lastActiveAt, metadata.lastActiveAt)
              : metadata.lastActiveAt,
          lastReadAt:
            existingRoom && typeof existingRoom.lastReadAt === "number"
              ? Math.max(existingRoom.lastReadAt, metadata.lastReadAt)
              : metadata.lastReadAt,
        };

        const pendingSet = new Set<string>(
          replacePending !== undefined
            ? sanitizePendingRelayMsgIds(replacePending)
            : sanitizePendingRelayMsgIds(existingRoom?.pendingRelayMsgIds),
        );
        if (addPending) {
          for (const id of addPending) {
            if (id.length > 0) pendingSet.add(id);
          }
        }
        if (removePending) {
          for (const id of removePending) {
            pendingSet.delete(id);
          }
        }
        const pendingRelayMsgIds = Array.from(pendingSet).slice(
          -MAX_VAULT_MESSAGES_PER_ROOM,
        );

        const existingCursor = sanitizeRelayCursor(existingRoom?.relayCursor);
        let relayCursor = existingCursor;
        if (params.relayCursor !== undefined) {
          const normalized = sanitizeRelayCursor(params.relayCursor);
          relayCursor = params.cursorReset
            ? normalized
            : Math.max(existingCursor, normalized);
        }

        let finalMessages: ChatMessageEnvelope[] | undefined;
        if (incomingMessages !== undefined) {
          const diskMessages = mergeWithExisting
            ? await this.readExistingMessages(userId, roomId)
            : [];
          finalMessages = mergeOrderedMessages(
            diskMessages,
            incomingMessages,
          ).slice(-MAX_VAULT_MESSAGES_PER_ROOM);
        }

        let finalFiles: FileManifest[] | undefined;
        if (incomingFiles !== undefined) {
          const diskFiles = mergeWithExisting
            ? await this.readExistingFiles(userId, roomId)
            : [];
          finalFiles = mergeOrderedFiles(diskFiles, incomingFiles).slice(
            -MAX_VAULT_FILES_PER_ROOM,
          );
        }

        const roomPayload: SerializedVaultRoomPayload = {
          v: 1,
          roomId,
          roomIdPrefix: mergedMetadata.roomIdPrefix,
          signalingKeyB64,
          roomAuthKeyB64,
          roomAppKeyB64,
          alias: mergedMetadata.alias,
          pinned: mergedMetadata.pinned,
          joinedAt: mergedMetadata.joinedAt,
          lastActiveAt: mergedMetadata.lastActiveAt,
          lastReadAt: mergedMetadata.lastReadAt,
          pendingRelayMsgIds,
          relayCursor,
        };

        const [roomEnc, messagesEnc, filesEnc] = await Promise.all([
          this.encryptJson(userId, roomId, "room", roomPayload),
          finalMessages !== undefined
            ? this.encryptJson(userId, roomId, "messages", finalMessages)
            : Promise.resolve(undefined),
          finalFiles !== undefined
            ? this.encryptJson(userId, roomId, "files", finalFiles)
            : Promise.resolve(undefined),
        ]);

        await this.backend.commitRoomBundle(userId, roomId, {
          room: roomEnc,
          ...(messagesEnc ? { messages: messagesEnc } : {}),
          ...(filesEnc ? { files: filesEnc } : {}),
        });

        return {
          metadata: mergedMetadata,
          ...(finalMessages !== undefined ? { messages: finalMessages } : {}),
          ...(finalFiles !== undefined ? { files: finalFiles } : {}),
          pendingRelayMsgIds,
          relayCursor,
        };
      }),
    );
  }

  saveRoom(
    userId: string,
    metadata: VaultRoomMetadata,
    roomKeys: DerivedRoomKeys,
  ): Promise<void> {
    return this.commitRoomState({
      userId,
      metadata,
      roomKeys,
    }).then(() => undefined);
  }

  saveRoomMessages(
    userId: string,
    roomId: string,
    messages: readonly ChatMessageEnvelope[],
  ): Promise<void> {
    const incoming = [...messages];
    return this.enqueueWrite(() =>
      this.withRoomLock(userId, roomId, async () => {
        const diskMessages = await this.readExistingMessages(userId, roomId);
        const merged = mergeOrderedMessages(diskMessages, incoming).slice(
          -MAX_VAULT_MESSAGES_PER_ROOM,
        );
        const encrypted = await this.encryptJson(
          userId,
          roomId,
          "messages",
          merged,
        );
        await this.backend.putMessagesEntry(userId, roomId, encrypted);
      }),
    );
  }

  saveRoomFiles(
    userId: string,
    roomId: string,
    files: readonly FileManifest[],
  ): Promise<void> {
    const incoming = [...files];
    return this.enqueueWrite(() =>
      this.withRoomLock(userId, roomId, async () => {
        const diskFiles = await this.readExistingFiles(userId, roomId);
        const merged = mergeOrderedFiles(diskFiles, incoming).slice(
          -MAX_VAULT_FILES_PER_ROOM,
        );
        const encrypted = await this.encryptJson(
          userId,
          roomId,
          "files",
          merged,
        );
        await this.backend.putFilesEntry(userId, roomId, encrypted);
      }),
    );
  }

  destroyRoom(userId: string, roomId: string): Promise<void> {
    return this.enqueueWrite(() =>
      this.withRoomLock(userId, roomId, async () => {
        await this.backend.deleteRoomAll(userId, roomId);
      }),
    );
  }

  wipeUserVault(userId: string): Promise<void> {
    return this.enqueueWrite(() =>
      this.withUserLock(userId, async () => {
        this.keyCache.delete(userId);
        await this.backend.deleteUserAll(userId);
      }),
    );
  }
}
