import type { ChatMessageEnvelope } from "@simpleim/contracts";

export const MAX_ACTIVE_MESH_ROOMS = 8;

export type RoomMeshConnectionStatus = "connected" | "detached" | "standby";

export interface RoomSummaryInput {
  readonly roomId: string;
  readonly roomIdPrefix: string;
  readonly alias: string | null;
  readonly pinned: boolean;
  readonly joinedAt: number;
  readonly lastActiveAt: number;
  readonly lastReadAt: number;
  readonly messages: readonly ChatMessageEnvelope[];
  readonly peerCount: number;
  readonly fileCount: number;
  readonly connectionStatus: RoomMeshConnectionStatus;
}

export interface RoomSummaryItem {
  readonly roomId: string;
  readonly roomIdPrefix: string;
  readonly alias: string | null;
  readonly pinned: boolean;
  readonly joinedAt: number;
  readonly lastActiveAt: number;
  readonly unreadCount: number;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAuthor: string | null;
  readonly peerCount: number;
  readonly fileCount: number;
  readonly connectionStatus: RoomMeshConnectionStatus;
}

export function computeUnreadCount(
  messages: readonly ChatMessageEnvelope[],
  lastReadAt: number,
  currentUserId: string,
): number {
  let count = 0;
  for (const msg of messages) {
    if (
      msg.createdAt > lastReadAt &&
      msg.authorCert.payload.userId !== currentUserId
    ) {
      count += 1;
    }
  }
  return count;
}

function summarizeMessagePreview(body: string, maxChars = 48): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

export function compareRoomOrder(
  a: Pick<RoomSummaryInput, "roomId" | "pinned" | "lastActiveAt" | "joinedAt">,
  b: Pick<RoomSummaryInput, "roomId" | "pinned" | "lastActiveAt" | "joinedAt">,
): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.lastActiveAt !== b.lastActiveAt) {
    return b.lastActiveAt - a.lastActiveAt;
  }
  if (a.joinedAt !== b.joinedAt) {
    return b.joinedAt - a.joinedAt;
  }
  return a.roomId.localeCompare(b.roomId);
}

export function buildSortedRoomSummaries(
  inputs: readonly RoomSummaryInput[],
  currentUserId: string,
): RoomSummaryItem[] {
  const sorted = [...inputs].sort(compareRoomOrder);
  return sorted.map((item) => {
    const lastMsg =
      item.messages.length > 0
        ? item.messages[item.messages.length - 1]
        : undefined;
    return {
      roomId: item.roomId,
      roomIdPrefix: item.roomIdPrefix,
      alias: item.alias,
      pinned: item.pinned,
      joinedAt: item.joinedAt,
      lastActiveAt: item.lastActiveAt,
      unreadCount: computeUnreadCount(
        item.messages,
        item.lastReadAt,
        currentUserId,
      ),
      lastMessagePreview: lastMsg
        ? summarizeMessagePreview(lastMsg.body)
        : null,
      lastMessageAuthor: lastMsg
        ? lastMsg.authorCert.payload.username
        : null,
      peerCount: item.peerCount,
      fileCount: item.fileCount,
      connectionStatus: item.connectionStatus,
    };
  });
}

export function selectActiveMeshRoomIds(
  sortedRoomIds: readonly string[],
  selectedRoomId: string | null,
  maxActive = MAX_ACTIVE_MESH_ROOMS,
): Set<string> {
  const active = new Set<string>();
  if (maxActive <= 0) {
    return active;
  }
  if (selectedRoomId && sortedRoomIds.includes(selectedRoomId)) {
    active.add(selectedRoomId);
  }
  for (const roomId of sortedRoomIds) {
    if (active.size >= maxActive) break;
    active.add(roomId);
  }
  return active;
}
