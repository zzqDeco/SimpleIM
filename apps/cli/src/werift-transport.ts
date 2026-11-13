import {
  CONTROL_CHANNEL_ID,
  CONTROL_CHANNEL_LABEL,
  SWARM_BUFFERED_LOW_THRESHOLD,
  SWARM_CHANNEL_ID,
  SWARM_CHANNEL_LABEL,
  type IceServerConfig,
  type SignalingInnerPayload,
} from "@simpleim/contracts";
import { extractSdpSha256Fingerprint } from "@simpleim/crypto";
import type {
  ChannelReadyState,
  DataChannelPort,
  PeerConnectionPort,
  PeerTransportFactoryPort,
  PeerTransportState,
} from "@simpleim/peer-core";
import {
  createSelfSignedCertificate,
  HashAlgorithm,
  NamedCurveAlgorithm,
  RTCCertificate,
  RTCPeerConnection,
  SignatureAlgorithm,
  type PeerConfig,
  type RTCDataChannel,
  type RTCIceServer,
} from "werift";

type LocalIceCandidatePayload = Extract<
  SignalingInnerPayload,
  { kind: "ice-candidate" }
>;

interface MappedIceConfig {
  iceServers: RTCIceServer[];
  hasStunServer: boolean;
  forceTurnTCP: boolean;
}

function mapContractIceServers(configs: readonly IceServerConfig[]): MappedIceConfig {
  const iceServers: RTCIceServer[] = [];
  let hasStunServer = false;
  let forceTurnTCP = false;

  for (const entry of configs) {
    for (const rawUrl of entry.urls) {
      const trimmed = rawUrl.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("stun:") || trimmed.startsWith("stuns:")) {
        const hostPort = trimmed.replace(/^stuns?:/, "").split("?")[0] ?? "";
        if (hostPort) {
          hasStunServer = true;
          iceServers.push({ urls: `stun:${hostPort}` });
        }
        continue;
      }

      if (trimmed.startsWith("turn:") || trimmed.startsWith("turns:")) {
        if (
          trimmed.startsWith("turns:") ||
          trimmed.toLowerCase().includes("transport=tcp")
        ) {
          forceTurnTCP = true;
        }
        const hostPort = trimmed.replace(/^turns?:/, "").split("?")[0] ?? "";
        if (hostPort) {
          iceServers.push({
            urls: `turn:${hostPort}`,
            ...(entry.username !== undefined ? { username: entry.username } : {}),
            ...(entry.credential !== undefined
              ? { credential: entry.credential }
              : {}),
          });
        }
      }
    }
  }

  return { iceServers, hasStunServer, forceTurnTCP };
}

const WERIFT_SDP_MAX_MESSAGE_SIZE = 262_144; // 256 KiB so browsers allow 65,582 B Swarm chunk frames

function upgradeSdpMaxMessageSize(sdp: string): string {
  return sdp.replace(
    /^a=max-message-size:\d+(\r?)$/gm,
    `a=max-message-size:${WERIFT_SDP_MAX_MESSAGE_SIZE}$1`,
  );
}

function mapDcState(state: string): ChannelReadyState {
  switch (state) {
    case "open":
      return "open";
    case "closing":
      return "closing";
    case "closed":
      return "closed";
    default:
      return "connecting";
  }
}

function mapPcState(state: string): PeerTransportState {
  switch (state) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "new";
  }
}

class WeriftDataChannelAdapter implements DataChannelPort {
  private readonly dc: RTCDataChannel;
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(err: unknown) => void>();
  private readonly textHandlers = new Set<(text: string) => void>();
  private readonly binaryHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly bufferedLowHandlers = new Set<() => void>();

