import {
  MAX_CHAT_LAMPORT,
  MAX_RELAY_LIST_LIMIT,
  MAX_SYNC_MESSAGES,
  type ChatMessageEnvelope,
  type FileManifest,
  type PeerIdentityCert,
  type PostAuthControlFrame,
  type RelayEnvelopeInnerPayload,
  type ServerSignalingFrame,
} from "@simpleim/contracts";
import {
  deriveRelayEnvelopeBlobId,
  deriveRelayKeys,
  openRelayEnvelopeBinary,
  sealRelayEnvelopeBinary,
  utf8ToBytes,
  verifyChatMessage,
  verifyFileManifest,
  wipeRelayKeys,
} from "@simpleim/crypto";
import { ChatSyncManager } from "./chat-sync.ts";
import { MeshSessionManager } from "./mesh-session.ts";
import {
  SignalingServerError,
  type ChatDeliveryStatus,
  type RoomPeerEngine,
  type RoomPeerEngineOptions,
  type ShareFileInput,
  type SwarmTransferProgress,
  type VerifiedPeerInfo,
} from "./ports.ts";
import { SwarmScheduler } from "./swarm-scheduler.ts";

const SYNC_BATCH_MSG_SLICE = 50;
const SYNC_BATCH_FILE_SLICE = 10;
// Keep plaintext sync.batch JSON <= 32 KiB (~44 KiB after Base64Url AEAD sealing)
// so every batch stays safely below all browsers' 64 KiB SCTP maxMessageSize floor.
const MAX_SYNC_BATCH_JSON_BYTES = 32_768;
const DEFAULT_ANTI_ENTROPY_SYNC_INTERVAL_MS = 15_000;
const MAX_INITIAL_RELAY_CHAT_MESSAGES = 100;
const RELAY_CHAT_FAIL_SURFACE_ATTEMPTS = 3;
const RELAY_CHAT_BASE_BACKOFF_MS = 1_000;
const RELAY_CHAT_MAX_BACKOFF_MS = 60_000;
const RELAY_CHAT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_KEEPALIVE_ENVELOPES = 10;
const MAX_KEEPALIVE_PAYLOAD_BYTES = 60_000;

interface PendingRelayChatEntry {
  message: ChatMessageEnvelope;
  attempts: number;
  nextRetryAt: number;
}

