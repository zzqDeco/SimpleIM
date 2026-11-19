import {
  CONTROL_CHANNEL_ID,
  CONTROL_CHANNEL_LABEL,
  createBitfield,
  DEFAULT_RELAY_MAX_FILE_BYTES,
  DEFAULT_RELAY_TTL_MS,
  isValidRelayBlobId,
  isValidRelayBoxId,
  MAX_RELAY_CHUNK_CIPHERTEXT_BYTES,
  MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_RELAY_LIST_LIMIT,
  setChunkInBitfield,
  SWARM_CHANNEL_ID,
  SWARM_CHANNEL_LABEL,
  SWARM_CHUNK_SIZE,
  type ClientSignalingFrame,
  type FileManifest,
  type IceServerConfig,
  type ServerSignalingFrame,
  type SignalingInnerPayload,
} from "@simpleim/contracts";
import {
  extractSdpSha256Fingerprint,
  sha256Hex,
} from "@simpleim/crypto";
import type {
  BlindRelayClientPort,
  BlindRelayListedEnvelope,
  ChannelReadyState,
  ChunkStoragePort,
  DataChannelPort,
  PeerConnectionPort,
  PeerTransportFactoryPort,
  PeerTransportState,
  SignalingClientPort,
} from "../src/index.ts";

export function makeDeterministicFingerprint(label: string): string {
  const hex = sha256Hex(`mock-dtls-fp:${label}`).toUpperCase();
  const pairs: string[] = [];
  for (let i = 0; i < 64; i += 2) {
    pairs.push(hex.slice(i, i + 2));
  }
  return pairs.join(":");
}

const SDP_MOCK_CONN_RE = /^a=x-mock-conn:([^\r\n]+)$/m;

function buildMockSdp(
  kind: "offer" | "answer",
  connId: string,
  fingerprint: string,
): string {
  return [
    "v=0",
    `o=- 1 1 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=setup:${kind === "offer" ? "actpass" : "active"}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=x-mock-conn:${connId}`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "",
  ].join("\r\n");
}

function extractMockConnId(sdp: string): string {
  const match = SDP_MOCK_CONN_RE.exec(sdp);
  const id = match?.[1]?.trim();
  if (!id) {
    throw new Error("Mock SDP missing a=x-mock-conn attribute");
  }
  return id;
}

export interface MockSignalingClientOptions {
  interceptOutgoing?: (
    frame: ClientSignalingFrame,
    defaultSend: (f: ClientSignalingFrame) => void,
  ) => void;
}

export class MockSignalingClient implements SignalingClientPort {
  readonly peerId: string;
  private readonly hub: MockSignalingHub;
  private readonly options?: MockSignalingClientOptions;
  private connected = false;
  private readonly serverFrameHandlers: Array<
    (frame: ServerSignalingFrame) => void
  > = [];
  private readonly connectionHandlers: Array<(connected: boolean) => void> = [];

  constructor(
    hub: MockSignalingHub,
    peerId: string,
    options?: MockSignalingClientOptions,
  ) {
    this.hub = hub;
    this.peerId = peerId;
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    await Promise.resolve();
    if (!this.hub.isOnline) {
      throw new Error("Center signaling server is offline");
    }
    if (this.connected) return;
    this.connected = true;
    this.hub.registerClient(this);
    for (const h of this.connectionHandlers) {
      h(true);
    }
  }

  send(frame: ClientSignalingFrame): void {
    if (!this.connected || !this.hub.isOnline) {
      throw new Error("Signaling WebSocket is not connected");
    }
    if (this.options?.interceptOutgoing) {
      this.options.interceptOutgoing(frame, (f) =>
        this.hub.handleClientFrame(this.peerId, f),
      );
      return;
    }
    this.hub.handleClientFrame(this.peerId, frame);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.hub.unregisterClient(this.peerId, true);
    for (const h of this.connectionHandlers) {
      h(false);
    }
  }

  forceServerDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const h of this.connectionHandlers) {
      h(false);
    }
  }

  deliverFromServer(frame: ServerSignalingFrame): void {
    if (!this.connected) return;
    queueMicrotask(() => {
      if (!this.connected) return;
      for (const h of this.serverFrameHandlers) {
        h(frame);
      }
    });
  }

  onServerFrame(handler: (frame: ServerSignalingFrame) => void): void {
    this.serverFrameHandlers.push(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }
}

export class MockSignalingHub {
  isOnline = true;
  private readonly clients = new Map<string, MockSignalingClient>();
  private readonly rooms = new Map<string, Set<string>>();

