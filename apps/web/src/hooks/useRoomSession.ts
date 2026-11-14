import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessageEnvelope,
  FileManifest,
  UserProfile,
} from "@simpleim/contracts";
import {
  generateEd25519KeyPair,
  generatePrefixedId,
  wipeRoomKeys,
  type DerivedRoomKeys,
  type Ed25519KeyPair,
} from "@simpleim/crypto";
import {
  createRoomPeerEngine,
  type RoomPeerEngine,
  type SwarmTransferProgress,
  type VerifiedPeerInfo,
} from "@simpleim/peer-core";
import { HttpApiError, type HttpAuthClient } from "../api/http-client.ts";
import { deriveRoomKeysOffThread } from "../crypto/kdf-client.ts";
import { toAppFailure, type AppFailure } from "../i18n/error-catalog.ts";
import { mergeOrderedFiles, mergeOrderedMessages } from "../state/collections.ts";
import { RoomRuntimeSlot } from "../state/runtime-slot.ts";
import {
  createBrowserFileChunkReader,
  OpfsChunkStorageAdapter,
} from "../storage/opfs-chunk-storage.ts";
import { BrowserSignalingClient } from "../transport/browser-signaling.ts";
import { BrowserWebRtcTransportFactory } from "../transport/browser-webrtc.ts";

export type JoinPhase = "idle" | "deriving" | "connecting";

export type SecurityEvent =
  | { readonly kind: "peer_rejected"; readonly reason: string }
  | { readonly kind: "engine_error"; readonly failure: AppFailure };

interface ActiveRoomRuntime {
  engine: RoomPeerEngine;
  roomKeys: DerivedRoomKeys;
  localSignKeyPair: Ed25519KeyPair;
  chunkStorage: OpfsChunkStorageAdapter;
  localPeerId: string;
  roomIdPrefix: string;
}

async function cleanupRuntimeInstance(rt: ActiveRoomRuntime): Promise<void> {
  try {
    await rt.engine.stop();
  } catch {
    // Ignore shutdown errors
  }
  try {
    wipeRoomKeys(rt.roomKeys);
    rt.localSignKeyPair.privateKeyBytes.fill(0);
  } catch {
    // Ignore wipe errors
  }
  try {
    await rt.chunkStorage.closeAll();
  } catch {
    // Ignore OPFS cleanup errors
  }
}

export interface UseRoomSessionParams {
  readonly user: UserProfile | null;
  readonly authClient: HttpAuthClient;
  readonly onSessionExpired: () => void;
}

export interface RoomSessionController {
  readonly inRoom: boolean;
  readonly joinPhase: JoinPhase;
  readonly joinFailure: AppFailure | null;
  readonly clearJoinFailure: () => void;
  readonly roomIdPrefix: string;
  readonly localPeerId: string;
  readonly centerConnected: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly securityEvent: SecurityEvent | null;
  readonly dismissSecurityEvent: () => void;
  readonly joinRoom: (passphrase: string) => Promise<void>;
  readonly leaveRoom: () => Promise<void>;
  readonly sendMessage: (
    body: string,
    replyToMsgId: string | null,
  ) => Promise<void>;
  readonly shareFiles: (selectedFiles: File[]) => Promise<void>;
  readonly downloadFile: (fileId: string) => Promise<void>;
  readonly cancelDownload: (fileId: string) => Promise<void>;
  readonly saveFile: (manifest: FileManifest) => Promise<void>;
  readonly canSaveFile: (fileId: string) => boolean;
}

