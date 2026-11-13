import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CliApiClient,
  CliSignalingClient,
  FsChunkStorageAdapter,
  WeriftTransportFactory,
} from "../apps/cli/src/index.ts";
import {
  createSimpleImServer,
  type SimpleImServerInstance,
} from "../apps/server/src/server.ts";
import {
  bytesToHex,
  deriveRoomKeys,
  sha256Bytes,
  wipeRoomKeys,
  type DerivedRoomKeys,
} from "../packages/crypto/src/index.ts";
import {
  createRoomPeerEngine,
  type RoomPeerEngine,
} from "../packages/peer-core/src/index.ts";

const WEB_DIST_DIR = resolve(import.meta.dir, "../apps/web/dist");

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

interface ProxyWsData {
  peerId: string;
  cookieHeader: string | null;
  authHeader: string | null;
  originHeader: string | null;
  backendWs: WebSocket | null;
  pendingOutbound: string[];
  closed: boolean;
}

interface ManagedCliPeer {
  peerId: string;
  username: string;
  sessionToken: string;
  roomKeys: DerivedRoomKeys;
  downloadDir: string;
  storage: FsChunkStorageAdapter;
  engine: RoomPeerEngine;
  completedFileIds: Set<string>;
  stop(): Promise<void>;
}

function createDeterministicBytes(byteLength: number, seedByte: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let x = (0x6d2b79f5 ^ (seedByte & 0xff)) >>> 0;
  for (let i = 0; i < byteLength; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (x + i * 17) & 0xff;
  }
  return out;
}

let tempRootDir: string | null = null;
let sqlitePath: string | null = null;
let apiServer: SimpleImServerInstance | null = null;
let edgeServer: Bun.Server<ProxyWsData> | null = null;
let stunSocket: Bun.udp.Socket<"buffer"> | null = null;
let centerStopped = false;
const activeEdgeSockets = new Set<Bun.ServerWebSocket<ProxyWsData>>();
const cliPeers = new Map<string, ManagedCliPeer>();
const serverLogLines: string[] = [];
const roomKeyCache = new Map<string, DerivedRoomKeys>();

function getOrDeriveCachedRoomKeys(passphrase: string): DerivedRoomKeys {
  let cached = roomKeyCache.get(passphrase);
  if (!cached) {
    cached = deriveRoomKeys(passphrase);
    roomKeyCache.set(passphrase, cached);
  }
  return {
    roomId: cached.roomId,
    roomIdPrefix: cached.roomIdPrefix,
    signalingKey: cached.signalingKey.slice(),
    roomAuthKey: cached.roomAuthKey.slice(),
    roomAppKey: cached.roomAppKey.slice(),
  };
}

