import type {
  ClientKind,
  ServerSignalingFrame,
  UserProfile,
} from "@simpleim/contracts";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: number;
}

export function toUserProfile(user: User): UserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly tokenSha256: Uint8Array;
  readonly clientKind: ClientKind;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
}

export interface AuthenticatedSession {
  readonly session: Session;
  readonly user: User;
  readonly rawToken: string;
  readonly expectedCsrfToken: string;
}

export interface SignalingConnectionHandle {
  readonly connectionId: string;
  readonly peerId: string;
  readonly userId: string;
  readonly clientKind: ClientKind;
  send(frame: ServerSignalingFrame): void;
  close(code?: number, reason?: string): void;
}

export interface SignalingPeer {
  readonly connectionId: string;
  readonly peerId: string;
  readonly userId: string;
  readonly clientKind: ClientKind;
  readonly connectedAt: number;
  readonly joinedRooms: Set<string>;
  readonly handle: SignalingConnectionHandle;
}
