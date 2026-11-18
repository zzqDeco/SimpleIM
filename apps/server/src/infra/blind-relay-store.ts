import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_RELAY_MAX_TOTAL_BYTES,
  isValidRelayBoxId,
  MAX_RELAY_CHUNK_CIPHERTEXT_BYTES,
  MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES,
  RELAY_AEAD_OVERHEAD_BYTES,
} from "@simpleim/contracts";
import {
  DomainError,
  type BlindRelayStorePort,
  type ClockPort,
  type ListRelayEnvelopesResult,
  type PutRelayChunkResult,
  type PutRelayEnvelopeResult,
  type StoredRelayEnvelope,
} from "../domain/index.ts";
import { SystemClock } from "./logger.ts";

export const DEFAULT_RELAY_SWEEP_INTERVAL_MS = 60_000;
const MAX_IDLE_BOX_SEQ_ENTRIES = 50_000;

interface EnvelopeIndexEntry {
  readonly kind: "envelope";
  readonly lruKey: string;
  readonly boxId: string;
  readonly blobId: string;
  readonly seq: number;
  readonly byteLength: number;
  readonly expiresAt: number;
  lastAccessedAt: number;
}

interface ChunkIndexEntry {
  readonly kind: "chunk";
  readonly lruKey: string;
  readonly boxId: string;
  readonly fileTag: string;
  readonly chunkBlobId: string;
  readonly byteLength: number;
  readonly expiresAt: number;
  lastAccessedAt: number;
}

type RelayIndexEntry = EnvelopeIndexEntry | ChunkIndexEntry;

export interface BlindRelayStoreBaseOptions {
  readonly maxTotalBytes?: number;
  readonly clock?: ClockPort;
  readonly sweepIntervalMs?: number;
}

abstract class AbstractBlindRelayStore implements BlindRelayStorePort {
  protected readonly maxTotalBytes: number;
  protected readonly clock: ClockPort;
  protected readonly envelopesByBox = new Map<
    string,
    Map<string, EnvelopeIndexEntry>
  >();
  protected readonly chunksByBox = new Map<
    string,
    Map<string, ChunkIndexEntry>
  >();
  protected readonly fileBytesByBoxAndTag = new Map<string, number>();
  protected readonly boxNextSeq = new Map<string, number>();
  protected readonly lruMap = new Map<string, RelayIndexEntry>();
  protected readonly expiryMap = new Map<string, RelayIndexEntry>();