async function serveStaticSpa(pathname: string): Promise<Response> {
  const cleanRel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = resolve(WEB_DIST_DIR, `.${cleanRel}`);
  if (candidate.startsWith(WEB_DIST_DIR) && existsSync(candidate)) {
    const st = await stat(candidate);
    if (st.isFile()) {
      const ext = extname(candidate).toLowerCase();
      return new Response(Bun.file(candidate), {
        status: 200,
        headers: {
          "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
        },
      });
    }
  }

  const indexHtml = join(WEB_DIST_DIR, "index.html");
  return new Response(Bun.file(indexHtml), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

async function startCluster(): Promise<{
  webOrigin: string;
  apiUrl: string;
  sqlitePath: string;
}> {
  if (!existsSync(join(WEB_DIST_DIR, "index.html"))) {
    throw new Error(
      `Missing built web bundle at ${WEB_DIST_DIR}. Run 'bun run build:web' first.`,
    );
  }

  await cleanupCluster();
  centerStopped = false;
  serverLogLines.length = 0;

  tempRootDir = await mkdtemp(join(tmpdir(), "simpleim-pw-e2e-"));
  sqlitePath = join(tempRootDir, "center.sqlite");

  edgeServer = Bun.serve<ProxyWsData>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws/v1/signaling") {
        if (centerStopped || !apiServer) {
          return new Response("Center signaling offline", { status: 502 });
        }
        const peerId = url.searchParams.get("peerId") ?? "";
        const upgraded = srv.upgrade(req, {
          data: {
            peerId,
            cookieHeader: req.headers.get("cookie"),
            authHeader: req.headers.get("authorization"),
            originHeader: req.headers.get("origin"),
            backendWs: null,
            pendingOutbound: [],
            closed: false,
          },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
        if (centerStopped || !apiServer) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "internal_error",
                message: "Center server stopped",
              },
            },
            { status: 502 },
          );
        }

        const targetUrl = `${apiServer.url}${url.pathname}${url.search}`;
        const forwardHeaders = new Headers();
        for (const name of [
          "accept",
          "content-type",
          "cookie",
          "authorization",
          "x-csrf-token",
          "origin",
          "x-correlation-id",
        ]) {
          const val = req.headers.get(name);
          if (val !== null) {
            forwardHeaders.set(name, val);
          }
        }

        const bodyBuf =
          req.method !== "GET" && req.method !== "HEAD"
            ? await req.arrayBuffer()
            : undefined;

        try {
          const upstreamRes = await fetch(targetUrl, {
            method: req.method,
            headers: forwardHeaders,
            ...(bodyBuf !== undefined ? { body: bodyBuf } : {}),
          });

          const outHeaders = new Headers();
          upstreamRes.headers.forEach((value, key) => {
            if (key.toLowerCase() !== "set-cookie") {
              outHeaders.set(key, value);
            }
          });
          for (const cookie of upstreamRes.headers.getSetCookie()) {
            outHeaders.append("set-cookie", cookie);
          }

          return new Response(await upstreamRes.arrayBuffer(), {
            status: upstreamRes.status,
            headers: outHeaders,
          });
        } catch {
          return Response.json(
            {
              ok: false,
              error: {
                code: "internal_error",
                message: "Upstream unreachable",
              },
            },
            { status: 502 },
          );
        }
      }

      return serveStaticSpa(url.pathname);
    },
    websocket: {
      open(clientWs) {
        activeEdgeSockets.add(clientWs);
        if (centerStopped || !apiServer) {
          clientWs.close(1012, "center_offline");
          return;
        }

        const headers: Record<string, string> = {};
        if (clientWs.data.cookieHeader) {
          headers.cookie = clientWs.data.cookieHeader;
        }
        if (clientWs.data.authHeader) {
          headers.authorization = clientWs.data.authHeader;
        }
        if (clientWs.data.originHeader) {
          headers.origin = clientWs.data.originHeader;
        }

        const targetWsUrl = `${apiServer.wsUrl}?peerId=${encodeURIComponent(clientWs.data.peerId)}`;
        const backendWs = new WebSocket(
          targetWsUrl,
          { headers } as unknown as string[],
        );
        backendWs.binaryType = "arraybuffer";
        clientWs.data.backendWs = backendWs;

        backendWs.onopen = () => {
          if (clientWs.data.closed) {
            backendWs.close();
            return;
          }
          while (clientWs.data.pendingOutbound.length > 0) {
            const msg = clientWs.data.pendingOutbound.shift();
            if (msg !== undefined) {
              backendWs.send(msg);
            }
          }
        };

        backendWs.onmessage = (ev) => {
          if (clientWs.data.closed) return;
          if (typeof ev.data === "string") {
            clientWs.send(ev.data);
          } else if (ev.data instanceof ArrayBuffer) {
            clientWs.send(new Uint8Array(ev.data));
          }
        };

        backendWs.onclose = (ev) => {
          if (!clientWs.data.closed) {
            clientWs.data.closed = true;
            try {
              clientWs.close(ev.code || 1000, ev.reason || "upstream_closed");
            } catch {
              // Ignore
            }
          }
        };

        backendWs.onerror = () => {
          // Handled in onclose
        };
      },
      message(clientWs, message) {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        const backend = clientWs.data.backendWs;
        if (backend && backend.readyState === WebSocket.OPEN) {
          backend.send(text);
        } else if (!clientWs.data.closed) {
          clientWs.data.pendingOutbound.push(text);
        }
      },
      close(clientWs) {
        activeEdgeSockets.delete(clientWs);
        clientWs.data.closed = true;
        const backend = clientWs.data.backendWs;
        clientWs.data.backendWs = null;
        if (
          backend &&
          (backend.readyState === WebSocket.OPEN ||
            backend.readyState === WebSocket.CONNECTING)
        ) {
          try {
            backend.close(1000, "client_closed");
          } catch {
            // Ignore
          }
        }
      },
    },
  });

  const webOrigin = `http://127.0.0.1:${edgeServer.port}`;

  // Ephemeral RFC 5389 UDP STUN responder on 127.0.0.1 so headless Chromium tabs
  // discover concrete IPv4 srflx candidates offline without mDNS multicast or public STUN.
  stunSocket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(sock, buf, remotePort, remoteAddr) {
        if (
          buf.byteLength < 20 ||
          buf[0] !== 0x00 ||
          buf[1] !== 0x01 ||
          buf[4] !== 0x21 ||
          buf[5] !== 0x12 ||
          buf[6] !== 0xa4 ||
          buf[7] !== 0x42
        ) {
          return;
        }
        const parts = remoteAddr.split(".").map((n) => Number.parseInt(n, 10));
        const ip =
          parts.length === 4 && parts.every((n) => Number.isInteger(n))
            ? parts
            : [127, 0, 0, 1];

        const res = new Uint8Array(32);
        res[0] = 0x01;
        res[1] = 0x01;
        res[2] = 0x00;
        res[3] = 0x0c;
        res[4] = 0x21;
        res[5] = 0x12;
        res[6] = 0xa4;
        res[7] = 0x42;
        res.set(buf.subarray(8, 20), 8);
        res[20] = 0x00;
        res[21] = 0x20;
        res[22] = 0x00;
        res[23] = 0x08;
        res[24] = 0x00;
        res[25] = 0x01;
        const xPort = remotePort ^ 0x2112;
        res[26] = (xPort >>> 8) & 0xff;
        res[27] = xPort & 0xff;
        res[28] = (ip[0]! ^ 0x21) & 0xff;
        res[29] = (ip[1]! ^ 0x12) & 0xff;
        res[30] = (ip[2]! ^ 0xa4) & 0xff;
        res[31] = (ip[3]! ^ 0x42) & 0xff;
        sock.send(res, remotePort, remoteAddr);
      },
    },
  });

  apiServer = createSimpleImServer({
    port: 0,
    host: "127.0.0.1",
    sqlitePath,
    allowedOrigins: [webOrigin],
    stunUrls: [`stun:127.0.0.1:${stunSocket.port}`],
    passwordHashMemoryCost: 4_096,
    passwordHashTimeCost: 1,
    logSink: (line) => serverLogLines.push(line),
  });

  return {
    webOrigin,
    apiUrl: apiServer.url,
    sqlitePath,
  };
}

