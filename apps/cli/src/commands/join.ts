import { open, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FileManifest } from "@simpleim/contracts";
import { deriveRoomKeys, wipeRoomKeys } from "@simpleim/crypto";
import { createRoomPeerEngine, type RoomPeerEngine } from "@simpleim/peer-core";
import { CliApiClient } from "../api-client.ts";
import type { ParsedCliCommand } from "../args.ts";
import { CredentialStore } from "../credentials.ts";
import { FsChunkStorageAdapter } from "../fs-chunk-storage.ts";
import { readPassphrase } from "../passphrase.ts";
import { CliSignalingClient } from "../signaling-client.ts";
import { WeriftTransportFactory } from "../werift-transport.ts";
import { requireValidCredentials, type CommandIo } from "./auth.ts";

export function formatHumanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function guessMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".txt":
    case ".md":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".zip":
      return "application/zip";
    case ".gz":
      return "application/gzip";
    default:
      return "application/octet-stream";
  }
}

export class LocalSharedFileRegistry {
  private readonly handles = new Map<string, Promise<FileHandle>>();

  createChunkReader(
    resolvedFilePath: string,
  ): (chunkIndex: number, offset: number, length: number) => Promise<Uint8Array> {
    return async (_chunkIndex: number, offset: number, length: number) => {
      let fhPromise = this.handles.get(resolvedFilePath);
      if (!fhPromise) {
        fhPromise = open(resolvedFilePath, "r");
        this.handles.set(resolvedFilePath, fhPromise);
      }
      const fh = await fhPromise;
      const buf = new Uint8Array(length);
      let readTotal = 0;
      while (readTotal < length) {
        const { bytesRead } = await fh.read(
          buf,
          readTotal,
          length - readTotal,
          offset + readTotal,
        );
        if (bytesRead <= 0) {
          throw new Error(
            `Unexpected EOF while reading shared file at offset ${offset + readTotal}`,
          );
        }
        readTotal += bytesRead;
      }
      return buf;
    };
  }

  async closeAll(): Promise<void> {
    const pending = Array.from(this.handles.values());
    this.handles.clear();
    for (const p of pending) {
      const fh = await p.catch(() => null);
      if (fh) {
        await fh.close().catch(() => {});
      }
    }
  }
}

export function formatJoinSlashHelp(): string {
  return [
    "Commands:",
    "  /peers                 List verified room peers and signaling state",
    "  /send <filepath>       Announce and seed a local file via 64 KiB P2P Swarm",
    "  /files                 List announced files in the room and transfer status",
    "  /get <fileId|index>    Download an announced file into download directory",
    "  /help                  Show this command reference",
    "  /leave, /quit          Disconnect from room and wipe keys",
  ].join("\n");
}

