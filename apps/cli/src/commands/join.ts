import { open, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { ChatMessageEnvelope, FileManifest } from "@simpleim/contracts";
import { deriveRoomKeys, wipeRoomKeys } from "@simpleim/crypto";
import {
  createRoomPeerEngine,
  type RoomPeerEngine,
  type SwarmTransferProgress,
} from "@simpleim/peer-core";
import { CliApiClient } from "../api-client.ts";
import type { ParsedCliCommand } from "../args.ts";
import { CredentialStore } from "../credentials.ts";
import { FsChunkStorageAdapter } from "../fs-chunk-storage.ts";
import { readPassphrase } from "../passphrase.ts";
import { CliSignalingClient } from "../signaling-client.ts";
import {
  formatCliFsError,
  formatCliRoomFingerprint,
  formatCliTimestamp,
  formatEtaSeconds,
  formatShortId,
  formatUniqueFileSelector,
  InteractiveJoinTerminal,
  parseCliFilePathInput,
} from "../terminal-io.ts";
import {
  formatCliChatMessage,
  sanitizeTerminalSingleLine,
} from "../terminal-sanitize.ts";
import { WeriftTransportFactory } from "../werift-transport.ts";
import {
  requireValidCredentials,
  withNetworkServerHint,
  type CommandIo,
} from "./auth.ts";

export function formatHumanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
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
    "  /peers                       List verified room peers and signaling state",
    "  /send <filepath>             Share a local file (supports ~, quotes, escaped spaces)",
    "  /files                       List announced files and transfer/relay status",
    "  /get <fileId|index>          Download or resume an announced file into download dir",
    "  /cancel <fileId|index>       Cancel an in-progress download",
    "  /reply <msgId|last> <text>   Reply quoting an earlier message",
    "  /retry                       Retry pending offline-relay chat messages",
    "  /help                        Show this command reference",
    "  /leave, /quit                Disconnect from room and wipe keys",
  ].join("\n");
}

function resolveTargetManifest(
  files: readonly FileManifest[],
  selector: string,
): FileManifest {
  const trimmed = selector.trim();
  // Short 1-based list index (no leading zero, <= 4 digits) resolves directly by position;
  // 8-char numeric-only UUIDv7 tails (e.g. "00000001" or "12345678") fall through to ID matching.
  if (/^[1-9]\d{0,3}$/.test(trimmed)) {
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

  const idMatches = files.filter(
    (f) => f.fileId.startsWith(trimmed) || f.fileId.endsWith(trimmed),
  );
  if (idMatches.length === 1 && idMatches[0]) {
    return idMatches[0];
  }
  if (idMatches.length > 1) {
    throw new Error(
      `Ambiguous fileId '${sanitizeTerminalSingleLine(trimmed)}'; run /files for unique IDs or indices`,
    );
  }
  throw new Error(
    `Unknown file '${sanitizeTerminalSingleLine(trimmed)}'; run /files to list available files`,
  );
}

function resolveTargetMessage(
  messages: readonly ChatMessageEnvelope[],
  selector: string,
): ChatMessageEnvelope {
  const trimmed = selector.trim();
  if (messages.length === 0) {
    throw new Error("No messages in this room to reply to yet.");
  }
  if (trimmed.toLowerCase() === "last") {
    return messages[messages.length - 1]!;
  }
  const cleanSelector = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const exact = messages.find((m) => m.msgId === cleanSelector);
  if (exact) return exact;
  const matches = messages.filter(
    (m) => m.msgId.startsWith(cleanSelector) || m.msgId.endsWith(cleanSelector),
  );
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous message ID '${sanitizeTerminalSingleLine(trimmed)}'`,
    );
  }
  throw new Error(
    `Unknown message '${sanitizeTerminalSingleLine(trimmed)}' (use a msgId prefix/suffix or 'last')`,
  );
}

export function formatCliReplyQuote(
  replyToMsgId: string | null | undefined,
  messages: readonly ChatMessageEnvelope[],
): string | null {
  if (!replyToMsgId) {
    return null;
  }
  const target = messages.find((m) => m.msgId === replyToMsgId);
  if (!target) {
    return `  ↳ replying to #${formatShortId(replyToMsgId, 8)}`;
  }
  const author = sanitizeTerminalSingleLine(target.authorCert.payload.username);
  const snippet = sanitizeTerminalSingleLine(target.body);
  const clipped =
    snippet.length > 72 ? `${snippet.slice(0, 71)}…` : snippet;
  return `  ↳ replying to @${author}: ${clipped}`;
}

