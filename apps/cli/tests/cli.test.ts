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
  bytesToBase64Url,
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
  createJoinCompleter,
  CredentialStore,
  DtlsHandshakeReassembler,
  ensureWeriftDtlsFragmentReassemblyGuarded,
  formatCliChatMessage,
  formatCliFsError,
  formatCliRoomFingerprint,
  formatCliTimestamp,
  formatHelpText,
  formatRenderedChatEvent,
  formatSeedQuotaHumanEvent,
  formatShortId,
  formatUniqueFileSelector,
  InteractiveJoinTerminal,
  JoinTransferProgressTracker,
  parseCliFilePathInput,
  sanitizeTerminalMultilineText,
  sanitizeTerminalSingleLine,
  shouldUseColor,
  executeJoinInputLine,
  FsChunkStorageAdapter,
  isMdnsIceCandidate,
  mapContractIceServers,
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
  validateRegisterUsernameLocal,
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
      getSignalingPeerCount: () => 1,
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
      getChatDeliveryStates: () => new Map(),
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
      retryChatMessage: async () => {},
      flushPendingRelayKeepalive: () => {},
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

  test("TURN TCP ECONNREFUSED regression: mapContractIceServers prefers UDP TURN when both UDP and TCP URLs exist, and TcpTransport rejects fast instead of hanging createOffer()", async () => {
    const mixed = mapContractIceServers([
      { urls: ["stun:120.25.210.202:3478"] },
      {
        urls: [
          "turn:120.25.210.202:3478?transport=udp",
          "turn:120.25.210.202:3478?transport=tcp",
        ],
        username: "1795000000:usr_1",
        credential: "secret",
      },
    ]);
    expect(mixed.forceTurnTCP).toBe(false);
    expect(mixed.hasStunServer).toBe(true);
    expect(mixed.hasTurnServer).toBe(true);
    expect(mixed.iceServers.length).toBe(2);

    const tcpOnly = mapContractIceServers([
      {
        urls: ["turn:120.25.210.202:3478?transport=tcp"],
        username: "1795000000:usr_1",
        credential: "secret",
      },
    ]);
    expect(tcpOnly.forceTurnTCP).toBe(true);

    // Pick a guaranteed-closed ephemeral localhost TCP port to trigger immediate ECONNREFUSED
    const netMod = await import("node:net");
    const closedPort = await new Promise<number>((resolve, reject) => {
      const srv = netMod.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });

    const factoryA = new WeriftTransportFactory();
    const factoryB = new WeriftTransportFactory();
    const refusedTurnServers = [
      {
        urls: [`turn:127.0.0.1:${closedPort}?transport=tcp`],
        username: "1795000000:usr_test",
        credential: "cred",
      },
    ];

    const connA = factoryA.createPeerConnection({
      localPeerId: "peer_019a000000007000800000000000030a",
      remotePeerId: "peer_019a000000007000800000000000030b",
      isInitiator: true,
      iceServers: refusedTurnServers,
    });
    const connB = factoryB.createPeerConnection({
      localPeerId: "peer_019a000000007000800000000000030b",
      remotePeerId: "peer_019a000000007000800000000000030a",
      isInitiator: false,
      iceServers: refusedTurnServers,
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

      const startedAt = Date.now();
      const offer = await connA.createOffer();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const answer = await connB.acceptOfferAndCreateAnswer(offer);
      await connA.acceptAnswer(answer);

      await Promise.all([
        waitForChannelOpen(connA.controlChannel),
        waitForChannelOpen(connB.controlChannel),
      ]);

      const received = new Promise<string>((resolve) => {
        connB.controlChannel.onTextMessage((t) => resolve(t));
      });
      connA.controlChannel.sendText("recovered-over-host-after-tcp-turn-refused");
      expect(await received).toBe("recovered-over-host-after-tcp-turn-refused");
    } finally {
      connA.close();
      connB.close();
    }
  });

  test("DTLS fragmented Post-Quantum ClientHello regression: DtlsHandshakeReassembler & DtlsServer survive dropped frag0, duplicate tail fragments, and out-of-order 3-fragment flights without 'dtls cipher suite negotiation failed'", async () => {
    const reassembler = new DtlsHandshakeReassembler();
    const fullBodySeq0 = Buffer.from(randomBytes(2_550));
    const fullBodySeq1 = Buffer.from(randomBytes(1_800));

    const frag0 = {
      msg_type: 1,
      length: 2_550,
      message_seq: 0,
      fragment_offset: 0,
      fragment_length: 1_100,
      fragment: fullBodySeq0.subarray(0, 1_100),
    };
    const frag1 = {
      msg_type: 1,
      length: 2_550,
      message_seq: 0,
      fragment_offset: 1_100,
      fragment_length: 1_100,
      fragment: fullBodySeq0.subarray(1_100, 2_200),
    };
    const frag2 = {
      msg_type: 1,
      length: 2_550,
      message_seq: 0,
      fragment_offset: 2_200,
      fragment_length: 350,
      fragment: fullBodySeq0.subarray(2_200, 2_550),
    };

    // Exact production crash reproduction: frag0 dropped while [frag1, frag2] + duplicate frag2 arrive!
    expect(reassembler.ingest([frag1])).toEqual([]);
    expect(reassembler.ingest([frag2])).toEqual([]);
    expect(reassembler.ingest([frag2])).toEqual([]);

    // Interleaved fragment from message_seq=1 must not mix into message_seq=0
    expect(
      reassembler.ingest([
        {
          msg_type: 1,
          length: 1_800,
          message_seq: 1,
          fragment_offset: 0,
          fragment_length: 900,
          fragment: fullBodySeq1.subarray(0, 900),
        },
      ]),
    ).toEqual([]);

    // Now delayed/retransmitted frag0 arrives -> message_seq=0 completes intact!
    const done0 = reassembler.ingest([frag0]);
    expect(done0.length).toBe(1);
    expect(done0[0]!.message_seq).toBe(0);
    expect(done0[0]!.fragment_offset).toBe(0);
    expect(done0[0]!.fragment_length).toBe(2_550);
    expect(done0[0]!.fragment.equals(fullBodySeq0)).toBe(true);

    // Overlapping re-fragmented retransmission completes message_seq=1 cleanly
    expect(
      reassembler.ingest([
        {
          msg_type: 1,
          length: 1_800,
          message_seq: 1,
          fragment_offset: 800,
          fragment_length: 600,
          fragment: fullBodySeq1.subarray(800, 1_400),
        },
      ]),
    ).toEqual([]);
    const done1 = reassembler.ingest([
      {
        msg_type: 1,
        length: 1_800,
        message_seq: 1,
        fragment_offset: 1_300,
        fragment_length: 500,
        fragment: fullBodySeq1.subarray(1_300, 1_800),
      },
    ]);
    expect(done1.length).toBe(1);
    expect(done1[0]!.message_seq).toBe(1);
    expect(done1[0]!.fragment.equals(fullBodySeq1)).toBe(true);

    // Real werift DtlsServer <-> DtlsClient handshake where the network MTU splits ClientHello
    // into 3 DTLS handshake fragments, drops frag0 + delivers [frag2, frag1, frag2] first,
    // and delivers Flight 3 out-of-order [frag2, frag0, frag1]!
    ensureWeriftDtlsFragmentReassemblyGuarded();
    const {
      createSelfSignedCertificate,
      DtlsClient,
      DtlsServer,
      HashAlgorithm,
      NamedCurveAlgorithm,
      SignatureAlgorithm,
    } = await import("werift");

    const serverCert = await createSelfSignedCertificate(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );
    const clientCert = await createSelfSignedCertificate(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );

    let recSeq = 100;
    const splitClientHelloIntoThreeFragments = (
      record: Buffer,
    ): [Buffer, Buffer, Buffer] | null => {
      if (record.length < 25 || record[0] !== 22) return null;
      const epoch = record.readUInt16BE(3);
      if (epoch !== 0) return null;
      const hs = record.subarray(13);
      const msgType = hs[0]!;
      if (msgType !== 1) return null;
      const totalLen = hs.readUIntBE(1, 3);
      const msgSeq = hs.readUInt16BE(4);
      const body = hs.subarray(12, 12 + totalLen);
      if (body.length < 30) return null;

      const c1 = Math.floor(totalLen / 3);
      const c2 = Math.floor((totalLen * 2) / 3);
      const slices: Array<[number, Buffer]> = [
        [0, body.subarray(0, c1)],
        [c1, body.subarray(c1, c2)],
        [c2, body.subarray(c2)],
      ];

      return slices.map(([offset, chunk]) => {
        const out = Buffer.alloc(13 + 12 + chunk.length);
        out[0] = 22;
        out[1] = record[1]!;
        out[2] = record[2]!;
        out.writeUInt16BE(0, 3);
        out.writeUIntBE(++recSeq, 5, 6);
        out.writeUInt16BE(12 + chunk.length, 11);
        out[13] = msgType;
        out.writeUIntBE(totalLen, 14, 3);
        out.writeUInt16BE(msgSeq, 17);
        out.writeUIntBE(offset, 19, 3);
        out.writeUIntBE(chunk.length, 22, 3);
        chunk.copy(out, 25);
        return out;
      }) as [Buffer, Buffer, Buffer];
    };

    let clientHelloCount = 0;
    const serverSocket = {
      onData: (_buf: Buffer) => {},
      send: async (buf: Buffer) => {
        queueMicrotask(() => clientSocket.onData(Buffer.from(buf)));
      },
      close: () => {},
    };
    const clientSocket = {
      onData: (_buf: Buffer) => {},
      send: async (buf: Buffer) => {
        const records: Buffer[] = [];
        let pos = 0;
        while (pos + 13 <= buf.length) {
          const recLen = buf.readUInt16BE(pos + 11);
          if (pos + 13 + recLen > buf.length) break;
          records.push(Buffer.from(buf.subarray(pos, pos + 13 + recLen)));
          pos += 13 + recLen;
        }
        for (const rec of records) {
          const frags = splitClientHelloIntoThreeFragments(rec);
          if (frags) {
            clientHelloCount += 1;
            const [f0, f1, f2] = frags;
            if (clientHelloCount === 1) {
              // Flight 1: deliver [f2, f1, f2] first (f0 delayed!), which crashed unpatched werift 100% of the time!
              queueMicrotask(() => {
                serverSocket.onData(f2);
                serverSocket.onData(f1);
                serverSocket.onData(f2);
              });
              setTimeout(() => serverSocket.onData(f0), 15);
            } else {
              // Flight 3 (cookie ClientHello): deliver out-of-order [f2, f0, f1]
              queueMicrotask(() => {
                serverSocket.onData(f2);
                serverSocket.onData(f0);
                serverSocket.onData(f1);
              });
            }
            continue;
          }
          queueMicrotask(() => serverSocket.onData(rec));
        }
      },
      close: () => {},
    };

    const dtlsErrors: unknown[] = [];
    const server = new DtlsServer({
      cert: serverCert.certPem,
      key: serverCert.keyPem,
      signatureHash: serverCert.signatureHash,
      transport: serverSocket as never,
      extendedMasterSecret: true,
    });
    const client = new DtlsClient({
      cert: clientCert.certPem,
      key: clientCert.keyPem,
      signatureHash: clientCert.signatureHash,
      transport: clientSocket as never,
      extendedMasterSecret: true,
    });

    server.onError.subscribe((err) => dtlsErrors.push(err));
    client.onError.subscribe((err) => dtlsErrors.push(err));

    const serverConnected = new Promise<void>((resolve, reject) => {
      server.onConnect.once(() => resolve());
      server.onError.once((err) => reject(err));
    });
    const clientConnected = new Promise<void>((resolve, reject) => {
      client.onConnect.once(() => resolve());
      client.onError.once((err) => reject(err));
    });

    void client.connect();
    await Promise.all([serverConnected, clientConnected]);
    expect(clientHelloCount).toBeGreaterThanOrEqual(2);
    expect(dtlsErrors).toEqual([]);

    const serverReceived = new Promise<string>((resolve) => {
      server.onData.once((buf) => resolve(buf.toString("utf8")));
    });
    await client.send(Buffer.from("pq-fragmented-dtls-ok", "utf8"));
    expect(await serverReceived).toBe("pq-fragmented-dtls-ok");

    server.close();
    client.close();
  });
});

