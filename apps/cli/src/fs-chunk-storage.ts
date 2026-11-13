import { createHash } from "node:crypto";
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
  MAX_SWARM_FILE_CHUNKS,
  sanitizeFileName,
  setChunkInBitfield,
  SWARM_CHUNK_SIZE,
  uuidToBytes16,
  type FileManifest,
} from "@simpleim/contracts";
import { hexToBytes, verifyChunkSha256 } from "@simpleim/crypto";
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

const BITFIELD_MAGIC = new Uint8Array([
  0x53, 0x49, 0x4d, 0x42, 0x46, 0x30, 0x31, 0x00,
]); // "SIMBF01\0"
const BITFIELD_HEADER_BYTES = 8 + 16 + 32 + 32; // 88 bytes: magic + fileId(16) + roomId(32) + fileSha256(32)
const MAX_BITFIELD_SIDECAR_BYTES =
  BITFIELD_HEADER_BYTES + Math.ceil(MAX_SWARM_FILE_CHUNKS / 8);
const MAX_FILENAME_UTF8_BYTES = 255;
const LONGEST_PARTIAL_SUFFIX_BYTES = ".simpleim.bitfield.tmp".length; // 22 bytes
const STREAM_HASH_BLOCK_BYTES = 256 * 1024;

function truncateUtf8ByBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).byteLength <= maxBytes) {
    return input;
  }
  let acc = "";
  let usedBytes = 0;
  for (const ch of input) {
    const chBytes = encoder.encode(ch).byteLength;
    if (usedBytes + chBytes > maxBytes) {
      break;
    }
    acc += ch;
    usedBytes += chBytes;
  }
  return acc.length > 0 ? acc : "file";
}

function buildBitfieldHeader(manifest: FileManifest): Uint8Array {
  const header = new Uint8Array(BITFIELD_HEADER_BYTES);
  header.set(BITFIELD_MAGIC, 0);
  header.set(uuidToBytes16(manifest.fileId), 8);
  header.set(hexToBytes(manifest.roomId), 24);
  header.set(hexToBytes(manifest.fileSha256), 56);
  return header;
}

function encodeBitfieldSidecar(
  manifest: FileManifest,
  bitfield: Uint8Array,
): Uint8Array {
  const header = buildBitfieldHeader(manifest);
  const out = new Uint8Array(BITFIELD_HEADER_BYTES + bitfield.byteLength);
  out.set(header, 0);
  out.set(bitfield, BITFIELD_HEADER_BYTES);
  return out;
}

function hasBitfieldMagic(raw: Uint8Array): boolean {
  if (raw.byteLength < BITFIELD_MAGIC.byteLength) return false;
  for (let i = 0; i < BITFIELD_MAGIC.byteLength; i++) {
    if (raw[i] !== BITFIELD_MAGIC[i]) return false;
  }
  return true;
}