export function formatRenderedChatEvent(params: {
  readonly msg: ChatMessageEnvelope;
  readonly isSync?: boolean;
  readonly messages: readonly ChatMessageEnvelope[];
  readonly nowMs?: number;
}): string {
  const quoteLine = formatCliReplyQuote(params.msg.replyToMsgId, params.messages);
  const chatLine = formatCliChatMessage({
    prefix: params.isSync ? "[sync] " : "",
    clock: formatCliTimestamp(params.msg.createdAt, params.nowMs),
    username: params.msg.authorCert.payload.username,
    body: params.msg.body,
  });
  return quoteLine ? `${quoteLine}\n${chatLine}` : chatLine;
}

interface TransferProgressSnapshot {
  status: SwarmTransferProgress["status"];
  downloadPct: number;
  downloadEmitAt: number;
  relayState: NonNullable<SwarmTransferProgress["relayCacheState"]>;
  relayPct: number;
  relayEmitAt: number;
}

/**
 * Throttles verbose SwarmTransferProgress updates into concise human-readable
 * status lines (download percentage, speed, ETA, pause, error, and relay caching).
 */
export class JoinTransferProgressTracker {
  private readonly states = new Map<string, TransferProgressSnapshot>();

  consume(
    progress: SwarmTransferProgress,
    nowMs: number = Date.now(),
    allFileIds: readonly string[] = [],
  ): string[] {
    const lines: string[] = [];
    const safeName = sanitizeTerminalSingleLine(progress.fileName);
    const shortId = formatUniqueFileSelector(progress.fileId, allFileIds, 8);
    const prev = this.states.get(progress.fileId);

    const downloadPct =
      progress.totalChunks === 0
        ? 100
        : Math.min(
            100,
            Math.floor((progress.completedChunks / progress.totalChunks) * 100),
          );
    const relayState = progress.relayCacheState ?? "none";
    const relayPct =
      progress.totalChunks === 0
        ? 100
        : Math.min(
            100,
            Math.floor(
              ((progress.relayCachedChunks ?? 0) / progress.totalChunks) * 100,
            ),
          );

    const next: TransferProgressSnapshot = prev
      ? { ...prev }
      : {
          status: "announced",
          downloadPct: -1,
          downloadEmitAt: 0,
          relayState: "none",
          relayPct: -1,
          relayEmitAt: 0,
        };

    // 1. Download lifecycle feedback
    if (progress.status === "downloading") {
      const statusChanged = prev?.status !== "downloading";
      const pctJump = downloadPct - next.downloadPct >= 10;
      const timeElapsed = nowMs - next.downloadEmitAt >= 500;
      const heartbeatElapsed =
        nowMs - next.downloadEmitAt >= 2000 && downloadPct !== next.downloadPct;
      if (
        (statusChanged && progress.completedChunks > 0) ||
        (pctJump && timeElapsed) ||
        heartbeatElapsed
      ) {
        const speedBytes = Math.max(0, progress.downloadSpeedBytesPerSec);
        const remainingBytes = Math.max(
          0,
          progress.fileSize - progress.bytesCompleted,
        );
        const etaStr =
          speedBytes > 0
            ? formatEtaSeconds(remainingBytes / speedBytes)
            : "--";
        const speedStr = `${formatHumanBytes(Math.round(speedBytes))}/s`;
        const peerCount = Math.max(
          progress.availableSeeders,
          progress.availablePeersWithChunks,
        );
        lines.push(
          `[file] Downloading '${safeName}' ${downloadPct}% (${formatHumanBytes(progress.bytesCompleted)} / ${formatHumanBytes(progress.fileSize)}, ${speedStr}, ETA ${etaStr}) [peers: ${peerCount}]`,
        );
        next.downloadPct = downloadPct;
        next.downloadEmitAt = nowMs;
      }
      next.status = "downloading";
    } else if (progress.status === "paused" && prev?.status !== "paused") {
      lines.push(
        `[file] Paused '${safeName}' at ${downloadPct}% — run '/get ${shortId}' to resume`,
      );
      next.status = "paused";
      next.downloadPct = downloadPct;
      next.downloadEmitAt = nowMs;
    } else if (progress.status === "error" && prev?.status !== "error") {
      const reason = sanitizeTerminalSingleLine(
        progress.errorMessage ?? "transfer failed",
      );
      lines.push(`[file] Transfer failed for '${safeName}': ${reason}`);
      next.status = "error";
      next.downloadEmitAt = nowMs;
    } else {
      next.status = progress.status;
    }

    // 2. Blind relay upload feedback (especially after /send)
    if (relayState === "uploading") {
      const stateChanged = next.relayState !== "uploading";
      const pctJump = relayPct - next.relayPct >= 25;
      const timeElapsed = nowMs - next.relayEmitAt >= 500;
      if (stateChanged || (pctJump && timeElapsed)) {
        lines.push(
          `[relay] Caching '${safeName}' ${relayPct}% (${progress.relayCachedChunks ?? 0}/${progress.totalChunks} chunks)`,
        );
        next.relayPct = relayPct;
        next.relayEmitAt = nowMs;
      }
    } else if (relayState === "cached" && next.relayState !== "cached") {
      if (prev?.relayState === "uploading") {
        lines.push(`[relay] Cached '${safeName}' for offline peers`);
      }
      next.relayPct = 100;
      next.relayEmitAt = nowMs;
    } else if (relayState === "too_large" && next.relayState !== "too_large") {
      lines.push(
        `[relay] '${safeName}' exceeds offline relay limit (direct P2P seeding remains active)`,
      );
      next.relayEmitAt = nowMs;
    } else if (relayState === "error" && next.relayState !== "error") {
      lines.push(
        `[relay] Offline relay cache failed for '${safeName}' (direct P2P seeding remains active)`,
      );
      next.relayEmitAt = nowMs;
    }
    next.relayState = relayState;

    this.states.set(progress.fileId, next);
    return lines;
  }
}