  protected totalBytes = 0;
  protected lastInsertedExpiresAt = 0;
  protected expiryStrictlySorted = true;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: BlindRelayStoreBaseOptions) {
    this.maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_RELAY_MAX_TOTAL_BYTES;
    this.clock = options?.clock ?? new SystemClock();
    const sweepIntervalMs =
      options?.sweepIntervalMs ?? DEFAULT_RELAY_SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.sweepExpired(this.clock.nowMs());
        } catch {
          // Ignore background sweep errors; read/write paths also enforce TTL.
        }
      }, sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  getEntryCount(): number {
    return this.lruMap.size;
  }

  putEnvelope(params: {
    boxId: string;
    blobId: string;
    payload: Uint8Array;
    nowMs: number;
    ttlMs: number;
  }): PutRelayEnvelopeResult {
    const existing = this.envelopesByBox.get(params.boxId)?.get(params.blobId);
    if (existing) {
      if (
        existing.expiresAt > params.nowMs &&
        this.hasEnvelopePayload(existing)
      ) {
        this.touchLru(existing, params.nowMs);
        return {
          seq: existing.seq,
          created: false,
          expiresAt: existing.expiresAt,
        };
      }
      this.removeEntry(existing);
    }

    this.sweepExpired(params.nowMs);

    if (params.payload.byteLength > this.maxTotalBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay envelope exceeds total cache capacity",
        413,
      );
    }

    this.evictLruToFit(params.payload.byteLength);

    const seq = this.peekNextSeq(params.boxId);
    const entry: EnvelopeIndexEntry = {
      kind: "envelope",
      lruKey: `e:${params.boxId}:${params.blobId}`,
      boxId: params.boxId,
      blobId: params.blobId,
      seq,
      byteLength: params.payload.byteLength,
      expiresAt: params.nowMs + params.ttlMs,
      lastAccessedAt: params.nowMs,
    };

    this.writeEnvelopePayload(entry, params.payload);
    this.commitNextSeq(params.boxId, seq + 1);
    this.insertEntry(entry);

    return {
      seq: entry.seq,
      created: true,
      expiresAt: entry.expiresAt,
    };
  }

  listEnvelopes(params: {
    boxId: string;
    afterSeq: number;
    limit: number;
    nowMs: number;
  }): ListRelayEnvelopesResult {
    const boxMap = this.envelopesByBox.get(params.boxId);
    if (!boxMap || boxMap.size === 0) {
      return { items: [], hasMore: false };
    }

    const items: StoredRelayEnvelope[] = [];
    let hasMore = false;

    for (const entry of Array.from(boxMap.values())) {
      if (entry.expiresAt <= params.nowMs) {
        this.removeEntry(entry);
        continue;
      }
      if (entry.seq <= params.afterSeq) {
        continue;
      }
      if (items.length < params.limit) {
        const payload = this.readEnvelopePayload(entry);
        if (payload === null) {
          this.removeEntry(entry);
          continue;
        }
        this.touchLru(entry, params.nowMs);
        items.push({
          seq: entry.seq,
          blobId: entry.blobId,
          payload,
          expiresAt: entry.expiresAt,
        });
      } else {
        if (this.hasEnvelopePayload(entry)) {
          hasMore = true;
          break;
        }
        this.removeEntry(entry);
      }
    }

    return { items, hasMore };
  }

  putChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    payload: Uint8Array;
    nowMs: number;
    ttlMs: number;
    maxFileBytes: number;
  }): PutRelayChunkResult {
    const chunkKey = `${params.fileTag}:${params.chunkBlobId}`;
    const existing = this.chunksByBox.get(params.boxId)?.get(chunkKey);
    if (existing) {
      if (existing.expiresAt > params.nowMs && this.hasChunkPayload(existing)) {
        this.touchLru(existing, params.nowMs);
        return {
          created: false,
          expiresAt: existing.expiresAt,
        };
      }
      this.removeEntry(existing);
    }

    this.sweepExpired(params.nowMs);

    const fileKey = `${params.boxId}:${params.fileTag}`;
    const currentFileBytes = this.fileBytesByBoxAndTag.get(fileKey) ?? 0;
    if (currentFileBytes + params.payload.byteLength > params.maxFileBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay file quota exceeded",
        413,
      );
    }

    if (params.payload.byteLength > this.maxTotalBytes) {
      throw new DomainError(
        "payload_too_large",
        "Relay chunk exceeds total cache capacity",
        413,
      );
    }

    this.evictLruToFit(params.payload.byteLength);

    const entry: ChunkIndexEntry = {
      kind: "chunk",
      lruKey: `c:${params.boxId}:${params.fileTag}:${params.chunkBlobId}`,
      boxId: params.boxId,
      fileTag: params.fileTag,
      chunkBlobId: params.chunkBlobId,
      byteLength: params.payload.byteLength,
      expiresAt: params.nowMs + params.ttlMs,
      lastAccessedAt: params.nowMs,
    };

    this.writeChunkPayload(entry, params.payload);
    this.insertEntry(entry);

    return {
      created: true,
      expiresAt: entry.expiresAt,
    };
  }

  getChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    nowMs: number;
  }): Uint8Array | null {
    const chunkKey = `${params.fileTag}:${params.chunkBlobId}`;
    const entry = this.chunksByBox.get(params.boxId)?.get(chunkKey);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= params.nowMs) {
      this.removeEntry(entry);
      return null;
    }
    const payload = this.readChunkPayload(entry);
    if (payload === null) {
      this.removeEntry(entry);
      return null;
    }
    this.touchLru(entry, params.nowMs);
    return payload;
  }

  sweepExpired(nowMs: number): number {
    let removed = 0;
    if (this.expiryStrictlySorted) {
      while (this.expiryMap.size > 0) {
        const first = this.expiryMap.values().next().value;
        if (!first || first.expiresAt > nowMs) {
          break;
        }
        this.removeEntry(first);
        removed++;
      }
      return removed;
    }

    for (const entry of Array.from(this.expiryMap.values())) {
      if (entry.expiresAt <= nowMs) {
        this.removeEntry(entry);
        removed++;
      }
    }
    return removed;
  }

  close(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  protected evictLruToFit(newBytes: number): void {
    while (
      this.totalBytes + newBytes > this.maxTotalBytes &&
      this.lruMap.size > 0
    ) {
      const oldest = this.lruMap.values().next().value;
      if (!oldest) {
        break;
      }
      this.removeEntry(oldest);
    }
  }

  protected insertEntry(entry: RelayIndexEntry): void {
    if (entry.kind === "envelope") {
      let boxMap = this.envelopesByBox.get(entry.boxId);
      if (!boxMap) {
        boxMap = new Map<string, EnvelopeIndexEntry>();
        this.envelopesByBox.set(entry.boxId, boxMap);
      }
      boxMap.set(entry.blobId, entry);
    } else {
      let boxMap = this.chunksByBox.get(entry.boxId);
      if (!boxMap) {
        boxMap = new Map<string, ChunkIndexEntry>();
        this.chunksByBox.set(entry.boxId, boxMap);
      }
      boxMap.set(`${entry.fileTag}:${entry.chunkBlobId}`, entry);
      const fileKey = `${entry.boxId}:${entry.fileTag}`;
      this.fileBytesByBoxAndTag.set(
        fileKey,
        (this.fileBytesByBoxAndTag.get(fileKey) ?? 0) + entry.byteLength,
      );
    }

    this.lruMap.set(entry.lruKey, entry);
    if (entry.expiresAt < this.lastInsertedExpiresAt) {
      this.expiryStrictlySorted = false;
    } else {
      this.lastInsertedExpiresAt = entry.expiresAt;
    }
    this.expiryMap.set(entry.lruKey, entry);
    this.totalBytes += entry.byteLength;
  }

  protected removeEntry(entry: RelayIndexEntry): void {
    if (!this.lruMap.delete(entry.lruKey)) {
      return;
    }
    this.expiryMap.delete(entry.lruKey);
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteLength);

    if (entry.kind === "envelope") {
      const boxMap = this.envelopesByBox.get(entry.boxId);
      let boxEmpty = true;
      if (boxMap) {
        boxMap.delete(entry.blobId);
        if (boxMap.size === 0) {
          this.envelopesByBox.delete(entry.boxId);
        } else {
          boxEmpty = false;
        }
      }
      this.deleteEnvelopePayload(entry, boxEmpty);
    } else {
      const boxMap = this.chunksByBox.get(entry.boxId);
      let boxEmpty = true;
      if (boxMap) {
        boxMap.delete(`${entry.fileTag}:${entry.chunkBlobId}`);
        if (boxMap.size === 0) {
          this.chunksByBox.delete(entry.boxId);
        } else {
          boxEmpty = false;
        }
      }
      const fileKey = `${entry.boxId}:${entry.fileTag}`;
      const remaining =
        (this.fileBytesByBoxAndTag.get(fileKey) ?? 0) - entry.byteLength;
      if (remaining <= 0) {
        this.fileBytesByBoxAndTag.delete(fileKey);
      } else {
        this.fileBytesByBoxAndTag.set(fileKey, remaining);
      }
      this.deleteChunkPayload(entry, boxEmpty);
    }
  }

  protected touchLru(entry: RelayIndexEntry, nowMs: number): void {
    if (!this.lruMap.has(entry.lruKey)) {
      return;
    }
    entry.lastAccessedAt = nowMs;
    this.lruMap.delete(entry.lruKey);
    this.lruMap.set(entry.lruKey, entry);
    this.onEntryTouched(entry, nowMs);
  }

  private peekNextSeq(boxId: string): number {
    return this.boxNextSeq.get(boxId) ?? 1;
  }

  private commitNextSeq(boxId: string, nextSeq: number): void {
    this.boxNextSeq.delete(boxId);
    this.boxNextSeq.set(boxId, nextSeq);
    if (this.boxNextSeq.size > MAX_IDLE_BOX_SEQ_ENTRIES) {
      for (const candidateBoxId of this.boxNextSeq.keys()) {
        if (!this.envelopesByBox.has(candidateBoxId)) {
          this.boxNextSeq.delete(candidateBoxId);
          if (this.boxNextSeq.size <= MAX_IDLE_BOX_SEQ_ENTRIES) {
            break;
          }
        }
      }
    }
  }

  protected seedNextSeq(boxId: string, nextSeq: number): void {
    const existing = this.boxNextSeq.get(boxId) ?? 1;
    if (nextSeq > existing) {
      this.boxNextSeq.set(boxId, nextSeq);
    }
  }

  protected onEntryTouched(_entry: RelayIndexEntry, _nowMs: number): void {
    // Optional hook for subclasses.
  }

  protected hasEnvelopePayload(_entry: EnvelopeIndexEntry): boolean {
    return true;
  }

  protected hasChunkPayload(_entry: ChunkIndexEntry): boolean {
    return true;
  }

  protected abstract writeEnvelopePayload(
    entry: EnvelopeIndexEntry,
    payload: Uint8Array,
  ): void;

  protected abstract readEnvelopePayload(
    entry: EnvelopeIndexEntry,
  ): Uint8Array | null;

  protected abstract deleteEnvelopePayload(
    entry: EnvelopeIndexEntry,
    boxEmpty: boolean,
  ): void;

  protected abstract writeChunkPayload(
    entry: ChunkIndexEntry,
    payload: Uint8Array,
  ): void;

  protected abstract readChunkPayload(
    entry: ChunkIndexEntry,
  ): Uint8Array | null;

  protected abstract deleteChunkPayload(
    entry: ChunkIndexEntry,
    boxEmpty: boolean,
  ): void;
}

