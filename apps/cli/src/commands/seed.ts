import { deriveRoomKeys, wipeRoomKeys } from "@simpleim/crypto";
import { createRoomPeerEngine } from "@simpleim/peer-core";
import { CliApiClient } from "../api-client.ts";
import type { ParsedCliCommand } from "../args.ts";
import { CredentialStore } from "../credentials.ts";
import { FsChunkStorageAdapter } from "../fs-chunk-storage.ts";
import { StructuredLogger } from "../logger.ts";
import { readPassphrase } from "../passphrase.ts";
import {
  SeedQuotaController,
  type SeedQuotaEvent,
} from "../seed-controller.ts";
import { CliSignalingClient } from "../signaling-client.ts";
import {
  createCliPalette,
  formatCliRoomFingerprint,
  formatShortId,
  shouldUseColor,
} from "../terminal-io.ts";
import { sanitizeTerminalSingleLine } from "../terminal-sanitize.ts";
import { WeriftTransportFactory } from "../werift-transport.ts";
import {
  requireValidCredentials,
  withNetworkServerHint,
  type CommandIo,
} from "./auth.ts";
import { formatHumanBytes } from "./join.ts";

export function formatSeedQuotaHumanEvent(event: SeedQuotaEvent): string {
  const shortFileId = formatShortId(event.fileId, 8);
  switch (event.kind) {
    case "accepted":
      return `[seed] Caching file ${shortFileId} (${formatHumanBytes(event.fileSize)}, ${event.totalChunks} chunks)...`;
    case "skipped_quota":
      return `[seed] Skipped file ${shortFileId} (${formatHumanBytes(event.fileSize)}): exceeds storage quota (${formatHumanBytes(event.diskBytes)} / ${formatHumanBytes(event.maxStorageBytes)})`;
    case "completed":
      return `[seed] Seeding file ${shortFileId} (${formatHumanBytes(event.fileSize)})`;
    case "download_failed":
      return `[seed] Failed to cache file ${shortFileId}: ${sanitizeTerminalSingleLine(event.reason)}`;
  }
}

