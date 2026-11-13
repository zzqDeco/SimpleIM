import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import {
  countChunksInBitfield,
  createBitfield,
  hasChunkInBitfield,
  sanitizeFileName,
  setChunkInBitfield,
  SWARM_CHUNK_SIZE,
  type FileManifest,
} from "@simpleim/contracts";
import type { ChunkStoragePort } from "@simpleim/peer-core";

export class StorageQuotaExceededError extends Error {
  readonly code = "storage_quota_exceeded";

  constructor(message: string) {
    super(message);
    this.name = "StorageQuotaExceededError";
  }
}

interface ReceivingFileRecord {
  kind: "receiving";
  manifest: FileManifest;
  safeName: string;
  partPath: string;
  bitfieldPath: string;
  fileHandle: FileHandle;
  bitfield: Uint8Array;
  bitfieldWriteChain: Promise<void>;
}

interface FinalizedFileRecord {
  kind: "finalized";
  manifest: FileManifest;
  finalPath: string;
}

interface LocalSeedingFileRecord {
  kind: "seeding";
  manifest: FileManifest;
  readLocalChunk: (
    chunkIndex: number,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
}

type StoredFileRecord =
  | ReceivingFileRecord
  | FinalizedFileRecord
  | LocalSeedingFileRecord;

function splitStemAndExt(safeName: string): { stem: string; ext: string } {
  const lastDot = safeName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { stem: safeName, ext: "" };
  }
  return {
    stem: safeName.slice(0, lastDot),
    ext: safeName.slice(lastDot),
  };
}

function maskUnusedTrailingBits(
  bitfield: Uint8Array,
  totalChunks: number,
): void {
  const rem = totalChunks & 7;
  if (rem === 0 || bitfield.byteLength === 0) return;
  const lastIdx = bitfield.byteLength - 1;
  const validMask = (0xff << (8 - rem)) & 0xff;
  bitfield[lastIdx] = (bitfield[lastIdx] ?? 0) & validMask;
}

