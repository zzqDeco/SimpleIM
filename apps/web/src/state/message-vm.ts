import type { ChatMessageEnvelope } from "@simpleim/contracts";
import type { ChatDeliveryStatus } from "@simpleim/peer-core";
import { formatMessageTime } from "../utils/format.ts";

export type MessageDeliveryTranslationKey =
  | "room.msg.delivery.pending"
  | "room.msg.delivery.relayed"
  | "room.msg.delivery.p2pOnly"
  | "room.msg.delivery.failed";

export interface MessageQuoteViewModel {
  readonly replyToMsgId: string;
  readonly resolvedAuthorHandle: string | null;
  readonly previewText: string;
}

export interface MessageViewModel {
  readonly msgId: string;
  readonly isSelf: boolean;
  readonly authorDisplayName: string;
  readonly authorUsername: string;
  readonly runtimeTag: "CLI" | "WEB";
  readonly createdAtIso: string;
  readonly formattedTime: string;
  readonly quote: MessageQuoteViewModel | null;
  readonly body: string;
  readonly deliveryStatus: ChatDeliveryStatus | null;
  readonly deliveryLabelKey: MessageDeliveryTranslationKey | null;
  readonly envelope: ChatMessageEnvelope;
}

function resolveDeliveryLabelKey(
  status: ChatDeliveryStatus | null,
): MessageDeliveryTranslationKey | null {
  switch (status) {
    case "pending":
      return "room.msg.delivery.pending";
    case "relayed":
      return "room.msg.delivery.relayed";
    case "p2p_only":
      return "room.msg.delivery.p2pOnly";
    case "failed":
      return "room.msg.delivery.failed";
    case null:
      return null;
  }
}

export function truncatePreview(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}…`;
}

export function deriveMessageViewModel(
  msg: ChatMessageEnvelope,
  localPeerId: string,
  messageById: ReadonlyMap<string, ChatMessageEnvelope>,
  currentUserId?: string,
  deliveryStates?: ReadonlyMap<string, ChatDeliveryStatus>,
): MessageViewModel {
  const author = msg.authorCert.payload;
  const isSelf =
    author.peerId === localPeerId ||
    (currentUserId !== undefined && author.userId === currentUserId);
  const runtimeTag = author.clientKind === "cli" ? "CLI" : "WEB";

  let quote: MessageQuoteViewModel | null = null;
  if (msg.replyToMsgId) {
    const replied = messageById.get(msg.replyToMsgId);
    quote = {
      replyToMsgId: msg.replyToMsgId,
      resolvedAuthorHandle: replied
        ? `@${replied.authorCert.payload.username}`
        : null,
      previewText: replied
        ? truncatePreview(replied.body, 96)
        : `#${msg.replyToMsgId.slice(0, 8)}`,
    };
  }

  const deliveryStatus: ChatDeliveryStatus | null = isSelf
    ? (deliveryStates?.get(msg.msgId) ?? null)
    : null;

  return {
    msgId: msg.msgId,
    isSelf,
    authorDisplayName: author.displayName,
    authorUsername: author.username,
    runtimeTag,
    createdAtIso: new Date(msg.createdAt).toISOString(),
    formattedTime: formatMessageTime(msg.createdAt),
    quote,
    body: msg.body,
    deliveryStatus,
    deliveryLabelKey: resolveDeliveryLabelKey(deliveryStatus),
    envelope: msg,
  };
}
