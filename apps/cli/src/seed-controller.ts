import type { FileManifest } from "@simpleim/contracts";
import type { FsChunkStorageAdapter } from "./fs-chunk-storage.ts";
import type { StructuredLogger } from "./logger.ts";

export interface SeedQuotaControllerOptions {
  maxStorageBytes: number;
  storage: FsChunkStorageAdapter;
  downloadFile: (fileId: string) => Promise<void>;
  logger?: StructuredLogger;
  roomIdPrefix?: string;
}

export class SeedQuotaController {
  readonly maxStorageBytes: number;
  private readonly storage: FsChunkStorageAdapter;
  private readonly downloadFile: (fileId: string) => Promise<void>;
  private readonly logger?: StructuredLogger;
  private readonly roomIdPrefix?: string;

  private readonly inFlightReservations = new Map<string, number>();
  private readonly completedFileIds = new Set<string>();
  private admissionQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SeedQuotaControllerOptions) {
    if (!Number.isFinite(options.maxStorageBytes) || options.maxStorageBytes <= 0) {
      throw new Error("maxStorageBytes must be a positive number");
    }
    this.maxStorageBytes = Math.floor(options.maxStorageBytes);
    this.storage = options.storage;
    this.downloadFile = options.downloadFile;
    this.logger = options.logger;
    this.roomIdPrefix = options.roomIdPrefix;
  }

  getInFlightCount(): number {
    return this.inFlightReservations.size;
  }

  getCompletedCount(): number {
    return this.completedFileIds.size;
  }

  onTransferCompleted(manifest: FileManifest): void {
    this.inFlightReservations.delete(manifest.fileId);
    this.completedFileIds.add(manifest.fileId);
    this.logger?.info("seed.file.completed", {
      roomIdPrefix: this.roomIdPrefix,
      meta: {
        fileId: manifest.fileId,
        fileSize: manifest.fileSize,
        totalChunks: manifest.totalChunks,
      },
    });
  }

  onFileAnnounced(manifest: FileManifest): Promise<boolean> {
    const run = this.admissionQueue.then(() => this.evaluateAndStart(manifest));
    this.admissionQueue = run.catch(() => {});
    return run;
  }

  private async evaluateAndStart(manifest: FileManifest): Promise<boolean> {
    if (
      this.completedFileIds.has(manifest.fileId) ||
      this.inFlightReservations.has(manifest.fileId)
    ) {
      return false;
    }

    const diskBytes = await this.storage.getUsedPayloadBytes();
    let pendingUnallocatedBytes = 0;
    for (const size of this.inFlightReservations.values()) {
      pendingUnallocatedBytes += size;
    }

    // Once initReceivingFile truncates the .part file on disk, its size is reflected in diskBytes;
    // while admission is serialized before downloadFile resolves, pendingUnallocatedBytes guards concurrent announcements.
    const projectedBytes = diskBytes + pendingUnallocatedBytes + manifest.fileSize;
    if (projectedBytes > this.maxStorageBytes) {
      this.logger?.warn("seed.file.skipped_quota", {
        roomIdPrefix: this.roomIdPrefix,
        errorCode: "payload_too_large",
        meta: {
          fileId: manifest.fileId,
          fileSize: manifest.fileSize,
          diskBytes,
          maxStorageBytes: this.maxStorageBytes,
        },
      });
      return false;
    }

    this.inFlightReservations.set(manifest.fileId, manifest.fileSize);
    const startedAt = Date.now();
    this.logger?.info("seed.file.accepted", {
      roomIdPrefix: this.roomIdPrefix,
      meta: {
        fileId: manifest.fileId,
        fileSize: manifest.fileSize,
        totalChunks: manifest.totalChunks,
        diskBytes,
        maxStorageBytes: this.maxStorageBytes,
      },
    });

    try {
      await this.downloadFile(manifest.fileId);
      if (!this.completedFileIds.has(manifest.fileId)) {
        const diskAfter = await this.storage.getUsedPayloadBytes();
        const allocatedDelta = Math.max(0, diskAfter - diskBytes);
        const remainingUnallocated = Math.max(
          0,
          manifest.fileSize - allocatedDelta,
        );
        this.inFlightReservations.set(manifest.fileId, remainingUnallocated);
      } else {
        this.inFlightReservations.delete(manifest.fileId);
      }
      this.logger?.info("seed.file.downloading", {
        roomIdPrefix: this.roomIdPrefix,
        durationMs: Date.now() - startedAt,
        meta: {
          fileId: manifest.fileId,
        },
      });
      return true;
    } catch (err) {
      this.inFlightReservations.delete(manifest.fileId);
      this.logger?.error("seed.file.download_failed", {
        roomIdPrefix: this.roomIdPrefix,
        durationMs: Date.now() - startedAt,
        errorCode: "internal_error",
        meta: {
          fileId: manifest.fileId,
          reason: err instanceof Error ? err.message : "download_error",
        },
      });
      return false;
    }
  }
}
