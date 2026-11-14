import {
  countChunksInBitfield,
  createBitfield,
  decodeSwarmFrame,
  encodeSwarmFrame,
  hasChunkInBitfield,
  MAX_POISON_STRIKES,
  MAX_SYNC_MESSAGES,
  setChunkInBitfield,
  SWARM_BUFFERED_LOW_THRESHOLD,
  SWARM_CHUNK_SIZE,
  SWARM_HASH_PAGE_CHUNKS,
  SWARM_MAX_BUFFERED_AMOUNT,
  SwarmFrameType,
  type FileManifest,
  type PeerIdentityCert,
  type PostAuthControlFrame,
} from "@simpleim/contracts";
import {
  createSignedFileManifestWithPages,
  verifyChunkSha256,
  verifyFileManifest,
  verifyHashPage,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import type {
  ChunkStoragePort,
  DataChannelPort,
  RoomPeerEngineEvents,
  ShareFileInput,
  SwarmTransferProgress,
  TransferStatus,
} from "./ports.ts";

const DEFAULT_MAX_IN_FLIGHT_PER_PEER = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const SPEED_WINDOW_MS = 3_000;
const MAX_QUEUED_OUTBOUND_CHUNKS_PER_PEER = 4_096;
const MAX_PRE_MANIFEST_FILES_PER_PEER = 512;
const MAX_PRE_MANIFEST_HAVES_PER_FILE = 4_096;
const MAX_RAW_BITFIELD_BYTES = 16_384;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface VerifiedSwarmPeerLink {
  readonly peerId: string;
  getRttMs(): number | null;
  readonly swarmChannel: DataChannelPort;
  isVerified(): boolean;
}

export interface SwarmSchedulerOptions {
  roomId: string;
  localPeerId: string;
  localCert: PeerIdentityCert;
  localSignKeyPair: Ed25519KeyPair;
  serverSignPubKey: string;
  chunkStorage: ChunkStoragePort;
  initialFiles?: readonly FileManifest[];
  maxInFlightPerPeer?: number;
  requestTimeoutMs?: number;
  now: () => number;
  events?: RoomPeerEngineEvents;
  broadcastControlFrame: (frame: PostAuthControlFrame) => void;
  sendControlFrameToPeer?: (peerId: string, frame: PostAuthControlFrame) => void;
  evictPeer: (peerId: string, reason: string) => void;
}

interface InFlightChunkRequest {
  fileId: string;
  chunkIndex: number;
  peerId: string;
  requestedAt: number;
  timer: TimerHandle;
}

interface SwarmFileEntry {
  manifest: FileManifest;
  status: TransferStatus;
  errorMessage?: string;
  localBitfield: Uint8Array;
  completedChunks: number;
  bytesCompleted: number;
  writingChunks: Set<number>;
  chunkInFlightPeers: Map<number, Set<string>>;
  resolvedChunkHashes: Array<string | undefined>;
  verifiedHashPages: Map<number, string[]>;
  requestedHashPages: Map<number, { peerId: string; requestedAt: number }>;
  failedHashPagePeers: Map<number, Set<string>>;
  downloadGen: number;
  activeDownloadGen: number | null;
  storageOwnerGen: number | null;
  initDownloadPromise: Promise<void> | null;
  pendingStorageOps: Set<Promise<unknown>>;
  finalizing: boolean;
  downloadStartedAt: number | null;
  speedSamples: Array<{ ts: number; bytes: number }>;
  lastSpeedBytesPerSec: number;
  peerTieSeed: number;
}

interface SwarmPeerEntry {
  link: VerifiedSwarmPeerLink;
  bitfields: Map<string, Uint8Array>;
  zeroChunkSeededFiles: Set<string>;
  earlyRawBitfields: Map<string, Uint8Array>;
  earlyHaves: Map<string, Set<number>>;
  inFlightRequests: Map<string, InFlightChunkRequest>;
  pendingStorageWrites: number;
  outboundChunkQueue: Array<{ fileId: string; chunkIndex: number }>;
  outboundChunkKeys: Set<string>;
  currentReadingKey: string | null;
  cancelledReadingKeys: Set<string>;
  drainingOutbound: boolean;
  needsRedrain: boolean;
  poisonStrikes: number;
  timeoutStrikes: number;
  chunkCooldownUntil: Map<string, number>;
  initialBitfieldsSent: boolean;
}

export function expectedChunkByteLength(
  manifest: FileManifest,
  chunkIndex: number,
): number {
  if (
    manifest.fileSize === 0 ||
    chunkIndex < 0 ||
    chunkIndex >= manifest.totalChunks
  ) {
    return 0;
  }
  const offset = chunkIndex * manifest.chunkSize;
  return Math.min(manifest.chunkSize, manifest.fileSize - offset);
}

function fnv1aHash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function chunkTieHash(seed: number, chunkIndex: number): number {
  let h = (seed ^ chunkIndex) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export class SwarmScheduler {
  private readonly roomId: string;
  private readonly localPeerId: string;
  private localCert: PeerIdentityCert;
  private readonly localSignKeyPair: Ed25519KeyPair;
  private readonly serverSignPubKey: string;
  private readonly chunkStorage: ChunkStoragePort;
  private readonly maxInFlightPerPeer: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly events?: RoomPeerEngineEvents;
  private readonly broadcastControlFrame: (frame: PostAuthControlFrame) => void;
  private readonly sendControlFrameToPeer: (
    peerId: string,
    frame: PostAuthControlFrame,
  ) => void;
  private readonly evictPeer: (peerId: string, reason: string) => void;

  private readonly files = new Map<string, SwarmFileEntry>();
  private readonly fileOrder: string[] = [];
  private readonly peers = new Map<string, SwarmPeerEntry>();
  private readonly hashPageRetryTimers = new Set<TimerHandle>();
  private stopped = false;

  constructor(options: SwarmSchedulerOptions) {
    this.roomId = options.roomId;
    this.localPeerId = options.localPeerId;
    this.localCert = options.localCert;
    this.localSignKeyPair = options.localSignKeyPair;
    this.serverSignPubKey = options.serverSignPubKey;
    this.chunkStorage = options.chunkStorage;
    this.maxInFlightPerPeer =
      options.maxInFlightPerPeer ?? DEFAULT_MAX_IN_FLIGHT_PER_PEER;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now;
    this.events = options.events;
    this.broadcastControlFrame = options.broadcastControlFrame;
    this.sendControlFrameToPeer = options.sendControlFrameToPeer ?? (() => {});
    this.evictPeer = options.evictPeer;

    if (options.initialFiles) {
      for (const manifest of options.initialFiles) {
        this.insertVerifiedManifest(manifest, false);
      }
    }
  }

  updateLocalCert(nextCert: PeerIdentityCert): void {
    this.localCert = nextCert;
  }

  async shareFile(input: ShareFileInput): Promise<FileManifest> {
    if (this.stopped) {
      throw new Error("RoomPeerEngine is stopped");
    }
    const { manifest, chunkHashPages } = await createSignedFileManifestWithPages({
      roomId: this.roomId,
      fileName: input.fileName,
      fileSize: input.fileSize,
      mimeType: input.mimeType,
      readChunk: input.readChunk,
      senderCert: this.localCert,
      peerSignPrivKey: this.localSignKeyPair.privateKeyBytes,
    });

    await this.chunkStorage.registerSeedingFile({
      manifest,
      readLocalChunk: input.readChunk,
    });

    const localBitfield = createBitfield(manifest.totalChunks);
    for (let i = 0; i < manifest.totalChunks; i++) {
      setChunkInBitfield(localBitfield, i);
    }

    const resolvedChunkHashes: Array<string | undefined> = chunkHashPages.flat();
    const verifiedHashPages = new Map<number, string[]>(
      chunkHashPages.map((page, idx) => [idx, page]),
    );

    let entry = this.files.get(manifest.fileId);
    if (!entry) {
      entry = {
        manifest,
        status: "seeding",
        localBitfield,
        completedChunks: manifest.totalChunks,
        bytesCompleted: manifest.fileSize,
        writingChunks: new Set(),
        chunkInFlightPeers: new Map(),
        resolvedChunkHashes,
        verifiedHashPages,
        requestedHashPages: new Map(),
        failedHashPagePeers: new Map(),
        downloadGen: 1,
        activeDownloadGen: null,
        storageOwnerGen: 1,
        initDownloadPromise: null,
        pendingStorageOps: new Set(),
        finalizing: false,
        downloadStartedAt: null,
        speedSamples: [],
        lastSpeedBytesPerSec: 0,
        peerTieSeed: fnv1aHash32(`${this.localPeerId}:${manifest.fileId}`),
      };
      this.files.set(manifest.fileId, entry);
      this.fileOrder.push(manifest.fileId);
    } else {
      const gen = (entry.downloadGen += 1);
      entry.activeDownloadGen = null;
      entry.storageOwnerGen = gen;
      entry.initDownloadPromise = null;
      entry.status = "seeding";
      entry.localBitfield = localBitfield;
      entry.completedChunks = manifest.totalChunks;
      entry.bytesCompleted = manifest.fileSize;
      entry.resolvedChunkHashes = resolvedChunkHashes;
      entry.verifiedHashPages = verifiedHashPages;
      entry.requestedHashPages.clear();
      entry.failedHashPagePeers.clear();
      entry.errorMessage = undefined;
    }

    this.applyEarlyPeerBitfieldsForFile(entry);
    this.emitProgress(entry);

    this.broadcastControlFrame({
      type: "file.announce",
      manifest,
    });
    this.broadcastBitfieldForFile(entry);

    return manifest;
  }

  ingestFileManifest(manifest: FileManifest, _sourcePeerId?: string): boolean {
    return this.insertVerifiedManifest(manifest, true);
  }

  private insertVerifiedManifest(
    manifest: FileManifest,
    emitAnnouncement: boolean,
  ): boolean {
    if (!verifyFileManifest(manifest, this.serverSignPubKey, this.roomId)) {
      return false;
    }
    if (this.files.has(manifest.fileId)) {
      return false;
    }

    const isPaged = manifest.hashPageHashes !== undefined;
    const resolvedChunkHashes: Array<string | undefined> = isPaged
      ? new Array<string | undefined>(manifest.totalChunks)
      : [...manifest.chunkHashes];
    const verifiedHashPages = new Map<number, string[]>();
    if (!isPaged && manifest.totalChunks > 0) {
      verifiedHashPages.set(0, [...manifest.chunkHashes]);
    }

    const entry: SwarmFileEntry = {
      manifest,
      status: "announced",
      localBitfield: createBitfield(manifest.totalChunks),
      completedChunks: 0,
      bytesCompleted: 0,
      writingChunks: new Set(),
      chunkInFlightPeers: new Map(),
      resolvedChunkHashes,
      verifiedHashPages,
      requestedHashPages: new Map(),
      failedHashPagePeers: new Map(),
      downloadGen: 0,
      activeDownloadGen: null,
      storageOwnerGen: null,
      initDownloadPromise: null,
      pendingStorageOps: new Set(),
      finalizing: false,
      downloadStartedAt: null,
      speedSamples: [],
      lastSpeedBytesPerSec: 0,
      peerTieSeed: fnv1aHash32(`${this.localPeerId}:${manifest.fileId}`),
    };
    this.files.set(manifest.fileId, entry);
    this.fileOrder.push(manifest.fileId);
    this.applyEarlyPeerBitfieldsForFile(entry);

    if (emitAnnouncement) {
      this.events?.onFileAnnounced?.(manifest);
    }
    return true;
  }

  handleHashPageRequestFrame(
    fromPeerId: string,
    fileId: string,
    pageIndices: readonly number[],
  ): void {
    if (this.stopped) return;
    const peer = this.peers.get(fromPeerId);
    if (!peer || !peer.link.isVerified()) return;
    const entry = this.files.get(fileId);
    if (!entry) return;

    for (const pageIndex of pageIndices) {
      const pageHashes = entry.verifiedHashPages.get(pageIndex);
      if (pageHashes && pageHashes.length > 0) {
        this.sendControlFrameToPeer(fromPeerId, {
          type: "file.hash_page",
          fileId,
          pageIndex,
          chunkHashes: pageHashes,
        });
      }
    }
  }

  handleHashPageFrame(
    fromPeerId: string,
    fileId: string,
    pageIndex: number,
    chunkHashes: readonly string[],
  ): void {
    if (this.stopped) return;
    const peer = this.peers.get(fromPeerId);
    if (!peer || !peer.link.isVerified()) return;
    const entry = this.files.get(fileId);
    if (!entry || !entry.manifest.hashPageHashes) return;

    const expectedDigest = entry.manifest.hashPageHashes[pageIndex];
    const startChunk = pageIndex * SWARM_HASH_PAGE_CHUNKS;
    const expectedLen = Math.min(
      SWARM_HASH_PAGE_CHUNKS,
      Math.max(0, entry.manifest.totalChunks - startChunk),
    );
    const valid =
      expectedDigest !== undefined &&
      expectedLen > 0 &&
      chunkHashes.length === expectedLen &&
      verifyHashPage(fileId, pageIndex, chunkHashes, expectedDigest);

    if (!valid) {
      entry.requestedHashPages.delete(pageIndex);
      this.recordFailedHashPagePeer(entry, pageIndex, fromPeerId);
      peer.poisonStrikes += 1;
      if (peer.poisonStrikes >= MAX_POISON_STRIKES) {
        this.evictPeer(fromPeerId, "hash_page_mismatch");
      } else {
        this.scheduleDownloads();
      }
      return;
    }

    entry.requestedHashPages.delete(pageIndex);
    entry.failedHashPagePeers.delete(pageIndex);
    if (!entry.verifiedHashPages.has(pageIndex)) {
      entry.verifiedHashPages.set(pageIndex, [...chunkHashes]);
      for (let i = 0; i < chunkHashes.length; i++) {
        entry.resolvedChunkHashes[startChunk + i] = chunkHashes[i];
      }
    }
    if (entry.status === "downloading") {
      this.scheduleDownloads();
    }
  }

  private runTrackedStorageOp<T>(
    entry: SwarmFileEntry,
    fn: () => Promise<T>,
  ): Promise<T> {
    const p = fn();
    const settled = p.then(
      () => undefined,
      () => undefined,
    );
    entry.pendingStorageOps.add(settled);
    void settled.finally(() => {
      entry.pendingStorageOps.delete(settled);
    });
    return p;
  }

  private async deleteStaleStorageIfOwned(
    entry: SwarmFileEntry,
    staleGen: number,
  ): Promise<void> {
    if (
      this.stopped ||
      (entry.storageOwnerGen !== null && entry.storageOwnerGen !== staleGen)
    ) {
      return;
    }
    if (entry.storageOwnerGen === staleGen) {
      entry.storageOwnerGen = null;
    }
    await this.runTrackedStorageOp(entry, () =>
      this.chunkStorage.deleteFile(entry.manifest.fileId).catch(() => undefined),
    );
  }

  private recordFailedHashPagePeer(
    entry: SwarmFileEntry,
    pageIndex: number,
    peerId: string,
  ): Set<string> {
    let failed = entry.failedHashPagePeers.get(pageIndex);
    if (!failed) {
      failed = new Set();
      entry.failedHashPagePeers.set(pageIndex, failed);
    }
    failed.add(peerId);
    return failed;
  }

  async downloadFile(fileId: string): Promise<void> {
    if (this.stopped) {
      throw new Error("RoomPeerEngine is stopped");
    }
    const entry = this.files.get(fileId);
    if (!entry) {
      throw new Error(`Unknown fileId: ${fileId}`);
    }
    if (entry.status === "seeding") {
      return;
    }
    if (entry.status === "downloading") {
      this.scheduleDownloads();
      return;
    }
    if (entry.initDownloadPromise !== null) {
      return entry.initDownloadPromise;
    }

    const gen = (entry.downloadGen += 1);
    entry.activeDownloadGen = gen;
    const initPromise = this.performDownloadInit(entry, gen).finally(() => {
      if (entry.initDownloadPromise === initPromise) {
        entry.initDownloadPromise = null;
      }
    });
    entry.initDownloadPromise = initPromise;
    return initPromise;
  }

  private async performDownloadInit(
    entry: SwarmFileEntry,
    gen: number,
  ): Promise<void> {
    const fileId = entry.manifest.fileId;

    // Wait for any in-flight storage operations from cancelled/obsolete attempts
    // to settle before initializing storage for the new generation.
    while (entry.pendingStorageOps.size > 0) {
      await Promise.allSettled(Array.from(entry.pendingStorageOps));
      if (this.stopped || entry.downloadGen !== gen) {
        return;
      }
    }
    if (this.stopped || entry.downloadGen !== gen) {
      return;
    }

    entry.storageOwnerGen = gen;
    let existingBitfield: Uint8Array;
    try {
      const res = await this.runTrackedStorageOp(entry, () =>
        this.chunkStorage.initReceivingFile(entry.manifest),
      );
      existingBitfield = res.existingBitfield;
    } catch (err) {
      if (entry.activeDownloadGen === gen) {
        entry.activeDownloadGen = null;
      }
      if (entry.storageOwnerGen === gen) {
        entry.storageOwnerGen = null;
      }
      throw err;
    }
    if (this.stopped || entry.downloadGen !== gen) {
      await this.deleteStaleStorageIfOwned(entry, gen);
      return;
    }

    if (entry.manifest.totalChunks === 0) {
      try {
        await this.runTrackedStorageOp(entry, () =>
          this.chunkStorage.finalizeFile(fileId),
        );
      } catch (err) {
        if (entry.activeDownloadGen === gen) {
          entry.activeDownloadGen = null;
        }
        throw err;
      }
      if (this.stopped || entry.downloadGen !== gen) {
        await this.deleteStaleStorageIfOwned(entry, gen);
        return;
      }
      entry.localBitfield = createBitfield(0);
      entry.completedChunks = 0;
      entry.bytesCompleted = 0;
      entry.status = "seeding";
      entry.errorMessage = undefined;
      entry.lastSpeedBytesPerSec = 0;
      this.broadcastBitfieldForFile(entry);
      this.emitProgress(entry);
      this.events?.onTransferCompleted?.(entry.manifest);
      return;
    }

    const normalizedBf = createBitfield(entry.manifest.totalChunks);
    let completed = 0;
    let bytesDone = 0;
    for (let i = 0; i < entry.manifest.totalChunks; i++) {
      if (hasChunkInBitfield(existingBitfield, i)) {
        setChunkInBitfield(normalizedBf, i);
        completed += 1;
        bytesDone += expectedChunkByteLength(entry.manifest, i);
      }
    }

    entry.localBitfield = normalizedBf;
    entry.completedChunks = completed;
    entry.bytesCompleted = bytesDone;
    entry.errorMessage = undefined;
    entry.finalizing = false;
    entry.writingChunks.clear();

    if (completed === entry.manifest.totalChunks) {
      try {
        await this.runTrackedStorageOp(entry, () =>
          this.chunkStorage.finalizeFile(fileId),
        );
      } catch (err) {
        if (entry.activeDownloadGen === gen) {
          entry.activeDownloadGen = null;
        }
        throw err;
      }
      if (this.stopped || entry.downloadGen !== gen) {
        await this.deleteStaleStorageIfOwned(entry, gen);
        return;
      }
      entry.status = "seeding";
      entry.lastSpeedBytesPerSec = 0;
      this.broadcastBitfieldForFile(entry);
      this.emitProgress(entry);
      this.events?.onTransferCompleted?.(entry.manifest);
      return;
    }

    entry.status = "downloading";
    entry.downloadStartedAt = this.now();
    entry.speedSamples = [];
    entry.lastSpeedBytesPerSec = 0;

    if (completed > 0) {
      this.broadcastBitfieldForFile(entry);
    }

    this.emitProgress(entry);
    this.scheduleDownloads();
  }

  async cancelDownload(fileId: string): Promise<void> {
    const entry = this.files.get(fileId);
    if (!entry) {
      return;
    }

    entry.downloadGen += 1;
    entry.activeDownloadGen = null;
    entry.storageOwnerGen = null;
    entry.initDownloadPromise = null;
    entry.status = "paused";
    entry.finalizing = false;
    entry.writingChunks.clear();
    entry.requestedHashPages.clear();
    entry.failedHashPagePeers.clear();
    entry.speedSamples = [];
    entry.lastSpeedBytesPerSec = 0;
    entry.downloadStartedAt = null;

    // Cancel all in-flight requests for this file across all peers
    for (const [chunkIndex, peerSet] of entry.chunkInFlightPeers.entries()) {
      for (const peerId of peerSet) {
        const peer = this.peers.get(peerId);
        if (!peer) continue;
        const reqKey = `${fileId}:${chunkIndex}`;
        const req = peer.inFlightRequests.get(reqKey);
        if (req) {
          clearTimeout(req.timer);
          peer.inFlightRequests.delete(reqKey);
        }
        this.sendSwarmFrameToPeer(peer, {
          frameType: SwarmFrameType.CANCEL,
          fileId,
          chunkIndex,
          payload: new Uint8Array(0),
        });
      }
    }
    entry.chunkInFlightPeers.clear();

    // Remove queued outbound chunks for deleted local data
    for (const peer of this.peers.values()) {
      if (peer.outboundChunkQueue.length > 0) {
        peer.outboundChunkQueue = peer.outboundChunkQueue.filter((item) => {
          if (item.fileId === fileId) {
            peer.outboundChunkKeys.delete(`${item.fileId}:${item.chunkIndex}`);
            return false;
          }
          return true;
        });
      }
      if (peer.currentReadingKey?.startsWith(`${fileId}:`)) {
        peer.cancelledReadingKeys.add(peer.currentReadingKey);
      }
    }

    entry.localBitfield = createBitfield(entry.manifest.totalChunks);
    entry.completedChunks = 0;
    entry.bytesCompleted = 0;
    this.broadcastBitfieldForFile(entry);

    await this.runTrackedStorageOp(entry, () =>
      this.chunkStorage.deleteFile(fileId),
    );
    if (!this.stopped) {
      this.emitProgress(entry);
      this.scheduleDownloads();
    }
  }

  getFiles(): FileManifest[] {
    const out: FileManifest[] = [];
    for (const id of this.fileOrder) {
      const entry = this.files.get(id);
      if (entry) {
        out.push(entry.manifest);
      }
    }
    return out;
  }

  getSyncSummaryFileIds(): string[] {
    const start = Math.max(0, this.fileOrder.length - MAX_SYNC_MESSAGES);
    return this.fileOrder.slice(start);
  }

  computeMissingFileIdsToRequest(peerKnownFileIds: readonly string[]): string[] {
    const want: string[] = [];
    const seen = new Set<string>();
    for (const id of peerKnownFileIds) {
      if (want.length >= MAX_SYNC_MESSAGES) break;
      if (!seen.has(id) && !this.files.has(id)) {
        seen.add(id);
        want.push(id);
      }
    }
    return want;
  }

  computeFilesPeerLacks(peerKnownFileIds: readonly string[]): FileManifest[] {
    const peerKnown = new Set(peerKnownFileIds);
    const start = Math.max(0, this.fileOrder.length - MAX_SYNC_MESSAGES);
    const missing: FileManifest[] = [];
    for (let i = start; i < this.fileOrder.length; i++) {
      const id = this.fileOrder[i];
      if (id && !peerKnown.has(id)) {
        const entry = this.files.get(id);
        if (entry) {
          missing.push(entry.manifest);
        }
      }
    }
    return missing;
  }

  getFilesByIds(wantFileIds: readonly string[]): FileManifest[] {
    const out: FileManifest[] = [];
    const seen = new Set<string>();
    for (const id of wantFileIds) {
      if (out.length >= MAX_SYNC_MESSAGES) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = this.files.get(id);
      if (entry) {
        out.push(entry.manifest);
      }
    }
    return out;
  }

  getTransferProgress(fileId: string): SwarmTransferProgress | undefined {
    const entry = this.files.get(fileId);
    if (!entry) return undefined;
    return this.buildProgress(entry);
  }

  onPeerVerified(link: VerifiedSwarmPeerLink): void {
    if (this.stopped) return;
    let peer = this.peers.get(link.peerId);
    if (!peer) {
      peer = {
        link,
        bitfields: new Map(),
        zeroChunkSeededFiles: new Set(),
        earlyRawBitfields: new Map(),
        earlyHaves: new Map(),
        inFlightRequests: new Map(),
        pendingStorageWrites: 0,
        outboundChunkQueue: [],
        outboundChunkKeys: new Set(),
        currentReadingKey: null,
        cancelledReadingKeys: new Set(),
        drainingOutbound: false,
        needsRedrain: false,
        poisonStrikes: 0,
        timeoutStrikes: 0,
        chunkCooldownUntil: new Map(),
        initialBitfieldsSent: false,
      };
      this.peers.set(link.peerId, peer);
    } else {
      peer.link = link;
    }

    link.swarmChannel.bufferedAmountLowThreshold = SWARM_BUFFERED_LOW_THRESHOLD;

    if (link.swarmChannel.readyState === "open") {
      peer.initialBitfieldsSent = true;
      this.sendAllLocalBitfieldsToPeer(peer);
      void this.drainPeerOutboundQueue(peer);
      this.scheduleDownloads();
    }
  }

  onPeerSwarmChannelOpen(peerId: string): void {
    if (this.stopped) return;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.link.isVerified()) return;

    peer.link.swarmChannel.bufferedAmountLowThreshold =
      SWARM_BUFFERED_LOW_THRESHOLD;

    if (!peer.initialBitfieldsSent) {
      peer.initialBitfieldsSent = true;
      this.sendAllLocalBitfieldsToPeer(peer);
    }
    void this.drainPeerOutboundQueue(peer);
    this.scheduleDownloads();
  }

  onPeerHelloAck(peerId: string): void {
    if (this.stopped) return;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.link.isVerified()) return;
    if (peer.link.swarmChannel.readyState === "open") {
      this.sendAllLocalBitfieldsToPeer(peer);
    }
  }

  onPeerBufferedAmountLow(peerId: string): void {
    if (this.stopped) return;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.link.isVerified()) return;
    void this.drainPeerOutboundQueue(peer);
  }

  onPeerDisconnected(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.peers.delete(peerId);
    peer.outboundChunkQueue = [];
    peer.outboundChunkKeys.clear();

    let releasedAnyInFlight = false;
    for (const req of peer.inFlightRequests.values()) {
      clearTimeout(req.timer);
      const entry = this.files.get(req.fileId);
      const peerSet = entry?.chunkInFlightPeers.get(req.chunkIndex);
      if (peerSet) {
        peerSet.delete(peerId);
        if (peerSet.size === 0) {
          entry?.chunkInFlightPeers.delete(req.chunkIndex);
        }
      }
      releasedAnyInFlight = true;
    }
    peer.inFlightRequests.clear();

    if (!this.stopped) {
      for (const entry of this.files.values()) {
        for (const [pageIdx, pendingPage] of entry.requestedHashPages.entries()) {
          if (pendingPage.peerId === peerId) {
            entry.requestedHashPages.delete(pageIdx);
            releasedAnyInFlight = true;
          }
        }
        for (const [pageIdx, failedSet] of entry.failedHashPagePeers.entries()) {
          failedSet.delete(peerId);
          if (failedSet.size === 0) {
            entry.failedHashPagePeers.delete(pageIdx);
          }
        }
        if (entry.status === "downloading") {
          this.emitProgress(entry);
        }
      }
      if (releasedAnyInFlight) {
        this.scheduleDownloads();
      }
    }
  }

  handleSwarmBinaryFrame(peerId: string, rawBytes: Uint8Array): void {
    if (this.stopped) return;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.link.isVerified()) {
      return;
    }

    let frame;
    try {
      frame = decodeSwarmFrame(rawBytes);
    } catch {
      return;
    }

    switch (frame.frameType) {
      case SwarmFrameType.BITFIELD:
        this.handleBitfieldFrame(peer, frame.fileId, frame.payload);
        break;
      case SwarmFrameType.HAVE:
        this.handleHaveFrame(peer, frame.fileId, frame.chunkIndex);
        break;
      case SwarmFrameType.REQUEST:
        this.handleRequestFrame(peer, frame.fileId, frame.chunkIndex);
        break;
      case SwarmFrameType.CHUNK:
        void this.handleChunkFrame(
          peer,
          frame.fileId,
          frame.chunkIndex,
          frame.payload,
        );
        break;
      case SwarmFrameType.CANCEL:
        this.handleCancelFrame(peer, frame.fileId, frame.chunkIndex);
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.hashPageRetryTimers) {
      clearTimeout(t);
    }
    this.hashPageRetryTimers.clear();
    for (const peer of this.peers.values()) {
      for (const req of peer.inFlightRequests.values()) {
        clearTimeout(req.timer);
      }
      peer.inFlightRequests.clear();
      peer.outboundChunkQueue = [];
      peer.outboundChunkKeys.clear();
    }
    this.peers.clear();
    for (const entry of this.files.values()) {
      entry.downloadGen += 1;
      entry.activeDownloadGen = null;
      entry.initDownloadPromise = null;
      entry.chunkInFlightPeers.clear();
      entry.writingChunks.clear();
      entry.requestedHashPages.clear();
      entry.failedHashPagePeers.clear();
    }
  }

  private handleBitfieldFrame(
    peer: SwarmPeerEntry,
    fileId: string,
    payload: Uint8Array,
  ): void {
    if (payload.byteLength > MAX_RAW_BITFIELD_BYTES) {
      return;
    }
    const entry = this.files.get(fileId);
    if (!entry) {
      const existingRaw = peer.earlyRawBitfields.get(fileId);
      if (existingRaw && existingRaw.byteLength === payload.byteLength) {
        for (let i = 0; i < existingRaw.byteLength; i++) {
          existingRaw[i] = (existingRaw[i] ?? 0) | (payload[i] ?? 0);
        }
      } else if (
        existingRaw !== undefined ||
        peer.earlyRawBitfields.size < MAX_PRE_MANIFEST_FILES_PER_PEER
      ) {
        peer.earlyRawBitfields.set(fileId, payload.slice());
      }
      return;
    }

    const expectedLen = Math.ceil(entry.manifest.totalChunks / 8);
    if (payload.byteLength !== expectedLen) {
      return;
    }

    if (entry.manifest.totalChunks === 0) {
      peer.zeroChunkSeededFiles.add(fileId);
      peer.bitfields.set(fileId, new Uint8Array(0));
    } else {
      const cleanBf = createBitfield(entry.manifest.totalChunks);
      const existingBf = peer.bitfields.get(fileId);
      if (existingBf && existingBf.byteLength === cleanBf.byteLength) {
        cleanBf.set(existingBf);
      }
      for (let i = 0; i < entry.manifest.totalChunks; i++) {
        if (hasChunkInBitfield(payload, i)) {
          setChunkInBitfield(cleanBf, i);
        }
      }
      const pending = peer.earlyHaves.get(fileId);
      if (pending) {
        for (const idx of pending) {
          if (idx < entry.manifest.totalChunks) {
            setChunkInBitfield(cleanBf, idx);
          }
        }
        peer.earlyHaves.delete(fileId);
      }
      peer.bitfields.set(fileId, cleanBf);
    }

    if (entry.status === "downloading") {
      this.emitProgress(entry);
      this.scheduleDownloads();
    }
  }

  private handleHaveFrame(
    peer: SwarmPeerEntry,
    fileId: string,
    chunkIndex: number,
  ): void {
    const entry = this.files.get(fileId);
    if (!entry) {
      let set = peer.earlyHaves.get(fileId);
      if (!set) {
        if (peer.earlyHaves.size >= MAX_PRE_MANIFEST_FILES_PER_PEER) return;
        set = new Set();
        peer.earlyHaves.set(fileId, set);
      }
      if (set.size < MAX_PRE_MANIFEST_HAVES_PER_FILE) {
        set.add(chunkIndex);
      }
      return;
    }

    if (chunkIndex >= entry.manifest.totalChunks) {
      return;
    }
    let bf = peer.bitfields.get(fileId);
    if (!bf) {
      bf = createBitfield(entry.manifest.totalChunks);
      peer.bitfields.set(fileId, bf);
    }
    if (!hasChunkInBitfield(bf, chunkIndex)) {
      setChunkInBitfield(bf, chunkIndex);
      if (entry.status === "downloading") {
        this.scheduleDownloads();
      }
    }
  }

  private applyEarlyPeerBitfieldsForFile(entry: SwarmFileEntry): void {
    const { fileId, totalChunks } = entry.manifest;
    const expectedLen = Math.ceil(totalChunks / 8);

    for (const peer of this.peers.values()) {
      const rawBf = peer.earlyRawBitfields.get(fileId);
      const rawHaves = peer.earlyHaves.get(fileId);
      peer.earlyRawBitfields.delete(fileId);
      peer.earlyHaves.delete(fileId);

      if (totalChunks === 0) {
        if (rawBf && rawBf.byteLength === 0) {
          peer.zeroChunkSeededFiles.add(fileId);
          peer.bitfields.set(fileId, new Uint8Array(0));
        }
        continue;
      }

      if (!rawBf && !rawHaves) continue;
      const bf = createBitfield(totalChunks);
      const existingBf = peer.bitfields.get(fileId);
      if (existingBf && existingBf.byteLength === bf.byteLength) {
        bf.set(existingBf);
      }
      if (rawBf && rawBf.byteLength === expectedLen) {
        for (let i = 0; i < totalChunks; i++) {
          if (hasChunkInBitfield(rawBf, i)) {
            setChunkInBitfield(bf, i);
          }
        }
      }
      if (rawHaves) {
        for (const idx of rawHaves) {
          if (idx < totalChunks) {
            setChunkInBitfield(bf, idx);
          }
        }
      }
      peer.bitfields.set(fileId, bf);
    }
  }

  private handleRequestFrame(
    peer: SwarmPeerEntry,
    fileId: string,
    chunkIndex: number,
  ): void {
    const entry = this.files.get(fileId);
    if (!entry) return;
    if (
      chunkIndex >= entry.manifest.totalChunks ||
      !hasChunkInBitfield(entry.localBitfield, chunkIndex)
    ) {
      return;
    }

    const qKey = `${fileId}:${chunkIndex}`;
    peer.cancelledReadingKeys.delete(qKey);
    if (
      !peer.outboundChunkKeys.has(qKey) &&
      peer.outboundChunkQueue.length < MAX_QUEUED_OUTBOUND_CHUNKS_PER_PEER
    ) {
      peer.outboundChunkKeys.add(qKey);
      peer.outboundChunkQueue.push({ fileId, chunkIndex });
    }
    void this.drainPeerOutboundQueue(peer);
  }

  private handleCancelFrame(
    peer: SwarmPeerEntry,
    fileId: string,
    chunkIndex: number,
  ): void {
    const qKey = `${fileId}:${chunkIndex}`;
    if (peer.outboundChunkKeys.delete(qKey)) {
      peer.outboundChunkQueue = peer.outboundChunkQueue.filter(
        (item) => !(item.fileId === fileId && item.chunkIndex === chunkIndex),
      );
    }
    if (peer.currentReadingKey === qKey) {
      peer.cancelledReadingKeys.add(qKey);
    }
  }

  private async drainPeerOutboundQueue(peer: SwarmPeerEntry): Promise<void> {
    if (peer.drainingOutbound) {
      peer.needsRedrain = true;
      return;
    }
    peer.drainingOutbound = true;

    try {
      do {
        peer.needsRedrain = false;

        while (
          !this.stopped &&
          this.peers.get(peer.link.peerId) === peer &&
          peer.link.isVerified() &&
          peer.link.swarmChannel.readyState === "open" &&
          peer.link.swarmChannel.bufferedAmount < SWARM_MAX_BUFFERED_AMOUNT &&
          peer.outboundChunkQueue.length > 0
        ) {
          const item = peer.outboundChunkQueue.shift()!;
          const qKey = `${item.fileId}:${item.chunkIndex}`;
          peer.outboundChunkKeys.delete(qKey);

          const entry = this.files.get(item.fileId);
          if (
            !entry ||
            item.chunkIndex >= entry.manifest.totalChunks ||
            !hasChunkInBitfield(entry.localBitfield, item.chunkIndex)
          ) {
            continue;
          }

          const expectedLen = expectedChunkByteLength(
            entry.manifest,
            item.chunkIndex,
          );
          peer.currentReadingKey = qKey;
          let chunkBytes: Uint8Array;
          try {
            chunkBytes = await this.chunkStorage.readChunk(
              item.fileId,
              item.chunkIndex,
              expectedLen,
            );
          } catch (err) {
            peer.currentReadingKey = null;
            this.events?.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            );
            continue;
          }
          peer.currentReadingKey = null;

          if (
            this.stopped ||
            this.peers.get(peer.link.peerId) !== peer ||
            !peer.link.isVerified() ||
            peer.link.swarmChannel.readyState !== "open"
          ) {
            break;
          }

          if (peer.cancelledReadingKeys.delete(qKey)) {
            continue;
          }

          if (
            peer.link.swarmChannel.bufferedAmount >= SWARM_MAX_BUFFERED_AMOUNT
          ) {
            if (!peer.outboundChunkKeys.has(qKey)) {
              peer.outboundChunkKeys.add(qKey);
              peer.outboundChunkQueue.unshift(item);
            }
            break;
          }

          this.sendSwarmFrameToPeer(peer, {
            frameType: SwarmFrameType.CHUNK,
            fileId: item.fileId,
            chunkIndex: item.chunkIndex,
            payload: chunkBytes,
          });
        }
      } while (
        peer.needsRedrain &&
        !this.stopped &&
        this.peers.get(peer.link.peerId) === peer &&
        peer.link.isVerified() &&
        peer.link.swarmChannel.readyState === "open" &&
        peer.link.swarmChannel.bufferedAmount < SWARM_MAX_BUFFERED_AMOUNT &&
        peer.outboundChunkQueue.length > 0
      );
    } finally {
      peer.drainingOutbound = false;
    }
  }

  private async handleChunkFrame(
    peer: SwarmPeerEntry,
    fileId: string,
    chunkIndex: number,
    payload: Uint8Array,
  ): Promise<void> {
    const entry = this.files.get(fileId);
    if (!entry) {
      return;
    }

    const senderPeerId = peer.link.peerId;
    const reqKey = `${fileId}:${chunkIndex}`;
    this.releaseInFlightRequest(entry, peer, chunkIndex);

    const expectedLen = expectedChunkByteLength(entry.manifest, chunkIndex);
    const expectedHash = entry.resolvedChunkHashes[chunkIndex];
    const isValid =
      chunkIndex < entry.manifest.totalChunks &&
      payload.byteLength === expectedLen &&
      expectedHash !== undefined &&
      verifyChunkSha256(payload, expectedHash);

    if (!isValid) {
      peer.poisonStrikes += 1;
      if (peer.poisonStrikes >= MAX_POISON_STRIKES) {
        this.evictPeer(senderPeerId, "chunk_hash_mismatch");
      } else {
        this.scheduleDownloads();
      }
      return;
    }

    peer.timeoutStrikes = 0;
    peer.chunkCooldownUntil.delete(reqKey);

    if (entry.status !== "downloading") {
      this.scheduleDownloads();
      return;
    }

    if (
      hasChunkInBitfield(entry.localBitfield, chunkIndex) ||
      entry.writingChunks.has(chunkIndex)
    ) {
      this.scheduleDownloads();
      return;
    }

    const chunkGen = entry.downloadGen;
    entry.writingChunks.add(chunkIndex);
    peer.pendingStorageWrites += 1;

    // Endgame cancellation: cancel any redundant in-flight requests to other peers for this chunk
    const otherPeers = entry.chunkInFlightPeers.get(chunkIndex);
    if (otherPeers && otherPeers.size > 0) {
      for (const otherPeerId of Array.from(otherPeers)) {
        if (otherPeerId === senderPeerId) continue;
        const otherPeer = this.peers.get(otherPeerId);
        if (otherPeer) {
          this.releaseInFlightRequest(entry, otherPeer, chunkIndex);
          this.sendSwarmFrameToPeer(otherPeer, {
            frameType: SwarmFrameType.CANCEL,
            fileId,
            chunkIndex,
            payload: new Uint8Array(0),
          });
        }
      }
      entry.chunkInFlightPeers.delete(chunkIndex);
    }

    // Schedule next chunk only if peer/file write budgets still have capacity
    this.scheduleDownloads();

    try {
      await this.runTrackedStorageOp(entry, () =>
        this.chunkStorage.writeVerifiedChunk(fileId, chunkIndex, payload),
      );
    } catch (err) {
      entry.writingChunks.delete(chunkIndex);
      peer.pendingStorageWrites = Math.max(0, peer.pendingStorageWrites - 1);
      if (
        !this.stopped &&
        entry.downloadGen === chunkGen &&
        entry.status === "downloading"
      ) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        entry.activeDownloadGen = null;
        entry.status = "error";
        entry.errorMessage = errorObj.message;
        this.emitProgress(entry);
        this.events?.onError?.(errorObj);
      }
      this.scheduleDownloads();
      return;
    }

    entry.writingChunks.delete(chunkIndex);
    peer.pendingStorageWrites = Math.max(0, peer.pendingStorageWrites - 1);
    if (
      this.stopped ||
      entry.downloadGen !== chunkGen ||
      entry.status !== "downloading"
    ) {
      this.scheduleDownloads();
      return;
    }

    if (!hasChunkInBitfield(entry.localBitfield, chunkIndex)) {
      setChunkInBitfield(entry.localBitfield, chunkIndex);
      entry.completedChunks += 1;
      entry.bytesCompleted += payload.byteLength;
      this.recordDownloadBytes(entry, payload.byteLength);

      // Immediate Swarm re-seeding while still downloading
      this.broadcastHaveChunk(fileId, chunkIndex);
    }

    if (
      entry.completedChunks === entry.manifest.totalChunks &&
      entry.writingChunks.size === 0
    ) {
      if (entry.finalizing) return;
      entry.finalizing = true;
      try {
        await this.runTrackedStorageOp(entry, () =>
          this.chunkStorage.finalizeFile(fileId),
        );
      } catch (err) {
        entry.finalizing = false;
        if (
          !this.stopped &&
          entry.downloadGen === chunkGen &&
          entry.status === "downloading"
        ) {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          entry.activeDownloadGen = null;
          entry.status = "error";
          entry.errorMessage = errorObj.message;
          this.emitProgress(entry);
          this.events?.onError?.(errorObj);
        }
        return;
      }
      if (
        this.stopped ||
        entry.downloadGen !== chunkGen ||
        entry.status !== "downloading"
      ) {
        if (!this.stopped && entry.downloadGen !== chunkGen) {
          await this.deleteStaleStorageIfOwned(entry, chunkGen);
        }
        return;
      }
      entry.status = "seeding";
      this.emitProgress(entry);
      this.events?.onTransferCompleted?.(entry.manifest);
      this.scheduleDownloads();
      return;
    }

    this.emitProgress(entry);
    this.scheduleDownloads();
  }

  private peerHasChunkInRange(
    bf: Uint8Array | undefined,
    startChunk: number,
    endChunkExclusive: number,
  ): boolean {
    if (!bf || bf.byteLength === 0) return false;
    for (let idx = startChunk; idx < endChunkExclusive; idx++) {
      if (hasChunkInBitfield(bf, idx)) {
        return true;
      }
    }
    return false;
  }

  private scheduleHashPageRetryTimer(entry: SwarmFileEntry, delayMs: number): void {
    const retryTimer = setTimeout(() => {
      this.hashPageRetryTimers.delete(retryTimer);
      if (!this.stopped && entry.status === "downloading") {
        this.scheduleDownloads();
      }
    }, Math.max(1, delayMs));
    this.hashPageRetryTimers.add(retryTimer);
  }

  private ensureHashPagesRequested(entry: SwarmFileEntry): void {
    const pageDigests = entry.manifest.hashPageHashes;
    if (!pageDigests || pageDigests.length === 0) return;
    if (entry.verifiedHashPages.size >= pageDigests.length) return;

    const nowTs = this.now();
    const missingPages: number[] = [];
    let nextPendingExpiryMs = Number.POSITIVE_INFINITY;

    for (let p = 0; p < pageDigests.length; p++) {
      if (entry.verifiedHashPages.has(p)) continue;
      const prevReq = entry.requestedHashPages.get(p);
      if (!prevReq || nowTs - prevReq.requestedAt >= this.requestTimeoutMs) {
        missingPages.push(p);
      } else {
        const remaining = prevReq.requestedAt + this.requestTimeoutMs - nowTs;
        if (remaining < nextPendingExpiryMs) {
          nextPendingExpiryMs = remaining;
        }
      }
    }

    if (missingPages.length === 0) {
      if (
        Number.isFinite(nextPendingExpiryMs) &&
        this.hashPageRetryTimers.size === 0
      ) {
        this.scheduleHashPageRetryTimer(entry, nextPendingExpiryMs);
      }
      return;
    }

    const verifiedPeers: SwarmPeerEntry[] = [];
    for (const peer of this.peers.values()) {
      if (peer.link.isVerified()) {
        verifiedPeers.push(peer);
      }
    }
    if (verifiedPeers.length === 0) return;

    const pagesByPeer = new Map<string, number[]>();
    for (const pageIdx of missingPages) {
      const prevReq = entry.requestedHashPages.get(pageIdx);
      let failedSet = entry.failedHashPagePeers.get(pageIdx);
      if (prevReq && nowTs - prevReq.requestedAt >= this.requestTimeoutMs) {
        failedSet = this.recordFailedHashPagePeer(
          entry,
          pageIdx,
          prevReq.peerId,
        );
      }

      if (
        failedSet &&
        verifiedPeers.every((p) => failedSet!.has(p.link.peerId))
      ) {
        failedSet.clear();
        if (prevReq && verifiedPeers.length > 1) {
          failedSet.add(prevReq.peerId);
        }
      }

      const startChunk = pageIdx * SWARM_HASH_PAGE_CHUNKS;
      const endChunk = Math.min(
        entry.manifest.totalChunks,
        startChunk + SWARM_HASH_PAGE_CHUNKS,
      );

      const sorted = [...verifiedPeers].sort((a, b) => {
        const aFailed = failedSet?.has(a.link.peerId) ? 1 : 0;
        const bFailed = failedSet?.has(b.link.peerId) ? 1 : 0;
        if (aFailed !== bFailed) return aFailed - bFailed;

        const aBf = a.bitfields.get(entry.manifest.fileId);
        const bBf = b.bitfields.get(entry.manifest.fileId);
        const aHasPageChunk = this.peerHasChunkInRange(aBf, startChunk, endChunk)
          ? 0
          : 1;
        const bHasPageChunk = this.peerHasChunkInRange(bBf, startChunk, endChunk)
          ? 0
          : 1;
        if (aHasPageChunk !== bHasPageChunk) {
          return aHasPageChunk - bHasPageChunk;
        }

        const aHasAnyChunks =
          countChunksInBitfield(
            aBf ?? new Uint8Array(0),
            entry.manifest.totalChunks,
          ) > 0
            ? 0
            : 1;
        const bHasAnyChunks =
          countChunksInBitfield(
            bBf ?? new Uint8Array(0),
            entry.manifest.totalChunks,
          ) > 0
            ? 0
            : 1;
        if (aHasAnyChunks !== bHasAnyChunks) {
          return aHasAnyChunks - bHasAnyChunks;
        }
        if (a.poisonStrikes !== b.poisonStrikes) {
          return a.poisonStrikes - b.poisonStrikes;
        }
        return a.timeoutStrikes - b.timeoutStrikes;
      });
      const chosen = sorted[0];
      if (!chosen) continue;
      entry.requestedHashPages.set(pageIdx, {
        peerId: chosen.link.peerId,
        requestedAt: nowTs,
      });
      let batch = pagesByPeer.get(chosen.link.peerId);
      if (!batch) {
        batch = [];
        pagesByPeer.set(chosen.link.peerId, batch);
      }
      batch.push(pageIdx);
    }

    for (const [peerId, pageIndices] of pagesByPeer.entries()) {
      this.sendControlFrameToPeer(peerId, {
        type: "file.hash_page_request",
        fileId: entry.manifest.fileId,
        pageIndices,
      });
    }

    this.scheduleHashPageRetryTimer(entry, this.requestTimeoutMs);
  }

  private peerActiveLoad(peer: SwarmPeerEntry): number {
    return peer.inFlightRequests.size + peer.pendingStorageWrites;
  }

  private scheduleDownloads(): void {
    if (this.stopped) return;

    const maxPendingWritesPerFile = Math.max(16, this.maxInFlightPerPeer * 4);
    let anyPeerHasControl = false;
    let anyPeerHasSwarmSlot = false;
    for (const peer of this.peers.values()) {
      if (!peer.link.isVerified()) continue;
      anyPeerHasControl = true;
      if (
        peer.link.swarmChannel.readyState === "open" &&
        this.peerActiveLoad(peer) < this.maxInFlightPerPeer
      ) {
        anyPeerHasSwarmSlot = true;
      }
    }
    if (!anyPeerHasControl) return;

    for (const entry of this.files.values()) {
      if (entry.status !== "downloading") continue;

      this.ensureHashPagesRequested(entry);
      if (!anyPeerHasSwarmSlot) continue;
      if (entry.writingChunks.size >= maxPendingWritesPerFile) continue;

      const totalChunks = entry.manifest.totalChunks;
      const uncompletedChunks =
        totalChunks - entry.completedChunks - entry.writingChunks.size;
      if (uncompletedChunks <= 0) continue;

      const endgameThreshold = Math.min(8, Math.ceil(totalChunks * 0.05));
      const isEndgame = uncompletedChunks <= endgameThreshold;
      const maxRequestsPerChunk = isEndgame ? 2 : 1;

      // Collect candidate missing chunks whose hashes are already verified
      const candidates: Array<{
        chunkIndex: number;
        availability: number;
        tie: number;
      }> = [];

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (
          entry.resolvedChunkHashes[chunkIndex] === undefined ||
          hasChunkInBitfield(entry.localBitfield, chunkIndex) ||
          entry.writingChunks.has(chunkIndex)
        ) {
          continue;
        }
        const activeCount =
          entry.chunkInFlightPeers.get(chunkIndex)?.size ?? 0;
        if (activeCount >= maxRequestsPerChunk) {
          continue;
        }

        let availability = 0;
        for (const peer of this.peers.values()) {
          if (!peer.link.isVerified()) continue;
          const bf = peer.bitfields.get(entry.manifest.fileId);
          if (bf && hasChunkInBitfield(bf, chunkIndex)) {
            availability += 1;
          }
        }
        if (availability === 0) {
          continue;
        }

        candidates.push({
          chunkIndex,
          availability,
          tie: chunkTieHash(entry.peerTieSeed, chunkIndex),
        });
      }

      if (candidates.length === 0) continue;

      // Rarest-First ordering, tie-broken deterministically per-peer so concurrent leechers diversify
      candidates.sort(
        (a, b) =>
          a.availability - b.availability ||
          a.tie - b.tie ||
          a.chunkIndex - b.chunkIndex,
      );

      const nowTs = this.now();
      for (const candidate of candidates) {
        if (entry.writingChunks.size >= maxPendingWritesPerFile) break;
        const { chunkIndex } = candidate;
        const reqKey = `${entry.manifest.fileId}:${chunkIndex}`;
        let inFlightPeers = entry.chunkInFlightPeers.get(chunkIndex);
        const neededCopies =
          maxRequestsPerChunk - (inFlightPeers?.size ?? 0);
        if (neededCopies <= 0) continue;

        // Find eligible peers holding this chunk with available in-flight + storage-write slots
        const eligiblePeers: SwarmPeerEntry[] = [];
        for (const peer of this.peers.values()) {
          if (
            !peer.link.isVerified() ||
            peer.link.swarmChannel.readyState !== "open" ||
            this.peerActiveLoad(peer) >= this.maxInFlightPerPeer
          ) {
            continue;
          }
          if (inFlightPeers?.has(peer.link.peerId)) {
            continue;
          }
          const bf = peer.bitfields.get(entry.manifest.fileId);
          if (bf && hasChunkInBitfield(bf, chunkIndex)) {
            eligiblePeers.push(peer);
          }
        }

        if (eligiblePeers.length === 0) continue;

        eligiblePeers.sort((a, b) => {
          const coolA =
            (a.chunkCooldownUntil.get(reqKey) ?? 0) > nowTs ? 1 : 0;
          const coolB =
            (b.chunkCooldownUntil.get(reqKey) ?? 0) > nowTs ? 1 : 0;
          if (coolA !== coolB) return coolA - coolB;

          const strikeDiff = a.poisonStrikes - b.poisonStrikes;
          if (strikeDiff !== 0) return strikeDiff;

          const timeoutDiff = a.timeoutStrikes - b.timeoutStrikes;
          if (timeoutDiff !== 0) return timeoutDiff;

          const loadDiff = this.peerActiveLoad(a) - this.peerActiveLoad(b);
          if (loadDiff !== 0) return loadDiff;

          const rttA = a.link.getRttMs() ?? 999_999;
          const rttB = b.link.getRttMs() ?? 999_999;
          if (rttA !== rttB) return rttA - rttB;
          return a.link.peerId.localeCompare(b.link.peerId);
        });

        const toDispatch = Math.min(neededCopies, eligiblePeers.length);
        for (let k = 0; k < toDispatch; k++) {
          const chosenPeer = eligiblePeers[k]!;
          if (!inFlightPeers) {
            inFlightPeers = new Set();
            entry.chunkInFlightPeers.set(chunkIndex, inFlightPeers);
          }
          this.dispatchChunkRequest(entry, chosenPeer, chunkIndex);
        }
      }
    }
  }

  private dispatchChunkRequest(
    entry: SwarmFileEntry,
    peer: SwarmPeerEntry,
    chunkIndex: number,
  ): void {
    const fileId = entry.manifest.fileId;
    const peerId = peer.link.peerId;
    const reqKey = `${fileId}:${chunkIndex}`;

    const timer = setTimeout(() => {
      if (this.stopped) return;
      const currentPeer = this.peers.get(peerId);
      const currentEntry = this.files.get(fileId);
      if (currentPeer && currentEntry) {
        currentPeer.timeoutStrikes += 1;
        const cooldownMs = Math.max(
          200,
          Math.min(5_000, this.requestTimeoutMs * 2),
        );
        currentPeer.chunkCooldownUntil.set(reqKey, this.now() + cooldownMs);
        this.releaseInFlightRequest(currentEntry, currentPeer, chunkIndex);
        this.sendSwarmFrameToPeer(currentPeer, {
          frameType: SwarmFrameType.CANCEL,
          fileId,
          chunkIndex,
          payload: new Uint8Array(0),
        });
        this.scheduleDownloads();
      }
    }, this.requestTimeoutMs);

    peer.inFlightRequests.set(reqKey, {
      fileId,
      chunkIndex,
      peerId,
      requestedAt: this.now(),
      timer,
    });

    let inFlightSet = entry.chunkInFlightPeers.get(chunkIndex);
    if (!inFlightSet) {
      inFlightSet = new Set();
      entry.chunkInFlightPeers.set(chunkIndex, inFlightSet);
    }
    inFlightSet.add(peerId);

    this.sendSwarmFrameToPeer(peer, {
      frameType: SwarmFrameType.REQUEST,
      fileId,
      chunkIndex,
      payload: new Uint8Array(0),
    });
  }

  private releaseInFlightRequest(
    entry: SwarmFileEntry,
    peer: SwarmPeerEntry,
    chunkIndex: number,
  ): void {
    const reqKey = `${entry.manifest.fileId}:${chunkIndex}`;
    const req = peer.inFlightRequests.get(reqKey);
    if (req) {
      clearTimeout(req.timer);
      peer.inFlightRequests.delete(reqKey);
    }
    const peerSet = entry.chunkInFlightPeers.get(chunkIndex);
    if (peerSet) {
      peerSet.delete(peer.link.peerId);
      if (peerSet.size === 0) {
        entry.chunkInFlightPeers.delete(chunkIndex);
      }
    }
  }

  private recordDownloadBytes(entry: SwarmFileEntry, byteLen: number): void {
    const nowTs = this.now();
    entry.speedSamples.push({ ts: nowTs, bytes: byteLen });
    const cutoff = nowTs - SPEED_WINDOW_MS;
    while (entry.speedSamples.length > 0 && entry.speedSamples[0]!.ts < cutoff) {
      entry.speedSamples.shift();
    }
    let totalWindowBytes = 0;
    for (const s of entry.speedSamples) {
      totalWindowBytes += s.bytes;
    }
    const oldestTs = entry.speedSamples[0]?.ts ?? nowTs;
    const startedAt = entry.downloadStartedAt ?? oldestTs;
    const effectiveStart = Math.max(startedAt, cutoff);
    const spanMs = Math.min(
      SPEED_WINDOW_MS,
      Math.max(50, nowTs - effectiveStart),
    );
    entry.lastSpeedBytesPerSec = Math.round((totalWindowBytes * 1000) / spanMs);
  }

  private computePeerAvailability(entry: SwarmFileEntry): {
    availableSeeders: number;
    availablePeersWithChunks: number;
  } {
    const { fileId, totalChunks } = entry.manifest;
    let availableSeeders = 0;
    let availablePeersWithChunks = 0;

    for (const peer of this.peers.values()) {
      if (!peer.link.isVerified()) continue;
      if (totalChunks === 0) {
        if (peer.zeroChunkSeededFiles.has(fileId)) {
          availableSeeders += 1;
        }
        continue;
      }
      const bf = peer.bitfields.get(fileId);
      if (!bf) continue;
      const count = countChunksInBitfield(bf, totalChunks);
      if (count === totalChunks) {
        availableSeeders += 1;
      }
      if (count >= 1) {
        availablePeersWithChunks += 1;
      }
    }

    return { availableSeeders, availablePeersWithChunks };
  }

  private buildProgress(entry: SwarmFileEntry): SwarmTransferProgress {
    const { availableSeeders, availablePeersWithChunks } =
      this.computePeerAvailability(entry);

    let downloadSpeedBytesPerSec = 0;
    if (entry.status === "downloading") {
      const nowTs = this.now();
      const cutoff = nowTs - SPEED_WINDOW_MS;
      while (
        entry.speedSamples.length > 0 &&
        entry.speedSamples[0]!.ts < cutoff
      ) {
        entry.speedSamples.shift();
      }
      if (entry.speedSamples.length === 0) {
        downloadSpeedBytesPerSec = 0;
      } else {
        downloadSpeedBytesPerSec = entry.lastSpeedBytesPerSec;
      }
    }

    return {
      fileId: entry.manifest.fileId,
      fileName: entry.manifest.fileName,
      fileSize: entry.manifest.fileSize,
      totalChunks: entry.manifest.totalChunks,
      completedChunks: entry.completedChunks,
      bytesCompleted: entry.bytesCompleted,
      downloadSpeedBytesPerSec,
      availableSeeders,
      availablePeersWithChunks,
      status: entry.status,
      ...(entry.errorMessage !== undefined
        ? { errorMessage: entry.errorMessage }
        : {}),
    };
  }

  private emitProgress(entry: SwarmFileEntry): void {
    this.events?.onTransferProgress?.(this.buildProgress(entry));
  }

  private sendAllLocalBitfieldsToPeer(peer: SwarmPeerEntry): void {
    for (const entry of this.files.values()) {
      if (entry.status === "seeding" || entry.completedChunks > 0) {
        this.sendSwarmFrameToPeer(peer, {
          frameType: SwarmFrameType.BITFIELD,
          fileId: entry.manifest.fileId,
          chunkIndex: 0,
          payload: entry.localBitfield,
        });
      }
    }
  }

  private broadcastBitfieldForFile(entry: SwarmFileEntry): void {
    const encoded = encodeSwarmFrame({
      frameType: SwarmFrameType.BITFIELD,
      fileId: entry.manifest.fileId,
      chunkIndex: 0,
      payload: entry.localBitfield,
    });
    for (const peer of this.peers.values()) {
      this.sendRawSwarmBytesToPeer(peer, encoded);
    }
  }

  private broadcastHaveChunk(fileId: string, chunkIndex: number): void {
    const encoded = encodeSwarmFrame({
      frameType: SwarmFrameType.HAVE,
      fileId,
      chunkIndex,
      payload: new Uint8Array(0),
    });
    for (const peer of this.peers.values()) {
      this.sendRawSwarmBytesToPeer(peer, encoded);
    }
  }

  private sendSwarmFrameToPeer(
    peer: SwarmPeerEntry,
    frame: {
      frameType: (typeof SwarmFrameType)[keyof typeof SwarmFrameType];
      fileId: string;
      chunkIndex: number;
      payload: Uint8Array;
    },
  ): void {
    if (
      !peer.link.isVerified() ||
      peer.link.swarmChannel.readyState !== "open"
    ) {
      return;
    }
    const encoded = encodeSwarmFrame(frame);
    this.sendRawSwarmBytesToPeer(peer, encoded);
  }

  private sendRawSwarmBytesToPeer(
    peer: SwarmPeerEntry,
    bytes: Uint8Array,
  ): void {
    if (
      !peer.link.isVerified() ||
      peer.link.swarmChannel.readyState !== "open"
    ) {
      return;
    }
    try {
      peer.link.swarmChannel.sendBinary(bytes);
    } catch {
      // Transport close will be handled by PeerSession state/close events
    }
  }
}

export { SWARM_CHUNK_SIZE };