  constructor(dc: RTCDataChannel, defaultLowThreshold?: number) {
    this.dc = dc;
    if (defaultLowThreshold !== undefined) {
      this.dc.bufferedAmountLowThreshold = defaultLowThreshold;
    }

    this.dc.stateChanged.subscribe((state) => {
      if (state === "open") {
        for (const h of this.openHandlers) h();
      } else if (state === "closed") {
        for (const h of this.closeHandlers) h();
      }
    });

    this.dc.error.subscribe((err) => {
      for (const h of this.errorHandlers) h(err);
    });

    this.dc.bufferedAmountLow.subscribe(() => {
      for (const h of this.bufferedLowHandlers) h();
    });

    this.dc.onMessage.subscribe((msg) => {
      if (typeof msg === "string") {
        for (const h of this.textHandlers) h(msg);
      } else {
        const view = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
        const copy = view.slice();
        for (const h of this.binaryHandlers) h(copy);
      }
    });
  }

  get id(): number {
    return this.dc.id;
  }

  get label(): string {
    return this.dc.label;
  }

  get readyState(): ChannelReadyState {
    return mapDcState(this.dc.readyState);
  }

  get bufferedAmount(): number {
    // Clamp to >= 0 because werift tracks string UTF-16 code units on enqueue
    // vs UTF-8 byte length on SCTP flush.
    return Math.max(0, this.dc.bufferedAmount);
  }

  get bufferedAmountLowThreshold(): number {
    return this.dc.bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.dc.bufferedAmountLowThreshold = Math.max(0, Math.floor(value));
  }

  sendText(text: string): void {
    if (this.dc.readyState !== "open") {
      throw new Error(`DataChannel '${this.dc.label}' is not open`);
    }
    this.dc.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.dc.readyState !== "open") {
      throw new Error(`DataChannel '${this.dc.label}' is not open`);
    }
    // Pass a Node Buffer so werift marks the SCTP payload with WEBRTC_BINARY PPID
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dc.send(buf);
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      // Ignore already-closed errors
    }
  }

  onOpen(handler: () => void): void {
    this.openHandlers.add(handler);
    if (this.dc.readyState === "open") {
      queueMicrotask(() => {
        if (this.dc.readyState === "open" && this.openHandlers.has(handler)) {
          handler();
        }
      });
    }
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onError(handler: (err: unknown) => void): void {
    this.errorHandlers.add(handler);
  }

  onTextMessage(handler: (text: string) => void): void {
    this.textHandlers.add(handler);
  }

  onBinaryMessage(handler: (bytes: Uint8Array) => void): void {
    this.binaryHandlers.add(handler);
  }

  onBufferedAmountLow(handler: () => void): void {
    this.bufferedLowHandlers.add(handler);
  }
}

type PendingRemoteIce =
  | {
      kind: "candidate";
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    }
  | { kind: "end" };

class WeriftPeerConnectionAdapter implements PeerConnectionPort {
  readonly remotePeerId: string;
  readonly isInitiator: boolean;
  readonly controlChannel: DataChannelPort;
  readonly swarmChannel: DataChannelPort;

  private readonly pc: RTCPeerConnection;
  private currentState: PeerTransportState = "new";
  private closed = false;
  private localDtlsCertPromise: Promise<RTCCertificate> | null = null;
  private localFingerprintCache: string | null = null;
  private remoteFingerprintCache: string | null = null;

  private remoteDescriptionReady = false;
  private readonly pendingRemoteIce: PendingRemoteIce[] = [];

  private deferLocalIce = false;
  private readonly bufferedLocalIce: Array<LocalIceCandidatePayload | "end"> = [];
  private localIceEnded = false;

  private readonly localIceCandidateHandlers = new Set<
    (candidate: LocalIceCandidatePayload) => void
  >();
  private readonly localIceEndHandlers = new Set<() => void>();
  private readonly stateChangeHandlers = new Set<
    (state: PeerTransportState) => void
  >();