  createClient(
    peerId: string,
    options?: MockSignalingClientOptions,
  ): MockSignalingClient {
    return new MockSignalingClient(this, peerId, options);
  }

  registerClient(client: MockSignalingClient): void {
    this.clients.set(client.peerId, client);
  }

  unregisterClient(peerId: string, notifyRoomPeers: boolean): void {
    this.clients.delete(peerId);
    for (const [roomId, members] of this.rooms.entries()) {
      if (members.delete(peerId)) {
        if (notifyRoomPeers && this.isOnline) {
          for (const otherPeerId of members) {
            this.clients.get(otherPeerId)?.deliverFromServer({
              type: "room.peer_left",
              roomId,
              peerId,
            });
          }
        }
        if (members.size === 0) {
          this.rooms.delete(roomId);
        }
      }
    }
  }

  handleClientFrame(fromPeerId: string, frame: ClientSignalingFrame): void {
    if (!this.isOnline) return;
    const sender = this.clients.get(fromPeerId);
    if (!sender) return;

    switch (frame.type) {
      case "room.join": {
        let members = this.rooms.get(frame.roomId);
        if (!members) {
          members = new Set();
          this.rooms.set(frame.roomId, members);
        }
        const existingPeers = Array.from(members).filter(
          (p) => p !== fromPeerId,
        );
        const alreadyIn = members.has(fromPeerId);
        members.add(fromPeerId);

        sender.deliverFromServer({
          type: "room.joined",
          roomId: frame.roomId,
          selfPeerId: fromPeerId,
          peers: existingPeers,
        });

        if (!alreadyIn) {
          for (const otherId of existingPeers) {
            this.clients.get(otherId)?.deliverFromServer({
              type: "room.peer_joined",
              roomId: frame.roomId,
              peerId: fromPeerId,
            });
          }
        }
        break;
      }
      case "room.leave": {
        const members = this.rooms.get(frame.roomId);
        if (members?.delete(fromPeerId)) {
          for (const otherId of members) {
            this.clients.get(otherId)?.deliverFromServer({
              type: "room.peer_left",
              roomId: frame.roomId,
              peerId: fromPeerId,
            });
          }
          if (members.size === 0) {
            this.rooms.delete(frame.roomId);
          }
        }
        break;
      }
      case "signal.relay": {
        const members = this.rooms.get(frame.roomId);
        if (!members || !members.has(fromPeerId) || !members.has(frame.toPeerId)) {
          return;
        }
        this.clients.get(frame.toPeerId)?.deliverFromServer({
          type: "signal.deliver",
          roomId: frame.roomId,
          fromPeerId,
          envelope: frame.envelope,
        });
        break;
      }
    }
  }

  shutdownCenterServer(): void {
    this.isOnline = false;
    this.rooms.clear();
    const connectedClients = Array.from(this.clients.values());
    this.clients.clear();
    for (const c of connectedClients) {
      c.forceServerDisconnect();
    }
  }

  restartCenterServer(): void {
    this.isOnline = true;
  }
}

export interface MockDataChannelStats {
  peakBufferedAmount: number;
  bufferedAmountLowEvents: number;
  binaryFramesSent: number;
  textFramesSent: number;
}

export class MockDataChannel implements DataChannelPort {
  readonly id: number;
  readonly label: string;
  readyState: ChannelReadyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;

  readonly stats: MockDataChannelStats = {
    peakBufferedAmount: 0,
    bufferedAmountLowEvents: 0,
    binaryFramesSent: 0,
    textFramesSent: 0,
  };

  private peerChannel: MockDataChannel | null = null;
  private readonly flushDelayMs: number;
  private readonly openHandlers: Array<() => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(err: unknown) => void> = [];
  private readonly textHandlers: Array<(text: string) => void> = [];
  private readonly binaryHandlers: Array<(bytes: Uint8Array) => void> = [];
  private readonly bufferedLowHandlers: Array<() => void> = [];
  private binaryInterceptor?: (bytes: Uint8Array) => Uint8Array | null;
  private textInterceptor?: (text: string) => string | null;
  private readonly maxTextBytes?: number;

  constructor(
    id: number,
    label: string,
    flushDelayMs = 0,
    maxTextBytes?: number,
  ) {
    this.id = id;
    this.label = label;
    this.flushDelayMs = flushDelayMs;
    this.maxTextBytes = maxTextBytes;
  }

  linkPeer(remote: MockDataChannel): void {
    this.peerChannel = remote;
  }