export async function runSeedCommand(
  cmd: Extract<ParsedCliCommand, { command: "seed" }>,
  io: CommandIo & { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const logger = cmd.json
    ? new StructuredLogger({
        sink: (line) => stdout.write(`${line}\n`),
      })
    : undefined;

  const palette = createCliPalette(
    !cmd.json && shouldUseColor(stdout, io.env),
  );
  const writeHuman = (
    text: string,
    target: "stdout" | "stderr" = "stdout",
  ): void => {
    if (cmd.json) return;
    (target === "stderr" ? stderr : stdout).write(`${text}\n`);
  };

  const bootStartedAt = Date.now();
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const creds = await requireValidCredentials(store, cmd.serverUrl, io.env);

  const passphrase = await readPassphrase({
    fromStdin: cmd.passphraseStdin,
    stdin,
    stderr,
  });

  writeHuman(
    palette.dim("Deriving E2EE room keys (Argon2id 64 MiB)..."),
    "stderr",
  );
  const kdfStartedAt = Date.now();
  const roomKeys = deriveRoomKeys(passphrase);
  logger?.info("seed.kdf.completed", {
    roomIdPrefix: roomKeys.roomIdPrefix,
    durationMs: Date.now() - kdfStartedAt,
  });

  const maxStorageBytes = Math.floor(cmd.maxStorageMb * 1024 * 1024);
  const api = new CliApiClient({
    serverUrl: creds.serverUrl,
    fetchImpl: io.fetchImpl,
  });
  let meta;
  let identity;
  try {
    meta = await api.getMeta(creds.sessionToken);
    identity = await api.requestFreshPeerIdentity({
      sessionToken: creds.sessionToken,
      userId: creds.user.id,
    });
  } catch (err) {
    throw withNetworkServerHint(err, api.serverUrl);
  }
  const { peerId, keyPair, cert } = identity;

  const signaling = new CliSignalingClient({
    serverUrl: api.serverUrl,
    sessionToken: creds.sessionToken,
    peerId,
    maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
    onProtocolError: (err) => {
      logger?.warn("seed.signaling.protocol_error", {
        roomIdPrefix: roomKeys.roomIdPrefix,
        errorCode: "invalid_frame",
        meta: { reason: err.message },
      });
      writeHuman(
        palette.yellow(
          `[signal] Protocol error: ${sanitizeTerminalSingleLine(err.message)}`,
        ),
        "stderr",
      );
    },
  });

  const transportFactory = new WeriftTransportFactory({
    onNetworkDiagnostic: (diag) => {
      logger?.warn("seed.network.degraded", {
        roomIdPrefix: roomKeys.roomIdPrefix,
        errorCode: diag.code,
        meta: {
          syscall: diag.syscall ?? null,
          errnoCode: diag.errnoCode ?? null,
          hasStunServer: diag.hasStunServer,
          hasTurnServer: diag.hasTurnServer,
          explicitHostCount: diag.explicitHostCount,
        },
      });
      writeHuman(
        palette.yellow(
          `[network] ${sanitizeTerminalSingleLine(diag.message)}`,
        ),
        "stderr",
      );
    },
  });
  const chunkStorage = new FsChunkStorageAdapter({
    downloadDir: cmd.storageDir,
    maxStorageBytes,
  });
  const relayClient = api.createBlindRelayClient(
    creds.sessionToken,
    meta.relay,
  );

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
    relayClient,
    events: {
      onCenterConnectionChange: (connected) => {
        logger?.info("seed.center.connection_changed", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { connected },
        });
        writeHuman(
          connected
            ? palette.green("[signal] Connected to signaling relay")
            : palette.yellow(
                "[signal] Signaling relay disconnected (active P2P channels remain alive)",
              ),
        );
      },
      onPeersChange: (peers) => {
        logger?.info("seed.peers.changed", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { verifiedPeerCount: peers.length },
        });
        const names = peers
          .map((p) => `@${sanitizeTerminalSingleLine(p.username)}`)
          .join(", ");
        writeHuman(
          `[room] Verified peers (${peers.length}): ${names || "none"}`,
        );
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        logger?.warn("seed.peer.auth_rejected", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          errorCode: "hello_auth_failed",
          meta: { remotePeerId, reason },
        });
        writeHuman(
          palette.yellow(
            `[security] Quarantined peer ${formatShortId(remotePeerId, 8)} rejected (${sanitizeTerminalSingleLine(reason)})`,
          ),
          "stderr",
        );
      },
      onChatMessage: (msg, isHistoricalSync) => {
        // Never log chat message body — only opaque msgId & lamport counter
        logger?.info("seed.chat.cached", {
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
        logger?.error("seed.engine.error", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          errorCode: "internal_error",
          meta: { reason: err.message },
        });
        writeHuman(
          palette.red(`[error] ${sanitizeTerminalSingleLine(err.message)}`),
          "stderr",
        );
      },
    },
  });

  quotaController = new SeedQuotaController({
    maxStorageBytes,
    storage: chunkStorage,
    downloadFile: (fileId) => engine.downloadFile(fileId),
    logger,
    onEvent: (event) => {
      writeHuman(
        formatSeedQuotaHumanEvent(event),
        event.kind === "download_failed" || event.kind === "skipped_quota"
          ? "stderr"
          : "stdout",
      );
    },
    roomIdPrefix: roomKeys.roomIdPrefix,
  });

  try {
    await engine.start();
    const fingerprint = formatCliRoomFingerprint(roomKeys.roomIdPrefix);
    logger?.info("seed.ready", {
      roomIdPrefix: roomKeys.roomIdPrefix,
      durationMs: Date.now() - bootStartedAt,
      meta: {
        peerId,
        maxStorageBytes,
      },
    });
    writeHuman(
      `Seed peer ready for room ${fingerprint} as @${sanitizeTerminalSingleLine(creds.user.username)} (${formatShortId(peerId, 8)}). Quota: ${formatHumanBytes(maxStorageBytes)}, Storage: ${cmd.storageDir}`,
    );
    writeHuman(palette.dim("Press Ctrl+C to stop seeding."));

    await new Promise<void>((resolveShutdown) => {
      let stopping = false;
      const onSigInt = () => triggerStop("SIGINT");
      const onSigTerm = () => triggerStop("SIGTERM");
      const onAbort = () => triggerStop("ABORT");
      const triggerStop = (signalName: string) => {
        if (stopping) return;
        stopping = true;
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
        io.abortSignal?.removeEventListener("abort", onAbort);
        logger?.info("seed.stopping", {
          roomIdPrefix: roomKeys.roomIdPrefix,
          meta: { signal: signalName },
        });
        writeHuman(`[seed] Stopping (${signalName})...`);
        resolveShutdown();
      };

      if (io.abortSignal?.aborted) {
        triggerStop("ABORT");
        return;
      }

      process.once("SIGINT", onSigInt);
      process.once("SIGTERM", onSigTerm);
      io.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    const stopStartedAt = Date.now();
    await engine.stop().catch(() => {});
    await chunkStorage.closeAll();
    wipeRoomKeys(roomKeys);
    keyPair.privateKeyBytes.fill(0);
    logger?.info("seed.stopped", {
      roomIdPrefix: roomKeys.roomIdPrefix,
      durationMs: Date.now() - stopStartedAt,
      meta: {
        totalUptimeMs: Date.now() - bootStartedAt,
      },
    });
    writeHuman("[seed] Stopped cleanly and wiped room keys.");
  }
}
