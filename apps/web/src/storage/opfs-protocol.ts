import {
  createBitfield,
  setChunkInBitfield,
  SWARM_CHUNK_SIZE,
} from "@simpleim/contracts";

export const OPFS_SWARM_DIR_NAME = "simpleim-swarm";
export const OPFS_INSTANCE_LOCK_PREFIX = "simpleim-opfs-instance:";
export const MAX_FALLBACK_STORAGE_BYTES = 16 * 1024 * 1024; // 16 MiB cap when OPFS SyncAccessHandle is unavailable

export type OpfsBackendKind = "opfs" | "fallback";

export type OpfsWorkerRequest =
  | {
      id: number;
      type: "configure";
      instanceId: string;
      maxFallbackBytes?: number;
    }
  | {
      id: number;
      type: "initReceivingFile";
      fileId: string;
      fileSize: number;
      totalChunks: number;
    }
  | {
      id: number;
      type: "writeVerifiedChunk";
      fileId: string;
      chunkIndex: number;
      dataBuffer: ArrayBuffer;
    }
  | {
      id: number;
      type: "readChunk";
      fileId: string;
      chunkIndex: number;
      expectedLength: number;
    }
  | {
      id: number;
      type: "finalizeFile";
      fileId: string;
    }
  | {
      id: number;
      type: "prepareDownload";
      fileId: string;
    }
  | {
      id: number;
      type: "deleteFile";
      fileId: string;
    }
  | {
      id: number;
      type: "closeAll";
    };