async function pathExistsAny(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function writeFullAt(
  fh: FileHandle,
  data: Uint8Array,
  position: number,
): Promise<void> {
  let writtenTotal = 0;
  while (writtenTotal < data.byteLength) {
    const { bytesWritten } = await fh.write(
      data,
      writtenTotal,
      data.byteLength - writtenTotal,
      position + writtenTotal,
    );
    if (bytesWritten <= 0) {
      throw new Error("Unexpected zero-byte write to chunk storage");
    }
    writtenTotal += bytesWritten;
  }
}

async function readFullAt(
  fh: FileHandle,
  length: number,
  position: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let readTotal = 0;
  while (readTotal < length) {
    const { bytesRead } = await fh.read(
      out,
      readTotal,
      length - readTotal,
      position + readTotal,
    );
    if (bytesRead <= 0) {
      throw new Error(
        `Unexpected EOF reading chunk at offset ${position + readTotal} (expected ${length}B, got ${readTotal}B)`,
      );
    }
    readTotal += bytesRead;
  }
  return out;
}

export interface FsChunkStorageOptions {
  downloadDir: string;
  maxStorageBytes?: number;
}

export class FsChunkStorageAdapter implements ChunkStoragePort {
  readonly downloadDir: string;
  readonly maxStorageBytes?: number;

  private readonly records = new Map<string, StoredFileRecord>();

  constructor(options: FsChunkStorageOptions) {
    this.downloadDir = resolve(options.downloadDir);
    if (options.maxStorageBytes !== undefined) {
      if (
        !Number.isFinite(options.maxStorageBytes) ||
        options.maxStorageBytes < 0
      ) {
        throw new Error("maxStorageBytes must be a non-negative number");
      }
      this.maxStorageBytes = Math.floor(options.maxStorageBytes);
    }
  }

  private resolveSafeChildPath(childFileName: string): string {
    const base = basename(childFileName);
    if (base !== childFileName || base === "." || base === "..") {
      throw new Error(`Unsafe storage filename rejected: ${childFileName}`);
    }
    const candidate = resolve(this.downloadDir, base);
    const prefix = this.downloadDir.endsWith(sep)
      ? this.downloadDir
      : `${this.downloadDir}${sep}`;
    if (!candidate.startsWith(prefix)) {
      throw new Error("Path traversal outside downloadDir rejected");
    }
    return candidate;
  }

  async getUsedPayloadBytes(excludePartPath?: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.downloadDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return 0;
      }
      throw err;
    }

    let total = 0;
    for (const name of entries) {
      if (name.endsWith(".simpleim.bitfield") || name.endsWith(".bitfield.tmp")) {
        continue;
      }
      const fullPath = join(this.downloadDir, name);
      if (excludePartPath && fullPath === excludePartPath) {
        continue;
      }
      try {
        const st = await stat(fullPath);
        if (st.isFile()) {
          total += st.size;
        }
      } catch {
        // Ignore concurrently removed transient files
      }
    }
    return total;
  }

  getCompletedFilePath(fileId: string): string | undefined {
    const rec = this.records.get(fileId);
    return rec?.kind === "finalized" ? rec.finalPath : undefined;
  }

  async initReceivingFile(
    manifest: FileManifest,
  ): Promise<{ existingBitfield: Uint8Array }> {
    const safeName = sanitizeFileName(manifest.fileName);

    const existingRec = this.records.get(manifest.fileId);
    if (existingRec) {
      if (existingRec.kind === "receiving") {
        return { existingBitfield: existingRec.bitfield.slice() };
      }
      if (existingRec.kind === "finalized" || existingRec.kind === "seeding") {
        const full = createBitfield(manifest.totalChunks);
        for (let i = 0; i < manifest.totalChunks; i++) {
          setChunkInBitfield(full, i);
        }
        return { existingBitfield: full };
      }
    }

    await mkdir(this.downloadDir, { recursive: true });

    // Disambiguate if another active download in the same session already owns <safeName>.simpleim.part
    const activePartCollision = Array.from(this.records.values()).some(
      (r) => r.kind === "receiving" && r.safeName === safeName,
    );
    const partBaseName = activePartCollision
      ? `${safeName}.${manifest.fileId.slice(0, 8)}`
      : safeName;

    const partPath = this.resolveSafeChildPath(`${partBaseName}.simpleim.part`);
    const bitfieldPath = this.resolveSafeChildPath(
      `${partBaseName}.simpleim.bitfield`,
    );

    if (this.maxStorageBytes !== undefined) {
      const currentUsed = await this.getUsedPayloadBytes(partPath);
      if (currentUsed + manifest.fileSize > this.maxStorageBytes) {
        throw new StorageQuotaExceededError(
          `File size (${manifest.fileSize} B) exceeds remaining storage quota (${Math.max(0, this.maxStorageBytes - currentUsed)} B available of ${this.maxStorageBytes} B)`,
        );
      }
    }

    const expectedBitfieldBytes = Math.ceil(manifest.totalChunks / 8);

    let resumedBitfield: Uint8Array | null = null;
    try {
      const [partStat, rawBf] = await Promise.all([
        stat(partPath),
        readFile(bitfieldPath),
      ]);
      if (
        partStat.isFile() &&
        partStat.size === manifest.fileSize &&
        rawBf.byteLength === expectedBitfieldBytes
      ) {
        const bf = new Uint8Array(rawBf.byteLength);
        bf.set(rawBf);
        maskUnusedTrailingBits(bf, manifest.totalChunks);
        resumedBitfield = bf;
      }
    } catch {
      resumedBitfield = null;
    }

    let fileHandle: FileHandle;
    let bitfield: Uint8Array;

    if (resumedBitfield !== null) {
      fileHandle = await open(partPath, "r+");
      bitfield = resumedBitfield;
    } else {
      fileHandle = await open(partPath, "w+");
      try {
        await fileHandle.truncate(manifest.fileSize);
        bitfield = createBitfield(manifest.totalChunks);
        await writeFile(bitfieldPath, bitfield);
      } catch (err) {
        await fileHandle.close().catch(() => {});
        throw err;
      }
    }

    const record: ReceivingFileRecord = {
      kind: "receiving",
      manifest,
      safeName,
      partPath,
      bitfieldPath,
      fileHandle,
      bitfield,
      bitfieldWriteChain: Promise.resolve(),
    };
    this.records.set(manifest.fileId, record);

    return { existingBitfield: bitfield.slice() };
  }

  async registerSeedingFile(params: {
    manifest: FileManifest;
    readLocalChunk: (
      chunkIndex: number,
      offset: number,
      length: number,
    ) => Promise<Uint8Array>;
  }): Promise<void> {
    sanitizeFileName(params.manifest.fileName);
    this.records.set(params.manifest.fileId, {
      kind: "seeding",
      manifest: params.manifest,
      readLocalChunk: params.readLocalChunk,
    });
  }

  async writeVerifiedChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
  ): Promise<void> {
    const rec = this.records.get(fileId);
    if (!rec || rec.kind !== "receiving") {
      throw new Error(`No active receiving file for fileId=${fileId}`);
    }

    const { manifest } = rec;
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= manifest.totalChunks
    ) {
      throw new Error(
        `Invalid chunkIndex ${chunkIndex} (totalChunks=${manifest.totalChunks})`,
      );
    }

    const offset = chunkIndex * SWARM_CHUNK_SIZE;
    const expectedLength = Math.min(
      SWARM_CHUNK_SIZE,
      manifest.fileSize - offset,
    );
    if (data.byteLength !== expectedLength) {
      throw new Error(
        `Chunk ${chunkIndex} size mismatch: expected ${expectedLength} B, got ${data.byteLength} B`,
      );
    }

    await writeFullAt(rec.fileHandle, data, offset);
    setChunkInBitfield(rec.bitfield, chunkIndex);

    const snapshot = rec.bitfield.slice();
    const persistOp = rec.bitfieldWriteChain.then(async () => {
      const tmpBf = `${rec.bitfieldPath}.tmp`;
      await writeFile(tmpBf, snapshot);
      await rename(tmpBf, rec.bitfieldPath);
    });
    rec.bitfieldWriteChain = persistOp.catch(() => {});
    await persistOp;
  }

  async readChunk(
    fileId: string,
    chunkIndex: number,
    expectedLength: number,
  ): Promise<Uint8Array> {
    const rec = this.records.get(fileId);
    if (!rec) {
      throw new Error(`Unknown fileId=${fileId}`);
    }

    const { manifest } = rec;
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= manifest.totalChunks
    ) {
      throw new Error(`Chunk index out of bounds: ${chunkIndex}`);
    }

    const offset = chunkIndex * SWARM_CHUNK_SIZE;
    const actualExpected = Math.min(
      SWARM_CHUNK_SIZE,
      manifest.fileSize - offset,
    );
    if (expectedLength !== actualExpected) {
      throw new Error(
        `Expected length ${expectedLength} does not match manifest chunk size ${actualExpected}`,
      );
    }

    if (rec.kind === "seeding") {
      const bytes = await rec.readLocalChunk(chunkIndex, offset, expectedLength);
      if (bytes.byteLength !== expectedLength) {
        throw new Error("Local seeding reader returned unexpected chunk length");
      }
      return bytes;
    }

    if (rec.kind === "receiving") {
      if (!hasChunkInBitfield(rec.bitfield, chunkIndex)) {
        throw new Error(`Chunk ${chunkIndex} not yet present in partial file`);
      }
      return readFullAt(rec.fileHandle, expectedLength, offset);
    }

    const fh = await open(rec.finalPath, "r");
    try {
      return await readFullAt(fh, expectedLength, offset);
    } finally {
      await fh.close();
    }
  }

  async finalizeFile(fileId: string): Promise<void> {
    const rec = this.records.get(fileId);
    if (!rec) {
      throw new Error(`Unknown fileId=${fileId}`);
    }
    if (rec.kind === "finalized" || rec.kind === "seeding") {
      return;
    }

    await rec.bitfieldWriteChain;

    const completedCount = countChunksInBitfield(
      rec.bitfield,
      rec.manifest.totalChunks,
    );
    if (completedCount !== rec.manifest.totalChunks) {
      throw new Error(
        `Cannot finalize incomplete file (${completedCount}/${rec.manifest.totalChunks} chunks)`,
      );
    }

    await rec.fileHandle.sync();
    await rec.fileHandle.close();

    const finalPath = await this.pickNonClobberingDestination(rec.safeName);
    await rename(rec.partPath, finalPath);
    await rm(rec.bitfieldPath, { force: true });

    this.records.set(fileId, {
      kind: "finalized",
      manifest: rec.manifest,
      finalPath,
    });
  }

  private async pickNonClobberingDestination(safeName: string): Promise<string> {
    const primary = this.resolveSafeChildPath(safeName);
    if (!(await pathExistsAny(primary))) {
      return primary;
    }

    const { stem, ext } = splitStemAndExt(safeName);
    for (let counter = 1; counter <= 10_000; counter++) {
      const candidateName = `${stem} (${counter})${ext}`;
      const candidatePath = this.resolveSafeChildPath(candidateName);
      if (!(await pathExistsAny(candidatePath))) {
        return candidatePath;
      }
    }
    throw new Error("Unable to allocate non-colliding filename in downloadDir");
  }

  async deleteFile(fileId: string): Promise<void> {
    const rec = this.records.get(fileId);
    if (!rec) return;
    this.records.delete(fileId);

    if (rec.kind === "receiving") {
      await rec.bitfieldWriteChain.catch(() => {});
      await rec.fileHandle.close().catch(() => {});
      await rm(rec.partPath, { force: true }).catch(() => {});
      await rm(rec.bitfieldPath, { force: true }).catch(() => {});
    }
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.records.values());
    this.records.clear();

    for (const rec of entries) {
      if (rec.kind === "receiving") {
        await rec.bitfieldWriteChain.catch(() => {});
        await rec.fileHandle.close().catch(() => {});
      }
    }
  }
}
