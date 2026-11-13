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

function toExactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

class BrowserDataChannelAdapter implements DataChannelPort {
  readonly id: number;
  readonly label: string;
  private readonly dc: RTCDataChannel;

  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(err: unknown) => void>();
  private readonly textHandlers = new Set<(text: string) => void>();
  private readonly binaryHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly bufferedLowHandlers = new Set<() => void>();

  constructor(dc: RTCDataChannel, fallbackId: number) {
    this.dc = dc;
    this.id = dc.id ?? fallbackId;
    this.label = dc.label;
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = SWARM_BUFFERED_LOW_THRESHOLD;

    this.dc.addEventListener("open", () => {
      for (const h of this.openHandlers) {
        h();
      }
    });

    this.dc.addEventListener("close", () => {
      for (const h of this.closeHandlers) {
        h();
      }
    });

    this.dc.addEventListener("error", (ev) => {
      for (const h of this.errorHandlers) {
        h(ev);
      }
    });

    this.dc.addEventListener("bufferedamountlow", () => {
      for (const h of this.bufferedLowHandlers) {
        h();
      }
    });

    this.dc.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data === "string") {
        for (const h of this.textHandlers) {
          h(ev.data);
        }
      } else if (ev.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(ev.data);
        for (const h of this.binaryHandlers) {
          h(bytes);
        }
      } else if (ArrayBuffer.isView(ev.data)) {
        const bytes = new Uint8Array(
          ev.data.buffer,
          ev.data.byteOffset,
          ev.data.byteLength,
        );
        for (const h of this.binaryHandlers) {
          h(bytes);
        }
      } else if (typeof Blob !== "undefined" && ev.data instanceof Blob) {
        void ev.data.arrayBuffer().then((ab) => {
          const bytes = new Uint8Array(ab);
          for (const h of this.binaryHandlers) {
            h(bytes);
          }
        });
      }
    });
  }

  get readyState(): ChannelReadyState {
    return this.dc.readyState;
  }

  get bufferedAmount(): number {
    return this.dc.bufferedAmount;
  }

  get bufferedAmountLowThreshold(): number {
    return this.dc.bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.dc.bufferedAmountLowThreshold = value;
  }

  sendText(text: string): void {
    this.dc.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.dc.send(toExactBuffer(bytes));
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      // Ignore already-closed channel
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

function mapConnectionState(pc: RTCPeerConnection): PeerTransportState {
  const cs = pc.connectionState;
  if (
    cs === "new" ||
    cs === "connecting" ||
    cs === "connected" ||
    cs === "disconnected" ||
    cs === "failed" ||
    cs === "closed"
  ) {
    return cs;
  }
  switch (pc.iceConnectionState) {
    case "checking":
      return "connecting";
    case "connected":
    case "completed":
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

class BrowserPeerConnectionAdapter implements PeerConnectionPort {
  readonly remotePeerId: string;
  readonly isInitiator: boolean;
  readonly controlChannel: DataChannelPort;
  readonly swarmChannel: DataChannelPort;

  private readonly pc: RTCPeerConnection;
  private currentState: PeerTransportState = "new";
  private localFingerprint: string | null = null;
  private remoteFingerprint: string | null = null;
  private remoteDescriptionReady = false;
  private deferLocalIce = false;
  private emittedIceEnd = false;
  private closed = false;
  private readonly bufferedLocalIce: Array<
    Extract<SignalingInnerPayload, { kind: "ice-candidate" }> | "end"
  > = [];
  private readonly pendingRemoteCandidates: RTCIceCandidateInit[] = [];

  private readonly iceCandidateHandlers = new Set<
    (candidate: Extract<SignalingInnerPayload, { kind: "ice-candidate" }>) => void
  >();
  private readonly iceEndHandlers = new Set<() => void>();
  private readonly stateHandlers = new Set<(state: PeerTransportState) => void>();

  constructor(params: {
    remotePeerId: string;
    isInitiator: boolean;
    iceServers: IceServerConfig[];
  }) {
    this.remotePeerId = params.remotePeerId;
    this.isInitiator = params.isInitiator;

    const rtcIceServers: RTCIceServer[] = params.iceServers.map((srv) => ({
      urls: srv.urls,
      ...(srv.username !== undefined ? { username: srv.username } : {}),
      ...(srv.credential !== undefined ? { credential: srv.credential } : {}),
    }));

    this.pc = new RTCPeerConnection({
      iceServers: rtcIceServers,
    });

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

    this.controlChannel = new BrowserDataChannelAdapter(
      rawControl,
      CONTROL_CHANNEL_ID,
    );
    this.swarmChannel = new BrowserDataChannelAdapter(
      rawSwarm,
      SWARM_CHANNEL_ID,
    );

    this.pc.addEventListener("icecandidate", (ev: RTCPeerConnectionIceEvent) => {
      if (this.closed) return;
      const cand = ev.candidate;
      if (!cand || cand.candidate.trim().length === 0) {
        if (!this.emittedIceEnd) {
          this.emittedIceEnd = true;
          this.emitOrBufferLocalIce("end");
        }
        return;
      }

      const payload: Extract<SignalingInnerPayload, { kind: "ice-candidate" }> = {
        kind: "ice-candidate",
        candidate: cand.candidate,
        sdpMid: cand.sdpMid,
        sdpMLineIndex: cand.sdpMLineIndex,
      };
      this.emitOrBufferLocalIce(payload);
    });

    const syncState = (): void => {
      if (this.closed) return;
      const next = mapConnectionState(this.pc);
      if (next !== this.currentState) {
        this.currentState = next;
        for (const h of this.stateHandlers) {
          h(next);
        }
      }
    };

    this.pc.addEventListener("connectionstatechange", syncState);
    this.pc.addEventListener("iceconnectionstatechange", syncState);
  }

  get state(): PeerTransportState {
    return this.currentState;
  }

  async createOffer(): Promise<string> {
    this.emittedIceEnd = false;
    this.deferLocalIce = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription?.sdp ?? offer.sdp ?? "";
      if (!sdp) {
        throw new Error("RTCPeerConnection created an empty SDP offer");
      }
      this.localFingerprint = extractSdpSha256Fingerprint(sdp);
      return sdp;
    } finally {
      this.deferLocalIce = false;
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  async acceptOfferAndCreateAnswer(offerSdp: string): Promise<string> {
    this.emittedIceEnd = false;
    this.remoteFingerprint = extractSdpSha256Fingerprint(offerSdp);
    await this.pc.setRemoteDescription({
      type: "offer",
      sdp: offerSdp,
    });
    this.remoteDescriptionReady = true;
    await this.flushPendingIceCandidates();

    this.deferLocalIce = true;
    try {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const answerSdp = this.pc.localDescription?.sdp ?? answer.sdp ?? "";
      if (!answerSdp) {
        throw new Error("RTCPeerConnection created an empty SDP answer");
      }
      this.localFingerprint = extractSdpSha256Fingerprint(answerSdp);
      return answerSdp;
    } finally {
      this.deferLocalIce = false;
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  async acceptAnswer(answerSdp: string): Promise<void> {
    this.remoteFingerprint = extractSdpSha256Fingerprint(answerSdp);
    await this.pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
    this.remoteDescriptionReady = true;
    await this.flushPendingIceCandidates();
  }

  async addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): Promise<void> {
    if (this.closed) return;
    const rawStr = candidate.candidate.trim();
    if (rawStr.length === 0) {
      await this.endIceCandidates();
      return;
    }

    const normalizedCandidate = rawStr.startsWith("a=")
      ? rawStr.slice(2)
      : rawStr;

    const hasMid = candidate.sdpMid !== undefined && candidate.sdpMid !== null;
    const hasMLine =
      candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null;

    const init: RTCIceCandidateInit = {
      candidate: normalizedCandidate,
      ...(hasMid ? { sdpMid: candidate.sdpMid } : {}),
      ...(hasMLine
        ? { sdpMLineIndex: candidate.sdpMLineIndex }
        : !hasMid
          ? { sdpMLineIndex: 0 }
          : {}),
    };

    if (!this.remoteDescriptionReady) {
      this.pendingRemoteCandidates.push(init);
      return;
    }

    await this.pc.addIceCandidate(init);
  }

  async endIceCandidates(): Promise<void> {
    if (this.closed || !this.remoteDescriptionReady) {
      return;
    }
    try {
      await this.pc.addIceCandidate(null);
    } catch {
      // Some browser engines treat null end-of-candidates as a no-op or unsupported
    }
  }

  getLocalDtlsFingerprint(): string {
    const sdp =
      this.pc.currentLocalDescription?.sdp ?? this.pc.localDescription?.sdp;
    if (sdp) {
      this.localFingerprint = extractSdpSha256Fingerprint(sdp);
    }
    if (!this.localFingerprint) {
      throw new Error("Local DTLS fingerprint is not yet available");
    }
    return this.localFingerprint;
  }

  getRemoteDtlsFingerprint(): string {
    const sdp =
      this.pc.currentRemoteDescription?.sdp ?? this.pc.remoteDescription?.sdp;
    if (sdp) {
      this.remoteFingerprint = extractSdpSha256Fingerprint(sdp);
    }
    if (!this.remoteFingerprint) {
      throw new Error("Remote DTLS fingerprint is not yet available");
    }
    return this.remoteFingerprint;
  }

  onLocalIceCandidate(
    handler: (
      candidate: Extract<SignalingInnerPayload, { kind: "ice-candidate" }>,
    ) => void,
  ): void {
    this.iceCandidateHandlers.add(handler);
    if (!this.deferLocalIce && this.bufferedLocalIce.length > 0) {
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  onLocalIceEnd(handler: () => void): void {
    this.iceEndHandlers.add(handler);
    if (!this.deferLocalIce && this.bufferedLocalIce.length > 0) {
      queueMicrotask(() => this.flushBufferedLocalIce());
    }
  }

  onStateChange(handler: (state: PeerTransportState) => void): void {
    this.stateHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingRemoteCandidates.length = 0;
    this.bufferedLocalIce.length = 0;
    this.controlChannel.close();
    this.swarmChannel.close();
    try {
      this.pc.close();
    } catch {
      // Ignore
    }
    if (this.currentState !== "closed") {
      this.currentState = "closed";
      for (const h of this.stateHandlers) {
        h("closed");
      }
    }
  }

  private emitOrBufferLocalIce(
    item: Extract<SignalingInnerPayload, { kind: "ice-candidate" }> | "end",
  ): void {
    const hasHandlers =
      item === "end"
        ? this.iceEndHandlers.size > 0
        : this.iceCandidateHandlers.size > 0;
    if (this.deferLocalIce || !hasHandlers) {
      this.bufferedLocalIce.push(item);
      return;
    }
    if (item === "end") {
      for (const h of this.iceEndHandlers) {
        h();
      }
    } else {
      for (const h of this.iceCandidateHandlers) {
        h(item);
      }
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
        if (this.iceEndHandlers.size === 0) break;
        this.bufferedLocalIce.shift();
        for (const h of this.iceEndHandlers) {
          h();
        }
      } else {
        if (this.iceCandidateHandlers.size === 0) break;
        this.bufferedLocalIce.shift();
        for (const h of this.iceCandidateHandlers) {
          h(next);
        }
      }
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (this.pendingRemoteCandidates.length === 0) {
      return;
    }
    const queued = this.pendingRemoteCandidates.splice(0);
    for (const cand of queued) {
      if (this.closed) break;
      try {
        await this.pc.addIceCandidate(cand);
      } catch {
        // Ignore stale candidate after state change
      }
    }
  }
}

export class BrowserWebRtcTransportFactory implements PeerTransportFactoryPort {
  createPeerConnection(params: {
    localPeerId: string;
    remotePeerId: string;
    isInitiator: boolean;
    iceServers: IceServerConfig[];
  }): PeerConnectionPort {
    return new BrowserPeerConnectionAdapter({
      remotePeerId: params.remotePeerId,
      isInitiator: params.isInitiator,
      iceServers: params.iceServers,
    });
  }
}
