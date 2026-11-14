import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CONTROL_CHANNEL_ID,
  CONTROL_CHANNEL_LABEL,
  countChunksInBitfield,
  decodeSwarmFrame,
  encodeSwarmFrame,
  hasChunkInBitfield,
  parseClientSignalingFrame,
  SWARM_CHANNEL_ID,
  SWARM_CHANNEL_LABEL,
  SWARM_CHUNK_SIZE,
  SwarmFrameType,
  type ChatMessageEnvelope,
  type ClientSignalingFrame,
  type FileManifest,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import {
  createSignedFileManifestFromChunks,
  generateEd25519KeyPair,
  generatePrefixedId,
  generateUuidV7,
  issuePeerIdentityCert,
  randomBytes,
  sha256Hex,
  signChatMessage,
  verifyPopRequest,
} from "@simpleim/crypto";
import type { DataChannelPort, RoomPeerEngine } from "@simpleim/peer-core";
import {
  CliApiClient,
  CliApiError,
  CliSecurityError,
  CliSignalingClient,
  CliUsageError,
  CredentialStore,
  executeJoinInputLine,
  FsChunkStorageAdapter,
  isMdnsIceCandidate,
  LocalSharedFileRegistry,
  parseCliArgs,
  probeNetworkInterfaces,
  readPassphrase,
  readVisiblePrompt,
  runCli,
  SeedQuotaController,
  StorageQuotaExceededError,
  stripMdnsCandidatesFromSdp,
  StructuredLogger,
  WeriftTransportFactory,
  type WeriftNetworkDiagnostic,
} from "../src/main.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `simpleim-cli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

function createSignedManifestFixture(params: {
  roomId: string;
  fileName: string;
  bytes: Uint8Array;
  fileId?: string;
}): Promise<FileManifest> {
  const serverKeys = generateEd25519KeyPair();
  const peerKeys = generateEd25519KeyPair();
  const peerId = generatePrefixedId("peer");
  const userId = generatePrefixedId("usr");
  const cert = issuePeerIdentityCert({
    serverKeyId: "srvk_test_01",
    serverSignPrivKey: serverKeys.privateKeyBytes,
    userId,
    username: "alice",
    displayName: "Alice",
    peerId,
    peerSignPubKey: peerKeys.publicKeyBase64Url,
    clientKind: "cli",
  });

  return createSignedFileManifestFromChunks({
    roomId: params.roomId,
    fileName: params.fileName,
    fileSize: params.bytes.byteLength,
    mimeType: "application/octet-stream",
    fileId: params.fileId,
    senderCert: cert,
    peerSignPrivKey: peerKeys.privateKeyBytes,
    readChunk: async (_idx, offset, length) =>
      params.bytes.subarray(offset, offset + length),
  });
}