export function createRoomPeerEngine(
  options: RoomPeerEngineOptions,
): RoomPeerEngine {
  const {
    localPeerId,
    localCert,
    localSignKeyPair,
    serverSignPubKey,
    roomKeys,
    iceServers,
    signaling,
    transportFactory,
    chunkStorage,
    relayClient,
    events,
  } = options;

  const now = options.now ?? (() => Date.now());
  const syncIntervalMs =
    options.syncIntervalMs ?? DEFAULT_ANTI_ENTROPY_SYNC_INTERVAL_MS;
  const roomId = roomKeys.roomId;
  const relayKeys = deriveRelayKeys(roomKeys.roomAppKey);

  let started = false;
  let stopped = false;
  let centerConnected = signaling.isConnected;
  let joinedOnCurrentConnection = false;
  let relaySyncedDuringStart = false;
  let signalingListenersAttached = false;
  let antiEntropyTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const chatDeliveryStates = new Map<string, ChatDeliveryStatus>();
  const uploadedChatMsgIds = new Set<string>();
  const pendingRelayChatMessages = new Map<string, PendingRelayChatEntry>();
  let flushingRelayChat = false;
  let activeFlushPromise: Promise<void> | null = null;
  let reflushRelayChatNeeded = false;
  let reflushRelayChatForce = false;
  let reflushRelayChatIgnoreAge = false;

  let relayCursor =
    typeof options.initialRelayCursor === "number" &&
    Number.isFinite(options.initialRelayCursor)
      ? Math.max(0, Math.floor(options.initialRelayCursor))
      : 0;
  let pullingRelay = false;
  let activeRelayPullPromise: Promise<void> | null = null;
  let pullRelayAgainRequested = false;

  const chatSync = new ChatSyncManager({
    roomId,
    localCert,
    localSignKeyPair,
    serverSignPubKey,
    now,
    initialMessages: options.initialMessages,
    events,
  });

  enqueueInitialRelayChatUploads();

  // Late-bound reference so SwarmScheduler and MeshSessionManager can call each other cleanly
  let meshManagerRef: MeshSessionManager | null = null;

  const swarmScheduler = new SwarmScheduler({
    roomId,
    localPeerId,
    localCert,
    localSignKeyPair,
    serverSignPubKey,
    chunkStorage,
    relay: relayClient
      ? {
          client: relayClient,
          relayKeys,
          pullEnvelopes: () => pullFromBlindRelay(),
          pullHashPagesForFile: (fileId) => pullRelayHashPagesForFile(fileId),
        }
      : undefined,
    initialFiles: options.initialFiles,
    maxInFlightPerPeer: options.maxInFlightPerPeer,
    requestTimeoutMs: options.requestTimeoutMs,
    now,
    events,
    broadcastControlFrame: (frame) => {
      meshManagerRef?.broadcastControlFrame(frame);
    },
    sendControlFrameToPeer: (peerId, frame) => {
      meshManagerRef?.sendControlFrameToPeer(peerId, frame);
    },
    evictPeer: (peerId, reason) => {
      meshManagerRef?.evictPeer(peerId, reason);
    },
  });

  const meshManager = new MeshSessionManager({
    localPeerId,
    localCert,
    localSignKeyPair,
    serverSignPubKey,
    roomKeys,
    iceServers,
    transportFactory,
    helloAuthTimeoutMs: options.helloAuthTimeoutMs,
    maxSignalPayloadBytes: options.maxSignalPayloadBytes,
    now,
    events,
    callbacks: {
      sendSignalRelay: (toPeerId, envelope) => {
        safeSendSignaling({
          type: "signal.relay",
          roomId,
          toPeerId,
          envelope,
        });
      },
      onPostAuthControlFrame: (remotePeerId, frame) => {
        handlePostAuthControlFrame(remotePeerId, frame);
      },
      onSessionVerified: (remotePeerId, swarmLink) => {
        swarmScheduler.onPeerVerified(swarmLink);
        meshManager.sendControlFrameToPeer(remotePeerId, {
          type: "sync.summary",
          knownMsgIds: chatSync.getSyncSummaryMsgIds(),
          knownFileIds: swarmScheduler.getSyncSummaryFileIds(),
        });
      },
      onPeerSwarmChannelOpen: (remotePeerId) => {
        swarmScheduler.onPeerSwarmChannelOpen(remotePeerId);
      },
      onPeerHelloAck: (remotePeerId) => {
        swarmScheduler.onPeerHelloAck(remotePeerId);
      },
      onPeerBufferedAmountLow: (remotePeerId) => {
        swarmScheduler.onPeerBufferedAmountLow(remotePeerId);
      },
      onSwarmBinaryFrame: (remotePeerId, bytes) => {
        swarmScheduler.handleSwarmBinaryFrame(remotePeerId, bytes);
      },
      onVerifiedPeerDisconnected: (remotePeerId) => {
        swarmScheduler.onPeerDisconnected(remotePeerId);
      },
    },
  });
  meshManagerRef = meshManager;

  function safeSendSignaling(
    frame: Parameters<typeof signaling.send>[0],
  ): void {
    if (stopped || !signaling.isConnected) {
      return;
    }
    try {
      signaling.send(frame);
    } catch (err) {
      events?.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function buildSyncSummaryFrame(): PostAuthControlFrame {
    return {
      type: "sync.summary",
      knownMsgIds: chatSync.getSyncSummaryMsgIds(),
      knownFileIds: swarmScheduler.getSyncSummaryFileIds(),
    };
  }

  function estimateJsonBytes(value: unknown): number {
    return utf8ToBytes(JSON.stringify(value)).byteLength;
  }

  function partitionSyncBatches(
    messages: readonly ChatMessageEnvelope[],
    files: readonly FileManifest[],
  ): Array<{ messages: ChatMessageEnvelope[]; files: FileManifest[] }> {
    const batches: Array<{
      messages: ChatMessageEnvelope[];
      files: FileManifest[];
    }> = [];
    let msgIdx = 0;
    let fileIdx = 0;

    while (msgIdx < messages.length || fileIdx < files.length) {
      const msgSlice: ChatMessageEnvelope[] = [];
      const fileSlice: FileManifest[] = [];
      let currentBytes = 64; // Frame wrapper overhead {"type":"sync.batch","messages":[],"files":[]}

      while (
        msgIdx < messages.length &&
        msgSlice.length < SYNC_BATCH_MSG_SLICE
      ) {
        const candidate = messages[msgIdx]!;
        const itemBytes = estimateJsonBytes(candidate) + 1;
        if (
          msgSlice.length > 0 &&
          currentBytes + itemBytes > MAX_SYNC_BATCH_JSON_BYTES
        ) {
          break;
        }
        msgSlice.push(candidate);
        currentBytes += itemBytes;
        msgIdx += 1;
        if (currentBytes >= MAX_SYNC_BATCH_JSON_BYTES) {
          break;
        }
      }

      while (
        fileIdx < files.length &&
        fileSlice.length < SYNC_BATCH_FILE_SLICE
      ) {
        const candidate = files[fileIdx]!;
        const itemBytes = estimateJsonBytes(candidate) + 1;
        if (
          (msgSlice.length > 0 || fileSlice.length > 0) &&
          currentBytes + itemBytes > MAX_SYNC_BATCH_JSON_BYTES
        ) {
          break;
        }
        fileSlice.push(candidate);
        currentBytes += itemBytes;
        fileIdx += 1;
        if (currentBytes >= MAX_SYNC_BATCH_JSON_BYTES) {
          break;
        }
      }

      batches.push({ messages: msgSlice, files: fileSlice });
    }

    return batches;
  }

  function sendSyncBatchesToPeer(
    remotePeerId: string,
    messages: readonly ChatMessageEnvelope[],
    files: readonly FileManifest[],
  ): void {
    if (messages.length === 0 && files.length === 0) {
      return;
    }
    for (const batch of partitionSyncBatches(messages, files)) {
      meshManager.sendControlFrameToPeer(remotePeerId, {
        type: "sync.batch",
        messages: batch.messages,
        files: batch.files,
      });
    }
  }

  function gossipSyncBatchesExcept(
    excludePeerId: string,
    messages: readonly ChatMessageEnvelope[],
    files: readonly FileManifest[],
  ): void {
    if (messages.length === 0 && files.length === 0) {
      return;
    }
    const targetPeers = meshManager
      .getVerifiedPeerIds()
      .filter((peerId) => peerId !== excludePeerId);
    if (targetPeers.length === 0) {
      return;
    }
    const batches = partitionSyncBatches(messages, files);
    for (const peerId of targetPeers) {
      for (const batch of batches) {
        meshManager.sendControlFrameToPeer(peerId, {
          type: "sync.batch",
          messages: batch.messages,
          files: batch.files,
        });
      }
    }
  }

  function handlePostAuthControlFrame(
    remotePeerId: string,
    frame: PostAuthControlFrame,
  ): void {
    if (stopped) return;

    switch (frame.type) {
      case "presence.ping":
        meshManager.handlePresencePing(remotePeerId, frame.sentAt);
        break;
      case "presence.pong":
        meshManager.handlePresencePong(remotePeerId, frame.sentAt);
        break;
      case "chat.message":
        if (chatSync.ingestRemoteMessage(frame.message, false)) {
          meshManager.broadcastControlFrameExcept(remotePeerId, {
            type: "chat.message",
            message: frame.message,
          });
        }
        break;
      case "file.announce":
        if (swarmScheduler.ingestFileManifest(frame.manifest, remotePeerId)) {
          meshManager.broadcastControlFrameExcept(remotePeerId, {
            type: "file.announce",
            manifest: frame.manifest,
          });
        }
        break;
      case "file.hash_page_request":
        swarmScheduler.handleHashPageRequestFrame(
          remotePeerId,
          frame.fileId,
          frame.pageIndices,
        );
        break;
      case "file.hash_page":
        swarmScheduler.handleHashPageFrame(
          remotePeerId,
          frame.fileId,
          frame.pageIndex,
          frame.chunkHashes,
        );
        break;
      case "sync.summary": {
        const wantMsgIds = chatSync.computeMissingMsgIdsToRequest(
          frame.knownMsgIds,
        );
        const wantFileIds = swarmScheduler.computeMissingFileIdsToRequest(
          frame.knownFileIds,
        );
        if (wantMsgIds.length > 0 || wantFileIds.length > 0) {
          meshManager.sendControlFrameToPeer(remotePeerId, {
            type: "sync.request",
            wantMsgIds,
            wantFileIds,
          });
        }

        // Only proactively push items absent from the peer's summary when the
        // summary is non-truncated (< MAX_SYNC_MESSAGES). When a peer advertises
        // a truncated 500-item window, rely on its explicit sync.request against
        // its full local inventory to avoid perpetual retransmission loops.
        const missingForPeerMsgs =
          frame.knownMsgIds.length < MAX_SYNC_MESSAGES
            ? chatSync.computeMessagesPeerLacks(frame.knownMsgIds)
            : [];
        const missingForPeerFiles =
          frame.knownFileIds.length < MAX_SYNC_MESSAGES
            ? swarmScheduler.computeFilesPeerLacks(frame.knownFileIds)
            : [];
        if (missingForPeerMsgs.length > 0 || missingForPeerFiles.length > 0) {
          sendSyncBatchesToPeer(
            remotePeerId,
            missingForPeerMsgs,
            missingForPeerFiles,
          );
        }
        break;
      }
      case "sync.request": {
        const messages = chatSync.getMessagesByIds(frame.wantMsgIds);
        const files = swarmScheduler.getFilesByIds(frame.wantFileIds);
        sendSyncBatchesToPeer(remotePeerId, messages, files);
        break;
      }
      case "sync.batch": {
        const newlyIngestedMsgs: ChatMessageEnvelope[] = [];
        const newlyIngestedFiles: FileManifest[] = [];
        for (const msg of frame.messages) {
          if (chatSync.ingestRemoteMessage(msg, true)) {
            newlyIngestedMsgs.push(msg);
          }
        }
        for (const manifest of frame.files) {
          if (swarmScheduler.ingestFileManifest(manifest, remotePeerId)) {
            newlyIngestedFiles.push(manifest);
          }
        }
        if (newlyIngestedMsgs.length > 0 || newlyIngestedFiles.length > 0) {
          gossipSyncBatchesExcept(
            remotePeerId,
            newlyIngestedMsgs,
            newlyIngestedFiles,
          );
        }
        break;
      }
    }
  }

  function handleServerSignalingFrame(frame: ServerSignalingFrame): void {
    if (stopped) return;

    switch (frame.type) {
      case "room.joined":
        if (frame.roomId !== roomId) return;
        meshManager.onRoomJoined(frame.peers);
        break;
      case "room.peer_joined":
        if (frame.roomId !== roomId) return;
        meshManager.onPeerJoined(frame.peerId);
        break;
      case "room.peer_left":
        if (frame.roomId !== roomId) return;
        meshManager.onPeerLeft(frame.peerId);
        break;
      case "signal.deliver":
        if (frame.roomId !== roomId) return;
        meshManager.onSignalDeliver(frame.fromPeerId, frame.envelope);
        break;
      case "error":
        if (frame.roomId === undefined || frame.roomId === roomId) {
          events?.onError?.(
            new SignalingServerError(frame.code, frame.message, frame.roomId),
          );
        }
        break;
    }
  }

  function setChatDeliveryStatus(
    msgId: string,
    status: ChatDeliveryStatus,
  ): void {
    if (stopped) return;
    if (chatDeliveryStates.get(msgId) === status) {
      return;
    }
    chatDeliveryStates.set(msgId, status);
    events?.onChatDeliveryChange?.(msgId, status);
  }

  function clearRelayRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRelayChatRetryTimer(): void {
    clearRelayRetryTimer();
    if (stopped || !started || !relayClient?.enabled) {
      return;
    }
    let earliestRetryAt = Number.POSITIVE_INFINITY;
    for (const entry of pendingRelayChatMessages.values()) {
      if (entry.nextRetryAt < earliestRetryAt) {
        earliestRetryAt = entry.nextRetryAt;
      }
    }
    if (!Number.isFinite(earliestRetryAt)) {
      return;
    }
    const delayMs = Math.max(0, earliestRetryAt - now());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped || !started || !relayClient?.enabled) {
        return;
      }
      void flushPendingRelayChatUploads();
    }, delayMs);
  }

  function enqueueInitialRelayChatUploads(): void {
    const localAuthored = chatSync
      .getMessages()
      .filter((m) => m.authorCert.payload.userId === localCert.payload.userId);
    const relayEnabled = Boolean(relayClient?.enabled);

    if (options.initialPendingRelayMsgIds !== undefined) {
      const pendingIdSet = new Set(options.initialPendingRelayMsgIds);
      for (const msg of localAuthored) {
        if (pendingIdSet.has(msg.msgId)) {
          if (relayEnabled) {
            if (
              !uploadedChatMsgIds.has(msg.msgId) &&
              !pendingRelayChatMessages.has(msg.msgId)
            ) {
              pendingRelayChatMessages.set(msg.msgId, {
                message: msg,
                attempts: 0,
                nextRetryAt: 0,
              });
            }
            chatDeliveryStates.set(msg.msgId, "pending");
          } else {
            chatDeliveryStates.set(msg.msgId, "p2p_only");
          }
        } else {
          if (relayEnabled) {
            uploadedChatMsgIds.add(msg.msgId);
            chatDeliveryStates.set(msg.msgId, "relayed");
          } else {
            chatDeliveryStates.set(msg.msgId, "p2p_only");
          }
        }
      }
      return;
    }

    if (!relayEnabled) {
      for (const msg of localAuthored) {
        chatDeliveryStates.set(msg.msgId, "p2p_only");
      }
      return;
    }

    const cutoff = Math.max(
      0,
      localAuthored.length - MAX_INITIAL_RELAY_CHAT_MESSAGES,
    );
    for (let i = 0; i < localAuthored.length; i++) {
      const msg = localAuthored[i]!;
      if (i < cutoff) {
        uploadedChatMsgIds.add(msg.msgId);
        chatDeliveryStates.set(msg.msgId, "relayed");
      } else {
        if (
          !uploadedChatMsgIds.has(msg.msgId) &&
          !pendingRelayChatMessages.has(msg.msgId)
        ) {
          pendingRelayChatMessages.set(msg.msgId, {
            message: msg,
            attempts: 0,
            nextRetryAt: 0,
          });
        }
        chatDeliveryStates.set(msg.msgId, "pending");
      }
    }
  }

  function flushPendingRelayChatUploads(
    force = false,
    ignoreAge = false,
  ): Promise<void> {
    if (stopped || !relayClient?.enabled) {
      return Promise.resolve();
    }
    if (flushingRelayChat) {
      reflushRelayChatNeeded = true;
      if (force) {
        reflushRelayChatForce = true;
      }
      if (ignoreAge) {
        reflushRelayChatIgnoreAge = true;
      }
      return activeFlushPromise ?? Promise.resolve();
    }

    flushingRelayChat = true;
    clearRelayRetryTimer();
    let passForce = force;
    let passIgnoreAge = ignoreAge;
    let completedSync = false;

    const flushTask = (async () => {
      try {
        do {
          reflushRelayChatNeeded = false;
          reflushRelayChatForce = false;
          reflushRelayChatIgnoreAge = false;

          for (const [msgId, entry] of Array.from(
            pendingRelayChatMessages.entries(),
          )) {
            if (stopped || !relayClient.enabled) return;
            if (uploadedChatMsgIds.has(msgId)) {
              pendingRelayChatMessages.delete(msgId);
              setChatDeliveryStatus(msgId, "relayed");
              continue;
            }
            const currentNow = now();
            if (
              !passIgnoreAge &&
              currentNow - entry.message.createdAt > RELAY_CHAT_MAX_AGE_MS
            ) {
              pendingRelayChatMessages.delete(msgId);
              setChatDeliveryStatus(msgId, "failed");
              continue;
            }
            if (!passForce && entry.nextRetryAt > currentNow) {
              continue;
            }

            try {
              const blobId = deriveRelayEnvelopeBlobId(
                relayKeys.relayIdKey,
                "chat",
                entry.message.msgId,
              );
              const payload = sealRelayEnvelopeBinary(
                relayKeys.relayKey,
                relayKeys.relayBoxId,
                blobId,
                { type: "relay.chat", message: entry.message },
              );
              await relayClient.putEnvelope({
                boxId: relayKeys.relayBoxId,
                blobId,
                payload,
              });
              if (stopped) return;
              pendingRelayChatMessages.delete(msgId);
              uploadedChatMsgIds.add(msgId);
              setChatDeliveryStatus(msgId, "relayed");
            } catch {
              if (stopped) return;
              if (
                uploadedChatMsgIds.has(msgId) ||
                pendingRelayChatMessages.get(msgId) !== entry
              ) {
                continue;
              }
              entry.attempts += 1;
              const delay = Math.min(
                RELAY_CHAT_MAX_BACKOFF_MS,
                RELAY_CHAT_BASE_BACKOFF_MS *
                  2 ** Math.min(entry.attempts - 1, 6),
              );
              entry.nextRetryAt = now() + delay;
              if (entry.attempts >= RELAY_CHAT_FAIL_SURFACE_ATTEMPTS) {
                setChatDeliveryStatus(msgId, "failed");
              }
            }
          }

          passForce = reflushRelayChatForce;
          passIgnoreAge = reflushRelayChatIgnoreAge;
        } while (reflushRelayChatNeeded && !stopped && relayClient.enabled);
      } finally {
        completedSync = true;
        flushingRelayChat = false;
        activeFlushPromise = null;
        if (!stopped && started && relayClient.enabled) {
          scheduleRelayChatRetryTimer();
        }
      }
    })();

    if (!completedSync) {
      activeFlushPromise = flushTask;
    }
    return flushTask;
  }

  function pullFromBlindRelay(): Promise<void> {
    if (stopped || !relayClient?.enabled) {
      return Promise.resolve();
    }
    if (pullingRelay) {
      pullRelayAgainRequested = true;
      return activeRelayPullPromise ?? Promise.resolve();
    }

    pullingRelay = true;
    let completedSync = false;

    const pullTask = (async () => {
      try {
        do {
          pullRelayAgainRequested = false;
          while (!stopped && relayClient.enabled) {
            const res = await relayClient.listEnvelopes({
              boxId: relayKeys.relayBoxId,
              afterSeq: relayCursor,
              limit: MAX_RELAY_LIST_LIMIT,
            });
            if (stopped) return;

            const verifiedMsgs: ChatMessageEnvelope[] = [];
            const verifiedManifests: FileManifest[] = [];
            const verifiedManifestEntries: Array<{
              manifest: FileManifest;
              expiresAt: number;
            }> = [];
            const pulledHashPages: Array<{
              fileId: string;
              pageIndex: number;
              chunkHashes: string[];
            }> = [];

            for (const item of res.items) {
              if (stopped) return;
              let inner: RelayEnvelopeInnerPayload;
              try {
                inner = openRelayEnvelopeBinary(
                  relayKeys.relayKey,
                  relayKeys.relayBoxId,
                  item.blobId,
                  item.payload,
                );
              } catch {
                // Silently ignore undecryptable/invalid envelopes and still advance cursor
                continue;
              }

              switch (inner.type) {
                case "relay.chat": {
                  if (
                    inner.message.lamport <= MAX_CHAT_LAMPORT &&
                    verifyChatMessage(inner.message, serverSignPubKey, roomId)
                  ) {
                    verifiedMsgs.push(inner.message);
                  }
                  break;
                }
                case "relay.manifest": {
                  if (
                    verifyFileManifest(inner.manifest, serverSignPubKey, roomId)
                  ) {
                    verifiedManifests.push(inner.manifest);
                    verifiedManifestEntries.push({
                      manifest: inner.manifest,
                      expiresAt: item.expiresAt,
                    });
                  }
                  break;
                }
                case "relay.hash_page": {
                  pulledHashPages.push({
                    fileId: inner.fileId,
                    pageIndex: inner.pageIndex,
                    chunkHashes: inner.chunkHashes,
                  });
                  break;
                }
              }
            }

            const cursorReset = res.cursorReset === true;
            const sanitizedServerCursor = Math.max(0, Math.floor(res.nextCursor));
            const nextCursor = cursorReset
              ? sanitizedServerCursor
              : Math.max(relayCursor, sanitizedServerCursor);

            if (
              events?.onRelayBatchPulled &&
              (verifiedMsgs.length > 0 ||
                verifiedManifests.length > 0 ||
                nextCursor !== relayCursor ||
                cursorReset)
            ) {
              await events.onRelayBatchPulled({
                messages: verifiedMsgs,
                files: verifiedManifests,
                nextCursor,
                cursorReset,
              });
              if (stopped) return;
            }

            const newlyPulledMsgs: ChatMessageEnvelope[] = [];
            const newlyPulledManifests: FileManifest[] = [];
            let removedAnyPending = false;

            for (const msg of verifiedMsgs) {
              if (stopped) return;
              uploadedChatMsgIds.add(msg.msgId);
              if (pendingRelayChatMessages.delete(msg.msgId)) {
                removedAnyPending = true;
              }
              if (msg.authorCert.payload.userId === localCert.payload.userId) {
                setChatDeliveryStatus(msg.msgId, "relayed");
              }
              if (chatSync.ingestRemoteMessage(msg, true)) {
                newlyPulledMsgs.push(msg);
              }
            }
            if (removedAnyPending && !flushingRelayChat) {
              scheduleRelayChatRetryTimer();
            }

            for (const { manifest, expiresAt } of verifiedManifestEntries) {
              if (stopped) return;
              if (swarmScheduler.ingestRelayManifest(manifest, expiresAt)) {
                newlyPulledManifests.push(manifest);
              }
            }

            for (const page of pulledHashPages) {
              if (stopped) return;
              swarmScheduler.ingestRelayHashPage(
                page.fileId,
                page.pageIndex,
                page.chunkHashes,
              );
            }

            if (newlyPulledMsgs.length > 0) {
              gossipSyncBatchesExcept("", newlyPulledMsgs, []);
            }
            for (const manifest of newlyPulledManifests) {
              meshManager.broadcastControlFrame({
                type: "file.announce",
                manifest,
              });
            }

            relayCursor = nextCursor;
            if (!res.hasMore || res.items.length === 0) {
              break;
            }
          }
        } while (pullRelayAgainRequested && !stopped && relayClient.enabled);
      } catch {
        pullRelayAgainRequested = false;
        // Ignore transient blind relay or persistence errors; next tick or reconnect will retry
      } finally {
        completedSync = true;
        pullingRelay = false;
        activeRelayPullPromise = null;
      }
    })();

    if (!completedSync) {
      activeRelayPullPromise = pullTask;
    }
    return pullTask;
  }

  async function pullRelayHashPagesForFile(targetFileId: string): Promise<void> {
    if (stopped || !relayClient?.enabled) {
      return;
    }
    let scanCursor = 0;
    try {
      while (!stopped && relayClient.enabled) {
        const res = await relayClient.listEnvelopes({
          boxId: relayKeys.relayBoxId,
          afterSeq: scanCursor,
          limit: MAX_RELAY_LIST_LIMIT,
        });
        if (stopped) return;
        for (const item of res.items) {
          if (stopped) return;
          try {
            const inner = openRelayEnvelopeBinary(
              relayKeys.relayKey,
              relayKeys.relayBoxId,
              item.blobId,
              item.payload,
            );
            if (
              inner.type === "relay.hash_page" &&
              inner.fileId === targetFileId
            ) {
              swarmScheduler.ingestRelayHashPage(
                inner.fileId,
                inner.pageIndex,
                inner.chunkHashes,
              );
            }
          } catch {
            // Ignore undecryptable/unrelated envelopes during targeted hash-page scan
          }
        }
        if (
          !res.hasMore ||
          res.items.length === 0 ||
          res.nextCursor <= scanCursor
        ) {
          break;
        }
        scanCursor = res.nextCursor;
      }
    } catch {
      // Ignore transient relay errors; SwarmScheduler evaluates remaining state
    }
  }

  function ensureSignalingListeners(): void {
    if (signalingListenersAttached) return;
    signalingListenersAttached = true;

    signaling.onConnectionChange((connected) => {
      if (stopped) return;
      if (connected) {
        const changed = !centerConnected;
        centerConnected = true;
        if (changed) {
          events?.onCenterConnectionChange?.(true);
        }
        if (started) {
          if (!joinedOnCurrentConnection) {
            joinedOnCurrentConnection = true;
            safeSendSignaling({ type: "room.join", roomId });
          }
          if (relayClient?.enabled) {
            relaySyncedDuringStart = true;
            for (const entry of pendingRelayChatMessages.values()) {
              entry.nextRetryAt = 0;
            }
            void flushPendingRelayChatUploads(true);
            void pullFromBlindRelay();
          }
        }
      } else {
        joinedOnCurrentConnection = false;
        meshManager.onCenterDisconnected();
        // Center-Detached Liveness: NEVER close active or verified PeerConnectionPorts!
        const changed = centerConnected;
        centerConnected = false;
        if (changed) {
          events?.onCenterConnectionChange?.(false);
        }
      }
    });

    signaling.onServerFrame((frame) => {
      handleServerSignalingFrame(frame);
    });
  }

  return {
    get roomId(): string {
      return roomId;
    },
    get localPeerId(): string {
      return localPeerId;
    },

    async start(): Promise<void> {
      if (stopped) {
        throw new Error("Cannot restart a stopped RoomPeerEngine");
      }
      if (started) {
        return;
      }
      ensureSignalingListeners();
      started = true;
      relaySyncedDuringStart = false;

      if (!signaling.isConnected) {
        try {
          await signaling.connect();
        } catch (err) {
          if (!stopped) {
            started = false;
            joinedOnCurrentConnection = false;
          }
          throw err;
        }
      }
      if (stopped) return;

      if (signaling.isConnected) {
        const changed = !centerConnected;
        centerConnected = true;
        if (changed) {
          events?.onCenterConnectionChange?.(true);
        }
        if (!joinedOnCurrentConnection) {
          joinedOnCurrentConnection = true;
          safeSendSignaling({ type: "room.join", roomId });
        }
      }

      if (relayClient?.enabled && !relaySyncedDuringStart) {
        void flushPendingRelayChatUploads();
        void pullFromBlindRelay();
      }

      if (antiEntropyTimer === null && syncIntervalMs > 0) {
        antiEntropyTimer = setInterval(() => {
          if (stopped) return;
          if (relayClient?.enabled) {
            void flushPendingRelayChatUploads();
            void pullFromBlindRelay();
          }
          if (meshManager.getVerifiedPeerIds().length === 0) return;
          meshManager.broadcastControlFrame(buildSyncSummaryFrame());
        }, syncIntervalMs);
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      started = false;
      joinedOnCurrentConnection = false;

      if (antiEntropyTimer !== null) {
        clearInterval(antiEntropyTimer);
        antiEntropyTimer = null;
      }
      clearRelayRetryTimer();

      pendingRelayChatMessages.clear();
      reflushRelayChatNeeded = false;
      reflushRelayChatForce = false;
      reflushRelayChatIgnoreAge = false;
      pullRelayAgainRequested = false;
      swarmScheduler.stop();
      meshManager.stop();
      wipeRelayKeys(relayKeys);

      if (signaling.isConnected) {
        try {
          signaling.send({ type: "room.leave", roomId });
        } catch {
          // Ignore leave errors during shutdown
        }
      }

      try {
        signaling.disconnect();
      } catch {
        // Ignore disconnect errors during shutdown
      }

      if (centerConnected) {
        centerConnected = false;
        events?.onCenterConnectionChange?.(false);
      }

      await chunkStorage.closeAll();
    },

    updateLocalCert(nextCert: PeerIdentityCert): void {
      if (stopped) return;
      if (
        nextCert.payload.peerId !== localPeerId ||
        nextCert.payload.peerSignPubKey !== localSignKeyPair.publicKeyBase64Url
      ) {
        throw new Error(
          "Updated PeerIdentityCert does not match engine peer identity",
        );
      }
      chatSync.updateLocalCert(nextCert);
      meshManager.updateLocalCert(nextCert);
      swarmScheduler.updateLocalCert(nextCert);
    },

    isCenterConnected(): boolean {
      return centerConnected;
    },

    getSignalingPeerCount(): number {
      return meshManager.getSignalingPeerCount();
    },

    getVerifiedPeers(): VerifiedPeerInfo[] {
      return meshManager.getVerifiedPeers();
    },

    getMessages(): ChatMessageEnvelope[] {
      return chatSync.getMessages();
    },

    getChatDeliveryStates(): ReadonlyMap<string, ChatDeliveryStatus> {
      return new Map(chatDeliveryStates);
    },

    getFiles(): FileManifest[] {
      return swarmScheduler.getFiles();
    },

    getTransferProgress(fileId: string): SwarmTransferProgress | undefined {
      return swarmScheduler.getTransferProgress(fileId);
    },

    async sendChatMessage(
      body: string,
      replyToMsgId?: string | null,
    ): Promise<ChatMessageEnvelope> {
      if (stopped) {
        throw new Error("RoomPeerEngine is stopped");
      }
      const message = chatSync.createLocalMessage(body, replyToMsgId);
      meshManager.broadcastControlFrame({
        type: "chat.message",
        message,
      });
      if (relayClient?.enabled) {
        if (!uploadedChatMsgIds.has(message.msgId)) {
          pendingRelayChatMessages.set(message.msgId, {
            message,
            attempts: 0,
            nextRetryAt: 0,
          });
          setChatDeliveryStatus(message.msgId, "pending");
          if (started && !stopped) {
            void flushPendingRelayChatUploads();
          }
        }
      } else {
        setChatDeliveryStatus(message.msgId, "p2p_only");
      }
      return message;
    },

    async retryChatMessage(msgId?: string): Promise<void> {
      if (stopped || !relayClient?.enabled) {
        return;
      }
      if (activeFlushPromise !== null) {
        await activeFlushPromise;
        if (stopped || !relayClient.enabled) {
          return;
        }
      }

      if (msgId !== undefined) {
        if (uploadedChatMsgIds.has(msgId)) {
          return;
        }
        const existing = pendingRelayChatMessages.get(msgId);
        if (existing) {
          existing.attempts = 0;
          existing.nextRetryAt = 0;
          setChatDeliveryStatus(msgId, "pending");
        } else {
          const found = chatSync.getMessagesByIds([msgId])[0];
          if (
            !found ||
            found.authorCert.payload.userId !== localCert.payload.userId
          ) {
            return;
          }
          pendingRelayChatMessages.set(msgId, {
            message: found,
            attempts: 0,
            nextRetryAt: 0,
          });
          setChatDeliveryStatus(msgId, "pending");
        }
        await flushPendingRelayChatUploads(true, true);
        return;
      }

      for (const [id, entry] of pendingRelayChatMessages.entries()) {
        entry.attempts = 0;
        entry.nextRetryAt = 0;
        setChatDeliveryStatus(id, "pending");
      }
      const failedIds: string[] = [];
      for (const [id, status] of chatDeliveryStates.entries()) {
        if (
          status === "failed" &&
          !uploadedChatMsgIds.has(id) &&
          !pendingRelayChatMessages.has(id)
        ) {
          failedIds.push(id);
        }
      }
      if (failedIds.length > 0) {
        for (const msg of chatSync.getMessagesByIds(failedIds)) {
          if (msg.authorCert.payload.userId === localCert.payload.userId) {
            pendingRelayChatMessages.set(msg.msgId, {
              message: msg,
              attempts: 0,
              nextRetryAt: 0,
            });
            setChatDeliveryStatus(msg.msgId, "pending");
          }
        }
      }
      if (pendingRelayChatMessages.size > 0) {
        await flushPendingRelayChatUploads(true, true);
      }
    },

    flushPendingRelayKeepalive(): void {
      if (
        stopped ||
        !relayClient?.enabled ||
        pendingRelayChatMessages.size === 0
      ) {
        return;
      }
      let dispatched = 0;
      for (const [msgId, entry] of pendingRelayChatMessages.entries()) {
        if (dispatched >= MAX_KEEPALIVE_ENVELOPES) {
          break;
        }
        if (uploadedChatMsgIds.has(msgId)) {
          continue;
        }
        try {
          const blobId = deriveRelayEnvelopeBlobId(
            relayKeys.relayIdKey,
            "chat",
            entry.message.msgId,
          );
          const payload = sealRelayEnvelopeBinary(
            relayKeys.relayKey,
            relayKeys.relayBoxId,
            blobId,
            { type: "relay.chat", message: entry.message },
          );
          if (payload.byteLength > MAX_KEEPALIVE_PAYLOAD_BYTES) {
            continue;
          }
          dispatched += 1;
          void relayClient
            .putEnvelope({
              boxId: relayKeys.relayBoxId,
              blobId,
              payload,
              keepalive: true,
            })
            .catch(() => {});
        } catch {
          // Best-effort synchronous keepalive dispatch during pagehide
        }
      }
    },

    async shareFile(input: ShareFileInput): Promise<FileManifest> {
      return swarmScheduler.shareFile(input);
    },

    async downloadFile(fileId: string): Promise<void> {
      return swarmScheduler.downloadFile(fileId);
    },

    async cancelDownload(fileId: string): Promise<void> {
      return swarmScheduler.cancelDownload(fileId);
    },
  };
}
