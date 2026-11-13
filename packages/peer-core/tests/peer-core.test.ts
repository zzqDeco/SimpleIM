import { describe, expect, test } from "bun:test";
import {
  decodeSwarmFrame,
  encodeSwarmFrame,
  SWARM_CHUNK_SIZE,
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
  deriveRoomKeys,
  generateEd25519KeyPair,
  issuePeerIdentityCert,
  sealPostAuthControlFrame,
  signChatMessage,
  type DerivedRoomKeys,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import {
  createRoomPeerEngine,
  type RoomPeerEngine,
  type RoomPeerEngineEvents,
} from "../src/index.ts";
import {
  InMemoryChunkStorage,
  makeDeterministicFingerprint,
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
  helloAuthTimeoutMs?: number;
  now?: () => number;
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

  const signaling = params.hub.createClient(params.peerId);
  const { factory, createdConnections } = params.network.createFactory(
    params.transportConfig,
  );
  const storage = new InMemoryChunkStorage();

  const receivedChat: Array<{
    msg: ChatMessageEnvelope;
    isHistoricalSync: boolean;
  }> = [];
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
    maxInFlightPerPeer: params.maxInFlightPerPeer,
    helloAuthTimeoutMs: params.helloAuthTimeoutMs,
    now: params.now,
    events: {
      onCenterConnectionChange: (connected) => {
        centerStates.push(connected);
        params.extraEvents?.onCenterConnectionChange?.(connected);
      },
      onPeersChange: (peers) => {
        params.extraEvents?.onPeersChange?.(peers);
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        authRejections.push({ remotePeerId, reason });
        params.extraEvents?.onPeerAuthRejected?.(remotePeerId, reason);
      },
      onChatMessage: (msg, isHistoricalSync) => {
        receivedChat.push({ msg, isHistoricalSync });
        params.extraEvents?.onChatMessage?.(msg, isHistoricalSync);
      },
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
});
