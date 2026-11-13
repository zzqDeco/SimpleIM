import {
  sanitizeFileName,
  SWARM_CHUNK_SIZE,
  type FileManifest,
} from "@simpleim/contracts";
import type { ChunkStoragePort } from "@simpleim/peer-core";
import {
  OPFS_SWARM_DIR_NAME,
  OpfsWorkerStorageCore,
  toExactArrayBuffer,
  type OpfsDirectoryHandleLike,
  type OpfsStorageNavigatorLike,
  type OpfsWorkerRequest,
  type OpfsWorkerResponse,
} from "./opfs-protocol.ts";

interface LocalSeedingEntry {
  manifest: FileManifest;
  readLocalChunk: (
    chunkIndex: number,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
}

interface PendingRpc {
  resolve: (res: Extract<OpfsWorkerResponse, { ok: true }>) => void;
  reject: (err: Error) => void;
}

export interface OpfsChunkStorageOptions {
  forceInlineFallback?: boolean;
  storageProvider?: () => OpfsStorageNavigatorLike | undefined;
}

export function createBrowserFileChunkReader(
  file: Blob,
): (chunkIndex: number, offset: number, length: number) => Promise<Uint8Array> {
  return async (_chunkIndex: number, offset: number, length: number) => {
    if (length === 0) {
      return new Uint8Array(0);
    }
    const slice = file.slice(offset, offset + length);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  };
}

export class OpfsChunkStorageAdapter implements ChunkStoragePort {
  private worker: Worker | null = null;
  private inlineCore: OpfsWorkerStorageCore | null = null;
  private closed = false;
  private nextRpcId = 1;
  private readonly pendingRpcs = new Map<number, PendingRpc>();
  private readonly localSeedingFiles = new Map<string, LocalSeedingEntry>();
  private readonly localSourceBlobs = new Map<string, Blob>();
  private readonly downloadedFileIds = new Set<string>();
  private readonly options: OpfsChunkStorageOptions;

  constructor(options?: OpfsChunkStorageOptions) {
    this.options = options ?? {};
    if (!this.options.forceInlineFallback && typeof Worker !== "undefined") {
      try {
        const w = new Worker(
          new URL("../workers/opfs.worker.ts", import.meta.url),
          { type: "module" },
        );
        w.onmessage = (event: MessageEvent<OpfsWorkerResponse>) => {
          this.handleWorkerResponse(event.data);
        };
        w.onerror = (event: ErrorEvent) => {
          const err = new Error(event.message || "OPFS worker runtime error");
          for (const pending of this.pendingRpcs.values()) {
            pending.reject(err);
          }
          this.pendingRpcs.clear();
        };
        this.worker = w;
      } catch {
        this.inlineCore = new OpfsWorkerStorageCore(this.options.storageProvider);
      }
    } else {
      this.inlineCore = new OpfsWorkerStorageCore(this.options.storageProvider);
    }
  }

  attachLocalSourceBlob(fileId: string, blob: Blob): void {
    this.localSourceBlobs.set(fileId, blob);
  }

  isSaveAvailable(fileId: string): boolean {
    return this.downloadedFileIds.has(fileId) || this.localSourceBlobs.has(fileId);
  }

  async initReceivingFile(
    manifest: FileManifest,
  ): Promise<{ existingBitfield: Uint8Array }> {
    const res = await this.sendRpc({
      id: this.nextRpcId++,
      type: "initReceivingFile",
      fileId: manifest.fileId,
      fileSize: manifest.fileSize,
      totalChunks: manifest.totalChunks,
    });
    if (res.type !== "initReceivingFile") {
      throw new Error("Unexpected OPFS worker response type");
    }
    return {
      existingBitfield: new Uint8Array(res.bitfieldBuffer),
    };
  }

  async registerSeedingFile(params: {
    manifest: FileManifest;
    readLocalChunk: (
      chunkIndex: number,
      offset: number,
      length: number,
    ) => Promise<Uint8Array>;
  }): Promise<void> {
    this.localSeedingFiles.set(params.manifest.fileId, {
      manifest: params.manifest,
      readLocalChunk: params.readLocalChunk,
    });
  }

  async writeVerifiedChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
  ): Promise<void> {
    const copyBuffer = toExactArrayBuffer(data.slice());
    await this.sendRpc(
      {
        id: this.nextRpcId++,
        type: "writeVerifiedChunk",
        fileId,
        chunkIndex,
        dataBuffer: copyBuffer,
      },
      [copyBuffer],
    );
  }

