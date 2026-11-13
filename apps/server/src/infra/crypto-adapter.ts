import { createHmac } from "node:crypto";
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
  readonly coturnUrls?: readonly string[];
  readonly coturnSharedSecret?: string;
  readonly turnTtlSeconds?: number;
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
    this.keyPair = options?.privateKeyBase64Url
      ? ed25519KeyPairFromPrivateKey(options.privateKeyBase64Url)
      : generateEd25519KeyPair();
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
