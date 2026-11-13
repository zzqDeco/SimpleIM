import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessageEnvelope,
  FileManifest,
} from "../packages/contracts/src/index.ts";
import {
  bytesToHex,
  deriveRoomKeys,
  sha256Bytes,
  verifyChatMessage,
  wipeRoomKeys,
  type DerivedRoomKeys,
} from "../packages/crypto/src/index.ts";
import {
  createRoomPeerEngine,
  type RoomPeerEngine,
} from "../packages/peer-core/src/index.ts";
import {
  CliApiClient,
  CliSignalingClient,
  FsChunkStorageAdapter,
  SeedQuotaController,
  WeriftTransportFactory,
} from "../apps/cli/src/index.ts";
import {
  createSimpleImServer,
  type SimpleImServerInstance,
} from "../apps/server/src/server.ts";

function cloneRoomKeys(source: DerivedRoomKeys): DerivedRoomKeys {
  return {
    roomId: source.roomId,
    roomIdPrefix: source.roomIdPrefix,
    signalingKey: source.signalingKey.slice(),
    roomAuthKey: source.roomAuthKey.slice(),
    roomAppKey: source.roomAppKey.slice(),
  };
}

function createDeterministicBinaryPayload(byteLength: number, seedByte: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let state = (0x9e3779b9 ^ (seedByte & 0xff)) >>> 0;
  for (let i = 0; i < byteLength; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = (state + i * 31) & 0xff;
  }
  return bytes;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 30;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${options.label ?? "condition"}`);
}

interface RealCliPeerHandle {
  username: string;
  peerId: string;
  sessionToken: string;
  downloadDir: string;
  roomKeys: DerivedRoomKeys;
  storage: FsChunkStorageAdapter;
  signaling: CliSignalingClient;
  engine: RoomPeerEngine;
  receivedMessages: ChatMessageEnvelope[];
  announcedFiles: FileManifest[];
  completedFileIds: Set<string>;
  rejectedPeers: Array<{ peerId: string; reason: string }>;
  seedController?: SeedQuotaController;
  stop(): Promise<void>;
}

describe("Full-Stack Real WebRTC (werift UDP/DTLS/SCTP) + Server + Swarm E2E", () => {
  const tempDirs: string[] = [];
  const activeServers: SimpleImServerInstance[] = [];
  const activePeers: RealCliPeerHandle[] = [];

  afterEach(async () => {
    while (activePeers.length > 0) {
      const peer = activePeers.pop();
      if (peer) {
        await peer.stop().catch(() => {});
      }
    }
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.stop(true).catch(() => {});
        try {
          srv.sqliteDb.close(false);
        } catch {
          // Ignore already-closed database
        }
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  async function spawnRealPeer(params: {
    serverUrl: string;
    username: string;
    displayName: string;
    password: string;
    roomKeys: DerivedRoomKeys;
    downloadDir: string;
    maxInFlightPerPeer?: number;
    seedMaxStorageBytes?: number;
  }): Promise<RealCliPeerHandle> {
    const api = new CliApiClient({ serverUrl: params.serverUrl });
    const reg = await api.register({
      username: params.username,
      password: params.password,
      displayName: params.displayName,
    });
    const [meta, identity] = await Promise.all([
      api.getMeta(reg.sessionToken),
      api.requestFreshPeerIdentity({
        sessionToken: reg.sessionToken,
        userId: reg.user.id,
      }),
    ]);

    const signaling = new CliSignalingClient({
      serverUrl: params.serverUrl,
      sessionToken: reg.sessionToken,
      peerId: identity.peerId,
      initialReconnectDelayMs: 200,
      maxReconnectDelayMs: 1_000,
    });
    const transportFactory = new WeriftTransportFactory();
    const storage = new FsChunkStorageAdapter({
      downloadDir: params.downloadDir,
      maxStorageBytes: params.seedMaxStorageBytes,
    });

    const receivedMessages: ChatMessageEnvelope[] = [];
    const announcedFiles: FileManifest[] = [];
    const completedFileIds = new Set<string>();
    const rejectedPeers: Array<{ peerId: string; reason: string }> = [];

    let seedController: SeedQuotaController | undefined;
    let engineRef: RoomPeerEngine | null = null;

    if (params.seedMaxStorageBytes !== undefined) {
      seedController = new SeedQuotaController({
        maxStorageBytes: params.seedMaxStorageBytes,
        storage,
        downloadFile: async (fileId) => {
          if (!engineRef) {
            throw new Error("Engine not initialized");
          }
          await engineRef.downloadFile(fileId);
        },
        roomIdPrefix: params.roomKeys.roomIdPrefix,
      });
    }

    const peerRoomKeys = cloneRoomKeys(params.roomKeys);
    const engine = createRoomPeerEngine({
      localPeerId: identity.peerId,
      localCert: identity.cert,
      localSignKeyPair: identity.keyPair,
      serverSignPubKey: meta.serverSignPubKey,
      roomKeys: peerRoomKeys,
      iceServers: meta.iceServers,
      signaling,
      transportFactory,
      chunkStorage: storage,
      maxInFlightPerPeer: params.maxInFlightPerPeer ?? 4,
      events: {
        onChatMessage: (msg) => {
          receivedMessages.push(msg);
        },
        onFileAnnounced: (manifest) => {
          announcedFiles.push(manifest);
          if (seedController) {
            void seedController.onFileAnnounced(manifest);
          }
        },
        onTransferCompleted: (manifest) => {
          completedFileIds.add(manifest.fileId);
          seedController?.onTransferCompleted(manifest);
        },
        onPeerAuthRejected: (remotePeerId, reason) => {
          rejectedPeers.push({ peerId: remotePeerId, reason });
        },
      },
    });
    engineRef = engine;

    await engine.start();

    let stopped = false;
    const handle: RealCliPeerHandle = {
      username: params.username,
      peerId: identity.peerId,
      sessionToken: reg.sessionToken,
      downloadDir: params.downloadDir,
      roomKeys: peerRoomKeys,
      storage,
      signaling,
      engine,
      receivedMessages,
      announcedFiles,
      completedFileIds,
      rejectedPeers,
      seedController,
      async stop() {
        if (stopped) return;
        stopped = true;
        await engine.stop();
        await storage.closeAll();
        wipeRoomKeys(peerRoomKeys);
        identity.keyPair.privateKeyBytes.fill(0);
      },
    };

    activePeers.push(handle);
    return handle;
  }

  test(
    "4-peer Full Mesh connects over real UDP WebRTC, survives central server shutdown for chat & 6-chunk Swarm transfer, and leaves zero room/message state in SQLite",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "simpleim-e2e-mesh-"));
      tempDirs.push(rootDir);

      const sqlitePath = join(rootDir, "server.sqlite");
      const serverLogs: string[] = [];
      const server = createSimpleImServer({
        port: 0,
        host: "127.0.0.1",
        sqlitePath,
        stunUrls: [],
        passwordHashMemoryCost: 4_096,
        passwordHashTimeCost: 1,
        logSink: (line) => serverLogs.push(line),
      });
      activeServers.push(server);

      // Exercise full production Argon2id (64 MiB, t=3, p=1) + HKDF-SHA256 room derivation
      const secretPassphrase = "项目组-Phase6-分布式信道密码!";
      const masterRoomKeys = deriveRoomKeys(secretPassphrase);

      try {
        const [alice, bob, carol, dave] = await Promise.all([
          spawnRealPeer({
            serverUrl: server.url,
            username: "alice_mesh",
            displayName: "Alice Mesh",
            password: "Password-Alice-123!",
            roomKeys: masterRoomKeys,
            downloadDir: join(rootDir, "dl-alice"),
            maxInFlightPerPeer: 2,
          }),
          spawnRealPeer({
            serverUrl: server.url,
            username: "bob_mesh",
            displayName: "Bob Mesh",
            password: "Password-Bob-123!",
            roomKeys: masterRoomKeys,
            downloadDir: join(rootDir, "dl-bob"),
            maxInFlightPerPeer: 2,
          }),
          spawnRealPeer({
            serverUrl: server.url,
            username: "carol_mesh",
            displayName: "Carol Mesh",
            password: "Password-Carol-123!",
            roomKeys: masterRoomKeys,
            downloadDir: join(rootDir, "dl-carol"),
            maxInFlightPerPeer: 2,
          }),
          spawnRealPeer({
            serverUrl: server.url,
            username: "dave_mesh",
            displayName: "Dave Mesh",
            password: "Password-Dave-123!",
            roomKeys: masterRoomKeys,
            downloadDir: join(rootDir, "dl-dave"),
            maxInFlightPerPeer: 2,
          }),
        ]);

        const peers = [alice, bob, carol, dave];

        // 1. Wait for all 4 peers (6 bidirectional WebRTC connections) to pass HELLO_AUTH
        await waitFor(
          () =>
            peers.every((p) => p.engine.getVerifiedPeers().length === 3),
          {
            timeoutMs: 15_000,
            label: "4-peer HELLO_AUTH Full Mesh establishment",
          },
        );

        for (const p of peers) {
          expect(p.rejectedPeers).toHaveLength(0);
          expect(p.engine.isCenterConnected()).toBe(true);
        }

        // 2. Pre-shutdown signed chat & threaded reply
        const msg1 = await alice.engine.sendChatMessage(
          "Pre-shutdown message from Alice",
        );
        await waitFor(
          () =>
            peers.every((p) =>
              p.engine.getMessages().some((m) => m.msgId === msg1.msgId),
            ),
          { label: "Alice pre-shutdown chat propagation" },
        );

        const msg2 = await bob.engine.sendChatMessage(
          "Reply from Bob while signaling is online",
          msg1.msgId,
        );
        await waitFor(
          () =>
            peers.every((p) =>
              p.engine.getMessages().some((m) => m.msgId === msg2.msgId),
            ),
          { label: "Bob threaded reply propagation" },
        );

        // 3. Shut down the central server completely (HTTP + WebSocket killed)
        await server.stop(true);

        let healthReachable = false;
        try {
          await fetch(`${server.url}/healthz`);
          healthReachable = true;
        } catch {
          healthReachable = false;
        }
        expect(healthReachable).toBe(false);

        await waitFor(
          () => peers.every((p) => !p.engine.isCenterConnected()),
          {
            timeoutMs: 5_000,
            label: "All peers detect center signaling disconnect",
          },
        );

        // 4. Verify active P2P DataChannels survive server death for chat
        const postShutdownMsg = await carol.engine.sendChatMessage(
          "Zero-server P2P message from Carol after center shutdown!",
        );
        await waitFor(
          () =>
            peers.every((p) =>
              p
                .engine
                .getMessages()
                .some((m) => m.msgId === postShutdownMsg.msgId),
            ),
          { label: "Carol post-shutdown P2P chat propagation" },
        );

        for (const p of peers) {
          const delivered = p.engine
            .getMessages()
            .find((m) => m.msgId === postShutdownMsg.msgId);
          expect(delivered).toBeDefined();
          expect(
            verifyChatMessage(
              delivered!,
              server.serverSignPubKey,
              masterRoomKeys.roomId,
            ),
          ).toBe(true);
        }

        // 5. Share & Swarm-transfer a 350 KiB binary file (6 chunks of 64 KiB) while server is STILL dead!
        const fileBytes = createDeterministicBinaryPayload(350 * 1024 + 321, 0x42);
        const expectedSha256 = bytesToHex(sha256Bytes(fileBytes));
        const sourceFilePath = join(rootDir, "architecture-bundle.bin");
        await writeFile(sourceFilePath, fileBytes);

        const manifest = await alice.engine.shareFile({
          fileName: "architecture-bundle.bin",
          fileSize: fileBytes.byteLength,
          mimeType: "application/octet-stream",
          readChunk: async (_chunkIndex, offset, length) =>
            fileBytes.subarray(offset, offset + length),
        });
        expect(manifest.totalChunks).toBe(6);
        expect(manifest.fileSha256).toBe(expectedSha256);

        const leechers = [bob, carol, dave];
        await waitFor(
          () =>
            leechers.every((l) =>
              l.engine.getFiles().some((f) => f.fileId === manifest.fileId),
            ),
          { label: "FileManifest propagation across post-shutdown P2P mesh" },
        );

        await Promise.all(
          leechers.map((l) => l.engine.downloadFile(manifest.fileId)),
        );

        await waitFor(
          () => leechers.every((l) => l.completedFileIds.has(manifest.fileId)),
          {
            timeoutMs: 20_000,
            label: "3 leechers complete 6-chunk Swarm file transfer",
          },
        );

        for (const leecher of leechers) {
          const finalPath = leecher.storage.getCompletedFilePath(manifest.fileId);
          expect(finalPath).toBeDefined();
          const diskBytes = new Uint8Array(await readFile(finalPath!));
          expect(diskBytes.byteLength).toBe(fileBytes.byteLength);
          expect(bytesToHex(sha256Bytes(diskBytes))).toBe(expectedSha256);

          const dirEntries = await readdir(leecher.downloadDir);
          expect(
            dirEntries.some(
              (n) =>
                n.endsWith(".simpleim.part") || n.endsWith(".simpleim.bitfield"),
            ),
          ).toBe(false);
        }

        // 6. Audit server SQLite file & structured logs for strict zero-knowledge compliance
        server.sqliteDb.close(false);
        const auditDb = new Database(sqlitePath, { readonly: true });
        try {
          const tables = auditDb
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
            )
            .all()
            .map((r) => r.name);
          expect(tables).toEqual(["schema_migrations", "sessions", "users"]);

          const userDump = JSON.stringify(
            auditDb.query("SELECT * FROM users").all(),
          );
          const sessionDump = JSON.stringify(
            auditDb.query("SELECT * FROM sessions").all(),
          );
          const combinedDump = `${userDump}\n${sessionDump}\n${serverLogs.join("\n")}`;

          expect(combinedDump).not.toContain(secretPassphrase);
          expect(combinedDump).not.toContain(masterRoomKeys.roomId);
          expect(combinedDump).not.toContain("Pre-shutdown message from Alice");
          expect(combinedDump).not.toContain("Zero-server P2P message");
          expect(combinedDump).not.toContain("architecture-bundle.bin");
          for (const p of peers) {
            expect(combinedDump).not.toContain(p.sessionToken);
          }
        } finally {
          auditDb.close(false);
        }
      } finally {
        wipeRoomKeys(masterRoomKeys);
      }
    },
    45_000,
  );

  test(
    "Seed peer relays offline-author signed chat + Swarm chunks to late joiner and quarantines forged roomAuthKey intruder",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "simpleim-e2e-seed-"));
      tempDirs.push(rootDir);

      const server = createSimpleImServer({
        port: 0,
        host: "127.0.0.1",
        sqlitePath: join(rootDir, "seed-center.sqlite"),
        stunUrls: [],
        passwordHashMemoryCost: 4_096,
        passwordHashTimeCost: 1,
        logSink: () => {},
      });
      activeServers.push(server);

      const roomKeys = deriveRoomKeys("seed-relay-passphrase", {
        memoryKiB: 1_024,
        iterations: 1,
      });

      try {
        const [alice, seedBot] = await Promise.all([
          spawnRealPeer({
            serverUrl: server.url,
            username: "alice_author",
            displayName: "Alice Author",
            password: "Password-Alice-123!",
            roomKeys,
            downloadDir: join(rootDir, "dl-alice"),
          }),
          spawnRealPeer({
            serverUrl: server.url,
            username: "seed_daemon",
            displayName: "Seed Daemon",
            password: "Password-Seed-123!",
            roomKeys,
            downloadDir: join(rootDir, "dl-seed"),
            seedMaxStorageBytes: 5 * 1024 * 1024,
          }),
        ]);

        await waitFor(
          () =>
            alice.engine.getVerifiedPeers().length === 1 &&
            seedBot.engine.getVerifiedPeers().length === 1,
          { label: "Alice <-> SeedBot HELLO_AUTH" },
        );

        // Mallory has a valid server cert and even knows roomId + signalingKey (so ICE/DTLS connects),
        // but possesses an invalid roomAuthKey -> must fail HELLO_AUTH and stay quarantined!
        const forgedKeys: DerivedRoomKeys = {
          roomId: roomKeys.roomId,
          roomIdPrefix: roomKeys.roomIdPrefix,
          signalingKey: roomKeys.signalingKey.slice(),
          roomAuthKey: sha256Bytes("wrong-room-auth-key"),
          roomAppKey: sha256Bytes("wrong-room-app-key"),
        };
        const mallory = await spawnRealPeer({
          serverUrl: server.url,
          username: "mallory_intruder",
          displayName: "Mallory Intruder",
          password: "Password-Mallory-123!",
          roomKeys: forgedKeys,
          downloadDir: join(rootDir, "dl-mallory"),
        });
        wipeRoomKeys(forgedKeys);

        await waitFor(
          () =>
            alice.rejectedPeers.some((r) => r.peerId === mallory.peerId) &&
            seedBot.rejectedPeers.some((r) => r.peerId === mallory.peerId),
          {
            timeoutMs: 10_000,
            label: "Mallory quarantined and evicted by HELLO_AUTH",
          },
        );
        expect(mallory.engine.getVerifiedPeers()).toHaveLength(0);
        await mallory.stop();

        // Alice sends signed chat & shares a 150 KiB (3-chunk) file; SeedBot auto-seeds it
        const aliceMsg = await alice.engine.sendChatMessage(
          "Signed message authored by Alice before going offline",
        );
        const seedPayload = createDeterministicBinaryPayload(150 * 1024 + 77, 0x99);
        const seedExpectedSha = bytesToHex(sha256Bytes(seedPayload));

        const seededManifest = await alice.engine.shareFile({
          fileName: "release-notes.pdf",
          fileSize: seedPayload.byteLength,
          mimeType: "application/pdf",
          readChunk: async (_idx, offset, length) =>
            seedPayload.subarray(offset, offset + length),
        });
        expect(seededManifest.totalChunks).toBe(3);

        await waitFor(
          () =>
            seedBot.engine.getMessages().some((m) => m.msgId === aliceMsg.msgId) &&
            seedBot.completedFileIds.has(seededManifest.fileId),
          {
            timeoutMs: 15_000,
            label: "SeedBot syncs Alice chat and auto-downloads 3-chunk file",
          },
        );

        // Alice leaves completely!
        await alice.stop();
        await waitFor(
          () => seedBot.engine.getVerifiedPeers().length === 0,
          { label: "SeedBot observes Alice departure" },
        );

        // Late-joiner Bob enters the room and catches up purely from SeedBot
        const bob = await spawnRealPeer({
          serverUrl: server.url,
          username: "bob_late_joiner",
          displayName: "Bob Late Joiner",
          password: "Password-Bob-123!",
          roomKeys,
          downloadDir: join(rootDir, "dl-bob"),
        });

        await waitFor(
          () =>
            bob.engine.getVerifiedPeers().length === 1 &&
            bob.engine.getMessages().some((m) => m.msgId === aliceMsg.msgId) &&
            bob.engine.getFiles().some((f) => f.fileId === seededManifest.fileId),
          {
            timeoutMs: 15_000,
            label: "Bob catches up Alice's signed message & FileManifest from SeedBot",
          },
        );

        const syncedMsg = bob.engine
          .getMessages()
          .find((m) => m.msgId === aliceMsg.msgId)!;
        expect(syncedMsg.authorCert.payload.username).toBe("alice_author");
        expect(
          verifyChatMessage(
            syncedMsg,
            server.serverSignPubKey,
            roomKeys.roomId,
          ),
        ).toBe(true);

        await bob.engine.downloadFile(seededManifest.fileId);
        await waitFor(
          () => bob.completedFileIds.has(seededManifest.fileId),
          {
            timeoutMs: 15_000,
            label: "Bob downloads Alice's file from SeedBot",
          },
        );

        const bobFinalPath = bob.storage.getCompletedFilePath(
          seededManifest.fileId,
        );
        expect(bobFinalPath).toBeDefined();
        const bobBytes = new Uint8Array(await readFile(bobFinalPath!));
        expect(bytesToHex(sha256Bytes(bobBytes))).toBe(seedExpectedSha);
      } finally {
        wipeRoomKeys(roomKeys);
      }
    },
    45_000,
  );
});