  constructor(params: {
    remotePeerId: string;
    isInitiator: boolean;
    iceServers: IceServerConfig[];
    icePortRange?: [number, number];
    iceAdditionalHostAddresses?: string[];
    iceUseIpv6?: boolean;
  }) {
    this.remotePeerId = params.remotePeerId;
    this.isInitiator = params.isInitiator;

    const mapped = mapContractIceServers(params.iceServers);
    const peerConfig: Partial<PeerConfig> = {
      iceServers: mapped.iceServers,
      iceUseIpv4: true,
      iceUseIpv6: params.iceUseIpv6 ?? false,
      iceAdditionalHostAddresses: params.iceAdditionalHostAddresses ?? [
        "127.0.0.1",
      ],
      forceTurnTCP: mapped.forceTurnTCP,
      ...(params.icePortRange !== undefined
        ? { icePortRange: params.icePortRange }
        : {}),
    };

    this.pc = new RTCPeerConnection(peerConfig);
    // Replace default STUN array explicitly because werift's deepMerge preserves default array items when given []
    this.pc.config.iceServers = mapped.iceServers;

    const rawControl = this.pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
      ordered: true,
    });
    const rawSwarm = this.pc.createDataChannel(SWARM_CHANNEL_LABEL, {
      negotiated: true,
      id: SWARM_CHANNEL_ID,
      ordered: false,
    });

    if (!mapped.hasStunServer) {
      // Prevent werift's Connection fallback to stun.l.google.com:19302 when iceServers has no STUN URL
      for (const iceTransport of this.pc.iceTransports) {
        (iceTransport.connection as unknown as { stunServer?: unknown }).stunServer =
          undefined;
      }
    }

    this.controlChannel = new WeriftDataChannelAdapter(rawControl);
    this.swarmChannel = new WeriftDataChannelAdapter(
      rawSwarm,
      SWARM_BUFFERED_LOW_THRESHOLD,
    );

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (this.closed) return;
      if (!candidate || !candidate.candidate) {
        this.emitOrBufferLocalIce("end");
        return;
      }
      const rawCand = candidate.candidate.trim();
      if (rawCand.length === 0) {
        this.emitOrBufferLocalIce("end");
        return;
      }
      const formattedCand = rawCand.startsWith("candidate:")
        ? rawCand
        : `candidate:${rawCand}`;
      const payload: LocalIceCandidatePayload = {
        kind: "ice-candidate",
        candidate: formattedCand,
        ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
        ...(candidate.sdpMLineIndex !== undefined
          ? { sdpMLineIndex: candidate.sdpMLineIndex }
          : {}),
      };
      this.emitOrBufferLocalIce(payload);
    });

    this.pc.iceGatheringStateChange.subscribe((gState) => {
      if (this.closed) return;
      if (gState === "complete") {
        this.emitOrBufferLocalIce("end");
      }
    });

    this.pc.connectionStateChange.subscribe((rawState) => {
      if (this.closed && rawState !== "closed") return;
      const next = mapPcState(rawState);
      if (next !== this.currentState) {
        this.currentState = next;
        for (const h of this.stateChangeHandlers) h(next);
      }
    });
  }

  get state(): PeerTransportState {
    if (this.closed) return "closed";
    if (
      this.controlChannel.readyState === "closed" &&
      this.swarmChannel.readyState === "closed"
    ) {
      return "closed";
    }
    return mapPcState(this.pc.connectionState);
  }

  private async ensureUniqueDtlsCert(): Promise<void> {
    if (!this.localDtlsCertPromise) {
      this.localDtlsCertPromise = (async () => {
        const keys = await createSelfSignedCertificate(
          {
            signature: SignatureAlgorithm.ecdsa_3,
            hash: HashAlgorithm.sha256_4,
          },
          NamedCurveAlgorithm.secp256r1_23,
        );
        return new RTCCertificate(keys.keyPem, keys.certPem, keys.signatureHash);
      })();
    }
    const cert = await this.localDtlsCertPromise;
    const pcInternal = this.pc as unknown as {
      secureManager?: { certificate?: RTCCertificate };
    };
    if (pcInternal.secureManager) {
      pcInternal.secureManager.certificate = cert;
    }
    for (const dt of this.pc.dtlsTransports) {
      dt.localCertificate = cert;
    }
  }

  async createOffer(): Promise<string> {
    if (this.closed) {
      throw new Error("PeerConnection is closed");
    }
    await this.ensureUniqueDtlsCert();

    this.deferLocalIce = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const rawSdp = this.pc.localDescription?.sdp ?? offer.sdp;
      const sdp = upgradeSdpMaxMessageSize(rawSdp);
      this.localFingerprintCache = extractSdpSha256Fingerprint(sdp);
      return sdp;
    } finally {
      this.deferLocalIce = false;
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  async acceptOfferAndCreateAnswer(offerSdp: string): Promise<string> {
    if (this.closed) {
      throw new Error("PeerConnection is closed");
    }
    await this.ensureUniqueDtlsCert();

    this.remoteFingerprintCache = extractSdpSha256Fingerprint(offerSdp);
    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    this.remoteDescriptionReady = true;
    await this.flushPendingRemoteIce();

    this.deferLocalIce = true;
    try {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const rawSdp = this.pc.localDescription?.sdp ?? answer.sdp;
      const sdp = upgradeSdpMaxMessageSize(rawSdp);
      this.localFingerprintCache = extractSdpSha256Fingerprint(sdp);
      return sdp;
    } finally {
      this.deferLocalIce = false;
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  async acceptAnswer(answerSdp: string): Promise<void> {
    if (this.closed) {
      throw new Error("PeerConnection is closed");
    }
    this.remoteFingerprintCache = extractSdpSha256Fingerprint(answerSdp);
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.remoteDescriptionReady = true;
    await this.flushPendingRemoteIce();
  }

  async addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): Promise<void> {
    if (this.closed) return;
    const trimmed = candidate.candidate.trim();
    if (trimmed.length === 0) {
      await this.endIceCandidates();
      return;
    }
    if (!this.remoteDescriptionReady) {
      this.pendingRemoteIce.push({
        kind: "candidate",
        candidate: trimmed,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
      return;
    }
    await this.applyRemoteCandidate(
      trimmed,
      candidate.sdpMid,
      candidate.sdpMLineIndex,
    );
  }

  async endIceCandidates(): Promise<void> {
    if (this.closed) return;
    if (!this.remoteDescriptionReady) {
      this.pendingRemoteIce.push({ kind: "end" });
      return;
    }
    this.applyRemoteIceEnd();
  }

  private async applyRemoteCandidate(
    rawCandidate: string,
    sdpMid?: string | null,
    sdpMLineIndex?: number | null,
  ): Promise<void> {
    try {
      await this.pc.addIceCandidate({
        candidate: rawCandidate,
        sdpMid: sdpMid ?? undefined,
        sdpMLineIndex: sdpMLineIndex ?? undefined,
      });
    } catch {
      // Safely ignore unsupported browser candidate extensions (e.g. typ prflx / mDNS)
    }
  }

  private applyRemoteIceEnd(): void {
    for (const iceTransport of this.pc.iceTransports) {
      try {
        iceTransport.addRemoteCandidate(undefined);
      } catch {
        // Ignore end-of-candidates errors
      }
    }
  }

  private async flushPendingRemoteIce(): Promise<void> {
    while (this.pendingRemoteIce.length > 0 && !this.closed) {
      const item = this.pendingRemoteIce.shift();
      if (!item) break;
      if (item.kind === "end") {
        this.applyRemoteIceEnd();
      } else {
        await this.applyRemoteCandidate(
          item.candidate,
          item.sdpMid,
          item.sdpMLineIndex,
        );
      }
    }
  }

  getLocalDtlsFingerprint(): string {
    const sdp = this.pc.localDescription?.sdp;
    if (sdp) {
      return extractSdpSha256Fingerprint(sdp);
    }
    if (this.localFingerprintCache) {
      return this.localFingerprintCache;
    }
    throw new Error("Local DTLS fingerprint not yet available");
  }

  getRemoteDtlsFingerprint(): string {
    const sdp = this.pc.remoteDescription?.sdp;
    if (sdp) {
      return extractSdpSha256Fingerprint(sdp);
    }
    if (this.remoteFingerprintCache) {
      return this.remoteFingerprintCache;
    }
    throw new Error("Remote DTLS fingerprint not yet available");
  }

  onLocalIceCandidate(
    handler: (candidate: LocalIceCandidatePayload) => void,
  ): void {
    this.localIceCandidateHandlers.add(handler);
    if (!this.deferLocalIce && this.bufferedLocalIce.length > 0) {
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  onLocalIceEnd(handler: () => void): void {
    this.localIceEndHandlers.add(handler);
    if (!this.deferLocalIce && this.bufferedLocalIce.length > 0) {
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  onStateChange(handler: (state: PeerTransportState) => void): void {
    this.stateChangeHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingRemoteIce.length = 0;
    this.bufferedLocalIce.length = 0;

    const prev = this.currentState;
    this.currentState = "closed";
    if (prev !== "closed") {
      for (const h of this.stateChangeHandlers) h("closed");
    }

    // Stop SCTP before pc.close() without racing DCEP RECONFIG, and yield I/O
    // event-loop turns so Bun/Linux node:dgram flushes SCTP ABORT UDP packets
    // before pc.close() tears down the underlying UDP socket.
    void (async () => {
      try {
        if (this.pc.sctpTransport) {
          const rawSctp = this.pc.sctpTransport.sctp as
            | { abort?: () => Promise<void> }
            | undefined;
          if (rawSctp && typeof rawSctp.abort === "function") {
            await rawSctp.abort().catch(() => {});
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          await this.pc.sctpTransport.stop();
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
        } else {
          this.controlChannel.close();
          this.swarmChannel.close();
        }
      } catch {
        // Ignore SCTP stop errors
      }
      await this.pc.close().catch(() => {});
    })();
  }

  private emitOrBufferLocalIce(item: LocalIceCandidatePayload | "end"): void {
    if (item === "end") {
      if (this.localIceEnded) return;
      this.localIceEnded = true;
    }

    const hasHandlers =
      item === "end"
        ? this.localIceEndHandlers.size > 0
        : this.localIceCandidateHandlers.size > 0;

    if (this.deferLocalIce || !hasHandlers) {
      this.bufferedLocalIce.push(item);
      return;
    }

    if (item === "end") {
      for (const h of this.localIceEndHandlers) h();
    } else {
      for (const h of this.localIceCandidateHandlers) h(item);
    }
  }

  private flushBufferedLocalIce(): void {
    if (this.closed || this.deferLocalIce) return;
    while (this.bufferedLocalIce.length > 0) {
      const next = this.bufferedLocalIce[0];
      if (!next) {
        this.bufferedLocalIce.shift();
        continue;
      }
      if (next === "end") {
        if (this.localIceEndHandlers.size === 0) break;
        this.bufferedLocalIce.shift();
        for (const h of this.localIceEndHandlers) h();
      } else {
        if (this.localIceCandidateHandlers.size === 0) break;
        this.bufferedLocalIce.shift();
        for (const h of this.localIceCandidateHandlers) h(next);
      }
    }
  }
}

export interface WeriftTransportFactoryOptions {
  icePortRange?: [number, number];
  iceAdditionalHostAddresses?: string[];
  iceUseIpv6?: boolean;
}

export class WeriftTransportFactory implements PeerTransportFactoryPort {
  private readonly options?: WeriftTransportFactoryOptions;

  constructor(options?: WeriftTransportFactoryOptions) {
    this.options = options;
  }

  createPeerConnection(params: {
    localPeerId: string;
    remotePeerId: string;
    isInitiator: boolean;
    iceServers: IceServerConfig[];
  }): PeerConnectionPort {
    return new WeriftPeerConnectionAdapter({
      remotePeerId: params.remotePeerId,
      isInitiator: params.isInitiator,
      iceServers: params.iceServers,
      ...(this.options?.icePortRange !== undefined
        ? { icePortRange: this.options.icePortRange }
        : {}),
      ...(this.options?.iceAdditionalHostAddresses !== undefined
        ? { iceAdditionalHostAddresses: this.options.iceAdditionalHostAddresses }
        : {}),
      ...(this.options?.iceUseIpv6 !== undefined
        ? { iceUseIpv6: this.options.iceUseIpv6 }
        : {}),
    });
  }
}
