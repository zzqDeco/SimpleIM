import { describe, expect, test } from "bun:test";
import {
  decodeSwarmFrame,
  encodeSwarmFrame,
  MAX_CHAT_LAMPORT,
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
  requestTimeoutMs?: number;
  helloAuthTimeoutMs?: number;
  maxSignalPayloadBytes?: number;
  now?: () => number;
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
    requestTimeoutMs: params.requestTimeoutMs,
    helloAuthTimeoutMs: params.helloAuthTimeoutMs,
    maxSignalPayloadBytes: params.maxSignalPayloadBytes,
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
  });
});