export async function executeJoinInputLine(params: {
  line: string;
  engine: RoomPeerEngine;
  chunkStorage: FsChunkStorageAdapter;
  sharedFiles: LocalSharedFileRegistry;
  stdout: NodeJS.WritableStream;
  cwd?: string;
  homeDir?: string;
  json?: boolean;
  nowMs?: number;
  onBeforeSelfChatPrint?: () => void;
}): Promise<"continue" | "exit"> {
  const { line, engine, chunkStorage, sharedFiles, stdout, json = false } = params;
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return "continue";
  }

  const emitJson = (payload: Record<string, unknown>): void => {
    stdout.write(`${JSON.stringify(payload)}\n`);
  };

  if (!trimmed.startsWith("/")) {
    const sent = await engine.sendChatMessage(trimmed);
    if (json) {
      emitJson({
        type: "chat_sent",
        msgId: sent.msgId,
        lamport: sent.lamport,
        createdAt: sent.createdAt,
        replyToMsgId: sent.replyToMsgId ?? null,
        author: {
          userId: sent.authorCert.payload.userId,
          username: sent.authorCert.payload.username,
          displayName: sent.authorCert.payload.displayName,
          clientKind: sent.authorCert.payload.clientKind,
        },
        body: sent.body,
      });
    } else {
      params.onBeforeSelfChatPrint?.();
      stdout.write(
        `${formatRenderedChatEvent({
          msg: sent,
          messages: engine.getMessages(),
          nowMs: params.nowMs,
        })}\n`,
      );
    }
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
      if (json) {
        emitJson({ type: "help", text: formatJoinSlashHelp() });
      } else {
        stdout.write(`${formatJoinSlashHelp()}\n`);
      }
      return "continue";

    case "/peers": {
      const connected = engine.isCenterConnected();
      const peers = engine.getVerifiedPeers();
      if (json) {
        emitJson({
          type: "peers_snapshot",
          centerConnected: connected,
          peers: peers.map((p) => ({
            peerId: p.peerId,
            userId: p.userId,
            username: p.username,
            displayName: p.displayName,
            clientKind: p.clientKind,
            rttMs: p.rttMs,
          })),
        });
        return "continue";
      }
      const centerStatus = connected
        ? "connected"
        : "detached (P2P channels active)";
      stdout.write(`Signaling server: ${centerStatus}\n`);
      if (peers.length === 0) {
        stdout.write("Verified P2P peers: (none)\n");
      } else {
        stdout.write(`Verified P2P peers (${peers.length}):\n`);
        for (const p of peers) {
          const rttLabel = p.rttMs !== null ? `${p.rttMs}ms` : "n/a";
          stdout.write(
            `  - @${sanitizeTerminalSingleLine(p.username)} (${sanitizeTerminalSingleLine(p.displayName)}) [${sanitizeTerminalSingleLine(p.clientKind)}] ${formatShortId(p.peerId, 8)} rtt=${rttLabel}\n`,
          );
        }
      }
      return "continue";
    }

    case "/send": {
      if (!rest) {
        if (json) {
          emitJson({ type: "error", message: "Usage: /send <filepath>" });
        } else {
          stdout.write("Usage: /send <filepath>\n");
        }
        return "continue";
      }
      const unquoted = parseCliFilePathInput(rest, params.homeDir);
      const targetPath = resolve(params.cwd ?? process.cwd(), unquoted);
      let st;
      try {
        st = await stat(targetPath);
      } catch (err) {
        throw new Error(formatCliFsError(err, targetPath));
      }
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
      if (json) {
        emitJson({
          type: "file_shared",
          fileId: manifest.fileId,
          fileName: manifest.fileName,
          fileSize: manifest.fileSize,
          totalChunks: manifest.totalChunks,
          mimeType: manifest.mimeType,
        });
      } else {
        const allIds = engine.getFiles().map((f) => f.fileId);
        stdout.write(
          `[file] Announced '${sanitizeTerminalSingleLine(manifest.fileName)}' (${formatHumanBytes(manifest.fileSize)}, ${manifest.totalChunks} chunks) id=${formatUniqueFileSelector(manifest.fileId, allIds, 8)}\n`,
        );
      }
      return "continue";
    }

    case "/files": {
      const files = engine.getFiles();
      if (json) {
        emitJson({
          type: "files_snapshot",
          files: files.map((f, i) => {
            const prog = engine.getTransferProgress(f.fileId);
            return {
              index: i + 1,
              fileId: f.fileId,
              fileName: f.fileName,
              fileSize: f.fileSize,
              totalChunks: f.totalChunks,
              senderUsername: f.senderCert.payload.username,
              status: prog?.status ?? "announced",
              completedChunks: prog?.completedChunks ?? 0,
              relayCacheState: prog?.relayCacheState ?? "none",
              savedPath: chunkStorage.getCompletedFilePath(f.fileId) ?? null,
            };
          }),
        });
        return "continue";
      }
      if (files.length === 0) {
        stdout.write("No files announced in this room yet.\n");
        return "continue";
      }
      const allIds = files.map((f) => f.fileId);
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
        const relaySuffix =
          prog?.relayCacheState && prog.relayCacheState !== "none"
            ? prog.relayCacheState === "uploading"
              ? ` [relay:uploading ${f.totalChunks === 0 ? 100 : Math.floor(((prog.relayCachedChunks ?? 0) / f.totalChunks) * 100)}%]`
              : ` [relay:${prog.relayCacheState}]`
            : "";
        const savedPath = chunkStorage.getCompletedFilePath(f.fileId);
        const savedSuffix = savedPath
          ? ` -> ${sanitizeTerminalSingleLine(savedPath)}`
          : "";
        stdout.write(
          `  [${i + 1}] ${formatUniqueFileSelector(f.fileId, allIds, 8)}  ${sanitizeTerminalSingleLine(f.fileName)} (${formatHumanBytes(f.fileSize)}) from @${sanitizeTerminalSingleLine(f.senderCert.payload.username)} [${status}]${relaySuffix}${savedSuffix}\n`,
        );
      });
      return "continue";
    }

    case "/get": {
      if (!rest) {
        if (json) {
          emitJson({ type: "error", message: "Usage: /get <fileId|index>" });
        } else {
          stdout.write("Usage: /get <fileId|index>\n");
        }
        return "continue";
      }
      const target = resolveTargetManifest(engine.getFiles(), rest);
      if (json) {
        emitJson({
          type: "download_started",
          fileId: target.fileId,
          fileName: target.fileName,
          fileSize: target.fileSize,
        });
      } else {
        stdout.write(
          `[file] Starting Swarm download for '${sanitizeTerminalSingleLine(target.fileName)}' (${formatHumanBytes(target.fileSize)})...\n`,
        );
      }
      await engine.downloadFile(target.fileId);
      return "continue";
    }

    case "/cancel": {
      if (!rest) {
        if (json) {
          emitJson({ type: "error", message: "Usage: /cancel <fileId|index>" });
        } else {
          stdout.write("Usage: /cancel <fileId|index>\n");
        }
        return "continue";
      }
      const target = resolveTargetManifest(engine.getFiles(), rest);
      const progress = engine.getTransferProgress(target.fileId);
      if (progress?.status !== "downloading") {
        const status = progress?.status ?? "announced";
        const safeName = sanitizeTerminalSingleLine(target.fileName);
        const msg =
          status === "seeding"
            ? `Cannot cancel '${safeName}': file is already completed/seeding`
            : `No active download for '${safeName}' (status: ${status})`;
        if (json) {
          emitJson({
            type: "error",
            fileId: target.fileId,
            status,
            message: msg,
          });
        } else {
          stdout.write(`[file] ${msg}\n`);
        }
        return "continue";
      }
      await engine.cancelDownload(target.fileId);
      if (json) {
        emitJson({
          type: "download_cancelled",
          fileId: target.fileId,
          fileName: target.fileName,
        });
      } else {
        const allIds = engine.getFiles().map((f) => f.fileId);
        stdout.write(
          `[file] Cancelled download for '${sanitizeTerminalSingleLine(target.fileName)}' (id=${formatUniqueFileSelector(target.fileId, allIds, 8)})\n`,
        );
      }
      return "continue";
    }

    case "/reply": {
      const replySpace = rest.indexOf(" ");
      if (replySpace < 0) {
        if (json) {
          emitJson({
            type: "error",
            message: "Usage: /reply <msgId|last> <message>",
          });
        } else {
          stdout.write("Usage: /reply <msgId|last> <message>\n");
        }
        return "continue";
      }
      const targetSelector = rest.slice(0, replySpace).trim();
      const replyBody = rest.slice(replySpace + 1).trim();
      if (!targetSelector || !replyBody) {
        if (json) {
          emitJson({
            type: "error",
            message: "Usage: /reply <msgId|last> <message>",
          });
        } else {
          stdout.write("Usage: /reply <msgId|last> <message>\n");
        }
        return "continue";
      }
      const targetMsg = resolveTargetMessage(engine.getMessages(), targetSelector);
      const sent = await engine.sendChatMessage(replyBody, targetMsg.msgId);
      if (json) {
        emitJson({
          type: "chat_sent",
          msgId: sent.msgId,
          lamport: sent.lamport,
          createdAt: sent.createdAt,
          replyToMsgId: sent.replyToMsgId ?? null,
          author: {
            userId: sent.authorCert.payload.userId,
            username: sent.authorCert.payload.username,
            displayName: sent.authorCert.payload.displayName,
            clientKind: sent.authorCert.payload.clientKind,
          },
          body: sent.body,
        });
      } else {
        params.onBeforeSelfChatPrint?.();
        stdout.write(
          `${formatRenderedChatEvent({
            msg: sent,
            messages: engine.getMessages(),
            nowMs: params.nowMs,
          })}\n`,
        );
      }
      return "continue";
    }

    case "/retry": {
      await engine.retryChatMessage();
      if (json) {
        emitJson({ type: "chat_retry_requested" });
      } else {
        stdout.write("[delivery] Retrying pending offline-relay messages...\n");
      }
      return "continue";
    }

    default:
      if (json) {
        emitJson({
          type: "error",
          message: `Unknown slash command '${sanitizeTerminalSingleLine(verb)}'`,
        });
      } else {
        stdout.write(
          `Unknown slash command '${sanitizeTerminalSingleLine(verb)}'. Type /help for commands.\n`,
        );
      }
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

  if (!cmd.json) {
    stderr.write("Deriving E2EE room keys (Argon2id 64 MiB)...\n");
  }
  const roomKeys = deriveRoomKeys(passphrase);

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
    wipeRoomKeys(roomKeys);
    throw withNetworkServerHint(err, api.serverUrl);
  }
  const { peerId, keyPair, cert } = identity;

  let terminal: InteractiveJoinTerminal | null = null;
  const writeAsync = (
    text: string,
    target: "stdout" | "stderr" = "stdout",
  ): void => {
    if (terminal) {
      terminal.writeAsyncLine(text, target);
    } else {
      (target === "stderr" ? stderr : stdout).write(`${text}\n`);
    }
  };
  const writeJsonEvent = (event: Record<string, unknown>): void => {
    stdout.write(`${JSON.stringify(event)}\n`);
  };

  const progressTracker = new JoinTransferProgressTracker();

  const signaling = new CliSignalingClient({
    serverUrl: api.serverUrl,
    sessionToken: creds.sessionToken,
    peerId,
    maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
  });
  const transportFactory = new WeriftTransportFactory({
    onNetworkDiagnostic: (diag) => {
      if (cmd.json) {
        writeJsonEvent({
          type: "network_diagnostic",
          code: diag.code,
          message: diag.message,
        });
      } else {
        writeAsync(
          `[network] ${sanitizeTerminalSingleLine(diag.message)}`,
          "stderr",
        );
      }
    },
  });
  const chunkStorage = new FsChunkStorageAdapter({
    downloadDir: cmd.downloadDir,
  });
  const relayClient = api.createBlindRelayClient(
    creds.sessionToken,
    meta.relay,
  );
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
    relayClient,
    events: {
      onCenterConnectionChange: (connected) => {
        if (cmd.json) {
          writeJsonEvent({ type: "signal", connected });
          return;
        }
        const palette = terminal?.palette;
        const msg = connected
          ? "[signal] Connected to signaling relay"
          : "[signal] Signaling relay disconnected (active P2P channels remain alive)";
        writeAsync(
          palette
            ? connected
              ? palette.green(msg)
              : palette.yellow(msg)
            : msg,
        );
      },
      onPeersChange: (peers) => {
        if (cmd.json) {
          writeJsonEvent({
            type: "peers",
            peers: peers.map((p) => ({
              peerId: p.peerId,
              userId: p.userId,
              username: p.username,
              displayName: p.displayName,
              clientKind: p.clientKind,
              rttMs: p.rttMs,
            })),
          });
          return;
        }
        const names = peers
          .map((p) => `@${sanitizeTerminalSingleLine(p.username)}`)
          .join(", ");
        writeAsync(`[room] Verified peers (${peers.length}): ${names || "none"}`);
      },
      onPeerAuthRejected: (remotePeerId, reason) => {
        if (cmd.json) {
          writeJsonEvent({
            type: "peer_auth_rejected",
            remotePeerId,
            reason,
          });
          return;
        }
        writeAsync(
          `[security] Quarantined peer ${formatShortId(remotePeerId, 8)} rejected (${sanitizeTerminalSingleLine(reason)})`,
          "stderr",
        );
      },
      onChatMessage: (msg, isSync) => {
        if (cmd.json) {
          writeJsonEvent({
            type: "chat",
            msgId: msg.msgId,
            lamport: msg.lamport,
            createdAt: msg.createdAt,
            isSync,
            replyToMsgId: msg.replyToMsgId ?? null,
            author: {
              userId: msg.authorCert.payload.userId,
              username: msg.authorCert.payload.username,
              displayName: msg.authorCert.payload.displayName,
              clientKind: msg.authorCert.payload.clientKind,
            },
            body: msg.body,
          });
          return;
        }
        writeAsync(
          formatRenderedChatEvent({
            msg,
            isSync,
            messages: engine.getMessages(),
          }),
        );
      },
      onChatDeliveryChange: (msgId, status) => {
        if (cmd.json) {
          writeJsonEvent({ type: "chat_delivery", msgId, status });
          return;
        }
        if (status === "failed") {
          const msg = `[delivery] Offline relay failed for message #${formatShortId(msgId, 8)} — run /retry`;
          writeAsync(terminal ? terminal.palette.yellow(msg) : msg, "stderr");
        }
      },
      onFileAnnounced: (manifest) => {
        if (manifest.senderCert.payload.peerId === peerId) return;
        if (cmd.json) {
          writeJsonEvent({
            type: "file_announced",
            fileId: manifest.fileId,
            fileName: manifest.fileName,
            fileSize: manifest.fileSize,
            totalChunks: manifest.totalChunks,
            mimeType: manifest.mimeType,
            senderUsername: manifest.senderCert.payload.username,
          });
          return;
        }
        const allIds = engine.getFiles().map((f) => f.fileId);
        const selector = formatUniqueFileSelector(manifest.fileId, allIds, 8);
        writeAsync(
          `[file] @${sanitizeTerminalSingleLine(manifest.senderCert.payload.username)} shared '${sanitizeTerminalSingleLine(manifest.fileName)}' (${formatHumanBytes(manifest.fileSize)}) — run '/get ${selector}' or '/files'`,
        );
      },
      onTransferProgress: (progress) => {
        if (cmd.json) {
          const remaining = Math.max(
            0,
            progress.fileSize - progress.bytesCompleted,
          );
          const etaSeconds =
            progress.downloadSpeedBytesPerSec > 0
              ? Math.ceil(remaining / progress.downloadSpeedBytesPerSec)
              : null;
          writeJsonEvent({
            type: "transfer_progress",
            fileId: progress.fileId,
            fileName: progress.fileName,
            status: progress.status,
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks,
            bytesCompleted: progress.bytesCompleted,
            fileSize: progress.fileSize,
            downloadSpeedBytesPerSec: progress.downloadSpeedBytesPerSec,
            etaSeconds,
            relayCacheState: progress.relayCacheState ?? "none",
            relayCachedChunks: progress.relayCachedChunks ?? 0,
            ...(progress.errorMessage
              ? { errorMessage: progress.errorMessage }
              : {}),
          });
          return;
        }
        const updates = progressTracker.consume(
          progress,
          Date.now(),
          engine.getFiles().map((f) => f.fileId),
        );
        for (const line of updates) {
          writeAsync(line);
        }
      },
      onTransferCompleted: (manifest) => {
        const finalPath = chunkStorage.getCompletedFilePath(manifest.fileId);
        if (cmd.json) {
          writeJsonEvent({
            type: "transfer_completed",
            fileId: manifest.fileId,
            fileName: manifest.fileName,
            savedPath: finalPath ?? cmd.downloadDir,
          });
          return;
        }
        writeAsync(
          `[file] Completed '${sanitizeTerminalSingleLine(manifest.fileName)}' -> ${sanitizeTerminalSingleLine(finalPath ?? cmd.downloadDir)} (seeding)`,
        );
      },
      onError: (err) => {
        if (cmd.json) {
          writeJsonEvent({ type: "error", message: err.message });
          return;
        }
        const msg = `[error] ${sanitizeTerminalSingleLine(err.message)}`;
        writeAsync(terminal ? terminal.palette.red(msg) : msg, "stderr");
      },
    },
  });

  try {
    await engine.start();
    const fingerprint = formatCliRoomFingerprint(roomKeys.roomIdPrefix);

    if (cmd.json) {
      writeJsonEvent({
        type: "joined",
        roomIdPrefix: roomKeys.roomIdPrefix,
        fingerprint,
        peerId,
        username: creds.user.username,
        displayName: creds.user.displayName,
        downloadDir: cmd.downloadDir,
      });
    } else {
      stdout.write(
        `Joined room ${fingerprint} as @${sanitizeTerminalSingleLine(creds.user.username)} (${sanitizeTerminalSingleLine(creds.user.displayName)}, ${formatShortId(peerId, 8)}). Downloads: ${cmd.downloadDir}\nType a message to chat, or /help for commands.\n`,
      );
    }

    await new Promise<void>((resolveLoop) => {
      let closing = false;
      const onSignal = () => finish();
      const finish = () => {
        if (closing) return;
        closing = true;
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        io.abortSignal?.removeEventListener("abort", onSignal);
        terminal?.close();
        resolveLoop();
      };

      if (io.abortSignal?.aborted) {
        finish();
        return;
      }

      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      io.abortSignal?.addEventListener("abort", onSignal, { once: true });

      terminal = new InteractiveJoinTerminal({
        stdin,
        stdout,
        stderr,
        jsonMode: cmd.json,
        env: io.env,
        getFiles: () => engine.getFiles(),
        onLine: async (rawLine) =>
          executeJoinInputLine({
            line: rawLine,
            engine,
            chunkStorage,
            sharedFiles,
            stdout: terminal ? terminal.createCommandOutputStream("stdout") : stdout,
            json: cmd.json,
            onBeforeSelfChatPrint: () => {
              terminal?.eraseJustSubmittedSingleLineEcho(rawLine);
            },
          }),
        onLineError: (err) => {
          const message = sanitizeTerminalSingleLine(
            err instanceof Error ? err.message : String(err),
          );
          if (cmd.json) {
            writeJsonEvent({ type: "error", message });
          } else if (terminal) {
            terminal.writeLine(`[command error] ${message}`, "stderr");
          } else {
            stderr.write(`[command error] ${message}\n`);
          }
        },
        onExit: () => finish(),
        onInputEof: () => {
          if (closing) return;
          if (!cmd.passphraseStdin) {
            finish();
          } else if (!cmd.json) {
            stderr.write(
              "[info] stdin closed (--passphrase-stdin mode); staying connected to room. Press Ctrl+C to leave.\n",
            );
          }
        },
      });
      terminal.startPrompt();
    });
  } finally {
    await engine.stop().catch(() => {});
    await sharedFiles.closeAll();
    await chunkStorage.closeAll();
    wipeRoomKeys(roomKeys);
    keyPair.privateKeyBytes.fill(0);
  }
}
