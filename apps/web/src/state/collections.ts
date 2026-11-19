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
  readonly preCommitFileIds?: ReadonlySet<string>;
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
  const existingDedup: FileManifest[] = [];
  const existingPos = new Map<string, number>();
  for (const f of existing) {
    const pos = existingPos.get(f.fileId);
    if (pos !== undefined) {
      existingDedup[pos] = f;
    } else {
      existingPos.set(f.fileId, existingDedup.length);
      existingDedup.push(f);
    }
  }

  const incomingDedup: FileManifest[] = [];
  const incomingPos = new Map<string, number>();
  for (const f of incoming) {
    const pos = incomingPos.get(f.fileId);
    if (pos !== undefined) {
      incomingDedup[pos] = f;
    } else {
      incomingPos.set(f.fileId, incomingDedup.length);
      incomingDedup.push(f);
    }
  }

  // Insert incoming-only segments ahead of the existing anchor they precede and
  // append trailing incoming-only items at the end so evicted older manifests
  // never jump past newer ones when merging capped snapshots.
  const insertBefore = new Map<number, FileManifest[]>();
  const trailing: FileManifest[] = [];
  let pendingSegment: FileManifest[] = [];

  for (const f of incomingDedup) {
    const anchorPos = existingPos.get(f.fileId);
    if (anchorPos !== undefined) {
      existingDedup[anchorPos] = f;
      if (pendingSegment.length > 0) {
        const bucket = insertBefore.get(anchorPos);
        if (bucket) {
          bucket.push(...pendingSegment);
        } else {
          insertBefore.set(anchorPos, pendingSegment);
        }
        pendingSegment = [];
      }
    } else {
      pendingSegment.push(f);
    }
  }
  if (pendingSegment.length > 0) {
    trailing.push(...pendingSegment);
  }

  const out: FileManifest[] = [];
  for (let i = 0; i < existingDedup.length; i++) {
    const before = insertBefore.get(i);
    if (before) {
      out.push(...before);
    }
    out.push(existingDedup[i]!);
  }
  out.push(...trailing);
  return out;
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

  let files: FileManifest[];
  if (input.committedFiles !== undefined) {
    if (input.preCommitFileIds !== undefined) {
      const committedIds = new Set(input.committedFiles.map((f) => f.fileId));
      const preCommitOnly: FileManifest[] = [];
      const concurrentLiveOnly: FileManifest[] = [];
      for (const f of input.liveFiles) {
        if (committedIds.has(f.fileId)) continue;
        if (input.preCommitFileIds.has(f.fileId)) {
          preCommitOnly.push(f);
        } else {
          concurrentLiveOnly.push(f);
        }
      }
      files = mergeOrderedFiles(
        [],
        [...preCommitOnly, ...input.committedFiles, ...concurrentLiveOnly],
      ).slice(-maxFiles);
    } else {
      const committedIds = new Set(input.committedFiles.map((f) => f.fileId));
      const hasOverlap = input.liveFiles.some((f) => committedIds.has(f.fileId));
      files = (
        hasOverlap
          ? mergeOrderedFiles(input.committedFiles, input.liveFiles)
          : mergeOrderedFiles(input.liveFiles, input.committedFiles)
      ).slice(-maxFiles);
    }
  } else {
    files = [...input.liveFiles];
  }

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