export class InMemoryBlindRelayStore extends AbstractBlindRelayStore {
  private readonly blobs = new Map<string, Uint8Array>();

  protected override hasEnvelopePayload(entry: EnvelopeIndexEntry): boolean {
    return this.blobs.has(entry.lruKey);
  }

  protected override hasChunkPayload(entry: ChunkIndexEntry): boolean {
    return this.blobs.has(entry.lruKey);
  }

  protected override writeEnvelopePayload(
    entry: EnvelopeIndexEntry,
    payload: Uint8Array,
  ): void {
    this.blobs.set(entry.lruKey, new Uint8Array(payload));
  }

  protected override readEnvelopePayload(
    entry: EnvelopeIndexEntry,
  ): Uint8Array | null {
    const stored = this.blobs.get(entry.lruKey);
    return stored ? new Uint8Array(stored) : null;
  }

  protected override deleteEnvelopePayload(entry: EnvelopeIndexEntry): void {
    this.blobs.delete(entry.lruKey);
  }

  protected override writeChunkPayload(
    entry: ChunkIndexEntry,
    payload: Uint8Array,
  ): void {
    this.blobs.set(entry.lruKey, new Uint8Array(payload));
  }

  protected override readChunkPayload(
    entry: ChunkIndexEntry,
  ): Uint8Array | null {
    const stored = this.blobs.get(entry.lruKey);
    return stored ? new Uint8Array(stored) : null;
  }

