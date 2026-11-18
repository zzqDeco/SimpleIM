import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_RELAY_MAX_FILE_BYTES,
  DEFAULT_RELAY_MAX_TOTAL_BYTES,
  DEFAULT_RELAY_TTL_MS,
  isValidRelayListEnvelopesResponse,
  MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES,
  MAX_SIGNAL_FRAME_BYTES,
  parseServerSignalingFrame,
  type CliAuthResponse,
  type MetaResponse,
  type PeerCertResponse,
  type RelayListEnvelopesResponse,
  type RelayPutChunkResponse,
  type RelayPutEnvelopeResponse,
  type ServerSignalingFrame,
  type WebAuthResponse,
} from "@simpleim/contracts";
import {
  base64UrlToBytes,
  createPopRequest,
  deriveRoomKeys,
  generateEd25519KeyPair,
  generatePrefixedId,
  openSignalingPayload,
  randomBytes,
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

  test("9. GET /api/v1/version reports immutable release metadata and custom stunUrls overrides default STUN endpoints", async () => {
    const srv = startTestServer({
      version: "v0.1.0",
      commitSha: "453129c0123456789abcdef0123456789abcdef0",
      stunUrls: ["stun:120.25.210.202:3478"],
    });

    const verRes = await fetch(`${srv.url}/api/v1/version`);
    expect(verRes.status).toBe(200);
    expect(await verRes.json()).toEqual({
      ok: true,
      version: "v0.1.0",
      sha: "453129c0123456789abcdef0123456789abcdef0",
    });

    const metaRes = await fetch(`${srv.url}/api/v1/meta`);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as MetaResponse;
    expect(meta.iceServers).toEqual([
      { urls: ["stun:120.25.210.202:3478"] },
    ]);
    expect(meta.relay).toEqual({
      enabled: true,
      ttlMs: DEFAULT_RELAY_TTL_MS,
      maxFileBytes: DEFAULT_RELAY_MAX_FILE_BYTES,
      maxTotalBytes: DEFAULT_RELAY_MAX_TOTAL_BYTES,
    });
  });

  test("10. Blind relay (/api/v1/relay/*): /meta config, Web Cookie+CSRF vs CLI Bearer, idempotent envelope PUT + paginated GET, log redaction, and SQLite zero-room-persistence", async () => {
    const devOrigin = "http://localhost:5173";
    const capturedLogs: string[] = [];
    const srv = startTestServer(
      {
        allowedOrigins: [devOrigin],
        relay: {
          enabled: true,
          ttlMs: 120_000,
          maxFileBytes: 1_048_576,
          maxTotalBytes: 8_388_608,
        },
      },
      capturedLogs,
    );

    const metaRes = await fetch(`${srv.url}/api/v1/meta`);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as MetaResponse;
    expect(meta.relay).toEqual({
      enabled: true,
      ttlMs: 120_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 8_388_608,
    });

    const boxId = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);
    const blob1 = "11112222333344445555666677778888";
    const blob2 = "9999aaaabbbbccccddddeeeeffff0001";
    const blob3 = "9999aaaabbbbccccddddeeeeffff0002";
    const fileTag = "fedcba9876543210fedcba9876543210";
    const chunkId = "0123456789abcdef0123456789abcdef";

    // CORS preflight on relay PUT includes PUT method and redacts boxId/blobId in logs
    const preflightRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob1}`,
      {
        method: "OPTIONS",
        headers: { Origin: devOrigin },
      },
    );
    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );

    // Unauthenticated requests are rejected with 401
    const unauthGet = await fetch(`${srv.url}/api/v1/relay/${boxId}/envelopes`);
    expect(unauthGet.status).toBe(401);

    // Register Web user (Cookie + CSRF) and CLI user (Bearer)
    const webRegRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: devOrigin },
      body: JSON.stringify({
        username: "relay_web",
        password: "relay-web-password-123",
        clientKind: "web",
      }),
    });
    expect(webRegRes.status).toBe(201);
    const webCookie = extractCookiePair(webRegRes.headers.get("set-cookie"));
    const webAuth = (await webRegRes.json()) as WebAuthResponse;

    const cliRegRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "relay_cli",
        password: "relay-cli-password-123",
        clientKind: "cli",
      }),
    });
    expect(cliRegRes.status).toBe(201);
    const cliAuth = (await cliRegRes.json()) as CliAuthResponse;

    const envBytes1 = randomBytes(96);
    const envBytes2 = randomBytes(128);
    const envBytes3 = randomBytes(64);
    const chunkBytes = randomBytes(512);

    // Web Cookie PUT without X-CSRF-Token -> 403 csrf_invalid (both envelope & chunk)
    const noCsrfEnv = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob1}`,
      {
        method: "PUT",
        headers: {
          Cookie: webCookie,
          Origin: devOrigin,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(envBytes1),
      },
    );
    expect(noCsrfEnv.status).toBe(403);
    expect(await noCsrfEnv.json()).toMatchObject({
      ok: false,
      error: { code: "csrf_invalid" },
    });

    const noCsrfChunk = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkId}`,
      {
        method: "PUT",
        headers: {
          Cookie: webCookie,
          Origin: devOrigin,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(chunkBytes),
      },
    );
    expect(noCsrfChunk.status).toBe(403);
    expect(await noCsrfChunk.json()).toMatchObject({
      ok: false,
      error: { code: "csrf_invalid" },
    });

    // Web Cookie PUT with valid X-CSRF-Token -> 201 Created (seq = 1)
    const put1Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob1}`,
      {
        method: "PUT",
        headers: {
          Cookie: webCookie,
          Origin: devOrigin,
          "X-CSRF-Token": webAuth.csrfToken,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(envBytes1),
      },
    );
    expect(put1Res.status).toBe(201);
    const put1Json = (await put1Res.json()) as RelayPutEnvelopeResponse;
    expect(put1Json.ok).toBe(true);
    expect(put1Json.seq).toBe(1);
    expect(put1Json.created).toBe(true);

    // Idempotent re-PUT of same (boxId, blobId) -> 200 OK, created: false, seq unchanged
    const put1DupRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob1}`,
      {
        method: "PUT",
        headers: {
          Cookie: webCookie,
          Origin: devOrigin,
          "X-CSRF-Token": webAuth.csrfToken,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(envBytes1),
      },
    );
    expect(put1DupRes.status).toBe(200);
    const put1DupJson = (await put1DupRes.json()) as RelayPutEnvelopeResponse;
    expect(put1DupJson).toEqual({
      ok: true,
      seq: 1,
      created: false,
      expiresAt: put1Json.expiresAt,
    });

    // CLI Bearer token PUT for blob2 (seq = 2) and blob3 (seq = 3)
    const bearerHeaders = { Authorization: `Bearer ${cliAuth.sessionToken}` };
    const put2Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob2}`,
      {
        method: "PUT",
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(envBytes2),
      },
    );
    expect(put2Res.status).toBe(201);
    expect(((await put2Res.json()) as RelayPutEnvelopeResponse).seq).toBe(2);

    const put3Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${blob3}`,
      {
        method: "PUT",
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(envBytes3),
      },
    );
    expect(put3Res.status).toBe(201);
    expect(((await put3Res.json()) as RelayPutEnvelopeResponse).seq).toBe(3);

    // Paginated GET ?afterSeq=0&limit=2 via Web Cookie (no CSRF needed on GET)
    const page1Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0&limit=2`,
      {
        headers: { Cookie: webCookie, Origin: devOrigin },
      },
    );
    expect(page1Res.status).toBe(200);
    const page1Json = (await page1Res.json()) as RelayListEnvelopesResponse;
    expect(isValidRelayListEnvelopesResponse(page1Json)).toBe(true);
    expect(page1Json.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(page1Json.items.map((i) => i.blobId)).toEqual([blob1, blob2]);
    expect(page1Json.nextCursor).toBe(2);
    expect(page1Json.hasMore).toBe(true);
    expect(base64UrlToBytes(page1Json.items[0]!.payloadB64)).toEqual(envBytes1);
    expect(base64UrlToBytes(page1Json.items[1]!.payloadB64)).toEqual(envBytes2);

    // Page 2 via CLI Bearer: ?afterSeq=2&limit=2 -> [seq=3], hasMore=false, nextCursor=3
    const page2Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=2&limit=2`,
      { headers: bearerHeaders },
    );
    expect(page2Res.status).toBe(200);
    const page2Json = (await page2Res.json()) as RelayListEnvelopesResponse;
    expect(page2Json.items.map((i) => i.seq)).toEqual([3]);
    expect(page2Json.nextCursor).toBe(3);
    expect(page2Json.hasMore).toBe(false);
    expect(base64UrlToBytes(page2Json.items[0]!.payloadB64)).toEqual(envBytes3);

    // Empty page when caught up: nextCursor === afterSeq
    const page3Res = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=3&limit=10`,
      { headers: bearerHeaders },
    );
    expect(page3Res.status).toBe(200);
    expect(await page3Res.json()).toEqual({
      ok: true,
      items: [],
      nextCursor: 3,
      hasMore: false,
    });

    // Parameter & payload boundary validation (400 / 413)
    const tooSmallEnv = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/00001111222233334444555566667777`,
      {
        method: "PUT",
        headers: bearerHeaders,
        body: new Uint8Array(39),
      },
    );
    expect(tooSmallEnv.status).toBe(400);

    const tooLargeEnv = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/00001111222233334444555566667777`,
      {
        method: "PUT",
        headers: bearerHeaders,
        body: new Uint8Array(MAX_RELAY_ENVELOPE_CIPHERTEXT_BYTES + 1),
      },
    );
    expect(tooLargeEnv.status).toBe(413);

    const badLimitRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?limit=101`,
      { headers: bearerHeaders },
    );
    expect(badLimitRes.status).toBe(400);

    // Chunk PUT + binary GET via CLI Bearer
    const putChunkRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkId}`,
      {
        method: "PUT",
        headers: bearerHeaders,
        body: new Uint8Array(chunkBytes),
      },
    );
    expect(putChunkRes.status).toBe(201);
    const putChunkJson = (await putChunkRes.json()) as RelayPutChunkResponse;
    expect(putChunkJson.ok).toBe(true);
    expect(putChunkJson.created).toBe(true);

    const getChunkRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkId}`,
      {
        headers: { ...bearerHeaders, Origin: devOrigin },
      },
    );
    expect(getChunkRes.status).toBe(200);
    expect(getChunkRes.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(getChunkRes.headers.get("cache-control")).toBe("no-store");
    expect(getChunkRes.headers.get("access-control-allow-origin")).toBe(
      devOrigin,
    );
    const downloadedChunk = new Uint8Array(await getChunkRes.arrayBuffer());
    expect(downloadedChunk).toEqual(new Uint8Array(chunkBytes));

    // CRITICAL: Boundary log verification - boxId, blobId, fileTag, and chunkId NEVER appear in logs
    expect(capturedLogs.length).toBeGreaterThan(0);
    const relayLogPaths = new Set<string>();
    for (const line of capturedLogs) {
      expect(line).not.toContain(boxId);
      expect(line).not.toContain(boxId.slice(0, 16));
      expect(line).not.toContain(blob1);
      expect(line).not.toContain(blob2);
      expect(line).not.toContain(blob3);
      expect(line).not.toContain(fileTag);
      expect(line).not.toContain(chunkId);
      const parsed = JSON.parse(line) as { path?: string; event?: string };
      if (parsed.path?.startsWith("/api/v1/relay")) {
        relayLogPaths.add(parsed.path);
      }
    }
    expect(Array.from(relayLogPaths).sort()).toEqual([
      "/api/v1/relay/:boxId/chunks",
      "/api/v1/relay/:boxId/envelopes",
    ]);

    // SQLite zero-room-persistence verification
    const tables = srv.sqliteDb
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["schema_migrations", "sessions", "users"]);

    const dumpJson = JSON.stringify({
      users: srv.sqliteDb.query("SELECT * FROM users").all(),
      sessions: srv.sqliteDb
        .query("SELECT id, user_id, client_kind FROM sessions")
        .all(),
    });
    expect(dumpJson).not.toContain(boxId.slice(0, 16));
    expect(dumpJson).not.toContain(blob1);
    expect(dumpJson).not.toContain(fileTag);
  });

  test("11. Relay quotas (per-file 413 maxFileBytes & global maxTotalBytes LRU eviction), ttlMs expiration, disabled relay (404), and rate limiting (429)", async () => {
    let now = 1_763_000_000_000;
    const clock = { nowMs: () => now };

    const srv = startTestServer({
      clock,
      relay: {
        enabled: true,
        ttlMs: 10_000,
        maxFileBytes: 250,
        maxTotalBytes: 350,
        sweepIntervalMs: 0,
      },
      relayEnvelopeRateLimit: {
        capacity: 4,
        refillPerSecond: 0,
      },
    });

    const regRes = await fetch(`${srv.url}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "quota_tester",
        password: "quota-password-123",
        clientKind: "cli",
      }),
    });
    const auth = (await regRes.json()) as CliAuthResponse;
    const headers = { Authorization: `Bearer ${auth.sessionToken}` };

    const boxId = "b".repeat(64);
    const fileA = "1".repeat(32);
    const fileB = "2".repeat(32);
    const c1 = "a".repeat(32);
    const c2 = "b".repeat(32);
    const c3 = "c".repeat(32);
    const cB1 = "d".repeat(32);

    const bytes120A = randomBytes(120);
    const bytes120B = randomBytes(120);
    const bytes40 = randomBytes(40);
    const bytes150 = randomBytes(150);

    // Put c1 (120 B) and c2 (120 B) under fileA -> 240 B <= 250 B maxFileBytes
    now += 10;
    expect(
      (
        await fetch(
          `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c1}`,
          { method: "PUT", headers, body: new Uint8Array(bytes120A) },
        )
      ).status,
    ).toBe(201);

    now += 10;
    expect(
      (
        await fetch(
          `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c2}`,
          { method: "PUT", headers, body: new Uint8Array(bytes120B) },
        )
      ).status,
    ).toBe(201);

    // Idempotent re-PUT of c2 at boundary (240 B) succeeds with 200 without exceeding maxFileBytes
    const dupC2 = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c2}`,
      { method: "PUT", headers, body: new Uint8Array(bytes120B) },
    );
    expect(dupC2.status).toBe(200);
    expect(((await dupC2.json()) as RelayPutChunkResponse).created).toBe(false);

    // Third chunk c3 (40 B) under fileA -> 240 + 40 = 280 > 250 -> 413 payload_too_large
    const overFileQuota = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c3}`,
      { method: "PUT", headers, body: new Uint8Array(bytes40) },
    );
    expect(overFileQuota.status).toBe(413);
    expect(await overFileQuota.json()).toMatchObject({
      ok: false,
      error: { code: "payload_too_large" },
    });

    // Touch c1 via GET so c1 becomes MRU and c2 becomes the oldest LRU entry
    now += 10;
    const readC1Before = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c1}`,
      { headers },
    );
    expect(readC1Before.status).toBe(200);
    expect(new Uint8Array(await readC1Before.arrayBuffer())).toEqual(
      new Uint8Array(bytes120A),
    );

    // Put cB1 (150 B) under fileB: total 240 + 150 = 390 > 350 maxTotalBytes -> evicts LRU c2 (120 B), keeping c1!
    now += 10;
    const putCB1 = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileB}/chunks/${cB1}`,
      { method: "PUT", headers, body: new Uint8Array(bytes150) },
    );
    expect(putCB1.status).toBe(201);

    // c2 was LRU-evicted -> 404
    const evictedC2 = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c2}`,
      { headers },
    );
    expect(evictedC2.status).toBe(404);

    // c1 (touched recently) and cB1 (newly added) remain available -> 200
    expect(
      (
        await fetch(
          `${srv.url}/api/v1/relay/${boxId}/files/${fileA}/chunks/${c1}`,
          { headers },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${srv.url}/api/v1/relay/${boxId}/files/${fileB}/chunks/${cB1}`,
          { headers },
        )
      ).status,
    ).toBe(200);

    // Put an envelope (consumes 1st of 4 envelope rate-limit tokens)
    const envBlob = "e".repeat(32);
    const putEnv = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes/${envBlob}`,
      { method: "PUT", headers, body: new Uint8Array(randomBytes(48)) },
    );
    expect(putEnv.status).toBe(201);

    // Advance clock past ttlMs (10_000 ms) -> chunks and envelopes expire immediately
    now += 15_000;

    const expiredChunkRes = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/files/${fileB}/chunks/${cB1}`,
      { headers },
    );
    expect(expiredChunkRes.status).toBe(404);

    // Uses 2nd envelope token -> expired envelope is purged and omitted
    const expiredEnvList = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0`,
      { headers },
    );
    expect(expiredEnvList.status).toBe(200);
    expect(
      ((await expiredEnvList.json()) as RelayListEnvelopesResponse).items,
    ).toEqual([]);

    // Exhaust remaining 2 envelope tokens (3rd & 4th), then 5th returns 429 rate_limited
    await fetch(`${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0`, {
      headers,
    });
    await fetch(`${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0`, {
      headers,
    });
    const rateLimitedEnv = await fetch(
      `${srv.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0`,
      { headers },
    );
    expect(rateLimitedEnv.status).toBe(429);
    expect(await rateLimitedEnv.json()).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });

    // Disabled relay returns 404 on relay endpoints and reports enabled: false on /meta
    const disabledSrv = startTestServer({
      relay: { enabled: false },
    });
    const disabledMeta = (await (
      await fetch(`${disabledSrv.url}/api/v1/meta`)
    ).json()) as MetaResponse;
    expect(disabledMeta.relay?.enabled).toBe(false);

    const disabledReg = (await (
      await fetch(`${disabledSrv.url}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "disabled_user",
          password: "disabled-password-123",
          clientKind: "cli",
        }),
      })
    ).json()) as CliAuthResponse;

    const disabledRelayRes = await fetch(
      `${disabledSrv.url}/api/v1/relay/${boxId}/envelopes`,
      {
        headers: { Authorization: `Bearer ${disabledReg.sessionToken}` },
      },
    );
    expect(disabledRelayRes.status).toBe(404);
  });

  test("12. FsBlindRelayStore persists non-expired blobs across server restarts, preserves monotonic seq, and purges orphan .tmp & expired files on startup", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "simpleim-relay-fs-"));
    const dbPath = join(tempDir, "simpleim.sqlite");
    const cacheDir = join(tempDir, "relay-cache");

    let now = 1_763_500_000_000;
    const clock = { nowMs: () => now };

    function collectFilesRecursive(dir: string): string[] {
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          out.push(...collectFilesRecursive(full));
        } else {
          out.push(full);
        }
      }
      return out;
    }

    try {
      const srv1 = startTestServer({
        sqlitePath: dbPath,
        clock,
        relay: {
          enabled: true,
          cacheDir,
          ttlMs: 60_000,
          maxFileBytes: 1_048_576,
          maxTotalBytes: 4_194_304,
          sweepIntervalMs: 0,
        },
      });

      const regRes = await fetch(`${srv1.url}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "fs_relay_user",
          password: "fs-relay-password-123",
          clientKind: "cli",
        }),
      });
      expect(regRes.status).toBe(201);
      const auth = (await regRes.json()) as CliAuthResponse;
      const headers = { Authorization: `Bearer ${auth.sessionToken}` };

      const boxId = "c".repeat(64);
      const fileTag = "3".repeat(32);
      const envBlobExpired = "00000000000000000000000000000001";
      const envBlobAlive = "00000000000000000000000000000002";
      const envBlobAfterRestart = "00000000000000000000000000000003";
      const chunkExpired = "000000000000000000000000000000a1";
      const chunkAlive = "000000000000000000000000000000a2";

      const envPayloadExpired = randomBytes(80);
      const envPayloadAlive = randomBytes(104);
      const envPayloadAfter = randomBytes(72);
      const chunkPayloadExpired = randomBytes(256);
      const chunkPayloadAlive = randomBytes(384);

      // At t = now (expires at now + 60_000): store env1 (seq=1) and chunkExpired
      expect(
        (
          await fetch(
            `${srv1.url}/api/v1/relay/${boxId}/envelopes/${envBlobExpired}`,
            { method: "PUT", headers, body: new Uint8Array(envPayloadExpired) },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await fetch(
            `${srv1.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkExpired}`,
            {
              method: "PUT",
              headers,
              body: new Uint8Array(chunkPayloadExpired),
            },
          )
        ).status,
      ).toBe(201);

      // Advance 40s (expires at t0 + 100_000): store env2 (seq=2) and chunkAlive
      now += 40_000;
      const putEnv2 = await fetch(
        `${srv1.url}/api/v1/relay/${boxId}/envelopes/${envBlobAlive}`,
        { method: "PUT", headers, body: new Uint8Array(envPayloadAlive) },
      );
      expect(putEnv2.status).toBe(201);
      expect(((await putEnv2.json()) as RelayPutEnvelopeResponse).seq).toBe(2);

      expect(
        (
          await fetch(
            `${srv1.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkAlive}`,
            { method: "PUT", headers, body: new Uint8Array(chunkPayloadAlive) },
          )
        ).status,
      ).toBe(201);

      await srv1.stop(true);
      srv1.sqliteDb.close(false);

      // Plant orphan .tmp files at root and inside nested v1/envelopes directory
      const rootOrphanTmp = join(cacheDir, "interrupted-upload.tmp");
      const nestedOrphanTmp = join(
        cacheDir,
        "v1",
        "envelopes",
        "cc",
        boxId,
        "partial_write.bin.9999.1.tmp",
      );
      writeFileSync(rootOrphanTmp, new Uint8Array(64));
      writeFileSync(nestedOrphanTmp, new Uint8Array(64));
      expect(existsSync(rootOrphanTmp)).toBe(true);
      expect(existsSync(nestedOrphanTmp)).toBe(true);

      // Advance clock another 30s (total +70s from t0): env1 & chunkExpired are now expired, env2 & chunkAlive remain valid
      now += 30_000;

      const srv2 = startTestServer({
        sqlitePath: dbPath,
        clock,
        relay: {
          enabled: true,
          cacheDir,
          ttlMs: 60_000,
          maxFileBytes: 1_048_576,
          maxTotalBytes: 4_194_304,
          sweepIntervalMs: 0,
        },
      });

      // Startup scan deleted all .tmp files and expired .bin files on disk
      expect(existsSync(rootOrphanTmp)).toBe(false);
      expect(existsSync(nestedOrphanTmp)).toBe(false);
      const remainingDiskFiles = collectFilesRecursive(cacheDir);
      expect(remainingDiskFiles.some((f) => f.endsWith(".tmp"))).toBe(false);
      expect(remainingDiskFiles.some((f) => f.includes(envBlobExpired))).toBe(
        false,
      );
      expect(remainingDiskFiles.some((f) => f.includes(chunkExpired))).toBe(
        false,
      );
      expect(remainingDiskFiles.length).toBe(2);

      // Non-expired envelope (seq=2) survived restart intact; expired seq=1 is absent
      const listAfterRestart = await fetch(
        `${srv2.url}/api/v1/relay/${boxId}/envelopes?afterSeq=0`,
        { headers },
      );
      expect(listAfterRestart.status).toBe(200);
      const listJson =
        (await listAfterRestart.json()) as RelayListEnvelopesResponse;
      expect(listJson.items.length).toBe(1);
      expect(listJson.items[0]?.seq).toBe(2);
      expect(listJson.items[0]?.blobId).toBe(envBlobAlive);
      expect(base64UrlToBytes(listJson.items[0]!.payloadB64)).toEqual(
        envPayloadAlive,
      );

      // Expired chunk returns 404; surviving chunk returns exact binary payload
      const deadChunkRes = await fetch(
        `${srv2.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkExpired}`,
        { headers },
      );
      expect(deadChunkRes.status).toBe(404);

      const aliveChunkRes = await fetch(
        `${srv2.url}/api/v1/relay/${boxId}/files/${fileTag}/chunks/${chunkAlive}`,
        { headers },
      );
      expect(aliveChunkRes.status).toBe(200);
      expect(new Uint8Array(await aliveChunkRes.arrayBuffer())).toEqual(
        new Uint8Array(chunkPayloadAlive),
      );

      // New envelope after restart continues monotonic sequence at seq = 3
      const putEnv3 = await fetch(
        `${srv2.url}/api/v1/relay/${boxId}/envelopes/${envBlobAfterRestart}`,
        { method: "PUT", headers, body: new Uint8Array(envPayloadAfter) },
      );
      expect(putEnv3.status).toBe(201);
      expect(((await putEnv3.json()) as RelayPutEnvelopeResponse).seq).toBe(3);

      // SQLite still strictly contains ONLY schema_migrations, sessions, users
      const sqliteTables = srv2.sqliteDb
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
        )
        .all()
        .map((r) => r.name);
      expect(sqliteTables).toEqual(["schema_migrations", "sessions", "users"]);

      await srv2.stop(true);
      srv2.sqliteDb.close(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