  setBinaryOutgoingInterceptor(
    fn: ((bytes: Uint8Array) => Uint8Array | null) | undefined,
  ): void {
    this.binaryInterceptor = fn;
  }

  setTextOutgoingInterceptor(
    fn: ((text: string) => string | null) | undefined,
  ): void {
    this.textInterceptor = fn;
  }

  openChannel(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    for (const h of this.openHandlers) {
      h();
    }
  }

  sendText(text: string): void {
    if (this.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    const outgoing = this.textInterceptor ? this.textInterceptor(text) : text;
    if (outgoing === null) {
      return;
    }
    const byteLen = new TextEncoder().encode(outgoing).byteLength;
    if (this.maxTextBytes !== undefined && byteLen > this.maxTextBytes) {
      throw new TypeError(
        `Message size (${byteLen}) exceeds maxMessageSize (${this.maxTextBytes})`,
      );
    }
    this.bufferedAmount += byteLen;
    if (this.bufferedAmount > this.stats.peakBufferedAmount) {
      this.stats.peakBufferedAmount = this.bufferedAmount;
    }
    this.stats.textFramesSent += 1;

    const remote = this.peerChannel;
    this.scheduleFlush(byteLen, () => {
      if (remote && remote.readyState === "open") {
        for (const h of remote.textHandlers) {
          h(outgoing);
        }
      }
    });
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    const outgoing = this.binaryInterceptor
      ? this.binaryInterceptor(bytes.slice())
      : bytes.slice();
    if (outgoing === null) {
      return;
    }

    const byteLen = outgoing.byteLength;
    this.bufferedAmount += byteLen;
    if (this.bufferedAmount > this.stats.peakBufferedAmount) {
      this.stats.peakBufferedAmount = this.bufferedAmount;
    }
    this.stats.binaryFramesSent += 1;

    const remote = this.peerChannel;
    this.scheduleFlush(byteLen, () => {
      if (remote && remote.readyState === "open") {
        for (const h of remote.binaryHandlers) {
          h(outgoing);
        }
      }
    });
  }

  private scheduleFlush(byteLen: number, deliver: () => void): void {
    const complete = () => {
      const prev = this.bufferedAmount;
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLen);
      deliver();
      if (
        this.readyState === "open" &&
        prev > this.bufferedAmountLowThreshold &&
        this.bufferedAmount <= this.bufferedAmountLowThreshold
      ) {
        this.stats.bufferedAmountLowEvents += 1;
        for (const h of this.bufferedLowHandlers) {
          h();
        }
      }
    };

    if (this.flushDelayMs > 0) {
      setTimeout(complete, this.flushDelayMs);
    } else {
      queueMicrotask(complete);
    }
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const h of this.closeHandlers) {
      h();
    }
    const remote = this.peerChannel;
    this.peerChannel = null;
    if (remote && remote.readyState !== "closed") {
      queueMicrotask(() => remote.close());
    }
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  onError(handler: (err: unknown) => void): void {
    this.errorHandlers.push(handler);
  }
  onTextMessage(handler: (text: string) => void): void {
    this.textHandlers.push(handler);
  }
  onBinaryMessage(handler: (bytes: Uint8Array) => void): void {
    this.binaryHandlers.push(handler);
  }
  onBufferedAmountLow(handler: () => void): void {
    this.bufferedLowHandlers.push(handler);
  }
}

export interface MockPeerConnectionConfig {
  swarmFlushDelayMs?: number;
  maxControlTextBytes?: number;
  overrideLocalFingerprint?: string;
  overrideRemoteFingerprint?: string;
  autoOpenChannels?: boolean;
  failIceOnAcceptAnswer?: boolean;
  failInitiatorOnlyOnAcceptAnswer?: boolean;
}

export class MockPeerConnection implements PeerConnectionPort {
  readonly connId: string;
  readonly localPeerId: string;
  readonly remotePeerId: string;
  readonly isInitiator: boolean;
  state: PeerTransportState = "new";
  readonly controlChannel: MockDataChannel;
  readonly swarmChannel: MockDataChannel;

  readonly receivedIceCandidates: Array<{
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }> = [];
  iceEnded = false;

  private readonly network: MockPeerTransportNetwork;
  private readonly config?: MockPeerConnectionConfig;
  private readonly localFingerprint: string;
  private remoteFingerprint: string | null = null;
  private linkedRemotePc: MockPeerConnection | null = null;