function resolveTargetManifest(
  files: readonly FileManifest[],
  selector: string,
): FileManifest {
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    const byIndex = files[idx - 1];
    if (!byIndex) {
      throw new Error(
        `No file at index ${idx} (${files.length} file(s) announced; run /files)`,
      );
    }
    return byIndex;
  }

  const exact = files.find((f) => f.fileId === trimmed);
  if (exact) return exact;

  const prefixMatches = files.filter((f) => f.fileId.startsWith(trimmed));
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous fileId prefix '${trimmed}'; run /files for full IDs`);
  }
  throw new Error(`Unknown file '${trimmed}'; run /files to list available files`);
}

export async function executeJoinInputLine(params: {
  line: string;
  engine: RoomPeerEngine;
  chunkStorage: FsChunkStorageAdapter;
  sharedFiles: LocalSharedFileRegistry;
  stdout: NodeJS.WritableStream;
  cwd?: string;
}): Promise<"continue" | "exit"> {
  const { line, engine, chunkStorage, sharedFiles, stdout } = params;
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return "continue";
  }

  if (!trimmed.startsWith("/")) {
    const sent = await engine.sendChatMessage(trimmed);
    const author = sent.authorCert.payload;
    stdout.write(
      `[${formatClock(sent.createdAt)}] @${author.username}: ${sent.body}\n`,
    );
    return "continue";
  }

  const spaceIdx = trimmed.indexOf(" ");
  const verb = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

  switch (verb) {
    case "/leave":
    case "/quit":
      return "exit";

    case "/help":
      stdout.write(`${formatJoinSlashHelp()}\n`);
      return "continue";

    case "/peers": {
      const centerStatus = engine.isCenterConnected()
        ? "connected"
        : "detached (P2P channels active)";
      const peers = engine.getVerifiedPeers();
      stdout.write(`Signaling server: ${centerStatus}\n`);
      if (peers.length === 0) {
        stdout.write("Verified P2P peers: (none)\n");
      } else {
        stdout.write(`Verified P2P peers (${peers.length}):\n`);
        for (const p of peers) {
          const rttLabel = p.rttMs !== null ? `${p.rttMs}ms` : "n/a";
          stdout.write(
            `  - @${p.username} (${p.displayName}) [${p.clientKind}] ${p.peerId} rtt=${rttLabel}\n`,
          );
        }
      }
      return "continue";
    }

    case "/send": {
      if (!rest) {
        stdout.write("Usage: /send <filepath>\n");
        return "continue";
      }
      const targetPath = resolve(params.cwd ?? process.cwd(), rest);
      const st = await stat(targetPath);
      if (!st.isFile()) {
        throw new Error(`Not a regular file: ${targetPath}`);
      }
      const readChunk = sharedFiles.createChunkReader(targetPath);
      const manifest = await engine.shareFile({
        fileName: basename(targetPath),
        fileSize: st.size,
        mimeType: guessMimeType(targetPath),
        readChunk,
      });
      stdout.write(
        `[file] Announced '${manifest.fileName}' (${formatHumanBytes(manifest.fileSize)}, ${manifest.totalChunks} chunks) id=${manifest.fileId}\n`,
      );
      return "continue";
    }

    case "/files": {
      const files = engine.getFiles();
      if (files.length === 0) {
        stdout.write("No files announced in this room yet.\n");
        return "continue";
      }
      stdout.write(`Room files (${files.length}):\n`);
      files.forEach((f, i) => {
        const prog = engine.getTransferProgress(f.fileId);
        const pct =
          f.totalChunks === 0
            ? 100
            : prog
              ? Math.floor((prog.completedChunks / f.totalChunks) * 100)
              : 0;
        const status = prog ? `${prog.status} ${pct}%` : "announced";
        const savedPath = chunkStorage.getCompletedFilePath(f.fileId);
        const savedSuffix = savedPath ? ` -> ${savedPath}` : "";
        stdout.write(
          `  [${i + 1}] ${f.fileId}  ${f.fileName} (${formatHumanBytes(f.fileSize)}) from @${f.senderCert.payload.username} [${status}]${savedSuffix}\n`,
        );
      });
      return "continue";
    }

    case "/get": {
      if (!rest) {
        stdout.write("Usage: /get <fileId|index>\n");
        return "continue";
      }
      const target = resolveTargetManifest(engine.getFiles(), rest);
      stdout.write(
        `[file] Starting Swarm download for '${target.fileName}' (${formatHumanBytes(target.fileSize)})...\n`,
      );
      await engine.downloadFile(target.fileId);
      return "continue";
    }

    default:
      stdout.write(`Unknown slash command '${verb}'. Type /help for commands.\n`);
      return "continue";
  }
}

export async function runJoinCommand(
  cmd: Extract<ParsedCliCommand, { command: "join" }>,
  io: CommandIo & { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const creds = await requireValidCredentials(store, cmd.serverUrl, io.env);

  const passphrase = await readPassphrase({
    fromStdin: cmd.passphraseStdin,
    stdin,
    stderr,
  });

  stderr.write("Deriving E2EE room keys (Argon2id 64 MiB)...\n");
  const roomKeys = deriveRoomKeys(passphrase);

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
  });
  const transportFactory = new WeriftTransportFactory({
    onNetworkDiagnostic: (diag) => {
      stderr.write(`[network] ${diag.message}\n`);
    },
  });
  const chunkStorage = new FsChunkStorageAdapter({
    downloadDir: cmd.downloadDir,
  });
  const sharedFiles = new LocalSharedFileRegistry();

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
        stdout.write(
          connected
            ? "[signal] Connected to signaling relay\n"
            : "[signal] Signaling relay disconnected (active P2P channels remain alive)\n",
        );
      },
      onPeersChange: (peers) => {
        const names = peers.map((p) => `@${p.username}`).join(", ");
        stdout.write(
          `[room] Verified peers (${peers.length}): ${names || "none"}\n`,
        );
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        stderr.write(
          `[security] Quarantined peer ${remotePeerId} rejected (${reason})\n`,
        );
      },
      onChatMessage: (msg, isSync) => {
        const prefix = isSync ? "[sync] " : "";
        stdout.write(
          `${prefix}[${formatClock(msg.createdAt)}] @${msg.authorCert.payload.username}: ${msg.body}\n`,
        );
      },
      onFileAnnounced: (manifest) => {
        if (manifest.senderCert.payload.peerId === peerId) return;
        stdout.write(
          `[file] @${manifest.senderCert.payload.username} shared '${manifest.fileName}' (${formatHumanBytes(manifest.fileSize)}) — run '/get ${manifest.fileId}' or '/files'\n`,
        );
      },
      onTransferCompleted: (manifest) => {
        const finalPath = chunkStorage.getCompletedFilePath(manifest.fileId);
        stdout.write(
          `[file] Completed '${manifest.fileName}' -> ${finalPath ?? cmd.downloadDir} (seeding)\n`,
        );
      },
      onError: (err) => {
        stderr.write(`[error] ${err.message}\n`);
      },
    },
  });

  try {
    await engine.start();
    stdout.write(
      `Joined room [${roomKeys.roomIdPrefix}] as @${creds.user.username} (${peerId}). Downloads: ${cmd.downloadDir}\nType a message to chat, or /help for commands.\n`,
    );

    await new Promise<void>((resolveLoop) => {
      let closing = false;
      const finish = () => {
        if (closing) return;
        closing = true;
        rl.close();
        resolveLoop();
      };

      const onSignal = () => finish();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      io.abortSignal?.addEventListener("abort", onSignal, { once: true });

      if ("resume" in stdin && typeof stdin.resume === "function") {
        stdin.resume();
      }
      const rl = createInterface({
        input: stdin,
        terminal: false,
      });

      let lineQueue: Promise<void> = Promise.resolve();
      rl.on("line", (rawLine) => {
        lineQueue = lineQueue
          .then(async () => {
            if (closing) return;
            try {
              const action = await executeJoinInputLine({
                line: rawLine,
                engine,
                chunkStorage,
                sharedFiles,
                stdout,
              });
              if (action === "exit") {
                finish();
              }
            } catch (err) {
              stderr.write(
                `[command error] ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          })
          .catch(() => {});
      });

      rl.on("close", () => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        if (!cmd.passphraseStdin) {
          finish();
        }
      });
    });
  } finally {
    await engine.stop().catch(() => {});
    await sharedFiles.closeAll();
    await chunkStorage.closeAll();
    wipeRoomKeys(roomKeys);
    keyPair.privateKeyBytes.fill(0);
  }
}