function matchesBitfieldHeader(
  raw: Uint8Array,
  manifest: FileManifest,
): boolean {
  if (raw.byteLength < BITFIELD_HEADER_BYTES) return false;
  let expected: Uint8Array;
  try {
    expected = buildBitfieldHeader(manifest);
  } catch {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < BITFIELD_HEADER_BYTES; i++) {
    diff |= (raw[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}

async function computeFileHandleSha256Hex(
  fh: FileHandle,
  totalBytes: number,
): Promise<string> {
  const hasher = createHash("sha256");
  if (totalBytes === 0) {
    return hasher.digest("hex");
  }
  const buf = new Uint8Array(Math.min(STREAM_HASH_BLOCK_BYTES, totalBytes));
  let offset = 0;
  while (offset < totalBytes) {
    const toRead = Math.min(buf.byteLength, totalBytes - offset);
    const { bytesRead } = await fh.read(buf, 0, toRead, offset);
    if (bytesRead <= 0) {
      throw new Error(
        `Unexpected EOF verifying finalized file at offset ${offset} (expected ${totalBytes} B)`,
      );
    }
    hasher.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hasher.digest("hex");
}

function clearBitInBitfield(bitfield: Uint8Array, chunkIndex: number): void {
  const byteIdx = chunkIndex >>> 3;
  if (byteIdx < 0 || byteIdx >= bitfield.byteLength) return;
  const mask = ~(0x80 >>> (chunkIndex & 7)) & 0xff;
  bitfield[byteIdx] = (bitfield[byteIdx] ?? 0) & mask;
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
  private fsAllocQueue: Promise<void> = Promise.resolve();

  private withFsAllocLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.fsAllocQueue.then(fn, fn);
    this.fsAllocQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

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

  private async isSidecarHeaderFile(filePath: string): Promise<boolean> {
    let fh: FileHandle | null = null;
    try {
      fh = await open(filePath, "r");
      const magicBuf = new Uint8Array(BITFIELD_MAGIC.byteLength);
      const { bytesRead } = await fh.read(
        magicBuf,
        0,
        BITFIELD_MAGIC.byteLength,
        0,
      );
      return bytesRead === BITFIELD_MAGIC.byteLength && hasBitfieldMagic(magicBuf);
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => {});
    }
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

    const activeMetadataPaths = new Set<string>();
    const finalizedPayloadPaths = new Set<string>();
    for (const rec of this.records.values()) {
      if (rec.kind === "receiving") {
        activeMetadataPaths.add(rec.bitfieldPath);
        activeMetadataPaths.add(`${rec.bitfieldPath}.tmp`);
      } else if (rec.kind === "finalized") {
        finalizedPayloadPaths.add(rec.finalPath);
      }
    }

    const entrySet = new Set(entries);
    let total = 0;
    for (const name of entries) {
      const fullPath = join(this.downloadDir, name);
      if (excludePartPath && fullPath === excludePartPath) {
        continue;
      }
      if (activeMetadataPaths.has(fullPath)) {
        continue;
      }

      try {
        const st = await stat(fullPath);
        if (!st.isFile()) {
          continue;
        }

        if (!finalizedPayloadPaths.has(fullPath)) {
          if (
            name.endsWith(".simpleim.bitfield") &&
            st.size >= BITFIELD_HEADER_BYTES &&
            st.size <= MAX_BITFIELD_SIDECAR_BYTES
          ) {
            const stem = name.slice(0, -".simpleim.bitfield".length);
            const adjacentPartName = `${stem}.simpleim.part`;
            const adjacentPartPath = join(this.downloadDir, adjacentPartName);
            if (
              entrySet.has(adjacentPartName) &&
              !finalizedPayloadPaths.has(adjacentPartPath) &&
              (await this.isSidecarHeaderFile(fullPath))
            ) {
              continue;
            }
          } else if (
            name.endsWith(".simpleim.bitfield.tmp") &&
            st.size >= BITFIELD_HEADER_BYTES &&
            st.size <= MAX_BITFIELD_SIDECAR_BYTES
          ) {
            const stem = name.slice(0, -".simpleim.bitfield.tmp".length);
            const adjacentPartName = `${stem}.simpleim.part`;
            const adjacentPartPath = join(this.downloadDir, adjacentPartName);
            if (
              entrySet.has(adjacentPartName) &&
              !finalizedPayloadPaths.has(adjacentPartPath) &&
              (await this.isSidecarHeaderFile(fullPath))
            ) {
              continue;
            }
          }
        }

        total += st.size;
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

  private isOwnedByOtherRecord(
    partPath: string,
    bitfieldPath: string,
    fileId: string,
  ): boolean {
    for (const [id, rec] of this.records.entries()) {
      if (id === fileId) continue;
      if (rec.kind === "receiving") {
        if (
          rec.partPath === partPath ||
          rec.bitfieldPath === bitfieldPath ||
          rec.partPath === bitfieldPath ||
          rec.bitfieldPath === partPath
        ) {
          return true;
        }
      } else if (rec.kind === "finalized") {
        if (rec.finalPath === partPath || rec.finalPath === bitfieldPath) {
          return true;
        }
      }
    }
    return false;
  }

  private async inspectCandidatePair(
    partPath: string,
    bitfieldPath: string,
    manifest: FileManifest,
    expectedBitfieldBytes: number,
  ): Promise<
    | { state: "free" }
    | { state: "resumable"; bitfield: Uint8Array }
    | { state: "collision" }
  > {
    if (this.isOwnedByOtherRecord(partPath, bitfieldPath, manifest.fileId)) {
      return { state: "collision" };
    }

    const [partExists, bfExists, tmpExists] = await Promise.all([
      pathExistsAny(partPath),
      pathExistsAny(bitfieldPath),
      pathExistsAny(`${bitfieldPath}.tmp`),
    ]);

    if (!partExists && !bfExists && !tmpExists) {
      return { state: "free" };
    }

    if (partExists && bfExists) {
      try {
        const [partStat, rawBf] = await Promise.all([
          stat(partPath),
          readFile(bitfieldPath),
        ]);
        if (
          partStat.isFile() &&
          matchesBitfieldHeader(rawBf, manifest) &&
          partStat.size === manifest.fileSize &&
          rawBf.byteLength === BITFIELD_HEADER_BYTES + expectedBitfieldBytes
        ) {
          const bf = rawBf.slice(BITFIELD_HEADER_BYTES);
          maskUnusedTrailingBits(bf, manifest.totalChunks);
          return { state: "resumable", bitfield: bf };
        }
      } catch {
        // Fall through to collision
      }
    }

    return { state: "collision" };
  }

  private async selectReceivingPaths(
    safeName: string,
    manifest: FileManifest,
    expectedBitfieldBytes: number,
  ): Promise<{
    partPath: string;
    bitfieldPath: string;
    resumedBitfield: Uint8Array | null;
  }> {
    const maxBaseBytes = MAX_FILENAME_UTF8_BYTES - LONGEST_PARTIAL_SUFFIX_BYTES; // 233 bytes
    const primaryBase = truncateUtf8ByBytes(safeName, maxBaseBytes);
    const primaryPart = this.resolveSafeChildPath(
      `${primaryBase}.simpleim.part`,
    );
    const primaryBf = this.resolveSafeChildPath(
      `${primaryBase}.simpleim.bitfield`,
    );

    const primaryCheck = await this.inspectCandidatePair(
      primaryPart,
      primaryBf,
      manifest,
      expectedBitfieldBytes,
    );
    if (primaryCheck.state === "free") {
      return {
        partPath: primaryPart,
        bitfieldPath: primaryBf,
        resumedBitfield: null,
      };
    }
    if (primaryCheck.state === "resumable") {
      return {
        partPath: primaryPart,
        bitfieldPath: primaryBf,
        resumedBitfield: primaryCheck.bitfield,
      };
    }

    // Disambiguate using the FULL manifest.fileId (never a truncated prefix!)
    const idSuffix = `.${manifest.fileId}`;
    const idBasePrefix = truncateUtf8ByBytes(
      safeName,
      maxBaseBytes - idSuffix.length,
    );
    const idBase = `${idBasePrefix}${idSuffix}`;
    const idPart = this.resolveSafeChildPath(`${idBase}.simpleim.part`);
    const idBf = this.resolveSafeChildPath(`${idBase}.simpleim.bitfield`);
    const idCheck = await this.inspectCandidatePair(
      idPart,
      idBf,
      manifest,
      expectedBitfieldBytes,
    );
    if (idCheck.state === "free") {
      return { partPath: idPart, bitfieldPath: idBf, resumedBitfield: null };
    }
    if (idCheck.state === "resumable") {
      return {
        partPath: idPart,
        bitfieldPath: idBf,
        resumedBitfield: idCheck.bitfield,
      };
    }

    for (let counter = 1; counter <= 10_000; counter++) {
      const numberedSuffix = `.${manifest.fileId}.${counter}`;
      const numberedPrefix = truncateUtf8ByBytes(
        safeName,
        maxBaseBytes - numberedSuffix.length,
      );
      const numberedBase = `${numberedPrefix}${numberedSuffix}`;
      const partPath = this.resolveSafeChildPath(
        `${numberedBase}.simpleim.part`,
      );
      const bitfieldPath = this.resolveSafeChildPath(
        `${numberedBase}.simpleim.bitfield`,
      );
      const check = await this.inspectCandidatePair(
        partPath,
        bitfieldPath,
        manifest,
        expectedBitfieldBytes,
      );
      if (check.state === "free") {
        return { partPath, bitfieldPath, resumedBitfield: null };
      }
      if (check.state === "resumable") {
        return {
          partPath,
          bitfieldPath,
          resumedBitfield: check.bitfield,
        };
      }
    }

    throw new Error("Unable to allocate non-colliding partial file path");
  }

  async initReceivingFile(
    manifest: FileManifest,
  ): Promise<{ existingBitfield: Uint8Array }> {
    return this.withFsAllocLock(() => this.initReceivingFileLocked(manifest));
  }

  private async initReceivingFileLocked(
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

    const expectedBitfieldBytes = Math.ceil(manifest.totalChunks / 8);
    const { partPath, bitfieldPath, resumedBitfield } =
      await this.selectReceivingPaths(safeName, manifest, expectedBitfieldBytes);

    if (this.maxStorageBytes !== undefined) {
      const currentUsed = await this.getUsedPayloadBytes(partPath);
      if (currentUsed + manifest.fileSize > this.maxStorageBytes) {
        throw new StorageQuotaExceededError(
          `File size (${manifest.fileSize} B) exceeds remaining storage quota (${Math.max(0, this.maxStorageBytes - currentUsed)} B available of ${this.maxStorageBytes} B)`,
        );
      }
    }

    let fileHandle: FileHandle;
    let bitfield: Uint8Array;

    if (resumedBitfield !== null) {
      fileHandle = await open(partPath, "r+");
      bitfield = resumedBitfield;

      // Re-verify resumed on-disk chunks whenever inline chunk hashes are present
      if (manifest.chunkHashes.length === manifest.totalChunks) {
        let clearedAnyCorruptChunk = false;
        try {
          for (let i = 0; i < manifest.totalChunks; i++) {
            if (!hasChunkInBitfield(bitfield, i)) continue;
            const offset = i * SWARM_CHUNK_SIZE;
            const expectedLen = Math.min(
              SWARM_CHUNK_SIZE,
              manifest.fileSize - offset,
            );
            const expectedHash = manifest.chunkHashes[i];
            let valid = false;
            if (expectedHash) {
              try {
                const diskBytes = await readFullAt(
                  fileHandle,
                  expectedLen,
                  offset,
                );
                valid = verifyChunkSha256(diskBytes, expectedHash);
              } catch {
                valid = false;
              }
            }
            if (!valid) {
              clearBitInBitfield(bitfield, i);
              clearedAnyCorruptChunk = true;
            }
          }
          if (clearedAnyCorruptChunk) {
            await writeFile(
              bitfieldPath,
              encodeBitfieldSidecar(manifest, bitfield),
            );
          }
        } catch (err) {
          await fileHandle.close().catch(() => {});
          throw err;
        }
      }
    } else {
      fileHandle = await open(partPath, "w+");
      try {
        await fileHandle.truncate(manifest.fileSize);
        bitfield = createBitfield(manifest.totalChunks);
        await writeFile(
          bitfieldPath,
          encodeBitfieldSidecar(manifest, bitfield),
        );
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

    const sidecarSnapshot = encodeBitfieldSidecar(manifest, rec.bitfield);
    const persistOp = rec.bitfieldWriteChain.then(async () => {
      const tmpBf = `${rec.bitfieldPath}.tmp`;
      await writeFile(tmpBf, sidecarSnapshot);
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

    // Verify whole-file SHA-256 against manifest before finalizing onto disk
    const wholeFileSha256 = await computeFileHandleSha256Hex(
      rec.fileHandle,
      rec.manifest.fileSize,
    );
    if (wholeFileSha256 !== rec.manifest.fileSha256.toLowerCase()) {
      this.records.delete(fileId);
      await rec.fileHandle.close().catch(() => {});
      await rm(rec.partPath, { force: true }).catch(() => {});
      await rm(rec.bitfieldPath, { force: true }).catch(() => {});
      throw new Error(
        `Finalized file SHA-256 mismatch for fileId=${fileId}`,
      );
    }

    await rec.fileHandle.sync();
    await rec.fileHandle.close();

    const finalPath = await this.withFsAllocLock(async () => {
      const dest = await this.pickNonClobberingDestination(rec.safeName);
      await rename(rec.partPath, dest);
      return dest;
    });
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
