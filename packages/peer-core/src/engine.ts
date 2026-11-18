import {
  MAX_RELAY_LIST_LIMIT,
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
  wipeRelayKeys,
} from "@simpleim/crypto";
import { ChatSyncManager } from "./chat-sync.ts";
import { MeshSessionManager } from "./mesh-session.ts";
import {
  SignalingServerError,
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
const MAX_RELAY_CHAT_UPLOAD_ATTEMPTS = 5;
const MAX_INITIAL_RELAY_CHAT_MESSAGES = 100;

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
  let signalingListenersAttached = false;
  let antiEntropyTimer: ReturnType<typeof setInterval> | null = null;

  const uploadedChatMsgIds = new Set<string>();
  const pendingRelayChatMessages = new Map<string, ChatMessageEnvelope>();
  const chatUploadAttempts = new Map<string, number>();
  let flushingRelayChat = false;
  let reflushRelayChatNeeded = false;

  let relayCursor = 0;
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

        const missingForPeerMsgs = chatSync.computeMessagesPeerLacks(
          frame.knownMsgIds,
        );
        const missingForPeerFiles = swarmScheduler.computeFilesPeerLacks(
          frame.knownFileIds,
        );
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

  function enqueueInitialRelayChatUploads(): void {
    if (!relayClient?.enabled) return;
    const localAuthored = chatSync
      .getMessages()
      .filter((m) => m.authorCert.payload.userId === localCert.payload.userId)
      .slice(-MAX_INITIAL_RELAY_CHAT_MESSAGES);
    for (const msg of localAuthored) {
      if (
        !uploadedChatMsgIds.has(msg.msgId) &&
        !pendingRelayChatMessages.has(msg.msgId)
      ) {
        pendingRelayChatMessages.set(msg.msgId, msg);
      }
    }
  }

  async function flushPendingRelayChatUploads(): Promise<void> {
    if (stopped || !relayClient?.enabled) return;
    if (flushingRelayChat) {
      reflushRelayChatNeeded = true;
      return;
    }
    flushingRelayChat = true;
    const attemptedInPass = new Set<string>();

    try {
      do {
        reflushRelayChatNeeded = false;
        for (const [msgId, message] of Array.from(
          pendingRelayChatMessages.entries(),
        )) {
          if (stopped || !relayClient.enabled) return;
          if (uploadedChatMsgIds.has(msgId)) {
            pendingRelayChatMessages.delete(msgId);
            chatUploadAttempts.delete(msgId);
            continue;
          }
          if (attemptedInPass.has(msgId)) {
            continue;
          }
          attemptedInPass.add(msgId);

          try {
            const blobId = deriveRelayEnvelopeBlobId(
              relayKeys.relayIdKey,
              "chat",
              message.msgId,
            );
            const payload = sealRelayEnvelopeBinary(
              relayKeys.relayKey,
              relayKeys.relayBoxId,
              blobId,
              { type: "relay.chat", message },
            );
            await relayClient.putEnvelope({
              boxId: relayKeys.relayBoxId,
              blobId,
              payload,
            });
            if (stopped) return;
            pendingRelayChatMessages.delete(msgId);
            chatUploadAttempts.delete(msgId);
            uploadedChatMsgIds.add(msgId);
          } catch {
            if (stopped) return;
            const attempts = (chatUploadAttempts.get(msgId) ?? 0) + 1;
            if (attempts >= MAX_RELAY_CHAT_UPLOAD_ATTEMPTS) {
              pendingRelayChatMessages.delete(msgId);
              chatUploadAttempts.delete(msgId);
            } else {
              chatUploadAttempts.set(msgId, attempts);
            }
          }
        }
      } while (reflushRelayChatNeeded && !stopped && relayClient.enabled);
    } finally {
      flushingRelayChat = false;
    }
  }

  function pullFromBlindRelay(): Promise<void> {
    if (stopped || !relayClient?.enabled) {
      return Promise.resolve();
    }
    if (activeRelayPullPromise !== null) {
      pullRelayAgainRequested = true;
      return activeRelayPullPromise;
    }

    activeRelayPullPromise = (async () => {
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

            const newlyPulledMsgs: ChatMessageEnvelope[] = [];
            const newlyPulledManifests: FileManifest[] = [];

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
                  uploadedChatMsgIds.add(inner.message.msgId);
                  pendingRelayChatMessages.delete(inner.message.msgId);
                  chatUploadAttempts.delete(inner.message.msgId);
                  if (chatSync.ingestRemoteMessage(inner.message, true)) {
                    newlyPulledMsgs.push(inner.message);
                  }
                  break;
                }
                case "relay.manifest": {
                  if (
                    swarmScheduler.ingestRelayManifest(
                      inner.manifest,
                      item.expiresAt,
                    )
                  ) {
                    newlyPulledManifests.push(inner.manifest);
                  }
                  break;
                }
                case "relay.hash_page": {
                  swarmScheduler.ingestRelayHashPage(
                    inner.fileId,
                    inner.pageIndex,
                    inner.chunkHashes,
                  );
                  break;
                }
              }
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

            relayCursor = Math.max(relayCursor, res.nextCursor);
            if (!res.hasMore || res.items.length === 0) {
              break;
            }
          }
        } while (pullRelayAgainRequested && !stopped && relayClient.enabled);
      } catch {
        // Ignore transient blind relay errors; next tick or reconnect will retry
      } finally {
        activeRelayPullPromise = null;
      }
    })();

    return activeRelayPullPromise;
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
            void flushPendingRelayChatUploads();
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
      enqueueInitialRelayChatUploads();
      started = true;

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

      if (relayClient?.enabled) {
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

      pendingRelayChatMessages.clear();
      chatUploadAttempts.clear();
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
      if (relayClient?.enabled && !uploadedChatMsgIds.has(message.msgId)) {
        pendingRelayChatMessages.set(message.msgId, message);
        if (started && !stopped) {
          void flushPendingRelayChatUploads();
        }
      }
      return message;
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
