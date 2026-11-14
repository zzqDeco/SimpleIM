import type { FileManifest } from "@simpleim/contracts";
import type { SwarmTransferProgress } from "@simpleim/peer-core";
import { formatBytes, formatSpeedMBps } from "../utils/format.ts";

export type TransferStatus = SwarmTransferProgress["status"];

export type TransferStatusTranslationKey =
  | "room.files.status.announced"
  | "room.files.status.downloading"
  | "room.files.status.seeding"
  | "room.files.status.paused"
  | "room.files.status.error";

export interface TransferViewModel {
  readonly fileId: string;
  readonly fileName: string;
  readonly formattedSize: string;
  readonly status: TransferStatus;
  readonly statusKey: TransferStatusTranslationKey;
  readonly percent: number;
  readonly seedCount: number;
  readonly peerChunkCount: number;
  readonly formattedSpeed: string;
  readonly showSpeed: boolean;
  readonly canDownload: boolean;
  readonly canCancel: boolean;
  readonly canSave: boolean;
  readonly errorMessage: string | null;
}

const STATUS_KEY_MAP: Readonly<
  Record<TransferStatus, TransferStatusTranslationKey>
> = {
  announced: "room.files.status.announced",
  downloading: "room.files.status.downloading",
  seeding: "room.files.status.seeding",
  paused: "room.files.status.paused",
  error: "room.files.status.error",
};

export function deriveTransferViewModel(
  manifest: FileManifest,
  progress: SwarmTransferProgress | undefined,
  localPeerId: string,
  saveAvailable: boolean,
): TransferViewModel {
  const isOwnSeed = manifest.senderCert.payload.peerId === localPeerId;
  const status: TransferStatus =
    progress?.status ?? (isOwnSeed ? "seeding" : "announced");
  const completedChunks =
    progress?.completedChunks ??
    (status === "seeding" ? manifest.totalChunks : 0);
  const percent =
    manifest.totalChunks === 0
      ? status === "seeding"
        ? 100
        : 0
      : Math.min(100, Math.round((completedChunks / manifest.totalChunks) * 100));

  const seedCount = progress?.availableSeeders ?? (isOwnSeed ? 1 : 0);
  const peerChunkCount = progress?.availablePeersWithChunks ?? seedCount;
  const speedBytesPerSec = progress?.downloadSpeedBytesPerSec ?? 0;

  return {
    fileId: manifest.fileId,
    fileName: manifest.fileName,
    formattedSize: formatBytes(manifest.fileSize),
    status,
    statusKey: STATUS_KEY_MAP[status],
    percent,
    seedCount,
    peerChunkCount,
    formattedSpeed: formatSpeedMBps(speedBytesPerSec),
    showSpeed: status === "downloading" && speedBytesPerSec > 0,
    canDownload:
      status === "announced" || status === "paused" || status === "error",
    canCancel: status === "downloading",
    canSave: status === "seeding" && saveAvailable,
    errorMessage: progress?.errorMessage ?? null,
  };
}

export function countActiveDownloads(
  files: readonly FileManifest[],
  transfers: ReadonlyMap<string, SwarmTransferProgress>,
): number {
  let count = 0;
  for (const file of files) {
    if (transfers.get(file.fileId)?.status === "downloading") {
      count += 1;
    }
  }
  return count;
}
