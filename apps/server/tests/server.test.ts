import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_SIGNAL_FRAME_BYTES,
  parseServerSignalingFrame,
  type CliAuthResponse,
  type MetaResponse,
  type PeerCertResponse,
  type ServerSignalingFrame,
  type WebAuthResponse,
} from "@simpleim/contracts";
import {
  createPopRequest,
  deriveRoomKeys,
  generateEd25519KeyPair,
  generatePrefixedId,
  openSignalingPayload,
  sealSignalingPayload,
  sha256Bytes,
  verifyPeerIdentityCert,
} from "@simpleim/crypto";
import {
  createSimpleImServer,
  type SimpleImServerInstance,
} from "../src/main.ts";

const activeServers: SimpleImServerInstance[] = [];

function startTestServer(
  overrides: Parameters<typeof createSimpleImServer>[0] = {},
  capturedLogs: string[] = [],
): SimpleImServerInstance {
  const srv = createSimpleImServer({
    port: 0,
    host: "127.0.0.1",
    sqlitePath: ":memory:",
    passwordHashMemoryCost: 4096,
    passwordHashTimeCost: 1,
    logSink: (line) => capturedLogs.push(line),
    ...overrides,
  });
  activeServers.push(srv);
  return srv;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      await srv.stop(true);
    }
  }
});

function extractCookiePair(setCookieHeader: string | null): string {
  expect(setCookieHeader).not.toBeNull();
  const firstSegment = (setCookieHeader ?? "").split(";")[0]?.trim() ?? "";
  expect(firstSegment.startsWith("simpleim_session=")).toBe(true);
  return firstSegment;
}

interface TestWsClient {
  readonly ws: WebSocket;
  nextFrame(timeoutMs?: number): Promise<ServerSignalingFrame>;
  nextRawMessage(timeoutMs?: number): Promise<string>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  close(): void;
}

async function openSignalingWs(
  url: string,
  headers: Record<string, string>,
): Promise<TestWsClient> {
  const ws = new WebSocket(url, { headers });
  const rawQueue: string[] = [];
  const rawWaiters: Array<(msg: string) => void> = [];
  let closeEvent: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(ev: { code: number; reason: string }) => void> = [];

  ws.addEventListener("message", (ev) => {
    const str = typeof ev.data === "string" ? ev.data : String(ev.data);
    const waiter = rawWaiters.shift();
    if (waiter) {
      waiter(str);
    } else {
      rawQueue.push(str);
    }
  });

  ws.addEventListener("close", (ev) => {
    closeEvent = { code: ev.code, reason: ev.reason };
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      waiter?.(closeEvent);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("WebSocket failed to open")),
      { once: true },
    );
  });

  const nextRawMessage = (timeoutMs = 5_000): Promise<string> => {
    const queued = rawQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = rawWaiters.indexOf(onMsg);
        if (idx >= 0) rawWaiters.splice(idx, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, timeoutMs);

      function onMsg(msg: string): void {
        clearTimeout(timer);
        resolve(msg);
      }

      rawWaiters.push(onMsg);
    });
  };

  return {
    ws,
    nextRawMessage,
    async nextFrame(timeoutMs = 5_000): Promise<ServerSignalingFrame> {
      const raw = await nextRawMessage(timeoutMs);
      return parseServerSignalingFrame(raw);
    },
    waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
      if (closeEvent) {
        return Promise.resolve(closeEvent);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for WebSocket close"));
        }, timeoutMs);
        closeWaiters.push((ev) => {
          clearTimeout(timer);
          resolve(ev);
        });
      });
    },
    close(): void {
      ws.close();
    },
  };
}