  protected override deleteChunkPayload(entry: ChunkIndexEntry): void {
    this.blobs.delete(entry.lruKey);
  }

  override close(): void {
    super.close();
    this.blobs.clear();
  }
}

export interface FsBlindRelayStoreOptions extends BlindRelayStoreBaseOptions {
  readonly cacheDir: string;
}

const ENVELOPE_FILE_RE = /^(\d+)_([0-9a-f]{32})_(\d+)\.bin$/;
const CHUNK_FILE_RE = /^([0-9a-f]{32})_([0-9a-f]{32})_(\d+)\.bin$/;
const HEX_PREFIX_RE = /^[0-9a-f]{2}$/;

export class FsBlindRelayStore extends AbstractBlindRelayStore {
  private readonly cacheDir: string;
  private readonly envelopesRoot: string;
  private readonly chunksRoot: string;
  private tmpCounter = 0;

  constructor(options: FsBlindRelayStoreOptions) {
    super(options);
    this.cacheDir = options.cacheDir;
    this.envelopesRoot = join(this.cacheDir, "v1", "envelopes");
    this.chunksRoot = join(this.cacheDir, "v1", "chunks");
    this.initializeFromDisk(this.clock.nowMs());
  }

  protected override hasEnvelopePayload(entry: EnvelopeIndexEntry): boolean {
    return existsSync(this.envelopeFilePath(entry));
  }

