import type { ChatMessageEnvelope } from "@simpleim/contracts";
import { formatMessageTime } from "../utils/format.ts";

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
  readonly envelope: ChatMessageEnvelope;
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
): MessageViewModel {
  const author = msg.authorCert.payload;
  const isSelf = author.peerId === localPeerId;
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
    envelope: msg,
  };
}
