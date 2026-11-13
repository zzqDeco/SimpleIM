import {
  ContractValidationError,
  isValidUuid,
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_LAMPORT,
  MAX_SYNC_MESSAGES,
  type ChatMessageEnvelope,
  type PeerIdentityCert,
} from "@simpleim/contracts";
import {
  signChatMessage,
  utf8ToBytes,
  verifyChatMessage,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import type { RoomPeerEngineEvents } from "./ports.ts";

const MAX_STORED_MESSAGES = 2_000;

export interface ChatSyncManagerOptions {
  roomId: string;
  localCert: PeerIdentityCert;
  localSignKeyPair: Ed25519KeyPair;
  serverSignPubKey: string;
  now: () => number;
  events?: RoomPeerEngineEvents;
}

export function compareChatMessages(
  a: ChatMessageEnvelope,
  b: ChatMessageEnvelope,
): number {
  return (
    a.lamport - b.lamport ||
    a.createdAt - b.createdAt ||
    a.msgId.localeCompare(b.msgId)
  );
}

export class ChatSyncManager {
  private readonly roomId: string;
  private readonly localCert: PeerIdentityCert;
  private readonly localSignKeyPair: Ed25519KeyPair;
  private readonly serverSignPubKey: string;
  private readonly now: () => number;
  private readonly events?: RoomPeerEngineEvents;

  private lamport = 0;
  private readonly messages: ChatMessageEnvelope[] = [];
  private readonly messagesById = new Map<string, ChatMessageEnvelope>();

  constructor(options: ChatSyncManagerOptions) {
    this.roomId = options.roomId;
    this.localCert = options.localCert;
    this.localSignKeyPair = options.localSignKeyPair;
    this.serverSignPubKey = options.serverSignPubKey;
    this.now = options.now;
    this.events = options.events;
  }

  createLocalMessage(
    body: string,
    replyToMsgId?: string | null,
  ): ChatMessageEnvelope {
    if (typeof body !== "string") {
      throw new ContractValidationError("Chat message body must be a string");
    }
    const bodyByteLen = utf8ToBytes(body).byteLength;
    if (bodyByteLen < 1 || bodyByteLen > MAX_CHAT_BODY_BYTES) {
      throw new ContractValidationError(
        `Chat message body must be 1..${MAX_CHAT_BODY_BYTES} UTF-8 bytes`,
      );
    }
    const normalizedReply = replyToMsgId ?? null;
    if (normalizedReply !== null && !isValidUuid(normalizedReply)) {
      throw new ContractValidationError("Invalid replyToMsgId UUID");
    }

    if (this.lamport >= MAX_CHAT_LAMPORT) {
      throw new ContractValidationError(
        "Local Lamport clock reached maximum safe bound",
      );
    }
    this.lamport += 1;
    const createdAt = this.now();
    const envelope = signChatMessage({
      roomId: this.roomId,
      lamport: this.lamport,
      body,
      replyToMsgId: normalizedReply,
      authorCert: this.localCert,
      peerSignPrivKey: this.localSignKeyPair.privateKeyBytes,
      createdAt,
    });

    this.insertSorted(envelope);
    return envelope;
  }

  ingestRemoteMessage(
    message: ChatMessageEnvelope,
    isHistoricalSync: boolean,
  ): boolean {
    if (
      message.lamport > MAX_CHAT_LAMPORT ||
      !verifyChatMessage(message, this.serverSignPubKey, this.roomId)
    ) {
      return false;
    }
    if (this.messagesById.has(message.msgId)) {
      return false;
    }

    if (message.lamport > this.lamport) {
      this.lamport = message.lamport;
    }
    this.insertSorted(message);
    this.events?.onChatMessage?.(message, isHistoricalSync);
    return true;
  }

  getMessages(): ChatMessageEnvelope[] {
    return [...this.messages];
  }

  getSyncSummaryMsgIds(): string[] {
    const start = Math.max(0, this.messages.length - MAX_SYNC_MESSAGES);
    const out: string[] = [];
    for (let i = start; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg) {
        out.push(msg.msgId);
      }
    }
    return out;
  }

  computeMissingMsgIdsToRequest(peerKnownMsgIds: readonly string[]): string[] {
    const want: string[] = [];
    const seen = new Set<string>();
    for (const id of peerKnownMsgIds) {
      if (want.length >= MAX_SYNC_MESSAGES) break;
      if (!seen.has(id) && !this.messagesById.has(id)) {
        seen.add(id);
        want.push(id);
      }
    }
    return want;
  }

  computeMessagesPeerLacks(
    peerKnownMsgIds: readonly string[],
  ): ChatMessageEnvelope[] {
    const peerKnown = new Set(peerKnownMsgIds);
    const start = Math.max(0, this.messages.length - MAX_SYNC_MESSAGES);
    const missing: ChatMessageEnvelope[] = [];
    for (let i = start; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg && !peerKnown.has(msg.msgId)) {
        missing.push(msg);
      }
    }
    return missing;
  }

  getMessagesByIds(wantMsgIds: readonly string[]): ChatMessageEnvelope[] {
    const out: ChatMessageEnvelope[] = [];
    const seen = new Set<string>();
    for (const id of wantMsgIds) {
      if (out.length >= MAX_SYNC_MESSAGES) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const msg = this.messagesById.get(id);
      if (msg) {
        out.push(msg);
      }
    }
    return out;
  }

  private insertSorted(message: ChatMessageEnvelope): void {
    this.messagesById.set(message.msgId, message);

    // Binary search insertion point since messages arrive mostly in causal order
    let low = 0;
    let high = this.messages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const midMsg = this.messages[mid]!;
      if (compareChatMessages(midMsg, message) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.messages.splice(low, 0, message);

    while (this.messages.length > MAX_STORED_MESSAGES) {
      const evicted = this.messages.shift();
      if (evicted) {
        this.messagesById.delete(evicted.msgId);
      }
    }
  }
}