  protected override hasChunkPayload(entry: ChunkIndexEntry): boolean {
    return existsSync(this.chunkFilePath(entry));
  }

  protected override writeEnvelopePayload(
    entry: EnvelopeIndexEntry,
    payload: Uint8Array,
  ): void {
    this.atomicWriteFile(
      this.envelopeFilePath(entry),
      payload,
      entry.lastAccessedAt,
    );
  }

  protected override readEnvelopePayload(
    entry: EnvelopeIndexEntry,
  ): Uint8Array | null {
    return safeReadBytes(this.envelopeFilePath(entry));
  }

  protected override deleteEnvelopePayload(
    entry: EnvelopeIndexEntry,
    boxEmpty: boolean,
  ): void {
    const filePath = this.envelopeFilePath(entry);
    safeUnlink(filePath);
    if (boxEmpty) {
      const boxDir = dirname(filePath);
      safeRmdir(boxDir);
      safeRmdir(dirname(boxDir));
    }
  }

  protected override writeChunkPayload(
    entry: ChunkIndexEntry,
    payload: Uint8Array,
  ): void {
    this.atomicWriteFile(
      this.chunkFilePath(entry),
      payload,
      entry.lastAccessedAt,
    );
  }

  protected override readChunkPayload(
    entry: ChunkIndexEntry,
  ): Uint8Array | null {
    return safeReadBytes(this.chunkFilePath(entry));
  }

  protected override deleteChunkPayload(
    entry: ChunkIndexEntry,
    boxEmpty: boolean,
  ): void {
    const filePath = this.chunkFilePath(entry);
    safeUnlink(filePath);
    if (boxEmpty) {
      const boxDir = dirname(filePath);
      safeRmdir(boxDir);
      safeRmdir(dirname(boxDir));
    }
  }

  protected override onEntryTouched(
    entry: RelayIndexEntry,
    nowMs: number,
  ): void {
    const filePath =
      entry.kind === "envelope"
        ? this.envelopeFilePath(entry)
        : this.chunkFilePath(entry);
    const sec = nowMs / 1000;
    try {
      utimesSync(filePath, sec, sec);
    } catch {
      // Best-effort mtime touch for restart LRU ordering.
    }
  }

  private envelopeFilePath(entry: EnvelopeIndexEntry): string {
    return join(
      this.envelopesRoot,
      entry.boxId.slice(0, 2),
      entry.boxId,
      `${entry.seq}_${entry.blobId}_${entry.expiresAt}.bin`,
    );
  }

  private chunkFilePath(entry: ChunkIndexEntry): string {
    return join(
      this.chunksRoot,
      entry.boxId.slice(0, 2),
      entry.boxId,
      `${entry.fileTag}_${entry.chunkBlobId}_${entry.expiresAt}.bin`,
    );
  }

  private atomicWriteFile(
    finalPath: string,
    payload: Uint8Array,
    nowMs: number,
  ): void {
    const parentDir = dirname(finalPath);
    mkdirSync(parentDir, { recursive: true });
    const tmpPath = `${finalPath}.${process.pid}.${++this.tmpCounter}.tmp`;
    try {
      writeFileSync(tmpPath, payload);
      const sec = nowMs / 1000;
      try {
        utimesSync(tmpPath, sec, sec);
      } catch {
        // Ignore if filesystem does not support utimes.
      }
      renameSync(tmpPath, finalPath);
    } catch (err) {
      safeUnlink(tmpPath);
      throw err;
    }
  }