  private readonly localIceHandlers: Array<
    (
      candidate: Extract<SignalingInnerPayload, { kind: "ice-candidate" }>,
    ) => void
  > = [];
  private readonly localIceEndHandlers: Array<() => void> = [];
  private readonly stateHandlers: Array<(state: PeerTransportState) => void> =
    [];

  constructor(params: {
    connId: string;
    network: MockPeerTransportNetwork;
    localPeerId: string;
    remotePeerId: string;
    isInitiator: boolean;
    config?: MockPeerConnectionConfig;
  }) {
    this.connId = params.connId;
    this.network = params.network;
    this.localPeerId = params.localPeerId;
    this.remotePeerId = params.remotePeerId;
    this.isInitiator = params.isInitiator;
    this.config = params.config;
    this.localFingerprint =
      params.config?.overrideLocalFingerprint ??
      makeDeterministicFingerprint(`${params.localPeerId}:${params.connId}`);

    this.controlChannel = new MockDataChannel(
      CONTROL_CHANNEL_ID,
      CONTROL_CHANNEL_LABEL,
      0,
      params.config?.maxControlTextBytes,
    );
    this.swarmChannel = new MockDataChannel(
      SWARM_CHANNEL_ID,
      SWARM_CHANNEL_LABEL,
      params.config?.swarmFlushDelayMs ?? 0,
    );
  }

  async createOffer(): Promise<string> {
    this.setState("connecting");
    this.emitTrickleIce();
    await Promise.resolve();
    return buildMockSdp("offer", this.connId, this.localFingerprint);
  }

  async acceptOfferAndCreateAnswer(offerSdp: string): Promise<string> {
    this.setState("connecting");
    const offerFp = extractSdpSha256Fingerprint(offerSdp);
    const offerConnId = extractMockConnId(offerSdp);
    this.remoteFingerprint =
      this.config?.overrideRemoteFingerprint ?? offerFp;

    const offerPc = this.network.getConnection(offerConnId);
    if (offerPc) {
      this.linkedRemotePc = offerPc;
      offerPc.linkedRemotePc = this;
      this.controlChannel.linkPeer(offerPc.controlChannel);
      offerPc.controlChannel.linkPeer(this.controlChannel);
      this.swarmChannel.linkPeer(offerPc.swarmChannel);
      offerPc.swarmChannel.linkPeer(this.swarmChannel);
    }

    this.emitTrickleIce();
    await Promise.resolve();
    return buildMockSdp("answer", this.connId, this.localFingerprint);
  }

  async acceptAnswer(answerSdp: string): Promise<void> {
    const answerFp = extractSdpSha256Fingerprint(answerSdp);
    this.remoteFingerprint =
      this.config?.overrideRemoteFingerprint ?? answerFp;
    await Promise.resolve();

    if (this.state === "closed") return;
    if (
      this.config?.failIceOnAcceptAnswer ||
      this.config?.failInitiatorOnlyOnAcceptAnswer
    ) {
      const remote = this.linkedRemotePc;
      this.linkedRemotePc = null;
      if (remote) {
        remote.linkedRemotePc = null;
      }
      this.setState("failed");
      if (this.config?.failIceOnAcceptAnswer) {
        remote?.setState("failed");
      }
      return;
    }
    this.activateDirectLink();
    this.linkedRemotePc?.activateDirectLink();
  }

  activateDirectLink(): void {
    if (this.state === "closed") return;
    this.setState("connected");
    if (this.config?.autoOpenChannels !== false) {
      queueMicrotask(() => {
        if (this.state !== "connected") return;
        this.controlChannel.openChannel();
        this.swarmChannel.openChannel();
      });
    }
  }

  async addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): Promise<void> {
    this.receivedIceCandidates.push(candidate);
  }

  async endIceCandidates(): Promise<void> {
    this.iceEnded = true;
  }

  getLocalDtlsFingerprint(): string {
    return this.localFingerprint;
  }

  getRemoteDtlsFingerprint(): string {
    if (!this.remoteFingerprint) {
      throw new Error("Remote DTLS fingerprint not yet negotiated");
    }
    return this.remoteFingerprint;
  }

  onLocalIceCandidate(
    handler: (
      candidate: Extract<SignalingInnerPayload, { kind: "ice-candidate" }>,
    ) => void,
  ): void {
    this.localIceHandlers.push(handler);
  }

  onLocalIceEnd(handler: () => void): void {
    this.localIceEndHandlers.push(handler);
  }

  onStateChange(handler: (state: PeerTransportState) => void): void {
    this.stateHandlers.push(handler);
  }

  close(): void {
    if (this.state === "closed") return;
    this.setState("closed");
    this.controlChannel.close();
    this.swarmChannel.close();

    const remote = this.linkedRemotePc;
    this.linkedRemotePc = null;
    if (remote && remote.state !== "closed") {
      queueMicrotask(() => remote.close());
    }
  }

  private setState(next: PeerTransportState): void {
    if (this.state === next) return;
    this.state = next;
    for (const h of this.stateHandlers) {
      h(next);
    }
  }

  private emitTrickleIce(): void {
    queueMicrotask(() => {
      if (this.state === "closed") return;
      for (const h of this.localIceHandlers) {
        h({
          kind: "ice-candidate",
          candidate: `candidate:1 1 UDP 2122252543 192.168.1.10 50000 typ host`,
          sdpMid: "0",
          sdpMLineIndex: 0,
        });
      }
      for (const h of this.localIceEndHandlers) {
        h();
      }
    });
  }
}