export type OpfsWorkerResponse =
  | {
      id: number;
      ok: true;
      type: "initReceivingFile";
      bitfieldBuffer: ArrayBuffer;
      backend: OpfsBackendKind;
    }
  | {
      id: number;
      ok: true;
      type:
        | "configure"
        | "writeVerifiedChunk"
        | "finalizeFile"
        | "deleteFile"
        | "closeAll";
    }
  | {
      id: number;
      ok: true;
      type: "readChunk";
      chunkBuffer: ArrayBuffer;
    }
  | {
      id: number;
      ok: true;
      type: "prepareDownload";
      backend: OpfsBackendKind;
      fallbackChunks?: ArrayBuffer[];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

export interface OpfsSyncAccessHandleLike {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandleLike {
  getFile(): Promise<File>;
  createSyncAccessHandle?: () => Promise<OpfsSyncAccessHandleLike>;
}

export interface OpfsDirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  keys?: () => AsyncIterable<string>;
  entries?: () => AsyncIterable<[string, unknown]>;
  [Symbol.asyncIterator]?: () => AsyncIterator<[string, unknown]>;
}

export interface OpfsStorageNavigatorLike {
  getDirectory?: () => Promise<OpfsDirectoryHandleLike>;
}

export interface WebLockRequestOptions {
  mode?: "exclusive" | "shared";
  ifAvailable?: boolean;
}

export interface WebLocksLike {
  request<T>(
    name: string,
    options: WebLockRequestOptions,
    callback: (lock: object | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface HeldInstanceLock {
  readonly ready: Promise<void>;
  release(): Promise<void>;
}

interface OpfsFileEntry {
  kind: "opfs";
  fileId: string;
  fileSize: number;
  totalChunks: number;
  bitfield: Uint8Array;
  finalized: boolean;
  fileHandle: OpfsFileHandleLike;
  accessHandle: OpfsSyncAccessHandleLike | null;
}

interface FallbackFileEntry {
  kind: "fallback";
  fileId: string;
  fileSize: number;
  totalChunks: number;
  bitfield: Uint8Array;
  finalized: boolean;
  chunks: Map<number, Uint8Array>;
}

type ManagedFileEntry = OpfsFileEntry | FallbackFileEntry;

const SAFE_FILE_ID_RE = /^[a-zA-Z0-9_-]{4,80}$/;

export function assertValidStorageFileId(fileId: string): void {
  if (!SAFE_FILE_ID_RE.test(fileId)) {
    throw new Error(`Unsafe storage fileId: ${fileId}`);
  }
}

export function defaultWebLocksProvider(): WebLocksLike | undefined {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return (navigator as unknown as { locks?: WebLocksLike }).locks;
  }
  return undefined;
}

export function acquireSharedInstanceLock(
  locks: WebLocksLike | undefined,
  instanceId: string,
): HeldInstanceLock | null {
  if (!locks || typeof locks.request !== "function") {
    return null;
  }
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let releaseHold!: () => void;
  const holdPromise = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let released = false;

  const requestDone = Promise.resolve(
    locks.request(
      `${OPFS_INSTANCE_LOCK_PREFIX}${instanceId}`,
      { mode: "shared" },
      async () => {
        markReady();
        await holdPromise;
      },
    ),
  ).catch(() => {
    markReady();
  });

  return {
    ready,
    async release(): Promise<void> {
      if (!released) {
        released = true;
        markReady();
        releaseHold();
      }
      await requestDone;
    },
  };
}

export async function listOpfsDirectoryNames(
  dir: OpfsDirectoryHandleLike,
): Promise<string[]> {
  const names: string[] = [];
  try {
    if (typeof dir.keys === "function") {
      for await (const name of dir.keys()) {
        if (typeof name === "string") {
          names.push(name);
        }
      }
      return names;
    }
    if (typeof dir.entries === "function") {
      for await (const [name] of dir.entries()) {
        if (typeof name === "string") {
          names.push(name);
        }
      }
      return names;
    }
    if (typeof dir[Symbol.asyncIterator] === "function") {
      for await (const [name] of dir as unknown as AsyncIterable<
        [string, unknown]
      >) {
        if (typeof name === "string") {
          names.push(name);
        }
      }
    }
  } catch {
    // Ignore directory iteration errors in unsupported environments
  }
  return names;
}

export async function reclaimAbandonedOpfsInstances(
  swarmRoot: OpfsDirectoryHandleLike,
  selfInstanceId: string,
  locks: WebLocksLike | undefined,
): Promise<string[]> {
  if (!locks || typeof locks.request !== "function") {
    return [];
  }
  const names = await listOpfsDirectoryNames(swarmRoot);
  const reclaimed: string[] = [];
  for (const candidateId of names) {
    if (
      candidateId === selfInstanceId ||
      !SAFE_FILE_ID_RE.test(candidateId)
    ) {
      continue;
    }
    try {
      await locks.request(
        `${OPFS_INSTANCE_LOCK_PREFIX}${candidateId}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            // Live tab or worker holds a shared lock on candidateId — preserve it!
            return;
          }
          try {
            await swarmRoot.removeEntry(candidateId, { recursive: true });
            reclaimed.push(candidateId);
          } catch {
            // Ignore NotFoundError or active handle race
          }
        },
      );
    } catch {
      // Ignore lock manager errors
    }
  }
  return reclaimed;
}

export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function generateStorageInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `inst_${Math.random().toString(36).slice(2, 12)}_${Date.now()}`;
}

export interface OpfsWorkerStorageOptions {
  storageProvider?: () => OpfsStorageNavigatorLike | undefined;
  locksProvider?: () => WebLocksLike | undefined;
  instanceId?: string;
  maxFallbackBytes?: number;
}

export class OpfsWorkerStorageCore {
  private readonly entries = new Map<string, ManagedFileEntry>();
  private swarmRootDir: OpfsDirectoryHandleLike | null = null;
  private swarmDir: OpfsDirectoryHandleLike | null = null;
  private instanceLock: HeldInstanceLock | null = null;
  private opfsSupported: boolean | null = null;
  private readonly storageProvider: () => OpfsStorageNavigatorLike | undefined;
  private readonly locksProvider: () => WebLocksLike | undefined;
  private instanceId: string;
  private maxFallbackBytes: number;

  constructor(
    optionsOrProvider?:
      | (() => OpfsStorageNavigatorLike | undefined)
      | OpfsWorkerStorageOptions,
  ) {
    const opts: OpfsWorkerStorageOptions =
      typeof optionsOrProvider === "function"
        ? { storageProvider: optionsOrProvider }
        : (optionsOrProvider ?? {});
    this.storageProvider =
      opts.storageProvider ??
      (() =>
        typeof navigator !== "undefined"
          ? (navigator.storage as unknown as OpfsStorageNavigatorLike | undefined)
          : undefined);
    this.locksProvider = opts.locksProvider ?? defaultWebLocksProvider;
    const candidateInstanceId = opts.instanceId ?? generateStorageInstanceId();
    assertValidStorageFileId(candidateInstanceId);
    this.instanceId = candidateInstanceId;
    this.maxFallbackBytes = this.normalizeMaxFallbackBytes(
      opts.maxFallbackBytes,
    );
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  configure(params: { instanceId: string; maxFallbackBytes?: number }): void {
    assertValidStorageFileId(params.instanceId);
    if (this.entries.size === 0 && !this.swarmDir) {
      this.instanceId = params.instanceId;
    }
    if (params.maxFallbackBytes !== undefined) {
      this.maxFallbackBytes = this.normalizeMaxFallbackBytes(
        params.maxFallbackBytes,
      );
    }
  }

  private normalizeMaxFallbackBytes(value?: number): number {
    if (value === undefined) {
      return MAX_FALLBACK_STORAGE_BYTES;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("maxFallbackBytes must be a non-negative finite number");
    }
    return Math.floor(value);
  }

  private getFallbackReservedBytes(excludeFileId?: string): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind !== "fallback" || entry.fileId === excludeFileId) {
        continue;
      }
      let storedBytes = 0;
      for (const chunk of entry.chunks.values()) {
        storedBytes += chunk.byteLength;
      }
      total += Math.max(entry.fileSize, storedBytes);
    }
    return total;
  }

  private getFallbackStoredChunkBytes(
    excludeFileId?: string,
    excludeChunkIndex?: number,
  ): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind !== "fallback") continue;
      for (const [idx, chunk] of entry.chunks.entries()) {
        if (entry.fileId === excludeFileId && idx === excludeChunkIndex) {
          continue;
        }
        total += chunk.byteLength;
      }
    }
    return total;
  }

  async dispatch(
    req: OpfsWorkerRequest,
  ): Promise<{ response: OpfsWorkerResponse; transfer: Transferable[] }> {
    try {
      switch (req.type) {
        case "configure": {
          this.configure({
            instanceId: req.instanceId,
            ...(req.maxFallbackBytes !== undefined
              ? { maxFallbackBytes: req.maxFallbackBytes }
              : {}),
          });
          return {
            response: {
              id: req.id,
              ok: true,
              type: "configure",
            },
            transfer: [],
          };
        }

        case "initReceivingFile": {
          const { bitfield, backend } = await this.initReceivingFile(
            req.fileId,
            req.fileSize,
            req.totalChunks,
          );
          const bitfieldBuffer = toExactArrayBuffer(bitfield.slice());
          return {
            response: {
              id: req.id,
              ok: true,
              type: "initReceivingFile",
              bitfieldBuffer,
              backend,
            },
            transfer: [bitfieldBuffer],
          };
        }

        case "writeVerifiedChunk": {
          await this.writeVerifiedChunk(
            req.fileId,
            req.chunkIndex,
            new Uint8Array(req.dataBuffer),
          );
          return {
            response: {
              id: req.id,
              ok: true,
              type: "writeVerifiedChunk",
            },
            transfer: [],
          };
        }

        case "readChunk": {
          const chunk = await this.readChunk(
            req.fileId,
            req.chunkIndex,
            req.expectedLength,
          );
          const chunkBuffer = toExactArrayBuffer(chunk);
          return {
            response: {
              id: req.id,
              ok: true,
              type: "readChunk",
              chunkBuffer,
            },
            transfer: [chunkBuffer],
          };
        }

        case "finalizeFile": {
          await this.finalizeFile(req.fileId);
          return {
            response: {
              id: req.id,
              ok: true,
              type: "finalizeFile",
            },
            transfer: [],
          };
        }

        case "prepareDownload": {
          const prep = await this.prepareDownload(req.fileId);
          return {
            response: {
              id: req.id,
              ok: true,
              type: "prepareDownload",
              backend: prep.backend,
              ...(prep.fallbackChunks !== undefined
                ? { fallbackChunks: prep.fallbackChunks }
                : {}),
            },
            transfer: prep.fallbackChunks ?? [],
          };
        }

        case "deleteFile": {
          await this.deleteFile(req.fileId);
          return {
            response: {
              id: req.id,
              ok: true,
              type: "deleteFile",
            },
            transfer: [],
          };
        }

        case "closeAll": {
          await this.closeAll();
          return {
            response: {
              id: req.id,
              ok: true,
              type: "closeAll",
            },
            transfer: [],
          };
        }
      }
    } catch (err) {
      return {
        response: {
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        transfer: [],
      };
    }
  }

  private async ensureSwarmDir(): Promise<OpfsDirectoryHandleLike | null> {
    if (this.opfsSupported === false) {
      return null;
    }
    if (this.swarmDir) {
      return this.swarmDir;
    }
    const storage = this.storageProvider();
    if (!storage || typeof storage.getDirectory !== "function") {
      this.opfsSupported = false;
      return null;
    }
    try {
      const locks = this.locksProvider();
      if (!this.instanceLock) {
        this.instanceLock = acquireSharedInstanceLock(locks, this.instanceId);
      }
      await this.instanceLock?.ready;

      const root = await storage.getDirectory();
      const swarmRoot = await root.getDirectoryHandle(OPFS_SWARM_DIR_NAME, {
        create: true,
      });
      const instanceDir = await swarmRoot.getDirectoryHandle(this.instanceId, {
        create: true,
      });
      this.swarmRootDir = swarmRoot;
      this.swarmDir = instanceDir;

      await reclaimAbandonedOpfsInstances(swarmRoot, this.instanceId, locks);
      return instanceDir;
    } catch {
      const lock = this.instanceLock;
      this.instanceLock = null;
      await lock?.release();
      this.opfsSupported = false;
      return null;
    }
  }

  private async ensureAccessHandle(
    entry: OpfsFileEntry,
  ): Promise<OpfsSyncAccessHandleLike> {
    if (entry.accessHandle) {
      return entry.accessHandle;
    }
    if (typeof entry.fileHandle.createSyncAccessHandle !== "function") {
      throw new Error("FileSystemSyncAccessHandle unavailable");
    }
    const handle = await entry.fileHandle.createSyncAccessHandle();
    entry.accessHandle = handle;
    return handle;
  }

  async initReceivingFile(
    fileId: string,
    fileSize: number,
    totalChunks: number,
  ): Promise<{ bitfield: Uint8Array; backend: OpfsBackendKind }> {
    assertValidStorageFileId(fileId);
    const existing = this.entries.get(fileId);
    if (existing) {
      return {
        bitfield: existing.bitfield,
        backend: existing.kind,
      };
    }

    const dir = await this.ensureSwarmDir();
    if (dir) {
      try {
        const fileHandle = await dir.getFileHandle(`${fileId}.bin`, {
          create: true,
        });
        if (typeof fileHandle.createSyncAccessHandle === "function") {
          const accessHandle = await fileHandle.createSyncAccessHandle();
          this.opfsSupported = true;
          const opfsEntry: OpfsFileEntry = {
            kind: "opfs",
            fileId,
            fileSize,
            totalChunks,
            bitfield: createBitfield(totalChunks),
            finalized: false,
            fileHandle,
            accessHandle,
          };
          this.entries.set(fileId, opfsEntry);
          return { bitfield: opfsEntry.bitfield, backend: "opfs" };
        }
      } catch {
        this.opfsSupported = false;
      }
    }

    const reservedBytes = this.getFallbackReservedBytes(fileId);
    if (
      fileSize > this.maxFallbackBytes ||
      reservedBytes + fileSize > this.maxFallbackBytes
    ) {
      throw new Error(
        `OPFS SyncAccessHandle is unavailable and file size (${fileSize} B) exceeds in-memory fallback cap (${this.maxFallbackBytes} B)`,
      );
    }

    const fallbackEntry: FallbackFileEntry = {
      kind: "fallback",
      fileId,
      fileSize,
      totalChunks,
      bitfield: createBitfield(totalChunks),
      finalized: false,
      chunks: new Map<number, Uint8Array>(),
    };
    this.entries.set(fileId, fallbackEntry);
    return { bitfield: fallbackEntry.bitfield, backend: "fallback" };
  }

  async writeVerifiedChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
  ): Promise<void> {
    assertValidStorageFileId(fileId);
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error(`Storage file not initialized: ${fileId}`);
    }
    if (chunkIndex < 0 || chunkIndex >= entry.totalChunks) {
      throw new Error(`Chunk index out of range: ${chunkIndex}`);
    }

    if (entry.kind === "opfs") {
      const handle = await this.ensureAccessHandle(entry);
      const byteOffset = chunkIndex * SWARM_CHUNK_SIZE;
      let written = 0;
      while (written < data.byteLength) {
        const slice = written === 0 ? data : data.subarray(written);
        const n = handle.write(slice, { at: byteOffset + written });
        if (n <= 0) {
          throw new Error("OPFS SyncAccessHandle write returned 0 bytes");
        }
        written += n;
      }
      handle.flush();
    } else {
      const storedElsewhere = this.getFallbackStoredChunkBytes(
        fileId,
        chunkIndex,
      );
      if (storedElsewhere + data.byteLength > this.maxFallbackBytes) {
        throw new Error(
          `In-memory fallback storage cap (${this.maxFallbackBytes} B) exceeded`,
        );
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      entry.chunks.set(chunkIndex, copy);
    }

    setChunkInBitfield(entry.bitfield, chunkIndex);
  }

  async readChunk(
    fileId: string,
    chunkIndex: number,
    expectedLength: number,
  ): Promise<Uint8Array> {
    assertValidStorageFileId(fileId);
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error(`Storage file not found: ${fileId}`);
    }
    if (expectedLength < 0 || expectedLength > SWARM_CHUNK_SIZE) {
      throw new Error(`Invalid expected chunk length: ${expectedLength}`);
    }
    if (expectedLength === 0) {
      return new Uint8Array(0);
    }

    if (entry.kind === "opfs") {
      const handle = await this.ensureAccessHandle(entry);
      const buf = new Uint8Array(expectedLength);
      const byteOffset = chunkIndex * SWARM_CHUNK_SIZE;
      let totalRead = 0;
      while (totalRead < expectedLength) {
        const target = totalRead === 0 ? buf : buf.subarray(totalRead);
        const n = handle.read(target, { at: byteOffset + totalRead });
        if (n <= 0) {
          break;
        }
        totalRead += n;
      }
      if (totalRead !== expectedLength) {
        throw new Error(
          `Short OPFS read on chunk ${chunkIndex}: expected ${expectedLength}, got ${totalRead}`,
        );
      }
      return buf;
    }

    const stored = entry.chunks.get(chunkIndex);
    if (!stored) {
      throw new Error(`Chunk ${chunkIndex} not present for ${fileId}`);
    }
    if (stored.byteLength < expectedLength) {
      throw new Error(
        `Fallback chunk ${chunkIndex} too short: expected ${expectedLength}, got ${stored.byteLength}`,
      );
    }
    return stored.slice(0, expectedLength);
  }

  async finalizeFile(fileId: string): Promise<void> {
    assertValidStorageFileId(fileId);
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error(`Storage file not found: ${fileId}`);
    }

    if (entry.kind === "opfs") {
      const handle = await this.ensureAccessHandle(entry);
      handle.truncate(entry.fileSize);
      handle.flush();
      entry.finalized = true;
      return;
    }

    if (entry.totalChunks > 0) {
      const lastIdx = entry.totalChunks - 1;
      const expectedLastLen = entry.fileSize - lastIdx * SWARM_CHUNK_SIZE;
      const lastChunk = entry.chunks.get(lastIdx);
      if (lastChunk && lastChunk.byteLength > expectedLastLen) {
        entry.chunks.set(lastIdx, lastChunk.slice(0, expectedLastLen));
      }
    }
    entry.finalized = true;
  }

  async prepareDownload(
    fileId: string,
  ): Promise<{ backend: OpfsBackendKind; fallbackChunks?: ArrayBuffer[] }> {
    assertValidStorageFileId(fileId);
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error(`Storage file not found: ${fileId}`);
    }

    if (entry.kind === "opfs") {
      if (entry.accessHandle) {
        entry.accessHandle.flush();
        entry.accessHandle.close();
        entry.accessHandle = null;
      }
      return { backend: "opfs" };
    }

    const buffers: ArrayBuffer[] = [];
    for (let i = 0; i < entry.totalChunks; i++) {
      const chunk = entry.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} while preparing fallback download`);
      }
      buffers.push(toExactArrayBuffer(chunk.slice()));
    }
    return { backend: "fallback", fallbackChunks: buffers };
  }

  async deleteFile(fileId: string): Promise<void> {
    assertValidStorageFileId(fileId);
    const entry = this.entries.get(fileId);
    if (entry) {
      if (entry.kind === "opfs" && entry.accessHandle) {
        try {
          entry.accessHandle.close();
        } catch {
          // Ignore already-closed handle
        }
        entry.accessHandle = null;
      } else if (entry.kind === "fallback") {
        for (const chunk of entry.chunks.values()) {
          chunk.fill(0);
        }
        entry.chunks.clear();
      }
      this.entries.delete(fileId);
    }

    if (this.swarmDir) {
      try {
        await this.swarmDir.removeEntry(`${fileId}.bin`);
      } catch {
        // Ignore NotFoundError
      }
    }
  }

  async closeAll(): Promise<void> {
    try {
      const fileIds = Array.from(this.entries.keys());
      for (const fileId of fileIds) {
        const entry = this.entries.get(fileId);
        if (!entry) continue;
        if (entry.kind === "opfs") {
          if (entry.accessHandle) {
            try {
              entry.accessHandle.close();
            } catch {
              // Ignore close errors
            }
            entry.accessHandle = null;
          }
        } else {
          for (const chunk of entry.chunks.values()) {
            chunk.fill(0);
          }
          entry.chunks.clear();
        }
      }
      this.entries.clear();

      if (this.swarmDir) {
        for (const fileId of fileIds) {
          try {
            await this.swarmDir.removeEntry(`${fileId}.bin`);
          } catch {
            // Ignore individual file removal error
          }
        }
      }
      if (this.swarmRootDir) {
        try {
          await this.swarmRootDir.removeEntry(this.instanceId, {
            recursive: true,
          });
        } catch {
          // Ignore if instance directory already empty/removed
        }
      }
      this.swarmDir = null;
      this.swarmRootDir = null;
    } finally {
      const lock = this.instanceLock;
      this.instanceLock = null;
      await lock?.release();
    }
  }
}
