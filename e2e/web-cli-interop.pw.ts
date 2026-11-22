import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";

const HARNESS_SCRIPT = resolve(import.meta.dirname, "./harness-worker.ts");

function resolveBunExecutable(): string {
  if (process.env.BUN_BIN) {
    return process.env.BUN_BIN;
  }
  const homeBun = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(homeBun)) {
    return homeBun;
  }
  return "bun";
}

function makeDeterministicBuffer(byteLength: number, seedByte: number): Buffer {
  const buf = Buffer.alloc(byteLength);
  let state = (0x85ebca6b ^ (seedByte & 0xff)) >>> 0;
  for (let i = 0; i < byteLength; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buf[i] = (state + i * 29) & 0xff;
  }
  return buf;
}

function sha256HexNode(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

class BunHarnessClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();

  constructor() {
    const bunBin = resolveBunExecutable();
    this.proc = spawn(bunBin, ["run", HARNESS_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const rl = createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(trimmed) as {
          id: number;
          ok: boolean;
          result?: unknown;
          error?: string;
        };
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        waiter.resolve(msg.result);
      } else {
        waiter.reject(new Error(msg.error ?? "Harness RPC error"));
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness] ${chunk.toString("utf8")}`);
    });

    this.proc.on("exit", (code) => {
      for (const [, waiter] of this.pending) {
        waiter.reject(
          new Error(`Harness process exited unexpectedly with code ${code}`),
        );
      }
      this.pending.clear();
    });
  }

  call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        resolve: (v) => resolvePromise(v as T),
        reject: rejectPromise,
      });
      this.proc.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        "utf8",
      );
    });
  }

  async close(): Promise<void> {
    try {
      await this.call("shutdown");
    } catch {
      this.proc.kill("SIGTERM");
    }
  }
}

interface CliStateSnapshot {
  centerConnected: boolean;
  verifiedPeers: Array<{
    peerId: string;
    username: string;
    displayName: string;
    clientKind: "web" | "cli";
  }>;
  messages: Array<{
    msgId: string;
    body: string;
    replyToMsgId: string | null;
    authorUsername: string;
    authorClientKind: "web" | "cli";
  }>;
  files: Array<{
    fileId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    fileSha256: string;
  }>;
  completedFileIds: string[];
}

async function registerAndJoinRoomOnWeb(params: {
  page: Page;
  webOrigin: string;
  username: string;
  displayName: string;
  password: string;
  passphrase: string;
}): Promise<void> {
  const { page } = params;
  await page.goto(params.webOrigin);

  await page.getByTestId("auth-tab-register").click();
  await page.getByTestId("auth-username").fill(params.username);
  await page.getByTestId("auth-display-name").fill(params.displayName);
  await page.getByTestId("auth-password").fill(params.password);
  await page.getByTestId("auth-submit").click();

  await expect(page.getByTestId("room-passphrase")).toBeVisible();
  await page.getByTestId("room-passphrase").fill(params.passphrase);
  await page.getByTestId("room-join-submit").click();

  await expect(page.getByTestId("connection-badge")).toHaveAttribute(
    "data-connection-state",
    "connected",
    { timeout: 25_000 },
  );
}

test.describe("Web (Chromium WebRTC + OPFS) <-> CLI (werift + Disk) Full-Stack E2E", () => {
  let harness: BunHarnessClient;

  test.beforeEach(() => {
    harness = new BunHarnessClient();
  });

  test.afterEach(async () => {
    await harness.close();
  });

  test("establishes Web<->Web & Web<->CLI HELLO_AUTH mesh, syncs signed chat & multi-chunk OPFS/Disk Swarm files, and survives center server shutdown", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const sharedPassphrase = "跨端验收-Web与CLI同群密码-2026";

    const contextAlice = await browser.newContext({ acceptDownloads: true });
    const contextCarol = await browser.newContext({ acceptDownloads: true });
    const pageAlice = await contextAlice.newPage();
    const pageCarol = await contextCarol.newPage();

    try {
      // 1. Register & join room from two isolated browser contexts + one real CLI (werift) peer
      await Promise.all([
        registerAndJoinRoomOnWeb({
          page: pageAlice,
          webOrigin: cluster.webOrigin,
          username: "web_alice",
          displayName: "Alice Web",
          password: "Password-WebAlice-123!",
          passphrase: sharedPassphrase,
        }),
        registerAndJoinRoomOnWeb({
          page: pageCarol,
          webOrigin: cluster.webOrigin,
          username: "web_carol",
          displayName: "Carol Web",
          password: "Password-WebCarol-123!",
          passphrase: sharedPassphrase,
        }),
      ]);

      const cliBob = await harness.call<{ peerId: string; username: string }>(
        "spawnCliPeer",
        {
          username: "cli_bob",
          displayName: "Bob CLI",
          password: "Password-CliBob-123!",
          passphrase: sharedPassphrase,
        },
      );

      // 2. Verify all 3 peers pass DTLS-bound HELLO_AUTH across Browser <-> Browser and Browser <-> CLI
      const alicePeerList = pageAlice.getByTestId("peer-list");
      await expect(alicePeerList).toContainText("@web_carol", {
        timeout: 20_000,
      });
      await expect(alicePeerList).toContainText("@cli_bob", {
        timeout: 20_000,
      });
      await expect(alicePeerList).toContainText("CLI");
      await expect(alicePeerList).toContainText("WEB");

      await expect
        .poll(
          async () => {
            const st = await harness.call<CliStateSnapshot>("getCliState", {
              peerId: cliBob.peerId,
            });
            return st.verifiedPeers.map((p) => p.username).sort();
          },
          { timeout: 20_000 },
        )
        .toEqual(["web_alice", "web_carol"]);

      // 3. Bidirectional signed Markdown chat (Web -> CLI/Web and CLI -> Web)
      await pageAlice
        .getByTestId("chat-input")
        .fill("Hello from **Alice Browser** over E2EE `RTCDataChannel`!");
      await pageAlice.getByTestId("chat-send").click();

      await expect(pageCarol.locator(".message-stream")).toContainText(
        "Hello from Alice Browser over E2EE RTCDataChannel!",
      );

      await expect
        .poll(async () => {
          const st = await harness.call<CliStateSnapshot>("getCliState", {
            peerId: cliBob.peerId,
          });
          return st.messages.some((m) =>
            m.body.includes("Alice Browser"),
          );
        })
        .toBe(true);

      await harness.call("cliSendChat", {
        peerId: cliBob.peerId,
        body: "Signed reply from **Bob CLI** (`werift` UDP/SCTP)!",
      });

      await expect(pageAlice.locator(".message-stream")).toContainText(
        "Signed reply from Bob CLI (werift UDP/SCTP)!",
      );
      await expect(pageCarol.locator(".message-stream")).toContainText(
        "Signed reply from Bob CLI (werift UDP/SCTP)!",
      );

      // 4. CLI -> Web multi-chunk Swarm file transfer (210 KiB = 4 chunks of 64 KiB) into Worker OPFS
      const cliShared = await harness.call<{
        fileId: string;
        fileName: string;
        fileSize: number;
        totalChunks: number;
        sha256: string;
      }>("cliShareFile", {
        peerId: cliBob.peerId,
        fileName: "cli-telemetry.bin",
        sizeBytes: 210 * 1024 + 137,
        seedByte: 0x5a,
      });
      expect(cliShared.totalChunks).toBe(4);

      const aliceCliFileCard = pageAlice
        .getByTestId("file-list")
        .locator(".file-card", { hasText: "cli-telemetry.bin" });
      await expect(aliceCliFileCard).toBeVisible();
      await aliceCliFileCard.getByTestId("file-download-button").click();

      await expect(aliceCliFileCard).toHaveAttribute(
        "data-transfer-status",
        "seeding",
        { timeout: 25_000 },
      );

      const downloadPromise = pageAlice.waitForEvent("download");
      await aliceCliFileCard.getByTestId("file-save-button").click();
      const browserDownload = await downloadPromise;
      expect(browserDownload.suggestedFilename()).toBe("cli-telemetry.bin");
      const downloadedPath = await browserDownload.path();
      expect(downloadedPath).toBeTruthy();
      const savedBytes = await readFile(downloadedPath!);
      expect(savedBytes.byteLength).toBe(cliShared.fileSize);
      expect(sha256HexNode(savedBytes)).toBe(cliShared.sha256);

      // 5. Web -> CLI multi-chunk Swarm file transfer (200 KiB = 4 chunks of 64 KiB) to CLI disk
      const webPayload = makeDeterministicBuffer(200 * 1024 + 509, 0xa7);
      const expectedWebSha = sha256HexNode(webPayload);

      await pageAlice.getByTestId("file-input").setInputFiles({
        name: "browser-capture.bin",
        mimeType: "application/octet-stream",
        buffer: webPayload,
      });

      await expect(
        pageAlice
          .getByTestId("file-list")
          .locator(".file-card", { hasText: "browser-capture.bin" }),
      ).toHaveAttribute("data-transfer-status", "seeding");

      let webAnnouncedFileId = "";
      await expect
        .poll(async () => {
          const st = await harness.call<CliStateSnapshot>("getCliState", {
            peerId: cliBob.peerId,
          });
          const found = st.files.find(
            (f) => f.fileName === "browser-capture.bin",
          );
          if (found) {
            webAnnouncedFileId = found.fileId;
          }
          return Boolean(found);
        })
        .toBe(true);

      const cliDownloaded = await harness.call<{
        finalPath: string;
        byteLength: number;
        diskSha256: string;
      }>("cliDownloadFile", {
        peerId: cliBob.peerId,
        fileId: webAnnouncedFileId,
      });
      expect(cliDownloaded.byteLength).toBe(webPayload.byteLength);
      expect(cliDownloaded.diskSha256).toBe(expectedWebSha);

      // 6. Stop central server completely -> verify P2P Direct survival across Web & CLI!
      await harness.call("stopCenterServer");

      await expect(pageAlice.getByTestId("connection-badge")).toHaveAttribute(
        "data-connection-state",
        "detached",
      );
      await expect(pageCarol.getByTestId("connection-badge")).toHaveAttribute(
        "data-connection-state",
        "detached",
      );

      await pageAlice
        .getByTestId("chat-input")
        .fill("Post-shutdown P2P message from Browser!");
      await pageAlice.getByTestId("chat-send").click();

      await expect(pageCarol.locator(".message-stream")).toContainText(
        "Post-shutdown P2P message from Browser!",
      );
      await expect
        .poll(async () => {
          const st = await harness.call<CliStateSnapshot>("getCliState", {
            peerId: cliBob.peerId,
          });
          return st.messages.some((m) =>
            m.body.includes("Post-shutdown P2P message from Browser!"),
          );
        })
        .toBe(true);

      await harness.call("cliSendChat", {
        peerId: cliBob.peerId,
        body: "Post-shutdown P2P reply from CLI while server is offline!",
      });

      await expect(pageAlice.locator(".message-stream")).toContainText(
        "Post-shutdown P2P reply from CLI while server is offline!",
      );

      // 7. Verify zero secrets in browser URL / localStorage & server SQLite / logs
      const browserStorageAudit = await pageAlice.evaluate(() => ({
        href: window.location.href,
        search: window.location.search,
        hash: window.location.hash,
        localStorageKeys: Object.keys(window.localStorage),
        sessionStorageKeys: Object.keys(window.sessionStorage),
      }));
      expect(browserStorageAudit.search).toBe("");
      expect(browserStorageAudit.hash).toBe("");
      expect(browserStorageAudit.localStorageKeys).toEqual([]);
      expect(browserStorageAudit.sessionStorageKeys).toEqual([]);

      const sqliteAudit = await harness.call<{
        tables: string[];
        leaked: string[];
      }>("auditSqlite", {
        forbiddenStrings: [
          sharedPassphrase,
          "cli-telemetry.bin",
          "browser-capture.bin",
          "Hello from **Alice Browser**",
          "Post-shutdown P2P message from Browser!",
          "Post-shutdown P2P reply from CLI",
          "Password-WebAlice-123!",
          "Password-CliBob-123!",
        ],
      });
      expect(sqliteAudit.tables).toEqual([
        "schema_migrations",
        "sessions",
        "users",
      ]);
      expect(sqliteAudit.leaked).toEqual([]);
    } finally {
      await contextAlice.close();
      await contextCarol.close();
    }
  });

  test("isolates distinct passphrases into orthogonal rooms and wipes room state on Leave Room", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await Promise.all([
        registerAndJoinRoomOnWeb({
          page: pageA,
          webOrigin: cluster.webOrigin,
          username: "room_a_user",
          displayName: "Room A User",
          password: "Password-RoomA-123!",
          passphrase: "alpha-secret-passphrase",
        }),
        registerAndJoinRoomOnWeb({
          page: pageB,
          webOrigin: cluster.webOrigin,
          username: "room_b_user",
          displayName: "Room B User",
          password: "Password-RoomB-123!",
          passphrase: "beta-secret-passphrase",
        }),
      ]);

      await pageA.getByTestId("chat-input").fill("Confidential Alpha message");
      await pageA.getByTestId("chat-send").click();

      // Wait briefly and verify Room B has zero peers and never sees Alpha's message
      await pageB.waitForTimeout(800);
      await expect(pageB.getByTestId("peer-list-empty")).toBeVisible();
      await expect(pageB.locator(".message-stream")).not.toContainText(
        "Confidential Alpha message",
      );

      // Leave Room wipes active room session and returns cleanly to JoinRoomView
      await pageA.getByTestId("leave-room-button").click();
      await expect(pageA.getByTestId("room-passphrase")).toBeVisible();
      await expect(pageA.getByTestId("room-passphrase")).toHaveValue("");
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("auto-detects browser locale, switches 6 languages and system/dark/light theme live, and stores only non-sensitive preference keys", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const context = await browser.newContext({
      locale: "zh-CN",
      colorScheme: "light",
    });
    const page = await context.newPage();

    try {
      await page.goto(cluster.webOrigin);

      // 1. Auto-detected zh-CN language and system light color-scheme without writing localStorage
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("#auth-heading")).toHaveText("登录账号");

      const initialKeys = await page.evaluate(() =>
        Object.keys(window.localStorage),
      );
      expect(initialKeys).toEqual([]);

      // 2. One-click theme switch: dark -> light -> system (plus live OS media query reaction)
      await page.getByTestId("theme-mode-dark").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await page.getByTestId("theme-mode-light").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      await page.getByTestId("theme-mode-system").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      // 3. Live 6-locale switching without reload
      const localeSelect = page.getByTestId("locale-select");

      await localeSelect.selectOption("ja");
      await expect(page.locator("html")).toHaveAttribute("lang", "ja");
      await expect(page.locator("#auth-heading")).toHaveText("ログイン");

      await localeSelect.selectOption("ko");
      await expect(page.locator("html")).toHaveAttribute("lang", "ko");
      await expect(page.locator("#auth-heading")).toHaveText("로그인");

      await localeSelect.selectOption("es");
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
      await expect(page.locator("#auth-heading")).toHaveText("Iniciar sesión");

      await localeSelect.selectOption("zh-TW");
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
      await expect(page.locator("#auth-heading")).toHaveText("登入帳號");

      await localeSelect.selectOption("en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("#auth-heading")).toHaveText("Sign in");

      // 4. Verify localStorage holds exclusively non-sensitive UI preference enums
      const finalStorage = await page.evaluate(() => ({
        keys: Object.keys(window.localStorage).sort(),
        locale: window.localStorage.getItem("simpleim.locale"),
        theme: window.localStorage.getItem("simpleim.theme"),
      }));
      expect(finalStorage).toEqual({
        keys: ["simpleim.locale", "simpleim.theme"],
        locale: "en",
        theme: "system",
      });
    } finally {
      await context.close();
    }
  });

  test("persists encrypted room vault across page reload & default sign-out, tracks multi-room unread badges, and wipes cache on Wipe & Sign Out", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const alphaPassphrase = "persistent-alpha-group-2026";
    const betaPassphrase = "persistent-beta-group-2026";

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // 1. Register & join Alpha room with a local alias, paired with a live CLI peer
      await page.goto(cluster.webOrigin);
      await page.getByTestId("auth-tab-register").click();
      await page.getByTestId("auth-username").fill("persist_alice");
      await page.getByTestId("auth-display-name").fill("Persist Alice");
      await page.getByTestId("auth-password").fill("Password-Persist-123!");
      await page.getByTestId("auth-submit").click();

      await expect(page.getByTestId("room-passphrase")).toBeVisible();
      await page.getByTestId("room-passphrase").fill(alphaPassphrase);
      await page.getByTestId("room-alias").fill("研发核心群");
      await page.getByTestId("room-join-submit").click();

      await expect(page.getByTestId("connection-badge")).toHaveAttribute(
        "data-connection-state",
        "connected",
        { timeout: 25_000 },
      );

      const cliBob = await harness.call<{ peerId: string; username: string }>(
        "spawnCliPeer",
        {
          username: "cli_persist_bob",
          displayName: "Persist Bob CLI",
          password: "Password-PersistBob-123!",
          passphrase: alphaPassphrase,
        },
      );

      await expect(page.getByTestId("peer-list")).toContainText(
        "@cli_persist_bob",
        { timeout: 20_000 },
      );

      await page
        .getByTestId("chat-input")
        .fill("History message #1 from Alice before reload");
      await page.getByTestId("chat-send").click();

      await harness.call("cliSendChat", {
        peerId: cliBob.peerId,
        body: "History message #2 from CLI Bob before reload",
      });
      await expect(page.locator(".message-stream")).toContainText(
        "History message #2 from CLI Bob before reload",
      );

      // 2. Reload browser page -> auto-restores room & history WITHOUT re-entering passphrase, and reconnects P2P mesh!
      await page.reload();

      await expect(page.getByTestId("room-list-rail")).toContainText(
        "研发核心群",
        { timeout: 15_000 },
      );
      await expect(page.getByTestId("room-passphrase")).toHaveCount(0);
      await expect(page.locator(".message-stream")).toContainText(
        "History message #1 from Alice before reload",
      );
      await expect(page.locator(".message-stream")).toContainText(
        "History message #2 from CLI Bob before reload",
      );

      await expect(page.getByTestId("connection-badge")).toHaveAttribute(
        "data-connection-state",
        "connected",
        { timeout: 20_000 },
      );
      await expect(page.getByTestId("peer-list")).toContainText(
        "@cli_persist_bob",
        { timeout: 20_000 },
      );

      await harness.call("cliSendChat", {
        peerId: cliBob.peerId,
        body: "Post-reload live message #3 from CLI Bob",
      });
      await expect(page.locator(".message-stream")).toContainText(
        "Post-reload live message #3 from CLI Bob",
      );

      // 3. Join second room (Beta) from RoomListRail -> receive background message in Alpha -> unread badge increments
      await page.getByTestId("open-join-room-drawer").click();
      await page.getByTestId("rail-join-passphrase").fill(betaPassphrase);
      await page.getByTestId("rail-join-alias").fill("运维告警群");
      await page.getByTestId("rail-join-submit").click();

      await expect(page.getByTestId("room-list-rail")).toContainText(
        "运维告警群",
      );
      await expect(page.locator(".message-stream")).not.toContainText(
        "History message #1 from Alice before reload",
      );

      // CLI Bob sends message in Alpha while Alice is viewing Beta
      await harness.call("cliSendChat", {
        peerId: cliBob.peerId,
        body: "Background unread ping in Alpha room!",
      });

      await expect(page.getByTestId("room-unread-badge")).toHaveText("1", {
        timeout: 15_000,
      });

      // Click Alpha room in RoomListRail -> switches back, clears unread badge, displays new message
      await page
        .getByTestId("room-list-rail")
        .locator(".room-item-select", { hasText: "研发核心群" })
        .click();
      await expect(page.getByTestId("room-unread-badge")).toHaveCount(0);
      await expect(page.locator(".message-stream")).toContainText(
        "Background unread ping in Alpha room!",
      );

      // 4. Default Sign Out preserves encrypted local RoomVault -> signing back in restores both rooms + history!
      await page.getByTestId("sign-out-button").click();
      await expect(page.getByTestId("auth-username")).toBeVisible();

      await page.getByTestId("auth-username").fill("persist_alice");
      await page.getByTestId("auth-password").fill("Password-Persist-123!");
      await page.getByTestId("auth-submit").click();

      await expect(page.getByTestId("room-list-rail")).toContainText(
        "研发核心群",
        { timeout: 15_000 },
      );
      await expect(page.getByTestId("room-list-rail")).toContainText(
        "运维告警群",
      );
      await expect(page.locator(".message-stream")).toContainText(
        "Background unread ping in Alpha room!",
      );

      // Zero secrets in localStorage / sessionStorage while vault is populated
      const storageAudit = await page.evaluate(() => ({
        localStorageKeys: Object.keys(window.localStorage),
        sessionStorageKeys: Object.keys(window.sessionStorage),
      }));
      expect(storageAudit.localStorageKeys).toEqual([]);
      expect(storageAudit.sessionStorageKeys).toEqual([]);

      // 5. Explicit "Wipe & Sign Out" wipes local RoomVault -> next login starts fresh on JoinRoomScreen
      await page.getByTestId("wipe-vault-button").click();
      await expect(page.getByTestId("auth-username")).toBeVisible();

      await page.getByTestId("auth-username").fill("persist_alice");
      await page.getByTestId("auth-password").fill("Password-Persist-123!");
      await page.getByTestId("auth-submit").click();

      await expect(page.getByTestId("room-passphrase")).toBeVisible();
      await expect(page.getByTestId("room-list-rail")).toHaveCount(0);

      // 6. Final server SQLite & log zero-knowledge audit
      const sqliteAudit = await harness.call<{
        tables: string[];
        leaked: string[];
      }>("auditSqlite", {
        forbiddenStrings: [
          alphaPassphrase,
          betaPassphrase,
          "研发核心群",
          "运维告警群",
          "Background unread ping in Alpha room!",
        ],
      });
      expect(sqliteAudit.tables).toEqual([
        "schema_migrations",
        "sessions",
        "users",
      ]);
      expect(sqliteAudit.leaked).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("delivers E2EE offline chat messages and multi-chunk files asynchronously via Blind Ephemeral Relay when peers are never online simultaneously", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const offlinePassphrase = "async-blind-ephemeral-relay-2026-发完即走";
    const offlineMessage =
      "Offline E2EE handover: sender closed browser before receiver joined!";
    const retriedOfflineMessage =
      "Outbox retry E2EE memo: recovered after transient relay outage!";
    // 3 chunks (2 * 64 KiB + tail = 160 KiB + 333 B)
    const offlineFileBuffer = makeDeterministicBuffer(160 * 1024 + 333, 0x3c);
    const expectedOfflineSha = sha256HexNode(offlineFileBuffer);

    // Phase 1: Sender joins alone, sends chat + multi-chunk file, waits for encrypted relay cache, then closes browser completely!
    const contextSender = await browser.newContext({ acceptDownloads: true });
    const pageSender = await contextSender.newPage();
    try {
      await registerAndJoinRoomOnWeb({
        page: pageSender,
        webOrigin: cluster.webOrigin,
        username: "offline_sender",
        displayName: "Offline Sender",
        password: "Password-OfflineSender-123!",
        passphrase: offlinePassphrase,
      });

      await expect(pageSender.getByTestId("peer-list-empty")).toBeVisible();

      await pageSender.getByTestId("chat-input").fill(offlineMessage);
      await pageSender.getByTestId("chat-send").click();
      const firstSentEntry = pageSender
        .locator(".msg-entry-self", { hasText: offlineMessage });
      await expect(firstSentEntry).toBeVisible();
      await expect(firstSentEntry).toHaveAttribute(
        "data-delivery-status",
        "relayed",
        { timeout: 15_000 },
      );

      // Simulate transient relay outage -> send a second message -> verify failed state + manual Retry button -> recover to relayed!
      await pageSender.route("**/api/v1/relay/*/envelopes/*", async (route) => {
        if (route.request().method() === "PUT") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "internal_error", message: "Simulated relay outage" },
            }),
          });
          return;
        }
        await route.continue();
      });

      await pageSender.getByTestId("chat-input").fill(retriedOfflineMessage);
      await pageSender.getByTestId("chat-send").click();
      const retriedEntry = pageSender
        .locator(".msg-entry-self", { hasText: retriedOfflineMessage });
      await expect(retriedEntry).toBeVisible();
      await expect(retriedEntry).toHaveAttribute(
        "data-delivery-status",
        "failed",
        { timeout: 15_000 },
      );
      await expect(retriedEntry.getByTestId("msg-retry-button")).toBeVisible();

      // Restore relay reachability and click Retry button -> transitions atomically to relayed!
      await pageSender.unroute("**/api/v1/relay/*/envelopes/*");
      await retriedEntry.getByTestId("msg-retry-button").click();
      await expect(retriedEntry).toHaveAttribute(
        "data-delivery-status",
        "relayed",
        { timeout: 15_000 },
      );

      await pageSender.getByTestId("file-input").setInputFiles({
        name: "offline-handover.bin",
        mimeType: "application/octet-stream",
        buffer: offlineFileBuffer,
      });

      const senderFileCard = pageSender
        .getByTestId("file-list")
        .locator(".file-card", { hasText: "offline-handover.bin" });
      await expect(senderFileCard).toHaveAttribute(
        "data-transfer-status",
        "seeding",
      );
      await expect(senderFileCard).toHaveAttribute(
        "data-relay-state",
        "cached",
        { timeout: 25_000 },
      );
      await expect(senderFileCard.getByTestId("file-relay-badge")).toBeVisible();
    } finally {
      // Completely close Sender's browser context so 0 peers remain online in the room!
      await contextSender.close();
    }

    // Phase 2: Late Web Receiver joins with 0 online peers, automatically receives offline chat & file manifest, and downloads verified file!
    const contextReceiver = await browser.newContext({ acceptDownloads: true });
    const pageReceiver = await contextReceiver.newPage();
    try {
      await registerAndJoinRoomOnWeb({
        page: pageReceiver,
        webOrigin: cluster.webOrigin,
        username: "offline_receiver",
        displayName: "Offline Receiver",
        password: "Password-OfflineReceiver-123!",
        passphrase: offlinePassphrase,
      });

      await expect(pageReceiver.getByTestId("peer-list-empty")).toBeVisible();

      await expect(pageReceiver.locator(".message-stream")).toContainText(
        offlineMessage,
        { timeout: 20_000 },
      );
      await expect(pageReceiver.locator(".message-stream")).toContainText(
        retriedOfflineMessage,
        { timeout: 20_000 },
      );

      const receiverFileCard = pageReceiver
        .getByTestId("file-list")
        .locator(".file-card", { hasText: "offline-handover.bin" });
      await expect(receiverFileCard).toBeVisible({ timeout: 20_000 });
      await expect(receiverFileCard).toHaveAttribute(
        "data-relay-state",
        "cached",
      );

      await receiverFileCard.getByTestId("file-download-button").click();
      await expect(receiverFileCard).toHaveAttribute(
        "data-transfer-status",
        "seeding",
        { timeout: 25_000 },
      );

      const downloadPromise = pageReceiver.waitForEvent("download");
      await receiverFileCard.getByTestId("file-save-button").click();
      const browserDownload = await downloadPromise;
      expect(browserDownload.suggestedFilename()).toBe("offline-handover.bin");
      const downloadedPath = await browserDownload.path();
      expect(downloadedPath).toBeTruthy();
      const downloadedBytes = await readFile(downloadedPath!);
      expect(downloadedBytes.byteLength).toBe(offlineFileBuffer.byteLength);
      expect(sha256HexNode(downloadedBytes)).toBe(expectedOfflineSha);
    } finally {
      // Close Web Receiver too before testing late CLI joiner!
      await contextReceiver.close();
    }

    // Phase 3: Late CLI peer joins with 0 online peers and also pulls offline chat + verified multi-chunk file from Blind Relay!
    const cliLate = await harness.call<{ peerId: string; username: string }>(
      "spawnCliPeer",
      {
        username: "cli_late_reader",
        displayName: "Late CLI Reader",
        password: "Password-LateCli-123!",
        passphrase: offlinePassphrase,
      },
    );

    let lateFileId = "";
    await expect
      .poll(
        async () => {
          const st = await harness.call<CliStateSnapshot>("getCliState", {
            peerId: cliLate.peerId,
          });
          const hasMsg = st.messages.some((m) =>
            m.body.includes(offlineMessage),
          );
          const fileEntry = st.files.find(
            (f) => f.fileName === "offline-handover.bin",
          );
          if (fileEntry) {
            lateFileId = fileEntry.fileId;
          }
          return hasMsg && Boolean(fileEntry) && st.verifiedPeers.length === 0;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    const cliLateDownloaded = await harness.call<{
      finalPath: string;
      byteLength: number;
      diskSha256: string;
    }>("cliDownloadFile", {
      peerId: cliLate.peerId,
      fileId: lateFileId,
    });
    expect(cliLateDownloaded.byteLength).toBe(offlineFileBuffer.byteLength);
    expect(cliLateDownloaded.diskSha256).toBe(expectedOfflineSha);

    // Phase 4: Verify SQLite still holds strictly 3 tables and zero secrets / filenames / chat text!
    const sqliteAudit = await harness.call<{
      tables: string[];
      leaked: string[];
    }>("auditSqlite", {
      forbiddenStrings: [
        offlinePassphrase,
        offlineMessage,
        retriedOfflineMessage,
        "offline-handover.bin",
        "Password-OfflineSender-123!",
        "Password-OfflineReceiver-123!",
      ],
    });
    expect(sqliteAudit.tables).toEqual([
      "schema_migrations",
      "sessions",
      "users",
    ]);
    expect(sqliteAudit.leaked).toEqual([]);
  });

  test("mobile iOS-sized viewport scrolls smoothly to earliest messages, prevents input auto-zoom, and keeps scroll position when remote messages arrive", async ({
    browser,
  }) => {
    const cluster = await harness.call<{
      webOrigin: string;
      apiUrl: string;
      sqlitePath: string;
    }>("startCluster");

    const passphrase = "mobile-ios-scroll-regression-2026";
    const cliPeer = await harness.call<{ peerId: string; username: string }>(
      "spawnCliPeer",
      {
        username: "mobile_cli_peer",
        displayName: "Mobile CLI Peer",
        password: "Password-MobileCli-123!",
        passphrase,
      },
    );

    // Pre-populate 32 messages from CLI peer so the transcript overflows mobile viewport substantially
    for (let i = 1; i <= 32; i++) {
      await harness.call("cliSendChat", {
        peerId: cliPeer.peerId,
        body: `History entry #${i}: checking mobile upward scroll reachability`,
      });
    }

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();

    try {
      await registerAndJoinRoomOnWeb({
        page,
        webOrigin: cluster.webOrigin,
        username: "mobile_ios_user",
        displayName: "iOS Tester",
        password: "Password-IosTester-123!",
        passphrase,
      });

      await expect(page.locator(".message-stream")).toContainText(
        "History entry #32:",
        { timeout: 25_000 },
      );

      // Verify mobile layout constraints:
      // 1) .room-shell stays locked at scrollTop 0 and does not overflow viewport
      // 2) .message-stream has real vertical overflow and starts scrolled to bottom
      // 3) textarea font-size is 16px to prevent iOS Safari focus auto-zoom
      // 4) top-bar is compact on mobile (< 150px)
      const initialLayout = await page.evaluate(() => {
        const shell = document.querySelector(".room-shell") as HTMLElement;
        const stream = document.querySelector(".message-stream") as HTMLElement;
        const topBar = document.querySelector(".top-bar") as HTMLElement;
        const input = document.querySelector(
          "[data-testid='chat-input']",
        ) as HTMLElement;
        return {
          shellScrollTop: shell.scrollTop,
          shellHeight: Math.round(shell.getBoundingClientRect().height),
          topBarHeight: Math.round(topBar.getBoundingClientRect().height),
          streamClientH: stream.clientHeight,
          streamScrollH: stream.scrollHeight,
          streamScrollTop: stream.scrollTop,
          streamMinHeight: getComputedStyle(stream).minHeight,
          inputFontSize: getComputedStyle(input).fontSize,
        };
      });
      expect(initialLayout.shellScrollTop).toBe(0);
      expect(initialLayout.shellHeight).toBeLessThanOrEqual(844);
      expect(initialLayout.topBarHeight).toBeLessThan(150);
      expect(initialLayout.streamScrollH).toBeGreaterThan(
        initialLayout.streamClientH + 400,
      );
      expect(initialLayout.streamScrollTop).toBeGreaterThan(200);
      expect(initialLayout.streamMinHeight).toBe("0px");
      expect(initialLayout.inputFontSize).toBe("16px");

      // Scroll all the way up to message #1 inside .message-stream
      await page.evaluate(() => {
        const stream = document.querySelector(".message-stream") as HTMLElement;
        stream.scrollTop = 0;
        stream.dispatchEvent(new Event("scroll"));
      });

      await expect(page.getByTestId("jump-to-latest-button")).toBeVisible();

      const topVisibility = await page.evaluate(() => {
        const stream = document.querySelector(".message-stream") as HTMLElement;
        const shell = document.querySelector(".room-shell") as HTMLElement;
        const firstEntry = document.querySelector(".msg-entry") as HTMLElement;
        const streamRect = stream.getBoundingClientRect();
        const firstRect = firstEntry.getBoundingClientRect();
        return {
          shellScrollTop: shell.scrollTop,
          streamScrollTop: stream.scrollTop,
          firstText: firstEntry.textContent ?? "",
          firstVisibleInStream:
            firstRect.top >= streamRect.top - 2 &&
            firstRect.bottom <= streamRect.bottom + 2,
        };
      });
      expect(topVisibility.shellScrollTop).toBe(0);
      expect(topVisibility.streamScrollTop).toBe(0);
      expect(topVisibility.firstText).toContain("History entry #1:");
      expect(topVisibility.firstVisibleInStream).toBe(true);

      // While user is reading message #1 at the top, CLI sends a new remote message #33 ->
      // transcript MUST NOT yank scrollTop back to bottom!
      await harness.call("cliSendChat", {
        peerId: cliPeer.peerId,
        body: "Live remote entry #33 while reading top!",
      });
      await expect(page.locator(".message-stream")).toContainText(
        "Live remote entry #33 while reading top!",
        { timeout: 15_000 },
      );

      const afterRemoteScrollTop = await page.evaluate(
        () => (document.querySelector(".message-stream") as HTMLElement).scrollTop,
      );
      expect(afterRemoteScrollTop).toBe(0);
      await expect(page.getByTestId("jump-to-latest-button")).toBeVisible();

      // Clicking "Latest" jumps cleanly to the bottom and hides the button
      await page.getByTestId("jump-to-latest-button").click();
      await expect(page.getByTestId("jump-to-latest-button")).toHaveCount(0);

      const bottomMetrics = await page.evaluate(() => {
        const stream = document.querySelector(".message-stream") as HTMLElement;
        return {
          distanceFromBottom:
            stream.scrollHeight - stream.scrollTop - stream.clientHeight,
          shellScrollTop: (document.querySelector(".room-shell") as HTMLElement)
            .scrollTop,
        };
      });
      expect(bottomMetrics.shellScrollTop).toBe(0);
      expect(bottomMetrics.distanceFromBottom).toBeLessThanOrEqual(4);
    } finally {
      await context.close();
    }
  });
});
