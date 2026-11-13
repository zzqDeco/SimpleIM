import {
  createBitfield,
  setChunkInBitfield,
  SWARM_CHUNK_SIZE,
} from "@simpleim/contracts";

export const OPFS_SWARM_DIR_NAME = "simpleim-swarm";

export type OpfsBackendKind = "opfs" | "fallback";

export type OpfsWorkerRequest =
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
      type: "writeVerifiedChunk" | "finalizeFile" | "deleteFile" | "closeAll";
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
}

export interface OpfsStorageNavigatorLike {
  getDirectory?: () => Promise<OpfsDirectoryHandleLike>;
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

function assertValidStorageFileId(fileId: string): void {
  if (!SAFE_FILE_ID_RE.test(fileId)) {
    throw new Error(`Unsafe storage fileId: ${fileId}`);
  }
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

export class OpfsWorkerStorageCore {
  private readonly entries = new Map<string, ManagedFileEntry>();
  private rootDir: OpfsDirectoryHandleLike | null = null;
  private swarmDir: OpfsDirectoryHandleLike | null = null;
  private opfsSupported: boolean | null = null;
  private readonly storageProvider: () => OpfsStorageNavigatorLike | undefined;

  constructor(storageProvider?: () => OpfsStorageNavigatorLike | undefined) {
    this.storageProvider =
      storageProvider ??
      (() =>
        typeof navigator !== "undefined"
          ? (navigator.storage as unknown as OpfsStorageNavigatorLike | undefined)
          : undefined);
  }

  async dispatch(
    req: OpfsWorkerRequest,
  ): Promise<{ response: OpfsWorkerResponse; transfer: Transferable[] }> {
    try {
      switch (req.type) {
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
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_SWARM_DIR_NAME, {
        create: true,
      });
      this.rootDir = root;
      this.swarmDir = dir;
      return dir;
    } catch {
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
    if (this.rootDir) {
      try {
        await this.rootDir.removeEntry(OPFS_SWARM_DIR_NAME, { recursive: true });
      } catch {
        // Ignore if directory already empty/removed
      }
    }
    this.swarmDir = null;
  }
}