async function spawnCliPeer(params: {
  username: string;
  displayName: string;
  password: string;
  passphrase: string;
}): Promise<{ peerId: string; username: string }> {
  if (!apiServer || !tempRootDir) {
    throw new Error("Cluster not started");
  }

  const api = new CliApiClient({ serverUrl: apiServer.url });
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

  const roomKeys = getOrDeriveCachedRoomKeys(params.passphrase);
  const downloadDir = join(tempRootDir, `cli-${params.username}`);

  const signaling = new CliSignalingClient({
    serverUrl: apiServer.url,
    sessionToken: reg.sessionToken,
    peerId: identity.peerId,
    initialReconnectDelayMs: 300,
    maxReconnectDelayMs: 1_500,
  });
  const transportFactory = new WeriftTransportFactory();
  const storage = new FsChunkStorageAdapter({ downloadDir });
  const completedFileIds = new Set<string>();

  const engine = createRoomPeerEngine({
    localPeerId: identity.peerId,
    localCert: identity.cert,
    localSignKeyPair: identity.keyPair,
    serverSignPubKey: meta.serverSignPubKey,
    roomKeys,
    iceServers: meta.iceServers,
    signaling,
    transportFactory,
    chunkStorage: storage,
    events: {
      onTransferCompleted: (manifest) => {
        completedFileIds.add(manifest.fileId);
      },
    },
  });

  await engine.start();

  let stopped = false;
  const managed: ManagedCliPeer = {
    peerId: identity.peerId,
    username: params.username,
    sessionToken: reg.sessionToken,
    roomKeys,
    downloadDir,
    storage,
    engine,
    completedFileIds,
    async stop() {
      if (stopped) return;
      stopped = true;
      await engine.stop();
      await storage.closeAll();
      wipeRoomKeys(roomKeys);
      identity.keyPair.privateKeyBytes.fill(0);
    },
  };

  cliPeers.set(identity.peerId, managed);
  return {
    peerId: identity.peerId,
    username: params.username,
  };
}

