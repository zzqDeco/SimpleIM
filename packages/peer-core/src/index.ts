export * from "./ports.ts";

import type { RoomPeerEngine, RoomPeerEngineOptions } from "./ports.ts";

export function createRoomPeerEngine(_options: RoomPeerEngineOptions): RoomPeerEngine {
  throw new Error("RoomPeerEngine implementation pending Phase 3");
}
