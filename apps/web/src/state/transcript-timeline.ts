import type { ChatMessageEnvelope } from "@simpleim/contracts";
import type { ChatDeliveryStatus } from "@simpleim/peer-core";
import {
  formatDatePillLabel,
  formatTranscriptDividerLabel,
  getLocalDayKey,
  type RelativeDateLabels,
} from "../utils/format.ts";
import {
  deriveMessageViewModel,
  type MessageViewModel,
} from "./message-vm.ts";

/** Standard IM time-gap threshold (5 minutes) for inserting an inline timestamp divider. */
export const TRANSCRIPT_TIME_GAP_MS = 5 * 60 * 1000;

export interface TranscriptTimelineItem {
  readonly vm: MessageViewModel;
  readonly dayKey: string;
  readonly datePillLabel: string;
  readonly showDivider: boolean;
  readonly isDayBoundary: boolean;
  readonly dividerLabel: string | null;
  readonly isCompact: boolean;
}

export interface BuildTranscriptTimelineParams {
  readonly messages: readonly ChatMessageEnvelope[];
  readonly localPeerId: string;
  readonly currentUserId?: string;
  readonly deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly nowMs: number;
  readonly dateLabels: RelativeDateLabels;
  readonly timeGapMs?: number;
}

export function buildTranscriptTimeline(
  params: BuildTranscriptTimelineParams,
): TranscriptTimelineItem[] {
  const {
    messages,
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

  const items: TranscriptTimelineItem[] = [];
  let prevMsg: ChatMessageEnvelope | undefined;
  let prevDayKey = "";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const vm = deriveMessageViewModel(
      msg,
      localPeerId,
      byId,
      currentUserId,
      deliveryStates,
    );
    const dayKey = getLocalDayKey(msg.createdAt);
    const isFirst = i === 0;
    const isDayBoundary = isFirst || dayKey !== prevDayKey;
    const hasTimeGap =
      !isFirst &&
      prevMsg !== undefined &&
      Math.abs(msg.createdAt - prevMsg.createdAt) >= timeGapMs;
    const showDivider = isDayBoundary || hasTimeGap;
    const dividerLabel = showDivider
      ? formatTranscriptDividerLabel(
          msg.createdAt,
          nowMs,
          dateLabels,
          isDayBoundary,
        )
      : null;
    const datePillLabel = formatDatePillLabel(msg.createdAt, nowMs, dateLabels);

    const sameAuthorAsPrev =
      prevMsg !== undefined &&
      prevMsg.authorCert.payload.userId === msg.authorCert.payload.userId &&
      prevMsg.authorCert.payload.username === msg.authorCert.payload.username &&
      prevMsg.authorCert.payload.displayName ===
        msg.authorCert.payload.displayName &&
      prevMsg.authorCert.payload.clientKind ===
        msg.authorCert.payload.clientKind;

    // Group consecutive messages from the same sender within a short window into compact entries,
    // except when a divider starts a new block or the message quotes an earlier message.
    const isCompact = !showDivider && sameAuthorAsPrev && !msg.replyToMsgId;

    items.push({
      vm,
      dayKey,
      datePillLabel,
      showDivider,
      isDayBoundary,
      dividerLabel,
      isCompact,
    });

    prevMsg = msg;
    prevDayKey = dayKey;
  }

  return items;
}