  async readChunk(
    fileId: string,
    chunkIndex: number,
    expectedLength: number,
  ): Promise<Uint8Array> {
    const local = this.localSeedingFiles.get(fileId);
    if (local) {
      const offset = chunkIndex * SWARM_CHUNK_SIZE;
      return local.readLocalChunk(chunkIndex, offset, expectedLength);
    }

    const res = await this.sendRpc({
      id: this.nextRpcId++,
      type: "readChunk",
      fileId,
      chunkIndex,
      expectedLength,
    });
    if (res.type !== "readChunk") {
      throw new Error("Unexpected OPFS worker response type");
    }
    return new Uint8Array(res.chunkBuffer);
  }

  async finalizeFile(fileId: string): Promise<void> {
    await this.sendRpc({
      id: this.nextRpcId++,
      type: "finalizeFile",
      fileId,
    });
    this.downloadedFileIds.add(fileId);
  }

  async deleteFile(fileId: string): Promise<void> {
    this.localSeedingFiles.delete(fileId);
    this.localSourceBlobs.delete(fileId);
    this.downloadedFileIds.delete(fileId);
    await this.sendRpc({
      id: this.nextRpcId++,
      type: "deleteFile",
      fileId,
    });
  }

  async closeAll(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.localSeedingFiles.clear();
    this.localSourceBlobs.clear();
    this.downloadedFileIds.clear();
    try {
      await this.sendRpc({
        id: this.nextRpcId++,
        type: "closeAll",
      });
    } finally {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.inlineCore = null;
      for (const pending of this.pendingRpcs.values()) {
        pending.reject(new Error("OPFS storage closed"));
      }
      this.pendingRpcs.clear();
    }
  }

  async triggerBrowserDownload(
    fileId: string,
    fileName: string,
    mimeType = "application/octet-stream",
  ): Promise<void> {
    const safeName = sanitizeFileName(fileName);
    const safeMime = mimeType.trim() || "application/octet-stream";

    let blobToSave: Blob | null = null;
    const localBlob = this.localSourceBlobs.get(fileId);
    if (localBlob) {
      blobToSave = localBlob.slice(0, localBlob.size, safeMime);
    } else {
      const prep = await this.sendRpc({
        id: this.nextRpcId++,
        type: "prepareDownload",
        fileId,
      });
      if (prep.type !== "prepareDownload") {
        throw new Error("Unexpected prepareDownload response");
      }

      if (prep.backend === "opfs") {
        const storage = (
          this.options.storageProvider
            ? this.options.storageProvider()
            : typeof navigator !== "undefined"
              ? (navigator.storage as unknown as OpfsStorageNavigatorLike | undefined)
              : undefined
        );
        if (!storage?.getDirectory) {
          throw new Error("OPFS directory API unavailable on main thread");
        }
        const rootDir: OpfsDirectoryHandleLike = await storage.getDirectory();
        const swarmDir = await rootDir.getDirectoryHandle(OPFS_SWARM_DIR_NAME);
        const fileHandle = await swarmDir.getFileHandle(`${fileId}.bin`);
        // Zero-copy File backed directly by OPFS disk storage
        const opfsFile = await fileHandle.getFile();
        blobToSave = opfsFile.slice(0, opfsFile.size, safeMime);
      } else {
        blobToSave = new Blob(prep.fallbackChunks ?? [], { type: safeMime });
      }
    }

    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
      return;
    }

    const objectUrl = URL.createObjectURL(blobToSave);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = safeName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }

  private handleWorkerResponse(res: OpfsWorkerResponse): void {
    const pending = this.pendingRpcs.get(res.id);
    if (!pending) return;
    this.pendingRpcs.delete(res.id);

    if (!res.ok) {
      pending.reject(new Error(res.error));
      return;
    }
    pending.resolve(res);
  }

  private async sendRpc(
    req: OpfsWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<Extract<OpfsWorkerResponse, { ok: true }>> {
    if (this.inlineCore) {
      const { response } = await this.inlineCore.dispatch(req);
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    }

    const worker = this.worker;
    if (!worker) {
      // Recreate inline core if called during teardown race, or fail cleanly
      throw new Error("OPFS worker has been closed");
    }

    return new Promise<Extract<OpfsWorkerResponse, { ok: true }>>(
      (resolve, reject) => {
        this.pendingRpcs.set(req.id, { resolve, reject });
        worker.postMessage(req, transfer);
      },
    );
  }
}
