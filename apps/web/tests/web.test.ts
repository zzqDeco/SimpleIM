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
import { RoomRuntimeSlot } from "../src/App.tsx";
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
  type WebLocksLike,
} from "../src/storage/opfs-protocol.ts";
import { BrowserSignalingClient } from "../src/transport/browser-signaling.ts";
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

  test("enforces maxFallbackBytes cap, isolates OPFS cleanup per instanceId, and fails fast when OPFS Worker crashes", async () => {
    // 1. Bounded fallback storage when OPFS SyncAccessHandle is unavailable
    const cappedFallback = new OpfsChunkStorageAdapter({
      forceInlineFallback: true,
      storageProvider: () => undefined,
      maxFallbackBytes: SWARM_CHUNK_SIZE,
    });
    const tooLargeManifest = buildDummyManifest({
      fileId: "019a0000-0000-7000-8000-000000000301",
      fileName: "huge-video.mp4",
      fileSize: SWARM_CHUNK_SIZE * 2,
      totalChunks: 2,
    });
    await expect(
      cappedFallback.initReceivingFile(tooLargeManifest),
    ).rejects.toThrow("exceeds in-memory fallback cap");
    await cappedFallback.closeAll();

    // 2. Per-instance OPFS directory isolation across concurrent tabs
    const instanceDirs = new Map<string, Map<string, Uint8Array>>();
    const makeInstanceDir = (instName: string): OpfsDirectoryHandleLike => ({
      async getDirectoryHandle() {
        throw new Error("Unexpected nested subdir");
      },
      async getFileHandle(fileName: string) {
        let files = instanceDirs.get(instName);
        if (!files) {
          files = new Map();
          instanceDirs.set(instName, files);
        }
        if (!files.has(fileName)) {
          files.set(fileName, new Uint8Array(0));
        }
        return {
          async getFile() {
            const bytes = files!.get(fileName) ?? new Uint8Array(0);
            return new File([bytes.slice()], fileName);
          },
          async createSyncAccessHandle(): Promise<OpfsSyncAccessHandleLike> {
            return {
              write(buf, opts) {
                const at = opts?.at ?? 0;
                const cur = files!.get(fileName) ?? new Uint8Array(0);
                const next = new Uint8Array(
                  Math.max(cur.byteLength, at + buf.byteLength),
                );
                next.set(cur);
                next.set(buf, at);
                files!.set(fileName, next);
                return buf.byteLength;
              },
              read(buf, opts) {
                const at = opts?.at ?? 0;
                const cur = files!.get(fileName) ?? new Uint8Array(0);
                const avail = Math.min(buf.byteLength, Math.max(0, cur.byteLength - at));
                buf.set(cur.subarray(at, at + avail), 0);
                return avail;
              },
              truncate(sz) {
                const cur = files!.get(fileName) ?? new Uint8Array(0);
                files!.set(fileName, cur.slice(0, sz));
              },
              flush() {},
              close() {},
            };
          },
        };
      },
      async removeEntry(fileName: string) {
        instanceDirs.get(instName)?.delete(fileName);
      },
    });

    const swarmRootHandle: OpfsDirectoryHandleLike = {
      async getDirectoryHandle(name: string) {
        if (!instanceDirs.has(name)) {
          instanceDirs.set(name, new Map());
        }
        return makeInstanceDir(name);
      },
      async getFileHandle() {
        throw new Error("Unexpected root file");
      },
      async removeEntry(name: string) {
        instanceDirs.delete(name);
      },
    };
    const sharedRootHandle: OpfsDirectoryHandleLike = {
      async getDirectoryHandle() {
        return swarmRootHandle;
      },
      async getFileHandle() {
        throw new Error("Unexpected root file");
      },
      async removeEntry() {
        throw new Error("Must NEVER wipe shared simpleim-swarm root directory!");
      },
    };

    const tabACore = new OpfsWorkerStorageCore({
      instanceId: "tab_instance_a",
      storageProvider: () => ({ getDirectory: async () => sharedRootHandle }),
    });
    const tabBCore = new OpfsWorkerStorageCore({
      instanceId: "tab_instance_b",
      storageProvider: () => ({ getDirectory: async () => sharedRootHandle }),
    });

    const fileA = "019a0000-0000-7000-8000-000000000311";
    const fileB = "019a0000-0000-7000-8000-000000000312";
    await tabACore.initReceivingFile(fileA, 16, 1);
    await tabBCore.initReceivingFile(fileB, 16, 1);
    await tabACore.writeVerifiedChunk(fileA, 0, new Uint8Array(16).fill(0xaa));
    await tabBCore.writeVerifiedChunk(fileB, 0, new Uint8Array(16).fill(0xbb));

    // Closing Tab A deletes ONLY tab_instance_a while preserving Tab B's OPFS data!
    await tabACore.closeAll();
    expect(instanceDirs.has("tab_instance_a")).toBe(false);
    expect(instanceDirs.get("tab_instance_b")?.get(`${fileB}.bin`)).toEqual(
      new Uint8Array(16).fill(0xbb),
    );
    await tabBCore.closeAll();
    expect(instanceDirs.has("tab_instance_b")).toBe(false);

    // 3. OPFS Worker crash fails fast on in-flight + subsequent RPCs and does not hang closeAll()
    let mockOnError: ((ev: ErrorEvent) => void) | null = null;
    let terminatedCount = 0;
    const crashingAdapter = new OpfsChunkStorageAdapter({
      workerFactory: () => {
        const fakeWorker = {
          onmessage: null as ((ev: MessageEvent) => void) | null,
          onmessageerror: null as (() => void) | null,
          set onerror(fn: ((ev: ErrorEvent) => void) | null) {
            mockOnError = fn;
          },
          get onerror() {
            return mockOnError;
          },
          postMessage() {
            queueMicrotask(() => {
              mockOnError?.({ message: "Simulated OPFS worker crash" } as ErrorEvent);
            });
          },
          terminate() {
            terminatedCount += 1;
          },
        };
        return fakeWorker as unknown as Worker;
      },
    });

    const crashManifest = buildDummyManifest({
      fileId: "019a0000-0000-7000-8000-000000000321",
      fileName: "crash.bin",
      fileSize: 64,
      totalChunks: 1,
    });
    await expect(
      crashingAdapter.initReceivingFile(crashManifest),
    ).rejects.toThrow("Simulated OPFS worker crash");
    expect(terminatedCount).toBe(1);

    // Subsequent calls fail immediately with the stored worker error instead of hanging
    await expect(
      crashingAdapter.initReceivingFile(crashManifest),
    ).rejects.toThrow("Simulated OPFS worker crash");

    // closeAll() resolves immediately without hanging on the dead worker
    await crashingAdapter.closeAll();

    // 4. Worker crash after writing OPFS chunks cleans up simpleim-swarm/<crashedInstanceId>,
    // and hard-crashed tab directories are reclaimed via Web Locks while preserving live tabs!
    const sharedHolders = new Map<string, number>();
    const exclusiveHeld = new Set<string>();
    const mockLocks: WebLocksLike = {
      async request<T>(
        name: string,
        options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean },
        callback: (lock: object | null) => Promise<T> | T,
      ): Promise<T> {
        const mode = options.mode ?? "exclusive";
        if (mode === "shared") {
          sharedHolders.set(name, (sharedHolders.get(name) ?? 0) + 1);
          try {
            return await callback({ name, mode });
          } finally {
            const next = (sharedHolders.get(name) ?? 1) - 1;
            if (next <= 0) {
              sharedHolders.delete(name);
            } else {
              sharedHolders.set(name, next);
            }
          }
        }
        const busy =
          (sharedHolders.get(name) ?? 0) > 0 || exclusiveHeld.has(name);
        if (options.ifAvailable && busy) {
          return await callback(null);
        }
        exclusiveHeld.add(name);
        try {
          return await callback({ name, mode });
        } finally {
          exclusiveHeld.delete(name);
        }
      },
    };

    const enumerableSwarmRoot: OpfsDirectoryHandleLike = {
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        if (!instanceDirs.has(name)) {
          if (!opts?.create) {
            throw new Error(`Directory not found: ${name}`);
          }
          instanceDirs.set(name, new Map());
        }
        return makeInstanceDir(name);
      },
      async getFileHandle() {
        throw new Error("Unexpected root file");
      },
      async removeEntry(name: string) {
        instanceDirs.delete(name);
      },
      async *keys() {
        for (const k of Array.from(instanceDirs.keys())) {
          yield k;
        }
      },
    };
    const enumerableRoot: OpfsDirectoryHandleLike = {
      async getDirectoryHandle() {
        return enumerableSwarmRoot;
      },
      async getFileHandle() {
        throw new Error("Unexpected root file");
      },
      async removeEntry() {
        throw new Error("Must NEVER wipe shared root!");
      },
    };

    // 4a. Worker writes to OPFS then crashes -> main-thread cleanup deletes simpleim-swarm/<workerCrashInst>
    instanceDirs.set(
      "worker_crashed_inst",
      new Map([["partial.bin", new Uint8Array(32).fill(0x55)]]),
    );
    let triggerLateCrash: ((ev: ErrorEvent) => void) | null = null;
    const midSessionCrashAdapter = new OpfsChunkStorageAdapter({
      instanceId: "worker_crashed_inst",
      storageProvider: () => ({ getDirectory: async () => enumerableRoot }),
      locksProvider: () => mockLocks,
      workerFactory: () => {
        const w = {
          onmessage: null as ((ev: MessageEvent) => void) | null,
          onmessageerror: null as (() => void) | null,
          set onerror(fn: ((ev: ErrorEvent) => void) | null) {
            triggerLateCrash = fn;
          },
          get onerror() {
            return triggerLateCrash;
          },
          postMessage(req: { id: number; type: string }) {
            queueMicrotask(() => {
              w.onmessage?.({
                data: { id: req.id, ok: true, type: req.type },
              } as MessageEvent);
            });
          },
          terminate() {},
        };
        return w as unknown as Worker;
      },
    });

    triggerLateCrash?.({ message: "OPFS worker OOM crash" } as ErrorEvent);
    await midSessionCrashAdapter.closeAll();
    expect(instanceDirs.has("worker_crashed_inst")).toBe(false);

    // 4b. Hard tab crash leaves abandoned_tab_inst with NO Web Lock, while live_tab_inst holds a shared Web Lock
    instanceDirs.set(
      "abandoned_tab_inst",
      new Map([["orphan.bin", new Uint8Array(64).fill(0x99)]]),
    );

    const liveTabCore = new OpfsWorkerStorageCore({
      instanceId: "live_tab_inst",
      storageProvider: () => ({ getDirectory: async () => enumerableRoot }),
      locksProvider: () => mockLocks,
    });
    const liveFileId = "019a0000-0000-7000-8000-000000000399";
    await liveTabCore.initReceivingFile(liveFileId, 16, 1);
    await liveTabCore.writeVerifiedChunk(
      liveFileId,
      0,
      new Uint8Array(16).fill(0x77),
    );
    // Notice: abandoned_tab_inst was already swept by liveTabCore on startup!
    expect(instanceDirs.has("abandoned_tab_inst")).toBe(false);
    expect(instanceDirs.has("live_tab_inst")).toBe(true);

    // Re-plant another crashed tab directory and open a chat-only OpfsChunkStorageAdapter on main thread
    instanceDirs.set(
      "second_crashed_tab",
      new Map([["orphan2.bin", new Uint8Array(64).fill(0x88)]]),
    );
    const freshTabAdapter = new OpfsChunkStorageAdapter({
      instanceId: "fresh_chat_tab",
      forceInlineFallback: true,
      storageProvider: () => ({ getDirectory: async () => enumerableRoot }),
      locksProvider: () => mockLocks,
    });
    await freshTabAdapter.closeAll();

    // second_crashed_tab was reclaimed, while live_tab_inst's active file remained 100% untouched!
    expect(instanceDirs.has("second_crashed_tab")).toBe(false);
    expect(instanceDirs.get("live_tab_inst")?.get(`${liveFileId}.bin`)).toEqual(
      new Uint8Array(16).fill(0x77),
    );
    await liveTabCore.closeAll();
    expect(instanceDirs.has("live_tab_inst")).toBe(false);
  });
});

