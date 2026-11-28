import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";
import { getFileCreatedAtMs } from "../utils/format.ts";

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
  readonly files?: readonly FileManifest[];
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
  readonly lastActivityMs: number;
  readonly unreadCount: number;
  readonly lastMessageKind: "text" | "file" | null;
  readonly lastMessagePreview: string | null;
  readonly lastMessageFileName: string | null;
  readonly lastMessageAuthor: string | null;
  readonly peerCount: number;
  readonly fileCount: number;
  readonly connectionStatus: RoomMeshConnectionStatus;
}

export function computeUnreadCount(
  messages: readonly ChatMessageEnvelope[],
  lastReadAt: number,
  currentUserId: string,
  files: readonly FileManifest[] = [],
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
  for (const file of files) {
    const fileTs = getFileCreatedAtMs(file);
    if (
      fileTs > lastReadAt &&
      file.senderCert.payload.userId !== currentUserId
    ) {
      count += 1;
    }
  }
  return count;
}

export function stripMarkdownForPreview(body: string): string {
  return body
    .replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, " $1 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeMessagePreview(body: string, maxChars = 48): string {
  const collapsed = stripMarkdownForPreview(body);
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
    const files = item.files ?? [];
    const lastMsg =
      item.messages.length > 0
        ? item.messages[item.messages.length - 1]
        : undefined;
    let latestFile: FileManifest | undefined;
    let latestFileTs = -1;
    for (const file of files) {
      const ts = getFileCreatedAtMs(file);
      if (ts >= latestFileTs) {
        latestFileTs = ts;
        latestFile = file;
      }
    }

    const lastMsgTs = lastMsg?.createdAt ?? -1;
    let lastMessageKind: "text" | "file" | null = null;
    let lastMessagePreview: string | null = null;
    let lastMessageFileName: string | null = null;
    let lastMessageAuthor: string | null = null;
    let latestContentTs = 0;

    if (latestFile && latestFileTs > lastMsgTs) {
      lastMessageKind = "file";
      lastMessageFileName = latestFile.fileName;
      lastMessageAuthor = latestFile.senderCert.payload.username;
      latestContentTs = Math.max(0, latestFileTs);
    } else if (lastMsg) {
      lastMessageKind = "text";
      lastMessagePreview = summarizeMessagePreview(lastMsg.body);
      lastMessageAuthor = lastMsg.authorCert.payload.username;
      latestContentTs = Math.max(0, lastMsgTs);
    }

    return {
      roomId: item.roomId,
      roomIdPrefix: item.roomIdPrefix,
      alias: item.alias,
      pinned: item.pinned,
      joinedAt: item.joinedAt,
      lastActiveAt: item.lastActiveAt,
      lastActivityMs: Math.max(item.lastActiveAt, latestContentTs),
      unreadCount: computeUnreadCount(
        item.messages,
        item.lastReadAt,
        currentUserId,
        files,
      ),
      lastMessageKind,
      lastMessagePreview,
      lastMessageFileName,
      lastMessageAuthor,
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
