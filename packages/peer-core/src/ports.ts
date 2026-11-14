import type {
  ChatMessageEnvelope,
  ClientSignalingFrame,
  ErrorCode,
  FileManifest,
  IceServerConfig,
  PeerIdentityCert,
  ServerSignalingFrame,
  SignalingInnerPayload,
} from "@simpleim/contracts";
import type { DerivedRoomKeys, Ed25519KeyPair } from "@simpleim/crypto";

export class SignalingServerError extends Error {
  readonly code: ErrorCode;
  readonly roomId?: string;

  constructor(code: ErrorCode, serverMessage: string, roomId?: string) {
    super(`Signaling error [${code}]: ${serverMessage}`);
    this.name = "SignalingServerError";
    this.code = code;
    if (roomId !== undefined) {
      this.roomId = roomId;
    }
  }
}

export type ChannelReadyState = "connecting" | "open" | "closing" | "closed";

export type PeerTransportState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface DataChannelPort {
  readonly id: number;
  readonly label: string;
  readonly readyState: ChannelReadyState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: unknown) => void): void;
  onTextMessage(handler: (text: string) => void): void;
  onBinaryMessage(handler: (bytes: Uint8Array) => void): void;
  onBufferedAmountLow(handler: () => void): void;
}

export interface PeerConnectionPort {
  readonly remotePeerId: string;
  readonly isInitiator: boolean;
  readonly state: PeerTransportState;
  readonly controlChannel: DataChannelPort;
  readonly swarmChannel: DataChannelPort;
  createOffer(): Promise<string>;
  acceptOfferAndCreateAnswer(offerSdp: string): Promise<string>;
  acceptAnswer(answerSdp: string): Promise<void>;
  addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): Promise<void>;
  endIceCandidates(): Promise<void>;
  getLocalDtlsFingerprint(): string;
  getRemoteDtlsFingerprint(): string;
  onLocalIceCandidate(
    handler: (
      candidate: Extract<SignalingInnerPayload, { kind: "ice-candidate" }>,
    ) => void,
  ): void;
  onLocalIceEnd(handler: () => void): void;
  onStateChange(handler: (state: PeerTransportState) => void): void;
  close(): void;
}

export interface PeerTransportFactoryPort {
  createPeerConnection(params: {
    localPeerId: string;
    remotePeerId: string;
    isInitiator: boolean;
    iceServers: IceServerConfig[];
  }): PeerConnectionPort;
}

export interface SignalingClientPort {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  send(frame: ClientSignalingFrame): void;
  disconnect(): void;
  onServerFrame(handler: (frame: ServerSignalingFrame) => void): void;
  onConnectionChange(handler: (connected: boolean) => void): void;
}

export interface ChunkStoragePort {
  initReceivingFile(
    manifest: FileManifest,
  ): Promise<{ existingBitfield: Uint8Array }>;
  registerSeedingFile(params: {
    manifest: FileManifest;
    readLocalChunk: (
      chunkIndex: number,
      offset: number,
      length: number,
    ) => Promise<Uint8Array>;
  }): Promise<void>;
  writeVerifiedChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
  ): Promise<void>;
  readChunk(
    fileId: string,
    chunkIndex: number,
    expectedLength: number,
  ): Promise<Uint8Array>;
  finalizeFile(fileId: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface VerifiedPeerInfo {
  peerId: string;
  userId: string;
  username: string;
  displayName: string;
  clientKind: "web" | "cli";
  rttMs: number | null;
  connectedAt: number;
}

export type TransferStatus =
  | "announced"
  | "downloading"
  | "seeding"
  | "paused"
  | "error";

export interface SwarmTransferProgress {
  fileId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  completedChunks: number;
  bytesCompleted: number;
  downloadSpeedBytesPerSec: number;
  availableSeeders: number;
  availablePeersWithChunks: number;
  status: TransferStatus;
  errorMessage?: string;
}

export interface RoomPeerEngineEvents {
  onCenterConnectionChange?: (connected: boolean) => void;
  onPeersChange?: (peers: VerifiedPeerInfo[]) => void;
  onPeerAuthRejected?: (remotePeerId: string, reason: string) => void;
  onChatMessage?: (message: ChatMessageEnvelope, isHistoricalSync: boolean) => void;
  onFileAnnounced?: (manifest: FileManifest) => void;
  onTransferProgress?: (progress: SwarmTransferProgress) => void;
  onTransferCompleted?: (manifest: FileManifest) => void;
  onError?: (error: Error) => void;
}

export interface RoomPeerEngineOptions {
  localPeerId: string;
  localCert: PeerIdentityCert;
  localSignKeyPair: Ed25519KeyPair;
  serverSignPubKey: string;
  roomKeys: DerivedRoomKeys;
  iceServers: IceServerConfig[];
  signaling: SignalingClientPort;
  transportFactory: PeerTransportFactoryPort;
  chunkStorage: ChunkStoragePort;
  events?: RoomPeerEngineEvents;
  maxInFlightPerPeer?: number;
  requestTimeoutMs?: number;
  helloAuthTimeoutMs?: number;
  maxSignalPayloadBytes?: number;
  now?: () => number;
}

export interface ShareFileInput {
  fileName: string;
  fileSize: number;
  mimeType?: string;
  readChunk: (
    chunkIndex: number,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
}

export interface RoomPeerEngine {
  readonly roomId: string;
  readonly localPeerId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isCenterConnected(): boolean;
  getVerifiedPeers(): VerifiedPeerInfo[];
  getMessages(): ChatMessageEnvelope[];
  getFiles(): FileManifest[];
  getTransferProgress(fileId: string): SwarmTransferProgress | undefined;
  sendChatMessage(
    body: string,
    replyToMsgId?: string | null,
  ): Promise<ChatMessageEnvelope>;
  shareFile(input: ShareFileInput): Promise<FileManifest>;
  downloadFile(fileId: string): Promise<void>;
  cancelDownload(fileId: string): Promise<void>;
}
