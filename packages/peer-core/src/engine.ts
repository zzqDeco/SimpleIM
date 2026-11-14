import type {
  ChatMessageEnvelope,
  FileManifest,
  PostAuthControlFrame,
  ServerSignalingFrame,
} from "@simpleim/contracts";
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
const SYNC_BATCH_FILE_SLICE = 25;

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
    events,
  } = options;

  const now = options.now ?? (() => Date.now());
  const roomId = roomKeys.roomId;

  let started = false;
  let stopped = false;
  let centerConnected = signaling.isConnected;
  let joinedOnCurrentConnection = false;
  let signalingListenersAttached = false;

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

  function sendSyncBatchesToPeer(
    remotePeerId: string,
    messages: ChatMessageEnvelope[],
    files: FileManifest[],
  ): void {
    if (messages.length === 0 && files.length === 0) {
      return;
    }

    let msgIdx = 0;
    let fileIdx = 0;
    while (msgIdx < messages.length || fileIdx < files.length) {
      const msgSlice = messages.slice(msgIdx, msgIdx + SYNC_BATCH_MSG_SLICE);
      const fileSlice = files.slice(fileIdx, fileIdx + SYNC_BATCH_FILE_SLICE);
      msgIdx += msgSlice.length;
      fileIdx += fileSlice.length;

      meshManager.sendControlFrameToPeer(remotePeerId, {
        type: "sync.batch",
        messages: msgSlice,
        files: fileSlice,
      });
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
        chatSync.ingestRemoteMessage(frame.message, false);
        break;
      case "file.announce":
        swarmScheduler.ingestFileManifest(frame.manifest, remotePeerId);
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
        for (const msg of frame.messages) {
          chatSync.ingestRemoteMessage(msg, true);
        }
        for (const manifest of frame.files) {
          swarmScheduler.ingestFileManifest(manifest, remotePeerId);
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
        if (started && !joinedOnCurrentConnection) {
          joinedOnCurrentConnection = true;
          safeSendSignaling({ type: "room.join", roomId });
        }
      } else {
        joinedOnCurrentConnection = false;
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
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      started = false;
      joinedOnCurrentConnection = false;

      swarmScheduler.stop();
      meshManager.stop();

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

    isCenterConnected(): boolean {
      return centerConnected;
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
