import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";

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