function getCliState(params: { peerId: string }) {
  const peer = cliPeers.get(params.peerId);
  if (!peer) {
    throw new Error(`Unknown CLI peerId: ${params.peerId}`);
  }
  return {
    centerConnected: peer.engine.isCenterConnected(),
    verifiedPeers: peer.engine.getVerifiedPeers(),
    messages: peer.engine.getMessages().map((m) => ({
      msgId: m.msgId,
      body: m.body,
      replyToMsgId: m.replyToMsgId,
      authorUsername: m.authorCert.payload.username,
      authorClientKind: m.authorCert.payload.clientKind,
    })),
    files: peer.engine.getFiles().map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      fileSize: f.fileSize,
      totalChunks: f.totalChunks,
      fileSha256: f.fileSha256,
    })),
    completedFileIds: Array.from(peer.completedFileIds),
  };
}

async function cliSendChat(params: {
  peerId: string;
  body: string;
  replyToMsgId?: string | null;
}) {
  const peer = cliPeers.get(params.peerId);
  if (!peer) {
    throw new Error(`Unknown CLI peerId: ${params.peerId}`);
  }
  const msg = await peer.engine.sendChatMessage(
    params.body,
    params.replyToMsgId ?? null,
  );
  return { msgId: msg.msgId };
}

async function cliShareFile(params: {
  peerId: string;
  fileName: string;
  sizeBytes: number;
  seedByte: number;
}) {
  const peer = cliPeers.get(params.peerId);
  if (!peer) {
    throw new Error(`Unknown CLI peerId: ${params.peerId}`);
  }
  const payload = createDeterministicBytes(params.sizeBytes, params.seedByte);
  const sha256 = bytesToHex(sha256Bytes(payload));

  const manifest = await peer.engine.shareFile({
    fileName: params.fileName,
    fileSize: payload.byteLength,
    mimeType: "application/octet-stream",
    readChunk: async (_chunkIndex, offset, length) =>
      payload.subarray(offset, offset + length),
  });

  return {
    fileId: manifest.fileId,
    fileName: manifest.fileName,
    fileSize: manifest.fileSize,
    totalChunks: manifest.totalChunks,
    sha256,
  };
}

async function cliDownloadFile(params: { peerId: string; fileId: string }) {
  const peer = cliPeers.get(params.peerId);
  if (!peer) {
    throw new Error(`Unknown CLI peerId: ${params.peerId}`);
  }
  await peer.engine.downloadFile(params.fileId);

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (peer.completedFileIds.has(params.fileId)) {
      const finalPath = peer.storage.getCompletedFilePath(params.fileId);
      if (!finalPath) {
        throw new Error("Completed file missing finalPath");
      }
      const diskBytes = new Uint8Array(await readFile(finalPath));
      return {
        finalPath,
        byteLength: diskBytes.byteLength,
        diskSha256: bytesToHex(sha256Bytes(diskBytes)),
      };
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`CLI download timed out for fileId=${params.fileId}`);
}