describe("CliApiClient BlindRelayClient", () => {
  test("attaches Bearer token on binary PUT/GET and decodes listed envelopes", async () => {
    const authHeaders: Array<string | null> = [];
    const envBytes = new Uint8Array(56).fill(0x33);
    const chunkBytes = new Uint8Array(96).fill(0x77);
    const boxId = "a".repeat(64);
    const blobId = "b".repeat(32);
    const fileTag = "c".repeat(32);
    const chunkBlobId = "d".repeat(32);

    const api = new CliApiClient({
      serverUrl: "http://127.0.0.1:3999",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        authHeaders.push(headers.get("authorization"));

        if (
          url.pathname === `/api/v1/relay/${boxId}/envelopes/${blobId}` &&
          init?.method === "PUT"
        ) {
          return Response.json(
            { ok: true, seq: 3, created: true, expiresAt: 1_900_000_000_000 },
            { status: 201 },
          );
        }
        if (
          url.pathname === `/api/v1/relay/${boxId}/envelopes/${blobId}` &&
          init?.method === "GET"
        ) {
          return new Response(envBytes, { status: 200 });
        }
        if (
          url.pathname === `/api/v1/relay/${boxId}/envelopes` &&
          init?.method === "GET"
        ) {
          const afterSeqParam = Number(url.searchParams.get("afterSeq") ?? "0");
          const cursorReset = afterSeqParam > 3;
          return Response.json({
            ok: true,
            items: [
              {
                seq: 3,
                blobId,
                payloadB64: bytesToBase64Url(envBytes),
                expiresAt: 1_900_000_000_000,
              },
            ],
            nextCursor: 3,
            hasMore: false,
            ...(cursorReset ? { cursorReset: true } : {}),
          });
        }
        if (
          url.pathname ===
            `/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkBlobId}` &&
          init?.method === "PUT"
        ) {
          return Response.json(
            { ok: true, created: true, expiresAt: 1_900_000_000_000 },
            { status: 201 },
          );
        }
        if (
          url.pathname ===
            `/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkBlobId}` &&
          init?.method === "GET"
        ) {
          return new Response(chunkBytes, { status: 200 });
        }
        return Response.json(
          { ok: false, error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
      }) as typeof fetch,
    });

    const relay = api.createBlindRelayClient("cli_tok_secret", {
      enabled: true,
      ttlMs: 86_400_000,
      maxFileBytes: 104_857_600,
      maxTotalBytes: 2_147_483_648,
    });
    expect(relay.enabled).toBe(true);

    const putEnv = await relay.putEnvelope({
      boxId,
      blobId,
      payload: envBytes,
    });
    expect(putEnv).toEqual({ seq: 3, expiresAt: 1_900_000_000_000 });

    expect(await relay.getEnvelope?.({ boxId, blobId })).toEqual(envBytes);
    expect(
      await relay.getEnvelope?.({ boxId, blobId: "0".repeat(32) }),
    ).toBeNull();

    const listed = await relay.listEnvelopes({ boxId, afterSeq: 0 });
    expect(listed.items[0]?.payload).toEqual(envBytes);
    expect(listed.cursorReset).toBeUndefined();

    const listedReset = await relay.listEnvelopes({ boxId, afterSeq: 99 });
    expect(listedReset.cursorReset).toBe(true);
    expect(listedReset.nextCursor).toBe(3);
    expect(listedReset.items[0]?.payload).toEqual(envBytes);

    const putCh = await relay.putChunk({
      boxId,
      fileTag,
      chunkBlobId,
      payload: chunkBytes,
    });
    expect(putCh.expiresAt).toBe(1_900_000_000_000);

    expect(await relay.getChunk({ boxId, fileTag, chunkBlobId })).toEqual(
      chunkBytes,
    );
    expect(
      await relay.getChunk({
        boxId,
        fileTag,
        chunkBlobId: "0".repeat(32),
      }),
    ).toBeNull();
    expect(authHeaders.every((h) => h === "Bearer cli_tok_secret")).toBe(true);
  });

  test("Issue #37 P0: CLI terminal sanitizer strips ANSI/OSC/CSI/C0/C1/BiDi sequences and indents multi-line chat continuations to prevent spoofing", async () => {
    // 1. Single-line sanitizer strips OSC 52 clipboard injection, OSC title, 8-bit C1 OSC,
    //    CSI clear-screen, DCS/APC, BiDi RLO, CR/LF, and stray control chars.
    const hostileDisplayName =
      "\x1b]52;c;cHduZWQ=\x07\x1b]0;evil-title\x1b\\\x9d2;c1title\x9c\x1b[2J\x1b[31mAlice\x1b[0m\u202e\r\n[12:00:00] @admin: ok\x1bPfoo\x1b\\\x00\x7f";
    const safeName = sanitizeTerminalSingleLine(hostileDisplayName);
    expect(safeName).toBe("Alice [12:00:00] @admin: ok");
    expect(safeName).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);

    // 2. Multi-line chat spoofing: newline or carriage-return attempts to forge another user's line
    const spoofBody =
      "Hello\x1b[31m!\x1b[0m\n[12:00:00] @alice: I approve wire transfer\r[12:00:01] @bob: confirmed\x1b]52;c;AAAA\x07";
    const formatted = formatCliChatMessage({
      clock: "12:00:00",
      username: "mallory\x1b[2K",
      body: spoofBody,
    });
    expect(formatted).toBe(
      [
        "[12:00:00] @mallory: Hello!",
        "  │ [12:00:00] @alice: I approve wire transfer",
        "  │ [12:00:01] @bob: confirmed",
      ].join("\n"),
    );
    expect(formatted).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);

    // 3. Tabs expand cleanly without control chars
    expect(sanitizeTerminalMultilineText("a\tb\u2028c")).toBe("a  b\nc");

    // 4. executeJoinInputLine /peers sanitizes hostile peer displayName in stdout
    const outChunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c) => outChunks.push(c.toString("utf8")));

    const fakeEngine = {
      isCenterConnected: () => true,
      getVerifiedPeers: () => [
        {
          peerId: "peer_019a00000000700080000000000000aa",
          userId: "usr_019a00000000700080000000000000aa",
          username: "mallory",
          displayName: "Mal\x1b[31m\n[room] forged\x1b]0;bad\x07",
          clientKind: "web" as const,
          rttMs: 12,
        },
      ],
    } as unknown as RoomPeerEngine;

    const tmpDir = await mkdtemp(join(tmpdir(), "simpleim-cli-sanitize-"));
    const chunkStorage = new FsChunkStorageAdapter({ downloadDir: tmpDir });
    const sharedFiles = new LocalSharedFileRegistry();
    try {
      await executeJoinInputLine({
        line: "/peers",
        engine: fakeEngine,
        chunkStorage,
        sharedFiles,
        stdout,
      });
      const rendered = outChunks.join("");
      expect(rendered).toContain("@mallory (Mal [room] forged) [web]");
      expect(rendered).not.toMatch(/\x1b|\x07/);
    } finally {
      await chunkStorage.closeAll();
      await sharedFiles.closeAll();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Issue #37 CLI P1/P2 Interactive UX", () => {
  test("pseudo-TTY interactive session preserves partial user input across async incoming messages, eliminates double-echo, supports Ctrl+C exit, and completes slash commands & fileIds", async () => {
    const ttyIn = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        this.isRaw = mode;
        return this;
      },
    });
    const ttyOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
    });
    const ttyErr = new PassThrough();

    let capturedOut = "";
    ttyOut.on("data", (chunk) => {
      capturedOut += chunk.toString("utf8");
    });

    const submittedLines: string[] = [];
    let exited = false;

    const sampleManifest = await createSignedManifestFixture({
      roomId: "f".repeat(64),
      fileName: "report.pdf",
      bytes: new TextEncoder().encode("pdf"),
      fileId: "019a7777-0000-7000-8000-000000000001",
    });

    let resolveSecondLine!: () => void;
    const secondLinePromise = new Promise<void>((r) => {
      resolveSecondLine = r;
    });

    const terminal = new InteractiveJoinTerminal({
      stdin: ttyIn,
      stdout: ttyOut,
      stderr: ttyErr,
      env: { NO_COLOR: "1" },
      getFiles: () => [sampleManifest],
      onLine: async (line) => {
        submittedLines.push(line);
        if (submittedLines.length === 1) {
          terminal.eraseJustSubmittedSingleLineEcho(line);
          terminal.writeLine(`[12:00:02] @alice: ${line}`);
        } else {
          resolveSecondLine();
        }
        return "continue";
      },
      onExit: () => {
        exited = true;
      },
    });

    expect(terminal.isInteractive).toBe(true);
    expect(terminal.palette.enabled).toBe(false); // NO_COLOR=1 honored
    terminal.startPrompt();

    // User starts typing a message WITHOUT pressing Enter yet
    ttyIn.write("hello wo");
    await Bun.sleep(15);

    // Incoming remote chat message arrives mid-typing -> must clear active line,
    // print incoming message cleanly, and redraw prompt + untouched partial input!
    terminal.writeAsyncLine("[12:00:01] @bob: incoming ping!");
    await Bun.sleep(15);

    expect(capturedOut).toContain("[12:00:01] @bob: incoming ping!\n");
    // Prompt and buffered input were restored right after the incoming message
    const afterIncoming = capturedOut.slice(
      capturedOut.indexOf("incoming ping!\n") + "incoming ping!\n".length,
    );
    expect(afterIncoming).toContain("❯ ");
    expect(afterIncoming).toContain("hello wo");
    expect(afterIncoming).not.toContain("\x1b[1A");

    // User finishes typing "rld" and presses Enter -> exact intact message submitted!
    ttyIn.write("rld\r");
    await Bun.sleep(25);
    expect(submittedLines).toEqual(["hello world"]);
    // Single-line echo erasure sequence emitted before formatted self-line
    expect(capturedOut).toContain("\x1b[1A\r\x1b[2K[12:00:02] @alice: hello world\n");

    // Second line works cleanly, and Ctrl+C (\x03) triggers clean exit callback
    ttyIn.write("/peers\r");
    await secondLinePromise;
    expect(submittedLines).toEqual(["hello world", "/peers"]);

    ttyIn.write("\x03");
    await Bun.sleep(15);
    expect(exited).toBe(true);
    terminal.close();

    // Tab completer completes slash commands and unambiguous fileId selectors
    const secondSameBucketManifest = await createSignedManifestFixture({
      roomId: "f".repeat(64),
      fileName: "report-2.pdf",
      bytes: new TextEncoder().encode("pdf2"),
      fileId: "019a7777-0000-7000-8000-000000000002",
    });
    const completer = createJoinCompleter(() => [
      sampleManifest,
      secondSameBucketManifest,
    ]);
    expect(completer("/pe")[0]).toEqual(["/peers"]);
    expect(completer("/ca")[0]).toEqual(["/cancel "]);
    expect(completer("/get 0000000")[0]).toEqual([
      "/get 00000001",
      "/get 00000002",
    ]);
    expect(completer("/cancel 1")[0]).toEqual(["/cancel 1"]);

    // Wrapped multi-row input (20-col TTY, 30 typed chars): async incoming output clears all
    // wrapped rows and resets redraw tracking so _refreshLine NEVER moves up to erase the event!
    const narrowIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const narrowOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
    });
    let narrowBuf = "";
    narrowOut.on("data", (c) => {
      narrowBuf += c.toString("utf8");
    });
    const narrowTerm = new InteractiveJoinTerminal({
      stdin: narrowIn,
      stdout: narrowOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      onLine: async () => "continue",
    });
    narrowTerm.startPrompt();
    narrowIn.write("123456789012345678901234567890");
    await Bun.sleep(15);

    narrowBuf = "";
    narrowTerm.writeAsyncLine("[12:00:05] @bob: FIRST_WRAPPED");
    const afterFirst = narrowBuf.slice(
      narrowBuf.indexOf("FIRST_WRAPPED\n") + "FIRST_WRAPPED\n".length,
    );
    expect(narrowBuf).toContain("\x1b[1A");
    expect(afterFirst).not.toContain("\x1b[1A");
    expect(afterFirst).toContain("❯ 123456789012345678901234567890");

    narrowBuf = "";
    narrowTerm.writeAsyncLine("[12:00:06] @bob: SECOND_WRAPPED");
    const afterSecond = narrowBuf.slice(
      narrowBuf.indexOf("SECOND_WRAPPED\n") + "SECOND_WRAPPED\n".length,
    );
    expect(afterSecond).not.toContain("\x1b[1A");
    expect(afterSecond).toContain("❯ 123456789012345678901234567890");
    narrowTerm.close();

    // Piped stdin reaching immediate EOF drains ALL queued async commands (including /quit)
    const pipedIn = new PassThrough();
    const drained: string[] = [];
    let pipedExited = false;
    let pipedEof = false;
    let resolvePipedDone!: () => void;
    const pipedDone = new Promise<void>((r) => {
      resolvePipedDone = r;
    });
    const pipedTerm = new InteractiveJoinTerminal({
      stdin: pipedIn,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onLine: async (line) => {
        await Bun.sleep(15);
        drained.push(line);
        return line === "/quit" ? "exit" : "continue";
      },
      onExit: () => {
        pipedExited = true;
        resolvePipedDone();
      },
      onInputEof: () => {
        pipedEof = true;
      },
    });
    pipedIn.end("one\ntwo\n/quit\n");
    await pipedDone;
    expect(drained).toEqual(["one", "two", "/quit"]);
    expect(pipedExited).toBe(true);
    expect(pipedEof).toBe(false);
    pipedTerm.close();

    // Pasting multiple lines ("one\rtwo\r") onto a TTY must NOT emit \x1b[1A and erase
    // the formatted first message when rendering the second message!
    const pasteIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const pasteOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
    });
    let pasteBuf = "";
    pasteOut.on("data", (c) => {
      pasteBuf += c.toString("utf8");
    });
    let pasteCount = 0;
    let resolvePasteDone!: () => void;
    const pasteDone = new Promise<void>((r) => {
      resolvePasteDone = r;
    });
    const pasteTerm = new InteractiveJoinTerminal({
      stdin: pasteIn,
      stdout: pasteOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      onLine: async (line) => {
        await Bun.sleep(10);
        pasteTerm.eraseJustSubmittedSingleLineEcho(line);
        pasteTerm.writeLine(`[12:00:10] @alice: ${line}`);
        pasteCount += 1;
        if (pasteCount === 2) resolvePasteDone();
        return "continue";
      },
    });
    pasteTerm.startPrompt();
    pasteIn.write("one\rtwo\r");
    await pasteDone;
    expect(pasteBuf).toContain("[12:00:10] @alice: one\n");
    expect(pasteBuf).toContain("[12:00:10] @alice: two\n");
    expect(pasteBuf).not.toContain("\x1b[1A");
    pasteTerm.close();

    // Typing ahead while an async command handler is still running preserves cursor position
    // (submitting "one", typing "partial" mid-flight, then "X\r" must yield "partialX", not "Xpartial")
    const aheadIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const aheadOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
    });
    const aheadLines: string[] = [];
    let resolveAheadDone!: () => void;
    const aheadDone = new Promise<void>((r) => {
      resolveAheadDone = r;
    });
    const aheadTerm = new InteractiveJoinTerminal({
      stdin: aheadIn,
      stdout: aheadOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      onLine: async (line) => {
        aheadLines.push(line);
        if (aheadLines.length === 1) {
          await Bun.sleep(25);
          aheadTerm.writeLine("[done] one");
        } else {
          resolveAheadDone();
        }
        return "continue";
      },
    });
    aheadTerm.startPrompt();
    aheadIn.write("one\r");
    await Bun.sleep(5);
    aheadIn.write("partial");
    await Bun.sleep(35);
    aheadIn.write("X\r");
    await aheadDone;
    expect(aheadLines).toEqual(["one", "partialX"]);
    aheadTerm.close();

    // Wrapped type-ahead (30 chars on 20-col TTY) during an async command retains
    // readline's wrapped-row tracking so prompt restoration moves up before redrawing!
    const wrappedAheadIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const wrappedAheadOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
    });
    let wrappedAheadBuf = "";
    wrappedAheadOut.on("data", (c) => {
      wrappedAheadBuf += c.toString("utf8");
    });
    let resolveWrappedCmd!: () => void;
    const wrappedCmdGate = new Promise<void>((r) => {
      resolveWrappedCmd = r;
    });
    const wrappedAheadTerm = new InteractiveJoinTerminal({
      stdin: wrappedAheadIn,
      stdout: wrappedAheadOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      onLine: async () => {
        await wrappedCmdGate;
        return "continue";
      },
    });
    wrappedAheadTerm.startPrompt();
    wrappedAheadIn.write("first\r");
    await Bun.sleep(10);
    wrappedAheadIn.write("123456789012345678901234567890");
    await Bun.sleep(10);
    wrappedAheadBuf = "";
    resolveWrappedCmd();
    await Bun.sleep(20);
    expect(wrappedAheadBuf).toContain("\x1b[1A");
    expect(wrappedAheadBuf).toContain("❯ 123456789012345678901234567890");
    wrappedAheadTerm.close();

    // Production wiring: executeJoinInputLine routed through createCommandOutputStream()
    // on a 20-col TTY with 30 wrapped type-ahead chars clears the wrapped input BEFORE
    // printing the command result and NEVER emits \x1b[1A after the result!
    const wiredIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const wiredOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
    });
    let wiredBuf = "";
    wiredOut.on("data", (c) => {
      wiredBuf += c.toString("utf8");
    });
    const wiredWorkDir = await makeTempDir("wired-tty");
    const wiredFile = join(wiredWorkDir, "wired.txt");
    await writeFile(wiredFile, "wired-data");
    let releaseShare!: () => void;
    const shareGate = new Promise<void>((r) => {
      releaseShare = r;
    });
    const wiredFiles: FileManifest[] = [];
    const wiredEngine = {
      roomId: "f".repeat(64),
      localPeerId: "peer_019a0000000070008000000000000099",
      getFiles: () => wiredFiles,
      getMessages: () => [],
      shareFile: async () => {
        await shareGate;
        wiredFiles.push(sampleManifest);
        return sampleManifest;
      },
    } as unknown as RoomPeerEngine;
    const wiredStorage = new FsChunkStorageAdapter({
      downloadDir: join(wiredWorkDir, "dl"),
    });
    const wiredShared = new LocalSharedFileRegistry();
    const wiredTerm: InteractiveJoinTerminal = new InteractiveJoinTerminal({
      stdin: wiredIn,
      stdout: wiredOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      getFiles: () => wiredFiles,
      onLine: async (rawLine): Promise<"continue" | "exit"> =>
        executeJoinInputLine({
          line: rawLine,
          engine: wiredEngine,
          chunkStorage: wiredStorage,
          sharedFiles: wiredShared,
          stdout: wiredTerm.createCommandOutputStream("stdout"),
          cwd: wiredWorkDir,
        }),
    });
    try {
      wiredTerm.startPrompt();
      wiredIn.write(`/send ${wiredFile}\r`);
      await Bun.sleep(10);
      // 30 single-cell accented characters ('é') on a 20-col TTY occupy exactly 2 rows
      // (1 row up), NEVER 3 rows up (\x1b[3A) as a naive non-ASCII=2 estimate would emit!
      wiredIn.write("é".repeat(30));
      await Bun.sleep(10);
      wiredBuf = "";
      releaseShare();
      await Bun.sleep(30);
      expect(wiredBuf).toContain("\x1b[1A");
      expect(wiredBuf).not.toContain("\x1b[2A");
      expect(wiredBuf).not.toContain("\x1b[3A");
      expect(wiredBuf).toContain("[file] Announced 'report.pdf'");
      const afterAnnouncement = wiredBuf.slice(
        wiredBuf.indexOf("[file] Announced 'report.pdf'"),
      );
      expect(afterAnnouncement).not.toContain("\x1b[1A");
      expect(afterAnnouncement).toContain(`❯ ${"é".repeat(30)}`);
    } finally {
      wiredTerm.close();
      await wiredShared.closeAll();
      await wiredStorage.closeAll();
    }

    // /get 1 + 30 wrapped type-ahead chars in one chunk + mid-command async progress:
    // writeAsyncLine MUST NOT move upward after command output already hid the type-ahead!
    const dlIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const dlOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 20,
    });
    let dlBuf = "";
    dlOut.on("data", (c) => {
      dlBuf += c.toString("utf8");
    });
    const dlStorage = new FsChunkStorageAdapter({
      downloadDir: join(wiredWorkDir, "dl2"),
    });
    const dlShared = new LocalSharedFileRegistry();
    const dlEngine = {
      roomId: "f".repeat(64),
      localPeerId: "peer_019a0000000070008000000000000099",
      getFiles: () => [sampleManifest],
      getMessages: () => [],
      downloadFile: async () => {
        dlTerm.writeAsyncLine("[file] Downloading 'report.pdf' 25%");
      },
    } as unknown as RoomPeerEngine;
    const dlTerm: InteractiveJoinTerminal = new InteractiveJoinTerminal({
      stdin: dlIn,
      stdout: dlOut,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
      getFiles: () => [sampleManifest],
      onLine: async (rawLine): Promise<"continue" | "exit"> =>
        executeJoinInputLine({
          line: rawLine,
          engine: dlEngine,
          chunkStorage: dlStorage,
          sharedFiles: dlShared,
          stdout: dlTerm.createCommandOutputStream("stdout"),
          cwd: wiredWorkDir,
        }),
    });
    try {
      dlTerm.startPrompt();
      dlBuf = "";
      dlIn.write(`/get 1\r${"a".repeat(30)}`);
      await Bun.sleep(30);
      const startIdx = dlBuf.indexOf("[file] Starting Swarm download");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      const afterStart = dlBuf.slice(startIdx);
      expect(afterStart).not.toContain("\x1b[1A");
      expect(afterStart).toContain("[file] Downloading 'report.pdf' 25%\n");
      expect(afterStart).toContain(`❯ ${"a".repeat(30)}`);
    } finally {
      dlTerm.close();
      await dlShared.closeAll();
      await dlStorage.closeAll();
    }
  });

  test("parses /send paths (~, quotes, Finder escaped spaces), formats friendly FS errors, supports /cancel, /reply, /retry, and join --json NDJSON", async () => {
    const workDir = await makeTempDir("join-p1-ux");
    const fakeHome = join(workDir, "home");
    const docsDir = join(fakeHome, "Docs");
    await Bun.write(join(docsDir, "My Report (Final).pdf"), "PDF_CONTENT");

    // Path parser handles ~, single quotes, double quotes, POSIX escaped Finder paths,
    // AND preserves native Windows drive/UNC backslashes intact
    expect(
      parseCliFilePathInput("~/Docs/My\\ Report\\ \\(Final\\).pdf", fakeHome, "darwin"),
    ).toBe(join(docsDir, "My Report (Final).pdf"));
    expect(
      parseCliFilePathInput(`'${join(docsDir, "My Report (Final).pdf")}'`, fakeHome, "darwin"),
    ).toBe(join(docsDir, "My Report (Final).pdf"));
    expect(
      parseCliFilePathInput(`"${join(docsDir, "My Report (Final).pdf")}"`, fakeHome, "darwin"),
    ).toBe(join(docsDir, "My Report (Final).pdf"));
    expect(
      parseCliFilePathInput("C:\\Users\\alice\\report.pdf", "C:\\Users\\alice", "win32"),
    ).toBe("C:\\Users\\alice\\report.pdf");
    expect(
      parseCliFilePathInput('"C:\\Users\\alice\\My Report.pdf"', "C:\\Users\\alice", "win32"),
    ).toBe("C:\\Users\\alice\\My Report.pdf");
    expect(
      parseCliFilePathInput("\\\\filesrv\\share\\bundle.zip", "C:\\Users\\alice", "win32"),
    ).toBe("\\\\filesrv\\share\\bundle.zip");
    expect(
      parseCliFilePathInput("~\\Documents\\notes.txt", "C:\\Users\\alice", "win32"),
    ).toBe("C:\\Users\\alice\\Documents\\notes.txt");
    expect(
      parseCliFilePathInput("relative\\path\\file.bin", "C:\\Users\\alice", "win32"),
    ).toBe("relative\\path\\file.bin");
    expect(formatCliFsError({ code: "ENOENT" }, "/missing/file.bin")).toBe(
      "File not found: /missing/file.bin",
    );
    expect(formatCliFsError({ code: "EISDIR" }, "/tmp")).toBe(
      "Expected a file, but path is a directory: /tmp",
    );

    const roomId = "e".repeat(64);
    const serverKeys = generateEd25519KeyPair();
    const peerKeys = generateEd25519KeyPair();
    const peerId = "peer_019a9999000070008000000000000001";
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

    const files: FileManifest[] = [];
    const messages: ChatMessageEnvelope[] = [];
    const downloadedIds: string[] = [];
    const cancelledIds: string[] = [];
    const transferStatuses = new Map<
      string,
      "announced" | "downloading" | "seeding" | "paused" | "error"
    >();
    let retryCount = 0;

    const mockEngine: RoomPeerEngine = {
      roomId,
      localPeerId: peerId,
      start: async () => {},
      stop: async () => {},
      updateLocalCert: () => {},
      isCenterConnected: () => true,
      getSignalingPeerCount: () => 0,
      getVerifiedPeers: () => [],
      getMessages: () => messages,
      getChatDeliveryStates: () => new Map(),
      getFiles: () => files,
      getTransferProgress: (fileId) => {
        const manifest = files.find((f) => f.fileId === fileId);
        const status = transferStatuses.get(fileId);
        if (!manifest || !status) return undefined;
        return {
          fileId,
          fileName: manifest.fileName,
          fileSize: manifest.fileSize,
          totalChunks: manifest.totalChunks,
          completedChunks: status === "seeding" ? manifest.totalChunks : 0,
          bytesCompleted: status === "seeding" ? manifest.fileSize : 0,
          downloadSpeedBytesPerSec: 0,
          availableSeeders: 1,
          availablePeersWithChunks: 1,
          status,
        };
      },
      sendChatMessage: async (body, replyToMsgId) => {
        const msg = signChatMessage({
          roomId,
          lamport: messages.length + 1,
          body,
          replyToMsgId: replyToMsgId ?? undefined,
          authorCert: cert,
          peerSignPrivKey: peerKeys.privateKeyBytes,
        });
        messages.push(msg);
        return msg;
      },
      retryChatMessage: async () => {
        retryCount += 1;
      },
      flushPendingRelayKeepalive: () => {},
      shareFile: async (input) => {
        const m = await createSignedFileManifestFromChunks({
          roomId,
          fileName: input.fileName,
          fileSize: input.fileSize,
          mimeType: input.mimeType,
          readChunk: input.readChunk,
          senderCert: cert,
          peerSignPrivKey: peerKeys.privateKeyBytes,
        });
        files.push(m);
        transferStatuses.set(m.fileId, "seeding");
        return m;
      },
      downloadFile: async (fileId) => {
        downloadedIds.push(fileId);
        transferStatuses.set(fileId, "downloading");
      },
      cancelDownload: async (fileId) => {
        cancelledIds.push(fileId);
        transferStatuses.set(fileId, "paused");
      },
    };

    const chunkStorage = new FsChunkStorageAdapter({
      downloadDir: join(workDir, "dl"),
    });
    const sharedFiles = new LocalSharedFileRegistry();

    const jsonLines: Record<string, unknown>[] = [];
    const jsonStdout = new PassThrough();
    jsonStdout.on("data", (c) => {
      for (const l of c.toString("utf8").split("\n")) {
        if (l.trim()) jsonLines.push(JSON.parse(l) as Record<string, unknown>);
      }
    });

    let humanOut = "";
    const humanStdout = new PassThrough();
    humanStdout.on("data", (c) => {
      humanOut += c.toString("utf8");
    });

    try {
      // /send with Finder backslash-escaped spaces & tilde expansion
      await executeJoinInputLine({
        line: "/send ~/Docs/My\\ Report\\ \\(Final\\).pdf",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
        homeDir: fakeHome,
      });
      expect(files.length).toBe(1);
      expect(files[0]!.fileName).toBe("My Report (Final).pdf");

      // Missing file produces clean friendly error (no raw ENOENT stack noise)
      await expect(
        executeJoinInputLine({
          line: "/send '/nonexistent/Ghost File.pdf'",
          engine: mockEngine,
          chunkStorage,
          sharedFiles,
          stdout: humanStdout,
          cwd: workDir,
          homeDir: fakeHome,
        }),
      ).rejects.toThrow("File not found: /nonexistent/Ghost File.pdf");

      // /cancel refuses to destroy a locally shared (seeding) file
      await executeJoinInputLine({
        line: "/cancel 1",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      expect(cancelledIds).toEqual([]);
      expect(humanOut).toContain("already completed/seeding");

      // Two files sharing the exact same 65-second UUIDv7 timestamp prefix get unambiguous
      // random-tail selectors (and numeric-only tails like "00000002" resolve by ID, not list index!)
      const sameBucketA = await createSignedManifestFixture({
        roomId,
        fileName: "same-minute-a.bin",
        bytes: new TextEncoder().encode("A"),
        fileId: "019a8888-1111-7000-8000-000000000001",
      });
      const sameBucketB = await createSignedManifestFixture({
        roomId,
        fileName: "same-minute-b.bin",
        bytes: new TextEncoder().encode("B"),
        fileId: "019a8888-1111-7000-8000-000000000002",
      });
      files.push(sameBucketA, sameBucketB);
      const selA = formatUniqueFileSelector(
        sameBucketA.fileId,
        files.map((f) => f.fileId),
      );
      const selB = formatUniqueFileSelector(
        sameBucketB.fileId,
        files.map((f) => f.fileId),
      );
      expect(selA).toBe("00000001");
      expect(selB).toBe("00000002");
      await executeJoinInputLine({
        line: `/get ${selB}`,
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      expect(downloadedIds).toEqual([sameBucketB.fileId]);
      // Now that sameBucketB is actively downloading, /cancel succeeds!
      await executeJoinInputLine({
        line: `/cancel ${selB}`,
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      expect(cancelledIds).toEqual([sameBucketB.fileId]);
      expect(humanOut).toContain("Cancelled download for 'same-minute-b.bin'");
      // Shared 8-char timestamp prefix is correctly flagged as ambiguous
      await expect(
        executeJoinInputLine({
          line: "/get 019a8888",
          engine: mockEngine,
          chunkStorage,
          sharedFiles,
          stdout: humanStdout,
          cwd: workDir,
        }),
      ).rejects.toThrow("Ambiguous fileId");

      // Chat + /reply renders reply quote context & /retry invokes engine.retryChatMessage
      await executeJoinInputLine({
        line: "Original statement",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      await executeJoinInputLine({
        line: "/reply last Agreed!",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      expect(humanOut).toContain("↳ replying to @alice: Original statement");
      expect(messages[1]!.replyToMsgId).toBe(messages[0]!.msgId);

      await executeJoinInputLine({
        line: "/retry",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: humanStdout,
        cwd: workDir,
      });
      expect(retryCount).toBe(1);

      // --json mode emits clean NDJSON objects for chat, /files, and /cancel
      await executeJoinInputLine({
        line: "JSON hello",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: jsonStdout,
        cwd: workDir,
        json: true,
      });
      await executeJoinInputLine({
        line: "/files",
        engine: mockEngine,
        chunkStorage,
        sharedFiles,
        stdout: jsonStdout,
        cwd: workDir,
        json: true,
      });
      expect(jsonLines.map((e) => e.type)).toEqual(["chat_sent", "files_snapshot"]);
      expect(jsonLines[0]!.body).toBe("JSON hello");
    } finally {
      await sharedFiles.closeAll();
      await chunkStorage.closeAll();
    }
  });

  test("throttles download & relay progress with speed/ETA, formats Web-aligned fingerprints/timestamps/shortIds, and renders topic --help & seed human output", () => {
    const tracker = new JoinTransferProgressTracker();
    const fileId = "019a8888-1111-7000-8000-000000000099";

    const first = tracker.consume(
      {
        fileId,
        fileName: "archive.tar.gz",
        fileSize: 2 * 1024 * 1024,
        totalChunks: 32,
        completedChunks: 8,
        bytesCompleted: 512 * 1024,
        downloadSpeedBytesPerSec: 512 * 1024,
        availableSeeders: 2,
        availablePeersWithChunks: 2,
        status: "downloading",
      },
      1_000,
    );
    expect(first.length).toBe(1);
    expect(first[0]).toContain("Downloading 'archive.tar.gz' 25%");
    expect(first[0]).toContain("ETA 3s");
    expect(first[0]).toContain("[peers: 2]");

    // Rapid follow-up within 500ms is throttled
    expect(
      tracker.consume(
        {
          fileId,
          fileName: "archive.tar.gz",
          fileSize: 2 * 1024 * 1024,
          totalChunks: 32,
          completedChunks: 10,
          bytesCompleted: 640 * 1024,
          downloadSpeedBytesPerSec: 512 * 1024,
          availableSeeders: 2,
          availablePeersWithChunks: 2,
          status: "downloading",
        },
        1_200,
      ),
    ).toEqual([]);

    // Pause and relay caching transitions emit crisp updates
    const paused = tracker.consume(
      {
        fileId,
        fileName: "archive.tar.gz",
        fileSize: 2 * 1024 * 1024,
        totalChunks: 32,
        completedChunks: 10,
        bytesCompleted: 640 * 1024,
        downloadSpeedBytesPerSec: 0,
        availableSeeders: 1,
        availablePeersWithChunks: 1,
        status: "paused",
        relayCacheState: "uploading",
        relayCachedChunks: 4,
      },
      2_000,
    );
    expect(paused[0]).toContain("Paused 'archive.tar.gz' at 31% — run '/get 00000099' to resume");
    expect(paused[1]).toContain("[relay] Caching 'archive.tar.gz' 12% (4/32 chunks)");

    const cached = tracker.consume(
      {
        fileId,
        fileName: "archive.tar.gz",
        fileSize: 2 * 1024 * 1024,
        totalChunks: 32,
        completedChunks: 32,
        bytesCompleted: 2 * 1024 * 1024,
        downloadSpeedBytesPerSec: 0,
        availableSeeders: 1,
        availablePeersWithChunks: 1,
        status: "seeding",
        relayCacheState: "cached",
        relayCachedChunks: 32,
      },
      3_000,
    );
    expect(cached).toEqual(["[relay] Cached 'archive.tar.gz' for offline peers"]);

    // Fingerprint matches Web `#xxxxxxxx`, short IDs use random tail, and old sync messages include YYYY-MM-DD
    expect(formatCliRoomFingerprint("D7276E1899aabbcc")).toBe("#d7276e18");
    expect(formatShortId("peer_019a1234567890abcdef", 8)).toBe("peer_90abcdef");
    expect(formatShortId(fileId, 8)).toBe("00000099");

    const nowMs = new Date(2026, 10, 28, 15, 0, 0).getTime();
    const todayMs = new Date(2026, 10, 28, 9, 5, 4).getTime();
    const yesterdayMs = new Date(2026, 10, 27, 22, 10, 30).getTime();
    expect(formatCliTimestamp(todayMs, nowMs)).toBe("09:05:04");
    expect(formatCliTimestamp(yesterdayMs, nowMs)).toBe("2026-11-27 22:10:30");

    // Color detection respects isTTY & NO_COLOR
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);

    // Topic --help covers join slash commands, -u, ./downloads, and --passphrase-stdin
    const joinHelp = formatHelpText("join");
    expect(joinHelp).toContain("/cancel <fileId|index>");
    expect(joinHelp).toContain("./downloads");
    expect(joinHelp).toContain("--passphrase-stdin");
    expect(formatHelpText("register")).toContain("-u, --username");
    expect(formatHelpText("seed")).toContain("human-readable");

    // Seed human event formatter omits filenames and stays readable
    expect(
      formatSeedQuotaHumanEvent({
        kind: "accepted",
        fileId,
        fileSize: 65_536,
        totalChunks: 1,
      }),
    ).toBe("[seed] Caching file 00000099 (64.0 KiB, 1 chunks)...");
  });

  test("register pre-validates username locally, prompts server/displayName/confirm-password on interactive TTY, and adds --server hint on network errors", async () => {
    const configDir = await makeTempDir("reg-ux");
    expect(() => validateRegisterUsernameLocal("ab")).toThrow("Invalid username");
    expect(() => validateRegisterUsernameLocal("bad space")).toThrow("Invalid username");
    expect(validateRegisterUsernameLocal("Alice_01")).toBe("alice_01");

    // 1. Local username validation rejects BEFORE requesting password or hitting network
    let networkCalls = 0;
    const badUserStderr = new PassThrough();
    let badUserErr = "";
    badUserStderr.on("data", (c) => {
      badUserErr += c.toString("utf8");
    });
    const badCode = await runCli(
      ["register", "--server", "http://127.0.0.1:3999", "-u", "x", "--config-dir", configDir],
      {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: badUserStderr,
        fetchImpl: (async () => {
          networkCalls += 1;
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
      },
    );
    expect(badCode).toBe(1);
    expect(networkCalls).toBe(0);
    expect(badUserErr).toContain("Invalid username");

    // 2. Network failure appends actionable --server hint
    const netStdin = new PassThrough();
    netStdin.end("ValidPass!123\n");
    const netStderr = new PassThrough();
    let netErr = "";
    netStderr.on("data", (c) => {
      netErr += c.toString("utf8");
    });
    const netCode = await runCli(
      [
        "register",
        "-u",
        "alice_net",
        "--password-stdin",
        "--config-dir",
        configDir,
      ],
      {
        stdin: netStdin,
        stdout: new PassThrough(),
        stderr: netStderr,
        env: {},
        fetchImpl: (async () => {
          throw new Error("Connection refused");
        }) as unknown as typeof fetch,
      },
    );
    expect(netCode).toBe(1);
    expect(netErr).toContain("Pass --server <url> or set SIMPLEIM_SERVER_URL");

    // 3. Interactive TTY register prompts for server URL, display name, and password confirmation
    const makeFakeTty = () => {
      const stream = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode(mode: boolean) {
          this.isRaw = mode;
          return this;
        },
      });
      return stream;
    };

    const mismatchTty = makeFakeTty();
    const mismatchErr = new PassThrough();
    let mismatchText = "";
    mismatchErr.on("data", (c) => {
      mismatchText += c.toString("utf8");
    });
    const mismatchPromise = runCli(
      ["register", "--config-dir", configDir],
      {
        stdin: mismatchTty,
        stdout: new PassThrough(),
        stderr: mismatchErr,
        env: {},
        fetchImpl: (async () => {
          networkCalls += 1;
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
      },
    );
    // Feed: server URL, username, display name, password, mismatched confirmation
    await Bun.sleep(10);
    mismatchTty.write("https://im.example.com\n");
    await Bun.sleep(10);
    mismatchTty.write("tty_alice\n");
    await Bun.sleep(10);
    mismatchTty.write("TTY Alice\n");
    await Bun.sleep(10);
    mismatchTty.write("CorrectPass!99\r");
    await Bun.sleep(10);
    mismatchTty.write("WrongPass!99\r");

    expect(await mismatchPromise).toBe(1);
    expect(networkCalls).toBe(0);
    expect(mismatchText).toContain("Server URL [");
    expect(mismatchText).toContain("Display name (optional");
    expect(mismatchText).toContain("Confirm password:");
    expect(mismatchText).toContain("Passwords do not match");
  });
});
