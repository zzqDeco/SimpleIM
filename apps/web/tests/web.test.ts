import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  hasChunkInBitfield,
  SWARM_CHUNK_SIZE,
  type FileManifest,
} from "@simpleim/contracts";
import {
  deriveRoomKeys,
  generateEd25519KeyPair,
  issuePeerIdentityCert,
  sha256Hex,
} from "@simpleim/crypto";
import { HttpAuthClient } from "../src/api/http-client.ts";
import { deriveRoomKeysOffThread } from "../src/crypto/kdf-client.ts";
import {
  createBrowserFileChunkReader,
  OpfsChunkStorageAdapter,
} from "../src/storage/opfs-chunk-storage.ts";
import {
  OpfsWorkerStorageCore,
  type OpfsDirectoryHandleLike,
  type OpfsFileHandleLike,
  type OpfsSyncAccessHandleLike,
} from "../src/storage/opfs-protocol.ts";
import {
  formatBytes,
  formatMessageTime,
  formatRoomFingerprint,
  formatSha256Prefix,
  formatSpeedMBps,
} from "../src/utils/format.ts";
import {
  renderSafeMarkdown,
  sanitizeLinkUrl,
  tokenizeInlineMarkdown,
  tokenizeMarkdownBlocks,
} from "../src/utils/markdown.tsx";

function buildDummyManifest(params: {
  fileId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
}): FileManifest {
  const serverKeys = generateEd25519KeyPair();
  const peerKeys = generateEd25519KeyPair();
  const cert = issuePeerIdentityCert({
    serverKeyId: "srvk_test",
    serverSignPrivKey: serverKeys.privateKeyBytes,
    userId: "usr_019a0000000070008000000000000001",
    username: "alice",
    displayName: "Alice",
    peerId: "peer_019a0000000070008000000000000001",
    peerSignPubKey: peerKeys.publicKeyBase64Url,
    clientKind: "web",
  });

  return {
    fileId: params.fileId,
    roomId: "a".repeat(64),
    fileName: params.fileName,
    fileSize: params.fileSize,
    mimeType: "application/octet-stream",
    chunkSize: SWARM_CHUNK_SIZE,
    totalChunks: params.totalChunks,
    fileSha256: "b".repeat(64),
    chunkHashes: Array.from({ length: params.totalChunks }, () => "c".repeat(64)),
    senderCert: cert,
    senderSig: "A".repeat(86),
  };
}

describe("Safe Markdown Tokenizer & React Renderer", () => {
  test("renders fenced code, inline code, bold, italic, and safe https links cleanly", () => {
    const md = [
      "Hello **Alice** and *Bob* with `XChaCha20-Poly1305`!",
      "Check [SimpleIM Docs](https://example.com/docs?v=1) or https://webrtc.org.",
      "",
      "```ts",
      "const x = 1 < 2 && 3 > 1;",
      "```",
    ].join("\n");

    const blocks = tokenizeMarkdownBlocks(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[1]).toEqual({
      type: "code_block",
      language: "ts",
      code: "const x = 1 < 2 && 3 > 1;",
    });

    const html = renderToStaticMarkup(renderSafeMarkdown(md));
    expect(html).toContain("<strong>Alice</strong>");
    expect(html).toContain("<em>Bob</em>");
    expect(html).toContain('<code class="md-inline-code">XChaCha20-Poly1305</code>');
    expect(html).toContain(
      '<a href="https://example.com/docs?v=1" target="_blank" rel="noopener noreferrer" class="md-link">SimpleIM Docs</a>',
    );
    expect(html).toContain(
      '<a href="https://webrtc.org/" target="_blank" rel="noopener noreferrer" class="md-link">https://webrtc.org</a>',
    );
    expect(html).toContain(
      '<pre class="md-code-block"><code data-lang="ts">const x = 1 &lt; 2 &amp;&amp; 3 &gt; 1;</code></pre>',
    );
  });

  test("refuses javascript:, data:, vbscript: URLs and escapes raw HTML tags", () => {
    expect(sanitizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeLinkUrl("  JAVASCRIPT:alert(document.cookie) ")).toBeNull();
    expect(sanitizeLinkUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeLinkUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeLinkUrl("/relative/path")).toBeNull();
    expect(sanitizeLinkUrl("https://safe.example.org/hello")).toBe(
      "https://safe.example.org/hello",
    );

    const malicious =
      '[Click Me](javascript:alert(1)) and [Payload](DATA:text/html;base64,PHNjcmlwdD4=) <script>alert("xss")</script> <img src=x onerror=alert(1)>';

    const tokens = tokenizeInlineMarkdown(malicious);
    expect(tokens.some((t) => t.type === "link")).toBe(false);

    const html = renderToStaticMarkup(renderSafeMarkdown(malicious));
    expect(html).not.toContain("<a");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("data:text/html");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("Click Me");
  });
});