async function stopCenterServer(): Promise<{ stopped: true }> {
  centerStopped = true;
  for (const ws of Array.from(activeEdgeSockets)) {
    ws.data.closed = true;
    try {
      ws.close(1012, "server_shutdown");
    } catch {
      // Ignore
    }
  }
  activeEdgeSockets.clear();

  if (apiServer) {
    await apiServer.stop(true);
  }
  return { stopped: true };
}

function auditSqlite(params: { forbiddenStrings: string[] }) {
  if (!sqlitePath) {
    throw new Error("No sqlitePath initialized");
  }
  if (apiServer) {
    try {
      apiServer.sqliteDb.close(false);
    } catch {
      // Ignore
    }
  }

  const db = new Database(sqlitePath, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .all()
      .map((r) => r.name);

    const dump = [
      JSON.stringify(db.query("SELECT * FROM users").all()),
      JSON.stringify(db.query("SELECT * FROM sessions").all()),
      ...serverLogLines,
    ].join("\n");

    const leaked = params.forbiddenStrings.filter(
      (secret) => secret.length > 0 && dump.includes(secret),
    );

    return { tables, leaked };
  } finally {
    db.close(false);
  }
}

async function cleanupCluster(): Promise<void> {
  for (const peer of cliPeers.values()) {
    await peer.stop().catch(() => {});
  }
  cliPeers.clear();

  for (const cached of roomKeyCache.values()) {
    wipeRoomKeys(cached);
  }
  roomKeyCache.clear();

  for (const ws of Array.from(activeEdgeSockets)) {
    try {
      ws.close(1000, "cleanup");
    } catch {
      // Ignore
    }
  }
  activeEdgeSockets.clear();

  if (stunSocket) {
    try {
      stunSocket.close();
    } catch {
      // Ignore
    }
    stunSocket = null;
  }

  if (edgeServer) {
    await edgeServer.stop(true).catch(() => {});
    edgeServer = null;
  }

  if (apiServer) {
    await apiServer.stop(true).catch(() => {});
    try {
      apiServer.sqliteDb.close(false);
    } catch {
      // Ignore
    }
    apiServer = null;
  }

  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true }).catch(() => {});
    tempRootDir = null;
    sqlitePath = null;
  }
}

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function writeResponse(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: RpcRequest;
  try {
    req = JSON.parse(trimmed) as RpcRequest;
  } catch (err) {
    writeResponse({
      id: -1,
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON",
    });
    return;
  }

  try {
    let result: unknown;
    switch (req.method) {
      case "startCluster":
        result = await startCluster();
        break;
      case "spawnCliPeer":
        result = await spawnCliPeer(
          req.params as Parameters<typeof spawnCliPeer>[0],
        );
        break;
      case "getCliState":
        result = getCliState(req.params as Parameters<typeof getCliState>[0]);
        break;
      case "cliSendChat":
        result = await cliSendChat(
          req.params as Parameters<typeof cliSendChat>[0],
        );
        break;
      case "cliShareFile":
        result = await cliShareFile(
          req.params as Parameters<typeof cliShareFile>[0],
        );
        break;
      case "cliDownloadFile":
        result = await cliDownloadFile(
          req.params as Parameters<typeof cliDownloadFile>[0],
        );
        break;
      case "stopCenterServer":
        result = await stopCenterServer();
        break;
      case "auditSqlite":
        result = auditSqlite(req.params as Parameters<typeof auditSqlite>[0]);
        break;
      case "shutdown":
        await cleanupCluster();
        writeResponse({ id: req.id, ok: true, result: { closed: true } });
        process.exit(0);
        return;
      default:
        throw new Error(`Unknown RPC method: ${req.method}`);
    }
    writeResponse({ id: req.id, ok: true, result });
  } catch (err) {
    writeResponse({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

process.on("SIGTERM", () => {
  void cleanupCluster().finally(() => process.exit(0));
});
