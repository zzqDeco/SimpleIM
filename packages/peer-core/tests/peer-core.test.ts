import { describe, expect, test } from "bun:test";
import {
  decodeSwarmFrame,
  encodeSwarmFrame,
  MAX_CHAT_LAMPORT,
  MAX_SYNC_MESSAGES,
  RELAY_AEAD_OVERHEAD_BYTES,
  SWARM_CHUNK_SIZE,
  SWARM_HASH_PAGE_CHUNKS,
  SWARM_HEADER_BYTES,
  SWARM_MAX_BUFFERED_AMOUNT,
  SwarmFrameType,
  type ChatMessageEnvelope,
  type FileManifest,
  type SwarmTransferProgress,
} from "@simpleim/contracts";
import {
  bytesToBase64Url,
  computeChannelBindingTranscript,
  createHelloProveFrame,
  createSignedFileManifestFromChunks,
  deriveRelayChunkBlobId,
  deriveRelayFileTag,
  deriveRelayKeys,
  deriveRoomKeys,
  generateEd25519KeyPair,
  issuePeerIdentityCert,
  openPostAuthControlFrame,
  sealPostAuthControlFrame,
  sealRelayChunkBinary,
  signChatMessage,
  type DerivedRoomKeys,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import {
  createRoomPeerEngine,
  SignalingServerError,
  type BlindRelayClientPort,
  type ChatDeliveryStatus,
  type RoomPeerEngine,
  type RoomPeerEngineEvents,
} from "../src/index.ts";
import {
  InMemoryChunkStorage,
  makeDeterministicFingerprint,
  MockBlindRelayHub,
  MockPeerTransportNetwork,
  MockSignalingClient,
  MockSignalingHub,
  type MockPeerConnection,
  type MockPeerConnectionConfig,
} from "./mock-ports.ts";

const FAST_KDF = { memoryKiB: 64, iterations: 1 } as const;

interface TestServerCA {
  serverKeyId: string;
  keyPair: Ed25519KeyPair;
}

function createTestServerCA(): TestServerCA {
  return {
    serverKeyId: "srvk_test_01",
    keyPair: generateEd25519KeyPair(),
  };
}

interface TestPeerRig {
  peerId: string;
  username: string;
  engine: RoomPeerEngine;
  signaling: MockSignalingClient;
  storage: InMemoryChunkStorage;
  connections: MockPeerConnection[];
  signalingKeyPair: Ed25519KeyPair;
  receivedChat: Array<{ msg: ChatMessageEnvelope; isHistoricalSync: boolean }>;
  deliveryChanges: Array<{ msgId: string; status: ChatDeliveryStatus }>;
  announcedFiles: FileManifest[];
  completedFiles: FileManifest[];
  progressEvents: SwarmTransferProgress[];
  authRejections: Array<{ remotePeerId: string; reason: string }>;
  centerStates: boolean[];
}

function createTestPeerRig(params: {
  ca: TestServerCA;
  hub: MockSignalingHub;
  network: MockPeerTransportNetwork;
  roomKeys: DerivedRoomKeys;
  peerId: string;
  username: string;
  clientKind?: "web" | "cli";
  certNowMs?: number;
  certTtlMs?: number;
  maxInFlightPerPeer?: number;
  requestTimeoutMs?: number;
  helloAuthTimeoutMs?: number;
  syncIntervalMs?: number;
  maxSignalPayloadBytes?: number;
  now?: () => number;
  relayClient?: BlindRelayClientPort;
  initialMessages?: readonly ChatMessageEnvelope[];
  initialFiles?: readonly FileManifest[];
  initialPendingRelayMsgIds?: readonly string[];
  initialRelayCursor?: number;
  signalingOptions?: ConstructorParameters<typeof MockSignalingClient>[2];
  transportConfig?: (p: {
    localPeerId: string;
    remotePeerId: string;
    isInitiator: boolean;
  }) => MockPeerConnectionConfig | undefined;
  extraEvents?: RoomPeerEngineEvents;
}): TestPeerRig {
  const peerKeyPair = generateEd25519KeyPair();
  const cert = issuePeerIdentityCert({
    serverKeyId: params.ca.serverKeyId,
    serverSignPrivKey: params.ca.keyPair.privateKeyBytes,
    userId: `usr_${params.username.padEnd(10, "0")}`,
    username: params.username,
    displayName: params.username.toUpperCase(),
    peerId: params.peerId,
    peerSignPubKey: peerKeyPair.publicKeyBase64Url,
    clientKind: params.clientKind ?? "web",
    nowMs: params.certNowMs ?? Date.now() - 5_000,
    ttlMs: params.certTtlMs ?? 3_600_000,
  });

  const signaling = params.hub.createClient(
    params.peerId,
    params.signalingOptions,
  );
  const { factory, createdConnections } = params.network.createFactory(
    params.transportConfig,
  );
  const storage = new InMemoryChunkStorage();

  const receivedChat: Array<{
    msg: ChatMessageEnvelope;
    isHistoricalSync: boolean;
  }> = [];
  const deliveryChanges: Array<{ msgId: string; status: ChatDeliveryStatus }> =
    [];
  const announcedFiles: FileManifest[] = [];
  const completedFiles: FileManifest[] = [];
  const progressEvents: SwarmTransferProgress[] = [];
  const authRejections: Array<{ remotePeerId: string; reason: string }> = [];
  const centerStates: boolean[] = [];

  const engine = createRoomPeerEngine({
    localPeerId: params.peerId,
    localCert: cert,
    localSignKeyPair: peerKeyPair,
    serverSignPubKey: params.ca.keyPair.publicKeyBase64Url,
    roomKeys: params.roomKeys,
    iceServers: [{ urls: ["stun:stun.example.org:3478"] }],
    signaling,
    transportFactory: factory,
    chunkStorage: storage,
    relayClient: params.relayClient,
    initialMessages: params.initialMessages,
    initialFiles: params.initialFiles,
    initialPendingRelayMsgIds: params.initialPendingRelayMsgIds,
    initialRelayCursor: params.initialRelayCursor,
    maxInFlightPerPeer: params.maxInFlightPerPeer,
    requestTimeoutMs: params.requestTimeoutMs,
    helloAuthTimeoutMs: params.helloAuthTimeoutMs,
    syncIntervalMs: params.syncIntervalMs,
    maxSignalPayloadBytes: params.maxSignalPayloadBytes,
    now: params.now,
    events: {
      onCenterConnectionChange: (connected) => {
        centerStates.push(connected);
        params.extraEvents?.onCenterConnectionChange?.(connected);
      },
      onSignalingPeersChange: (count) => {
        params.extraEvents?.onSignalingPeersChange?.(count);
      },
      onPeersChange: (peers) => {
        params.extraEvents?.onPeersChange?.(peers);
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        authRejections.push({ remotePeerId, reason });
        params.extraEvents?.onPeerAuthRejected?.(remotePeerId, reason);
      },
      onPeerTransportFailure: (remotePeerId, reason) => {
        params.extraEvents?.onPeerTransportFailure?.(remotePeerId, reason);
      },
      onChatMessage: (msg, isHistoricalSync) => {
        receivedChat.push({ msg, isHistoricalSync });
        params.extraEvents?.onChatMessage?.(msg, isHistoricalSync);
      },
      onChatDeliveryChange: (msgId, status) => {
        deliveryChanges.push({ msgId, status });
        params.extraEvents?.onChatDeliveryChange?.(msgId, status);
      },
      ...(params.extraEvents?.onRelayBatchPulled
        ? {
            onRelayBatchPulled: params.extraEvents.onRelayBatchPulled,
          }
        : {}),
      onFileAnnounced: (manifest) => {
        announcedFiles.push(manifest);
        params.extraEvents?.onFileAnnounced?.(manifest);
      },
      onTransferProgress: (progress) => {
        progressEvents.push(progress);
        params.extraEvents?.onTransferProgress?.(progress);
      },
      onTransferCompleted: (manifest) => {
        completedFiles.push(manifest);
        params.extraEvents?.onTransferCompleted?.(manifest);
      },
      onError: (err) => {
        params.extraEvents?.onError?.(err);
      },
    },
  });

  return {
    peerId: params.peerId,
    username: params.username,
    engine,
    signaling,
    storage,
    connections: createdConnections,
    signalingKeyPair: peerKeyPair,
    receivedChat,
    deliveryChanges,
    announcedFiles,
    completedFiles,
    progressEvents,
    authRejections,
    centerStates,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}

function makeDeterministicPayload(byteLength: number): Uint8Array {
  const buf = new Uint8Array(byteLength);
  let state = 0x9e3779b9;
  for (let i = 0; i < byteLength; i++) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + i) >>> 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

function makeSliceReader(
  fullBytes: Uint8Array,
): (chunkIndex: number, offset: number, length: number) => Promise<Uint8Array> {
  return async (_chunkIndex, offset, length) => {
    return fullBytes.slice(offset, offset + length);
  };
}

describe("@simpleim/peer-core — RoomPeerEngine", () => {
  test("1. 3-peer Full Mesh auto-connects glare-free, completes HELLO_AUTH, populates RTT, and orders signed chat messages", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("alpha-bravo-room-passphrase", FAST_KDF);

    const peerA = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01aaaaaaaaaa",
      username: "alice",
      clientKind: "web",
    });
    const peerB = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bbbbbbbbbb",
      username: "bob",
      clientKind: "cli",
    });
    const peerC = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_03cccccccccc",
      username: "carol",
      clientKind: "web",
    });

    try {
      await Promise.all([
        peerA.engine.start(),
        peerB.engine.start(),
        peerC.engine.start(),
      ]);

      await waitFor(
        () =>
          peerA.engine.getVerifiedPeers().length === 2 &&
          peerB.engine.getVerifiedPeers().length === 2 &&
          peerC.engine.getVerifiedPeers().length === 2 &&
          peerA.engine.getVerifiedPeers().every((p) => p.rttMs !== null) &&
          peerB.engine.getVerifiedPeers().every((p) => p.rttMs !== null) &&
          peerC.engine.getVerifiedPeers().every((p) => p.rttMs !== null),
      );

      // Verify deterministic glare-free initiator rule: localPeerId < remotePeerId
      expect(peerA.connections.length).toBe(2);
      expect(peerA.connections.every((c) => c.isInitiator)).toBe(true);

      expect(peerB.connections.length).toBe(2);
      const bToA = peerB.connections.find(
        (c) => c.remotePeerId === peerA.peerId,
      );
      const bToC = peerB.connections.find(
        (c) => c.remotePeerId === peerC.peerId,
      );
      expect(bToA?.isInitiator).toBe(false);
      expect(bToC?.isInitiator).toBe(true);

      expect(peerC.connections.length).toBe(2);
      expect(peerC.connections.every((c) => !c.isInitiator)).toBe(true);

      // Verify trickle ICE candidates and end-of-candidates flushed cleanly
      for (const rig of [peerA, peerB, peerC]) {
        for (const pc of rig.connections) {
          expect(pc.receivedIceCandidates.length).toBeGreaterThan(0);
          expect(pc.iceEnded).toBe(true);
        }
      }

      // Verify verified peer identity metadata & RTT
      const aPeers = peerA.engine.getVerifiedPeers();
      expect(aPeers.map((p) => p.username)).toEqual(["bob", "carol"]);
      expect(aPeers.map((p) => p.clientKind)).toEqual(["cli", "web"]);

      // Exchange causal signed chat messages across all 3 peers
      const m1 = await peerA.engine.sendChatMessage("Hello mesh from Alice");
      await waitFor(
        () =>
          peerB.engine.getMessages().length === 1 &&
          peerC.engine.getMessages().length === 1,
      );

      const m2 = await peerB.engine.sendChatMessage(
        "Reply from Bob CLI",
        m1.msgId,
      );
      await waitFor(
        () =>
          peerA.engine.getMessages().length === 2 &&
          peerC.engine.getMessages().length === 2,
      );

      const m3 = await peerC.engine.sendChatMessage("Carol confirms causality");
      await waitFor(
        () =>
          peerA.engine.getMessages().length === 3 &&
          peerB.engine.getMessages().length === 3 &&
          peerC.engine.getMessages().length === 3,
      );

      expect(m1.lamport).toBe(1);
      expect(m2.lamport).toBe(2);
      expect(m2.replyToMsgId).toBe(m1.msgId);
      expect(m3.lamport).toBe(3);

      const expectedIds = [m1.msgId, m2.msgId, m3.msgId];
      expect(peerA.engine.getMessages().map((m) => m.msgId)).toEqual(
        expectedIds,
      );
      expect(peerB.engine.getMessages().map((m) => m.msgId)).toEqual(
        expectedIds,
      );
      expect(peerC.engine.getMessages().map((m) => m.msgId)).toEqual(
        expectedIds,
      );
      expect(peerB.receivedChat.every((e) => !e.isHistoricalSync)).toBe(true);
    } finally {
      await Promise.all([
        peerA.engine.stop(),
        peerB.engine.stop(),
        peerC.engine.stop(),
      ]);
      expect(peerA.storage.closed).toBe(true);
    }
  });

  test("2. Security rejections: wrong roomAuthKey (room_mac_mismatch), expired PeerIdentityCert (cert_expired), signaling MITM DTLS fingerprint swap (channel_binding_sig_mismatch), and UNVERIFIED quarantine", async () => {
    const ca = createTestServerCA();
    const validRoomKeys = deriveRoomKeys("correct-horse-battery", FAST_KDF);
    const wrongRoomKeys = deriveRoomKeys("wrong-attacker-passphrase", FAST_KDF);

    // 2a. Wrong roomAuthKey -> room_mac_mismatch during HELLO_AUTH
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const honest = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_01honestaaaa",
        username: "honest",
      });

      // Attacker joins same roomId/signaling channel to reach WebRTC, but holds wrong roomAuthKey/roomAppKey
      const mismatchedKeys: DerivedRoomKeys = {
        ...validRoomKeys,
        roomAuthKey: wrongRoomKeys.roomAuthKey,
        roomAppKey: wrongRoomKeys.roomAppKey,
      };
      const intruder = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: mismatchedKeys,
        peerId: "peer_02intruderbb",
        username: "intruder",
      });

      await Promise.all([honest.engine.start(), intruder.engine.start()]);
      await waitFor(
        () =>
          honest.authRejections.length === 1 &&
          intruder.authRejections.length === 1,
      );

      expect(honest.authRejections[0]).toEqual({
        remotePeerId: intruder.peerId,
        reason: "room_mac_mismatch",
      });
      expect(honest.engine.getVerifiedPeers()).toHaveLength(0);
      expect(honest.connections[0]?.state).toBe("closed");

      await Promise.all([honest.engine.stop(), intruder.engine.stop()]);
    }

    // 2b. Expired PeerIdentityCert -> cert_expired
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const fixedNow = 1_765_000_000_000;

      const honest = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_01honestaaaa",
        username: "honest",
        certNowMs: fixedNow - 10_000,
        certTtlMs: 3_600_000,
        now: () => fixedNow,
      });
      const expiredPeer = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_02expiredbbb",
        username: "expireduser",
        certNowMs: fixedNow - 120_000,
        certTtlMs: 60_000, // exp = fixedNow - 60_000 (expired!)
        now: () => fixedNow,
      });

      await Promise.all([honest.engine.start(), expiredPeer.engine.start()]);
      await waitFor(() => honest.authRejections.length === 1);

      expect(honest.authRejections[0]).toEqual({
        remotePeerId: expiredPeer.peerId,
        reason: "cert_expired",
      });
      expect(honest.engine.getVerifiedPeers()).toHaveLength(0);
      expect(honest.connections[0]?.state).toBe("closed");

      await Promise.all([honest.engine.stop(), expiredPeer.engine.stop()]);
    }

    // 2c. Simulated signaling MITM altering DTLS fingerprint -> channel_binding_sig_mismatch
    // An insider MITM who knows the room passphrase (and thus roomAuthKey) terminates DTLS with
    // substituted fingerprint, recomputes a valid roomMac for Honest's DTLS transcript, and replays
    // Victim's PeerIdentityCert + peerSig (which signed Victim's real DTLS fingerprint).
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const mitmDtlsFp = makeDeterministicFingerprint("mitm-substituted-dtls");

      const honest = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_01honestaaaa",
        username: "honest",
        transportConfig: () => ({
          overrideRemoteFingerprint: mitmDtlsFp,
        }),
      });

      const victim = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_02victimbbbb",
        username: "victim",
      });

      // Intercept Victim -> Honest hello.prove on wire to simulate MITM re-MACing roomMac with roomAuthKey
      let honestLocalNonce = "";
      let victimLocalNonce = "";
      const origCreate = network.createFactory.bind(network);
      const mitmFactoryWrap = origCreate();
      void mitmFactoryWrap;

      await honest.engine.start();
      await victim.engine.start();

      // Wait until connections are created, then intercept hello frames if needed or verify direct rejection.
      // Notice: Even if MITM re-MACs roomMac, let's test the exact MITM re-MAC attack explicitly too!
      await waitFor(() => honest.authRejections.length === 1);
      await Promise.all([honest.engine.stop(), victim.engine.stop()]);

      // Now run explicit active MITM re-MAC test to verify exact "channel_binding_sig_mismatch" code!
      const hub2 = new MockSignalingHub();
      const net2 = new MockPeerTransportNetwork();

      const honest2 = createTestPeerRig({
        ca,
        hub: hub2,
        network: net2,
        roomKeys: validRoomKeys,
        peerId: "peer_01honestaaaa",
        username: "honest",
      });

      const victimKeyPair = generateEd25519KeyPair();
      const victimPeerId = "peer_02victimbbbb";
      const victimCert = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: "usr_victim0000",
        username: "victim",
        displayName: "VICTIM",
        peerId: victimPeerId,
        peerSignPubKey: victimKeyPair.publicKeyBase64Url,
        clientKind: "cli",
      });

      // MITM acts as signaling peer "peer_02victimbbbb" with its own DTLS cert, knows roomKeys,
      // but does NOT have victimKeyPair.privateKeyBytes (forges/replays victim's peerSig over real Victim FP!)
      const mitmSigClient = hub2.createClient(victimPeerId);
      const { factory: mitmTransportFactory } = net2.createFactory(() => ({
        overrideLocalFingerprint: mitmDtlsFp,
      }));

      await honest2.engine.start();
      await mitmSigClient.connect();
      mitmSigClient.onServerFrame(async (frame) => {
        if (frame.type !== "signal.deliver") return;
        const { openSignalingPayload, sealSignalingPayload, signEd25519 } =
          await import("@simpleim/crypto");
        const inner = openSignalingPayload(
          validRoomKeys.signalingKey,
          validRoomKeys.roomId,
          frame.fromPeerId,
          victimPeerId,
          frame.envelope,
        );
        if (inner.kind === "sdp-offer") {
          const mitmPc = mitmTransportFactory.createPeerConnection({
            localPeerId: victimPeerId,
            remotePeerId: honest2.peerId,
            isInitiator: false,
            iceServers: [],
          });
          mitmPc.controlChannel.onOpen(() => {
            victimLocalNonce = bytesToBase64Url(new Uint8Array(32).fill(7));
            mitmPc.controlChannel.sendText(
              JSON.stringify({
                type: "hello.challenge",
                nonce: victimLocalNonce,
              }),
            );
          });
          mitmPc.controlChannel.onTextMessage((raw) => {
            const parsed = JSON.parse(raw) as { type: string; nonce?: string };
            if (parsed.type === "hello.challenge" && parsed.nonce) {
              honestLocalNonce = parsed.nonce;
              // Victim signed transcript with Victim's real DTLS fingerprint (NOT mitmDtlsFp!)
              const victimRealFp =
                makeDeterministicFingerprint("victim-real-dtls");
              const victimTranscript = computeChannelBindingTranscript({
                roomId: validRoomKeys.roomId,
                localPeerId: victimPeerId,
                remotePeerId: honest2.peerId,
                localFingerprint: victimRealFp,
                remoteFingerprint: mitmPc.getRemoteDtlsFingerprint(),
                localNonce: victimLocalNonce,
                remoteNonce: honestLocalNonce,
              });
              const replayedVictimSig = signEd25519(
                victimKeyPair.privateKeyBytes,
                victimTranscript,
              );

              // Insider MITM recomputes valid roomMac over Honest's observed DTLS transcript!
              const mitmDummyKey = generateEd25519KeyPair();
              const mitmMacHelper = createHelloProveFrame({
                roomId: validRoomKeys.roomId,
                roomAuthKey: validRoomKeys.roomAuthKey,
                cert: victimCert,
                peerSignPrivKey: mitmDummyKey.privateKeyBytes,
                localPeerId: victimPeerId,
                remotePeerId: honest2.peerId,
                localFingerprint: mitmDtlsFp,
                remoteFingerprint: mitmPc.getRemoteDtlsFingerprint(),
                localNonce: victimLocalNonce,
                remoteNonce: honestLocalNonce,
              });
              const forgedRoomMac = mitmMacHelper.roomMac;

              // Also try to sneak in a sealed chat message and binary chunk before rejection!
              const forgedMsg = signChatMessage({
                roomId: validRoomKeys.roomId,
                lamport: 1,
                body: "MITM injected chat before auth!",
                authorCert: victimCert,
                peerSignPrivKey: victimKeyPair.privateKeyBytes,
              });
              const sealedChat = sealPostAuthControlFrame(
                validRoomKeys.roomAppKey,
                validRoomKeys.roomId,
                { type: "chat.message", message: forgedMsg },
              );
              mitmPc.controlChannel.sendText(JSON.stringify(sealedChat));

              mitmPc.controlChannel.sendText(
                JSON.stringify({
                  type: "hello.prove",
                  cert: victimCert,
                  roomMac: forgedRoomMac,
                  peerSig: replayedVictimSig,
                }),
              );
            }
          });
          const ans = await mitmPc.acceptOfferAndCreateAnswer(inner.sdp);
          mitmSigClient.send({
            type: "signal.relay",
            roomId: validRoomKeys.roomId,
            toPeerId: honest2.peerId,
            envelope: sealSignalingPayload(
              validRoomKeys.signalingKey,
              validRoomKeys.roomId,
              victimPeerId,
              honest2.peerId,
              { kind: "sdp-answer", sdp: ans },
            ),
          });
        }
      });
      mitmSigClient.send({ type: "room.join", roomId: validRoomKeys.roomId });

      await waitFor(() => honest2.authRejections.length === 1);
      expect(honest2.authRejections[0]).toEqual({
        remotePeerId: victimPeerId,
        reason: "channel_binding_sig_mismatch",
      });
      expect(honest2.engine.getVerifiedPeers()).toHaveLength(0);
      expect(honest2.engine.getMessages()).toHaveLength(0);
      expect(honest2.engine.getFiles()).toHaveLength(0);
      expect(honest2.connections[0]?.state).toBe("closed");

      mitmSigClient.disconnect();
      await honest2.engine.stop();
    }

    // 2d. UNVERIFIED quarantine + hello_auth_timeout when remote stalls handshake
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const honest = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys: validRoomKeys,
        peerId: "peer_01honestaaaa",
        username: "honest",
        helloAuthTimeoutMs: 60,
      });

      const silentPeerId = "peer_02silentbbbb";
      const silentClient = hub.createClient(silentPeerId);
      const { factory: silentFactory } = network.createFactory();

      await honest.engine.start();
      await silentClient.connect();
      silentClient.onServerFrame(async (frame) => {
        if (frame.type !== "signal.deliver") return;
        const { openSignalingPayload, sealSignalingPayload } = await import(
          "@simpleim/crypto"
        );
        const inner = openSignalingPayload(
          validRoomKeys.signalingKey,
          validRoomKeys.roomId,
          frame.fromPeerId,
          silentPeerId,
          frame.envelope,
        );
        if (inner.kind === "sdp-offer") {
          const pc = silentFactory.createPeerConnection({
            localPeerId: silentPeerId,
            remotePeerId: honest.peerId,
            isInitiator: false,
            iceServers: [],
          });
          // Send Swarm binary frame while UNVERIFIED; never send hello.prove!
          pc.swarmChannel.onOpen(() => {
            pc.swarmChannel.sendBinary(
              encodeSwarmFrame({
                frameType: SwarmFrameType.BITFIELD,
                fileId: "019a0000-0000-7000-8000-000000000001",
                chunkIndex: 0,
                payload: new Uint8Array([0xff]),
              }),
            );
          });
          const ans = await pc.acceptOfferAndCreateAnswer(inner.sdp);
          silentClient.send({
            type: "signal.relay",
            roomId: validRoomKeys.roomId,
            toPeerId: honest.peerId,
            envelope: sealSignalingPayload(
              validRoomKeys.signalingKey,
              validRoomKeys.roomId,
              silentPeerId,
              honest.peerId,
              { kind: "sdp-answer", sdp: ans },
            ),
          });
        }
      });
      silentClient.send({ type: "room.join", roomId: validRoomKeys.roomId });

      await waitFor(() => honest.authRejections.length === 1);
      expect(honest.authRejections[0]).toEqual({
        remotePeerId: silentPeerId,
        reason: "hello_auth_timeout",
      });
      expect(honest.engine.getVerifiedPeers()).toHaveLength(0);

      silentClient.disconnect();
      await honest.engine.stop();
    }
  });

  test("3. Center-server shutdown survival: active P2P mesh keeps exchanging chat & files after MockSignalingHub shuts down", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("center-detached-survival-room", FAST_KDF);

    const peerA = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01aaaaaaaaaa",
      username: "alice",
    });
    const peerB = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bbbbbbbbbb",
      username: "bob",
    });
    const peerC = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_03cccccccccc",
      username: "carol",
    });

    try {
      await Promise.all([
        peerA.engine.start(),
        peerB.engine.start(),
        peerC.engine.start(),
      ]);

      await waitFor(
        () =>
          peerA.engine.getVerifiedPeers().length === 2 &&
          peerB.engine.getVerifiedPeers().length === 2 &&
          peerC.engine.getVerifiedPeers().length === 2,
      );

      expect(peerA.engine.isCenterConnected()).toBe(true);

      // Shut down the central signaling server completely!
      hub.shutdownCenterServer();

      expect(peerA.engine.isCenterConnected()).toBe(false);
      expect(peerB.engine.isCenterConnected()).toBe(false);
      expect(peerC.engine.isCenterConnected()).toBe(false);
      expect(peerA.centerStates).toContain(false);

      // Active P2P channels MUST stay open and verified!
      expect(peerA.engine.getVerifiedPeers()).toHaveLength(2);
      expect(peerB.engine.getVerifiedPeers()).toHaveLength(2);
      expect(peerC.engine.getVerifiedPeers()).toHaveLength(2);

      // Exchange chat messages with center server dead
      const offlineMsg = await peerB.engine.sendChatMessage(
        "Center server is down, P2P lives on!",
      );
      await waitFor(
        () =>
          peerA.engine.getMessages().some((m) => m.msgId === offlineMsg.msgId) &&
          peerC.engine.getMessages().some((m) => m.msgId === offlineMsg.msgId),
      );

      // Share and transfer a 200 KiB multi-chunk file with center server dead
      const fileBytes = makeDeterministicPayload(200_000);
      const manifest = await peerA.engine.shareFile({
        fileName: "offline-survival.bin",
        fileSize: fileBytes.byteLength,
        mimeType: "application/octet-stream",
        readChunk: makeSliceReader(fileBytes),
      });

      await waitFor(
        () =>
          peerB.announcedFiles.length === 1 && peerC.announcedFiles.length === 1,
      );

      await Promise.all([
        peerB.engine.downloadFile(manifest.fileId),
        peerC.engine.downloadFile(manifest.fileId),
      ]);

      await waitFor(
        () =>
          peerB.completedFiles.length === 1 && peerC.completedFiles.length === 1,
      );

      expect(peerB.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        fileBytes,
      );
      expect(peerC.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        fileBytes,
      );

      // Restart center server & reconnect signaling -> room.join is re-sent without disturbing active P2P channels,
      // and newly joining Peer D connects to the existing mesh and syncs messages/files created while center was offline!
      hub.restartCenterServer();
      await Promise.all([
        peerA.signaling.connect(),
        peerB.signaling.connect(),
        peerC.signaling.connect(),
      ]);
      expect(peerA.engine.isCenterConnected()).toBe(true);
      expect(peerA.engine.getVerifiedPeers()).toHaveLength(2);

      const peerD = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_04dddddddddd",
        username: "dave",
      });
      await peerD.engine.start();
      await waitFor(
        () =>
          peerD.engine.getVerifiedPeers().length === 3 &&
          peerD.engine.getMessages().some((m) => m.msgId === offlineMsg.msgId) &&
          peerD.engine.getFiles().some((f) => f.fileId === manifest.fileId),
      );
      await peerD.engine.stop();
    } finally {
      await Promise.all([
        peerA.engine.stop(),
        peerB.engine.stop(),
        peerC.engine.stop(),
      ]);
    }
  });

  test("4. Online catch-up sync: late-joining Peer C syncs verified messages & FileManifests while rejecting forged relayed signatures", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("catch-up-sync-room", FAST_KDF);

    const peerA = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01aaaaaaaaaa",
      username: "alice",
    });
    const peerB = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bbbbbbbbbb",
      username: "bob",
    });

    const sharedBytes = makeDeterministicPayload(150_000);

    try {
      await Promise.all([peerA.engine.start(), peerB.engine.start()]);
      await waitFor(
        () =>
          peerA.engine.getVerifiedPeers().length === 1 &&
          peerB.engine.getVerifiedPeers().length === 1,
      );

      const m1 = await peerA.engine.sendChatMessage("First historical message");
      await waitFor(() => peerB.engine.getMessages().length === 1);
      const m2 = await peerB.engine.sendChatMessage(
        "Second historical message",
        m1.msgId,
      );
      await waitFor(() => peerA.engine.getMessages().length === 2);
      const m3 = await peerA.engine.sendChatMessage("Third historical message");
      await waitFor(() => peerB.engine.getMessages().length === 3);

      const manifest = await peerA.engine.shareFile({
        fileName: "design-spec.pdf",
        fileSize: sharedBytes.byteLength,
        mimeType: "application/pdf",
        readChunk: makeSliceReader(sharedBytes),
      });
      await waitFor(() => peerB.engine.getFiles().length === 1);

      // Now Peer C joins late!
      const peerC = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_03cccccccccc",
        username: "carol",
      });

      await peerC.engine.start();
      await waitFor(
        () =>
          peerC.engine.getVerifiedPeers().length === 2 &&
          peerC.engine.getMessages().length === 3 &&
          peerC.engine.getFiles().length === 1,
      );

      expect(peerC.engine.getMessages().map((m) => m.msgId)).toEqual([
        m1.msgId,
        m2.msgId,
        m3.msgId,
      ]);
      expect(peerC.receivedChat).toHaveLength(3);
      expect(peerC.receivedChat.every((item) => item.isHistoricalSync)).toBe(
        true,
      );
      expect(peerC.engine.getFiles()[0]?.fileId).toBe(manifest.fileId);

      // Inject a sync.batch from Peer B's open control channel containing 1 forged message & 1 valid message
      const validExtraMsg = signChatMessage({
        roomId: roomKeys.roomId,
        lamport: 10,
        body: "Valid relayed message",
        authorCert: issuePeerIdentityCert({
          serverKeyId: ca.serverKeyId,
          serverSignPrivKey: ca.keyPair.privateKeyBytes,
          userId: "usr_alice00000",
          username: "alice",
          displayName: "ALICE",
          peerId: peerA.peerId,
          peerSignPubKey: peerA.signalingKeyPair.publicKeyBase64Url,
          clientKind: "web",
        }),
        peerSignPrivKey: peerA.signalingKeyPair.privateKeyBytes,
      });

      const forgedMsg: ChatMessageEnvelope = {
        ...m1,
        msgId: "019a9999-9999-7999-8999-999999999999",
        lamport: 9,
        body: "FORGED TAMPERED MESSAGE BODY!",
      };

      const bToCConn = peerB.connections.find(
        (c) => c.remotePeerId === peerC.peerId,
      )!;
      const sealedTamperedBatch = sealPostAuthControlFrame(
        roomKeys.roomAppKey,
        roomKeys.roomId,
        {
          type: "sync.batch",
          messages: [forgedMsg, validExtraMsg],
          files: [],
        },
      );
      bToCConn.controlChannel.sendText(JSON.stringify(sealedTamperedBatch));

      await waitFor(() => peerC.engine.getMessages().length === 4);
      const cMsgs = peerC.engine.getMessages();
      expect(cMsgs.some((m) => m.msgId === forgedMsg.msgId)).toBe(false);
      expect(cMsgs.some((m) => m.msgId === validExtraMsg.msgId)).toBe(true);

      // Verify Peer C can also download the synced FileManifest seamlessly!
      await peerC.engine.downloadFile(manifest.fileId);
      await waitFor(() => peerC.completedFiles.length === 1);
      expect(peerC.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        sharedBytes,
      );

      await peerC.engine.stop();
    } finally {
      await Promise.all([peerA.engine.stop(), peerB.engine.stop()]);
    }
  });

  test("5a. 4-peer Swarm multi-source file transfer (22 chunks / ~1.4 MiB): concurrent download, HAVE re-seeding, and bufferedAmount >= 1 MiB backpressure pause/resume", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("four-peer-swarm-room", FAST_KDF);

    // 22 chunks (21 * 64 KiB + 32,777 B tail = 1,409,033 B > 1 MiB)
    const totalBytes = 21 * SWARM_CHUNK_SIZE + 32_777;
    const originalPayload = makeDeterministicPayload(totalBytes);

    // Give Seeder A a 6ms simulated network drain delay so bufferedAmount hits >= 1 MiB backpressure!
    const seederA = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01seederaaaa",
      username: "seeder",
      maxInFlightPerPeer: 24,
      transportConfig: () => ({ swarmFlushDelayMs: 6 }),
    });
    const leecherB = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02leecherbbb",
      username: "bob",
      maxInFlightPerPeer: 4,
      transportConfig: () => ({ swarmFlushDelayMs: 1 }),
    });
    const leecherC = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_03leecherccc",
      username: "carol",
      maxInFlightPerPeer: 4,
      transportConfig: () => ({ swarmFlushDelayMs: 1 }),
    });
    const leecherD = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_04leecherddd",
      username: "dave",
      maxInFlightPerPeer: 4,
      transportConfig: () => ({ swarmFlushDelayMs: 1 }),
    });

    try {
      await Promise.all([
        seederA.engine.start(),
        leecherB.engine.start(),
        leecherC.engine.start(),
        leecherD.engine.start(),
      ]);

      await waitFor(
        () =>
          seederA.engine.getVerifiedPeers().length === 3 &&
          leecherB.engine.getVerifiedPeers().length === 3 &&
          leecherC.engine.getVerifiedPeers().length === 3 &&
          leecherD.engine.getVerifiedPeers().length === 3,
      );

      const manifest = await seederA.engine.shareFile({
        fileName: "release-bundle.tar.zst",
        fileSize: originalPayload.byteLength,
        mimeType: "application/zstd",
        readChunk: makeSliceReader(originalPayload),
      });
      expect(manifest.totalChunks).toBe(22);

      await waitFor(
        () =>
          leecherB.announcedFiles.length === 1 &&
          leecherC.announcedFiles.length === 1 &&
          leecherD.announcedFiles.length === 1,
      );

      // Start concurrent downloads on Peers B, C, and D
      await Promise.all([
        leecherB.engine.downloadFile(manifest.fileId),
        leecherC.engine.downloadFile(manifest.fileId),
        leecherD.engine.downloadFile(manifest.fileId),
      ]);

      await waitFor(
        () =>
          leecherB.completedFiles.length === 1 &&
          leecherC.completedFiles.length === 1 &&
          leecherD.completedFiles.length === 1,
        5_000,
      );

      // Verify 100% byte-for-byte equality across all 3 downloaders
      expect(leecherB.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        originalPayload,
      );
      expect(leecherC.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        originalPayload,
      );
      expect(leecherD.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        originalPayload,
      );

      // Verify all 3 downloaders transitioned to "seeding"
      expect(leecherB.engine.getTransferProgress(manifest.fileId)?.status).toBe(
        "seeding",
      );
      expect(leecherC.engine.getTransferProgress(manifest.fileId)?.status).toBe(
        "seeding",
      );
      expect(leecherD.engine.getTransferProgress(manifest.fileId)?.status).toBe(
        "seeding",
      );

      // Verify multi-peer Swarm cross-seeding: leechers B, C, D served chunks to each other via HAVE!
      const crossSeededChunks =
        leecherB.storage.chunksServedCount +
        leecherC.storage.chunksServedCount +
        leecherD.storage.chunksServedCount;
      expect(crossSeededChunks).toBeGreaterThan(0);

      // Verify Seeder A enforced bufferedAmount <= ~1 MiB high-water mark and resumed on bufferedAmountLow!
      const maxPeakOnSeeder = Math.max(
        ...seederA.connections.map((c) => c.swarmChannel.stats.peakBufferedAmount),
      );
      const totalLowEventsOnSeeder = seederA.connections.reduce(
        (sum, c) => sum + c.swarmChannel.stats.bufferedAmountLowEvents,
        0,
      );

      // If 22 chunks (22 * 65,562 = 1,442,364 B) had been dumped without backpressure, peak would exceed 1.4 MiB.
      // With backpressure at 1,048,576 B, peak stays bounded to <= 1_048_576 + 1 single frame (65,562 B)!
      expect(maxPeakOnSeeder).toBeLessThanOrEqual(
        SWARM_MAX_BUFFERED_AMOUNT + SWARM_CHUNK_SIZE + SWARM_HEADER_BYTES,
      );

      // Also explicitly trigger a single-peer 22-chunk burst against Seeder A to deterministically assert
      // crossing SWARM_MAX_BUFFERED_AMOUNT AND firing bufferedAmountLowEvents >= 1!
      const leecherE = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_05leechereee",
        username: "erin",
        maxInFlightPerPeer: 22,
      });
      // Pause B/C/D cross-seeding by stopping them first so E pulls all 22 chunks straight from Seeder A!
      await Promise.all([
        leecherB.engine.stop(),
        leecherC.engine.stop(),
        leecherD.engine.stop(),
      ]);

      await leecherE.engine.start();
      await waitFor(
        () =>
          leecherE.engine.getVerifiedPeers().length === 1 &&
          leecherE.engine.getFiles().length === 1,
      );
      await leecherE.engine.downloadFile(manifest.fileId);
      await waitFor(() => leecherE.completedFiles.length === 1, 5_000);

      const aToEConn = seederA.connections.find(
        (c) => c.remotePeerId === leecherE.peerId,
      )!;
      expect(aToEConn.swarmChannel.stats.peakBufferedAmount).toBeGreaterThanOrEqual(
        SWARM_MAX_BUFFERED_AMOUNT,
      );
      expect(aToEConn.swarmChannel.stats.peakBufferedAmount).toBeLessThanOrEqual(
        SWARM_MAX_BUFFERED_AMOUNT + SWARM_CHUNK_SIZE + SWARM_HEADER_BYTES,
      );
      expect(
        aToEConn.swarmChannel.stats.bufferedAmountLowEvents,
      ).toBeGreaterThanOrEqual(1);
      expect(leecherE.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        originalPayload,
      );
      void totalLowEventsOnSeeder;

      await leecherE.engine.stop();
    } finally {
      await Promise.all([
        seederA.engine.stop(),
        leecherB.engine.stop(),
        leecherC.engine.stop(),
        leecherD.engine.stop(),
      ]);
    }
  });

  test("5b. Swarm chunk poisoning defense: corrupting peer is evicted after 3 strikes and receiver recovers 100% from honest seeder", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("poison-strike-defense-room", FAST_KDF);

    const payloadBytes = makeDeterministicPayload(20 * SWARM_CHUNK_SIZE + 4_096); // 21 chunks

    // Honest Seeder A has slight flush delay (4ms) while Malicious Peer M responds immediately with corrupted chunks
    const honestSeeder = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01honestseed",
      username: "alice",
      transportConfig: () => ({ swarmFlushDelayMs: 4 }),
    });

    const maliciousSeeder = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02maliciousm",
      username: "mallory",
    });

    const receiver = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_03receiverbb",
      username: "bob",
      maxInFlightPerPeer: 16,
    });

    let corruptedChunksSent = 0;

    try {
      await Promise.all([
        honestSeeder.engine.start(),
        maliciousSeeder.engine.start(),
        receiver.engine.start(),
      ]);

      await waitFor(
        () =>
          honestSeeder.engine.getVerifiedPeers().length === 2 &&
          maliciousSeeder.engine.getVerifiedPeers().length === 2 &&
          receiver.engine.getVerifiedPeers().length === 2,
      );

      // Honest Seeder shares file; Malicious peer downloads it honestly first so it holds all chunks,
      // then flips bits on every outgoing CHUNK it sends to Receiver!
      const manifest = await honestSeeder.engine.shareFile({
        fileName: "critical-firmware.bin",
        fileSize: payloadBytes.byteLength,
        readChunk: makeSliceReader(payloadBytes),
      });

      await waitFor(
        () =>
          maliciousSeeder.announcedFiles.length === 1 &&
          receiver.announcedFiles.length === 1,
      );

      await maliciousSeeder.engine.downloadFile(manifest.fileId);
      await waitFor(() => maliciousSeeder.completedFiles.length === 1);

      // Arm Mallory's outgoing swarmChannel toward Receiver to corrupt every CHUNK payload!
      const malloryToBob = maliciousSeeder.connections.find(
        (c) => c.remotePeerId === receiver.peerId,
      )!;
      malloryToBob.swarmChannel.setBinaryOutgoingInterceptor((raw) => {
        const decoded = decodeSwarmFrame(raw);
        if (decoded.frameType === SwarmFrameType.CHUNK) {
          corruptedChunksSent += 1;
          const poisonedPayload = decoded.payload.slice();
          poisonedPayload[0] = (poisonedPayload[0]! ^ 0xff) & 0xff;
          return encodeSwarmFrame({
            frameType: SwarmFrameType.CHUNK,
            fileId: decoded.fileId,
            chunkIndex: decoded.chunkIndex,
            payload: poisonedPayload,
          });
        }
        return raw;
      });

      await receiver.engine.downloadFile(manifest.fileId);
      await waitFor(() => receiver.completedFiles.length === 1, 5_000);

      // Verify Mallory sent >= 3 corrupted chunks and was automatically evicted after 3 strikes!
      expect(corruptedChunksSent).toBeGreaterThanOrEqual(3);
      expect(receiver.engine.getVerifiedPeers().map((p) => p.peerId)).toEqual([
        honestSeeder.peerId,
      ]);

      // Verify 100% byte-for-byte integrity on Receiver's finalized output!
      expect(receiver.storage.getFinalizedBytes(manifest.fileId)).toEqual(
        payloadBytes,
      );
    } finally {
      await Promise.all([
        honestSeeder.engine.stop(),
        maliciousSeeder.engine.stop(),
        receiver.engine.stop(),
      ]);
    }
  });

  test("6. Swarm edge cases: 0-byte file, partial existingBitfield resume, Endgame CANCEL, and cancelDownload", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("swarm-edge-cases-room", FAST_KDF);

    const peerA = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01aaaaaaaaaa",
      username: "alice",
    });
    const peerB = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bbbbbbbbbb",
      username: "bob",
    });
    const peerC = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_03cccccccccc",
      username: "carol",
    });

    try {
      await Promise.all([
        peerA.engine.start(),
        peerB.engine.start(),
        peerC.engine.start(),
      ]);
      await waitFor(
        () =>
          peerA.engine.getVerifiedPeers().length === 2 &&
          peerB.engine.getVerifiedPeers().length === 2 &&
          peerC.engine.getVerifiedPeers().length === 2,
      );

      // 6a. 0-byte empty file finalizes immediately
      const emptyManifest = await peerA.engine.shareFile({
        fileName: "empty.txt",
        fileSize: 0,
        mimeType: "text/plain",
        readChunk: async () => new Uint8Array(0),
      });
      expect(emptyManifest.totalChunks).toBe(0);
      await waitFor(() => peerB.announcedFiles.length === 1);
      await peerB.engine.downloadFile(emptyManifest.fileId);
      expect(peerB.completedFiles[0]?.fileId).toBe(emptyManifest.fileId);
      expect(peerB.storage.getFinalizedBytes(emptyManifest.fileId)).toEqual(
        new Uint8Array(0),
      );
      expect(
        peerB.engine.getTransferProgress(emptyManifest.fileId)?.status,
      ).toBe("seeding");

      // 6b. Partial existingBitfield resume + Endgame CANCEL
      const resumeBytes = makeDeterministicPayload(4 * SWARM_CHUNK_SIZE); // 4 chunks
      const resumeManifest = await peerA.engine.shareFile({
        fileName: "resume-test.bin",
        fileSize: resumeBytes.byteLength,
        readChunk: makeSliceReader(resumeBytes),
      });
      await waitFor(
        () =>
          peerB.announcedFiles.length === 2 && peerC.announcedFiles.length === 2,
      );

      // Let Peer B complete download so both A and B seed all 4 chunks
      await peerB.engine.downloadFile(resumeManifest.fileId);
      await waitFor(() => peerB.completedFiles.length === 2);

      // Pre-populate chunks 0, 1, 2 on Peer C so only 1 chunk (chunk 3) remains -> immediate Endgame mode!
      peerC.storage.seedPartialPreExistingChunks(
        resumeManifest,
        new Map([
          [0, resumeBytes.slice(0, SWARM_CHUNK_SIZE)],
          [1, resumeBytes.slice(SWARM_CHUNK_SIZE, 2 * SWARM_CHUNK_SIZE)],
          [2, resumeBytes.slice(2 * SWARM_CHUNK_SIZE, 3 * SWARM_CHUNK_SIZE)],
        ]),
      );

      // Stall Peer A's CHUNK response so Peer B wins the Endgame race and Peer C sends CANCEL to Peer A!
      let cancelReceivedByA = false;
      const aToC = peerA.connections.find(
        (c) => c.remotePeerId === peerC.peerId,
      )!;
      const cToA = peerC.connections.find(
        (c) => c.remotePeerId === peerA.peerId,
      )!;
      aToC.swarmChannel.setBinaryOutgoingInterceptor((raw) => {
        const frame = decodeSwarmFrame(raw);
        if (
          frame.frameType === SwarmFrameType.CHUNK &&
          frame.fileId === resumeManifest.fileId
        ) {
          return null; // Drop/stall A's chunk so B wins Endgame
        }
        return raw;
      });
      const origSendBinary = cToA.swarmChannel.sendBinary.bind(
        cToA.swarmChannel,
      );
      cToA.swarmChannel.sendBinary = (bytes: Uint8Array) => {
        const frame = decodeSwarmFrame(bytes);
        if (
          frame.frameType === SwarmFrameType.CANCEL &&
          frame.fileId === resumeManifest.fileId &&
          frame.chunkIndex === 3
        ) {
          cancelReceivedByA = true;
        }
        origSendBinary(bytes);
      };

      await peerC.engine.downloadFile(resumeManifest.fileId);
      await waitFor(() => peerC.completedFiles.length === 1);

      expect(peerC.storage.chunksWrittenCount).toBe(1); // Only chunk 3 needed to be transferred!
      expect(cancelReceivedByA).toBe(true);
      expect(peerC.storage.getFinalizedBytes(resumeManifest.fileId)).toEqual(
        resumeBytes,
      );

      // 6c. cancelDownload transitions to "paused" and deletes receiving file
      aToC.swarmChannel.setBinaryOutgoingInterceptor(() => null);
      const bToC = peerB.connections.find(
        (c) => c.remotePeerId === peerC.peerId,
      )!;
      bToC.swarmChannel.setBinaryOutgoingInterceptor((raw) => {
        const frame = decodeSwarmFrame(raw);
        if (frame.frameType === SwarmFrameType.CHUNK) {
          return null; // Stall chunks so download stays in-progress until cancelled
        }
        return raw;
      });

      const cancelTestBytes = makeDeterministicPayload(3 * SWARM_CHUNK_SIZE);
      const cancelManifest = await peerA.engine.shareFile({
        fileName: "cancel-me.bin",
        fileSize: cancelTestBytes.byteLength,
        readChunk: makeSliceReader(cancelTestBytes),
      });
      await waitFor(() => peerC.announcedFiles.length === 3);

      await peerC.engine.downloadFile(cancelManifest.fileId);
      expect(
        peerC.engine.getTransferProgress(cancelManifest.fileId)?.status,
      ).toBe("downloading");

      await peerC.engine.cancelDownload(cancelManifest.fileId);
      expect(
        peerC.engine.getTransferProgress(cancelManifest.fileId)?.status,
      ).toBe("paused");
      expect(peerC.storage.deletedFileIds).toContain(cancelManifest.fileId);
    } finally {
      await Promise.all([
        peerA.engine.stop(),
        peerB.engine.stop(),
        peerC.engine.stop(),
      ]);
    }
  });

  test("7. Regression guards: start() retry, post-open helloAuthTimeout, MAX_CHAT_LAMPORT bound, BITFIELD/HAVE OR-merge, async cancel race, timeout deprioritization, write backpressure, and >512-chunk paged FileManifest", async () => {
    const ca = createTestServerCA();
    const roomKeys = deriveRoomKeys("codex-peer-core-regressions", FAST_KDF);

    // 7a + 7b. engine.start() recovers after signaling.connect() failure AND helloAuthTimeoutMs starts only on dc:0 open
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      hub.shutdownCenterServer(); // Initially offline!

      const peerA = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01aaaaaaaaaa",
        username: "alice",
        helloAuthTimeoutMs: 50,
      });
      const peerB = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02bbbbbbbbbb",
        username: "bob",
        helloAuthTimeoutMs: 50,
        signalingOptions: {
          interceptOutgoing: (frame, defaultSend) => {
            if (frame.type === "signal.relay") {
              // Delay SDP answer / ICE > helloAuthTimeoutMs (50ms) before dc:0 opens!
              setTimeout(() => defaultSend(frame), 90);
              return;
            }
            defaultSend(frame);
          },
        },
      });

      try {
        await expect(peerA.engine.start()).rejects.toThrow(
          "Center signaling server is offline",
        );

        // Retry after center server comes back online!
        hub.restartCenterServer();
        await Promise.all([peerA.engine.start(), peerB.engine.start()]);

        await waitFor(
          () =>
            peerA.engine.getVerifiedPeers().length === 1 &&
            peerB.engine.getVerifiedPeers().length === 1,
        );
        expect(peerA.authRejections).toHaveLength(0);
        expect(peerB.authRejections).toHaveLength(0);

        // 7c. MAX_CHAT_LAMPORT guard rejects oversized remote Lamport clocks without overflowing local clock
        const forgedHighLamport = signChatMessage({
          roomId: roomKeys.roomId,
          lamport: MAX_CHAT_LAMPORT + 1,
          body: "Overflow attempt",
          authorCert: issuePeerIdentityCert({
            serverKeyId: ca.serverKeyId,
            serverSignPrivKey: ca.keyPair.privateKeyBytes,
            userId: "usr_bob0000000",
            username: "bob",
            displayName: "BOB",
            peerId: peerB.peerId,
            peerSignPubKey: peerB.signalingKeyPair.publicKeyBase64Url,
            clientKind: "web",
          }),
          peerSignPrivKey: peerB.signalingKeyPair.privateKeyBytes,
        });
        const bToA = peerB.connections.find(
          (c) => c.remotePeerId === peerA.peerId,
        )!;
        bToA.controlChannel.sendText(
          JSON.stringify(
            sealPostAuthControlFrame(roomKeys.roomAppKey, roomKeys.roomId, {
              type: "chat.message",
              message: forgedHighLamport,
            }),
          ),
        );

        const cleanMsg = await peerA.engine.sendChatMessage("Safe lamport");
        expect(cleanMsg.lamport).toBe(1);
        await waitFor(() => peerB.engine.getMessages().length === 1);
        expect(peerA.engine.getMessages().map((m) => m.msgId)).toEqual([
          cleanMsg.msgId,
        ]);
      } finally {
        await Promise.all([peerA.engine.stop(), peerB.engine.stop()]);
      }
    }

    // 7d + 7e + 7f + 7g. BITFIELD/HAVE OR-merge, cancelDownload during async initReceivingFile,
    // timed-out source deprioritization, and pendingStorageWrites backpressure
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const seederA = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01seederaaaa",
        username: "alice",
      });
      const seederB = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02seederbbbb",
        username: "bob",
      });
      const receiverC = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_03receivercc",
        username: "carol",
        maxInFlightPerPeer: 2,
        requestTimeoutMs: 40,
      });

      try {
        await Promise.all([
          seederA.engine.start(),
          seederB.engine.start(),
          receiverC.engine.start(),
        ]);
        await waitFor(
          () =>
            seederA.engine.getVerifiedPeers().length === 2 &&
            seederB.engine.getVerifiedPeers().length === 2 &&
            receiverC.engine.getVerifiedPeers().length === 2,
        );

        // 7d. Out-of-order HAVE(1) followed by stale BITFIELD([0x01]) OR-merges so chunk 1 stays available
        const twoChunkBytes = makeDeterministicPayload(2 * SWARM_CHUNK_SIZE);
        const aToC = seederA.connections.find(
          (c) => c.remotePeerId === receiverC.peerId,
        )!;
        // Intercept Seeder A's initial BITFIELD to simulate HAVE(1) arriving before stale BITFIELD([0x01])
        let reorderedInitialBitfield = false;
        aToC.swarmChannel.setBinaryOutgoingInterceptor((raw) => {
          const decoded = decodeSwarmFrame(raw);
          if (
            decoded.frameType === SwarmFrameType.BITFIELD &&
            !reorderedInitialBitfield
          ) {
            reorderedInitialBitfield = true;
            queueMicrotask(() => {
              // First send HAVE(chunk 1), then stale BITFIELD claiming only chunk 0!
              aToC.swarmChannel.sendBinary(
                encodeSwarmFrame({
                  frameType: SwarmFrameType.HAVE,
                  fileId: decoded.fileId,
                  chunkIndex: 1,
                  payload: new Uint8Array(0),
                }),
              );
              aToC.swarmChannel.sendBinary(
                encodeSwarmFrame({
                  frameType: SwarmFrameType.BITFIELD,
                  fileId: decoded.fileId,
                  chunkIndex: 0,
                  payload: new Uint8Array([0x80]), // MSB bit 0 = chunk 0 only!
                }),
              );
            });
            return null;
          }
          return raw;
        });

        const mergeManifest = await seederA.engine.shareFile({
          fileName: "or-merge.bin",
          fileSize: twoChunkBytes.byteLength,
          readChunk: makeSliceReader(twoChunkBytes),
        });
        await waitFor(() => receiverC.announcedFiles.length === 1);
        await receiverC.engine.downloadFile(mergeManifest.fileId);
        await waitFor(() => receiverC.completedFiles.length === 1);
        expect(receiverC.storage.getFinalizedBytes(mergeManifest.fileId)).toEqual(
          twoChunkBytes,
        );
        aToC.swarmChannel.setBinaryOutgoingInterceptor(undefined);

        // 7e. cancelDownload invoked while initReceivingFile is still awaiting cancels cleanly
        const raceBytes = makeDeterministicPayload(2 * SWARM_CHUNK_SIZE);
        const raceManifest = await seederA.engine.shareFile({
          fileName: "cancel-race.bin",
          fileSize: raceBytes.byteLength,
          readChunk: makeSliceReader(raceBytes),
        });
        await waitFor(() => receiverC.announcedFiles.length === 2);

        let releaseInit!: () => void;
        const origInit = receiverC.storage.initReceivingFile.bind(
          receiverC.storage,
        );
        receiverC.storage.initReceivingFile = async (m) => {
          await new Promise<void>((resolve) => {
            releaseInit = resolve;
          });
          return origInit(m);
        };

        const pendingDownload = receiverC.engine.downloadFile(
          raceManifest.fileId,
        );
        await waitFor(() => typeof releaseInit === "function");
        await receiverC.engine.cancelDownload(raceManifest.fileId);
        releaseInit();
        await pendingDownload;

        expect(
          receiverC.engine.getTransferProgress(raceManifest.fileId)?.status,
        ).toBe("paused");
        expect(receiverC.storage.deletedFileIds).toContain(raceManifest.fileId);
        receiverC.storage.initReceivingFile = origInit;

        // 7f + 7g. Timed-out source peer deprioritization + writeVerifiedChunk backpressure
        const sixChunkBytes = makeDeterministicPayload(6 * SWARM_CHUNK_SIZE);
        const timeoutManifest = await seederA.engine.shareFile({
          fileName: "timeout-and-backpressure.bin",
          fileSize: sixChunkBytes.byteLength,
          readChunk: makeSliceReader(sixChunkBytes),
        });
        await waitFor(
          () =>
            seederB.announcedFiles.length === 3 &&
            receiverC.announcedFiles.length === 3,
        );
        await seederB.engine.downloadFile(timeoutManifest.fileId);
        await waitFor(() => seederB.completedFiles.length === 1);

        // Make Seeder A silently drop all outgoing CHUNK frames so Receiver C times out on A and falls back to Seeder B!
        aToC.swarmChannel.setBinaryOutgoingInterceptor((raw) => {
          const decoded = decodeSwarmFrame(raw);
          if (decoded.frameType === SwarmFrameType.CHUNK) {
            return null;
          }
          return raw;
        });

        // Gate Receiver C's writeVerifiedChunk to verify maxInFlightPerPeer (2) caps concurrent storage writes!
        let activeWrites = 0;
        let peakConcurrentWrites = 0;
        const pendingWriteResolvers: Array<() => void> = [];
        const origWrite = receiverC.storage.writeVerifiedChunk.bind(
          receiverC.storage,
        );
        receiverC.storage.writeVerifiedChunk = async (
          fileId,
          chunkIndex,
          data,
        ) => {
          activeWrites += 1;
          if (activeWrites > peakConcurrentWrites) {
            peakConcurrentWrites = activeWrites;
          }
          await new Promise<void>((resolve) => {
            pendingWriteResolvers.push(resolve);
          });
          activeWrites -= 1;
          return origWrite(fileId, chunkIndex, data);
        };

        await receiverC.engine.downloadFile(timeoutManifest.fileId);
        // Wait until Seeder B delivers its maxInFlightPerPeer (2) chunks and stalls on write backpressure
        await waitFor(() => pendingWriteResolvers.length === 2, 3_000);
        await new Promise<void>((r) => setTimeout(r, 30));
        // Because Seeder A drops chunks and Seeder B has maxInFlightPerPeer=2 occupied by pendingStorageWrites,
        // peakConcurrentWrites on Seeder B stays bounded at 2!
        expect(peakConcurrentWrites).toBe(2);

        // Restore fast writes and drain queued resolvers so all 6 chunks finish via Seeder B!
        receiverC.storage.writeVerifiedChunk = origWrite;
        while (pendingWriteResolvers.length > 0) {
          pendingWriteResolvers.shift()!();
        }

        await waitFor(() => receiverC.completedFiles.length === 2, 5_000);
        expect(
          receiverC.storage.getFinalizedBytes(timeoutManifest.fileId),
        ).toEqual(sixChunkBytes);
      } finally {
        await Promise.all([
          seederA.engine.stop(),
          seederB.engine.stop(),
          receiverC.engine.stop(),
        ]);
      }
    }

    // 7h. > 512 chunks (515 chunks) paged FileManifest transfers file.hash_page_request / file.hash_page
    // and rejects tampered hash pages from a malicious peer
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const honestSeeder = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01honestseed",
        username: "alice",
      });
      const maliciousPeer = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02maliciousm",
        username: "mallory",
      });
      const receiver = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_03receiverbb",
        username: "bob",
        maxInFlightPerPeer: 32,
      });

      try {
        await Promise.all([
          honestSeeder.engine.start(),
          maliciousPeer.engine.start(),
          receiver.engine.start(),
        ]);
        await waitFor(
          () =>
            honestSeeder.engine.getVerifiedPeers().length === 2 &&
            maliciousPeer.engine.getVerifiedPeers().length === 2 &&
            receiver.engine.getVerifiedPeers().length === 2,
        );

        const totalChunks = SWARM_HASH_PAGE_CHUNKS + 3; // 515 chunks across 2 hash pages!
        const pagedPayload = makeDeterministicPayload(
          (totalChunks - 1) * SWARM_CHUNK_SIZE + 512,
        );

        const pagedManifest = await honestSeeder.engine.shareFile({
          fileName: "large-paged-archive.tar",
          fileSize: pagedPayload.byteLength,
          readChunk: makeSliceReader(pagedPayload),
        });
        expect(pagedManifest.totalChunks).toBe(515);
        expect(pagedManifest.chunkHashes).toHaveLength(0);
        expect(pagedManifest.hashPageHashes).toHaveLength(2);

        await waitFor(() => receiver.announcedFiles.length === 1);

        // Mallory injects 3 tampered file.hash_page frames -> gets evicted for hash_page_poisoning
        const malloryToReceiver = maliciousPeer.connections.find(
          (c) => c.remotePeerId === receiver.peerId,
        )!;
        for (let i = 0; i < 3; i++) {
          malloryToReceiver.controlChannel.sendText(
            JSON.stringify(
              sealPostAuthControlFrame(roomKeys.roomAppKey, roomKeys.roomId, {
                type: "file.hash_page",
                fileId: pagedManifest.fileId,
                pageIndex: 1,
                chunkHashes: [
                  "0".repeat(64),
                  "1".repeat(64),
                  "2".repeat(64),
                ],
              }),
            ),
          );
        }

        await waitFor(
          () => receiver.engine.getVerifiedPeers().length === 1,
          3_000,
        );
        expect(receiver.engine.getVerifiedPeers()[0]?.peerId).toBe(
          honestSeeder.peerId,
        );

        // Receiver fetches valid hash pages 0 & 1 and all 515 chunks from Honest Seeder!
        await receiver.engine.downloadFile(pagedManifest.fileId);
        await waitFor(() => receiver.completedFiles.length === 1, 8_000);
        expect(receiver.storage.getFinalizedBytes(pagedManifest.fileId)).toEqual(
          pagedPayload,
        );
      } finally {
        await Promise.all([
          honestSeeder.engine.stop(),
          maliciousPeer.engine.stop(),
          receiver.engine.stop(),
        ]);
      }
    }
  });

  test("8. Round-2 regression guards: configurable maxSignalPayloadBytes, overlapping/cancel-restart downloadFile storage ownership, and multi-peer hash-page retry rotation", async () => {
    const ca = createTestServerCA();
    const roomKeys = deriveRoomKeys("codex-round2-peer-core-suite", FAST_KDF);

    // 8a. Large (>28,000 char) SDP payloads succeed when maxSignalPayloadBytes is raised to 65_536
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const peerA = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01largeoffer",
        username: "alice",
        maxSignalPayloadBytes: 65_536,
      });
      const peerB = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02largeanswr",
        username: "bob",
        maxSignalPayloadBytes: 65_536,
      });

      // Inflate outgoing SDP offer & answer beyond the default 28,000-char / 40,000-ciphertext limit
      const origCreateA = peerA.engine.start.bind(peerA.engine);
      void origCreateA;
      const interceptWithHugeSdp = async () => {
        const { openSignalingPayload, sealSignalingPayload } = await import(
          "@simpleim/crypto"
        );
        const hugePadding = `\r\na=x-sdp-padding:${"Z".repeat(33_000)}`;
        const makeBloater =
          (fromId: string) =>
          (
            frame: Parameters<typeof peerA.signaling.send>[0],
            defaultSend: (f: Parameters<typeof peerA.signaling.send>[0]) => void,
          ) => {
            if (frame.type === "signal.relay") {
              const inner = openSignalingPayload(
                roomKeys.signalingKey,
                roomKeys.roomId,
                fromId,
                frame.toPeerId,
                frame.envelope,
                { maxFrameBytes: 65_536 },
              );
              if (inner.kind === "sdp-offer" || inner.kind === "sdp-answer") {
                const bloated = sealSignalingPayload(
                  roomKeys.signalingKey,
                  roomKeys.roomId,
                  fromId,
                  frame.toPeerId,
                  {
                    kind: inner.kind,
                    sdp: inner.sdp + hugePadding,
                  },
                );
                expect(bloated.ciphertext.length).toBeGreaterThan(44_000);
                defaultSend({ ...frame, envelope: bloated });
                return;
              }
            }
            defaultSend(frame);
          };

        const hub2 = new MockSignalingHub();
        const net2 = new MockPeerTransportNetwork();
        const defaultLimitPeerB = createTestPeerRig({
          ca,
          hub: hub2,
          network: net2,
          roomKeys,
          peerId: "peer_02defaultlim",
          username: "bob",
          // Default 32 KiB limit -> must drop the >44,000-char envelope
        });
        const highSenderA = createTestPeerRig({
          ca,
          hub: hub2,
          network: net2,
          roomKeys,
          peerId: "peer_01highsender",
          username: "alice",
          maxSignalPayloadBytes: 65_536,
          signalingOptions: {
            interceptOutgoing: makeBloater("peer_01highsender"),
          },
        });

        try {
          await Promise.all([
            highSenderA.engine.start(),
            defaultLimitPeerB.engine.start(),
          ]);
          await new Promise<void>((r) => setTimeout(r, 60));
          expect(defaultLimitPeerB.engine.getVerifiedPeers()).toHaveLength(0);
        } finally {
          await Promise.all([
            highSenderA.engine.stop(),
            defaultLimitPeerB.engine.stop(),
          ]);
        }

        // Now run with BOTH peers configured at maxSignalPayloadBytes: 65_536
        const hub3 = new MockSignalingHub();
        const net3 = new MockPeerTransportNetwork();
        const highA = createTestPeerRig({
          ca,
          hub: hub3,
          network: net3,
          roomKeys,
          peerId: "peer_01highpeer01",
          username: "alice",
          maxSignalPayloadBytes: 65_536,
          signalingOptions: {
            interceptOutgoing: makeBloater("peer_01highpeer01"),
          },
        });
        const highB = createTestPeerRig({
          ca,
          hub: hub3,
          network: net3,
          roomKeys,
          peerId: "peer_02highpeer02",
          username: "bob",
          maxSignalPayloadBytes: 65_536,
          signalingOptions: {
            interceptOutgoing: makeBloater("peer_02highpeer02"),
          },
        });
        try {
          await Promise.all([highA.engine.start(), highB.engine.start()]);
          await waitFor(
            () =>
              highA.engine.getVerifiedPeers().length === 1 &&
              highB.engine.getVerifiedPeers().length === 1,
          );
        } finally {
          await Promise.all([highA.engine.stop(), highB.engine.stop()]);
          await Promise.all([peerA.engine.stop(), peerB.engine.stop()]);
        }
      };
      await interceptWithHugeSdp();
    }

    // 8b. Overlapping downloadFile() calls AND cancelDownload -> immediate downloadFile restart preserve storage ownership
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const seeder = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01seederaaaa",
        username: "alice",
      });
      const receiver = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02receiverbb",
        username: "bob",
      });

      try {
        await Promise.all([seeder.engine.start(), receiver.engine.start()]);
        await waitFor(
          () =>
            seeder.engine.getVerifiedPeers().length === 1 &&
            receiver.engine.getVerifiedPeers().length === 1,
        );

        // Subcase 1: Concurrent duplicate downloadFile(id) while initReceivingFile is still pending
        const dupPayload = makeDeterministicPayload(3 * SWARM_CHUNK_SIZE + 128);
        const dupManifest = await seeder.engine.shareFile({
          fileName: "concurrent-dup.bin",
          fileSize: dupPayload.byteLength,
          readChunk: makeSliceReader(dupPayload),
        });
        await waitFor(() => receiver.announcedFiles.length === 1);

        let releaseDupInit!: () => void;
        let dupInitCalls = 0;
        const origInit = receiver.storage.initReceivingFile.bind(
          receiver.storage,
        );
        receiver.storage.initReceivingFile = async (m) => {
          dupInitCalls += 1;
          await new Promise<void>((r) => {
            releaseDupInit = r;
          });
          return origInit(m);
        };

        const pDup1 = receiver.engine.downloadFile(dupManifest.fileId);
        await waitFor(() => typeof releaseDupInit === "function");
        const pDup2 = receiver.engine.downloadFile(dupManifest.fileId);

        releaseDupInit();
        await Promise.all([pDup1, pDup2]);
        receiver.storage.initReceivingFile = origInit;

        await waitFor(() => receiver.completedFiles.length === 1);
        expect(dupInitCalls).toBe(1);
        expect(receiver.storage.deletedFileIds).not.toContain(
          dupManifest.fileId,
        );
        expect(receiver.storage.getFinalizedBytes(dupManifest.fileId)).toEqual(
          dupPayload,
        );

        // Subcase 2: downloadFile #1 -> cancelDownload -> immediate downloadFile #2 BEFORE #1's initReceivingFile resolves
        const restartPayload = makeDeterministicPayload(
          2 * SWARM_CHUNK_SIZE + 512,
        );
        const restartManifest = await seeder.engine.shareFile({
          fileName: "cancel-restart.bin",
          fileSize: restartPayload.byteLength,
          readChunk: makeSliceReader(restartPayload),
        });
        await waitFor(() => receiver.announcedFiles.length === 2);

        let releaseStaleInit!: () => void;
        let initCallIndex = 0;
        receiver.storage.initReceivingFile = async (m) => {
          initCallIndex += 1;
          if (initCallIndex === 1) {
            await new Promise<void>((r) => {
              releaseStaleInit = r;
            });
          }
          return origInit(m);
        };

        const staleAttempt = receiver.engine.downloadFile(
          restartManifest.fileId,
        );
        await waitFor(() => typeof releaseStaleInit === "function");
        await receiver.engine.cancelDownload(restartManifest.fileId);
        // Immediately restart BEFORE staleAttempt's initReceivingFile resolves!
        const freshAttempt = receiver.engine.downloadFile(
          restartManifest.fileId,
        );
        // Now let Attempt #1's delayed initReceivingFile resolve
        releaseStaleInit();
        await Promise.all([staleAttempt, freshAttempt]);
        receiver.storage.initReceivingFile = origInit;

        await waitFor(() => receiver.completedFiles.length === 2);
        expect(
          receiver.storage.getFinalizedBytes(restartManifest.fileId),
        ).toEqual(restartPayload);
      } finally {
        await Promise.all([seeder.engine.stop(), receiver.engine.stop()]);
      }
    }

    // 8c. Hash-page retry rotation walks past 2+ unresponsive peers to reach the 3rd honest seeder
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const unresponsive1 = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01silentpeer",
        username: "silent1",
      });
      const unresponsive2 = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02silentpeer",
        username: "silent2",
      });
      const honestSeeder3 = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_03honestseed",
        username: "alice",
      });
      const receiver4 = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_04receiverdd",
        username: "bob",
        maxInFlightPerPeer: 32,
        requestTimeoutMs: 30,
      });

      try {
        await Promise.all([
          unresponsive1.engine.start(),
          unresponsive2.engine.start(),
          honestSeeder3.engine.start(),
          receiver4.engine.start(),
        ]);
        await waitFor(
          () =>
            unresponsive1.engine.getVerifiedPeers().length === 3 &&
            unresponsive2.engine.getVerifiedPeers().length === 3 &&
            honestSeeder3.engine.getVerifiedPeers().length === 3 &&
            receiver4.engine.getVerifiedPeers().length === 3,
        );

        const totalChunks = SWARM_HASH_PAGE_CHUNKS + 4; // 516 chunks across 2 hash pages
        const pagedBytes = makeDeterministicPayload(
          (totalChunks - 1) * SWARM_CHUNK_SIZE + 256,
        );
        const pagedManifest = await honestSeeder3.engine.shareFile({
          fileName: "rotate-hash-pages.tar",
          fileSize: pagedBytes.byteLength,
          readChunk: makeSliceReader(pagedBytes),
        });
        await waitFor(() => receiver4.announcedFiles.length === 1);

        // Make BOTH unresponsive1 and unresponsive2 advertise full BITFIELDs to receiver4 so they
        // look like top-priority seeders, while never answering file.hash_page_request or CHUNK!
        const fullBf = new Uint8Array(Math.ceil(totalChunks / 8)).fill(0xff);
        // Clear trailing unused bits in final byte
        const rem = totalChunks % 8;
        if (rem !== 0) {
          fullBf[fullBf.length - 1] = (0xff << (8 - rem)) & 0xff;
        }
        for (const silentRig of [unresponsive1, unresponsive2]) {
          const connToR = silentRig.connections.find(
            (c) => c.remotePeerId === receiver4.peerId,
          )!;
          connToR.swarmChannel.sendBinary(
            encodeSwarmFrame({
              frameType: SwarmFrameType.BITFIELD,
              fileId: pagedManifest.fileId,
              chunkIndex: 0,
              payload: fullBf,
            }),
          );
        }
        await new Promise<void>((r) => setTimeout(r, 15));

        await receiver4.engine.downloadFile(pagedManifest.fileId);
        await waitFor(() => receiver4.completedFiles.length === 1, 8_000);
        expect(receiver4.storage.getFinalizedBytes(pagedManifest.fileId)).toEqual(
          pagedBytes,
        );
      } finally {
        await Promise.all([
          unresponsive1.engine.stop(),
          unresponsive2.engine.stop(),
          honestSeeder3.engine.stop(),
          receiver4.engine.stop(),
        ]);
      }
    }

    // 8d. Signaling server error frames preserve structured ErrorCode via SignalingServerError
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const observedErrors: Error[] = [];
      const rig = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_sig_err_01",
        username: "sigerr",
        extraEvents: {
          onError: (err) => observedErrors.push(err),
        },
      });

      try {
        await rig.engine.start();
        rig.signaling.deliverFromServer({
          type: "error",
          code: "room_full",
          message: "Room capacity reached",
          roomId: roomKeys.roomId,
        });
        await waitFor(() => observedErrors.length === 1);
        expect(observedErrors[0]).toBeInstanceOf(SignalingServerError);
        expect((observedErrors[0] as SignalingServerError).code).toBe("room_full");
      } finally {
        await rig.engine.stop();
      }
    }
  });

  test("9. Warm-start initialMessages & initialFiles restores monotonic Lamport, rejects tampered history, and syncs incrementally", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("warm-start-vault-passphrase", FAST_KDF);

    // Phase 1: Alice and Bob exchange chat + file manifest, then Alice snapshots her local history (simulating RoomVault)
    const alice1 = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01alice_old1",
      username: "alice",
    });
    const bob = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bob_online",
      username: "bob",
    });

    let savedMessages: ChatMessageEnvelope[] = [];
    let savedFiles: FileManifest[] = [];

    try {
      await Promise.all([alice1.engine.start(), bob.engine.start()]);
      await waitFor(
        () =>
          alice1.engine.getVerifiedPeers().length === 1 &&
          bob.engine.getVerifiedPeers().length === 1,
      );

      await alice1.engine.sendChatMessage("Warm message #1 from Alice");
      await bob.engine.sendChatMessage("Warm message #2 from Bob");
      const sampleBytes = makeDeterministicPayload(1024);
      await bob.engine.shareFile({
        fileName: "persisted-spec.txt",
        fileSize: sampleBytes.byteLength,
        readChunk: makeSliceReader(sampleBytes),
      });

      await waitFor(
        () =>
          alice1.engine.getMessages().length === 2 &&
          alice1.engine.getFiles().length === 1,
      );

      savedMessages = alice1.engine.getMessages();
      savedFiles = alice1.engine.getFiles();
      await alice1.engine.stop();

      // While Alice is offline/reloading, Bob sends message #3
      await bob.engine.sendChatMessage("Missed message #3 while Alice reloaded");

      // Inject one tampered message into Alice's snapshot -> must be silently rejected during warm-start
      const tamperedMsg: ChatMessageEnvelope = {
        ...savedMessages[0]!,
        msgId: "019a0000-0000-7000-8000-999999999999",
        body: "Tampered vault body",
      };

      const peerKeyPair2 = generateEd25519KeyPair();
      const cert2 = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: "usr_alice00000",
        username: "alice",
        displayName: "ALICE",
        peerId: "peer_03alice_new2",
        peerSignPubKey: peerKeyPair2.publicKeyBase64Url,
        clientKind: "web",
        nowMs: Date.now() - 5_000,
        ttlMs: 3_600_000,
      });

      const constructorEvents: ChatMessageEnvelope[] = [];
      const signaling2 = hub.createClient("peer_03alice_new2");
      const { factory: factory2 } = network.createFactory();
      const storage2 = new InMemoryChunkStorage();

      const alice2Engine = createRoomPeerEngine({
        localPeerId: "peer_03alice_new2",
        localCert: cert2,
        localSignKeyPair: peerKeyPair2,
        serverSignPubKey: ca.keyPair.publicKeyBase64Url,
        roomKeys,
        iceServers: [{ urls: ["stun:stun.example.org:3478"] }],
        signaling: signaling2,
        transportFactory: factory2,
        chunkStorage: storage2,
        initialMessages: [...savedMessages, tamperedMsg],
        initialFiles: savedFiles,
        events: {
          onChatMessage: (msg) => constructorEvents.push(msg),
        },
      });

      try {
        // Warm-started messages & files are immediately present with zero constructor event spam and tampered item dropped
        expect(constructorEvents.length).toBe(0);
        expect(alice2Engine.getMessages().map((m) => m.body)).toEqual([
          "Warm message #1 from Alice",
          "Warm message #2 from Bob",
        ]);
        expect(alice2Engine.getFiles().map((f) => f.fileName)).toEqual([
          "persisted-spec.txt",
        ]);

        // Reconnect Alice2 -> incremental sync fetches ONLY missed message #3, and Alice2's next Lamport stays monotonic
        await alice2Engine.start();
        await waitFor(() => alice2Engine.getMessages().length === 3);
        expect(constructorEvents.map((m) => m.body)).toEqual([
          "Missed message #3 while Alice reloaded",
        ]);

        const postReloadMsg = await alice2Engine.sendChatMessage(
          "Post-reload message #4 from Alice",
        );
        expect(postReloadMsg.lamport).toBeGreaterThan(3);
        await waitFor(() => bob.engine.getMessages().length === 4);
      } finally {
        await alice2Engine.stop();
      }
    } finally {
      await alice1.engine.stop();
      await bob.engine.stop();
    }
  });

  test("10. updateLocalCert propagates renewed PeerIdentityCert to ChatSyncManager and MeshSessionManager for >24h sessions", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("cert-renewal-room", FAST_KDF);

    let currentNow = 1_763_000_000_000;
    const aliceKeyPair = generateEd25519KeyPair();
    const initialAliceCert = issuePeerIdentityCert({
      serverKeyId: ca.serverKeyId,
      serverSignPrivKey: ca.keyPair.privateKeyBytes,
      userId: "usr_alice_renew",
      username: "alice",
      displayName: "Alice",
      peerId: "peer_01alice_renew",
      peerSignPubKey: aliceKeyPair.publicKeyBase64Url,
      clientKind: "web",
      nowMs: currentNow,
      ttlMs: 3_600_000, // 1 hour initial TTL
    });

    const aliceEngine = createRoomPeerEngine({
      localPeerId: "peer_01alice_renew",
      localCert: initialAliceCert,
      localSignKeyPair: aliceKeyPair,
      serverSignPubKey: ca.keyPair.publicKeyBase64Url,
      roomKeys,
      iceServers: [],
      signaling: hub.createClient("peer_01alice_renew"),
      transportFactory: network.createFactory().factory,
      chunkStorage: new InMemoryChunkStorage(),
      now: () => currentNow,
    });

    await aliceEngine.start();

    // Advance simulated clock past initial 1h TTL (2 hours later) and renew Alice's cert in-place
    currentNow += 2 * 3_600_000;
    const renewedAliceCert = issuePeerIdentityCert({
      serverKeyId: ca.serverKeyId,
      serverSignPrivKey: ca.keyPair.privateKeyBytes,
      userId: "usr_alice_renew",
      username: "alice",
      displayName: "Alice",
      peerId: "peer_01alice_renew",
      peerSignPubKey: aliceKeyPair.publicKeyBase64Url,
      clientKind: "web",
      nowMs: currentNow - 1_000,
      ttlMs: 86_400_000,
    });
    aliceEngine.updateLocalCert(renewedAliceCert);

    // Late-joining Bob verifies Alice via HELLO_AUTH at T+2h (would fail with cert_expired if old cert remained!)
    const bobKeyPair = generateEd25519KeyPair();
    const bobCert = issuePeerIdentityCert({
      serverKeyId: ca.serverKeyId,
      serverSignPrivKey: ca.keyPair.privateKeyBytes,
      userId: "usr_bob_renew",
      username: "bob",
      displayName: "Bob",
      peerId: "peer_02bob_renew",
      peerSignPubKey: bobKeyPair.publicKeyBase64Url,
      clientKind: "cli",
      nowMs: currentNow - 1_000,
      ttlMs: 86_400_000,
    });
    const bobEngine = createRoomPeerEngine({
      localPeerId: "peer_02bob_renew",
      localCert: bobCert,
      localSignKeyPair: bobKeyPair,
      serverSignPubKey: ca.keyPair.publicKeyBase64Url,
      roomKeys,
      iceServers: [],
      signaling: hub.createClient("peer_02bob_renew"),
      transportFactory: network.createFactory().factory,
      chunkStorage: new InMemoryChunkStorage(),
      now: () => currentNow,
    });

    try {
      await bobEngine.start();
      await waitFor(
        () =>
          aliceEngine.getVerifiedPeers().length === 1 &&
          bobEngine.getVerifiedPeers().length === 1,
      );

      const sentAt2h = await aliceEngine.sendChatMessage(
        "Signed with renewed 24h cert!",
      );
      expect(sentAt2h.authorCert.payload.exp).toBe(renewedAliceCert.payload.exp);
      await waitFor(() => bobEngine.getMessages().length === 1);
      expect(bobEngine.getMessages()[0]?.body).toBe(
        "Signed with renewed 24h cert!",
      );
    } finally {
      await aliceEngine.stop();
      await bobEngine.stop();
    }
  });

  test("11. ICE failure reporting & automatic P2P retry: surfaces onPeerTransportFailure when initial ICE fails and heals automatically to sync queued messages", async () => {
    const ca = createTestServerCA();
    const hub = new MockSignalingHub();
    const network = new MockPeerTransportNetwork();
    const roomKeys = deriveRoomKeys("ice-failure-auto-retry-room", FAST_KDF);

    let aliceAttempts = 0;
    const aliceTransportFailures: Array<{
      remotePeerId: string;
      reason: string;
    }> = [];
    const bobTransportFailures: Array<{
      remotePeerId: string;
      reason: string;
    }> = [];

    const alice = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_01alice_ice",
      username: "alice",
      transportConfig: () => {
        aliceAttempts += 1;
        return { failIceOnAcceptAnswer: aliceAttempts === 1 };
      },
      extraEvents: {
        onPeerTransportFailure: (remotePeerId, reason) => {
          aliceTransportFailures.push({ remotePeerId, reason });
        },
      },
    });

    const bob = createTestPeerRig({
      ca,
      hub,
      network,
      roomKeys,
      peerId: "peer_02bob_ice",
      username: "bob",
      extraEvents: {
        onPeerTransportFailure: (remotePeerId, reason) => {
          bobTransportFailures.push({ remotePeerId, reason });
        },
      },
    });

    try {
      await Promise.all([alice.engine.start(), bob.engine.start()]);

      // Attempt #1 fails ICE -> both peers observe signalingPeerCount === 1 and receive onPeerTransportFailure("...", "ice_failed")
      await waitFor(
        () =>
          aliceTransportFailures.length === 1 &&
          bobTransportFailures.length === 1,
      );
      expect(aliceTransportFailures[0]).toEqual({
        remotePeerId: "peer_02bob_ice",
        reason: "ice_failed",
      });
      expect(alice.engine.getSignalingPeerCount()).toBe(1);
      expect(alice.engine.getVerifiedPeers().length).toBe(0);

      // Alice sends a message while P2P is still down -> stored locally, ready for automatic catch-up sync
      await alice.engine.sendChatMessage(
        "Queued while TURN TCP 3478 was temporarily blocked!",
      );
      expect(bob.engine.getMessages().length).toBe(0);

      // Automatic mesh retry (~3s) establishes the WebRTC DataChannel, completes HELLO_AUTH, and syncs Alice's queued message!
      await waitFor(
        () =>
          alice.engine.getVerifiedPeers().length === 1 &&
          bob.engine.getVerifiedPeers().length === 1 &&
          bob.engine.getMessages().length === 1,
        5_500,
      );
      expect(bob.engine.getMessages()[0]?.body).toBe(
        "Queued while TURN TCP 3478 was temporarily blocked!",
      );
    } finally {
      await alice.engine.stop();
      await bob.engine.stop();
    }
  });

  test("12. Multi-party partial-mesh gossip, 64 KiB SCTP sync.batch byte budgeting, asymmetric responder offer replacement, and periodic anti-entropy sync", async () => {
    const ca = createTestServerCA();
    const roomKeys = deriveRoomKeys("partial-mesh-gossip-and-batch-budget", FAST_KDF);

    // 12a. Partial-mesh chain A <-> B <-> C <-> D (direct A<->C, A<->D, B<->D blocked by NAT)
    // + strict 64 KiB (65,536 B) SCTP maxMessageSize on every DataChannel!
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();

      const areNeighbors = (p1: string, p2: string): boolean => {
        const pair = [p1, p2].sort().join("|");
        return (
          pair === "peer_01aaaaaaaaaa|peer_02bbbbbbbbbb" ||
          pair === "peer_02bbbbbbbbbb|peer_03cccccccccc" ||
          pair === "peer_03cccccccccc|peer_04dddddddddd"
        );
      };

      const makePartialMeshRig = (peerId: string, username: string) =>
        createTestPeerRig({
          ca,
          hub,
          network,
          roomKeys,
          peerId,
          username,
          syncIntervalMs: 80,
          transportConfig: ({ localPeerId, remotePeerId }) => ({
            maxControlTextBytes: 65_536,
            failIceOnAcceptAnswer: !areNeighbors(localPeerId, remotePeerId),
          }),
        });

      const peerA = makePartialMeshRig("peer_01aaaaaaaaaa", "alice");
      const peerB = makePartialMeshRig("peer_02bbbbbbbbbb", "bob");
      const peerC = makePartialMeshRig("peer_03cccccccccc", "carol");

      try {
        await Promise.all([
          peerA.engine.start(),
          peerB.engine.start(),
          peerC.engine.start(),
        ]);

        // Wait for chain A <-> B <-> C (A has 1 peer: B; B has 2 peers: A, C; C has 1 peer: B)
        await waitFor(
          () =>
            peerA.engine.getVerifiedPeers().length === 1 &&
            peerB.engine.getVerifiedPeers().length === 2 &&
            peerC.engine.getVerifiedPeers().length === 1,
        );

        // Live messages from A reach C via B, and live messages from C reach A via B!
        await peerA.engine.sendChatMessage("hello-from-alice-over-hop");
        await peerC.engine.sendChatMessage("hello-from-carol-over-hop");

        await waitFor(
          () =>
            peerA.engine.getMessages().length === 2 &&
            peerB.engine.getMessages().length === 2 &&
            peerC.engine.getMessages().length === 2,
        );
        expect(peerC.receivedChat.find((x) => x.msg.body === "hello-from-alice-over-hop")?.isHistoricalSync).toBe(false);
        expect(peerA.receivedChat.find((x) => x.msg.body === "hello-from-carol-over-hop")?.isHistoricalSync).toBe(false);

        // File announcements also gossip across partial mesh A -> B -> C!
        const sharedBytes = makeDeterministicPayload(2 * SWARM_CHUNK_SIZE);
        const sharedManifest = await peerA.engine.shareFile({
          fileName: "relayed-across-hops.bin",
          fileSize: sharedBytes.byteLength,
          readChunk: makeSliceReader(sharedBytes),
        });
        await waitFor(() => peerC.announcedFiles.length === 1);
        expect(peerC.announcedFiles[0]?.fileId).toBe(sharedManifest.fileId);

        // Bulk 20 x 12 KiB AI-essay messages (~240 KiB > 64 KiB SCTP maxMessageSize!) sent by A
        // before late-joiner D connects ONLY to C (3 hops away from A: A <-> B <-> C <-> D)!
        for (let i = 0; i < 20; i++) {
          await peerA.engine.sendChatMessage(
            `essay-${i.toString().padStart(2, "0")}-${"文".repeat(4_000)}`,
          );
        }
        await waitFor(() => peerC.engine.getMessages().length === 22);

        const peerD = makePartialMeshRig("peer_04dddddddddd", "dave");
        try {
          // Seed an offline pre-existing message on D before D connects to C, so D's sync.batch
          // must also propagate backwards D -> C -> B -> A!
          await peerD.engine.sendChatMessage("dave-offline-note-before-join");
          await peerD.engine.start();

          await waitFor(
            () =>
              peerD.engine.getVerifiedPeers().length === 1 &&
              peerD.engine.getMessages().length === 23 &&
              peerA.engine.getMessages().length === 23 &&
              peerB.engine.getMessages().length === 23 &&
              peerC.engine.getMessages().length === 23 &&
              peerD.engine.getFiles().length === 1,
            3_000,
          );

          const canonicalIds = peerA.engine.getMessages().map((m) => m.msgId);
          expect(peerB.engine.getMessages().map((m) => m.msgId)).toEqual(canonicalIds);
          expect(peerC.engine.getMessages().map((m) => m.msgId)).toEqual(canonicalIds);
          expect(peerD.engine.getMessages().map((m) => m.msgId)).toEqual(canonicalIds);

          // Simulate a transient dropped live chat.message from D -> C and verify periodic anti-entropy (80ms) heals it!
          const dToC = peerD.connections.find(
            (c) => c.remotePeerId === peerC.peerId && c.state === "connected",
          )!;
          let droppedOnce = false;
          dToC.controlChannel.setTextOutgoingInterceptor((txt) => {
            if (!droppedOnce) {
              droppedOnce = true;
              return null; // Drop live chat.message frame!
            }
            return txt;
          });
          await peerD.engine.sendChatMessage("healed-by-periodic-anti-entropy");
          expect(droppedOnce).toBe(true);

          await waitFor(
            () =>
              peerA.engine
                .getMessages()
                .some((m) => m.body === "healed-by-periodic-anti-entropy"),
            2_000,
          );
        } finally {
          await peerD.engine.stop();
        }
      } finally {
        await Promise.all([
          peerA.engine.stop(),
          peerB.engine.stop(),
          peerC.engine.stop(),
        ]);
      }
    }

    // 12b. Asymmetric ICE failure where Initiator fails while Responder stays stuck in "connecting":
    // Responder must replace its stuck UNVERIFIED session on Initiator's fresh retry offer!
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      let initiatorAttempts = 0;

      const initiator = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01_asym_init",
        username: "init",
        transportConfig: () => {
          initiatorAttempts += 1;
          return {
            failInitiatorOnlyOnAcceptAnswer: initiatorAttempts === 1,
          };
        },
      });
      const responder = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02_asym_resp",
        username: "resp",
      });

      try {
        await Promise.all([initiator.engine.start(), responder.engine.start()]);
        await waitFor(
          () =>
            initiator.engine.getVerifiedPeers().length === 1 &&
            responder.engine.getVerifiedPeers().length === 1,
          5_500,
        );
        expect(initiatorAttempts).toBe(2);
      } finally {
        await Promise.all([initiator.engine.stop(), responder.engine.stop()]);
      }
    }
  });

  test("13. Hybrid P2P + Zero-Knowledge Blind Ephemeral Relay: 100% asynchronous offline chat + 4-chunk & 520-chunk paged file transfers, P2P-first priority, too_large state, and tampered relay chunk rejection", async () => {
    const ca = createTestServerCA();

    // 13a. 100% Asynchronous Offline Chat + 4-Chunk File Transfer (0 simultaneous P2P peers)
    // + P2P-first verification when a live seeder IS online!
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const relayHub = new MockBlindRelayHub();
      const roomKeys = deriveRoomKeys(
        "async-blind-relay-offline-catchup-room",
        FAST_KDF,
      );
      const inspectRelayKeys = deriveRelayKeys(roomKeys.roomAppKey);

      const aliceRelay = relayHub.createClient();
      const alice = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01alice_async",
        username: "alice",
        relayClient: aliceRelay,
        syncIntervalMs: 80,
      });

      const fileBytes = makeDeterministicPayload(3 * SWARM_CHUNK_SIZE + 17_777); // 4 chunks
      let sharedManifest!: FileManifest;
      let msg1!: ChatMessageEnvelope;
      let msg2!: ChatMessageEnvelope;

      try {
        await alice.engine.start();
        expect(alice.engine.getVerifiedPeers()).toHaveLength(0);

        msg1 = await alice.engine.sendChatMessage(
          "Offline note #1 left in encrypted blind box",
        );
        msg2 = await alice.engine.sendChatMessage(
          "Offline reply #2 while Bob is asleep",
          msg1.msgId,
        );

        sharedManifest = await alice.engine.shareFile({
          fileName: "async-design-spec.pdf",
          fileSize: fileBytes.byteLength,
          mimeType: "application/pdf",
          readChunk: makeSliceReader(fileBytes),
        });
        expect(sharedManifest.totalChunks).toBe(4);

        await waitFor(
          () =>
            alice.engine.getTransferProgress(sharedManifest.fileId)
              ?.relayCacheState === "cached" &&
            relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId) === 3,
        );

        const aliceCachedProgress = alice.engine.getTransferProgress(
          sharedManifest.fileId,
        );
        expect(aliceCachedProgress?.relayCacheState).toBe("cached");
        expect(aliceCachedProgress?.relayCachedChunks).toBe(4);
        expect(aliceCachedProgress?.relayExpiresAt).toBeDefined();
        expect(
          relayHub.getStoredChunkCount(inspectRelayKeys.relayBoxId),
        ).toBe(4);
      } finally {
        // Alice goes completely offline; signaling room is now 100% empty!
        await alice.engine.stop();
      }

      // Inject a garbage/corrupted ciphertext envelope on the blind relay to verify Bob ignores it cleanly
      relayHub.injectCorruptedEnvelope(
        inspectRelayKeys.relayBoxId,
        "0123456789abcdef0123456789abcdef",
        new Uint8Array(96).fill(0xaa),
      );

      const bobRelay = relayHub.createClient();
      const bob = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02bob_async",
        username: "bob",
        clientKind: "cli",
        relayClient: bobRelay,
        syncIntervalMs: 80,
      });

      try {
        await bob.engine.start();
        expect(bob.engine.getSignalingPeerCount()).toBe(0);
        expect(bob.engine.getVerifiedPeers()).toHaveLength(0);

        // Bob automatically pulls both signed chat messages and the FileManifest from the blind relay!
        await waitFor(
          () =>
            bob.engine.getMessages().length === 2 &&
            bob.engine.getFiles().length === 1,
        );

        const bobMsgs = bob.engine.getMessages();
        expect(bobMsgs.map((m) => m.msgId)).toEqual([msg1.msgId, msg2.msgId]);
        expect(bobMsgs[0]?.body).toBe(
          "Offline note #1 left in encrypted blind box",
        );
        expect(bobMsgs[1]?.replyToMsgId).toBe(msg1.msgId);
        expect(bob.receivedChat.every((c) => c.isHistoricalSync)).toBe(true);

        const bobAnnouncedProgress = bob.engine.getTransferProgress(
          sharedManifest.fileId,
        );
        expect(bobAnnouncedProgress?.relayCacheState).toBe("cached");
        expect(bobAnnouncedProgress?.relayCachedChunks).toBe(4);
        expect(bobAnnouncedProgress?.relayExpiresAt).toBeDefined();

        // Bob downloads all 4 chunks from the blind relay with 0 P2P peers online!
        await bob.engine.downloadFile(sharedManifest.fileId);
        await waitFor(
          () =>
            bob.completedFiles.length === 1 &&
            bob.engine.getTransferProgress(sharedManifest.fileId)?.status ===
              "seeding",
        );

        expect(bobRelay.getChunkCalls).toBe(4);
        expect(bob.storage.getFinalizedBytes(sharedManifest.fileId)).toEqual(
          fileBytes,
        );

        // Now Carol joins while Bob IS online and seeding -> P2P-First rule must fetch from Bob with 0 relay chunk fetches!
        const carolRelay = relayHub.createClient();
        const carol = createTestPeerRig({
          ca,
          hub,
          network,
          roomKeys,
          peerId: "peer_03carol_p2p",
          username: "carol",
          relayClient: carolRelay,
          syncIntervalMs: 80,
        });
        try {
          await carol.engine.start();
          await waitFor(
            () =>
              carol.engine.getVerifiedPeers().length === 1 &&
              carol.engine.getFiles().length === 1 &&
              (carol.engine.getTransferProgress(sharedManifest.fileId)
                ?.availableSeeders ?? 0) === 1,
          );
          await carol.engine.downloadFile(sharedManifest.fileId);
          await waitFor(() => carol.completedFiles.length === 1);
          expect(carolRelay.getChunkCalls).toBe(0);
          expect(
            carol.storage.getFinalizedBytes(sharedManifest.fileId),
          ).toEqual(fileBytes);
        } finally {
          await carol.engine.stop();
        }
      } finally {
        await bob.engine.stop();
      }

      // Verify local-authored initialMessages composed while offline are pushed to blind relay on start()
      // (while foreign-authored initialMessages are NOT redundantly re-uploaded by non-authors!)
      const daveKeyPair = generateEd25519KeyPair();
      const daveCert = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: "usr_dave000000",
        username: "dave",
        displayName: "DAVE",
        peerId: "peer_04dave_init",
        peerSignPubKey: daveKeyPair.publicKeyBase64Url,
        clientKind: "cli",
      });
      const daveOfflineMsg = signChatMessage({
        roomId: roomKeys.roomId,
        lamport: 5,
        body: "Composed offline by Dave before reconnecting",
        authorCert: daveCert,
        peerSignPrivKey: daveKeyPair.privateKeyBytes,
      });
      const envCountBeforeDave = relayHub.getStoredEnvelopeCount(
        inspectRelayKeys.relayBoxId,
      );
      const daveEngine = createRoomPeerEngine({
        localPeerId: "peer_04dave_init",
        localCert: daveCert,
        localSignKeyPair: daveKeyPair,
        serverSignPubKey: ca.keyPair.publicKeyBase64Url,
        roomKeys,
        iceServers: [],
        signaling: hub.createClient("peer_04dave_init"),
        transportFactory: network.createFactory().factory,
        chunkStorage: new InMemoryChunkStorage(),
        relayClient: relayHub.createClient(),
        initialMessages: [msg1, daveOfflineMsg],
      });
      try {
        await daveEngine.start();
        await waitFor(
          () =>
            relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId) ===
            envCountBeforeDave + 1,
        );
      } finally {
        await daveEngine.stop();
      }
    }

    // 13b. Paged >512-chunk file (520 chunks) offline relay + >maxFileBytes ("too_large") state
    // + tampered relay chunk AEAD & SHA-256 poisoning rejection!
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const pagedSizeBytes = 519 * SWARM_CHUNK_SIZE + 4_321; // 520 chunks (2 hash pages)
      const maxRelayFileBytes = 530 * SWARM_CHUNK_SIZE;
      const relayHub = new MockBlindRelayHub({
        maxFileBytes: maxRelayFileBytes,
      });
      const roomKeys = deriveRoomKeys(
        "paged-relay-and-tamper-rejection-room",
        FAST_KDF,
      );
      const inspectRelayKeys = deriveRelayKeys(roomKeys.roomAppKey);

      const alice = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01alice_paged",
        username: "alice",
        relayClient: relayHub.createClient(),
      });

      const pagedBytes = makeDeterministicPayload(pagedSizeBytes);
      const oversizedBytes = makeDeterministicPayload(
        maxRelayFileBytes + SWARM_CHUNK_SIZE,
      );
      const poisonTestBytes = makeDeterministicPayload(
        2 * SWARM_CHUNK_SIZE + 999,
      ); // 3 chunks

      let pagedManifest!: FileManifest;
      let oversizedManifest!: FileManifest;
      let poisonManifest!: FileManifest;

      try {
        await alice.engine.start();

        // 1) > maxFileBytes immediately enters relayCacheState === "too_large" without uploading chunks
        oversizedManifest = await alice.engine.shareFile({
          fileName: "huge-archive.tar",
          fileSize: oversizedBytes.byteLength,
          readChunk: makeSliceReader(oversizedBytes),
        });
        expect(
          alice.engine.getTransferProgress(oversizedManifest.fileId)
            ?.relayCacheState,
        ).toBe("too_large");
        expect(
          relayHub.getStoredChunkCount(inspectRelayKeys.relayBoxId),
        ).toBe(0);

        // 2) 520-chunk paged file uploads all 520 chunks + 2 hash pages + manifest atomically last
        pagedManifest = await alice.engine.shareFile({
          fileName: "paged-dataset-520.bin",
          fileSize: pagedBytes.byteLength,
          readChunk: makeSliceReader(pagedBytes),
        });
        expect(pagedManifest.totalChunks).toBe(520);
        expect(pagedManifest.hashPageHashes).toHaveLength(2);

        // 3) 3-chunk file that will have chunk #1 poisoned on the relay server after Alice disconnects
        poisonManifest = await alice.engine.shareFile({
          fileName: "tamper-target.bin",
          fileSize: poisonTestBytes.byteLength,
          readChunk: makeSliceReader(poisonTestBytes),
        });
        expect(poisonManifest.totalChunks).toBe(3);

        await waitFor(
          () =>
            alice.engine.getTransferProgress(pagedManifest.fileId)
              ?.relayCacheState === "cached" &&
            alice.engine.getTransferProgress(poisonManifest.fileId)
              ?.relayCacheState === "cached",
          5_000,
        );
        expect(
          alice.engine.getTransferProgress(pagedManifest.fileId)
            ?.relayCachedChunks,
        ).toBe(520);
      } finally {
        await alice.engine.stop();
      }

      // Corrupt chunk #1 ciphertext of poisonManifest on the relay server (AEAD bit-flip tamper)
      const poisonFileTag = deriveRelayFileTag(
        inspectRelayKeys.relayIdKey,
        poisonManifest.fileId,
      );
      const poisonChunk1BlobId = deriveRelayChunkBlobId(
        inspectRelayKeys.relayIdKey,
        poisonManifest.fileId,
        1,
      );
      relayHub.tamperChunkBytes(
        inspectRelayKeys.relayBoxId,
        poisonFileTag,
        poisonChunk1BlobId,
        (bytes) => {
          const copy = bytes.slice();
          const lastIdx = copy.byteLength - 1;
          copy[lastIdx] = (copy[lastIdx] ?? 0) ^ 0xff;
          return copy;
        },
      );

      const bob = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02bob_paged",
        username: "bob",
        relayClient: relayHub.createClient(),
      });

      try {
        await bob.engine.start();
        await waitFor(() => bob.engine.getFiles().length === 2);

        // Bob downloads the 520-chunk paged file completely offline via blind relay!
        await bob.engine.downloadFile(pagedManifest.fileId);
        await waitFor(
          () =>
            bob.completedFiles.some((f) => f.fileId === pagedManifest.fileId),
          5_000,
        );
        expect(bob.storage.getFinalizedBytes(pagedManifest.fileId)).toEqual(
          pagedBytes,
        );

        // Attempt #1 on poisonManifest: AEAD authentication rejects tampered chunk #1; never written to storage!
        await bob.engine.downloadFile(poisonManifest.fileId);
        await waitFor(
          () =>
            bob.engine.getTransferProgress(poisonManifest.fileId)?.status ===
            "error",
        );
        expect(
          bob.engine.getTransferProgress(poisonManifest.fileId)?.errorMessage,
        ).toBe("Offline relay cache unavailable or expired; peer seeder required");
        expect(bob.storage.hasReceivedChunk(poisonManifest.fileId, 1)).toBe(
          false,
        );
        expect(
          bob.storage.getFinalizedBytes(poisonManifest.fileId),
        ).toBeUndefined();

        // Attempt #2 on poisonManifest: replace chunk #1 with valid AEAD ciphertext sealing WRONG plaintext
        // (simulating an insider with relayKey trying to poison chunk bytes against Alice's Ed25519 manifest!)
        const wrongPlaintext = new Uint8Array(SWARM_CHUNK_SIZE).fill(0x42);
        const validAeadWrongPlaintext = sealRelayChunkBinary(
          inspectRelayKeys.relayKey,
          inspectRelayKeys.relayBoxId,
          poisonFileTag,
          poisonChunk1BlobId,
          wrongPlaintext,
        );
        relayHub.overwriteRawChunk(
          inspectRelayKeys.relayBoxId,
          poisonFileTag,
          poisonChunk1BlobId,
          validAeadWrongPlaintext,
        );

        await bob.engine.downloadFile(poisonManifest.fileId);
        await waitFor(
          () =>
            bob.engine.getTransferProgress(poisonManifest.fileId)?.status ===
            "error",
        );
        expect(bob.storage.hasReceivedChunk(poisonManifest.fileId, 1)).toBe(
          false,
        );
        expect(
          bob.storage.getFinalizedBytes(poisonManifest.fileId),
        ).toBeUndefined();
      } finally {
        await bob.engine.stop();
      }
    }
  });

  test("14. Issue #29 Relay Reliability: persistent outbox exponential backoff & status transitions, keepalive flush, and atomic onRelayBatchPulled + cursorReset", async () => {
    const ca = createTestServerCA();

    // 14a. Persistent Outbox + Delivery Status transitions (>5 failures, manual retryChatMessage,
    // WebSocket reconnect immediate flush, 24h max-age cutoff, initialPendingRelayMsgIds, p2p_only, and fast retryTimer)
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const relayHub = new MockBlindRelayHub();
      const roomKeys = deriveRoomKeys(
        "issue29-persistent-outbox-and-backoff",
        FAST_KDF,
      );
      const inspectRelayKeys = deriveRelayKeys(roomKeys.roomAppKey);

      let fakeNow = 1_765_000_000_000;
      const aliceRelay = relayHub.createClient();
      aliceRelay.failNextEnvelopePuts(6);

      const alice = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01alice_outbox",
        username: "alice",
        relayClient: aliceRelay,
        syncIntervalMs: 25,
        certNowMs: fakeNow - 5_000,
        certTtlMs: 48 * 3_600_000,
        now: () => fakeNow,
      });

      let msg1!: ChatMessageEnvelope;
      let msg2!: ChatMessageEnvelope;
      let msgAged!: ChatMessageEnvelope;

      try {
        await alice.engine.start();

        // Send msg1 while relay fails 6 consecutive times (exceeding old 5-attempt cap!)
        msg1 = await alice.engine.sendChatMessage(
          "Must survive 6 transient failures without being dropped",
        );
        expect(alice.engine.getChatDeliveryStates().get(msg1.msgId)).toBe(
          "pending",
        );

        // Attempt 1 fails immediately (backoff = 1s), status stays "pending"
        await waitFor(() => aliceRelay.putEnvelopeCalls === 1);
        expect(alice.engine.getChatDeliveryStates().get(msg1.msgId)).toBe(
          "pending",
        );

        // Attempt 2 fails after 1s (backoff = 2s), status stays "pending"
        fakeNow += 1_000;
        await waitFor(() => aliceRelay.putEnvelopeCalls === 2);
        expect(alice.engine.getChatDeliveryStates().get(msg1.msgId)).toBe(
          "pending",
        );

        // Attempt 3 fails after 2s (backoff = 4s) -> surfaces "failed"
        fakeNow += 2_000;
        await waitFor(
          () =>
            aliceRelay.putEnvelopeCalls === 3 &&
            alice.engine.getChatDeliveryStates().get(msg1.msgId) === "failed",
        );

        // Attempts 4, 5, 6 continue with exponential backoff (4s, 8s, 16s) without dropping!
        fakeNow += 4_000;
        await waitFor(() => aliceRelay.putEnvelopeCalls === 4);
        fakeNow += 8_000;
        await waitFor(() => aliceRelay.putEnvelopeCalls === 5);
        fakeNow += 16_000;
        await waitFor(() => aliceRelay.putEnvelopeCalls === 6);

        expect(alice.engine.getChatDeliveryStates().get(msg1.msgId)).toBe(
          "failed",
        );
        expect(
          alice.deliveryChanges
            .filter((e) => e.msgId === msg1.msgId)
            .map((e) => e.status),
        ).toEqual(["pending", "failed"]);
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(0);

        // Manual retryChatMessage(msgId) succeeds immediately (even though nextRetryAt is +32s away!)
        await alice.engine.retryChatMessage(msg1.msgId);
        expect(alice.engine.getChatDeliveryStates().get(msg1.msgId)).toBe(
          "relayed",
        );
        expect(aliceRelay.putEnvelopeCalls).toBe(7);
        expect(
          alice.deliveryChanges
            .filter((e) => e.msgId === msg1.msgId)
            .map((e) => e.status),
        ).toEqual(["pending", "failed", "pending", "relayed"]);
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(1);

        // Verify WebSocket reconnect immediately resets backoff and flushes failed outbox entries!
        aliceRelay.failNextEnvelopePuts(3);
        msg2 = await alice.engine.sendChatMessage(
          "Healed immediately on WebSocket reconnect",
        );
        await waitFor(() => aliceRelay.putEnvelopeCalls === 8);
        fakeNow += 1_000;
        await waitFor(() => aliceRelay.putEnvelopeCalls === 9);
        fakeNow += 2_000;
        await waitFor(
          () =>
            aliceRelay.putEnvelopeCalls === 10 &&
            alice.engine.getChatDeliveryStates().get(msg2.msgId) === "failed",
        );

        // Do NOT advance fakeNow — nextRetryAt is still +4s in the future!
        hub.shutdownCenterServer();
        hub.restartCenterServer();
        await alice.signaling.connect();

        await waitFor(
          () =>
            alice.engine.getChatDeliveryStates().get(msg2.msgId) === "relayed",
        );
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(2);

        // Verify >24h max-age stops automatic retries and marks "failed", while explicit retryChatMessage still works
        const callsBeforeAge = aliceRelay.putEnvelopeCalls;
        aliceRelay.failNextEnvelopePuts(1);
        msgAged = await alice.engine.sendChatMessage(
          "Aged past 24h automatic retry window",
        );
        await waitFor(() => aliceRelay.putEnvelopeCalls === callsBeforeAge + 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(alice.engine.getChatDeliveryStates().get(msgAged.msgId)).toBe(
          "pending",
        );

        const callsAfterFirstFail = aliceRelay.putEnvelopeCalls;
        fakeNow += 25 * 60 * 60 * 1000;
        await waitFor(
          () =>
            alice.engine.getChatDeliveryStates().get(msgAged.msgId) ===
            "failed",
        );
        // Auto-flush marked it failed due to age without issuing another putEnvelope call
        expect(aliceRelay.putEnvelopeCalls).toBe(callsAfterFirstFail);

        // Explicit user retryChatMessage still re-enqueues and delivers it!
        await alice.engine.retryChatMessage(msgAged.msgId);
        expect(alice.engine.getChatDeliveryStates().get(msgAged.msgId)).toBe(
          "relayed",
        );
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(3);
      } finally {
        await alice.engine.stop();
      }

      // Verify initialPendingRelayMsgIds retries ONLY unconfirmed messages and marks others "relayed"
      const alice2KeyPair = generateEd25519KeyPair();
      const alice2Cert = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: msg1.authorCert.payload.userId,
        username: "alice",
        displayName: "ALICE",
        peerId: "peer_02alice_reload",
        peerSignPubKey: alice2KeyPair.publicKeyBase64Url,
        clientKind: "web",
        nowMs: Date.now() - 5_000,
        ttlMs: 3_600_000,
      });
      const unsentMsg = signChatMessage({
        roomId: roomKeys.roomId,
        lamport: 10,
        body: "Unsent local message recovered from persistent outbox",
        authorCert: alice2Cert,
        peerSignPrivKey: alice2KeyPair.privateKeyBytes,
      });

      const alice2Relay = relayHub.createClient();
      const alice2DeliveryChanges: Array<{
        msgId: string;
        status: ChatDeliveryStatus;
      }> = [];
      const alice2Engine = createRoomPeerEngine({
        localPeerId: "peer_02alice_reload",
        localCert: alice2Cert,
        localSignKeyPair: alice2KeyPair,
        serverSignPubKey: ca.keyPair.publicKeyBase64Url,
        roomKeys,
        iceServers: [],
        signaling: hub.createClient("peer_02alice_reload"),
        transportFactory: network.createFactory().factory,
        chunkStorage: new InMemoryChunkStorage(),
        relayClient: alice2Relay,
        initialMessages: [msg1, msg2, msgAged, unsentMsg],
        initialPendingRelayMsgIds: [unsentMsg.msgId],
        syncIntervalMs: 0,
        events: {
          onChatDeliveryChange: (msgId, status) => {
            alice2DeliveryChanges.push({ msgId, status });
          },
        },
      });

      try {
        const preStartStates = alice2Engine.getChatDeliveryStates();
        expect(preStartStates.get(msg1.msgId)).toBe("relayed");
        expect(preStartStates.get(msg2.msgId)).toBe("relayed");
        expect(preStartStates.get(msgAged.msgId)).toBe("relayed");
        expect(preStartStates.get(unsentMsg.msgId)).toBe("pending");

        await alice2Engine.start();
        await waitFor(
          () =>
            alice2Engine.getChatDeliveryStates().get(unsentMsg.msgId) ===
            "relayed",
        );
        expect(alice2Relay.putEnvelopeCalls).toBe(1);
        expect(alice2DeliveryChanges).toEqual([
          { msgId: unsentMsg.msgId, status: "relayed" },
        ]);
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(4);
      } finally {
        await alice2Engine.stop();
      }

      // Verify p2p_only status when relay is unavailable/disabled
      const p2pOnlyRig = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_03p2ponly_01",
        username: "dave",
        syncIntervalMs: 0,
      });
      try {
        await p2pOnlyRig.engine.start();
        const p2pMsg = await p2pOnlyRig.engine.sendChatMessage("P2P only note");
        expect(p2pOnlyRig.engine.getChatDeliveryStates().get(p2pMsg.msgId)).toBe(
          "p2p_only",
        );
        expect(p2pOnlyRig.deliveryChanges).toEqual([
          { msgId: p2pMsg.msgId, status: "p2p_only" },
        ]);
      } finally {
        await p2pOnlyRig.engine.stop();
      }

      // Verify scheduled retryTimer retries in ~1s even when anti-entropy syncIntervalMs is 60s
      const fastRetryRelay = relayHub.createClient();
      fastRetryRelay.failNextEnvelopePuts(1);
      const fastRetryRig = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_04fastretry1",
        username: "erin",
        relayClient: fastRetryRelay,
        syncIntervalMs: 60_000,
      });
      try {
        await fastRetryRig.engine.start();
        const fastMsg = await fastRetryRig.engine.sendChatMessage(
          "Retried via 1s backoff timer before 60s anti-entropy",
        );
        await waitFor(() => fastRetryRelay.putEnvelopeCalls === 1);
        expect(
          fastRetryRig.engine.getChatDeliveryStates().get(fastMsg.msgId),
        ).toBe("pending");
        await waitFor(
          () =>
            fastRetryRig.engine.getChatDeliveryStates().get(fastMsg.msgId) ===
            "relayed",
          2_500,
        );
        expect(fastRetryRelay.putEnvelopeCalls).toBe(2);
      } finally {
        await fastRetryRig.engine.stop();
      }
    }

    // 14b. flushPendingRelayKeepalive() synchronously dispatches keepalive PUT before stop()
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const relayHub = new MockBlindRelayHub();
      const roomKeys = deriveRoomKeys(
        "issue29-keepalive-pagehide-flush",
        FAST_KDF,
      );
      const inspectRelayKeys = deriveRelayKeys(roomKeys.roomAppKey);

      const aliceRelay = relayHub.createClient();
      aliceRelay.failNextEnvelopePuts(1);

      const alice = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01alice_keep",
        username: "alice",
        relayClient: aliceRelay,
        syncIntervalMs: 60_000,
      });

      let keepaliveMsg!: ChatMessageEnvelope;
      try {
        await alice.engine.start();
        keepaliveMsg = await alice.engine.sendChatMessage(
          "Last-second message flushed on pagehide via keepalive",
        );
        await waitFor(() => aliceRelay.putEnvelopeCalls === 1);
        expect(
          relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId),
        ).toBe(0);
        expect(aliceRelay.keepalivePutCount).toBe(0);

        // Must execute synchronously BEFORE stop() wipes relayKeys!
        alice.engine.flushPendingRelayKeepalive();
        expect(aliceRelay.keepalivePutCount).toBe(1);
      } finally {
        await alice.engine.stop();
      }

      // Calling flushPendingRelayKeepalive after stop() is a safe no-op
      alice.engine.flushPendingRelayKeepalive();
      expect(aliceRelay.keepalivePutCount).toBe(1);

      await waitFor(
        () => relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId) === 1,
      );

      // Late-joining Bob pulls and decrypts the keepalive-uploaded message cleanly
      const bob = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02bob_keep01",
        username: "bob",
        relayClient: relayHub.createClient(),
        syncIntervalMs: 0,
      });
      try {
        await bob.engine.start();
        await waitFor(() => bob.engine.getMessages().length === 1);
        expect(bob.engine.getMessages()[0]?.msgId).toBe(keepaliveMsg.msgId);
        expect(bob.engine.getMessages()[0]?.body).toBe(
          "Last-second message flushed on pagehide via keepalive",
        );
      } finally {
        await bob.engine.stop();
      }
    }

    // 14c. Atomic onRelayBatchPulled + relayCursor binding and cursorReset: true recovery
    {
      const hub = new MockSignalingHub();
      const network = new MockPeerTransportNetwork();
      const relayHub = new MockBlindRelayHub();
      const roomKeys = deriveRoomKeys(
        "issue29-atomic-batch-and-cursor-reset",
        FAST_KDF,
      );
      const inspectRelayKeys = deriveRelayKeys(roomKeys.roomAppKey);

      const alice = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_01alice_atom",
        username: "alice",
        relayClient: relayHub.createClient(),
        syncIntervalMs: 0,
      });

      const fileBytes = makeDeterministicPayload(SWARM_CHUNK_SIZE + 512);
      let msgA!: ChatMessageEnvelope;
      let msgB!: ChatMessageEnvelope;
      let fileA!: FileManifest;

      try {
        await alice.engine.start();
        msgA = await alice.engine.sendChatMessage("Atomic batch message #1");
        msgB = await alice.engine.sendChatMessage("Atomic batch message #2");
        fileA = await alice.engine.shareFile({
          fileName: "atomic-spec.bin",
          fileSize: fileBytes.byteLength,
          readChunk: makeSliceReader(fileBytes),
        });
        await waitFor(
          () =>
            alice.engine.getTransferProgress(fileA.fileId)?.relayCacheState ===
              "cached" &&
            relayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId) === 3,
        );
      } finally {
        await alice.engine.stop();
      }

      let failFirstBatch = true;
      let batchCallbackAttempts = 0;
      const recordedBatches: Array<{
        msgIds: string[];
        fileIds: string[];
        nextCursor: number;
        cursorReset: boolean;
      }> = [];

      const bobRelay = relayHub.createClient();
      const bob = createTestPeerRig({
        ca,
        hub,
        network,
        roomKeys,
        peerId: "peer_02bob_atomic",
        username: "bob",
        relayClient: bobRelay,
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: async (batch) => {
            batchCallbackAttempts += 1;
            recordedBatches.push({
              msgIds: batch.messages.map((m) => m.msgId),
              fileIds: batch.files.map((f) => f.fileId),
              nextCursor: batch.nextCursor,
              cursorReset: batch.cursorReset,
            });
            if (failFirstBatch) {
              failFirstBatch = false;
              throw new Error("Simulated IndexedDB transaction failure");
            }
          },
        },
      });

      try {
        await bob.engine.start();
        await waitFor(() => batchCallbackAttempts === 1);
        // Allow outer pull catch/finally to settle
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        // Failed persistence MUST NOT commit messages/files or advance relayCursor!
        expect(bob.engine.getMessages()).toHaveLength(0);
        expect(bob.engine.getFiles()).toHaveLength(0);
        expect(bob.receivedChat).toHaveLength(0);
        expect(bob.announcedFiles).toHaveLength(0);
        expect(bobRelay.recordedListAfterSeqs).toEqual([0]);

        // Reconnect triggers Pull #2 -> succeeds, commits exact batch, and advances cursor to 3!
        hub.shutdownCenterServer();
        hub.restartCenterServer();
        await bob.signaling.connect();

        await waitFor(
          () =>
            bob.engine.getMessages().length === 2 &&
            bob.engine.getFiles().length === 1,
        );
        expect(bobRelay.recordedListAfterSeqs).toEqual([0, 0]);
        expect(recordedBatches[1]).toEqual({
          msgIds: [msgA.msgId, msgB.msgId],
          fileIds: [fileA.fileId],
          nextCursor: 3,
          cursorReset: false,
        });
        expect(bob.engine.getMessages().map((m) => m.msgId)).toEqual([
          msgA.msgId,
          msgB.msgId,
        ]);
        expect(bob.engine.getFiles().map((f) => f.fileId)).toEqual([
          fileA.fileId,
        ]);

        // Pull #3 uses the advanced cursor (3)!
        hub.shutdownCenterServer();
        hub.restartCenterServer();
        await bob.signaling.connect();
        await waitFor(() => bobRelay.listEnvelopeCalls === 3);
        expect(bobRelay.recordedListAfterSeqs).toEqual([0, 0, 3]);
      } finally {
        await bob.engine.stop();
      }

      // cursorReset: true recovery when initialRelayCursor (50) is ahead of a reset server (highestSeq = 2)
      const resetAliceHub = new MockSignalingHub();
      const resetCarolHub = new MockSignalingHub();
      const resetNet = new MockPeerTransportNetwork();
      const resetRelayHub = new MockBlindRelayHub();

      const aliceReset = createTestPeerRig({
        ca,
        hub: resetAliceHub,
        network: resetNet,
        roomKeys,
        peerId: "peer_01alice_rst1",
        username: "alice",
        relayClient: resetRelayHub.createClient(),
        syncIntervalMs: 0,
      });

      let resetMsg1!: ChatMessageEnvelope;
      let resetMsg2!: ChatMessageEnvelope;
      let resetMsg3!: ChatMessageEnvelope;

      await aliceReset.engine.start();
      resetMsg1 = await aliceReset.engine.sendChatMessage(
        "Post-restart message #1",
      );
      resetMsg2 = await aliceReset.engine.sendChatMessage(
        "Post-restart message #2",
      );
      await waitFor(
        () =>
          resetRelayHub.getStoredEnvelopeCount(inspectRelayKeys.relayBoxId) ===
          2,
      );

      const carolRelay = resetRelayHub.createClient();
      const carolBatches: Array<{
        msgIds: string[];
        nextCursor: number;
        cursorReset: boolean;
      }> = [];
      const carol = createTestPeerRig({
        ca,
        hub: resetCarolHub,
        network: resetNet,
        roomKeys,
        peerId: "peer_03carol_rst1",
        username: "carol",
        relayClient: carolRelay,
        initialRelayCursor: 50,
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: (batch) => {
            carolBatches.push({
              msgIds: batch.messages.map((m) => m.msgId),
              nextCursor: batch.nextCursor,
              cursorReset: batch.cursorReset,
            });
          },
        },
      });

      try {
        await carol.engine.start();
        await waitFor(() => carol.engine.getMessages().length === 2);

        expect(carol.engine.getVerifiedPeers()).toHaveLength(0);
        expect(carolRelay.recordedListAfterSeqs[0]).toBe(50);
        expect(carolBatches[0]).toEqual({
          msgIds: [resetMsg1.msgId, resetMsg2.msgId],
          nextCursor: 2,
          cursorReset: true,
        });

        // Alice uploads a 3rd message (seq 3); Carol polls strictly via blind relay from cursor 2 (not 50!)
        resetMsg3 = await aliceReset.engine.sendChatMessage(
          "Post-restart message #3",
        );
        await waitFor(
          () =>
            resetRelayHub.getStoredEnvelopeCount(
              inspectRelayKeys.relayBoxId,
            ) === 3,
        );
        await aliceReset.engine.stop();

        resetCarolHub.shutdownCenterServer();
        resetCarolHub.restartCenterServer();
        await carol.signaling.connect();

        await waitFor(() => carolBatches.length === 2);
        expect(carolRelay.recordedListAfterSeqs).toEqual([50, 2]);
        expect(carolBatches[1]).toEqual({
          msgIds: [resetMsg3.msgId],
          nextCursor: 3,
          cursorReset: false,
        });
        expect(carol.engine.getMessages().map((m) => m.msgId)).toEqual([
          resetMsg1.msgId,
          resetMsg2.msgId,
          resetMsg3.msgId,
        ]);
      } finally {
        await aliceReset.engine.stop();
        await carol.engine.stop();
      }

      // Empty-box cursorReset: true resets persisted cursor from 25 -> 0
      const emptyHub = new MockSignalingHub();
      const emptyNet = new MockPeerTransportNetwork();
      const emptyRelayHub = new MockBlindRelayHub();
      const daveRelay = emptyRelayHub.createClient();
      const daveBatches: Array<{
        msgCount: number;
        fileCount: number;
        nextCursor: number;
        cursorReset: boolean;
      }> = [];
      const dave = createTestPeerRig({
        ca,
        hub: emptyHub,
        network: emptyNet,
        roomKeys,
        peerId: "peer_04dave_empty",
        username: "dave",
        relayClient: daveRelay,
        initialRelayCursor: 25,
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: (batch) => {
            daveBatches.push({
              msgCount: batch.messages.length,
              fileCount: batch.files.length,
              nextCursor: batch.nextCursor,
              cursorReset: batch.cursorReset,
            });
          },
        },
      });
      try {
        await dave.engine.start();
        await waitFor(() => daveBatches.length === 1);
        expect(daveBatches[0]).toEqual({
          msgCount: 0,
          fileCount: 0,
          nextCursor: 0,
          cursorReset: true,
        });

        emptyHub.shutdownCenterServer();
        emptyHub.restartCenterServer();
        await dave.signaling.connect();
        await waitFor(() => daveRelay.listEnvelopeCalls === 2);
        expect(daveRelay.recordedListAfterSeqs).toEqual([25, 0]);
      } finally {
        await dave.engine.stop();
      }
    }
  });

  test(
    "15a. Codex review Fix 1: persisted-cursor reload downloads >32 MiB paged files via direct getEnvelope and scan fallback",
    async () => {
      const ca = createTestServerCA();
      const roomKeys = deriveRoomKeys(
        "codex-review-fix1-paged-reload",
        FAST_KDF,
      );
      const relayHub = new MockBlindRelayHub({
        maxFileBytes: 64 * 1024 * 1024,
      });
      const seederHub = new MockSignalingHub();
      const seederNet = new MockPeerTransportNetwork();
      const totalChunks = SWARM_HASH_PAGE_CHUNKS + 4; // 516 chunks -> 2 hash pages
      const pagedSize = totalChunks * SWARM_CHUNK_SIZE;
      const makeVirtualPagedChunk = (chunkIndex: number): Uint8Array => {
        const buf = new Uint8Array(SWARM_CHUNK_SIZE);
        buf.fill((chunkIndex * 31 + 7) & 0xff);
        buf[0] = chunkIndex & 0xff;
        buf[1] = (chunkIndex >>> 8) & 0xff;
        return buf;
      };

      const seeder = createTestPeerRig({
        ca,
        hub: seederHub,
        network: seederNet,
        roomKeys,
        peerId: "peer_15a_seeder01",
        username: "alice",
        relayClient: relayHub.createClient(),
        syncIntervalMs: 0,
      });

      let pagedManifest!: FileManifest;
      try {
        await seeder.engine.start();
        pagedManifest = await seeder.engine.shareFile({
          fileName: "paged-reload.bin",
          fileSize: pagedSize,
          readChunk: async (chunkIndex) => makeVirtualPagedChunk(chunkIndex),
        });
        expect(pagedManifest.hashPageHashes?.length).toBe(2);
        await waitFor(
          () =>
            seeder.engine.getTransferProgress(pagedManifest.fileId)
              ?.relayCacheState === "cached",
          10_000,
        );
      } finally {
        await seeder.engine.stop();
      }

      // First receiver session pulls hash_page + manifest envelopes and records persisted cursor
      const firstRecHub = new MockSignalingHub();
      const firstRecNet = new MockPeerTransportNetwork();
      let persistedCursor = 0;
      const rec1 = createTestPeerRig({
        ca,
        hub: firstRecHub,
        network: firstRecNet,
        roomKeys,
        peerId: "peer_15a_recv0001",
        username: "bob",
        relayClient: relayHub.createClient(),
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: (batch) => {
            persistedCursor = batch.nextCursor;
          },
        },
      });
      try {
        await rec1.engine.start();
        await waitFor(() => rec1.announcedFiles.length === 1);
        expect(persistedCursor).toBeGreaterThanOrEqual(3);
      } finally {
        await rec1.engine.stop();
      }

      // Simulated browser reload #1 (direct getEnvelope supported): starts with persisted manifest + cursor
      const reloadHub1 = new MockSignalingHub();
      const reloadNet1 = new MockPeerTransportNetwork();
      const reloadRelay1 = relayHub.createClient();
      const reload1Batches: number[] = [];
      const recReload1 = createTestPeerRig({
        ca,
        hub: reloadHub1,
        network: reloadNet1,
        roomKeys,
        peerId: "peer_15a_recv0002",
        username: "bob",
        relayClient: reloadRelay1,
        initialFiles: [pagedManifest],
        initialRelayCursor: persistedCursor,
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: (batch) => {
            reload1Batches.push(batch.nextCursor);
          },
        },
      });
      try {
        await recReload1.engine.start();
        await waitFor(() => reloadRelay1.listEnvelopeCalls >= 1);
        await recReload1.engine.downloadFile(pagedManifest.fileId);
        await waitFor(() => recReload1.completedFiles.length === 1, 10_000);
        expect(reloadRelay1.getEnvelopeCalls).toBeGreaterThanOrEqual(2);
        expect(reload1Batches).toEqual([]);
        const assembled1 = recReload1.storage.getFinalizedBytes(
          pagedManifest.fileId,
        );
        expect(assembled1?.byteLength).toBe(pagedSize);
        expect(assembled1?.subarray(0, 4)).toEqual(
          makeVirtualPagedChunk(0).subarray(0, 4),
        );
        expect(
          assembled1?.subarray(
            (totalChunks - 1) * SWARM_CHUNK_SIZE,
            (totalChunks - 1) * SWARM_CHUNK_SIZE + 4,
          ),
        ).toEqual(makeVirtualPagedChunk(totalChunks - 1).subarray(0, 4));
      } finally {
        await recReload1.engine.stop();
      }

      // Simulated browser reload #2 (getEnvelope omitted -> cursor-independent scan fallback)
      const reloadHub2 = new MockSignalingHub();
      const reloadNet2 = new MockPeerTransportNetwork();
      const reloadRelay2 = relayHub.createClient({ disableGetEnvelope: true });
      const reload2Batches: number[] = [];
      const recReload2 = createTestPeerRig({
        ca,
        hub: reloadHub2,
        network: reloadNet2,
        roomKeys,
        peerId: "peer_15a_recv0003",
        username: "bob",
        relayClient: reloadRelay2,
        initialFiles: [pagedManifest],
        initialRelayCursor: persistedCursor,
        syncIntervalMs: 0,
        extraEvents: {
          onRelayBatchPulled: (batch) => {
            reload2Batches.push(batch.nextCursor);
          },
        },
      });
      try {
        await recReload2.engine.start();
        await waitFor(() => reloadRelay2.listEnvelopeCalls >= 1);
        await recReload2.engine.downloadFile(pagedManifest.fileId);
        await waitFor(() => recReload2.completedFiles.length === 1, 10_000);
        expect(reloadRelay2.recordedListAfterSeqs).toContain(0);
        expect(reload2Batches).toEqual([]);
        reloadHub2.shutdownCenterServer();
        reloadHub2.restartCenterServer();
        await recReload2.signaling.connect();
        await waitFor(
          () =>
            reloadRelay2.recordedListAfterSeqs[
              reloadRelay2.recordedListAfterSeqs.length - 1
            ] === persistedCursor &&
            reloadRelay2.recordedListAfterSeqs.length >= 3,
        );
      } finally {
        await recReload2.engine.stop();
      }
    },
    20_000,
  );

  test("15b & 15c. Codex review Fixes 4 & 5: AEAD wire-byte quota eligibility and relay-slot release on download retry", async () => {
    const ca = createTestServerCA();
    const roomKeys = deriveRoomKeys(
      "codex-review-fix4-fix5-passphrase",
      FAST_KDF,
    );

    // 15b (Fix 4): Relay file eligibility accounts for per-chunk XChaCha20-Poly1305 overhead (40 B/chunk)
    {
      const exactTwoChunkBytes = 2 * SWARM_CHUNK_SIZE;
      const relayHub = new MockBlindRelayHub({
        maxFileBytes: exactTwoChunkBytes,
      });
      const hub = new MockSignalingHub();
      const net = new MockPeerTransportNetwork();
      const relayClient = relayHub.createClient();
      const seeder = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15b_seeder01",
        username: "alice",
        relayClient,
        syncIntervalMs: 0,
      });

      try {
        await seeder.engine.start();

        const overQuotaBytes = makeDeterministicPayload(exactTwoChunkBytes);
        const overManifest = await seeder.engine.shareFile({
          fileName: "over-by-aead-overhead.bin",
          fileSize: overQuotaBytes.byteLength,
          readChunk: makeSliceReader(overQuotaBytes),
        });
        expect(
          seeder.engine.getTransferProgress(overManifest.fileId)
            ?.relayCacheState,
        ).toBe("too_large");
        await new Promise<void>((r) => setTimeout(r, 40));
        expect(relayClient.putChunkCalls).toBe(0);

        const exactFitBytes = makeDeterministicPayload(
          exactTwoChunkBytes - 2 * RELAY_AEAD_OVERHEAD_BYTES,
        );
        const fitManifest = await seeder.engine.shareFile({
          fileName: "exact-wire-fit.bin",
          fileSize: exactFitBytes.byteLength,
          readChunk: makeSliceReader(exactFitBytes),
        });
        await waitFor(
          () =>
            seeder.engine.getTransferProgress(fitManifest.fileId)
              ?.relayCacheState === "cached",
        );
        expect(relayClient.putChunkCalls).toBe(2);
      } finally {
        await seeder.engine.stop();
      }
    }

    // 15c (Fix 5): Retrying a failed relay download clears obsolete in-flight relay slots without leaking the 4-slot cap
    {
      const relayHub = new MockBlindRelayHub();
      const seederHub = new MockSignalingHub();
      const seederNet = new MockPeerTransportNetwork();
      const fiveChunkBytes = makeDeterministicPayload(5 * SWARM_CHUNK_SIZE);

      const seeder = createTestPeerRig({
        ca,
        hub: seederHub,
        network: seederNet,
        roomKeys,
        peerId: "peer_15c_seeder01",
        username: "alice",
        relayClient: relayHub.createClient(),
        syncIntervalMs: 0,
      });

      let fiveChunkManifest!: FileManifest;
      try {
        await seeder.engine.start();
        fiveChunkManifest = await seeder.engine.shareFile({
          fileName: "five-chunk-retry.bin",
          fileSize: fiveChunkBytes.byteLength,
          readChunk: makeSliceReader(fiveChunkBytes),
        });
        await waitFor(
          () =>
            seeder.engine.getTransferProgress(fiveChunkManifest.fileId)
              ?.relayCacheState === "cached",
        );
      } finally {
        await seeder.engine.stop();
      }

      const recvHub = new MockSignalingHub();
      const recvNet = new MockPeerTransportNetwork();
      const baseRelay = relayHub.createClient();
      const delayedGen1Resolvers: Array<() => void> = [];
      let getChunkCallNum = 0;

      const gatedRelay: BlindRelayClientPort = {
        enabled: baseRelay.enabled,
        maxFileBytes: baseRelay.maxFileBytes,
        putEnvelope: (p) => baseRelay.putEnvelope(p),
        getEnvelope: baseRelay.getEnvelope
          ? (p) => baseRelay.getEnvelope!(p)
          : undefined,
        listEnvelopes: (p) => baseRelay.listEnvelopes(p),
        putChunk: (p) => baseRelay.putChunk(p),
        getChunk: async (p) => {
          getChunkCallNum += 1;
          const myCall = getChunkCallNum;
          if (myCall >= 2 && myCall <= 4) {
            await new Promise<void>((resolve) => {
              delayedGen1Resolvers.push(resolve);
            });
          }
          return baseRelay.getChunk(p);
        },
      };

      const receiver = createTestPeerRig({
        ca,
        hub: recvHub,
        network: recvNet,
        roomKeys,
        peerId: "peer_15c_recv0001",
        username: "bob",
        relayClient: gatedRelay,
        syncIntervalMs: 0,
      });

      let failedOnce = false;
      const origWrite = receiver.storage.writeVerifiedChunk.bind(
        receiver.storage,
      );
      receiver.storage.writeVerifiedChunk = async (
        fileId,
        chunkIndex,
        data,
      ) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("Transient OPFS write failure");
        }
        return origWrite(fileId, chunkIndex, data);
      };

      try {
        await receiver.engine.start();
        await waitFor(() => receiver.announcedFiles.length === 1);
        await receiver.engine.downloadFile(fiveChunkManifest.fileId);

        await waitFor(
          () =>
            receiver.engine.getTransferProgress(fiveChunkManifest.fileId)
              ?.status === "error" && delayedGen1Resolvers.length === 3,
        );

        await receiver.engine.downloadFile(fiveChunkManifest.fileId);
        await waitFor(() => receiver.completedFiles.length === 1, 5_000);
        expect(
          receiver.storage.getFinalizedBytes(fiveChunkManifest.fileId),
        ).toEqual(fiveChunkBytes);

        while (delayedGen1Resolvers.length > 0) {
          delayedGen1Resolvers.shift()!();
        }
        await new Promise<void>((r) => setTimeout(r, 20));
      } finally {
        await receiver.engine.stop();
      }
    }
  });

  test(
    "15d. Codex review Fix 6: gossip deduplication suppresses older messages outside 2,000-message window without triangle loops",
    async () => {
      const ca = createTestServerCA();
      const roomKeys = deriveRoomKeys(
        "codex-review-fix6-gossip-dedup",
        FAST_KDF,
      );
      const hub = new MockSignalingHub();
      const net = new MockPeerTransportNetwork();
      const baseTs = Date.now() - 10_000;
      const authorKeys = generateEd25519KeyPair();
      const authorCert = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: "usr_hist000001",
        username: "hist",
        displayName: "Hist",
        peerId: "peer_15d_hist0001",
        peerSignPubKey: authorKeys.publicKeyBase64Url,
        clientKind: "cli",
        nowMs: baseTs - 60_000,
        ttlMs: 3_600_000,
      });

      const retained2000: ChatMessageEnvelope[] = [];
      for (let i = 0; i < 2_000; i++) {
        retained2000.push(
          signChatMessage({
            roomId: roomKeys.roomId,
            lamport: 1_001 + i,
            body: `m${i}`,
            authorCert,
            peerSignPrivKey: authorKeys.privateKeyBytes,
            createdAt: baseTs + i,
          }),
        );
      }
      const olderEvictedMsg = signChatMessage({
        roomId: roomKeys.roomId,
        lamport: 1,
        body: "ancient-evicted-msg",
        authorCert,
        peerSignPrivKey: authorKeys.privateKeyBytes,
        createdAt: baseTs - 1_000,
      });

      const peerA = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15d_01alice0",
        username: "alice",
        initialMessages: retained2000,
        syncIntervalMs: 0,
      });
      const peerB = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15d_02bob000",
        username: "bob",
        initialMessages: retained2000,
        syncIntervalMs: 0,
      });
      const peerC = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15d_03carol0",
        username: "carol",
        initialMessages: retained2000,
        syncIntervalMs: 0,
      });

      expect(peerB.engine.getMessages().length).toBe(2_000);

      try {
        await Promise.all([
          peerA.engine.start(),
          peerB.engine.start(),
          peerC.engine.start(),
        ]);
        await waitFor(
          () =>
            peerA.engine.getVerifiedPeers().length === 2 &&
            peerB.engine.getVerifiedPeers().length === 2 &&
            peerC.engine.getVerifiedPeers().length === 2,
        );

        let forwardedChatFrames = 0;
        const bToC = peerB.connections.find(
          (c) => c.remotePeerId === peerC.peerId,
        )!;
        bToC.controlChannel.setTextOutgoingInterceptor((raw) => {
          try {
            const parsed = JSON.parse(raw) as { type?: string };
            if (parsed.type === "control.sealed") {
              const inner = openPostAuthControlFrame(
                roomKeys.roomAppKey,
                roomKeys.roomId,
                parsed as Parameters<typeof openPostAuthControlFrame>[2],
              );
              if (inner.type === "chat.message") {
                forwardedChatFrames += 1;
              }
            }
          } catch {
            // Ignore non-matching frames
          }
          return raw;
        });

        // Inject valid older message (lamport=1) directly from A -> B
        const aToB = peerA.connections.find(
          (c) => c.remotePeerId === peerB.peerId,
        )!;
        const sealedOld = sealPostAuthControlFrame(
          roomKeys.roomAppKey,
          roomKeys.roomId,
          { type: "chat.message", message: olderEvictedMsg },
        );
        aToB.controlChannel.sendText(JSON.stringify(sealedOld));

        await new Promise<void>((r) => setTimeout(r, 80));
        expect(peerB.receivedChat.length).toBe(0);
        expect(peerC.receivedChat.length).toBe(0);
        expect(forwardedChatFrames).toBe(0);
        expect(peerB.engine.getMessages().length).toBe(2_000);
        expect(
          peerB.engine
            .getMessages()
            .some((m) => m.msgId === olderEvictedMsg.msgId),
        ).toBe(false);

        // Positive control: a newer valid message (lamport=5000) DOES ingest & forward once to C!
        const newerMsg = signChatMessage({
          roomId: roomKeys.roomId,
          lamport: 5_000,
          body: "newer-valid-msg",
          authorCert,
          peerSignPrivKey: authorKeys.privateKeyBytes,
          createdAt: baseTs + 5_000,
        });
        const sealedNew = sealPostAuthControlFrame(
          roomKeys.roomAppKey,
          roomKeys.roomId,
          { type: "chat.message", message: newerMsg },
        );
        aToB.controlChannel.sendText(JSON.stringify(sealedNew));
        await waitFor(
          () => peerB.receivedChat.length === 1 && peerC.receivedChat.length === 1,
        );
        expect(forwardedChatFrames).toBe(1);
      } finally {
        await Promise.all([
          peerA.engine.stop(),
          peerB.engine.stop(),
          peerC.engine.stop(),
        ]);
      }
    },
    20_000,
  );

  test(
    "15e. Codex review Fix 7: converged peers with >500 files emit ZERO redundant sync.batch pushes on truncated sync.summary",
    async () => {
      const ca = createTestServerCA();
      const roomKeys = deriveRoomKeys(
        "codex-review-fix7-truncated-summary",
        FAST_KDF,
      );
      const hub = new MockSignalingHub();
      const net = new MockPeerTransportNetwork();
      const fileAuthorKeys = generateEd25519KeyPair();
      const fileAuthorCert = issuePeerIdentityCert({
        serverKeyId: ca.serverKeyId,
        serverSignPrivKey: ca.keyPair.privateKeyBytes,
        userId: "usr_files00001",
        username: "files",
        displayName: "Files",
        peerId: "peer_15e_files001",
        peerSignPubKey: fileAuthorKeys.publicKeyBase64Url,
        clientKind: "cli",
      });

      const emptyReader = async () => new Uint8Array(0);
      const filesA: FileManifest[] = [];
      const filesB: FileManifest[] = [];
      for (let i = 0; i < MAX_SYNC_MESSAGES; i++) {
        filesA.push(
          await createSignedFileManifestFromChunks({
            roomId: roomKeys.roomId,
            fileName: `a-${i}.txt`,
            fileSize: 0,
            readChunk: emptyReader,
            senderCert: fileAuthorCert,
            peerSignPrivKey: fileAuthorKeys.privateKeyBytes,
          }),
        );
        filesB.push(
          await createSignedFileManifestFromChunks({
            roomId: roomKeys.roomId,
            fileName: `b-${i}.txt`,
            fileSize: 0,
            readChunk: emptyReader,
            senderCert: fileAuthorCert,
            peerSignPrivKey: fileAuthorKeys.privateKeyBytes,
          }),
        );
      }

      const peerA = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15e_01alice0",
        username: "alice",
        initialFiles: filesA,
        syncIntervalMs: 50,
      });
      const peerB = createTestPeerRig({
        ca,
        hub,
        network: net,
        roomKeys,
        peerId: "peer_15e_02bob000",
        username: "bob",
        initialFiles: filesB,
        syncIntervalMs: 50,
      });

      try {
        await Promise.all([peerA.engine.start(), peerB.engine.start()]);
        await waitFor(
          () =>
            peerA.engine.getFiles().length === MAX_SYNC_MESSAGES * 2 &&
            peerB.engine.getFiles().length === MAX_SYNC_MESSAGES * 2,
          10_000,
        );

        let postConvergeSummaries = 0;
        let postConvergeSyncBatches = 0;
        for (const [rig, remoteId] of [
          [peerA, peerB.peerId],
          [peerB, peerA.peerId],
        ] as const) {
          const conn = rig.connections.find(
            (c) => c.remotePeerId === remoteId,
          )!;
          conn.controlChannel.setTextOutgoingInterceptor((raw) => {
            try {
              const parsed = JSON.parse(raw) as { type?: string };
              if (parsed.type === "control.sealed") {
                const inner = openPostAuthControlFrame(
                  roomKeys.roomAppKey,
                  roomKeys.roomId,
                  parsed as Parameters<typeof openPostAuthControlFrame>[2],
                );
                if (inner.type === "sync.summary") {
                  postConvergeSummaries += 1;
                } else if (inner.type === "sync.batch") {
                  postConvergeSyncBatches += 1;
                }
              }
            } catch {
              // Ignore non-control.sealed frames
            }
            return raw;
          });
        }

        await waitFor(() => postConvergeSummaries >= 4, 3_000);
        await new Promise<void>((r) => setTimeout(r, 80));
        expect(postConvergeSyncBatches).toBe(0);
      } finally {
        await Promise.all([peerA.engine.stop(), peerB.engine.stop()]);
      }
    },
    20_000,
  );
});