export class MockPeerTransportNetwork {
  private seq = 0;
  private readonly connections = new Map<string, MockPeerConnection>();

  createFactory(
    configForPair?: (params: {
      localPeerId: string;
      remotePeerId: string;
      isInitiator: boolean;
    }) => MockPeerConnectionConfig | undefined,
  ): {
    factory: PeerTransportFactoryPort;
    createdConnections: MockPeerConnection[];
  } {
    const createdConnections: MockPeerConnection[] = [];

    const factory: PeerTransportFactoryPort = {
      createPeerConnection: ({
        localPeerId,
        remotePeerId,
        isInitiator,
        iceServers: _iceServers,
      }: {
        localPeerId: string;
        remotePeerId: string;
        isInitiator: boolean;
        iceServers: IceServerConfig[];
      }): PeerConnectionPort => {
        this.seq += 1;
        const connId = `pc_${this.seq}_${localPeerId}_to_${remotePeerId}`;
        const pc = new MockPeerConnection({
          connId,
          network: this,
          localPeerId,
          remotePeerId,
          isInitiator,
          config: configForPair?.({ localPeerId, remotePeerId, isInitiator }),
        });
        this.connections.set(connId, pc);
        createdConnections.push(pc);
        return pc;
      },
    };

    return { factory, createdConnections };
  }

  getConnection(connId: string): MockPeerConnection | undefined {
    return this.connections.get(connId);
  }
}

interface SeedingRecord {
  manifest: FileManifest;
  readLocalChunk: (
    chunkIndex: number,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
}

interface ReceivingRecord {
  manifest: FileManifest;
  chunks: Map<number, Uint8Array>;
  finalized: boolean;
}

export class InMemoryChunkStorage implements ChunkStoragePort {
  chunksServedCount = 0;
  chunksWrittenCount = 0;
  deletedFileIds: string[] = [];
  closed = false;

  private readonly seeding = new Map<string, SeedingRecord>();
  private readonly receiving = new Map<string, ReceivingRecord>();
  private readonly finalizedFiles = new Map<string, Uint8Array>();

  seedPartialPreExistingChunks(
    manifest: FileManifest,
    chunks: Map<number, Uint8Array>,
  ): void {
    this.receiving.set(manifest.fileId, {
      manifest,
      chunks: new Map(chunks),
      finalized: false,
    });
  }

  async initReceivingFile(
    manifest: FileManifest,
  ): Promise<{ existingBitfield: Uint8Array }> {
    let rec = this.receiving.get(manifest.fileId);
    if (!rec) {
      rec = {
        manifest,
        chunks: new Map(),
        finalized: false,
      };
      this.receiving.set(manifest.fileId, rec);
    }
    const existingBitfield = createBitfield(manifest.totalChunks);
    for (const idx of rec.chunks.keys()) {
      if (idx < manifest.totalChunks) {
        setChunkInBitfield(existingBitfield, idx);
      }
    }
    return { existingBitfield };
  }

  async registerSeedingFile(params: {
    manifest: FileManifest;
    readLocalChunk: (
      chunkIndex: number,
      offset: number,
      length: number,
    ) => Promise<Uint8Array>;
  }): Promise<void> {
    this.seeding.set(params.manifest.fileId, {
      manifest: params.manifest,
      readLocalChunk: params.readLocalChunk,
    });
  }

  async writeVerifiedChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
  ): Promise<void> {
    const rec = this.receiving.get(fileId);
    if (!rec) {
      throw new Error(`Receiving file not initialized: ${fileId}`);
    }
    this.chunksWrittenCount += 1;
    rec.chunks.set(chunkIndex, data.slice());
  }

