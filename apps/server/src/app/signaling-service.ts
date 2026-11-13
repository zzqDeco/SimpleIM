import {
  isValidPeerId,
  isValidRoomIdHex,
  MAX_PEERS_PER_ROOM,
  type EncryptedEnvelope,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import {
  DomainError,
  type ClockPort,
  type RateLimiterPort,
  type RateLimitRule,
  type SignalingConnectionHandle,
  type SignalingPeer,
} from "../domain/index.ts";

export const DEFAULT_MAX_ROOMS_PER_CONNECTION = 8;

export const DEFAULT_WS_FRAME_RATE_LIMIT: RateLimitRule = {
  capacity: 120,
  refillPerSecond: 60,
};

export interface SignalingServiceDependencies {
  readonly rateLimiter: RateLimiterPort;
  readonly clock: ClockPort;
  readonly maxPeersPerRoom?: number;
  readonly maxRoomsPerConnection?: number;
  readonly wsFrameRateLimit?: RateLimitRule;
}

export class SignalingService {
  private readonly rooms = new Map<
    string,
    Map<string, SignalingConnectionHandle>
  >();
  private readonly connections = new Map<string, SignalingPeer>();
  private readonly peerIdToConnectionId = new Map<string, string>();

  private readonly rateLimiter: RateLimiterPort;
  private readonly clock: ClockPort;
  private readonly maxPeersPerRoom: number;
  private readonly maxRoomsPerConnection: number;
  private readonly wsFrameRateLimit: RateLimitRule;

  constructor(deps: SignalingServiceDependencies) {
    this.rateLimiter = deps.rateLimiter;
    this.clock = deps.clock;
    this.maxPeersPerRoom = deps.maxPeersPerRoom ?? MAX_PEERS_PER_ROOM;
    this.maxRoomsPerConnection =
      deps.maxRoomsPerConnection ?? DEFAULT_MAX_ROOMS_PER_CONNECTION;
    this.wsFrameRateLimit = deps.wsFrameRateLimit ?? DEFAULT_WS_FRAME_RATE_LIMIT;
  }

  getActiveRoomCount(): number {
    return this.rooms.size;
  }

  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  canClaimPeerId(peerId: string, userId: string): boolean {
    const existingConnId = this.peerIdToConnectionId.get(peerId);
    if (!existingConnId) {
      return true;
    }
    const existingPeer = this.connections.get(existingConnId);
    if (!existingPeer) {
      return true;
    }
    return existingPeer.userId === userId;
  }

  registerConnection(handle: SignalingConnectionHandle): void {
    const existingConnId = this.peerIdToConnectionId.get(handle.peerId);
    if (existingConnId && existingConnId !== handle.connectionId) {
      const existingPeer = this.connections.get(existingConnId);
      if (existingPeer) {
        if (existingPeer.userId !== handle.userId) {
          throw new DomainError("unauthorized", "peerId is already active");
        }
        this.disconnectPeer(existingConnId);
        safeCloseHandle(existingPeer.handle, 1000, "Superseded by reconnect");
      }
    }

    const peer: SignalingPeer = {
      connectionId: handle.connectionId,
      peerId: handle.peerId,
      userId: handle.userId,
      clientKind: handle.clientKind,
      connectedAt: this.clock.nowMs(),
      joinedRooms: new Set<string>(),
      handle,
    };
    this.connections.set(handle.connectionId, peer);
    this.peerIdToConnectionId.set(handle.peerId, handle.connectionId);
  }

  joinRoom(connectionId: string, roomId: string): void {
    this.enforceConnectionRateLimit(connectionId);
    const peer = this.requireConnection(connectionId);

    if (!isValidRoomIdHex(roomId)) {
      throw new DomainError("invalid_frame", "Invalid roomId");
    }

    if (peer.joinedRooms.has(roomId)) {
      const currentRoom = this.rooms.get(roomId);
      const otherPeers: string[] = [];
      if (currentRoom) {
        for (const existingPeerId of currentRoom.keys()) {
          if (existingPeerId !== peer.peerId) {
            otherPeers.push(existingPeerId);
          }
        }
      }
      safeSendFrame(peer.handle, {
        type: "room.joined",
        roomId,
        selfPeerId: peer.peerId,
        peers: otherPeers,
      });
      return;
    }

    if (peer.joinedRooms.size >= this.maxRoomsPerConnection) {
      throw new DomainError(
        "room_limit_exceeded",
        `Cannot join more than ${this.maxRoomsPerConnection} rooms per connection`,
      );
    }

    let roomMap = this.rooms.get(roomId);
    if (roomMap && roomMap.size >= this.maxPeersPerRoom) {
      throw new DomainError("room_full", "Room has reached maximum capacity");
    }

    if (!roomMap) {
      roomMap = new Map<string, SignalingConnectionHandle>();
      this.rooms.set(roomId, roomMap);
    }

    const existingPeers = Array.from(roomMap.keys());
    roomMap.set(peer.peerId, peer.handle);
    peer.joinedRooms.add(roomId);

    safeSendFrame(peer.handle, {
      type: "room.joined",
      roomId,
      selfPeerId: peer.peerId,
      peers: existingPeers,
    });

    const joinedAnnouncement: ServerSignalingFrame = {
      type: "room.peer_joined",
      roomId,
      peerId: peer.peerId,
    };
    for (const [otherPeerId, otherHandle] of roomMap.entries()) {
      if (otherPeerId !== peer.peerId) {
        safeSendFrame(otherHandle, joinedAnnouncement);
      }
    }
  }

  leaveRoom(connectionId: string, roomId: string): void {
    this.enforceConnectionRateLimit(connectionId);
    const peer = this.requireConnection(connectionId);

    if (!isValidRoomIdHex(roomId)) {
      throw new DomainError("invalid_frame", "Invalid roomId");
    }

    if (!peer.joinedRooms.has(roomId)) {
      return;
    }

    peer.joinedRooms.delete(roomId);
    this.removePeerFromRoomMap(roomId, peer.peerId, connectionId);
  }

  disconnectPeer(connectionId: string): void {
    const peer = this.connections.get(connectionId);
    if (!peer) {
      return;
    }

    this.connections.delete(connectionId);
    if (this.peerIdToConnectionId.get(peer.peerId) === connectionId) {
      this.peerIdToConnectionId.delete(peer.peerId);
    }
    this.rateLimiter.resetKey(`ws:frame:${connectionId}`);

    const joinedRoomIds = Array.from(peer.joinedRooms);
    peer.joinedRooms.clear();

    for (const roomId of joinedRoomIds) {
      this.removePeerFromRoomMap(roomId, peer.peerId, connectionId);
    }
  }

  relaySignal(
    connectionId: string,
    roomId: string,
    toPeerId: string,
    envelope: EncryptedEnvelope,
  ): void {
    this.enforceConnectionRateLimit(connectionId);
    const peer = this.requireConnection(connectionId);

    if (!isValidRoomIdHex(roomId) || !isValidPeerId(toPeerId)) {
      throw new DomainError("invalid_frame", "Invalid roomId or toPeerId");
    }

    const fromPeerId = peer.peerId;
    if (fromPeerId === toPeerId) {
      throw new DomainError("invalid_frame", "Cannot relay signal to self");
    }

    const roomMap = this.rooms.get(roomId);
    if (!roomMap || roomMap.get(fromPeerId)?.connectionId !== connectionId) {
      throw new DomainError(
        "invalid_frame",
        "Sender peer has not joined the target room",
      );
    }

    const recipientHandle = roomMap.get(toPeerId);
    if (!recipientHandle) {
      throw new DomainError("not_found", "Recipient peer is not in the room");
    }

    safeSendFrame(recipientHandle, {
      type: "signal.deliver",
      roomId,
      fromPeerId,
      envelope,
    });
  }

  private removePeerFromRoomMap(
    roomId: string,
    peerId: string,
    connectionId: string,
  ): void {
    const roomMap = this.rooms.get(roomId);
    if (!roomMap) {
      return;
    }

    const currentHandle = roomMap.get(peerId);
    if (!currentHandle || currentHandle.connectionId !== connectionId) {
      if (roomMap.size === 0) {
        this.rooms.delete(roomId);
      }
      return;
    }

    roomMap.delete(peerId);
    if (roomMap.size === 0) {
      this.rooms.delete(roomId);
      return;
    }

    const leftFrame: ServerSignalingFrame = {
      type: "room.peer_left",
      roomId,
      peerId,
    };
    for (const otherHandle of roomMap.values()) {
      safeSendFrame(otherHandle, leftFrame);
    }
  }

  private enforceConnectionRateLimit(connectionId: string): void {
    const ok = this.rateLimiter.consume(
      `ws:frame:${connectionId}`,
      this.wsFrameRateLimit,
      this.clock.nowMs(),
    );
    if (!ok) {
      throw new DomainError(
        "rate_limited",
        "Signaling frame rate limit exceeded",
      );
    }
  }

  private requireConnection(connectionId: string): SignalingPeer {
    const peer = this.connections.get(connectionId);
    if (!peer) {
      throw new DomainError("unauthorized", "Signaling connection not active");
    }
    return peer;
  }
}

function safeSendFrame(
  handle: SignalingConnectionHandle,
  frame: ServerSignalingFrame,
): void {
  try {
    handle.send(frame);
  } catch {
    // Ignore transient send errors on closing sockets; ws close hook cleans up membership.
  }
}

function safeCloseHandle(
  handle: SignalingConnectionHandle,
  code: number,
  reason: string,
): void {
  try {
    handle.close(code, reason);
  } catch {
    // Ignore errors when closing an already closed socket.
  }
}
