import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ClientKind,
  IceServerConfig,
  PeerCertRequest,
  PeerIdentityCert,
} from "@simpleim/contracts";
import {
  bytesToBase64Url,
  concatBytes,
  constantTimeEqual,
  ed25519KeyPairFromPrivateKey,
  generateEd25519KeyPair,
  generatePrefixedId,
  issuePeerIdentityCert,
  randomBytes,
  sha256Bytes,
  utf8ToBytes,
  verifyPopRequest,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import type { IdentitySignerPort, PasswordHasherPort } from "../domain/index.ts";

export interface BunPasswordHasherOptions {
  readonly memoryCost?: number;
  readonly timeCost?: number;
}

export class BunPasswordHasher implements PasswordHasherPort {
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly dummyHashPromise: Promise<string>;

  constructor(options?: BunPasswordHasherOptions) {
    this.memoryCost = options?.memoryCost ?? 65_536;
    this.timeCost = options?.timeCost ?? 3;
    const dummySecret = bytesToBase64Url(randomBytes(32));
    this.dummyHashPromise = Bun.password.hash(dummySecret, {
      algorithm: "argon2id",
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
    });
  }

  hash(password: string): Promise<string> {
    return Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
    });
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    return Bun.password.verify(password, passwordHash);
  }

  async verifyDummy(password: string): Promise<void> {
    const dummyHash = await this.dummyHashPromise;
    await Bun.password.verify(password, dummyHash);
  }
}

export interface ServerIdentitySignerOptions {
  readonly serverKeyId?: string;
  readonly privateKeyBase64Url?: string;
  readonly persistedKeyPath?: string;
  readonly requireExplicitKey?: boolean;
  readonly coturnUrls?: readonly string[];
  readonly coturnSharedSecret?: string;
  readonly turnTtlSeconds?: number;
}

function resolveOrPersistServerKeyPair(
  options?: ServerIdentitySignerOptions,
): Ed25519KeyPair {
  const explicit = options?.privateKeyBase64Url?.trim();
  if (explicit) {
    return ed25519KeyPairFromPrivateKey(explicit);
  }
  if (options?.requireExplicitKey) {
    throw new Error(
      "SERVER_IDENTITY_PRIVATE_KEY is required when NODE_ENV=production so PeerIdentityCerts and CSRF secrets survive server restarts",
    );
  }
  const keyPath = options?.persistedKeyPath?.trim();
  if (keyPath) {
    if (existsSync(keyPath)) {
      const saved = readFileSync(keyPath, "utf8").trim();
      return ed25519KeyPairFromPrivateKey(saved);
    }
    const generated = generateEd25519KeyPair();
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${generated.privateKeyBase64Url}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Ignore chmod errors on filesystems without POSIX permissions
    }
    return generated;
  }
  return generateEd25519KeyPair();
}

export class ServerIdentitySigner implements IdentitySignerPort {
  readonly serverKeyId: string;
  readonly serverSignPubKey: string;
  private readonly keyPair: Ed25519KeyPair;
  private readonly csrfSecret: Uint8Array;
  private readonly coturnUrls: readonly string[];
  private readonly coturnSharedSecret: string | undefined;
  private readonly turnTtlSeconds: number;

  constructor(options?: ServerIdentitySignerOptions) {
    this.serverKeyId = options?.serverKeyId || "srvk_2026_01";
    this.keyPair = resolveOrPersistServerKeyPair(options);
    this.serverSignPubKey = this.keyPair.publicKeyBase64Url;
    this.csrfSecret = sha256Bytes(
      concatBytes(
        utf8ToBytes("simpleim/v1/csrf-hmac-key\0"),
        this.keyPair.privateKeyBytes,
      ),
    );
    this.coturnUrls = (options?.coturnUrls ?? []).filter((u) => u.length > 0);
    this.coturnSharedSecret = options?.coturnSharedSecret || undefined;
    this.turnTtlSeconds = options?.turnTtlSeconds ?? 43_200; // 12 hours
  }

  generateUserId(nowMs: number): string {
    return generatePrefixedId("usr", nowMs);
  }

  generateSessionId(nowMs: number): string {
    return generatePrefixedId("ses", nowMs);
  }

  generateSessionToken(): { rawToken: string; tokenSha256: Uint8Array } {
    const rawToken = bytesToBase64Url(randomBytes(32));
    return {
      rawToken,
      tokenSha256: sha256Bytes(rawToken),
    };
  }

  hashSessionToken(rawToken: string): Uint8Array {
    return sha256Bytes(rawToken);
  }

  deriveCsrfToken(rawSessionToken: string): string {
    const digest = createHmac("sha256", this.csrfSecret)
      .update(`simpleim/v1/csrf:${rawSessionToken}`)
      .digest();
    return bytesToBase64Url(new Uint8Array(digest));
  }

  verifyCsrfToken(
    rawSessionToken: string,
    candidateCsrfToken: string,
  ): boolean {
    if (
      typeof candidateCsrfToken !== "string" ||
      candidateCsrfToken.length === 0
    ) {
      return false;
    }
    const expected = this.deriveCsrfToken(rawSessionToken);
    if (candidateCsrfToken.length !== expected.length) {
      return false;
    }
    return constantTimeEqual(
      utf8ToBytes(expected),
      utf8ToBytes(candidateCsrfToken),
    );
  }

  verifyPop(params: {
    userId: string;
    request: PeerCertRequest;
    nowMs: number;
    maxSkewMs: number;
  }): boolean {
    return verifyPopRequest({
      userId: params.userId,
      request: params.request,
      nowMs: params.nowMs,
      maxSkewMs: params.maxSkewMs,
    });
  }

  signPeerCert(params: {
    userId: string;
    username: string;
    displayName: string;
    peerId: string;
    peerSignPubKey: string;
    clientKind: ClientKind;
    nowMs: number;
    ttlMs: number;
  }): PeerIdentityCert {
    return issuePeerIdentityCert({
      serverKeyId: this.serverKeyId,
      serverSignPrivKey: this.keyPair.privateKeyBytes,
      userId: params.userId,
      username: params.username,
      displayName: params.displayName,
      peerId: params.peerId,
      peerSignPubKey: params.peerSignPubKey,
      clientKind: params.clientKind,
      nowMs: params.nowMs,
      ttlMs: params.ttlMs,
    });
  }

  buildTurnCredentials(userId: string, nowMs: number): IceServerConfig | null {
    if (!this.coturnSharedSecret || this.coturnUrls.length === 0) {
      return null;
    }
    const expiresUnix = Math.floor(nowMs / 1000) + this.turnTtlSeconds;
    const turnUsername = `${expiresUnix}:${userId}`;
    const credential = createHmac("sha1", this.coturnSharedSecret)
      .update(turnUsername)
      .digest("base64");
    return {
      urls: [...this.coturnUrls],
      username: turnUsername,
      credential,
    };
  }
}
