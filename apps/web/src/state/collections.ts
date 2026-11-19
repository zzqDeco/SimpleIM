import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";
import type { ChatDeliveryStatus } from "@simpleim/peer-core";

export interface ReconcilableRoomMetadata {
  readonly roomId: string;
  readonly roomIdPrefix: string;
  readonly alias: string | null;
  readonly pinned: boolean;
  readonly joinedAt: number;
  readonly lastActiveAt: number;
  readonly lastReadAt: number;
}

export interface ReconcileCommittedRoomStateInput<
  TMeta extends ReconcilableRoomMetadata,
> {
  readonly liveMetadata: TMeta;
  readonly liveMessages: readonly ChatMessageEnvelope[];
  readonly liveFiles: readonly FileManifest[];
  readonly livePendingRelayMsgIds: ReadonlySet<string>;
  readonly liveDeliveryStates: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly liveRelayCursor: number;
  readonly committedMetadata: TMeta;
  readonly committedMessages?: readonly ChatMessageEnvelope[];
  readonly committedFiles?: readonly FileManifest[];
  readonly committedPendingRelayMsgIds: readonly string[];
  readonly committedRelayCursor: number;
  readonly removedPendingRelayMsgIds?: readonly string[];
  readonly cursorReset?: boolean;
  readonly maxMessages?: number;
  readonly maxFiles?: number;
}

export interface ReconciledRoomState<TMeta extends ReconcilableRoomMetadata> {
  readonly metadata: TMeta;
  readonly messages: ChatMessageEnvelope[];
  readonly files: FileManifest[];
  readonly pendingRelayMsgIds: Set<string>;
  readonly relayCursor: number;
}

export function mergeOrderedMessages(
  existing: readonly ChatMessageEnvelope[],
  incoming: readonly ChatMessageEnvelope[],
): ChatMessageEnvelope[] {
  const byId = new Map<string, ChatMessageEnvelope>();
  for (const m of existing) {
    byId.set(m.msgId, m);
  }
  for (const m of incoming) {
    byId.set(m.msgId, m);
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      a.lamport - b.lamport ||
      a.createdAt - b.createdAt ||
      a.msgId.localeCompare(b.msgId),
  );
}

export function mergeOrderedFiles(
  existing: readonly FileManifest[],
  incoming: readonly FileManifest[],
): FileManifest[] {
  const byId = new Map<string, FileManifest>();
  for (const f of existing) {
    byId.set(f.fileId, f);
  }
  for (const f of incoming) {
    byId.set(f.fileId, f);
  }
  return Array.from(byId.values());
}

/**
 * Reconciles a completed RoomVault commit snapshot back into live in-memory room state
 * without dropping messages, files, metadata edits, or outbox acknowledgements that
 * arrived while the IndexedDB commit was awaiting completion.
 */
export function reconcileCommittedRoomState<
  TMeta extends ReconcilableRoomMetadata,
>(input: ReconcileCommittedRoomStateInput<TMeta>): ReconciledRoomState<TMeta> {
  const metadata: TMeta = {
    ...input.liveMetadata,
    joinedAt: Math.min(
      input.liveMetadata.joinedAt,
      input.committedMetadata.joinedAt,
    ),
    lastActiveAt: Math.max(
      input.liveMetadata.lastActiveAt,
      input.committedMetadata.lastActiveAt,
    ),
    lastReadAt: Math.max(
      input.liveMetadata.lastReadAt,
      input.committedMetadata.lastReadAt,
    ),
  };

  const maxMessages = input.maxMessages ?? 2_000;
  const maxFiles = input.maxFiles ?? 200;

  const messages =
    input.committedMessages !== undefined
      ? mergeOrderedMessages(input.committedMessages, input.liveMessages).slice(
          -maxMessages,
        )
      : [...input.liveMessages];

  const files =
    input.committedFiles !== undefined
      ? mergeOrderedFiles(input.committedFiles, input.liveFiles).slice(
          -maxFiles,
        )
      : [...input.liveFiles];

  const removedSet = new Set(input.removedPendingRelayMsgIds ?? []);
  const pendingRelayMsgIds = new Set<string>(input.livePendingRelayMsgIds);
  for (const id of removedSet) {
    pendingRelayMsgIds.delete(id);
  }
  for (const id of input.committedPendingRelayMsgIds) {
    if (removedSet.has(id)) continue;
    if (input.liveDeliveryStates.get(id) === "relayed") continue;
    pendingRelayMsgIds.add(id);
  }

  const relayCursor = input.cursorReset
    ? input.committedRelayCursor
    : Math.max(input.liveRelayCursor, input.committedRelayCursor);

  return {
    metadata,
    messages,
    files,
    pendingRelayMsgIds,
    relayCursor,
  };
}
