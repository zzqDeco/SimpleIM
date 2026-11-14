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
});
