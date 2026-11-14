import {
  HELLO_AUTH_TIMEOUT_MS,
  isRecord,
  isValidPeerId,
  MAX_PEERS_PER_ROOM,
  parseWireControlFrame,
  type EncryptedEnvelope,
  type IceServerConfig,
  type PeerIdentityCert,
  type PostAuthControlFrame,
  type SignalingInnerPayload,
} from "@simpleim/contracts";
import {
  createHelloChallengeNonce,
  createHelloProveFrame,
  openPostAuthControlFrame,
  openSignalingPayload,
  sealPostAuthControlFrame,
  sealSignalingPayload,
  verifyHelloProveFrame,
  type DerivedRoomKeys,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import type {
  DataChannelPort,
  PeerConnectionPort,
  PeerTransportFactoryPort,
  RoomPeerEngineEvents,
  VerifiedPeerInfo,
} from "./ports.ts";
import type { VerifiedSwarmPeerLink } from "./swarm-scheduler.ts";

const PRESENCE_PING_INTERVAL_MS = 15_000;
const PRE_OPEN_CONNECT_TIMEOUT_MS = 30_000;
const MAX_BUFFERED_ICE_PER_PEER = 128;
const MAX_EARLY_ICE_PEERS = 32;

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;
type BufferedIceItem = Extract<
  SignalingInnerPayload,
  { kind: "ice-candidate" | "ice-end" }
>;

export interface MeshSessionCallbacks {
  sendSignalRelay: (toPeerId: string, envelope: EncryptedEnvelope) => void;
  onPostAuthControlFrame: (
    remotePeerId: string,
    frame: PostAuthControlFrame,
  ) => void;
  onSessionVerified: (remotePeerId: string, link: VerifiedSwarmPeerLink) => void;
  onPeerSwarmChannelOpen: (remotePeerId: string) => void;
  onPeerHelloAck: (remotePeerId: string) => void;
  onPeerBufferedAmountLow: (remotePeerId: string) => void;
  onSwarmBinaryFrame: (remotePeerId: string, bytes: Uint8Array) => void;
  onVerifiedPeerDisconnected: (remotePeerId: string) => void;
}

export interface MeshSessionManagerOptions {
  localPeerId: string;
  localCert: PeerIdentityCert;
  localSignKeyPair: Ed25519KeyPair;
  serverSignPubKey: string;
  roomKeys: DerivedRoomKeys;
  iceServers: IceServerConfig[];
  transportFactory: PeerTransportFactoryPort;
  helloAuthTimeoutMs?: number;
  maxSignalPayloadBytes?: number;
  now: () => number;
  events?: RoomPeerEngineEvents;
  callbacks: MeshSessionCallbacks;
}

interface PeerSession {
  readonly remotePeerId: string;
  readonly isInitiator: boolean;
  readonly pc: PeerConnectionPort;
  readonly localNonce: string;
  remoteNonce: string | null;
  challengeSent: boolean;
  proveSent: boolean;
  remoteProveVerified: boolean;
  verified: boolean;
  closed: boolean;
  authRejected: boolean;
  offerAccepted: boolean;
  answerAccepted: boolean;
  remoteDescReady: boolean;
  drainingIce: boolean;
  remoteIceQueue: BufferedIceItem[];
  remoteCert: PeerIdentityCert | null;
  rttMs: number | null;
  connectedAt: number;
  connectTimer: TimerHandle | null;
  helloAuthTimer: TimerHandle | null;
  pingInterval: IntervalHandle | null;
}

export class MeshSessionManager {
  private readonly localPeerId: string;
  private localCert: PeerIdentityCert;
  private readonly localSignKeyPair: Ed25519KeyPair;
  private readonly serverSignPubKey: string;
  private readonly roomKeys: DerivedRoomKeys;
  private readonly iceServers: IceServerConfig[];
  private readonly transportFactory: PeerTransportFactoryPort;
  private readonly helloAuthTimeoutMs: number;
  private readonly maxSignalPayloadBytes?: number;
  private readonly now: () => number;
  private readonly events?: RoomPeerEngineEvents;
  private readonly callbacks: MeshSessionCallbacks;

  private readonly sessions = new Map<string, PeerSession>();
  private readonly earlyIceByPeer = new Map<string, BufferedIceItem[]>();
  private stopped = false;

  constructor(options: MeshSessionManagerOptions) {
    this.localPeerId = options.localPeerId;
    this.localCert = options.localCert;
    this.localSignKeyPair = options.localSignKeyPair;
    this.serverSignPubKey = options.serverSignPubKey;
    this.roomKeys = options.roomKeys;
    this.iceServers = options.iceServers;
    this.transportFactory = options.transportFactory;
    this.helloAuthTimeoutMs =
      options.helloAuthTimeoutMs ?? HELLO_AUTH_TIMEOUT_MS;
    this.maxSignalPayloadBytes = options.maxSignalPayloadBytes;
    this.now = options.now;
    this.events = options.events;
    this.callbacks = options.callbacks;
  }

  updateLocalCert(nextCert: PeerIdentityCert): void {
    this.localCert = nextCert;
  }

  onRoomJoined(peers: readonly string[]): void {
    if (this.stopped) return;
    for (const remotePeerId of peers) {
      this.onPeerJoined(remotePeerId);
    }
  }

  onPeerJoined(remotePeerId: string): void {
    if (this.stopped) return;
    if (remotePeerId === this.localPeerId || !isValidPeerId(remotePeerId)) {
      return;
    }

    const existing = this.sessions.get(remotePeerId);
    if (existing) {
      if (this.isSessionHealthyOrConnecting(existing)) {
        return;
      }
      this.closeSession(existing);
    }

    if (this.sessions.size >= MAX_PEERS_PER_ROOM) {
      return;
    }

    const isInitiator = this.localPeerId < remotePeerId;
    if (isInitiator) {
      const session = this.createPeerSession(remotePeerId, true);
      void this.initiateOffer(session);
    }
  }

  onPeerLeft(remotePeerId: string): void {
    if (this.stopped) return;
    this.earlyIceByPeer.delete(remotePeerId);

    const existing = this.sessions.get(remotePeerId);
    if (!existing) return;

    // Never tear down a healthy VERIFIED P2P session on signaling peer_left;
    // only clean up if the underlying WebRTC transport is already dead.
    if (!this.isSessionHealthyOrConnecting(existing)) {
      this.closeSession(existing);
    }
  }

  onSignalDeliver(fromPeerId: string, envelope: EncryptedEnvelope): void {
    if (this.stopped) return;
    if (fromPeerId === this.localPeerId || !isValidPeerId(fromPeerId)) {
      return;
    }

    let payload: SignalingInnerPayload;
    try {
      payload = openSignalingPayload(
        this.roomKeys.signalingKey,
        this.roomKeys.roomId,
        fromPeerId,
        this.localPeerId,
        envelope,
        this.maxSignalPayloadBytes !== undefined
          ? { maxFrameBytes: this.maxSignalPayloadBytes }
          : undefined,
      );
    } catch {
      // Attacker or wrong room key: safely drop frame without crashing or affecting state
      return;
    }

    switch (payload.kind) {
      case "sdp-offer":
        void this.handleIncomingOffer(fromPeerId, payload.sdp);
        break;
      case "sdp-answer":
        void this.handleIncomingAnswer(fromPeerId, payload.sdp);
        break;
      case "ice-candidate":
      case "ice-end":
        this.handleIncomingIce(fromPeerId, payload);
        break;
    }
  }

  getVerifiedPeers(): VerifiedPeerInfo[] {
    const out: VerifiedPeerInfo[] = [];
    for (const session of this.sessions.values()) {
      if (session.verified && !session.closed && session.remoteCert) {
        const p = session.remoteCert.payload;
        out.push({
          peerId: p.peerId,
          userId: p.userId,
          username: p.username,
          displayName: p.displayName,
          clientKind: p.clientKind,
          rttMs: session.rttMs,
          connectedAt: session.connectedAt,
        });
      }
    }
    out.sort((a, b) => a.peerId.localeCompare(b.peerId));
    return out;
  }

  sendControlFrameToPeer(
    remotePeerId: string,
    frame: PostAuthControlFrame,
  ): void {
    if (this.stopped) return;
    const session = this.sessions.get(remotePeerId);
    if (
      !session ||
      !session.verified ||
      session.closed ||
      session.pc.controlChannel.readyState !== "open"
    ) {
      return;
    }
    const sealed = sealPostAuthControlFrame(
      this.roomKeys.roomAppKey,
      this.roomKeys.roomId,
      frame,
    );
    this.safeSendText(session.pc.controlChannel, JSON.stringify(sealed));
  }

  broadcastControlFrame(frame: PostAuthControlFrame): void {
    if (this.stopped) return;
    for (const session of this.sessions.values()) {
      if (
        session.verified &&
        !session.closed &&
        session.pc.controlChannel.readyState === "open"
      ) {
        const sealed = sealPostAuthControlFrame(
          this.roomKeys.roomAppKey,
          this.roomKeys.roomId,
          frame,
        );
        this.safeSendText(session.pc.controlChannel, JSON.stringify(sealed));
      }
    }
  }

  handlePresencePing(remotePeerId: string, sentAt: number): void {
    this.sendControlFrameToPeer(remotePeerId, {
      type: "presence.pong",
      sentAt,
    });
  }

  handlePresencePong(remotePeerId: string, sentAt: number): void {
    const session = this.sessions.get(remotePeerId);
    if (!session || !session.verified || session.closed) return;
    const sample = Math.max(0, this.now() - sentAt);
    const prev = session.rttMs;
    session.rttMs =
      prev === null ? sample : Math.round(prev * 0.7 + sample * 0.3);
    if (prev !== session.rttMs) {
      this.events?.onPeersChange?.(this.getVerifiedPeers());
    }
  }

  evictPeer(remotePeerId: string, _reason: string): void {
    const session = this.sessions.get(remotePeerId);
    if (session) {
      this.closeSession(session);
    }
  }

  stop(): void {
    this.stopped = true;
    this.earlyIceByPeer.clear();
    const active = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of active) {
      session.closed = true;
      session.verified = false;
      if (session.connectTimer !== null) {
        clearTimeout(session.connectTimer);
        session.connectTimer = null;
      }
      if (session.helloAuthTimer !== null) {
        clearTimeout(session.helloAuthTimer);
        session.helloAuthTimer = null;
      }
      if (session.pingInterval !== null) {
        clearInterval(session.pingInterval);
        session.pingInterval = null;
      }
      try {
        session.pc.close();
      } catch {
        // Ignore transport close errors on shutdown
      }
    }
  }

  private isSessionHealthyOrConnecting(session: PeerSession): boolean {
    if (session.closed) return false;
    const st = session.pc.state;
    if (st === "failed" || st === "closed" || st === "disconnected") {
      return false;
    }
    if (
      session.pc.controlChannel.readyState === "closed" ||
      session.pc.controlChannel.readyState === "closing"
    ) {
      return false;
    }
    return true;
  }

  private createPeerSession(
    remotePeerId: string,
    isInitiator: boolean,
  ): PeerSession {
    const pc = this.transportFactory.createPeerConnection({
      localPeerId: this.localPeerId,
      remotePeerId,
      isInitiator,
      iceServers: this.iceServers,
    });

    const earlyIce = this.earlyIceByPeer.get(remotePeerId) ?? [];
    this.earlyIceByPeer.delete(remotePeerId);

    const session: PeerSession = {
      remotePeerId,
      isInitiator,
      pc,
      localNonce: createHelloChallengeNonce(),
      remoteNonce: null,
      challengeSent: false,
      proveSent: false,
      remoteProveVerified: false,
      verified: false,
      closed: false,
      authRejected: false,
      offerAccepted: false,
      answerAccepted: false,
      remoteDescReady: false,
      drainingIce: false,
      remoteIceQueue: [...earlyIce],
      remoteCert: null,
      rttMs: null,
      connectedAt: 0,
      connectTimer: null,
      helloAuthTimer: null,
      pingInterval: null,
    };

    this.sessions.set(remotePeerId, session);

    const preOpenTimeoutMs = Math.max(
      PRE_OPEN_CONNECT_TIMEOUT_MS,
      this.helloAuthTimeoutMs * 3,
    );
    session.connectTimer = setTimeout(() => {
      if (
        !this.stopped &&
        !session.closed &&
        !session.verified &&
        session.pc.controlChannel.readyState !== "open"
      ) {
        this.closeSession(session);
      }
    }, preOpenTimeoutMs);

    this.attachPeerConnectionHandlers(session);
    return session;
  }

  private attachPeerConnectionHandlers(session: PeerSession): void {
    const { pc, remotePeerId } = session;

    pc.onLocalIceCandidate((candidate) => {
      if (this.stopped || session.closed) return;
      this.sendEncryptedSignal(remotePeerId, candidate);
    });

    pc.onLocalIceEnd(() => {
      if (this.stopped || session.closed) return;
      this.sendEncryptedSignal(remotePeerId, { kind: "ice-end" });
    });

    pc.onStateChange((state) => {
      if (this.stopped || session.closed) return;
      if (
        state === "failed" ||
        state === "closed" ||
        state === "disconnected"
      ) {
        this.closeSession(session);
      }
    });

    const { controlChannel, swarmChannel } = pc;

    controlChannel.onOpen(() => {
      this.handleControlChannelOpen(session);
    });

    controlChannel.onClose(() => {
      if (!this.stopped && !session.closed) {
        this.closeSession(session);
      }
    });

    controlChannel.onError((err) => {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    controlChannel.onTextMessage((rawText) => {
      this.handleControlTextMessage(session, rawText);
    });

    swarmChannel.onOpen(() => {
      if (this.stopped || session.closed || !session.verified) return;
      this.callbacks.onPeerSwarmChannelOpen(remotePeerId);
    });

    swarmChannel.onClose(() => {
      if (!this.stopped && !session.closed) {
        this.closeSession(session);
      }
    });

    swarmChannel.onError((err) => {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    swarmChannel.onBufferedAmountLow(() => {
      if (this.stopped || session.closed || !session.verified) return;
      this.callbacks.onPeerBufferedAmountLow(remotePeerId);
    });

    swarmChannel.onBinaryMessage((bytes) => {
      // Quarantine: strictly drop all file-swarm frames while UNVERIFIED
      if (this.stopped || session.closed || !session.verified) {
        return;
      }
      this.callbacks.onSwarmBinaryFrame(remotePeerId, bytes);
    });

    if (controlChannel.readyState === "open") {
      this.handleControlChannelOpen(session);
    }
  }

  private async initiateOffer(session: PeerSession): Promise<void> {
    try {
      const sdp = await session.pc.createOffer();
      if (this.stopped || session.closed) return;
      this.sendEncryptedSignal(session.remotePeerId, {
        kind: "sdp-offer",
        sdp,
      });
    } catch (err) {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
        this.closeSession(session);
      }
    }
  }

  private async handleIncomingOffer(
    fromPeerId: string,
    offerSdp: string,
  ): Promise<void> {
    // Enforce deterministic glare-free rule: responder must have localPeerId > fromPeerId
    if (this.localPeerId < fromPeerId) {
      return;
    }

    const existing = this.sessions.get(fromPeerId);
    if (existing) {
      if (this.isSessionHealthyOrConnecting(existing)) {
        if (existing.verified || existing.offerAccepted) {
          return;
        }
      } else {
        this.closeSession(existing);
      }
    }

    let session = this.sessions.get(fromPeerId);
    if (!session) {
      if (this.sessions.size >= MAX_PEERS_PER_ROOM) {
        return;
      }
      session = this.createPeerSession(fromPeerId, false);
    }

    session.offerAccepted = true;
    try {
      const answerSdp = await session.pc.acceptOfferAndCreateAnswer(offerSdp);
      if (this.stopped || session.closed) return;
      this.sendEncryptedSignal(fromPeerId, {
        kind: "sdp-answer",
        sdp: answerSdp,
      });
      session.remoteDescReady = true;
      await this.drainRemoteIce(session);
    } catch (err) {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
        this.closeSession(session);
      }
    }
  }

  private async handleIncomingAnswer(
    fromPeerId: string,
    answerSdp: string,
  ): Promise<void> {
    const session = this.sessions.get(fromPeerId);
    if (
      !session ||
      session.closed ||
      !session.isInitiator ||
      session.answerAccepted
    ) {
      return;
    }

    session.answerAccepted = true;
    try {
      await session.pc.acceptAnswer(answerSdp);
      if (this.stopped || session.closed) return;
      session.remoteDescReady = true;
      await this.drainRemoteIce(session);
    } catch (err) {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
        this.closeSession(session);
      }
    }
  }

  private handleIncomingIce(fromPeerId: string, item: BufferedIceItem): void {
    const session = this.sessions.get(fromPeerId);
    if (session && !session.closed) {
      if (session.remoteIceQueue.length < MAX_BUFFERED_ICE_PER_PEER) {
        session.remoteIceQueue.push(item);
      }
      void this.drainRemoteIce(session);
      return;
    }

    if (this.localPeerId > fromPeerId) {
      let queue = this.earlyIceByPeer.get(fromPeerId);
      if (!queue) {
        if (this.earlyIceByPeer.size >= MAX_EARLY_ICE_PEERS) return;
        queue = [];
        this.earlyIceByPeer.set(fromPeerId, queue);
      }
      if (queue.length < MAX_BUFFERED_ICE_PER_PEER) {
        queue.push(item);
      }
    }
  }

  private async drainRemoteIce(session: PeerSession): Promise<void> {
    if (
      !session.remoteDescReady ||
      session.drainingIce ||
      session.closed ||
      this.stopped
    ) {
      return;
    }

    session.drainingIce = true;
    try {
      while (
        session.remoteIceQueue.length > 0 &&
        !session.closed &&
        !this.stopped
      ) {
        const next = session.remoteIceQueue.shift()!;
        if (next.kind === "ice-candidate") {
          await session.pc.addIceCandidate({
            candidate: next.candidate,
            sdpMid: next.sdpMid,
            sdpMLineIndex: next.sdpMLineIndex,
          });
        } else {
          await session.pc.endIceCandidates();
        }
      }
    } catch (err) {
      if (!this.stopped && !session.closed) {
        this.events?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    } finally {
      session.drainingIce = false;
    }
  }

  private handleControlChannelOpen(session: PeerSession): void {
    if (this.stopped || session.closed) return;
    if (session.connectTimer !== null) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }
    if (session.helloAuthTimer === null && !session.verified) {
      session.helloAuthTimer = setTimeout(() => {
        if (!this.stopped && !session.closed && !session.verified) {
          this.rejectSessionAuth(session, "hello_auth_timeout");
        }
      }, this.helloAuthTimeoutMs);
    }
    this.sendChallengeIfReady(session);
    this.sendProveIfReady(session);
    this.maybePromoteSession(session);
  }

  private sendChallengeIfReady(session: PeerSession): void {
    if (
      session.challengeSent ||
      session.closed ||
      session.pc.controlChannel.readyState !== "open"
    ) {
      return;
    }
    session.challengeSent = true;
    this.safeSendText(
      session.pc.controlChannel,
      JSON.stringify({
        type: "hello.challenge",
        nonce: session.localNonce,
      }),
    );
  }

  private sendProveIfReady(session: PeerSession): boolean {
    if (
      session.proveSent ||
      session.closed ||
      session.remoteNonce === null ||
      session.pc.controlChannel.readyState !== "open"
    ) {
      return session.proveSent;
    }

    this.sendChallengeIfReady(session);

    let proveFrame;
    try {
      const localFp = session.pc.getLocalDtlsFingerprint();
      const remoteFp = session.pc.getRemoteDtlsFingerprint();
      proveFrame = createHelloProveFrame({
        roomId: this.roomKeys.roomId,
        roomAuthKey: this.roomKeys.roomAuthKey,
        cert: this.localCert,
        peerSignPrivKey: this.localSignKeyPair.privateKeyBytes,
        localPeerId: this.localPeerId,
        remotePeerId: session.remotePeerId,
        localFingerprint: localFp,
        remoteFingerprint: remoteFp,
        localNonce: session.localNonce,
        remoteNonce: session.remoteNonce,
      });
    } catch {
      this.rejectSessionAuth(session, "channel_binding_sig_mismatch");
      return false;
    }

    session.proveSent = true;
    this.safeSendText(session.pc.controlChannel, JSON.stringify(proveFrame));
    return true;
  }

  private handleControlTextMessage(
    session: PeerSession,
    rawText: string,
  ): void {
    if (this.stopped || session.closed) return;

    let wireFrame;
    try {
      wireFrame = parseWireControlFrame(rawText);
    } catch {
      if (!session.verified) {
        try {
          const parsed: unknown = JSON.parse(rawText);
          if (isRecord(parsed) && parsed.type === "hello.prove") {
            this.rejectSessionAuth(session, "invalid_cert");
          }
        } catch {
          // Drop malformed frame in quarantine
        }
      }
      return;
    }

    if (wireFrame.type === "control.sealed") {
      // Quarantine: strictly drop post-auth sealed frames while UNVERIFIED
      if (!session.verified) {
        return;
      }

      let innerFrame: PostAuthControlFrame;
      try {
        innerFrame = openPostAuthControlFrame(
          this.roomKeys.roomAppKey,
          this.roomKeys.roomId,
          wireFrame,
        );
      } catch {
        return;
      }

      this.callbacks.onPostAuthControlFrame(session.remotePeerId, innerFrame);
      return;
    }

    if (wireFrame.type === "hello.challenge") {
      if (session.verified || session.remoteNonce !== null) {
        return;
      }
      session.remoteNonce = wireFrame.nonce;
      if (session.pc.controlChannel.readyState === "open") {
        this.sendChallengeIfReady(session);
        if (this.sendProveIfReady(session)) {
          this.maybePromoteSession(session);
        }
      }
      return;
    }

    if (wireFrame.type === "hello.prove") {
      if (session.remoteProveVerified || session.closed) {
        return;
      }
      if (session.remoteNonce === null) {
        this.rejectSessionAuth(session, "hello_auth_failed");
        return;
      }

      if (session.pc.controlChannel.readyState === "open") {
        if (!this.sendProveIfReady(session)) {
          return;
        }
      }

      let localFp: string;
      let remoteFp: string;
      try {
        localFp = session.pc.getLocalDtlsFingerprint();
        remoteFp = session.pc.getRemoteDtlsFingerprint();
      } catch {
        this.rejectSessionAuth(session, "channel_binding_sig_mismatch");
        return;
      }

      const verifyRes = verifyHelloProveFrame({
        frame: wireFrame,
        expectedRemotePeerId: session.remotePeerId,
        serverSignPubKey: this.serverSignPubKey,
        roomId: this.roomKeys.roomId,
        roomAuthKey: this.roomKeys.roomAuthKey,
        localPeerId: this.localPeerId,
        localFingerprint: localFp,
        remoteFingerprint: remoteFp,
        localNonce: session.localNonce,
        remoteNonce: session.remoteNonce,
        nowMs: this.now(),
      });

      if (!verifyRes.ok) {
        this.rejectSessionAuth(session, verifyRes.reason);
        return;
      }

      session.remoteCert = verifyRes.cert;
      session.remoteProveVerified = true;

      if (session.pc.controlChannel.readyState === "open") {
        this.safeSendText(
          session.pc.controlChannel,
          JSON.stringify({ type: "hello.ack" }),
        );
      }

      this.maybePromoteSession(session);
      return;
    }

    if (wireFrame.type === "hello.ack") {
      if (session.verified) {
        this.callbacks.onPeerHelloAck(session.remotePeerId);
      }
    }
  }

  private maybePromoteSession(session: PeerSession): void {
    if (
      session.verified ||
      session.closed ||
      !session.proveSent ||
      !session.remoteProveVerified ||
      session.remoteCert === null
    ) {
      return;
    }

    session.verified = true;
    session.connectedAt = this.now();

    if (session.connectTimer !== null) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }
    if (session.helloAuthTimer !== null) {
      clearTimeout(session.helloAuthTimer);
      session.helloAuthTimer = null;
    }

    const swarmLink: VerifiedSwarmPeerLink = {
      peerId: session.remotePeerId,
      getRttMs: () => session.rttMs,
      swarmChannel: session.pc.swarmChannel,
      isVerified: () => session.verified && !session.closed && !this.stopped,
    };

    this.callbacks.onSessionVerified(session.remotePeerId, swarmLink);
    this.events?.onPeersChange?.(this.getVerifiedPeers());

    // Immediate initial RTT ping + periodic 15s keepalive ping
    this.sendPing(session);
    session.pingInterval = setInterval(() => {
      if (this.stopped || session.closed || !session.verified) return;
      this.sendPing(session);
    }, PRESENCE_PING_INTERVAL_MS);
  }

  private sendPing(session: PeerSession): void {
    this.sendControlFrameToPeer(session.remotePeerId, {
      type: "presence.ping",
      sentAt: this.now(),
    });
  }

  private rejectSessionAuth(session: PeerSession, reason: string): void {
    if (session.authRejected || session.closed) return;
    session.authRejected = true;
    this.closeSession(session);
    this.events?.onPeerAuthRejected?.(session.remotePeerId, reason);
  }

  private closeSession(session: PeerSession): void {
    if (session.closed) return;
    const wasVerified = session.verified;
    session.closed = true;
    session.verified = false;

    if (session.connectTimer !== null) {
      clearTimeout(session.connectTimer);
      session.connectTimer = null;
    }
    if (session.helloAuthTimer !== null) {
      clearTimeout(session.helloAuthTimer);
      session.helloAuthTimer = null;
    }
    if (session.pingInterval !== null) {
      clearInterval(session.pingInterval);
      session.pingInterval = null;
    }

    if (this.sessions.get(session.remotePeerId) === session) {
      this.sessions.delete(session.remotePeerId);
    }

    try {
      session.pc.close();
    } catch {
      // Ignore redundant close errors
    }

    if (wasVerified && !this.stopped) {
      this.callbacks.onVerifiedPeerDisconnected(session.remotePeerId);
      this.events?.onPeersChange?.(this.getVerifiedPeers());
    }
  }

  private sendEncryptedSignal(
    toPeerId: string,
    payload: SignalingInnerPayload,
  ): void {
    const envelope = sealSignalingPayload(
      this.roomKeys.signalingKey,
      this.roomKeys.roomId,
      this.localPeerId,
      toPeerId,
      payload,
    );
    this.callbacks.sendSignalRelay(toPeerId, envelope);
  }

  private safeSendText(channel: DataChannelPort, text: string): void {
    if (channel.readyState !== "open") return;
    try {
      channel.sendText(text);
    } catch {
      // Transport close will trigger channel/PC state handler
    }
  }
}