  async readChunk(
    fileId: string,
    chunkIndex: number,
    expectedLength: number,
  ): Promise<Uint8Array> {
    this.chunksServedCount += 1;
    const seed = this.seeding.get(fileId);
    if (seed) {
      const offset = chunkIndex * SWARM_CHUNK_SIZE;
      return seed.readLocalChunk(chunkIndex, offset, expectedLength);
    }
    const rec = this.receiving.get(fileId);
    const chunk = rec?.chunks.get(chunkIndex);
    if (!chunk || chunk.byteLength !== expectedLength) {
      throw new Error(`Chunk ${chunkIndex} not available for ${fileId}`);
    }
    return chunk.slice();
  }

  async finalizeFile(fileId: string): Promise<void> {
    const rec = this.receiving.get(fileId);
    if (!rec) {
      throw new Error(`Cannot finalize uninitialized file: ${fileId}`);
    }
    const { manifest } = rec;
    const full = new Uint8Array(manifest.fileSize);
    let offset = 0;
    for (let i = 0; i < manifest.totalChunks; i++) {
      const chunk = rec.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} on finalizeFile(${fileId})`);
      }
      full.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rec.finalized = true;
    this.finalizedFiles.set(fileId, full);
  }

  async deleteFile(fileId: string): Promise<void> {
    this.deletedFileIds.push(fileId);
    this.receiving.delete(fileId);
    this.finalizedFiles.delete(fileId);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
  }

  getFinalizedBytes(fileId: string): Uint8Array | undefined {
    return this.finalizedFiles.get(fileId);
  }

  hasReceivedChunk(fileId: string, chunkIndex: number): boolean {
    return Boolean(this.receiving.get(fileId)?.chunks.has(chunkIndex));
  }
}

interface StoredRelayEnvelope {
  seq: number;
  blobId: string;
  payload: Uint8Array;
  expiresAt: number;
}

interface StoredRelayChunk {
  payload: Uint8Array;
  expiresAt: number;
}

interface StoredRelayBox {
  nextSeq: number;
  envelopesByBlobId: Map<string, StoredRelayEnvelope>;
  chunksByKey: Map<string, StoredRelayChunk>;
}

export interface MockBlindRelayHubOptions {
  ttlMs?: number;
  maxFileBytes?: number;
  now?: () => number;
}

export interface MockBlindRelayClientOptions {
  enabled?: boolean;
  maxFileBytes?: number;
  disableGetEnvelope?: boolean;
}

export class MockBlindRelayClient implements BlindRelayClientPort {
  enabled: boolean;
  readonly maxFileBytes: number;
  putEnvelopeCalls = 0;
  getEnvelopeCalls = 0;
  keepalivePutCount = 0;
  listEnvelopeCalls = 0;
  putChunkCalls = 0;
  getChunkCalls = 0;
  readonly recordedListAfterSeqs: number[] = [];
  getEnvelope?: (params: {
    boxId: string;
    blobId: string;
  }) => Promise<Uint8Array | null>;

  private readonly hub: MockBlindRelayHub;
  private remainingEnvelopePutFailures = 0;

  constructor(hub: MockBlindRelayHub, options?: MockBlindRelayClientOptions) {
    this.hub = hub;
    this.enabled = options?.enabled ?? true;
    this.maxFileBytes = options?.maxFileBytes ?? hub.maxFileBytes;
    if (!options?.disableGetEnvelope) {
      this.getEnvelope = async (params) => {
        this.getEnvelopeCalls += 1;
        await Promise.resolve();
        return this.hub.getEnvelope(params);
      };
    }
  }

  failNextEnvelopePuts(count: number): void {
    this.remainingEnvelopePutFailures = Math.max(0, Math.floor(count));
  }

  setEnvelopePutFailures(count: number): void {
    this.failNextEnvelopePuts(count);
  }

  async putEnvelope(params: {
    boxId: string;
    blobId: string;
    payload: Uint8Array;
    keepalive?: boolean;
  }): Promise<{ seq: number; expiresAt: number }> {
    this.putEnvelopeCalls += 1;
    if (params.keepalive) {
      this.keepalivePutCount += 1;
    }
    await Promise.resolve();
    if (this.remainingEnvelopePutFailures > 0) {
      this.remainingEnvelopePutFailures -= 1;
      throw new Error("Simulated transient blind relay putEnvelope failure");
    }
    return this.hub.putEnvelope(params);
  }

  async listEnvelopes(params: {
    boxId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<{
    items: BlindRelayListedEnvelope[];
    nextCursor: number;
    hasMore: boolean;
    cursorReset?: boolean;
  }> {
    this.listEnvelopeCalls += 1;
    this.recordedListAfterSeqs.push(params.afterSeq);
    await Promise.resolve();
    return this.hub.listEnvelopes(params);
  }

  async putChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    payload: Uint8Array;
  }): Promise<{ expiresAt: number }> {
    this.putChunkCalls += 1;
    await Promise.resolve();
    return this.hub.putChunk(params);
  }

  async getChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
  }): Promise<Uint8Array | null> {
    this.getChunkCalls += 1;
    await Promise.resolve();
    return this.hub.getChunk(params);
  }
}

export class MockBlindRelayHub {
  isOnline = true;
  keepalivePutCount = 0;
  readonly ttlMs: number;
  readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly boxes = new Map<string, StoredRelayBox>();
  private remainingEnvelopePutFailures = 0;

  constructor(options?: MockBlindRelayHubOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_RELAY_TTL_MS;
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_RELAY_MAX_FILE_BYTES;
    this.now = options?.now ?? (() => Date.now());
  }

  failNextEnvelopePuts(count: number): void {
    this.remainingEnvelopePutFailures = Math.max(0, Math.floor(count));
  }

  setEnvelopePutFailures(count: number): void {
    this.failNextEnvelopePuts(count);
  }

  createClient(options?: MockBlindRelayClientOptions): MockBlindRelayClient {
    return new MockBlindRelayClient(this, options);
  }

  private getOrCreateBox(boxId: string): StoredRelayBox {
    let box = this.boxes.get(boxId);
    if (!box) {
      box = {
        nextSeq: 1,
        envelopesByBlobId: new Map(),
        chunksByKey: new Map(),
      };
      this.boxes.set(boxId, box);
    }
    return box;
  }

  private purgeExpired(box: StoredRelayBox): void {
    const nowTs = this.now();
    for (const [blobId, item] of box.envelopesByBlobId.entries()) {
      if (item.expiresAt <= nowTs) {
        box.envelopesByBlobId.delete(blobId);
      }
    }
    for (const [key, chunk] of box.chunksByKey.entries()) {
      if (chunk.expiresAt <= nowTs) {
        box.chunksByKey.delete(key);
      }
    }
  }

  putEnvelope(params: {
    boxId: string;
    blobId: string;
    payload: Uint8Array;
    keepalive?: boolean;
  }): { seq: number; expiresAt: number } {
    if (params.keepalive) {
      this.keepalivePutCount += 1;
    }
    if (!this.isOnline) {
      throw new Error("Blind relay server is offline");
    }
    if (this.remainingEnvelopePutFailures > 0) {
      this.remainingEnvelopePutFailures -= 1;
      throw new Error("Simulated transient blind relay putEnvelope failure");
    }
    if (!isValidRelayBoxId(params.boxId) || !isValidRelayBlobId(params.blobId)) {
      throw new Error("Invalid relay boxId or blobId");
    }
    if (params.payload.byteLength > MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES) {
      throw new Error("Relay envelope exceeds maximum ciphertext size");
    }

    const box = this.getOrCreateBox(params.boxId);
    this.purgeExpired(box);

    const existing = box.envelopesByBlobId.get(params.blobId);
    if (existing) {
      return { seq: existing.seq, expiresAt: existing.expiresAt };
    }

    const seq = box.nextSeq++;
    const expiresAt = this.now() + this.ttlMs;
    box.envelopesByBlobId.set(params.blobId, {
      seq,
      blobId: params.blobId,
      payload: params.payload.slice(),
      expiresAt,
    });
    return { seq, expiresAt };
  }

  getEnvelope(params: {
    boxId: string;
    blobId: string;
  }): Uint8Array | null {
    if (!this.isOnline) {
      throw new Error("Blind relay server is offline");
    }
    if (!isValidRelayBoxId(params.boxId) || !isValidRelayBlobId(params.blobId)) {
      throw new Error("Invalid relay boxId or blobId");
    }
    const box = this.boxes.get(params.boxId);
    if (!box) return null;
    this.purgeExpired(box);
    const rec = box.envelopesByBlobId.get(params.blobId);
    return rec ? rec.payload.slice() : null;
  }

  listEnvelopes(params: {
    boxId: string;
    afterSeq: number;
    limit?: number;
  }): {
    items: BlindRelayListedEnvelope[];
    nextCursor: number;
    hasMore: boolean;
    cursorReset?: boolean;
  } {
    if (!this.isOnline) {
      throw new Error("Blind relay server is offline");
    }
    if (!isValidRelayBoxId(params.boxId)) {
      throw new Error("Invalid relay boxId");
    }

    const box = this.boxes.get(params.boxId);
    if (!box) {
      const cursorReset = params.afterSeq > 0;
      return {
        items: [],
        nextCursor: 0,
        hasMore: false,
        ...(cursorReset ? { cursorReset: true } : {}),
      };
    }
    this.purgeExpired(box);

    const highestIssuedSeq = box.nextSeq - 1;
    const cursorReset = params.afterSeq > highestIssuedSeq;
    const effectiveAfterSeq = cursorReset ? 0 : params.afterSeq;

    const effectiveLimit = Math.min(
      Math.max(1, params.limit ?? MAX_RELAY_LIST_LIMIT),
      MAX_RELAY_LIST_LIMIT,
    );
    const matching = Array.from(box.envelopesByBlobId.values())
      .filter((it) => it.seq > effectiveAfterSeq)
      .sort((a, b) => a.seq - b.seq);

    const page = matching.slice(0, effectiveLimit).map((it) => ({
      seq: it.seq,
      blobId: it.blobId,
      payload: it.payload.slice(),
      expiresAt: it.expiresAt,
    }));
    const hasMore = matching.length > effectiveLimit;
    const nextCursor =
      page.length > 0 ? page[page.length - 1]!.seq : effectiveAfterSeq;

    return {
      items: page,
      nextCursor,
      hasMore,
      ...(cursorReset ? { cursorReset: true } : {}),
    };
  }

  putChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
    payload: Uint8Array;
  }): { expiresAt: number } {
    if (!this.isOnline) {
      throw new Error("Blind relay server is offline");
    }
    if (
      !isValidRelayBoxId(params.boxId) ||
      !isValidRelayBlobId(params.fileTag) ||
      !isValidRelayBlobId(params.chunkBlobId)
    ) {
      throw new Error("Invalid relay chunk identifiers");
    }
    if (params.payload.byteLength > MAX_RELAY_CHUNK_CIPHERTEXT_BYTES) {
      throw new Error("Relay chunk exceeds maximum ciphertext size");
    }

    const box = this.getOrCreateBox(params.boxId);
    this.purgeExpired(box);

    const key = `${params.fileTag}:${params.chunkBlobId}`;
    const expiresAt = this.now() + this.ttlMs;
    box.chunksByKey.set(key, {
      payload: params.payload.slice(),
      expiresAt,
    });
    return { expiresAt };
  }

  getChunk(params: {
    boxId: string;
    fileTag: string;
    chunkBlobId: string;
  }): Uint8Array | null {
    if (!this.isOnline) {
      throw new Error("Blind relay server is offline");
    }
    const box = this.boxes.get(params.boxId);
    if (!box) return null;
    this.purgeExpired(box);

    const key = `${params.fileTag}:${params.chunkBlobId}`;
    const rec = box.chunksByKey.get(key);
    return rec ? rec.payload.slice() : null;
  }

  tamperChunkBytes(
    boxId: string,
    fileTag: string,
    chunkBlobId: string,
    mutator: (bytes: Uint8Array) => Uint8Array,
  ): void {
    const box = this.boxes.get(boxId);
    const key = `${fileTag}:${chunkBlobId}`;
    const rec = box?.chunksByKey.get(key);
    if (!rec) {
      throw new Error(`Relay chunk not found for tampering: ${key}`);
    }
    rec.payload = mutator(rec.payload.slice());
  }

  overwriteRawChunk(
    boxId: string,
    fileTag: string,
    chunkBlobId: string,
    rawPayload: Uint8Array,
  ): void {
    const box = this.getOrCreateBox(boxId);
    box.chunksByKey.set(`${fileTag}:${chunkBlobId}`, {
      payload: rawPayload.slice(),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  injectCorruptedEnvelope(
    boxId: string,
    blobId: string,
    rawPayload: Uint8Array,
  ): void {
    const box = this.getOrCreateBox(boxId);
    const seq = box.nextSeq++;
    box.envelopesByBlobId.set(blobId, {
      seq,
      blobId,
      payload: rawPayload.slice(),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  getStoredEnvelopeCount(boxId: string): number {
    return this.boxes.get(boxId)?.envelopesByBlobId.size ?? 0;
  }

  getStoredChunkCount(boxId: string): number {
    return this.boxes.get(boxId)?.chunksByKey.size ?? 0;
  }
}