describe("SimpleIM Server Integration Suite", () => {
  test("1. GET /healthz and GET /api/v1/meta (public STUN vs authenticated Coturn HMAC-SHA1)", async () => {
    const coturnSecret = "turn-super-secret-2026";
    const srv = startTestServer({
      serverKeyId: "srvk_test_01",
      coturnUrls: ["turn:turn.example.com:3478?transport=udp"],
      coturnSharedSecret: coturnSecret,
    });

    const healthRes = await fetch(`${srv.url}/healthz`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });

    // Unauthenticated /api/v1/meta returns public key + STUN only (no TURN credentials)
    const publicMetaRes = await fetch(`${srv.url}/api/v1/meta`);
    expect(publicMetaRes.status).toBe(200);
    const publicMeta = (await publicMetaRes.json()) as MetaResponse;
    expect(publicMeta.ok).toBe(true);
    expect(publicMeta.serverKeyId).toBe("srvk_test_01");
    expect(publicMeta.serverSignPubKey).toBe(srv.serverSignPubKey);
    expect(publicMeta.iceServers).toHaveLength(1);
    expect(publicMeta.iceServers[0]?.urls).toContain(
      "stun:stun.cloudflare.com:3478",
    );
    expect(publicMeta.limits).toEqual({
      maxPeersPerRoom: 16,
      maxRoomsPerConnection: 8,
      maxSignalPayloadBytes: 32_768,
    });

    // Stale/invalid bearer token on /api/v1/meta gracefully falls back to public meta
    const staleMetaRes = await fetch(`${srv.url}/api/v1/meta`, {
      headers: { Authorization: "Bearer stale_invalid_token_1234567890" },
    });
    expect(staleMetaRes.status).toBe(200);

    // Register CLI user and fetch authenticated /api/v1/meta -> includes HMAC-SHA1 TURN credentials
    const regRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "turn_tester",
        password: "strong-password-123",
        clientKind: "cli",
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as CliAuthResponse;

    const authMetaRes = await fetch(`${srv.url}/api/v1/meta`, {
      headers: { Authorization: `Bearer ${regBody.sessionToken}` },
    });
    expect(authMetaRes.status).toBe(200);
    const authMeta = (await authMetaRes.json()) as MetaResponse;
    expect(authMeta.iceServers).toHaveLength(2);

    const turnEntry = authMeta.iceServers[1];
    expect(turnEntry?.urls).toEqual([
      "turn:turn.example.com:3478?transport=udp",
    ]);
    expect(turnEntry?.username?.endsWith(`:${regBody.user.id}`)).toBe(true);
    const expectedHmac = createHmac("sha1", coturnSecret)
      .update(turnEntry?.username ?? "")
      .digest("base64");
    expect(turnEntry?.credential).toBe(expectedHmac);
  });

  test("2. CLI register -> login -> me -> peer-cert (verified offline) -> logout -> 401", async () => {
    const srv = startTestServer();

    // Register
    const regRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "cli_alice",
        password: "correct-horse-battery",
        displayName: "Alice CLI",
        clientKind: "cli",
      }),
    });
    expect(regRes.status).toBe(201);
    expect(regRes.headers.get("set-cookie")).toBeNull();
    const regJson = (await regRes.json()) as CliAuthResponse;
    expect(regJson.ok).toBe(true);
    expect(regJson.user.username).toBe("cli_alice");
    expect(regJson.user.displayName).toBe("Alice CLI");
    expect(typeof regJson.sessionToken).toBe("string");
    expect(regJson.expiresAt).toBeGreaterThan(Date.now());

    // Login (creates a fresh CLI session)
    const loginRes = await fetch(`${srv.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "CLI_ALICE",
        password: "correct-horse-battery",
        clientKind: "cli",
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as CliAuthResponse;
    expect(loginJson.user.id).toBe(regJson.user.id);
    expect(loginJson.sessionToken).not.toBe(regJson.sessionToken);

    const bearerHeaders = {
      Authorization: `Bearer ${loginJson.sessionToken}`,
      "Content-Type": "application/json",
    };

    // GET /api/v1/auth/me
    const meRes = await fetch(`${srv.url}/api/v1/auth/me`, {
      headers: bearerHeaders,
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson).toEqual({
      ok: true,
      user: regJson.user,
    });

    // POST /api/v1/auth/peer-cert
    const peerKeyPair = generateEd25519KeyPair();
    const peerId = generatePrefixedId("peer");
    const popReq = createPopRequest({
      userId: loginJson.user.id,
      peerId,
      peerSignKeyPair: peerKeyPair,
    });

    const certRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: bearerHeaders,
      body: JSON.stringify(popReq),
    });
    expect(certRes.status).toBe(200);
    const certJson = (await certRes.json()) as PeerCertResponse;
    expect(certJson.ok).toBe(true);

    const verified = verifyPeerIdentityCert(
      certJson.cert,
      srv.serverSignPubKey,
    );
    expect(verified).toEqual({ ok: true });
    expect(certJson.cert.payload.userId).toBe(loginJson.user.id);
    expect(certJson.cert.payload.username).toBe("cli_alice");
    expect(certJson.cert.payload.displayName).toBe("Alice CLI");
    expect(certJson.cert.payload.peerId).toBe(peerId);
    expect(certJson.cert.payload.peerSignPubKey).toBe(
      peerKeyPair.publicKeyBase64Url,
    );
    expect(certJson.cert.payload.clientKind).toBe("cli");
    expect(certJson.cert.payload.exp - certJson.cert.payload.iat).toBe(
      24 * 60 * 60 * 1000,
    );

    // POST /api/v1/auth/logout
    const logoutRes = await fetch(`${srv.url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${loginJson.sessionToken}` },
    });
    expect(logoutRes.status).toBe(200);
    expect(await logoutRes.json()).toEqual({ ok: true });

    // Subsequent requests with logged-out token return 401 unauthorized
    const afterMeRes = await fetch(`${srv.url}/api/v1/auth/me`, {
      headers: bearerHeaders,
    });
    expect(afterMeRes.status).toBe(401);
    const afterMeJson = (await afterMeRes.json()) as {
      ok: false;
      error: { code: string };
    };
    expect(afterMeJson.ok).toBe(false);
    expect(afterMeJson.error.code).toBe("unauthorized");
  });

  test("3. Web register (Cookie + csrfToken) -> CSRF enforcement on peer-cert & logout -> CORS allowlist", async () => {
    const devOrigin = "http://localhost:5173";
    const srv = startTestServer({
      allowedOrigins: [devOrigin],
      secureCookies: true,
    });

    // CORS preflight from allowed dev origin
    const preflightOk = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "OPTIONS",
      headers: { Origin: devOrigin },
    });
    expect(preflightOk.status).toBe(204);
    expect(preflightOk.headers.get("access-control-allow-origin")).toBe(
      devOrigin,
    );
    expect(preflightOk.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );

    // CORS preflight from disallowed origin -> 403
    const preflightBad = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(preflightBad.status).toBe(403);

    // Web register
    const regRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: devOrigin,
      },
      body: JSON.stringify({
        username: "web_bob",
        password: "web-secret-password",
        displayName: "Bob Web",
        clientKind: "web",
      }),
    });
    expect(regRes.status).toBe(201);
    const rawSetCookie = regRes.headers.get("set-cookie");
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("SameSite=Strict");
    expect(rawSetCookie).toContain("Path=/");
    expect(rawSetCookie).toContain("Max-Age=2592000");
    expect(rawSetCookie).toContain("Secure");

    const cookieHeader = extractCookiePair(rawSetCookie);
    const regJson = (await regRes.json()) as WebAuthResponse &
      Record<string, unknown>;
    expect(regJson.ok).toBe(true);
    expect(typeof regJson.csrfToken).toBe("string");
    expect(regJson.sessionToken).toBeUndefined();

    const peerKeyPair = generateEd25519KeyPair();
    const peerId = generatePrefixedId("peer");
    const popReq = createPopRequest({
      userId: regJson.user.id,
      peerId,
      peerSignKeyPair: peerKeyPair,
    });

    // peer-cert WITHOUT x-csrf-token -> 403 csrf_invalid
    const noCsrfRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Origin: devOrigin,
      },
      body: JSON.stringify(popReq),
    });
    expect(noCsrfRes.status).toBe(403);
    expect(await noCsrfRes.json()).toMatchObject({
      ok: false,
      error: { code: "csrf_invalid" },
    });

    // peer-cert WITH wrong x-csrf-token -> 403 csrf_invalid
    const wrongCsrfRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Origin: devOrigin,
        "x-csrf-token": "wrong-csrf-token-value",
      },
      body: JSON.stringify(popReq),
    });
    expect(wrongCsrfRes.status).toBe(403);
    expect(await wrongCsrfRes.json()).toMatchObject({
      ok: false,
      error: { code: "csrf_invalid" },
    });

    // peer-cert WITH valid x-csrf-token -> 200 OK
    const validCsrfRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Origin: devOrigin,
        "x-csrf-token": regJson.csrfToken,
      },
      body: JSON.stringify(popReq),
    });
    expect(validCsrfRes.status).toBe(200);
    const certJson = (await validCsrfRes.json()) as PeerCertResponse;
    expect(certJson.cert.payload.clientKind).toBe("web");
    expect(
      verifyPeerIdentityCert(certJson.cert, srv.serverSignPubKey),
    ).toEqual({ ok: true });

    // logout WITHOUT x-csrf-token -> 403 csrf_invalid
    const badLogout = await fetch(`${srv.url}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: devOrigin,
      },
    });
    expect(badLogout.status).toBe(403);

    // logout WITH valid x-csrf-token -> 200 OK & clears cookie
    const okLogout = await fetch(`${srv.url}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: devOrigin,
        "x-csrf-token": regJson.csrfToken,
      },
    });
    expect(okLogout.status).toBe(200);
    expect(okLogout.headers.get("set-cookie")).toContain("Max-Age=0");

    // Session row is deleted: reusing the old cookie returns 401
    const afterLogoutMe = await fetch(`${srv.url}/api/v1/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    expect(afterLogoutMe.status).toBe(401);
  });

  test("4. Duplicate username (409), invalid credentials (401), PoP skew/tamper (400/401), oversized HTTP body (413), and rate limit (429)", async () => {
    const srv = startTestServer({
      authRateLimit: { capacity: 5, refillPerSecond: 0 },
    });

    // First registration succeeds
    const reg1 = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "charlie",
        password: "charlie-password-123",
        clientKind: "cli",
      }),
    });
    expect(reg1.status).toBe(201);
    const reg1Json = (await reg1.json()) as CliAuthResponse;

    // Case-insensitive duplicate username -> 409 username_taken
    const regDup = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "CHARLIE",
        password: "another-password-123",
        clientKind: "cli",
      }),
    });
    expect(regDup.status).toBe(409);
    expect(await regDup.json()).toMatchObject({
      ok: false,
      error: { code: "username_taken" },
    });

    // Wrong password -> 401 invalid_credentials
    const badPw = await fetch(`${srv.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "charlie",
        password: "wrong-password-999",
        clientKind: "cli",
      }),
    });
    expect(badPw.status).toBe(401);
    expect(await badPw.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_credentials" },
    });

    // Non-existent user -> dummy Argon2id verify + 401 invalid_credentials
    const ghostLogin = await fetch(`${srv.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ghost_user_404",
        password: "any-password-12345",
        clientKind: "cli",
      }),
    });
    expect(ghostLogin.status).toBe(401);
    expect(await ghostLogin.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_credentials" },
    });

    // PoP timestamp skew (> 60s) -> 400/401 invalid_pop
    const kp = generateEd25519KeyPair();
    const skewedPop = createPopRequest({
      userId: reg1Json.user.id,
      peerId: generatePrefixedId("peer"),
      peerSignKeyPair: kp,
      timestamp: Date.now() - 120_000,
    });
    const skewRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reg1Json.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(skewedPop),
    });
    expect([400, 401]).toContain(skewRes.status);
    expect(await skewRes.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_pop" },
    });

    // PoP wrong signature (signed for wrong userId) -> 400/401 invalid_pop
    const wrongKeyPop = createPopRequest({
      userId: generatePrefixedId("usr"),
      peerId: generatePrefixedId("peer"),
      peerSignKeyPair: kp,
    });
    const wrongSigRes = await fetch(`${srv.url}/api/v1/auth/peer-cert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reg1Json.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wrongKeyPop),
    });
    expect([400, 401]).toContain(wrongSigRes.status);
    expect(await wrongSigRes.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_pop" },
    });

    // Oversized HTTP body (> 64 KiB) -> 413 payload_too_large
    const hugeBody = JSON.stringify({
      username: "huge",
      password: "password12345",
      displayName: "x".repeat(70_000),
      clientKind: "cli",
    });
    const hugeRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: hugeBody,
    });
    expect(hugeRes.status).toBe(413);
    expect(await hugeRes.json()).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    });

    // Exhaust login rate limit (capacity = 5, 2 already consumed above -> 3 more succeed/401, 4th returns 429)
    let hitRateLimit = false;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${srv.url}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "charlie",
          password: "wrong-password-999",
          clientKind: "cli",
        }),
      });
      if (r.status === 429) {
        hitRateLimit = true;
        expect(await r.json()).toMatchObject({
          ok: false,
          error: { code: "rate_limited" },
        });
        break;
      }
    }
    expect(hitRateLimit).toBe(true);
  });

  test("5 & 6. Ephemeral WebSocket signaling, E2EE relay, 1009 oversized frame close, redacted logs, and SQLite zero-room-persistence", async () => {
    const capturedLogs: string[] = [];
    const srv = startTestServer(
      {
        limits: {
          maxPeersPerRoom: 2,
          maxRoomsPerConnection: 2,
          maxSignalPayloadBytes: MAX_SIGNAL_FRAME_BYTES,
        },
      },
      capturedLogs,
    );

    // Register Peer 1 (Web client with Cookie)
    const aliceRegRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice_sig",
        password: "alice-secret-password",
        displayName: "Alice SecretName",
        clientKind: "web",
      }),
    });
    expect(aliceRegRes.status).toBe(201);
    const aliceCookie = extractCookiePair(
      aliceRegRes.headers.get("set-cookie"),
    );

    // Register Peer 2 (CLI client with Bearer token)
    const bobRegRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "bob_sig",
        password: "bob-secret-password",
        displayName: "Bob SecretName",
        clientKind: "cli",
      }),
    });
    expect(bobRegRes.status).toBe(201);
    const bobAuth = (await bobRegRes.json()) as CliAuthResponse;

    // Register Peer 3 (CLI client to test room_full + oversized 1009)
    const carolRegRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "carol_sig",
        password: "carol-secret-password",
        clientKind: "cli",
      }),
    });
    const carolAuth = (await carolRegRes.json()) as CliAuthResponse;

    const alicePeerId = generatePrefixedId("peer");
    const bobPeerId = generatePrefixedId("peer");
    const carolPeerId = generatePrefixedId("peer");

    // Cookie WS upgrade from disallowed Origin must be rejected (403)
    const csWshAttempt = await fetch(
      `${srv.url}/ws/v1/signaling?peerId=${alicePeerId}`,
      {
        headers: {
          Cookie: aliceCookie,
          Origin: "https://evil.attacker",
        },
      },
    );
    expect(csWshAttempt.status).toBe(403);

    // Open Alice (Cookie + valid same-origin) & Bob (Bearer)
    const aliceWs = await openSignalingWs(
      `${srv.wsUrl}?peerId=${alicePeerId}`,
      {
        Cookie: aliceCookie,
        Origin: srv.url,
      },
    );
    const bobWs = await openSignalingWs(`${srv.wsUrl}?peerId=${bobPeerId}`, {
      Authorization: `Bearer ${bobAuth.sessionToken}`,
    });
    const carolWs = await openSignalingWs(
      `${srv.wsUrl}?peerId=${carolPeerId}`,
      {
        Authorization: `Bearer ${carolAuth.sessionToken}`,
      },
    );

    // Derive shared room keys from passphrase
    const roomKeys = deriveRoomKeys("shared-room-passphrase-v1", {
      memoryKiB: 1024,
      iterations: 1,
    });

    // Alice joins room
    aliceWs.ws.send(
      JSON.stringify({ type: "room.join", roomId: roomKeys.roomId }),
    );
    const aliceJoinedRaw = await aliceWs.nextRawMessage();
    expect(aliceJoinedRaw).not.toContain("alice_sig");
    expect(aliceJoinedRaw).not.toContain("Alice SecretName");
    const aliceJoined = parseServerSignalingFrame(aliceJoinedRaw);
    expect(aliceJoined).toEqual({
      type: "room.joined",
      roomId: roomKeys.roomId,
      selfPeerId: alicePeerId,
      peers: [],
    });

    // Bob joins same room -> Bob receives room.joined (with Alice's peerId ONLY), Alice receives room.peer_joined
    bobWs.ws.send(
      JSON.stringify({ type: "room.join", roomId: roomKeys.roomId }),
    );
    const [bobJoinedRaw, alicePeerJoinedRaw] = await Promise.all([
      bobWs.nextRawMessage(),
      aliceWs.nextRawMessage(),
    ]);

    for (const raw of [bobJoinedRaw, alicePeerJoinedRaw]) {
      expect(raw).not.toContain("alice_sig");
      expect(raw).not.toContain("Alice SecretName");
      expect(raw).not.toContain("bob_sig");
      expect(raw).not.toContain("Bob SecretName");
    }

    expect(parseServerSignalingFrame(bobJoinedRaw)).toEqual({
      type: "room.joined",
      roomId: roomKeys.roomId,
      selfPeerId: bobPeerId,
      peers: [alicePeerId],
    });
    expect(parseServerSignalingFrame(alicePeerJoinedRaw)).toEqual({
      type: "room.peer_joined",
      roomId: roomKeys.roomId,
      peerId: bobPeerId,
    });

    // Carol tries to join full room (maxPeersPerRoom: 2) -> error room_full
    carolWs.ws.send(
      JSON.stringify({ type: "room.join", roomId: roomKeys.roomId }),
    );
    const carolRoomFull = await carolWs.nextFrame();
    expect(carolRoomFull).toMatchObject({
      type: "error",
      code: "room_full",
      roomId: roomKeys.roomId,
    });

    // Alice seals an SDP offer with XChaCha20-Poly1305 and relays to Bob
    const secretSdp =
      "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n";
    const sealedOffer = sealSignalingPayload(
      roomKeys.signalingKey,
      roomKeys.roomId,
      alicePeerId,
      bobPeerId,
      { kind: "sdp-offer", sdp: secretSdp },
    );
    aliceWs.ws.send(
      JSON.stringify({
        type: "signal.relay",
        roomId: roomKeys.roomId,
        toPeerId: bobPeerId,
        envelope: sealedOffer,
      }),
    );

    const deliveredFrame = await bobWs.nextFrame();
    expect(deliveredFrame).toEqual({
      type: "signal.deliver",
      roomId: roomKeys.roomId,
      fromPeerId: alicePeerId,
      envelope: sealedOffer,
    });
    if (deliveredFrame.type === "signal.deliver") {
      const opened = openSignalingPayload(
        roomKeys.signalingKey,
        roomKeys.roomId,
        deliveredFrame.fromPeerId,
        bobPeerId,
        deliveredFrame.envelope,
      );
      expect(opened).toEqual({ kind: "sdp-offer", sdp: secretSdp });
    }

    // Bob disconnects -> Alice receives room.peer_left
    const bobClosed = bobWs.waitForClose();
    bobWs.close();
    await bobClosed;

    const peerLeftFrame = await aliceWs.nextFrame();
    expect(peerLeftFrame).toEqual({
      type: "room.peer_left",
      roomId: roomKeys.roomId,
      peerId: bobPeerId,
    });

    // Carol sends an oversized > 32 KiB frame -> socket closed with 1009
    const carolClosePromise = carolWs.waitForClose();
    carolWs.ws.send("x".repeat(MAX_SIGNAL_FRAME_BYTES + 2_048));
    const carolCloseResult = await carolClosePromise;
    expect(carolCloseResult.code).toBe(1009);

    // Alice disconnects -> active in-memory room map drops immediately to 0
    const aliceClosed = aliceWs.waitForClose();
    aliceWs.close();
    await aliceClosed;

    // Wait briefly for server close callback to finish cleanup
    for (
      let attempt = 0;
      attempt < 20 && srv.signalingService.getActiveRoomCount() > 0;
      attempt++
    ) {
      await Bun.sleep(10);
    }
    expect(srv.signalingService.getActiveRoomCount()).toBe(0);
    expect(srv.signalingService.getActiveConnectionCount()).toBe(0);

    // 6. Zero-room-persistence SQLite assertions
    const tableRows = srv.sqliteDb
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      )
      .all();
    expect(tableRows.map((r) => r.name)).toEqual([
      "schema_migrations",
      "sessions",
      "users",
    ]);

    const sessionRows = srv.sqliteDb
      .query<
        { id: string; token_sha256: Uint8Array; client_kind: string },
        []
      >("SELECT id, token_sha256, client_kind FROM sessions")
      .all();
    expect(sessionRows.length).toBe(3);

    const expectedBobTokenSha = sha256Bytes(bobAuth.sessionToken);
    let matchedBobHash = false;
    for (const row of sessionRows) {
      expect(row.token_sha256).toBeInstanceOf(Uint8Array);
      expect(row.token_sha256.byteLength).toBe(32);
      if (Buffer.from(row.token_sha256).equals(Buffer.from(expectedBobTokenSha))) {
        matchedBobHash = true;
      }
    }
    expect(matchedBobHash).toBe(true);

    const sessionColumns = srv.sqliteDb
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((c) => c.name);
    expect(sessionColumns).toEqual([
      "id",
      "user_id",
      "token_sha256",
      "client_kind",
      "created_at",
      "expires_at",
      "last_seen_at",
    ]);

    // Verify structured JSON boundary logs redact secrets, tokens, full roomIds, and SDP
    expect(capturedLogs.length).toBeGreaterThan(0);
    for (const line of capturedLogs) {
      expect(line).not.toContain("alice-secret-password");
      expect(line).not.toContain("bob-secret-password");
      expect(line).not.toContain(bobAuth.sessionToken);
      expect(line).not.toContain(carolAuth.sessionToken);
      expect(line).not.toContain(secretSdp);
      expect(line).not.toContain(sealedOffer.ciphertext);
      expect(line).not.toContain(roomKeys.roomId);

      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.ts).toBe("number");
      expect(Number.isInteger(parsed.durationMs)).toBe(true);
      expect(typeof parsed.corrId).toBe("string");
      if (parsed.roomIdPrefix !== undefined) {
        expect(parsed.roomIdPrefix).toBe(roomKeys.roomIdPrefix);
        expect((parsed.roomIdPrefix as string).length).toBe(8);
      }
    }
  });

  test("7. Room limits, explicit room.leave cleanup, WS frame rate limiting, and WAL file-backed SQLite persistence", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "simpleim-srv-test-"));
    const dbPath = join(tempDir, "server.sqlite");

    try {
      const srv = startTestServer({
        sqlitePath: dbPath,
        limits: {
          maxPeersPerRoom: 4,
          maxRoomsPerConnection: 2,
          maxSignalPayloadBytes: MAX_SIGNAL_FRAME_BYTES,
        },
        wsFrameRateLimit: {
          capacity: 5,
          refillPerSecond: 0,
        },
      });

      const journalRow = srv.sqliteDb
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();
      expect(journalRow?.journal_mode.toLowerCase()).toBe("wal");

      const regRes = await fetch(`${srv.url}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "wal_tester",
          password: "wal-password-12345",
          clientKind: "cli",
        }),
      });
      expect(regRes.status).toBe(201);
      const auth = (await regRes.json()) as CliAuthResponse;

      const peerId = generatePrefixedId("peer");
      const wsClient = await openSignalingWs(
        `${srv.wsUrl}?peerId=${peerId}`,
        { Authorization: `Bearer ${auth.sessionToken}` },
      );

      const room1 = "1".repeat(64);
      const room2 = "2".repeat(64);
      const room3 = "3".repeat(64);

      // Join room1 & room2 (2 tokens consumed)
      wsClient.ws.send(JSON.stringify({ type: "room.join", roomId: room1 }));
      expect((await wsClient.nextFrame()).type).toBe("room.joined");

      wsClient.ws.send(JSON.stringify({ type: "room.join", roomId: room2 }));
      expect((await wsClient.nextFrame()).type).toBe("room.joined");
      expect(srv.signalingService.getActiveRoomCount()).toBe(2);

      // Attempt to join 3rd room -> room_limit_exceeded (3rd token consumed)
      wsClient.ws.send(JSON.stringify({ type: "room.join", roomId: room3 }));
      expect(await wsClient.nextFrame()).toMatchObject({
        type: "error",
        code: "room_limit_exceeded",
        roomId: room3,
      });

      // Leave room1 & room2 -> active room Map shrinks immediately to 0 (4th & 5th tokens consumed)
      wsClient.ws.send(JSON.stringify({ type: "room.leave", roomId: room1 }));
      wsClient.ws.send(JSON.stringify({ type: "room.leave", roomId: room2 }));

      // 6th frame exceeds connection token bucket (capacity: 5) BEFORE JSON parsing -> rate_limited
      wsClient.ws.send(JSON.stringify({ type: "room.join", roomId: room1 }));
      expect(await wsClient.nextFrame()).toMatchObject({
        type: "error",
        code: "rate_limited",
      });
      expect(srv.signalingService.getActiveRoomCount()).toBe(0);

      const closed = wsClient.waitForClose();
      wsClient.close();
      await closed;
      const originalPubKey = srv.serverSignPubKey;
      await srv.stop(true);
      srv.sqliteDb.close(false);

      // Restart server against same SQLite file: user, session, AND signing key persist, zero room tables exist
      const srvRestarted = startTestServer({ sqlitePath: dbPath });
      expect(srvRestarted.serverSignPubKey).toBe(originalPubKey);
      const meRes = await fetch(`${srvRestarted.url}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${auth.sessionToken}` },
      });
      expect(meRes.status).toBe(200);
      expect(srvRestarted.signalingService.getActiveRoomCount()).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("8. Production requires explicit SERVER_IDENTITY_PRIVATE_KEY, cookie /auth/me recovers csrfToken, malformed WS frames consume pre-parse rate limit, and custom maxSignalPayloadBytes is enforced", async () => {
    // 1. Production mode rejects startup without SERVER_IDENTITY_PRIVATE_KEY
    expect(() =>
      createSimpleImServer({
        port: 0,
        host: "127.0.0.1",
        sqlitePath: ":memory:",
        nodeEnv: "production",
      }),
    ).toThrow(/SERVER_IDENTITY_PRIVATE_KEY/);

    const explicitKey = generateEd25519KeyPair();
    const srv = startTestServer({
      nodeEnv: "production",
      serverIdentityPrivateKey: explicitKey.privateKeyBase64Url,
      limits: {
        maxPeersPerRoom: 4,
        maxRoomsPerConnection: 2,
        maxSignalPayloadBytes: 2_048,
      },
      wsFrameRateLimit: {
        capacity: 2,
        refillPerSecond: 0,
      },
    });
    expect(srv.serverSignPubKey).toBe(explicitKey.publicKeyBase64Url);

    // 2. Cookie-authenticated GET /api/v1/auth/me returns derived csrfToken usable on /peer-cert
    const regWeb = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "cookie_reload",
        password: "reload-password-123",
        clientKind: "web",
      }),
    });
    expect(regWeb.status).toBe(201);
    const cookieHeader = extractCookiePair(regWeb.headers.get("set-cookie"));
    const webAuth = (await regWeb.json()) as WebAuthResponse;

    const meRes = await fetch(`${srv.url}/api/v1/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as {
      ok: true;
      csrfToken?: string;
      user: { id: string };
    };
    expect(meJson.csrfToken).toBe(webAuth.csrfToken);

    // 3. Malformed JSON frames consume pre-parse WS rate-limit tokens and sustained flood closes 1008
    const regCli = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ws_budget_cli",
        password: "budget-password-123",
        clientKind: "cli",
      }),
    });
    const cliAuth = (await regCli.json()) as CliAuthResponse;
    const ws1 = await openSignalingWs(
      `${srv.wsUrl}?peerId=${generatePrefixedId("peer")}`,
      { Authorization: `Bearer ${cliAuth.sessionToken}` },
    );

    ws1.ws.send("{not-valid-json-1");
    expect(await ws1.nextFrame()).toMatchObject({
      type: "error",
      code: "invalid_frame",
    });
    ws1.ws.send("{not-valid-json-2");
    expect(await ws1.nextFrame()).toMatchObject({
      type: "error",
      code: "invalid_frame",
    });
    // 3rd frame (even if valid JSON) is blocked BEFORE parsing because the 2 malformed frames exhausted capacity=2
    ws1.ws.send(JSON.stringify({ type: "room.join", roomId: "a".repeat(64) }));
    expect(await ws1.nextFrame()).toMatchObject({
      type: "error",
      code: "rate_limited",
    });
    ws1.close();
    await ws1.waitForClose();

    // 4. Configured limits.maxSignalPayloadBytes (2048 B) closes oversized frames with 1009
    const ws2 = await openSignalingWs(
      `${srv.wsUrl}?peerId=${generatePrefixedId("peer")}`,
      { Authorization: `Bearer ${cliAuth.sessionToken}` },
    );
    const closePromise = ws2.waitForClose();
    ws2.ws.send("z".repeat(2_500));
    const closed = await closePromise;
    expect(closed.code).toBe(1009);
  });
});