describe("BrowserSignalingClient configurable maxSignalPayloadBytes", () => {
  test("accepts >32 KiB signal.relay / signal.deliver when maxSignalPayloadBytes is raised and drops under default", async () => {
    const roomId = "e".repeat(64);
    const peerA = "peer_019a0000000070008000000000000011";
    const peerB = "peer_019a0000000070008000000000000022";
    const bigCiphertext = "K".repeat(48_000);

    const makeMockWsFactory = () => {
      let lastSocket: {
        readyState: number;
        binaryType: string;
        sent: string[];
        onopen: (() => void) | null;
        onmessage: ((ev: { data: unknown }) => void) | null;
        onerror: (() => void) | null;
        onclose: ((ev: { code: number }) => void) | null;
        send(d: string): void;
        close(): void;
      } | null = null;

      const factory = (_url: string) => {
        const sock = {
          readyState: WebSocket.OPEN,
          binaryType: "arraybuffer",
          sent: [] as string[],
          onopen: null as (() => void) | null,
          onmessage: null as ((ev: { data: unknown }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as ((ev: { code: number }) => void) | null,
          send(d: string) {
            sock.sent.push(d);
          },
          close() {
            sock.readyState = WebSocket.CLOSED;
          },
        };
        lastSocket = sock;
        queueMicrotask(() => sock.onopen?.());
        return sock as unknown as WebSocket;
      };
      return { factory, getSocket: () => lastSocket! };
    };

    const defaultRig = makeMockWsFactory();
    const defaultClient = new BrowserSignalingClient({
      peerId: peerA,
      wsUrl: "ws://127.0.0.1:3000/ws/v1/signaling",
      webSocketFactory: defaultRig.factory,
    });
    const defaultFrames: unknown[] = [];
    defaultClient.onServerFrame((f) => defaultFrames.push(f));
    await defaultClient.connect();

    expect(() =>
      defaultClient.send({
        type: "signal.relay",
        roomId,
        toPeerId: peerB,
        envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
      }),
    ).toThrow();
    defaultRig.getSocket().onmessage?.({
      data: JSON.stringify({
        type: "signal.deliver",
        roomId,
        fromPeerId: peerB,
        envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
      }),
    });
    expect(defaultFrames).toHaveLength(0);
    defaultClient.disconnect();

    const raisedRig = makeMockWsFactory();
    const raisedClient = new BrowserSignalingClient({
      peerId: peerA,
      wsUrl: "ws://127.0.0.1:3000/ws/v1/signaling",
      maxSignalPayloadBytes: 65_536,
      webSocketFactory: raisedRig.factory,
    });
    const raisedFrames: unknown[] = [];
    raisedClient.onServerFrame((f) => raisedFrames.push(f));
    await raisedClient.connect();

    raisedClient.send({
      type: "signal.relay",
      roomId,
      toPeerId: peerB,
      envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
    });
    expect(raisedRig.getSocket().sent).toHaveLength(1);

    raisedRig.getSocket().onmessage?.({
      data: JSON.stringify({
        type: "signal.deliver",
        roomId,
        fromPeerId: peerB,
        envelope: { nonce: "N".repeat(32), ciphertext: bigCiphertext },
      }),
    });
    expect(raisedFrames).toHaveLength(1);
    raisedClient.disconnect();
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

  test("HttpAuthClient.getMe() recovers csrfToken on reload and refuses to restore session without CSRF capability", async () => {
    let lastLogoutCsrf: string | null = null;
    let includeCsrfInMe = true;

    const mockFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const hdrs = new Headers(init?.headers);
      if (url.endsWith("/api/v1/auth/me")) {
        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: "usr_019a0000000070008000000000000077",
              username: "reloaded_alice",
              displayName: "Alice Reloaded",
              createdAt: 1_763_000_000_000,
            },
            ...(includeCsrfInMe ? { csrfToken: "csrf_recovered_from_me_77" } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/auth/logout")) {
        lastLogoutCsrf = hdrs.get("x-csrf-token");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const reloadedClient = new HttpAuthClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: mockFetch,
      enableBroadcastChannel: false,
      csrfSyncTimeoutMs: 10,
    });
    const restored = await reloadedClient.getMe();
    expect(restored?.username).toBe("reloaded_alice");
    expect(reloadedClient.hasCsrfToken()).toBe(true);
    await reloadedClient.logout();
    expect(lastLogoutCsrf).toBe("csrf_recovered_from_me_77");
    reloadedClient.dispose();

    // When /auth/me omits csrfToken and no sibling tab answers, getMe() returns null rather than broken auth
    includeCsrfInMe = false;
    const unrecoverableClient = new HttpAuthClient({
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl: mockFetch,
      enableBroadcastChannel: false,
      csrfSyncTimeoutMs: 10,
    });
    expect(await unrecoverableClient.getMe()).toBeNull();
    expect(unrecoverableClient.getCurrentUser()).toBeNull();
    expect(unrecoverableClient.hasCsrfToken()).toBe(false);
    unrecoverableClient.dispose();
  });

  test("RoomRuntimeSlot prevents obsolete join attempt failure from clearing newer active runtime", () => {
    const slot = new RoomRuntimeSlot<{ id: string }>();

    // Attempt #1 starts
    const gen1 = slot.beginAttempt();
    const rt1 = { id: "runtime_1" };
    expect(slot.installIfCurrent(gen1, rt1)).toBe(true);
    expect(slot.current).toBe(rt1);

    // User triggers teardown + Attempt #2 before Attempt #1's catch block runs
    expect(slot.takeActiveForTeardown()).toBe(rt1);
    const gen2 = slot.beginAttempt();
    const rt2 = { id: "runtime_2" };
    expect(slot.installIfCurrent(gen2, rt2)).toBe(true);
    expect(slot.current).toBe(rt2);

    // Attempt #1 fails late and runs clearIfOwned(rt1) -> MUST NOT touch rt2!
    expect(slot.isCurrentAttempt(gen1)).toBe(false);
    expect(slot.clearIfOwned(rt1)).toBe(false);
    expect(slot.current).toBe(rt2);

    // Stale installIfCurrent from an even older attempt is also rejected
    expect(slot.installIfCurrent(gen1, { id: "stale" })).toBe(false);
    expect(slot.current).toBe(rt2);
  });
});
