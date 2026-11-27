import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";
import type {
  ChatDeliveryStatus,
  SwarmTransferProgress,
} from "@simpleim/peer-core";
import {
  formatDatePillLabel,
  formatMessageDateTime,
  formatMessageTime,
  formatTranscriptDividerLabel,
  getFileCreatedAtMs,
  getLocalDayKey,
  type RelativeDateLabels,
} from "../utils/format.ts";
import {
  deriveMessageViewModel,
  type MessageViewModel,
} from "./message-vm.ts";
import {
  deriveTransferViewModel,
  type TransferViewModel,
} from "./transfer-vm.ts";

/** Standard IM time-gap threshold (5 minutes) for inserting an inline timestamp divider. */
export const TRANSCRIPT_TIME_GAP_MS = 5 * 60 * 1000;

interface TranscriptTimelineBaseItem {
  readonly itemKey: string;
  readonly createdAtMs: number;
  readonly isSelf: boolean;
  readonly dayKey: string;
  readonly datePillLabel: string;
  readonly showDivider: boolean;
  readonly isDayBoundary: boolean;
  readonly dividerLabel: string | null;
}

export interface TranscriptMessageItem extends TranscriptTimelineBaseItem {
  readonly kind: "message";
  readonly vm: MessageViewModel;
  readonly isCompact: boolean;
}

export interface TranscriptFileItem extends TranscriptTimelineBaseItem {
  readonly kind: "file";
  readonly createdAtIso: string;
  readonly formattedTime: string;
  readonly formattedDateTime: string;
  readonly authorDisplayName: string;
  readonly authorUsername: string;
  readonly runtimeTag: "CLI" | "WEB";
  readonly manifest: FileManifest;
  readonly transfer: TransferViewModel;
  readonly isCompact: false;
}

export type TranscriptTimelineItem = TranscriptMessageItem | TranscriptFileItem;

export interface BuildTranscriptTimelineParams {
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files?: readonly FileManifest[];
  readonly transfers?: ReadonlyMap<string, SwarmTransferProgress>;
  readonly canSaveFile?: (fileId: string) => boolean;
  readonly localPeerId: string;
  readonly currentUserId?: string;
  readonly deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly nowMs: number;
  readonly dateLabels: RelativeDateLabels;
  readonly timeGapMs?: number;
}

type RawTimelineEntry =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAtMs: number;
      readonly msg: ChatMessageEnvelope;
    }
  | {
      readonly kind: "file";
      readonly id: string;
      readonly createdAtMs: number;
      readonly manifest: FileManifest;
    };

export function buildTranscriptTimeline(
  params: BuildTranscriptTimelineParams,
): TranscriptTimelineItem[] {
  const {
    messages,
    files = [],
    transfers,
    canSaveFile,
    localPeerId,
    currentUserId,
    deliveryStates,
    nowMs,
    dateLabels,
    timeGapMs = TRANSCRIPT_TIME_GAP_MS,
  } = params;

  const byId = new Map<string, ChatMessageEnvelope>();
  for (const msg of messages) {
    byId.set(msg.msgId, msg);
  }

  const rawEntries: RawTimelineEntry[] = [];
  for (const msg of messages) {
    rawEntries.push({
      kind: "message",
      id: msg.msgId,
      createdAtMs: msg.createdAt,
      msg,
    });
  }
  for (const manifest of files) {
    rawEntries.push({
      kind: "file",
      id: manifest.fileId,
      createdAtMs: getFileCreatedAtMs(manifest),
      manifest,
    });
  }

  // Chronological merge: messages precede files on identical millisecond timestamps
  // so caption + attachment bursts always render caption first.
  rawEntries.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    if (a.kind !== b.kind) {
      return a.kind === "message" ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  const items: TranscriptTimelineItem[] = [];
  let prevEntry: RawTimelineEntry | undefined;
  let prevDayKey = "";

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i]!;
    const dayKey = getLocalDayKey(entry.createdAtMs);
    const isFirst = i === 0;
    const isDayBoundary = isFirst || dayKey !== prevDayKey;
    const hasTimeGap =
      !isFirst &&
      prevEntry !== undefined &&
      Math.abs(entry.createdAtMs - prevEntry.createdAtMs) >= timeGapMs;
    const showDivider = isDayBoundary || hasTimeGap;
    const dividerLabel = showDivider
      ? formatTranscriptDividerLabel(
          entry.createdAtMs,
          nowMs,
          dateLabels,
          isDayBoundary,
        )
      : null;
    const datePillLabel = formatDatePillLabel(
      entry.createdAtMs,
      nowMs,
      dateLabels,
    );

    if (entry.kind === "message") {
      const { msg } = entry;
      const vm = deriveMessageViewModel(
        msg,
        localPeerId,
        byId,
        currentUserId,
        deliveryStates,
      );

      const sameAuthorAsPrevMsg =
        prevEntry?.kind === "message" &&
        prevEntry.msg.authorCert.payload.userId ===
          msg.authorCert.payload.userId &&
        prevEntry.msg.authorCert.payload.username ===
          msg.authorCert.payload.username &&
        prevEntry.msg.authorCert.payload.displayName ===
          msg.authorCert.payload.displayName &&
        prevEntry.msg.authorCert.payload.clientKind ===
          msg.authorCert.payload.clientKind;

      // Group consecutive text messages from the same sender within a short window,
      // except after a divider, after a file card, or when quoting another message.
      const isCompact = !showDivider && sameAuthorAsPrevMsg && !msg.replyToMsgId;

      items.push({
        kind: "message",
        itemKey: `msg:${msg.msgId}`,
        createdAtMs: entry.createdAtMs,
        isSelf: vm.isSelf,
        vm,
        dayKey,
        datePillLabel,
        showDivider,
        isDayBoundary,
        dividerLabel,
        isCompact,
      });
    } else {
      const { manifest } = entry;
      const sender = manifest.senderCert.payload;
      const isSelf =
        sender.peerId === localPeerId ||
        (currentUserId !== undefined && sender.userId === currentUserId);
      const runtimeTag = sender.clientKind === "cli" ? "CLI" : "WEB";
      const createdAtIso =
        Number.isFinite(entry.createdAtMs) && entry.createdAtMs > 0
          ? new Date(entry.createdAtMs).toISOString()
          : "";
      const transfer = deriveTransferViewModel(
        manifest,
        transfers?.get(manifest.fileId),
        localPeerId,
        canSaveFile ? canSaveFile(manifest.fileId) : false,
      );

      items.push({
        kind: "file",
        itemKey: `file:${manifest.fileId}`,
        createdAtMs: entry.createdAtMs,
        createdAtIso,
        formattedTime: formatMessageTime(entry.createdAtMs),
        formattedDateTime: formatMessageDateTime(entry.createdAtMs),
        isSelf,
        authorDisplayName: sender.displayName,
        authorUsername: sender.username,
        runtimeTag,
        manifest,
        transfer,
        dayKey,
        datePillLabel,
        showDivider,
        isDayBoundary,
        dividerLabel,
        isCompact: false,
      });
    }

    prevEntry = entry;
    prevDayKey = dayKey;
  }

  return items;
}