function waitForChannelOpen(dc: DataChannelPort, timeoutMs = 10_000): Promise<void> {
  if (dc.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for DataChannel '${dc.label}' to open`));
    }, timeoutMs);
    dc.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("CLI Argument Parser & Security Guards", () => {
  test("rejects plaintext --passphrase and -p flags with CliSecurityError", () => {
    const forbiddenInvocations = [
      ["join", "--passphrase", "correct-horse-battery-staple"],
      ["join", "--passphrase=correct-horse-battery-staple"],
      ["seed", "-p", "secret-room"],
      ["seed", "-p=secret-room"],
      ["join", "--room-passphrase=secret-room"],
      ["login", "--username", "alice", "--password", "hunter222"],
      ["register", "--password=hunter222"],
    ];

    for (const argv of forbiddenInvocations) {
      let caught: unknown;
      try {
        parseCliArgs(argv, "/tmp/work");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliSecurityError);
      expect((caught as Error).message).toContain("process tables");
    }
  });

  test("runCli returns exit code 2 on --passphrase without echoing secret value", async () => {
    let errText = "";
    const stderr = new PassThrough();
    stderr.on("data", (c) => {
      errText += c.toString("utf8");
    });

    const code = await runCli(["join", "--passphrase", "TOP_SECRET_DO_NOT_LOG"], {
      stderr,
    });
    expect(code).toBe(2);
    expect(errText).toContain("--passphrase-stdin");
    expect(errText).not.toContain("TOP_SECRET_DO_NOT_LOG");
  });

  test("parses register, login, logout, whoami, join, and seed flags cleanly", () => {
    const reg = parseCliArgs(
      [
        "register",
        "--server",
        "https://im.example.com",
        "--username",
        "alice_01",
        "--display-name",
        "Alice Wonder",
        "--config-dir",
        "/tmp/cfg",
      ],
      "/workspace",
    );
    expect(reg).toEqual({
      command: "register",
      serverUrl: "https://im.example.com",
      configDir: "/tmp/cfg",
      username: "alice_01",
      displayName: "Alice Wonder",
      passwordStdin: false,
      json: false,
    });

    const login = parseCliArgs(
      ["login", "--server=http://127.0.0.1:4000", "-u", "bob", "--json"],
      "/workspace",
    );
    expect(login).toEqual({
      command: "login",
      serverUrl: "http://127.0.0.1:4000",
      username: "bob",
      passwordStdin: false,
      json: true,
    });

    const joinCmd = parseCliArgs(
      ["join", "--download-dir", "my-downloads", "--passphrase-stdin"],
      "/workspace",
    );
    expect(joinCmd).toEqual({
      command: "join",
      downloadDir: "/workspace/my-downloads",
      passphraseStdin: true,
      json: false,
    });

    const seedCmd = parseCliArgs(
      [
        "seed",
        "--storage-dir",
        "./seed-data",
        "--max-storage-mb",
        "256",
        "--passphrase-stdin",
      ],
      "/workspace",
    );
    expect(seedCmd).toEqual({
      command: "seed",
      storageDir: "/workspace/seed-data",
      maxStorageMb: 256,
      passphraseStdin: true,
      json: false,
    });

    expect(() =>
      parseCliArgs(["seed", "--max-storage-mb", "0"], "/workspace"),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["login", "--download-dir", "./dl"], "/workspace"),
    ).toThrow(CliUsageError);
  });
});

describe("PassphraseReader", () => {
  test("reads first line from stdin when fromStdin is true and strips CRLF", async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let stderrOut = "";
    stderr.on("data", (c) => {
      stderrOut += c.toString("utf8");
    });

    const promise = readPassphrase({ fromStdin: true, stdin, stderr });
    stdin.write("correct horse battery staple 🚀\r\nsecond-line-ignored\n");
    stdin.end();

    const passphrase = await promise;
    expect(passphrase).toBe("correct horse battery staple 🚀");
    expect(stderrOut).toBe("");

    // Subsequent prompt on the SAME piped stream preserves unread lines from the first chunk!
    const secondLine = await readVisiblePrompt({
      prompt: "Next line: ",
      stdin,
      stderr: new PassThrough(),
    });
    expect(secondLine).toBe("second-line-ignored");
  });

  test("interactive TTY raw mode disables echo, handles backspace, and restores terminal state in finally", async () => {
    class FakeTtyInput extends EventEmitter {
      isTTY = true;
      isRaw = false;
      rawTransitions: boolean[] = [];
      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.rawTransitions.push(mode);
        return this;
      }
      resume(): this {
        return this;
      }
      pause(): this {
        return this;
      }
    }

    const ttyIn = new FakeTtyInput();
    let stderrOut = "";
    const stderr = new PassThrough();
    stderr.on("data", (c) => {
      stderrOut += c.toString("utf8");
    });

    const pending = readPassphrase({
      fromStdin: false,
      stdin: ttyIn as unknown as NodeJS.ReadableStream,
      stderr,
    });

    ttyIn.emit("data", Buffer.from("secrx", "utf8"));
    ttyIn.emit("data", Buffer.from("\x7fet-pass\r", "utf8"));

    const result = await pending;
    expect(result).toBe("secret-pass");
    expect(ttyIn.rawTransitions).toEqual([true, false]);
    expect(ttyIn.isRaw).toBe(false);
    expect(stderrOut).toBe("Room passphrase: \n");
    expect(stderrOut).not.toContain("secret-pass");

    // Verify terminal raw mode is also restored when user presses Ctrl+C (\x03)
    const ttyAbort = new FakeTtyInput();
    const abortPending = readPassphrase({
      fromStdin: false,
      stdin: ttyAbort as unknown as NodeJS.ReadableStream,
      stderr: new PassThrough(),
    });
    ttyAbort.emit("data", Buffer.from("par\x03", "utf8"));
    await expect(abortPending).rejects.toThrow("SIGINT");
    expect(ttyAbort.isRaw).toBe(false);
  });
});

describe("CredentialStore (0600 Atomic Storage)", () => {
  test("creates 0700 config dir, writes 0600 credentials.json atomically, overwrites, and deletes on logout", async () => {
    const baseDir = await makeTempDir("creds");
    const configDir = join(baseDir, "nested-simpleim");
    const store = new CredentialStore({
      env: { SIMPLEIM_CONFIG_DIR: configDir },
    });

    expect(await store.load()).toBeNull();

    const firstCreds = {
      serverUrl: "http://127.0.0.1:3000",
      sessionToken: "tok_secret_session_one",
      expiresAt: Date.now() + 3_600_000,
      user: {
        id: generatePrefixedId("usr"),
        username: "alice",
        displayName: "Alice",
        createdAt: Date.now(),
      },
    };
    await store.save(firstCreds);

    const dirStat = await stat(configDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const fileStat = await stat(store.filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    // Ensure no leftover temporary files remain
    const filesInDir = await readdir(configDir);
    expect(filesInDir).toEqual(["credentials.json"]);

    expect(await store.load()).toEqual(firstCreds);

    // Overwrite with updated token
    const secondCreds = {
      ...firstCreds,
      sessionToken: "tok_secret_session_two",
    };
    await store.save(secondCreds);
    expect(await store.load()).toEqual(secondCreds);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);

    // Delete on logout
    expect(await store.clear()).toBe(true);
    expect(await store.load()).toBeNull();
    expect(await store.clear()).toBe(false);
  });
});

describe("CliApiClient & CliSignalingClient", () => {
  test("executes CLI auth lifecycle (register, whoami, peer-cert PoP, logout) without leaking tokens", async () => {
    const configDir = await makeTempDir("auth-flow");
    const serverKeys = generateEd25519KeyPair();
    const userId = generatePrefixedId("usr");
    let activeToken: string | null = null;

    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      const headers = new Headers(init?.headers);
      const authHeader = headers.get("authorization");

      if (url.pathname === "/api/v1/auth/register" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.clientKind).toBe("cli");
        activeToken = "ses_cli_token_abc123";
        return Response.json(
          {
            ok: true,
            sessionToken: activeToken,
            expiresAt: Date.now() + 86_400_000,
            user: {
              id: userId,
              username: String(body.username),
              displayName: String(body.displayName ?? body.username),
              createdAt: 1_763_000_000_000,
            },
          },
          { status: 201 },
        );
      }

      if (url.pathname === "/api/v1/auth/me" && init?.method === "GET") {
        if (authHeader !== `Bearer ${activeToken}`) {
          return Response.json(
            { ok: false, error: { code: "unauthorized", message: "Unauthorized" } },
            { status: 401 },
          );
        }
        return Response.json({
          ok: true,
          user: {
            id: userId,
            username: "charlie",
            displayName: "Charlie CLI",
            createdAt: 1_763_000_000_000,
          },
        });
      }

      if (url.pathname === "/api/v1/auth/peer-cert" && init?.method === "POST") {
        expect(authHeader).toBe(`Bearer ${activeToken}`);
        const reqBody = JSON.parse(String(init.body));
        expect(verifyPopRequest({ userId, request: reqBody })).toBe(true);
        const cert = issuePeerIdentityCert({
          serverKeyId: "srvk_01",
          serverSignPrivKey: serverKeys.privateKeyBytes,
          userId,
          username: "charlie",
          displayName: "Charlie CLI",
          peerId: reqBody.peerId,
          peerSignPubKey: reqBody.peerSignPubKey,
          clientKind: "cli",
        });
        return Response.json({ ok: true, cert });
      }

      if (url.pathname === "/api/v1/auth/logout" && init?.method === "POST") {
        expect(authHeader).toBe(`Bearer ${activeToken}`);
        activeToken = null;
        return Response.json({ ok: true });
      }

      return Response.json(
        { ok: false, error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      );
    }) as unknown as typeof fetch;

    const regStdin = new PassThrough();
    regStdin.end("SuperStrongPass!99\n");
    let regOut = "";
    const regStdout = new PassThrough();
    regStdout.on("data", (c) => {
      regOut += c.toString("utf8");
    });

    const regCode = await runCli(
      [
        "register",
        "--server",
        "http://127.0.0.1:3999",
        "--username",
        "charlie",
        "--display-name",
        "Charlie CLI",
        "--password-stdin",
        "--config-dir",
        configDir,
      ],
      { stdin: regStdin, stdout: regStdout, stderr: new PassThrough(), fetchImpl: mockFetch },
    );
    expect(regCode).toBe(0);
    expect(regOut).toContain("@charlie");
    expect(regOut).not.toContain("ses_cli_token_abc123");

    // Issue PeerIdentityCert using stored credentials
    const store = new CredentialStore({ configDir });
    const stored = await store.load();
    expect(stored).not.toBeNull();
    const api = new CliApiClient({
      serverUrl: "http://127.0.0.1:3999",
      fetchImpl: mockFetch,
    });
    const issued = await api.requestFreshPeerIdentity({
      sessionToken: stored!.sessionToken,
      userId: stored!.user.id,
    });
    expect(issued.cert.payload.username).toBe("charlie");
    expect(issued.cert.payload.clientKind).toBe("cli");

    // Run whoami
    let whoOut = "";
    const whoStdout = new PassThrough();
    whoStdout.on("data", (c) => {
      whoOut += c.toString("utf8");
    });
    const whoCode = await runCli(["whoami", "--config-dir", configDir], {
      stdout: whoStdout,
      stderr: new PassThrough(),
      fetchImpl: mockFetch,
    });
    expect(whoCode).toBe(0);
    expect(whoOut).toContain("@charlie");
    expect(whoOut).not.toContain("ses_cli_token_abc123");

    // Run logout with a DIFFERENT --server -> must fail WITHOUT sending token or clearing local creds!
    let leakedRequests = 0;
    const wrongLogoutCode = await runCli(
      [
        "logout",
        "--server",
        "http://127.0.0.1:4999",
        "--config-dir",
        configDir,
      ],
      {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        fetchImpl: (async () => {
          leakedRequests += 1;
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
      },
    );
    expect(wrongLogoutCode).toBe(1);
    expect(leakedRequests).toBe(0);
    expect(await store.load()).not.toBeNull();

    // Run logout against matching server
    const outCode = await runCli(["logout", "--config-dir", configDir], {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      fetchImpl: mockFetch,
    });
    expect(outCode).toBe(0);
    expect(await store.load()).toBeNull();

    // Subsequent getMe with revoked token throws CliApiError
    await expect(api.getMe("ses_cli_token_abc123")).rejects.toBeInstanceOf(
      CliApiError,
    );
  });

  test("login reads both username and password from a single piped stdin chunk", async () => {
    const configDir = await makeTempDir("login-single-chunk");
    const userId = generatePrefixedId("usr");
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        sessionToken: "ses_piped_login_tok",
        expiresAt: Date.now() + 86_400_000,
        user: {
          id: userId,
          username: String(capturedBody.username),
          displayName: String(capturedBody.username),
          createdAt: 1_763_000_000_000,
        },
      });
    }) as unknown as typeof fetch;

    const stdin = new PassThrough();
    stdin.end("charlie_pipe\nPipedSecretPass!42\n");

    const code = await runCli(
      [
        "login",
        "--server",
        "http://127.0.0.1:3999",
        "--password-stdin",
        "--config-dir",
        configDir,
      ],
      {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        fetchImpl: mockFetch,
      },
    );
    expect(code).toBe(0);
    expect(capturedBody).toMatchObject({
      username: "charlie_pipe",
      password: "PipedSecretPass!42",
      clientKind: "cli",
    });
  });

  test("CliSignalingClient passes Bearer header, parses server frames, and auto-reconnects with backoff", async () => {
    const peerId = generatePrefixedId("peer");
    const roomId = "a".repeat(64);
    const observedHeaders: Array<string | null> = [];
    const observedPeerIds: Array<string | null> = [];
    const serverSockets: Array<{ close: () => void; send: (d: string) => void }> = [];
    const receivedClientFrames: ClientSignalingFrame[] = [];

    const server = Bun.serve<{ auth: string | null }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== "/ws/v1/signaling") {
          return new Response("Not Found", { status: 404 });
        }
        observedHeaders.push(req.headers.get("authorization"));
        observedPeerIds.push(url.searchParams.get("peerId"));
        if (srv.upgrade(req, { data: { auth: req.headers.get("authorization") } })) {
          return;
        }
        return new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          serverSockets.push(ws);
          const joinedFrame: ServerSignalingFrame = {
            type: "room.joined",
            roomId,
            selfPeerId: peerId,
            peers: [],
          };
          ws.send(JSON.stringify(joinedFrame));
        },
        message(_ws, msg) {
          receivedClientFrames.push(parseClientSignalingFrame(String(msg)));
        },
      },
    });

    const transitions: boolean[] = [];
    const receivedServerFrames: ServerSignalingFrame[] = [];
    const client = new CliSignalingClient({
      serverUrl: `http://127.0.0.1:${server.port}`,
      sessionToken: "bearer_sig_tok_999",
      peerId,
      initialReconnectDelayMs: 30,
      maxReconnectDelayMs: 100,
    });

    try {
      client.onConnectionChange((c) => transitions.push(c));
      client.onServerFrame((f) => receivedServerFrames.push(f));

      await client.connect();
      expect(client.isConnected).toBe(true);
      expect(observedHeaders[0]).toBe("Bearer bearer_sig_tok_999");
      expect(observedPeerIds[0]).toBe(peerId);

      client.send({ type: "room.join", roomId });

      // Wait briefly for frame exchange
      await Bun.sleep(30);
      expect(receivedClientFrames).toEqual([{ type: "room.join", roomId }]);
      expect(receivedServerFrames.length).toBe(1);
      expect(receivedServerFrames[0]?.type).toBe("room.joined");

      // Simulate abrupt server-side WebSocket drop and wait for automatic reconnect
      serverSockets[0]?.close();
      const deadline = Date.now() + 3_000;
      while (serverSockets.length < 2 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      await Bun.sleep(20);

      expect(serverSockets.length).toBeGreaterThanOrEqual(2);
      expect(client.isConnected).toBe(true);
      expect(transitions).toEqual([true, false, true]);

      // Verify configurable maxSignalPayloadBytes allows >32 KiB envelopes on both send & receive
      const highLimitClient = new CliSignalingClient({
        serverUrl: `http://127.0.0.1:${server.port}`,
        sessionToken: "bearer_sig_tok_999",
        peerId: generatePrefixedId("peer"),
        maxSignalPayloadBytes: 65_536,
        autoReconnect: false,
      });
      const highLimitReceived: ServerSignalingFrame[] = [];
      highLimitClient.onServerFrame((f) => highLimitReceived.push(f));
      await highLimitClient.connect();
      const bigCiphertext = "Q".repeat(46_000);
      expect(() =>
        client.send({
          type: "signal.relay",
          roomId,
          toPeerId: peerId,
          envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
        }),
      ).toThrow();
      const serverHighLimitSocket = serverSockets[serverSockets.length - 1]!;
      serverHighLimitSocket.send(
        JSON.stringify({
          type: "signal.deliver",
          roomId,
          fromPeerId: peerId,
          envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
        }),
      );
      const highDeadline = Date.now() + 2_000;
      while (highLimitReceived.length < 2 && Date.now() < highDeadline) {
        await Bun.sleep(10);
      }
      expect(highLimitReceived[1]?.type).toBe("signal.deliver");
      highLimitClient.disconnect();

      client.disconnect();
      expect(client.isConnected).toBe(false);
    } finally {
      client.disconnect();
      server.stop(true);
    }
  });
});