describe("Formatting Helpers", () => {
  test("formats byte sizes, MB/s speeds, SHA-256 prefixes, and room fingerprints", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-15)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(65_536)).toBe("64.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");

    expect(formatSpeedMBps(0)).toBe("0.00 MB/s");
    expect(formatSpeedMBps(512 * 1024)).toBe("0.50 MB/s");
    expect(formatSpeedMBps(12.25 * 1024 * 1024)).toBe("12.25 MB/s");

    expect(
      formatRoomFingerprint(
        "A1B2C3D4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      ),
    ).toBe("#a1b2c3d4");

    expect(formatSha256Prefix("ABCDEF0123456789abcdef", 12)).toBe("abcdef012345");
    expect(formatMessageTime(0)).toBe("--:--");
    expect(formatMessageTime(1_763_047_215_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("OPFS Worker Fallback & SyncAccessHandle Storage Protocol", () => {
  test("fallback storage protocol handles initReceivingFile, writeVerifiedChunk, readChunk, finalizeFile, and closeAll", async () => {
    const adapter = new OpfsChunkStorageAdapter({
      forceInlineFallback: true,
      storageProvider: () => undefined,
    });

    const fileId = "019a0000-0000-7000-8000-000000000101";
    const totalSize = SWARM_CHUNK_SIZE + 1234;
    const manifest = buildDummyManifest({
      fileId,
      fileName: "report.pdf",
      fileSize: totalSize,
      totalChunks: 2,
    });

    const { existingBitfield } = await adapter.initReceivingFile(manifest);
    expect(existingBitfield.byteLength).toBe(1);
    expect(hasChunkInBitfield(existingBitfield, 0)).toBe(false);

    const chunk0 = new Uint8Array(SWARM_CHUNK_SIZE);
    for (let i = 0; i < chunk0.byteLength; i++) {
      chunk0[i] = i & 0xff;
    }
    const chunk1 = new Uint8Array(1234);
    for (let i = 0; i < chunk1.byteLength; i++) {
      chunk1[i] = (255 - i) & 0xff;
    }

    await adapter.writeVerifiedChunk(fileId, 0, chunk0);
    await adapter.writeVerifiedChunk(fileId, 1, chunk1);

    const reInit = await adapter.initReceivingFile(manifest);
    expect(hasChunkInBitfield(reInit.existingBitfield, 0)).toBe(true);
    expect(hasChunkInBitfield(reInit.existingBitfield, 1)).toBe(true);

    await adapter.finalizeFile(fileId);
    expect(adapter.isSaveAvailable(fileId)).toBe(true);

    const read0 = await adapter.readChunk(fileId, 0, SWARM_CHUNK_SIZE);
    const read1 = await adapter.readChunk(fileId, 1, 1234);
    expect(sha256Hex(read0)).toBe(sha256Hex(chunk0));
    expect(sha256Hex(read1)).toBe(sha256Hex(chunk1));

    await adapter.closeAll();
    await adapter.closeAll(); // Idempotent repeated closeAll()
    expect(adapter.isSaveAvailable(fileId)).toBe(false);
    await expect(adapter.readChunk(fileId, 0, SWARM_CHUNK_SIZE)).rejects.toThrow();
  });

  test("simulated OPFS FileSystemSyncAccessHandle writes at exact 64 KiB offsets, truncates on finalize, and deletes on closeAll", async () => {
    const diskFiles = new Map<string, Uint8Array>();
    let openHandles = 0;
    let removedEntries: string[] = [];

    const createMockFileHandle = (name: string): OpfsFileHandleLike => ({
      async getFile(): Promise<File> {
        const bytes = diskFiles.get(name) ?? new Uint8Array(0);
        return new File([bytes.slice()], name);
      },
      async createSyncAccessHandle(): Promise<OpfsSyncAccessHandleLike> {
        openHandles++;
        let closed = false;
        return {
          write(buffer: Uint8Array, options?: { at?: number }): number {
            const at = options?.at ?? 0;
            const current = diskFiles.get(name) ?? new Uint8Array(0);
            const needed = Math.max(current.byteLength, at + buffer.byteLength);
            const next =
              needed > current.byteLength ? new Uint8Array(needed) : current;
            if (next !== current) {
              next.set(current);
              diskFiles.set(name, next);
            }
            next.set(buffer, at);
            return buffer.byteLength;
          },
          read(buffer: Uint8Array, options?: { at?: number }): number {
            const at = options?.at ?? 0;
            const current = diskFiles.get(name) ?? new Uint8Array(0);
            if (at >= current.byteLength) return 0;
            const available = Math.min(buffer.byteLength, current.byteLength - at);
            buffer.set(current.subarray(at, at + available), 0);
            return available;
          },
          truncate(newSize: number): void {
            const current = diskFiles.get(name) ?? new Uint8Array(0);
            const next = new Uint8Array(newSize);
            next.set(current.subarray(0, Math.min(current.byteLength, newSize)));
            diskFiles.set(name, next);
          },
          flush(): void {},
          close(): void {
            if (!closed) {
              closed = true;
              openHandles--;
            }
          },
        };
      },
    });

    const swarmDirHandle: OpfsDirectoryHandleLike = {
      async getDirectoryHandle() {
        return swarmDirHandle;
      },
      async getFileHandle(name: string) {
        if (!diskFiles.has(name)) {
          diskFiles.set(name, new Uint8Array(0));
        }
        return createMockFileHandle(name);
      },
      async removeEntry(name: string) {
        removedEntries.push(name);
        diskFiles.delete(name);
      },
    };

    const rootDirHandle: OpfsDirectoryHandleLike = {
      async getDirectoryHandle() {
        return swarmDirHandle;
      },
      async getFileHandle(name: string) {
        return createMockFileHandle(name);
      },
      async removeEntry(name: string) {
        removedEntries.push(name);
        diskFiles.clear();
      },
    };

    const core = new OpfsWorkerStorageCore(() => ({
      getDirectory: async () => rootDirHandle,
    }));

    const fileId = "019a0000-0000-7000-8000-000000000202";
    const init = await core.initReceivingFile(fileId, SWARM_CHUNK_SIZE + 500, 2);
    expect(init.backend).toBe("opfs");
    expect(openHandles).toBe(1);

    const c0 = new Uint8Array(SWARM_CHUNK_SIZE).fill(0x41);
    const c1Padded = new Uint8Array(800).fill(0x42);
    await core.writeVerifiedChunk(fileId, 1, c1Padded);
    await core.writeVerifiedChunk(fileId, 0, c0);
    await core.finalizeFile(fileId);

    expect(diskFiles.get(`${fileId}.bin`)?.byteLength).toBe(SWARM_CHUNK_SIZE + 500);

    // Prepare download releases exclusive SyncAccessHandle lock, and subsequent readChunk re-acquires seamlessly
    const prep = await core.prepareDownload(fileId);
    expect(prep.backend).toBe("opfs");
    expect(openHandles).toBe(0);

    const seededSlice = await core.readChunk(fileId, 1, 500);
    expect(seededSlice.byteLength).toBe(500);
    expect(seededSlice[0]).toBe(0x42);

    await core.closeAll();
    expect(openHandles).toBe(0);
    expect(diskFiles.size).toBe(0);
    expect(removedEntries).toContain(`${fileId}.bin`);
  });

  test("createBrowserFileChunkReader slices Blob on demand without full-file buffering", async () => {
    const raw = new Uint8Array(150_000);
    for (let i = 0; i < raw.byteLength; i++) {
      raw[i] = (i * 7) & 0xff;
    }
    const blob = new Blob([raw]);
    const reader = createBrowserFileChunkReader(blob);

    const secondChunk = await reader(1, SWARM_CHUNK_SIZE, SWARM_CHUNK_SIZE);
    expect(secondChunk.byteLength).toBe(SWARM_CHUNK_SIZE);
    expect(sha256Hex(secondChunk)).toBe(
      sha256Hex(raw.subarray(SWARM_CHUNK_SIZE, SWARM_CHUNK_SIZE * 2)),
    );
  });
});

describe("HTTP Auth Client CSRF & Off-Thread KDF", () => {
  test("HttpAuthClient stores CSRF token in memory and attaches X-CSRF-Token on logout and peer-cert", async () => {
    const observedHeaders: Array<{ url: string; csrf: string | null; credentials: string | undefined }> = [];

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const hdrs = new Headers(init?.headers);
      observedHeaders.push({
        url,
        csrf: hdrs.get("x-csrf-token"),
        credentials: init?.credentials,
      });

      if (url.endsWith("/api/v1/auth/login")) {
        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: "usr_019a0000000070008000000000000010",
              username: "alice",
              displayName: "Alice",
              createdAt: 1_763_000_000_000,
            },
            csrfToken: "csrf_secret_in_memory_123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/api/v1/auth/logout")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "not_found", message: "Not found" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new HttpAuthClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: mockFetch,
      enableBroadcastChannel: false,
    });

    const user = await client.login({ username: "Alice", password: "password123" });
    expect(user.username).toBe("alice");
    expect(client.hasCsrfToken()).toBe(true);

    await client.logout();
    expect(client.hasCsrfToken()).toBe(false);
    expect(observedHeaders[0]?.credentials).toBe("include");
    expect(observedHeaders[1]?.url).toContain("/api/v1/auth/logout");
    expect(observedHeaders[1]?.csrf).toBe("csrf_secret_in_memory_123");
    client.dispose();
  });

  test("deriveRoomKeysOffThread matches canonical deriveRoomKeys output", async () => {
    const opts = { memoryKiB: 1024, iterations: 1 };
    const expected = deriveRoomKeys("correct-horse-battery-staple", opts);
    const actual = await deriveRoomKeysOffThread("correct-horse-battery-staple", opts);

    expect(actual.roomId).toBe(expected.roomId);
    expect(actual.roomIdPrefix).toBe(expected.roomIdPrefix);
    expect(sha256Hex(actual.signalingKey)).toBe(sha256Hex(expected.signalingKey));
    expect(sha256Hex(actual.roomAuthKey)).toBe(sha256Hex(expected.roomAuthKey));
    expect(sha256Hex(actual.roomAppKey)).toBe(sha256Hex(expected.roomAppKey));
  });
});
