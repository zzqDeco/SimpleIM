import { deriveRoomKeys, wipeRoomKeys } from "@simpleim/crypto";
import { createRoomPeerEngine } from "@simpleim/peer-core";
import { CliApiClient } from "../api-client.ts";
import type { ParsedCliCommand } from "../args.ts";
import { CredentialStore } from "../credentials.ts";
import { FsChunkStorageAdapter } from "../fs-chunk-storage.ts";
import { StructuredLogger } from "../logger.ts";
import { readPassphrase } from "../passphrase.ts";
import { SeedQuotaController } from "../seed-controller.ts";
import { CliSignalingClient } from "../signaling-client.ts";
import { WeriftTransportFactory } from "../werift-transport.ts";
import { requireValidCredentials, type CommandIo } from "./auth.ts";

export async function runSeedCommand(
  cmd: Extract<ParsedCliCommand, { command: "seed" }>,
  io: CommandIo & { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const logger = new StructuredLogger({
    sink: (line) => (cmd.json ? stdout : stderr).write(`${line}\n`),
  });

  const bootStartedAt = Date.now();
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const creds = await requireValidCredentials(store, cmd.serverUrl, io.env);

  const passphrase = await readPassphrase({
    fromStdin: cmd.passphraseStdin,
    stdin,
    stderr,
  });

  const kdfStartedAt = Date.now();
  const roomKeys = deriveRoomKeys(passphrase);
  logger.info("seed.kdf.completed", {
    roomIdPrefix: roomKeys.roomIdPrefix,
    durationMs: Date.now() - kdfStartedAt,
  });

  const maxStorageBytes = Math.floor(cmd.maxStorageMb * 1024 * 1024);
  const api = new CliApiClient({
    serverUrl: creds.serverUrl,
    fetchImpl: io.fetchImpl,
  });
  const meta = await api.getMeta(creds.sessionToken);
  const { peerId, keyPair, cert } = await api.requestFreshPeerIdentity({
    sessionToken: creds.sessionToken,
    userId: creds.user.id,
  });

  const signaling = new CliSignalingClient({
    serverUrl: api.serverUrl,
    sessionToken: creds.sessionToken,
    peerId,
    maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
    onProtocolError: (err) => {
      logger.warn("seed.signaling.protocol_error", {
        roomIdPrefix: roomKeys.roomIdPrefix,
        errorCode: "invalid_frame",
        meta: { reason: err.message },
      });
    },
  });

  const transportFactory = new WeriftTransportFactory();
  const chunkStorage = new FsChunkStorageAdapter({
    downloadDir: cmd.storageDir,
    maxStorageBytes,
  });

  let quotaController: SeedQuotaController | null = null;

  const engine = createRoomPeerEngine({
    localPeerId: peerId,
    localCert: cert,
    localSignKeyPair: keyPair,
    serverSignPubKey: meta.serverSignPubKey,
    roomKeys,
    iceServers: meta.iceServers,
    maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
    signaling,
    transportFactory,
    chunkStorage,
    events: {
      onCenterConnectionChange: (connected) => {
        logger.info("seed.center.connection_changed", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { connected },
        });
      },
      onPeersChange: (peers) => {
        logger.info("seed.peers.changed", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { verifiedPeerCount: peers.length },
        });
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        logger.warn("seed.peer.auth_rejected", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          errorCode: "hello_auth_failed",
          meta: { remotePeerId, reason },
        });
      },
      onChatMessage: (msg, isHistoricalSync) => {
        // Never log chat message body — only opaque msgId & lamport counter
        logger.info("seed.chat.cached", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: {
            msgId: msg.msgId,
            lamport: msg.lamport,
            isHistoricalSync,
          },
        });
      },
      onFileAnnounced: (manifest) => {
        if (manifest.senderCert.payload.peerId === peerId) return;
        void quotaController?.onFileAnnounced(manifest);
      },
      onTransferCompleted: (manifest) => {
        quotaController?.onTransferCompleted(manifest);
      },
      onError: (err) => {
        logger.error("seed.engine.error", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          errorCode: "internal_error",
          meta: { reason: err.message },
        });
      },
    },
  });

  quotaController = new SeedQuotaController({
    maxStorageBytes,
    storage: chunkStorage,
    downloadFile: (fileId) => engine.downloadFile(fileId),
    logger,
    roomIdPrefix: roomKeys.roomIdPrefix,
  });

  try {
    await engine.start();
    logger.info("seed.ready", {
      roomIdPrefix: roomKeys.roomIdPrefix,
      durationMs: Date.now() - bootStartedAt,
      meta: {
        peerId,
        maxStorageBytes,
      },
    });

    await new Promise<void>((resolveShutdown) => {
      let stopping = false;
      const triggerStop = (signalName: string) => {
        if (stopping) return;
        stopping = true;
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
        logger.info("seed.stopping", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { signal: signalName },
        });
        resolveShutdown();
      };
      const onSigInt = () => triggerStop("SIGINT");
      const onSigTerm = () => triggerStop("SIGTERM");

      if (io.abortSignal?.aborted) {
        triggerStop("ABORT");
        return;
      }

      process.once("SIGINT", onSigInt);
      process.once("SIGTERM", onSigTerm);
      io.abortSignal?.addEventListener(
        "abort",
        () => triggerStop("ABORT"),
        { once: true },
      );
    });
  } finally {
    const stopStartedAt = Date.now();
    await engine.stop().catch(() => {});
    await chunkStorage.closeAll();
    wipeRoomKeys(roomKeys);
    keyPair.privateKeyBytes.fill(0);
    logger.info("seed.stopped", {
      roomIdPrefix: roomKeys.roomIdPrefix,
      durationMs: Date.now() - stopStartedAt,
      meta: {
        totalUptimeMs: Date.now() - bootStartedAt,
      },
    });
  }
}