  private initializeFromDisk(nowMs: number): void {
    mkdirSync(this.envelopesRoot, { recursive: true });
    mkdirSync(this.chunksRoot, { recursive: true });

    // Remove any orphan .tmp files anywhere under cacheDir.
    this.purgeTmpFilesRecursively(this.cacheDir);

    const loadedEnvelopes = new Map<string, EnvelopeIndexEntry>();
    const loadedChunks = new Map<string, ChunkIndexEntry>();

    this.scanEnvelopesRoot(nowMs, loadedEnvelopes);
    this.scanChunksRoot(nowMs, loadedChunks);

    const allEntries: RelayIndexEntry[] = [
      ...loadedEnvelopes.values(),
      ...loadedChunks.values(),
    ];

    // Insert envelopes per box sorted by seq ASC so listEnvelopes iterates in seq order.
    const envelopesSortedBySeq = Array.from(loadedEnvelopes.values()).sort(
      (a, b) => a.seq - b.seq,
    );
    for (const env of envelopesSortedBySeq) {
      let boxMap = this.envelopesByBox.get(env.boxId);
      if (!boxMap) {
        boxMap = new Map<string, EnvelopeIndexEntry>();
        this.envelopesByBox.set(env.boxId, boxMap);
      }
      boxMap.set(env.blobId, env);
    }

    for (const chunk of loadedChunks.values()) {
      let boxMap = this.chunksByBox.get(chunk.boxId);
      if (!boxMap) {
        boxMap = new Map<string, ChunkIndexEntry>();
        this.chunksByBox.set(chunk.boxId, boxMap);
      }
      boxMap.set(`${chunk.fileTag}:${chunk.chunkBlobId}`, chunk);
      const fileKey = `${chunk.boxId}:${chunk.fileTag}`;
      this.fileBytesByBoxAndTag.set(
        fileKey,
        (this.fileBytesByBoxAndTag.get(fileKey) ?? 0) + chunk.byteLength,
      );
    }

    // Populate lruMap ordered by lastAccessedAt ASC.
    const sortedByAccess = [...allEntries].sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt,
    );
    for (const entry of sortedByAccess) {
      this.lruMap.set(entry.lruKey, entry);
      this.totalBytes += entry.byteLength;
    }

    // Populate expiryMap ordered by expiresAt ASC.
    const sortedByExpiry = [...allEntries].sort(
      (a, b) => a.expiresAt - b.expiresAt,
    );
    this.expiryStrictlySorted = true;
    this.lastInsertedExpiresAt = 0;
    for (const entry of sortedByExpiry) {
      this.expiryMap.set(entry.lruKey, entry);
      this.lastInsertedExpiresAt = entry.expiresAt;
    }