export function useRoomSession({
  user,
  authClient,
  onSessionExpired,
}: UseRoomSessionParams): RoomSessionController {
  const runtimeSlotRef = useRef<RoomRuntimeSlot<ActiveRoomRuntime> | null>(null);
  if (!runtimeSlotRef.current) {
    runtimeSlotRef.current = new RoomRuntimeSlot<ActiveRoomRuntime>();
  }
  const runtimeSlot = runtimeSlotRef.current;

  const [joinPhase, setJoinPhase] = useState<JoinPhase>("idle");
  const [joinFailure, setJoinFailure] = useState<AppFailure | null>(null);
  const [inRoom, setInRoom] = useState(false);
  const [roomIdPrefix, setRoomIdPrefix] = useState("");
  const [localPeerId, setLocalPeerId] = useState("");
  const [centerConnected, setCenterConnected] = useState(false);
  const [peers, setPeers] = useState<VerifiedPeerInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessageEnvelope[]>([]);
  const [files, setFiles] = useState<FileManifest[]>([]);
  const [transfers, setTransfers] = useState<Map<string, SwarmTransferProgress>>(
    () => new Map(),
  );
  const [securityEvent, setSecurityEvent] = useState<SecurityEvent | null>(null);

  const leaveRoom = useCallback(async (): Promise<void> => {
    const rt = runtimeSlot.takeActiveForTeardown();

    setInRoom(false);
    setJoinPhase("idle");
    setJoinFailure(null);
    setRoomIdPrefix("");
    setLocalPeerId("");
    setCenterConnected(false);
    setPeers([]);
    setMessages([]);
    setFiles([]);
    setTransfers(new Map());
    setSecurityEvent(null);

    if (!rt) {
      return;
    }
    await cleanupRuntimeInstance(rt);
  }, [runtimeSlot]);

  useEffect(() => {
    const handlePageHide = (): void => {
      void leaveRoom();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      void leaveRoom();
    };
  }, [leaveRoom]);

  const joinRoom = useCallback(
    async (passphrase: string): Promise<void> => {
      if (!user) return;
      await leaveRoom();

      const myGen = runtimeSlot.beginAttempt();
      setJoinFailure(null);
      setJoinPhase("deriving");

      let derivedKeys: DerivedRoomKeys | null = null;
      let signKeyPair: Ed25519KeyPair | null = null;
      let chunkStorage: OpfsChunkStorageAdapter | null = null;
      let engine: RoomPeerEngine | null = null;
      let createdRuntime: ActiveRoomRuntime | null = null;

      try {
        derivedKeys = await deriveRoomKeysOffThread(passphrase);
        if (!runtimeSlot.isCurrentAttempt(myGen)) {
          wipeRoomKeys(derivedKeys);
          return;
        }

        setJoinPhase("connecting");
        const peerId = generatePrefixedId("peer");
        signKeyPair = generateEd25519KeyPair();

        const [meta, cert] = await Promise.all([
          authClient.getMeta(),
          authClient.issuePeerCert({
            userId: user.id,
            peerId,
            peerSignKeyPair: signKeyPair,
          }),
        ]);

        if (!runtimeSlot.isCurrentAttempt(myGen)) {
          wipeRoomKeys(derivedKeys);
          signKeyPair.privateKeyBytes.fill(0);
          return;
        }

        const signaling = new BrowserSignalingClient({
          peerId,
          maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
        });
        const transportFactory = new BrowserWebRtcTransportFactory();
        chunkStorage = new OpfsChunkStorageAdapter();

        const activeEngine = createRoomPeerEngine({
          localPeerId: peerId,
          localCert: cert,
          localSignKeyPair: signKeyPair,
          serverSignPubKey: meta.serverSignPubKey,
          roomKeys: derivedKeys,
          iceServers: meta.iceServers,
          maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
          signaling,
          transportFactory,
          chunkStorage,
          events: {
            onCenterConnectionChange: (connected) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setCenterConnected(connected);
            },
            onPeersChange: (nextPeers) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setPeers([...nextPeers]);
            },
            onPeerAuthRejected: (_remotePeerId, reason) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setSecurityEvent({ kind: "peer_rejected", reason });
            },
            onChatMessage: (msg) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setMessages((prev) =>
                mergeOrderedMessages(prev, [
                  ...activeEngine.getMessages(),
                  msg,
                ]),
              );
            },
            onFileAnnounced: (manifest) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setFiles((prev) =>
                mergeOrderedFiles(prev, [...activeEngine.getFiles(), manifest]),
              );
              const prog = activeEngine.getTransferProgress(manifest.fileId);
              if (prog) {
                setTransfers((prev) => {
                  const next = new Map(prev);
                  next.set(manifest.fileId, { ...prog });
                  return next;
                });
              }
            },
            onTransferProgress: (progress) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setTransfers((prev) => {
                const next = new Map(prev);
                next.set(progress.fileId, { ...progress });
                return next;
              });
            },
            onTransferCompleted: (manifest) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              const prog = activeEngine.getTransferProgress(manifest.fileId);
              setTransfers((prev) => {
                const next = new Map(prev);
                next.set(
                  manifest.fileId,
                  prog
                    ? { ...prog, status: "seeding" }
                    : {
                        fileId: manifest.fileId,
                        fileName: manifest.fileName,
                        fileSize: manifest.fileSize,
                        totalChunks: manifest.totalChunks,
                        completedChunks: manifest.totalChunks,
                        bytesCompleted: manifest.fileSize,
                        downloadSpeedBytesPerSec: 0,
                        availableSeeders: 1,
                        availablePeersWithChunks: 1,
                        status: "seeding",
                      },
                );
                return next;
              });
            },
            onError: (err) => {
              if (!runtimeSlot.isCurrentAttempt(myGen)) return;
              setSecurityEvent({
                kind: "engine_error",
                failure: toAppFailure(err),
              });
            },
          },
        });
        engine = activeEngine;

        createdRuntime = {
          engine: activeEngine,
          roomKeys: derivedKeys,
          localSignKeyPair: signKeyPair,
          chunkStorage,
          localPeerId: peerId,
          roomIdPrefix: derivedKeys.roomIdPrefix,
        };
        if (!runtimeSlot.installIfCurrent(myGen, createdRuntime)) {
          await cleanupRuntimeInstance(createdRuntime);
          return;
        }

        await activeEngine.start();

        if (
          !runtimeSlot.isCurrentAttempt(myGen) ||
          runtimeSlot.current !== createdRuntime
        ) {
          runtimeSlot.clearIfOwned(createdRuntime);
          await cleanupRuntimeInstance(createdRuntime);
          return;
        }

        setLocalPeerId(peerId);
        setRoomIdPrefix(derivedKeys.roomIdPrefix);
        setCenterConnected(activeEngine.isCenterConnected());
        setPeers(activeEngine.getVerifiedPeers());
        setMessages(activeEngine.getMessages());
        setFiles(activeEngine.getFiles());
        setJoinPhase("idle");
        setInRoom(true);
      } catch (err) {
        runtimeSlot.clearIfOwned(createdRuntime);
        if (engine) {
          try {
            await engine.stop();
          } catch {
            // Ignore
          }
        }
        if (derivedKeys) {
          wipeRoomKeys(derivedKeys);
        }
        if (signKeyPair) {
          signKeyPair.privateKeyBytes.fill(0);
        }
        if (chunkStorage) {
          try {
            await chunkStorage.closeAll();
          } catch {
            // Ignore
          }
        }

        if (runtimeSlot.isCurrentAttempt(myGen)) {
          setJoinPhase("idle");
          if (
            err instanceof HttpApiError &&
            (err.status === 401 || err.code === "csrf_invalid")
          ) {
            onSessionExpired();
          } else {
            setJoinFailure(toAppFailure(err));
          }
        }
      }
    },
    [authClient, leaveRoom, onSessionExpired, runtimeSlot, user],
  );

  const sendMessage = useCallback(
    async (body: string, replyToMsgId: string | null): Promise<void> => {
      const rt = runtimeSlot.current;
      if (!rt) {
        throw new Error("Room session is not active");
      }
      const sent = await rt.engine.sendChatMessage(body, replyToMsgId);
      setMessages((prev) =>
        mergeOrderedMessages(prev, [...rt.engine.getMessages(), sent]),
      );
    },
    [runtimeSlot],
  );

  const shareFiles = useCallback(
    async (selectedFiles: File[]): Promise<void> => {
      const rt = runtimeSlot.current;
      if (!rt) {
        throw new Error("Room session is not active");
      }
      for (const file of selectedFiles) {
        const manifest = await rt.engine.shareFile({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          readChunk: createBrowserFileChunkReader(file),
        });
        rt.chunkStorage.attachLocalSourceBlob(manifest.fileId, file);
        setFiles((prev) =>
          mergeOrderedFiles(prev, [...rt.engine.getFiles(), manifest]),
        );
        const prog = rt.engine.getTransferProgress(manifest.fileId);
        setTransfers((prev) => {
          const next = new Map(prev);
          next.set(
            manifest.fileId,
            prog
              ? { ...prog }
              : {
                  fileId: manifest.fileId,
                  fileName: manifest.fileName,
                  fileSize: manifest.fileSize,
                  totalChunks: manifest.totalChunks,
                  completedChunks: manifest.totalChunks,
                  bytesCompleted: manifest.fileSize,
                  downloadSpeedBytesPerSec: 0,
                  availableSeeders: 1,
                  availablePeersWithChunks: 1,
                  status: "seeding",
                },
          );
          return next;
        });
      }
    },
    [runtimeSlot],
  );

  const downloadFile = useCallback(
    async (fileId: string): Promise<void> => {
      const rt = runtimeSlot.current;
      if (!rt) return;
      await rt.engine.downloadFile(fileId);
      const prog = rt.engine.getTransferProgress(fileId);
      if (prog) {
        setTransfers((prev) => {
          const next = new Map(prev);
          next.set(fileId, { ...prog });
          return next;
        });
      }
    },
    [runtimeSlot],
  );

  const cancelDownload = useCallback(
    async (fileId: string): Promise<void> => {
      const rt = runtimeSlot.current;
      if (!rt) return;
      await rt.engine.cancelDownload(fileId);
      const prog = rt.engine.getTransferProgress(fileId);
      setTransfers((prev) => {
        const next = new Map(prev);
        if (prog) {
          next.set(fileId, { ...prog });
        }
        return next;
      });
    },
    [runtimeSlot],
  );

  const saveFile = useCallback(
    async (manifest: FileManifest): Promise<void> => {
      const rt = runtimeSlot.current;
      if (!rt) return;
      await rt.chunkStorage.triggerBrowserDownload(
        manifest.fileId,
        manifest.fileName,
        manifest.mimeType,
      );
    },
    [runtimeSlot],
  );

  const canSaveFile = useCallback(
    (fileId: string): boolean => {
      const rt = runtimeSlot.current;
      return rt ? rt.chunkStorage.isSaveAvailable(fileId) : false;
    },
    [runtimeSlot],
  );

  const clearJoinFailure = useCallback((): void => {
    setJoinFailure(null);
  }, []);

  const dismissSecurityEvent = useCallback((): void => {
    setSecurityEvent(null);
  }, []);

  return {
    inRoom,
    joinPhase,
    joinFailure,
    clearJoinFailure,
    roomIdPrefix,
    localPeerId,
    centerConnected,
    peers,
    messages,
    files,
    transfers,
    securityEvent,
    dismissSecurityEvent,
    joinRoom,
    leaveRoom,
    sendMessage,
    shareFiles,
    downloadFile,
    cancelDownload,
    saveFile,
    canSaveFile,
  };
}