describe("FsChunkStorageAdapter", () => {
  const roomId = "b".repeat(64);

  test("writes multi-chunk files in random order, resumes from partial .bitfield across restart, and serves chunks after finalization", async () => {
    const downloadDir = await makeTempDir("chunks-resume");
    // 3 full 64 KiB chunks + 1 tail chunk of 12,345 B = 208,953 B
    const totalLength = SWARM_CHUNK_SIZE * 3 + 12_345;
    const fullPayload = randomBytes(totalLength);
    const expectedSha256 = sha256Hex(fullPayload);

    const manifest = await createSignedManifestFixture({
      roomId,
      fileName: "dataset.bin",
      bytes: fullPayload,
    });
    expect(manifest.totalChunks).toBe(4);

    // Phase 1: Write chunk 3 and chunk 1 out of order, then shut down adapter
    const adapter1 = new FsChunkStorageAdapter({ downloadDir });
    const init1 = await adapter1.initReceivingFile(manifest);
    expect(countChunksInBitfield(init1.existingBitfield, 4)).toBe(0);

    const chunk0 = fullPayload.subarray(0, SWARM_CHUNK_SIZE);
    const chunk1 = fullPayload.subarray(SWARM_CHUNK_SIZE, SWARM_CHUNK_SIZE * 2);
    const chunk2 = fullPayload.subarray(
      SWARM_CHUNK_SIZE * 2,
      SWARM_CHUNK_SIZE * 3,
    );
    const chunk3 = fullPayload.subarray(SWARM_CHUNK_SIZE * 3);

    await adapter1.writeVerifiedChunk(manifest.fileId, 3, chunk3);
    await adapter1.writeVerifiedChunk(manifest.fileId, 1, chunk1);

    // Read chunk 1 while still in-progress receiving
    const partialRead1 = await adapter1.readChunk(
      manifest.fileId,
      1,
      SWARM_CHUNK_SIZE,
    );
    expect(sha256Hex(partialRead1)).toBe(sha256Hex(chunk1));
    await expect(
      adapter1.readChunk(manifest.fileId, 0, SWARM_CHUNK_SIZE),
    ).rejects.toThrow();

    await adapter1.closeAll();

    // Verify .part and .bitfield exist on disk
    const dirEntriesDuringPause = (await readdir(downloadDir)).sort();
    expect(dirEntriesDuringPause).toEqual([
      "dataset.bin.simpleim.bitfield",
      "dataset.bin.simpleim.part",
    ]);

    // Phase 2: Restart a fresh adapter on the same directory and verify seamless resume
    const adapter2 = new FsChunkStorageAdapter({ downloadDir });
    const init2 = await adapter2.initReceivingFile(manifest);
    expect(hasChunkInBitfield(init2.existingBitfield, 0)).toBe(false);
    expect(hasChunkInBitfield(init2.existingBitfield, 1)).toBe(true);
    expect(hasChunkInBitfield(init2.existingBitfield, 2)).toBe(false);
    expect(hasChunkInBitfield(init2.existingBitfield, 3)).toBe(true);

    // Write remaining chunks 2 and 0
    await adapter2.writeVerifiedChunk(manifest.fileId, 2, chunk2);
    await adapter2.writeVerifiedChunk(manifest.fileId, 0, chunk0);

    await adapter2.finalizeFile(manifest.fileId);

    const completedPath = adapter2.getCompletedFilePath(manifest.fileId);
    expect(completedPath).toBe(join(downloadDir, "dataset.bin"));

    // .part and .bitfield must be gone
    expect(await readdir(downloadDir)).toEqual(["dataset.bin"]);

    // Finalized file matches original byte-for-byte
    const finalizedBytes = new Uint8Array(await readFile(completedPath!));
    expect(sha256Hex(finalizedBytes)).toBe(expectedSha256);

    // Post-finalization seeding readChunk continues serving chunks from finalized file
    const seededChunk0 = await adapter2.readChunk(
      manifest.fileId,
      0,
      SWARM_CHUNK_SIZE,
    );
    const seededChunk3 = await adapter2.readChunk(manifest.fileId, 3, 12_345);
    expect(sha256Hex(seededChunk0)).toBe(sha256Hex(chunk0));
    expect(sha256Hex(seededChunk3)).toBe(sha256Hex(chunk3));

    await adapter2.closeAll();
  });

  test("never overwrites existing files (report.pdf -> report (1).pdf -> report (2).pdf)", async () => {
    const downloadDir = await makeTempDir("dedup");
    const originalExisting = new TextEncoder().encode("USER_PRECIOUS_REPORT_V0");
    await writeFile(join(downloadDir, "report.pdf"), originalExisting);

    const adapter = new FsChunkStorageAdapter({ downloadDir });

    const bytes1 = new TextEncoder().encode("FIRST_DOWNLOADED_REPORT");
    const manifest1 = await createSignedManifestFixture({
      roomId,
      fileName: "report.pdf",
      bytes: bytes1,
    });
    await adapter.initReceivingFile(manifest1);
    await adapter.writeVerifiedChunk(manifest1.fileId, 0, bytes1);
    await adapter.finalizeFile(manifest1.fileId);
    expect(basename(adapter.getCompletedFilePath(manifest1.fileId)!)).toBe(
      "report (1).pdf",
    );

    const bytes2 = new TextEncoder().encode("SECOND_DOWNLOADED_REPORT");
    const manifest2 = await createSignedManifestFixture({
      roomId,
      fileName: "report.pdf",
      bytes: bytes2,
    });
    await adapter.initReceivingFile(manifest2);
    await adapter.writeVerifiedChunk(manifest2.fileId, 0, bytes2);
    await adapter.finalizeFile(manifest2.fileId);
    expect(basename(adapter.getCompletedFilePath(manifest2.fileId)!)).toBe(
      "report (2).pdf",
    );

    // Original report.pdf must remain 100% untouched
    expect(await readFile(join(downloadDir, "report.pdf"), "utf8")).toBe(
      "USER_PRECIOUS_REPORT_V0",
    );
    expect(await readFile(join(downloadDir, "report (1).pdf"), "utf8")).toBe(
      "FIRST_DOWNLOADED_REPORT",
    );
    expect(await readFile(join(downloadDir, "report (2).pdf"), "utf8")).toBe(
      "SECOND_DOWNLOADED_REPORT",
    );

    await adapter.closeAll();
  });

  test("sanitizes path traversal filenames and enforces maxStorageBytes quota", async () => {
    const parentDir = await makeTempDir("traversal-quota");
    const downloadDir = join(parentDir, "vault");
    const adapter = new FsChunkStorageAdapter({
      downloadDir,
      maxStorageBytes: 100_000,
    });

    const smallPayload = randomBytes(60_000);
    const baseManifest = await createSignedManifestFixture({
      roomId,
      fileName: "safe.txt",
      bytes: smallPayload,
    });

    // Inject raw path traversal into manifest.fileName to test defense-in-depth inside FsChunkStorageAdapter
    const poisonedManifest: FileManifest = {
      ...baseManifest,
      fileName: "../../../outside-escape.txt",
    };

    await adapter.initReceivingFile(poisonedManifest);
    await adapter.writeVerifiedChunk(poisonedManifest.fileId, 0, smallPayload);
    await adapter.finalizeFile(poisonedManifest.fileId);

    const savedPath = adapter.getCompletedFilePath(poisonedManifest.fileId)!;
    expect(savedPath).toBe(join(downloadDir, "outside-escape.txt"));
    // Verify parent directory was not polluted
    expect(await readdir(parentDir)).toEqual(["vault"]);

    // Reject purely '..' filename
    await expect(
      adapter.initReceivingFile({
        ...baseManifest,
        fileId: generateUuidV7(),
        fileName: "..",
      }),
    ).rejects.toThrow();

    // Enforce maxStorageBytes: 60,000 B used + 50,000 B new = 110,000 B > 100,000 B quota
    const overQuotaPayload = randomBytes(50_000);
    const overQuotaManifest = await createSignedManifestFixture({
      roomId,
      fileName: "too-big.bin",
      bytes: overQuotaPayload,
    });
    await expect(
      adapter.initReceivingFile(overQuotaManifest),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);

    await adapter.closeAll();
  });

  test("binds resumed bitfield to manifest, clears corrupted disk chunks, disambiguates full UUIDv7 collisions, and counts payload files with metadata-like suffixes", async () => {
    const downloadDir = await makeTempDir("resume-binding");
    const payloadA = randomBytes(SWARM_CHUNK_SIZE * 2);
    const payloadB = randomBytes(SWARM_CHUNK_SIZE * 2);

    // Two distinct UUIDv7 fileIds sharing the exact same first 8 chars ("019a8888")!
    const fileIdA = "019a8888-1111-7000-8000-000000000001";
    const fileIdB = "019a8888-2222-7000-8000-000000000002";
    const fileIdC = "019a8888-3333-7000-8000-000000000003";

    const manifestA = await createSignedManifestFixture({
      roomId,
      fileName: "shared-name.bin",
      bytes: payloadA,
      fileId: fileIdA,
    });
    const manifestB = await createSignedManifestFixture({
      roomId,
      fileName: "shared-name.bin",
      bytes: payloadB,
      fileId: fileIdB,
    });
    const manifestC = await createSignedManifestFixture({
      roomId,
      fileName: "shared-name.bin",
      bytes: payloadB,
      fileId: fileIdC,
    });

    // 1. Concurrent downloads with identical 8-char UUIDv7 prefix disambiguate via FULL fileId!
    const adapter1 = new FsChunkStorageAdapter({ downloadDir });
    await adapter1.initReceivingFile(manifestA);
    await adapter1.initReceivingFile(manifestB);
    await adapter1.initReceivingFile(manifestC);

    await adapter1.writeVerifiedChunk(
      manifestA.fileId,
      0,
      payloadA.subarray(0, SWARM_CHUNK_SIZE),
    );
    await adapter1.writeVerifiedChunk(
      manifestA.fileId,
      1,
      payloadA.subarray(SWARM_CHUNK_SIZE),
    );
    await adapter1.writeVerifiedChunk(
      manifestB.fileId,
      0,
      payloadB.subarray(0, SWARM_CHUNK_SIZE),
    );

    const activeEntries = await readdir(downloadDir);
    expect(activeEntries).toContain(
      `shared-name.bin.${fileIdB}.simpleim.part`,
    );
    expect(activeEntries).toContain(
      `shared-name.bin.${fileIdC}.simpleim.part`,
    );
    await adapter1.closeAll();

    // 2. Corrupt chunk 1 of manifestA's .part on disk while paused -> initReceivingFile must clear chunk 1!
    const partPathA = join(downloadDir, "shared-name.bin.simpleim.part");
    const rawPartA = new Uint8Array(await readFile(partPathA));
    rawPartA[SWARM_CHUNK_SIZE] = (rawPartA[SWARM_CHUNK_SIZE]! ^ 0xff) & 0xff;
    await writeFile(partPathA, rawPartA);

    const adapter2 = new FsChunkStorageAdapter({ downloadDir });
    const resumedA = await adapter2.initReceivingFile(manifestA);
    expect(hasChunkInBitfield(resumedA.existingBitfield, 0)).toBe(true);
    expect(hasChunkInBitfield(resumedA.existingBitfield, 1)).toBe(false);

    // And a brand-new manifestD with same fileName & fileSize MUST NOT adopt manifestA's paused .part!
    const manifestD = await createSignedManifestFixture({
      roomId,
      fileName: "shared-name.bin",
      bytes: payloadB,
      fileId: "019a8888-4444-7000-8000-000000000004",
    });
    const initD = await adapter2.initReceivingFile(manifestD);
    expect(countChunksInBitfield(initD.existingBitfield, 2)).toBe(0);
    await adapter2.closeAll();

    // 3. Finalized user payload whose filename ends with .simpleim.bitfield counts toward maxStorageBytes!
    const quotaDir = await makeTempDir("quota-suffix");
    const quotaAdapter = new FsChunkStorageAdapter({
      downloadDir: quotaDir,
      maxStorageBytes: 50_000,
    });
    const disguisedPayload = randomBytes(40_000);
    const disguisedManifest = await createSignedManifestFixture({
      roomId,
      fileName: "sneaky.simpleim.bitfield",
      bytes: disguisedPayload,
    });
    await quotaAdapter.initReceivingFile(disguisedManifest);
    await quotaAdapter.writeVerifiedChunk(
      disguisedManifest.fileId,
      0,
      disguisedPayload,
    );
    await quotaAdapter.finalizeFile(disguisedManifest.fileId);

    expect(await quotaAdapter.getUsedPayloadBytes()).toBe(40_000);
    // Restarted adapter also counts finalized sneaky.simpleim.bitfield!
    await quotaAdapter.closeAll();
    const quotaAdapterRestarted = new FsChunkStorageAdapter({
      downloadDir: quotaDir,
      maxStorageBytes: 50_000,
    });
    expect(await quotaAdapterRestarted.getUsedPayloadBytes()).toBe(40_000);

    const nextManifest = await createSignedManifestFixture({
      roomId,
      fileName: "extra.bin",
      bytes: randomBytes(20_000),
    });
    await expect(
      quotaAdapterRestarted.initReceivingFile(nextManifest),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await quotaAdapterRestarted.closeAll();
  });
});

describe("SeedQuotaController & Redacted StructuredLogger", () => {
  test("admits files within quota without concurrent over-commit and redacts sensitive log fields", async () => {
    const storageDir = await makeTempDir("seed-quota");
    const storage = new FsChunkStorageAdapter({
      downloadDir: storageDir,
      maxStorageBytes: 100_000,
    });

    const emittedLogs: string[] = [];
    const logger = new StructuredLogger({
      correlationId: "corr_test_001",
      sink: (line) => emittedLogs.push(line),
    });

    // Verify logger explicitly strips forbidden fields & truncates roomId to 8 hex chars
    logger.info("test.boundary", {
      durationMs: 14.7,
      meta: {
        roomId: "abcdef0123456789".repeat(4),
        passphrase: "NEVER_LOG_PASSPHRASE",
        sessionToken: "NEVER_LOG_TOKEN",
        sdp: "v=0\r\nNEVER_LOG_SDP",
        body: "NEVER_LOG_CHAT_BODY",
        fileName: "NEVER_LOG_SECRET_DOC.pdf",
        safeCount: 3,
      },
    });

    expect(emittedLogs.length).toBe(1);
    const parsedLog = JSON.parse(emittedLogs[0]!) as Record<string, unknown>;
    expect(parsedLog.correlationId).toBe("corr_test_001");
    expect(parsedLog.roomIdPrefix).toBe("abcdef01");
    expect(parsedLog.durationMs).toBe(15);
    expect(parsedLog.safeCount).toBe(3);
    expect(emittedLogs[0]).not.toContain("NEVER_LOG");
    expect(emittedLogs[0]).not.toContain("abcdef0123456789");

    const downloadedIds: string[] = [];
    const controller = new SeedQuotaController({
      maxStorageBytes: 100_000,
      storage,
      roomIdPrefix: "abcdef01",
      logger,
      downloadFile: async (fileId) => {
        await Bun.sleep(10);
        downloadedIds.push(fileId);
      },
    });

    const roomId = "c".repeat(64);
    const m1 = await createSignedManifestFixture({
      roomId,
      fileName: "secret-alpha.pdf",
      bytes: randomBytes(60_000),
    });
    const m2 = await createSignedManifestFixture({
      roomId,
      fileName: "secret-beta.pdf",
      bytes: randomBytes(60_000),
    });
    const m3 = await createSignedManifestFixture({
      roomId,
      fileName: "secret-gamma.pdf",
      bytes: randomBytes(35_000),
    });

    // Announce all three concurrently: m1 (60KB) + m2 (60KB -> skipped) + m3 (35KB -> fits: 60+35=95 <= 100KB!)
    const results = await Promise.all([
      controller.onFileAnnounced(m1),
      controller.onFileAnnounced(m2),
      controller.onFileAnnounced(m3),
    ]);

    expect(results).toEqual([true, false, true]);
    expect(downloadedIds).toEqual([m1.fileId, m3.fileId]);

    controller.onTransferCompleted(m1);
    expect(controller.getCompletedCount()).toBe(1);

    // Ensure secret filenames never appeared in any seed logs
    const joinedLogs = emittedLogs.join("\n");
    expect(joinedLogs).not.toContain("secret-alpha.pdf");
    expect(joinedLogs).not.toContain("secret-beta.pdf");
    expect(joinedLogs).not.toContain("secret-gamma.pdf");
  });
});

describe("Interactive join Slash Commands", () => {
  test("handles chat lines, /peers, /send, /files, /get, /help, and /quit", async () => {
    const workDir = await makeTempDir("join-slash");
    const samplePath = join(workDir, "hello.txt");
    await writeFile(samplePath, "Hello P2P Swarm!");

    const roomId = "d".repeat(64);
    const serverKeys = generateEd25519KeyPair();
    const peerKeys = generateEd25519KeyPair();
    const peerId = generatePrefixedId("peer");
    const cert = issuePeerIdentityCert({
      serverKeyId: "srvk_01",
      serverSignPrivKey: serverKeys.privateKeyBytes,
      userId: generatePrefixedId("usr"),
      username: "alice",
      displayName: "Alice",
      peerId,
      peerSignPubKey: peerKeys.publicKeyBase64Url,
      clientKind: "cli",
    });

    const announcedFiles: FileManifest[] = [];
    const downloadedFileIds: string[] = [];
    const sentBodies: string[] = [];

    const mockEngine: RoomPeerEngine = {
      roomId,
      localPeerId: peerId,
      start: async () => {},
      stop: async () => {},
      updateLocalCert: () => {},
      isCenterConnected: () => true,
      getVerifiedPeers: () => [
        {
          peerId: "peer_019a0000000070008000000000000001",
          userId: "usr_019a0000000070008000000000000001",
          username: "bob",
          displayName: "Bob",
          clientKind: "web",
          rttMs: 12,
          connectedAt: Date.now(),
        },
      ],
      getMessages: () => [],
      getFiles: () => announcedFiles,
      getTransferProgress: () => undefined,
      sendChatMessage: async (body: string): Promise<ChatMessageEnvelope> => {
        sentBodies.push(body);
        return signChatMessage({
          roomId,
          lamport: 1,
          body,
          authorCert: cert,
          peerSignPrivKey: peerKeys.privateKeyBytes,
        });
      },
      shareFile: async (input) => {
        const manifest = await createSignedFileManifestFromChunks({
          roomId,
          fileName: input.fileName,
          fileSize: input.fileSize,
          mimeType: input.mimeType,
          readChunk: input.readChunk,
          senderCert: cert,
          peerSignPrivKey: peerKeys.privateKeyBytes,
        });
        announcedFiles.push(manifest);
        return manifest;
      },
      downloadFile: async (id) => {
        downloadedFileIds.push(id);
      },
      cancelDownload: async () => {},
    };

    const chunkStorage = new FsChunkStorageAdapter({
      downloadDir: join(workDir, "downloads"),
    });
    const sharedFiles = new LocalSharedFileRegistry();
    let outText = "";
    const stdout = new PassThrough();
    stdout.on("data", (c) => {
      outText += c.toString("utf8");
    });

    try {
      expect(
        await executeJoinInputLine({
          line: "Hello everyone!",
          engine: mockEngine,
          chunkStorage,
          sharedFiles,
          stdout,
          cwd: workDir,
        }),
      ).toBe("continue");
      expect(sentBodies).toEqual(["Hello everyone!"]);

      await executeJoinInputLine({
        line: "/peers",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout,
        cwd: workDir,
      });
      expect(outText).toContain("@bob (Bob) [web]");

      await executeJoinInputLine({
        line: `/send ${samplePath}`,
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout,
        cwd: workDir,
      });
      expect(announcedFiles.length).toBe(1);
      expect(announcedFiles[0]?.fileName).toBe("hello.txt");

      await executeJoinInputLine({
        line: "/files",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout,
        cwd: workDir,
      });
      expect(outText).toContain("[1]");
      expect(outText).toContain("hello.txt");

      await executeJoinInputLine({
        line: "/get 1",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout,
        cwd: workDir,
      });
      expect(downloadedFileIds).toEqual([announcedFiles[0]!.fileId]);

      expect(
        await executeJoinInputLine({
          line: "/quit",
          engine: mockEngine,
          chunkStorage,
          sharedFiles,
          stdout,
          cwd: workDir,
        }),
      ).toBe("exit");
    } finally {
      await sharedFiles.closeAll();
      await chunkStorage.closeAll();
    }
  });
});

describe("Real WeriftTransportFactory P2P Loopback", () => {
  test("establishes DTLS/SCTP negotiated channels (id:0 control-chat & id:1 file-swarm), verifies DTLS SHA-256 fingerprints, and transfers UTF-8 + 64 KiB SwarmBinaryFrame", async () => {
    const factory = new WeriftTransportFactory();
    const peerAId = "peer_019a000000007000800000000000000a";
    const peerBId = "peer_019a000000007000800000000000000b";

    const connA = factory.createPeerConnection({
      localPeerId: peerAId,
      remotePeerId: peerBId,
      isInitiator: true,
      iceServers: [],
    });

    const connB = factory.createPeerConnection({
      localPeerId: peerBId,
      remotePeerId: peerAId,
      isInitiator: false,
      iceServers: [],
    });

    try {
      expect(connA.controlChannel.id).toBe(CONTROL_CHANNEL_ID);
      expect(connA.controlChannel.label).toBe(CONTROL_CHANNEL_LABEL);
      expect(connA.swarmChannel.id).toBe(SWARM_CHANNEL_ID);
      expect(connA.swarmChannel.label).toBe(SWARM_CHANNEL_LABEL);

      // Wire trickle ICE exchange in memory
      connA.onLocalIceCandidate((cand) => {
        void connB.addIceCandidate(cand);
      });
      connA.onLocalIceEnd(() => {
        void connB.endIceCandidates();
      });

      connB.onLocalIceCandidate((cand) => {
        void connA.addIceCandidate(cand);
      });
      connB.onLocalIceEnd(() => {
        void connA.endIceCandidates();
      });

      const offerSdp = await connA.createOffer();
      const answerSdp = await connB.acceptOfferAndCreateAnswer(offerSdp);
      await connA.acceptAnswer(answerSdp);

      // Verify distinct per-peer DTLS certificates and exact cross-peer fingerprint binding
      const fpALocal = connA.getLocalDtlsFingerprint();
      const fpBLocal = connB.getLocalDtlsFingerprint();
      expect(fpALocal).not.toBe(fpBLocal);
      expect(fpALocal).toBe(connB.getRemoteDtlsFingerprint());
      expect(fpBLocal).toBe(connA.getRemoteDtlsFingerprint());

      // Wait for both negotiated channels (id:0 and id:1) to open on both sides
      await Promise.all([
        waitForChannelOpen(connA.controlChannel),
        waitForChannelOpen(connB.controlChannel),
        waitForChannelOpen(connA.swarmChannel),
        waitForChannelOpen(connB.swarmChannel),
      ]);

      // 1. Exchange UTF-8 JSON/text messages bidirectionally on dc:0 ("control-chat")
      const receivedTextAtB = new Promise<string>((resolve) => {
        connB.controlChannel.onTextMessage((txt) => resolve(txt));
      });
      const receivedTextAtA = new Promise<string>((resolve) => {
        connA.controlChannel.onTextMessage((txt) => resolve(txt));
      });

      const msgAtoB = JSON.stringify({
        type: "hello.challenge",
        note: "Hello from Peer A 🔒✨",
      });
      const msgBtoA = JSON.stringify({
        type: "hello.challenge",
        note: "Hello back from Peer B 🚀",
      });

      connA.controlChannel.sendText(msgAtoB);
      connB.controlChannel.sendText(msgBtoA);

      expect(await receivedTextAtB).toBe(msgAtoB);
      expect(await receivedTextAtA).toBe(msgBtoA);
      expect(connA.controlChannel.bufferedAmount).toBeGreaterThanOrEqual(0);

      // 2. Exchange a full 64 KiB (65,536 B) binary SwarmBinaryFrame on dc:1 ("file-swarm")
      const fileId = generateUuidV7();
      const rawChunkPayload = randomBytes(SWARM_CHUNK_SIZE);
      const expectedChunkHash = sha256Hex(rawChunkPayload);
      const encodedFrame = encodeSwarmFrame({
        frameType: SwarmFrameType.CHUNK,
        fileId,
        chunkIndex: 7,
        payload: rawChunkPayload,
      });

      const receivedBinaryAtB = new Promise<Uint8Array>((resolve) => {
        connB.swarmChannel.onBinaryMessage((bytes) => resolve(bytes));
      });

      connA.swarmChannel.sendBinary(encodedFrame);

      const wireBytesAtB = await receivedBinaryAtB;
      const decoded = decodeSwarmFrame(wireBytesAtB);
      expect(decoded.version).toBe(1);
      expect(decoded.frameType).toBe(SwarmFrameType.CHUNK);
      expect(decoded.fileId).toBe(fileId);
      expect(decoded.chunkIndex).toBe(7);
      expect(decoded.payload.byteLength).toBe(SWARM_CHUNK_SIZE);
      expect(sha256Hex(decoded.payload)).toBe(expectedChunkHash);
    } finally {
      connA.close();
      connB.close();
      expect(connA.state).toBe("closed");
      expect(connB.state).toBe("closed");
    }
  });

  test("Issue #20 regression: probeNetworkInterfaces, mDNS SDP/ICE filtering, and no_usable_ice_path error", async () => {
    const throwingGetIfAddrs = () => {
      throw Object.assign(
        new Error("A system error occurred: getifaddrs returned an error"),
        {
          code: "ERR_SYSTEM_ERROR",
          syscall: "getifaddrs",
          errno: 1,
        },
      );
    };

    const failedProbe = probeNetworkInterfaces(throwingGetIfAddrs);
    expect(failedProbe).toEqual({
      ok: false,
      code: "ERR_SYSTEM_ERROR",
      syscall: "getifaddrs",
      message: "A system error occurred: getifaddrs returned an error",
    });

    const healthyProbe = probeNetworkInterfaces(() => ({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "10.0.0.15",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "02:42:0a:00:00:0f",
          internal: false,
          cidr: "10.0.0.15/24",
        },
      ],
    }));
    expect(healthyProbe).toEqual({ ok: true, ipv4Count: 1, ipv6Count: 0 });

    // mDNS candidate detection keeps srflx/relay/IPv4 candidates while matching .local hostnames
    expect(
      isMdnsIceCandidate(
        "candidate:2999745851 1 udp 2122260223 e5f6a7b8-1234-4abc-9def-0123456789ab.local 54321 typ host generation 0",
      ),
    ).toBe(true);
    expect(
      isMdnsIceCandidate(
        "a=candidate:1 1 UDP 2122260223 ABCD-1234.LOCAL 60000 typ host",
      ),
    ).toBe(true);
    expect(
      isMdnsIceCandidate(
        "candidate:842163049 1 udp 1686052607 203.0.113.42 51234 typ srflx raddr e5f6a7b8.local rport 0 generation 0",
      ),
    ).toBe(false);
    expect(
      isMdnsIceCandidate(
        "candidate:1 1 udp 2122260223 127.0.0.1 54321 typ host",
      ),
    ).toBe(false);

    const sampleSdp = [
      "v=0",
      "a=fingerprint:sha-256 AA:BB:CC:DD",
      "a=candidate:1 1 udp 2122260223 e5f6a7b8-1234.local 54321 typ host",
      "a=candidate:2 1 udp 2122260223 127.0.0.1 54322 typ host",
      "",
    ].join("\r\n");
    const strippedSdp = stripMdnsCandidatesFromSdp(sampleSdp);
    expect(strippedSdp).not.toContain(".local");
    expect(strippedSdp).toContain("a=fingerprint:sha-256 AA:BB:CC:DD");
    expect(strippedSdp).toContain("127.0.0.1 54322 typ host");

    // When getifaddrs fails AND neither explicit host addresses nor TURN servers exist, reject deterministically
    const diagnostics: WeriftNetworkDiagnostic[] = [];
    const unusableFactory = new WeriftTransportFactory({
      networkInterfacesImpl: throwingGetIfAddrs,
      iceAdditionalHostAddresses: [],
      onNetworkDiagnostic: (d) => diagnostics.push(d),
    });
    const unusableConn = unusableFactory.createPeerConnection({
      localPeerId: "peer_a",
      remotePeerId: "peer_b",
      isInitiator: true,
      iceServers: [],
    });
    try {
      expect(diagnostics.map((d) => d.code)).toEqual([
        "network_interfaces_unavailable",
        "no_usable_ice_path",
      ]);
      await expect(unusableConn.createOffer()).rejects.toThrow(
        /Unsupported restricted network environment/,
      );
    } finally {
      unusableConn.close();
    }
  });

  test("Issue #20 regression: completes full WebRTC loopback under getifaddrs ERR_SYSTEM_ERROR while ignoring SDP & trickle .local mDNS candidates without instantiating MdnsLookup", async () => {
    const throwingGetIfAddrs = () => {
      throw Object.assign(
        new Error("A system error occurred: getifaddrs returned an error"),
        {
          code: "ERR_SYSTEM_ERROR",
          syscall: "getifaddrs",
          errno: 1,
        },
      );
    };

    const diagnosticsA: WeriftNetworkDiagnostic[] = [];
    const factoryA = new WeriftTransportFactory({
      networkInterfacesImpl: throwingGetIfAddrs,
      onNetworkDiagnostic: (d) => diagnosticsA.push(d),
    });
    const factoryB = new WeriftTransportFactory({
      networkInterfacesImpl: throwingGetIfAddrs,
    });

    const peerAId = "peer_019a000000007000800000000000010a";
    const peerBId = "peer_019a000000007000800000000000010b";

    const connA = factoryA.createPeerConnection({
      localPeerId: peerAId,
      remotePeerId: peerBId,
      isInitiator: true,
      iceServers: [],
    });
    // Second connection on same factory should not duplicate factory-level warning
    const dummyConn = factoryA.createPeerConnection({
      localPeerId: peerAId,
      remotePeerId: "peer_019a000000007000800000000000010c",
      isInitiator: true,
      iceServers: [],
    });
    dummyConn.close();
    expect(diagnosticsA.length).toBe(1);
    expect(diagnosticsA[0]?.code).toBe("network_interfaces_unavailable");
    expect(diagnosticsA[0]?.syscall).toBe("getifaddrs");
    expect(diagnosticsA[0]?.errnoCode).toBe("ERR_SYSTEM_ERROR");

    const connB = factoryB.createPeerConnection({
      localPeerId: peerBId,
      remotePeerId: peerAId,
      isInitiator: false,
      iceServers: [],
    });

    try {
      // Queue pre-SDP trickle .local mDNS candidates (exact browser behavior!)
      await connB.addIceCandidate({
        candidate:
          "candidate:111 1 udp 2122260223 9f8e7d6c-aaaa-4bbb-8ccc-111122223333.local 51001 typ host generation 0",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      await connA.addIceCandidate({
        candidate:
          "candidate:222 1 udp 2122260223 1a2b3c4d-dddd-4eee-8fff-444455556666.local 51002 typ host generation 0",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      connA.onLocalIceCandidate((cand) => {
        void connB.addIceCandidate(cand);
      });
      connA.onLocalIceEnd(() => {
        void connB.endIceCandidates();
      });
      connB.onLocalIceCandidate((cand) => {
        void connA.addIceCandidate(cand);
      });
      connB.onLocalIceEnd(() => {
        void connA.endIceCandidates();
      });

      const rawOfferSdp = await connA.createOffer();
      // Inject an embedded a=candidate:... .local line into SDP offer as well
      const offerWithMdns = `${rawOfferSdp}a=candidate:333 1 udp 2122260223 offer-embedded.local 52001 typ host\r\n`;

      const rawAnswerSdp = await connB.acceptOfferAndCreateAnswer(offerWithMdns);
      const answerWithMdns = `${rawAnswerSdp}a=candidate:444 1 udp 2122260223 answer-embedded.local 52002 typ host\r\n`;
      await connA.acceptAnswer(answerWithMdns);

      // Also feed post-SDP live trickle .local candidates
      await connA.addIceCandidate({
        candidate:
          "candidate:555 1 udp 2122260223 live-trickle-a.local 53001 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      await connB.addIceCandidate({
        candidate:
          "candidate:666 1 udp 2122260223 live-trickle-b.local 53002 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      // Verify internal werift config never enabled host NIC enumeration and never instantiated MdnsLookup!
      for (const conn of [connA, connB]) {
        const internalPc = (
          conn as unknown as {
            pc: {
              config: { iceUseIpv4: boolean; iceUseIpv6: boolean };
              iceTransports: Array<{ connection: { lookup?: unknown } }>;
            };
          }
        ).pc;
        expect(internalPc.config.iceUseIpv4).toBe(false);
        expect(internalPc.config.iceUseIpv6).toBe(false);
        for (const transport of internalPc.iceTransports) {
          expect(transport.connection.lookup).toBeUndefined();
        }
      }

      await Promise.all([
        waitForChannelOpen(connA.controlChannel),
        waitForChannelOpen(connB.controlChannel),
      ]);

      const msgPromise = new Promise<string>((resolve) => {
        connB.controlChannel.onTextMessage((t) => resolve(t));
      });
      connA.controlChannel.sendText("hello-from-restricted-container");
      expect(await msgPromise).toBe("hello-from-restricted-container");

      // Yield for any async dgram socket callbacks to ensure zero delayed crashes
      await Bun.sleep(50);
    } finally {
      connA.close();
      connB.close();
    }
  });

  test("Linux dgram ECONNREFUSED regression: werift UDP ICE sockets safely absorb ICMP recvmsg ECONNREFUSED errors without crashing Bun", async () => {
    const factoryA = new WeriftTransportFactory();
    const factoryB = new WeriftTransportFactory();

    const peerAId = "peer_019a000000007000800000000000020a";
    const peerBId = "peer_019a000000007000800000000000020b";

    const connA = factoryA.createPeerConnection({
      localPeerId: peerAId,
      remotePeerId: peerBId,
      isInitiator: true,
      iceServers: [],
    });
    const connB = factoryB.createPeerConnection({
      localPeerId: peerBId,
      remotePeerId: peerAId,
      isInitiator: false,
      iceServers: [],
    });

    try {
      connA.onLocalIceCandidate((cand) => {
        void connB.addIceCandidate(cand);
      });
      connA.onLocalIceEnd(() => {
        void connB.endIceCandidates();
      });
      connB.onLocalIceCandidate((cand) => {
        void connA.addIceCandidate(cand);
      });
      connB.onLocalIceEnd(() => {
        void connA.endIceCandidates();
      });

      const offer = await connA.createOffer();
      const answer = await connB.acceptOfferAndCreateAnswer(offer);
      await connA.acceptAnswer(answer);

      await Promise.all([
        waitForChannelOpen(connA.controlChannel),
        waitForChannelOpen(connB.controlChannel),
      ]);

      // Inspect every underlying dgram.Socket created by werift UdpTransport and emit ECONNREFUSED directly
      let emittedErrorCount = 0;
      for (const conn of [connA, connB]) {
        const internalPc = (
          conn as unknown as {
            pc: {
              iceTransports: Array<{
                connection: {
                  protocols: Array<{
                    transport?: { socket?: EventEmitter };
                    turn?: { transport?: { socket?: EventEmitter } };
                  }>;
                };
              }>;
            };
          }
        ).pc;

        for (const iceTransport of internalPc.iceTransports) {
          for (const proto of iceTransport.connection.protocols) {
            const sock = proto.transport?.socket ?? proto.turn?.transport?.socket;
            if (sock) {
              expect(sock.listenerCount("error")).toBeGreaterThan(0);
              const icmpErr = Object.assign(new Error("recvmsg ECONNREFUSED"), {
                code: "ECONNREFUSED",
                errno: -111,
                syscall: "recvmsg",
              });
              expect(() => sock.emit("error", icmpErr)).not.toThrow();
              emittedErrorCount += 1;
            }
          }
        }
      }
      expect(emittedErrorCount).toBeGreaterThanOrEqual(2);

      // Verify active WebRTC DataChannel continues delivering messages cleanly after transient ICMP error
      const msgPromise = new Promise<string>((resolve) => {
        connB.controlChannel.onTextMessage((t) => resolve(t));
      });
      connA.controlChannel.sendText("alive-after-econnrefused");
      expect(await msgPromise).toBe("alive-after-econnrefused");
    } finally {
      connA.close();
      connB.close();
    }
  });
});