    // Trim cache if persisted bytes exceed current configured maxTotalBytes.
    this.evictLruToFit(0);
  }

  private purgeTmpFilesRecursively(dirPath: string): void {
    if (!existsSync(dirPath)) {
      return;
    }
    for (const name of safeReaddir(dirPath)) {
      const fullPath = join(dirPath, name);
      if (name.endsWith(".tmp")) {
        safeUnlink(fullPath);
        continue;
      }
      const st = safeStat(fullPath);
      if (st?.isDirectory()) {
        this.purgeTmpFilesRecursively(fullPath);
      }
    }
  }

  private scanEnvelopesRoot(
    nowMs: number,
    loaded: Map<string, EnvelopeIndexEntry>,
  ): void {
    for (const prefix of safeReaddir(this.envelopesRoot)) {
      const prefixDir = join(this.envelopesRoot, prefix);
      if (prefix.endsWith(".tmp")) {
        safeUnlink(prefixDir);
        continue;
      }
      if (!HEX_PREFIX_RE.test(prefix)) {
        continue;
      }

      for (const boxId of safeReaddir(prefixDir)) {
        const boxDir = join(prefixDir, boxId);
        if (boxId.endsWith(".tmp")) {
          safeUnlink(boxDir);
          continue;
        }
        if (!isValidRelayBoxId(boxId) || boxId.slice(0, 2) !== prefix) {
          continue;
        }

        for (const fileName of safeReaddir(boxDir)) {
          const fullPath = join(boxDir, fileName);
          if (fileName.endsWith(".tmp")) {
            safeUnlink(fullPath);
            continue;
          }

          const match = ENVELOPE_FILE_RE.exec(fileName);
          if (!match) {
            safeUnlink(fullPath);
            continue;
          }

          const seq = Number(match[1]);
          const blobId = match[2]!;
          const expiresAt = Number(match[3]);
          if (
            !Number.isSafeInteger(seq) ||
            seq < 1 ||
            !Number.isSafeInteger(expiresAt)
          ) {
            safeUnlink(fullPath);
            continue;
          }

          this.seedNextSeq(boxId, seq + 1);

          const st = safeStat(fullPath);
          if (
            !st ||
            !st.isFile() ||
            expiresAt <= nowMs ||
            st.size < RELAY_AEAD_OVERHEAD_BYTES ||
            st.size > MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES
          ) {
            safeUnlink(fullPath);
            continue;
          }

          const entry: EnvelopeIndexEntry = {
            kind: "envelope",
            lruKey: `e:${boxId}:${blobId}`,
            boxId,
            blobId,
            seq,
            byteLength: st.size,
            expiresAt,
            lastAccessedAt: Math.round(st.mtimeMs),
          };

          const dup = loaded.get(entry.lruKey);
          if (dup) {
            if (entry.seq >= dup.seq) {
              safeUnlink(this.envelopeFilePath(dup));
              loaded.set(entry.lruKey, entry);
            } else {
              safeUnlink(fullPath);
            }
          } else {
            loaded.set(entry.lruKey, entry);
          }
        }

        safeRmdir(boxDir);
      }

      safeRmdir(prefixDir);
    }
  }

  private scanChunksRoot(
    nowMs: number,
    loaded: Map<string, ChunkIndexEntry>,
  ): void {
    for (const prefix of safeReaddir(this.chunksRoot)) {
      const prefixDir = join(this.chunksRoot, prefix);
      if (prefix.endsWith(".tmp")) {
        safeUnlink(prefixDir);
        continue;
      }
      if (!HEX_PREFIX_RE.test(prefix)) {
        continue;
      }

      for (const boxId of safeReaddir(prefixDir)) {
        const boxDir = join(prefixDir, boxId);
        if (boxId.endsWith(".tmp")) {
          safeUnlink(boxDir);
          continue;
        }
        if (!isValidRelayBoxId(boxId) || boxId.slice(0, 2) !== prefix) {
          continue;
        }

        for (const fileName of safeReaddir(boxDir)) {
          const fullPath = join(boxDir, fileName);
          if (fileName.endsWith(".tmp")) {
            safeUnlink(fullPath);
            continue;
          }

          const match = CHUNK_FILE_RE.exec(fileName);
          if (!match) {
            safeUnlink(fullPath);
            continue;
          }

          const fileTag = match[1]!;
          const chunkBlobId = match[2]!;
          const expiresAt = Number(match[3]);
          if (!Number.isSafeInteger(expiresAt)) {
            safeUnlink(fullPath);
            continue;
          }

          const st = safeStat(fullPath);
          if (
            !st ||
            !st.isFile() ||
            expiresAt <= nowMs ||
            st.size < RELAY_AEAD_OVERHEAD_BYTES ||
            st.size > MAX_RELAY_CHUNK_CIPHERTEXT_BYTES
          ) {
            safeUnlink(fullPath);
            continue;
          }

          const entry: ChunkIndexEntry = {
            kind: "chunk",
            lruKey: `c:${boxId}:${fileTag}:${chunkBlobId}`,
            boxId,
            fileTag,
            chunkBlobId,
            byteLength: st.size,
            expiresAt,
            lastAccessedAt: Math.round(st.mtimeMs),
          };

          const dup = loaded.get(entry.lruKey);
          if (dup) {
            if (entry.expiresAt >= dup.expiresAt) {
              safeUnlink(this.chunkFilePath(dup));
              loaded.set(entry.lruKey, entry);
            } else {
              safeUnlink(fullPath);
            }
          } else {
            loaded.set(entry.lruKey, entry);
          }
        }

        safeRmdir(boxDir);
      }

      safeRmdir(prefixDir);
    }
  }
}

function safeReaddir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeStat(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadBytes(filePath: string): Uint8Array | null {
  try {
    const buf = readFileSync(filePath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore missing file errors.
  }
}

function safeRmdir(dirPath: string): void {
  try {
    rmdirSync(dirPath);
  } catch {
    // Ignore non-empty or missing directory errors.
  }
}
