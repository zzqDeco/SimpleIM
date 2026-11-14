import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessageEnvelope,
  FileManifest,
  MetaResponse,
  PeerIdentityCert,
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
import {
  buildSortedRoomSummaries,
  compareRoomOrder,
  MAX_ACTIVE_MESH_ROOMS,
  selectActiveMeshRoomIds,
  type RoomMeshConnectionStatus,
  type RoomSummaryInput,
  type RoomSummaryItem,
} from "../state/room-list-vm.ts";
import { sanitizeRoomAlias } from "../state/validation.ts";
import {
  createBrowserFileChunkReader,
  OpfsChunkStorageAdapter,
} from "../storage/opfs-chunk-storage.ts";
import {
  RoomVault,
  type VaultRoomMetadata,
} from "../storage/room-vault.ts";
import { BrowserWebRtcTransportFactory } from "../transport/browser-webrtc.ts";
import { MultiplexedSignalingHub } from "../transport/multiplexed-signaling.ts";

export type JoinPhase = "idle" | "deriving" | "connecting";

export type SecurityEvent =
  | { readonly kind: "peer_rejected"; readonly reason: string }
  | { readonly kind: "engine_error"; readonly failure: AppFailure };

interface ActiveRoomEngineInstance {
  readonly engine: RoomPeerEngine;
  readonly chunkStorage: OpfsChunkStorageAdapter;
  readonly localPeerId: string;
}

interface ManagedRoomRecord {
  metadata: VaultRoomMetadata;
  readonly roomKeys: DerivedRoomKeys;
  messages: ChatMessageEnvelope[];
  files: FileManifest[];
  transfers: Map<string, SwarmTransferProgress>;
  peers: VerifiedPeerInfo[];
  centerConnected: boolean;
  activeRuntime: ActiveRoomEngineInstance | null;
  startingPromise: Promise<void> | null;
  disposed: boolean;
}

interface WorkspaceIdentityBundle {
  readonly userId: string;
  readonly peerId: string;
  readonly signKeyPair: Ed25519KeyPair;
  cert: PeerIdentityCert;
  readonly meta: MetaResponse;
  readonly signalingHub: MultiplexedSignalingHub;
  renewalTimer: ReturnType<typeof setTimeout> | null;
}

async function stopRoomEngineOnly(entry: ManagedRoomRecord): Promise<void> {
  const rt = entry.activeRuntime;
  entry.activeRuntime = null;
  entry.startingPromise = null;
  entry.centerConnected = false;
  entry.peers = [];
  if (!rt) return;

  try {
    await rt.engine.stop();
  } catch {
    // Ignore engine shutdown errors
  }
  try {
    await rt.chunkStorage.closeAll();
  } catch {
    // Ignore OPFS cleanup errors
  }
}

async function destroyEntryKeysAndEngine(entry: ManagedRoomRecord): Promise<void> {
  entry.disposed = true;
  await stopRoomEngineOnly(entry);
  try {
    wipeRoomKeys(entry.roomKeys);
  } catch {
    // Ignore wipe errors
  }
}

function disposeIdentityBundle(bundle: WorkspaceIdentityBundle | null): void {
  if (!bundle) return;
  if (bundle.renewalTimer !== null) {
    clearTimeout(bundle.renewalTimer);
    bundle.renewalTimer = null;
  }
  try {
    bundle.signalingHub.closeAll();
  } catch {
    // Ignore hub shutdown errors
  }
  try {
    bundle.signKeyPair.privateKeyBytes.fill(0);
  } catch {
    // Ignore key zeroization errors
  }
}

function computeEntryConnectionStatus(
  entry: ManagedRoomRecord,
): RoomMeshConnectionStatus {
  if (!entry.activeRuntime) {
    return "standby";
  }
  return entry.centerConnected ? "connected" : "detached";
}

export interface UseRoomSessionParams {
  readonly user: UserProfile | null;
  readonly authClient: HttpAuthClient;
  readonly onSessionExpired: () => void;
  readonly vault?: RoomVault;
}

export interface RoomSessionController {
  readonly hydrating: boolean;
  readonly inRoom: boolean;
  readonly joinPhase: JoinPhase;
  readonly joinFailure: AppFailure | null;
  readonly clearJoinFailure: () => void;
  readonly rooms: readonly RoomSummaryItem[];
  readonly selectedRoomId: string | null;
  readonly selectedRoomAlias: string | null;
  readonly selectedRoomStatus: RoomMeshConnectionStatus;
  readonly roomIdPrefix: string;
  readonly localPeerId: string;
  readonly centerConnected: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly securityEvent: SecurityEvent | null;
  readonly dismissSecurityEvent: () => void;
  readonly joinRoom: (passphrase: string, alias?: string) => Promise<boolean>;
  readonly selectRoom: (roomId: string) => Promise<void>;
  readonly renameRoomAlias: (
    roomId: string,
    alias: string | null,
  ) => Promise<void>;
  readonly togglePinRoom: (roomId: string) => Promise<void>;
  readonly leaveRoom: (roomId?: string) => Promise<void>;
  readonly disconnectAllPreservingVault: () => Promise<void>;
  readonly wipeLocalVault: () => Promise<void>;
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

interface UiWorkspaceSnapshot {
  readonly rooms: readonly RoomSummaryItem[];
  readonly selectedRoomId: string | null;
  readonly selectedRoomAlias: string | null;
  readonly selectedRoomStatus: RoomMeshConnectionStatus;
  readonly roomIdPrefix: string;
  readonly localPeerId: string;
  readonly centerConnected: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
}

const EMPTY_UI_SNAPSHOT: UiWorkspaceSnapshot = {
  rooms: [],
  selectedRoomId: null,
  selectedRoomAlias: null,
  selectedRoomStatus: "standby",
  roomIdPrefix: "",
  localPeerId: "",
  centerConnected: false,
  peers: [],
  messages: [],
  files: [],
  transfers: new Map(),
};

export function useRoomSession({
  user,
  authClient,
  onSessionExpired,
  vault: injectedVault,
}: UseRoomSessionParams): RoomSessionController {
  const vaultRef = useRef<RoomVault | null>(null);
  if (!vaultRef.current) {
    vaultRef.current = injectedVault ?? new RoomVault();
  }
  const vault = vaultRef.current;

  const workspaceGenRef = useRef(0);
  const roomsRef = useRef<Map<string, ManagedRoomRecord>>(new Map());
  const selectedRoomIdRef = useRef<string | null>(null);
  const identityRef = useRef<WorkspaceIdentityBundle | null>(null);
  const identityPromiseRef = useRef<{
    gen: number;
    promise: Promise<WorkspaceIdentityBundle>;
  } | null>(null);
  const meshOpChainRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightJoinsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const activeUserIdRef = useRef<string | null>(null);

  const isEntryLive = useCallback(
    (
      expectedGen: number,
      roomId: string,
      entry: ManagedRoomRecord,
    ): boolean =>
      workspaceGenRef.current === expectedGen &&
      !entry.disposed &&
      roomsRef.current.get(roomId) === entry,
    [],
  );

  const propagateUpdatedCertToEngines = useCallback(
    (freshCert: PeerIdentityCert): void => {
      for (const entry of roomsRef.current.values()) {
        if (!entry.disposed && entry.activeRuntime) {
          try {
            entry.activeRuntime.engine.updateLocalCert(freshCert);
          } catch {
            // Ignore stopped/mismatched engine update errors
          }
        }
      }
    },
    [],
  );

  const runSerializedMeshOp = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      const next = meshOpChainRef.current.then(task, task);
      meshOpChainRef.current = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    [],
  );

  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [joinPhase, setJoinPhase] = useState<JoinPhase>("idle");
  const [joinFailure, setJoinFailure] = useState<AppFailure | null>(null);
  const [securityEvent, setSecurityEvent] = useState<SecurityEvent | null>(null);
  const [snapshot, setSnapshot] = useState<UiWorkspaceSnapshot>(EMPTY_UI_SNAPSHOT);

  const publishSnapshot = useCallback((currentUserId: string | null): void => {
    if (!currentUserId || roomsRef.current.size === 0) {
      selectedRoomIdRef.current = null;
      setSnapshot(EMPTY_UI_SNAPSHOT);
      return;
    }

    const entries = Array.from(roomsRef.current.values());
    const summaryInputs: RoomSummaryInput[] = entries.map((entry) => ({
      roomId: entry.metadata.roomId,
      roomIdPrefix: entry.metadata.roomIdPrefix,
      alias: entry.metadata.alias,
      pinned: entry.metadata.pinned,
      joinedAt: entry.metadata.joinedAt,
      lastActiveAt: entry.metadata.lastActiveAt,
      lastReadAt: entry.metadata.lastReadAt,
      messages: entry.messages,
      peerCount: entry.peers.length,
      fileCount: entry.files.length,
      connectionStatus: computeEntryConnectionStatus(entry),
    }));
    const sortedSummaries = buildSortedRoomSummaries(
      summaryInputs,
      currentUserId,
    );

    let selId = selectedRoomIdRef.current;
    if (!selId || !roomsRef.current.has(selId)) {
      selId = sortedSummaries[0]?.roomId ?? null;
      selectedRoomIdRef.current = selId;
    }

    const selectedEntry = selId ? roomsRef.current.get(selId) : undefined;
    if (!selectedEntry) {
      setSnapshot(EMPTY_UI_SNAPSHOT);
      return;
    }

    setSnapshot({
      rooms: sortedSummaries,
      selectedRoomId: selectedEntry.metadata.roomId,
      selectedRoomAlias: selectedEntry.metadata.alias,
      selectedRoomStatus: computeEntryConnectionStatus(selectedEntry),
      roomIdPrefix: selectedEntry.metadata.roomIdPrefix,
      localPeerId:
        selectedEntry.activeRuntime?.localPeerId ??
        identityRef.current?.peerId ??
        "",
      centerConnected: selectedEntry.centerConnected,
      peers: [...selectedEntry.peers],
      messages: [...selectedEntry.messages],
      files: [...selectedEntry.files],
      transfers: new Map(selectedEntry.transfers),
    });
  }, []);

  const ensureIdentityBundle = useCallback(
    async (
      expectedGen: number,
      currentUser: UserProfile,
    ): Promise<WorkspaceIdentityBundle> => {
      const scheduleRenewal = (targetBundle: WorkspaceIdentityBundle): void => {
        if (targetBundle.renewalTimer !== null) {
          clearTimeout(targetBundle.renewalTimer);
          targetBundle.renewalTimer = null;
        }
        const msUntilRenew = Math.max(
          60_000,
          targetBundle.cert.payload.exp - Date.now() - 10 * 60_000,
        );
        targetBundle.renewalTimer = setTimeout(() => {
          if (
            workspaceGenRef.current !== expectedGen ||
            identityRef.current !== targetBundle
          ) {
            return;
          }
          void authClient
            .issuePeerCert({
              userId: currentUser.id,
              peerId: targetBundle.peerId,
              peerSignKeyPair: targetBundle.signKeyPair,
            })
            .then((freshCert) => {
              if (
                workspaceGenRef.current !== expectedGen ||
                identityRef.current !== targetBundle
              ) {
                return;
              }
              targetBundle.cert = freshCert;
              propagateUpdatedCertToEngines(freshCert);
              scheduleRenewal(targetBundle);
            })
            .catch(() => {
              // Retry before actual expiration if transient network error occurs
              if (
                workspaceGenRef.current === expectedGen &&
                identityRef.current === targetBundle
              ) {
                targetBundle.renewalTimer = setTimeout(
                  () => scheduleRenewal(targetBundle),
                  60_000,
                );
              }
            });
        }, msUntilRenew);
      };

      const existing = identityRef.current;
      if (
        existing &&
        existing.userId === currentUser.id &&
        existing.cert.payload.exp - Date.now() > 5 * 60_000
      ) {
        return existing;
      }

      if (
        identityPromiseRef.current &&
        identityPromiseRef.current.gen === expectedGen
      ) {
        return identityPromiseRef.current.promise;
      }

      // If the same user's identity bundle is near/past expiry (e.g. after sleep),
      // renew its certificate in-place so running engines and signalingHub stay intact.
      if (existing && existing.userId === currentUser.id) {
        const renewTask = (async (): Promise<WorkspaceIdentityBundle> => {
          const freshCert = await authClient.issuePeerCert({
            userId: currentUser.id,
            peerId: existing.peerId,
            peerSignKeyPair: existing.signKeyPair,
          });
          if (
            workspaceGenRef.current !== expectedGen ||
            identityRef.current !== existing
          ) {
            throw new Error("Workspace session superseded");
          }
          existing.cert = freshCert;
          propagateUpdatedCertToEngines(freshCert);
          scheduleRenewal(existing);
          return existing;
        })();
        const renewPromise = renewTask.finally(() => {
          if (identityPromiseRef.current?.promise === renewPromise) {
            identityPromiseRef.current = null;
          }
        });
        identityPromiseRef.current = { gen: expectedGen, promise: renewPromise };
        return renewPromise;
      }

      const initTask = (async (): Promise<WorkspaceIdentityBundle> => {
        const peerId = generatePrefixedId("peer");
        const signKeyPair = generateEd25519KeyPair();

        try {
          const [meta, cert] = await Promise.all([
            authClient.getMeta(),
            authClient.issuePeerCert({
              userId: currentUser.id,
              peerId,
              peerSignKeyPair: signKeyPair,
            }),
          ]);

          if (workspaceGenRef.current !== expectedGen) {
            signKeyPair.privateKeyBytes.fill(0);
            throw new Error("Workspace session superseded");
          }

          if (identityRef.current) {
            disposeIdentityBundle(identityRef.current);
          }

          const signalingHub = new MultiplexedSignalingHub({
            peerId,
            maxSignalPayloadBytes: meta.limits.maxSignalPayloadBytes,
          });

          const bundle: WorkspaceIdentityBundle = {
            userId: currentUser.id,
            peerId,
            signKeyPair,
            cert,
            meta,
            signalingHub,
            renewalTimer: null,
          };

          scheduleRenewal(bundle);
          identityRef.current = bundle;
          return bundle;
        } catch (err) {
          signKeyPair.privateKeyBytes.fill(0);
          throw err;
        }
      })();
      const promise = initTask.finally(() => {
        if (identityPromiseRef.current?.promise === promise) {
          identityPromiseRef.current = null;
        }
      });

      identityPromiseRef.current = { gen: expectedGen, promise };
      return promise;
    },
    [authClient, propagateUpdatedCertToEngines],
  );

  const startEngineForEntry = useCallback(
    async (
      expectedGen: number,
      currentUser: UserProfile,
      entry: ManagedRoomRecord,
      identity: WorkspaceIdentityBundle,
    ): Promise<void> => {
      if (entry.disposed || entry.activeRuntime) return;
      if (entry.startingPromise) {
        await entry.startingPromise;
        return;
      }

      const startTask = (async (): Promise<void> => {
        const roomId = entry.metadata.roomId;
        if (!isEntryLive(expectedGen, roomId, entry)) {
          return;
        }
        const signalingPort = identity.signalingHub.createRoomPort(roomId);
        const transportFactory = new BrowserWebRtcTransportFactory();
        const chunkStorage = new OpfsChunkStorageAdapter();

        let activeEngine: RoomPeerEngine | null = null;
        try {
          activeEngine = createRoomPeerEngine({
            localPeerId: identity.peerId,
            localCert: identity.cert,
            localSignKeyPair: identity.signKeyPair,
            serverSignPubKey: identity.meta.serverSignPubKey,
            roomKeys: entry.roomKeys,
            iceServers: identity.meta.iceServers,
            maxSignalPayloadBytes: identity.meta.limits.maxSignalPayloadBytes,
            initialMessages: entry.messages,
            initialFiles: entry.files,
            signaling: signalingPort,
            transportFactory,
            chunkStorage,
            events: {
              onCenterConnectionChange: (connected) => {
                if (!isEntryLive(expectedGen, roomId, entry)) {
                  return;
                }
                entry.centerConnected = connected;
                publishSnapshot(currentUser.id);
              },
              onPeersChange: (nextPeers) => {
                if (!isEntryLive(expectedGen, roomId, entry)) {
                  return;
                }
                entry.peers = [...nextPeers];
                publishSnapshot(currentUser.id);
              },
              onPeerAuthRejected: (_remotePeerId, reason) => {
                if (!isEntryLive(expectedGen, roomId, entry)) {
                  return;
                }
                if (selectedRoomIdRef.current === roomId) {
                  setSecurityEvent({ kind: "peer_rejected", reason });
                }
              },
              onChatMessage: (msg) => {
                if (!isEntryLive(expectedGen, roomId, entry) || !activeEngine) {
                  return;
                }
                entry.messages = mergeOrderedMessages(entry.messages, [
                  ...activeEngine.getMessages(),
                  msg,
                ]);
                const nextActiveAt = Math.max(
                  entry.metadata.lastActiveAt,
                  msg.createdAt,
                );
                const isSelected = selectedRoomIdRef.current === roomId;
                entry.metadata = {
                  ...entry.metadata,
                  lastActiveAt: nextActiveAt,
                  lastReadAt: isSelected
                    ? Math.max(
                        entry.metadata.lastReadAt,
                        msg.createdAt,
                        Date.now(),
                      )
                    : entry.metadata.lastReadAt,
                };
                void vault
                  .saveRoomMessages(currentUser.id, roomId, entry.messages)
                  .catch(() => {});
                void vault
                  .saveRoom(currentUser.id, entry.metadata, entry.roomKeys)
                  .catch(() => {});
                publishSnapshot(currentUser.id);
              },
              onFileAnnounced: (manifest) => {
                if (!isEntryLive(expectedGen, roomId, entry) || !activeEngine) {
                  return;
                }
                entry.files = mergeOrderedFiles(entry.files, [
                  ...activeEngine.getFiles(),
                  manifest,
                ]);
                const prog = activeEngine.getTransferProgress(manifest.fileId);
                if (prog) {
                  entry.transfers.set(manifest.fileId, { ...prog });
                }
                void vault
                  .saveRoomFiles(currentUser.id, roomId, entry.files)
                  .catch(() => {});
                publishSnapshot(currentUser.id);
              },
              onTransferProgress: (progress) => {
                if (!isEntryLive(expectedGen, roomId, entry)) {
                  return;
                }
                entry.transfers.set(progress.fileId, { ...progress });
                publishSnapshot(currentUser.id);
              },
              onTransferCompleted: (manifest) => {
                if (!isEntryLive(expectedGen, roomId, entry) || !activeEngine) {
                  return;
                }
                const prog = activeEngine.getTransferProgress(manifest.fileId);
                entry.transfers.set(
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
                publishSnapshot(currentUser.id);
              },
              onError: (err) => {
                if (!isEntryLive(expectedGen, roomId, entry)) {
                  return;
                }
                if (selectedRoomIdRef.current === roomId) {
                  setSecurityEvent({
                    kind: "engine_error",
                    failure: toAppFailure(err),
                  });
                }
              },
            },
          });

          const runtimeInstance: ActiveRoomEngineInstance = {
            engine: activeEngine,
            chunkStorage,
            localPeerId: identity.peerId,
          };
          entry.activeRuntime = runtimeInstance;

          await activeEngine.start();

          if (
            !isEntryLive(expectedGen, roomId, entry) ||
            entry.activeRuntime !== runtimeInstance
          ) {
            if (entry.activeRuntime === runtimeInstance) {
              entry.activeRuntime = null;
            }
            await activeEngine.stop().catch(() => {});
            await chunkStorage.closeAll().catch(() => {});
            return;
          }

          const verifiedMessages = activeEngine.getMessages();
          const verifiedFiles = activeEngine.getFiles();
          const droppedInvalidMsgs =
            verifiedMessages.length < entry.messages.length;
          const droppedInvalidFiles = verifiedFiles.length < entry.files.length;

          entry.centerConnected = activeEngine.isCenterConnected();
          entry.peers = activeEngine.getVerifiedPeers();
          entry.messages = verifiedMessages;
          entry.files = verifiedFiles;

          if (droppedInvalidMsgs && isEntryLive(expectedGen, roomId, entry)) {
            void vault
              .saveRoomMessages(currentUser.id, roomId, entry.messages)
              .catch(() => {});
          }
          if (droppedInvalidFiles && isEntryLive(expectedGen, roomId, entry)) {
            void vault
              .saveRoomFiles(currentUser.id, roomId, entry.files)
              .catch(() => {});
          }
          publishSnapshot(currentUser.id);
        } catch (err) {
          if (entry.activeRuntime?.engine === activeEngine) {
            entry.activeRuntime = null;
          }
          entry.centerConnected = false;
          entry.peers = [];
          if (activeEngine) {
            await activeEngine.stop().catch(() => {});
          } else {
            signalingPort.disconnect();
            await chunkStorage.closeAll().catch(() => {});
          }
          throw err;
        }
      })();

      entry.startingPromise = startTask.finally(() => {
        if (entry.startingPromise === startTask) {
          entry.startingPromise = null;
        }
      });

      await entry.startingPromise;
    },
    [isEntryLive, publishSnapshot, vault],
  );

  const rebalanceActiveMeshes = useCallback(
    (expectedGen: number, currentUser: UserProfile): Promise<void> =>
      runSerializedMeshOp(async () => {
        if (
          workspaceGenRef.current !== expectedGen ||
          roomsRef.current.size === 0
        ) {
          return;
        }

        const identity = await ensureIdentityBundle(expectedGen, currentUser);
        if (
          workspaceGenRef.current !== expectedGen ||
          roomsRef.current.size === 0
        ) {
          return;
        }

        const sortedEntries = Array.from(roomsRef.current.values())
          .filter((e) => !e.disposed)
          .sort((a, b) => compareRoomOrder(a.metadata, b.metadata));
        const maxActive = Math.min(
          MAX_ACTIVE_MESH_ROOMS,
          identity.meta.limits.maxRoomsPerConnection,
        );
        const desiredActiveIds = selectActiveMeshRoomIds(
          sortedEntries.map((e) => e.metadata.roomId),
          selectedRoomIdRef.current,
          maxActive,
        );

        // 1. Demote standby rooms first so server per-WS room cap is never exceeded
        for (const entry of sortedEntries) {
          if (
            !desiredActiveIds.has(entry.metadata.roomId) &&
            (entry.activeRuntime !== null || entry.startingPromise !== null)
          ) {
            await stopRoomEngineOnly(entry);
          }
        }
        if (workspaceGenRef.current !== expectedGen) return;

        // 2. Promote active rooms concurrently (selected room first)
        const entriesToStart = sortedEntries.filter(
          (e) =>
            !e.disposed &&
            desiredActiveIds.has(e.metadata.roomId) &&
            e.activeRuntime === null &&
            e.startingPromise === null,
        );
        entriesToStart.sort((a, b) => {
          if (a.metadata.roomId === selectedRoomIdRef.current) return -1;
          if (b.metadata.roomId === selectedRoomIdRef.current) return 1;
          return 0;
        });

        await Promise.allSettled(
          entriesToStart.map((entry) =>
            startEngineForEntry(expectedGen, currentUser, entry, identity),
          ),
        );
        if (workspaceGenRef.current === expectedGen) {
          publishSnapshot(currentUser.id);
        }
      }),
    [
      ensureIdentityBundle,
      publishSnapshot,
      runSerializedMeshOp,
      startEngineForEntry,
    ],
  );

  const disconnectAllPreservingVault = useCallback(async (): Promise<void> => {
    workspaceGenRef.current += 1;
    identityPromiseRef.current = null;
    inFlightJoinsRef.current.clear();

    const entries = Array.from(roomsRef.current.values());
    for (const entry of entries) {
      entry.disposed = true;
    }
    roomsRef.current.clear();
    selectedRoomIdRef.current = null;

    const identity = identityRef.current;
    identityRef.current = null;

    setJoinPhase("idle");
    setJoinFailure(null);
    setSecurityEvent(null);
    setSnapshot(EMPTY_UI_SNAPSHOT);

    await Promise.allSettled(
      entries.map((entry) => destroyEntryKeysAndEngine(entry)),
    );
    disposeIdentityBundle(identity);
    await vault.flush().catch(() => {});
  }, [vault]);

  const wipeLocalVault = useCallback(async (): Promise<void> => {
    const targetUserId = user?.id ?? activeUserIdRef.current;
    await disconnectAllPreservingVault();
    if (targetUserId) {
      await vault.wipeUserVault(targetUserId);
    }
  }, [disconnectAllPreservingVault, user?.id, vault]);

  // Hydrate persistent encrypted rooms from IndexedDB when user authenticates
  useEffect(() => {
    if (!user) {
      activeUserIdRef.current = null;
      setHydratedUserId(null);
      void disconnectAllPreservingVault();
      return;
    }

    activeUserIdRef.current = user.id;
    const myGen = workspaceGenRef.current + 1;
    workspaceGenRef.current = myGen;

    void (async () => {
      try {
        const hydratedRooms = await vault.loadWorkspace(user.id);
        if (workspaceGenRef.current !== myGen) {
          for (const h of hydratedRooms) {
            wipeRoomKeys(h.roomKeys);
          }
          return;
        }

        roomsRef.current.clear();
        for (const h of hydratedRooms) {
          roomsRef.current.set(h.metadata.roomId, {
            metadata: h.metadata,
            roomKeys: h.roomKeys,
            messages: h.messages,
            files: h.files,
            transfers: new Map(),
            peers: [],
            centerConnected: false,
            activeRuntime: null,
            startingPromise: null,
            disposed: false,
          });
        }

        if (hydratedRooms.length > 0) {
          const sorted = [...hydratedRooms].sort((a, b) =>
            compareRoomOrder(a.metadata, b.metadata),
          );
          const topRoomId = sorted[0]!.metadata.roomId;
          selectedRoomIdRef.current = topRoomId;
          const topEntry = roomsRef.current.get(topRoomId);
          if (topEntry && isEntryLive(myGen, topRoomId, topEntry)) {
            const readNow = Date.now();
            topEntry.metadata = {
              ...topEntry.metadata,
              lastReadAt: Math.max(topEntry.metadata.lastReadAt, readNow),
            };
            void vault
              .saveRoom(user.id, topEntry.metadata, topEntry.roomKeys)
              .catch(() => {});
          }
        } else {
          selectedRoomIdRef.current = null;
        }

        publishSnapshot(user.id);
        setHydratedUserId(user.id);

        if (hydratedRooms.length > 0) {
          await rebalanceActiveMeshes(myGen, user).catch((err) => {
            if (workspaceGenRef.current !== myGen) return;
            if (
              err instanceof HttpApiError &&
              (err.status === 401 || err.code === "csrf_invalid")
            ) {
              onSessionExpired();
            }
          });
        }
      } catch {
        if (workspaceGenRef.current === myGen) {
          setHydratedUserId(user.id);
        }
      }
    })();

    return () => {
      if (workspaceGenRef.current === myGen) {
        void disconnectAllPreservingVault();
      }
    };
  }, [
    disconnectAllPreservingVault,
    isEntryLive,
    onSessionExpired,
    publishSnapshot,
    rebalanceActiveMeshes,
    user,
    vault,
  ]);

  // On tab close / page reload, close live WebRTC & WebSocket and zeroize RAM keys WITHOUT deleting RoomVault
  useEffect(() => {
    const handlePageHide = (): void => {
      void disconnectAllPreservingVault();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [disconnectAllPreservingVault]);

  const joinRoom = useCallback(
    async (passphrase: string, alias?: string): Promise<boolean> => {
      if (!user) return false;
      const myGen = workspaceGenRef.current;

      setJoinFailure(null);
      setJoinPhase("deriving");

      let derivedKeys: DerivedRoomKeys | null = null;

      try {
        derivedKeys = await deriveRoomKeysOffThread(passphrase);
        if (workspaceGenRef.current !== myGen) {
          wipeRoomKeys(derivedKeys);
          return false;
        }
      } catch (err) {
        if (derivedKeys) {
          wipeRoomKeys(derivedKeys);
        }
        if (workspaceGenRef.current === myGen) {
          setJoinPhase("idle");
          setJoinFailure(toAppFailure(err));
        }
        return false;
      }

      const targetRoomId = derivedKeys.roomId;
      const joinDedupKey = `${myGen}:${targetRoomId}`;
      const existingJoin = inFlightJoinsRef.current.get(joinDedupKey);
      if (existingJoin) {
        wipeRoomKeys(derivedKeys);
        return existingJoin;
      }

      const keysToOwn = derivedKeys;
      const joinTask = (async (): Promise<boolean> => {
        let ownedKeys: DerivedRoomKeys | null = keysToOwn;
        let createdEntry: ManagedRoomRecord | null = null;

        try {
          return await runSerializedMeshOp(async (): Promise<boolean> => {
            if (workspaceGenRef.current !== myGen) {
              if (ownedKeys) {
                wipeRoomKeys(ownedKeys);
                ownedKeys = null;
              }
              return false;
            }

            const existing = roomsRef.current.get(targetRoomId);
            if (existing && !existing.disposed) {
              if (ownedKeys) {
                wipeRoomKeys(ownedKeys);
                ownedKeys = null;
              }

              const nowMs = Date.now();
              const nextAlias =
                alias !== undefined && sanitizeRoomAlias(alias) !== null
                  ? sanitizeRoomAlias(alias)
                  : existing.metadata.alias;
              existing.metadata = {
                ...existing.metadata,
                alias: nextAlias,
                lastActiveAt: nowMs,
                lastReadAt: nowMs,
              };
              selectedRoomIdRef.current = existing.metadata.roomId;
              setSecurityEvent(null);

              if (!isEntryLive(myGen, existing.metadata.roomId, existing)) {
                return false;
              }
              await vault.saveRoom(
                user.id,
                existing.metadata,
                existing.roomKeys,
              );
              if (!isEntryLive(myGen, existing.metadata.roomId, existing)) {
                return false;
              }

              setJoinPhase("connecting");
              const identity = await ensureIdentityBundle(myGen, user);
              if (!isEntryLive(myGen, existing.metadata.roomId, existing)) {
                return false;
              }

              if (!existing.activeRuntime && !existing.startingPromise) {
                const maxActive = Math.min(
                  MAX_ACTIVE_MESH_ROOMS,
                  identity.meta.limits.maxRoomsPerConnection,
                );
                const currentlyActive = Array.from(roomsRef.current.values())
                  .filter(
                    (e) =>
                      !e.disposed &&
                      e !== existing &&
                      (e.activeRuntime !== null || e.startingPromise !== null),
                  )
                  .sort((a, b) => compareRoomOrder(a.metadata, b.metadata));
                while (currentlyActive.length >= maxActive && maxActive > 0) {
                  const victim = currentlyActive.pop();
                  if (victim) {
                    await stopRoomEngineOnly(victim);
                  }
                }
                if (!isEntryLive(myGen, existing.metadata.roomId, existing)) {
                  return false;
                }
                await startEngineForEntry(myGen, user, existing, identity);
              }

              if (workspaceGenRef.current !== myGen) return false;
              setJoinPhase("idle");
              publishSnapshot(user.id);
              return true;
            }

            setJoinPhase("connecting");
            const identity = await ensureIdentityBundle(myGen, user);
            if (workspaceGenRef.current !== myGen) {
              if (ownedKeys) {
                wipeRoomKeys(ownedKeys);
                ownedKeys = null;
              }
              return false;
            }

            // Demote standby victims inside the serialized mesh op so per-WS cap is strictly respected
            const maxActive = Math.min(
              MAX_ACTIVE_MESH_ROOMS,
              identity.meta.limits.maxRoomsPerConnection,
            );
            const currentlyActive = Array.from(roomsRef.current.values())
              .filter(
                (e) =>
                  !e.disposed &&
                  (e.activeRuntime !== null || e.startingPromise !== null),
              )
              .sort((a, b) => compareRoomOrder(a.metadata, b.metadata));
            while (currentlyActive.length >= maxActive && maxActive > 0) {
              const victim = currentlyActive.pop();
              if (victim) {
                await stopRoomEngineOnly(victim);
              }
            }
            if (workspaceGenRef.current !== myGen || !ownedKeys) {
              if (ownedKeys) {
                wipeRoomKeys(ownedKeys);
                ownedKeys = null;
              }
              return false;
            }

            const nowMs = Date.now();
            const metadata: VaultRoomMetadata = {
              roomId: ownedKeys.roomId,
              roomIdPrefix: ownedKeys.roomIdPrefix,
              alias: sanitizeRoomAlias(alias),
              pinned: false,
              joinedAt: nowMs,
              lastActiveAt: nowMs,
              lastReadAt: nowMs,
            };

            createdEntry = {
              metadata,
              roomKeys: ownedKeys,
              messages: [],
              files: [],
              transfers: new Map(),
              peers: [],
              centerConnected: false,
              activeRuntime: null,
              startingPromise: null,
              disposed: false,
            };
            ownedKeys = null;

            roomsRef.current.set(metadata.roomId, createdEntry);
            const prevSelectedId = selectedRoomIdRef.current;
            selectedRoomIdRef.current = metadata.roomId;

            try {
              await startEngineForEntry(myGen, user, createdEntry, identity);
            } catch (startErr) {
              if (roomsRef.current.get(metadata.roomId) === createdEntry) {
                roomsRef.current.delete(metadata.roomId);
              }
              if (selectedRoomIdRef.current === metadata.roomId) {
                selectedRoomIdRef.current = prevSelectedId;
              }
              throw startErr;
            }

            if (!isEntryLive(myGen, metadata.roomId, createdEntry)) {
              if (roomsRef.current.get(metadata.roomId) === createdEntry) {
                roomsRef.current.delete(metadata.roomId);
              }
              await destroyEntryKeysAndEngine(createdEntry);
              return false;
            }

            await vault.saveRoom(
              user.id,
              createdEntry.metadata,
              createdEntry.roomKeys,
            );
            if (!isEntryLive(myGen, metadata.roomId, createdEntry)) {
              return false;
            }

            setSecurityEvent(null);
            setJoinPhase("idle");
            publishSnapshot(user.id);
            return true;
          });
        } catch (err) {
          const failedEntry = createdEntry as ManagedRoomRecord | null;
          if (failedEntry) {
            if (
              roomsRef.current.get(failedEntry.metadata.roomId) === failedEntry
            ) {
              roomsRef.current.delete(failedEntry.metadata.roomId);
            }
            await destroyEntryKeysAndEngine(failedEntry);
          } else if (ownedKeys) {
            wipeRoomKeys(ownedKeys);
          }

          if (workspaceGenRef.current === myGen) {
            setJoinPhase("idle");
            publishSnapshot(user.id);
            if (
              err instanceof HttpApiError &&
              (err.status === 401 || err.code === "csrf_invalid")
            ) {
              onSessionExpired();
            } else {
              setJoinFailure(toAppFailure(err));
            }
          }
          return false;
        }
      })();
      const trackedJoinTask = joinTask.finally(() => {
        if (inFlightJoinsRef.current.get(joinDedupKey) === trackedJoinTask) {
          inFlightJoinsRef.current.delete(joinDedupKey);
        }
      });

      inFlightJoinsRef.current.set(joinDedupKey, trackedJoinTask);
      return trackedJoinTask;
    },
    [
      ensureIdentityBundle,
      isEntryLive,
      onSessionExpired,
      publishSnapshot,
      runSerializedMeshOp,
      startEngineForEntry,
      user,
      vault,
    ],
  );

  const selectRoom = useCallback(
    async (roomId: string): Promise<void> => {
      if (!user) return;
      const myGen = workspaceGenRef.current;
      const entry = roomsRef.current.get(roomId);
      if (!entry || !isEntryLive(myGen, roomId, entry)) return;

      selectedRoomIdRef.current = roomId;
      setSecurityEvent(null);

      const latestMsgTime =
        entry.messages.length > 0
          ? entry.messages[entry.messages.length - 1]!.createdAt
          : 0;
      const nextReadAt = Math.max(
        entry.metadata.lastReadAt,
        latestMsgTime,
        Date.now(),
      );
      if (nextReadAt !== entry.metadata.lastReadAt) {
        entry.metadata = {
          ...entry.metadata,
          lastReadAt: nextReadAt,
        };
        if (isEntryLive(myGen, roomId, entry)) {
          void vault
            .saveRoom(user.id, entry.metadata, entry.roomKeys)
            .catch(() => {});
        }
      }

      publishSnapshot(user.id);

      if (!entry.activeRuntime && !entry.startingPromise) {
        await rebalanceActiveMeshes(myGen, user).catch((err) => {
          if (workspaceGenRef.current !== myGen) return;
          if (
            err instanceof HttpApiError &&
            (err.status === 401 || err.code === "csrf_invalid")
          ) {
            onSessionExpired();
          } else {
            setSecurityEvent({
              kind: "engine_error",
              failure: toAppFailure(err),
            });
          }
        });
      }
    },
    [
      isEntryLive,
      onSessionExpired,
      publishSnapshot,
      rebalanceActiveMeshes,
      user,
      vault,
    ],
  );

  const renameRoomAlias = useCallback(
    async (roomId: string, alias: string | null): Promise<void> => {
      if (!user) return;
      const myGen = workspaceGenRef.current;
      const entry = roomsRef.current.get(roomId);
      if (!entry || !isEntryLive(myGen, roomId, entry)) return;

      entry.metadata = {
        ...entry.metadata,
        alias: sanitizeRoomAlias(alias),
      };
      publishSnapshot(user.id);
      if (isEntryLive(myGen, roomId, entry)) {
        await vault.saveRoom(user.id, entry.metadata, entry.roomKeys);
      }
    },
    [isEntryLive, publishSnapshot, user, vault],
  );

  const togglePinRoom = useCallback(
    async (roomId: string): Promise<void> => {
      if (!user) return;
      const myGen = workspaceGenRef.current;
      const entry = roomsRef.current.get(roomId);
      if (!entry || !isEntryLive(myGen, roomId, entry)) return;

      entry.metadata = {
        ...entry.metadata,
        pinned: !entry.metadata.pinned,
      };
      publishSnapshot(user.id);
      if (isEntryLive(myGen, roomId, entry)) {
        await vault.saveRoom(user.id, entry.metadata, entry.roomKeys);
      }
      if (workspaceGenRef.current === myGen) {
        await rebalanceActiveMeshes(myGen, user).catch(() => {});
      }
    },
    [isEntryLive, publishSnapshot, rebalanceActiveMeshes, user, vault],
  );

  const leaveRoom = useCallback(
    async (explicitRoomId?: string): Promise<void> => {
      const targetRoomId = explicitRoomId ?? selectedRoomIdRef.current;
      if (!targetRoomId) return;

      const myGen = workspaceGenRef.current;
      const entry = roomsRef.current.get(targetRoomId);
      if (entry) {
        entry.disposed = true;
      }
      roomsRef.current.delete(targetRoomId);

      if (selectedRoomIdRef.current === targetRoomId) {
        const remaining = Array.from(roomsRef.current.values())
          .filter((e) => !e.disposed)
          .sort((a, b) => compareRoomOrder(a.metadata, b.metadata));
        selectedRoomIdRef.current = remaining[0]?.metadata.roomId ?? null;
        setSecurityEvent(null);
      }

      publishSnapshot(user?.id ?? null);

      if (entry) {
        await destroyEntryKeysAndEngine(entry);
      }
      if (user) {
        await vault.destroyRoom(user.id, targetRoomId);
        if (workspaceGenRef.current === myGen && roomsRef.current.size > 0) {
          await rebalanceActiveMeshes(myGen, user).catch(() => {});
        }
      }
    },
    [publishSnapshot, rebalanceActiveMeshes, user, vault],
  );

  const sendMessage = useCallback(
    async (body: string, replyToMsgId: string | null): Promise<void> => {
      const myGen = workspaceGenRef.current;
      const selId = selectedRoomIdRef.current;
      const entry = selId ? roomsRef.current.get(selId) : undefined;
      const rt = entry?.activeRuntime;
      if (!user || !entry || !rt || !isEntryLive(myGen, entry.metadata.roomId, entry)) {
        throw new Error("Room session is not active");
      }

      const roomId = entry.metadata.roomId;
      const sent = await rt.engine.sendChatMessage(body, replyToMsgId);
      if (!isEntryLive(myGen, roomId, entry)) {
        return;
      }

      entry.messages = mergeOrderedMessages(entry.messages, [
        ...rt.engine.getMessages(),
        sent,
      ]);
      const nowMs = Math.max(Date.now(), sent.createdAt);
      entry.metadata = {
        ...entry.metadata,
        lastActiveAt: nowMs,
        lastReadAt: nowMs,
      };
      publishSnapshot(user.id);

      if (!isEntryLive(myGen, roomId, entry)) {
        return;
      }
      await Promise.all([
        vault.saveRoomMessages(user.id, roomId, entry.messages),
        vault.saveRoom(user.id, entry.metadata, entry.roomKeys),
      ]);
    },
    [isEntryLive, publishSnapshot, user, vault],
  );

  const shareFiles = useCallback(
    async (selectedFiles: File[]): Promise<void> => {
      const myGen = workspaceGenRef.current;
      const selId = selectedRoomIdRef.current;
      const entry = selId ? roomsRef.current.get(selId) : undefined;
      const rt = entry?.activeRuntime;
      if (!user || !entry || !rt || !isEntryLive(myGen, entry.metadata.roomId, entry)) {
        throw new Error("Room session is not active");
      }

      const roomId = entry.metadata.roomId;
      for (const file of selectedFiles) {
        if (!isEntryLive(myGen, roomId, entry) || entry.activeRuntime !== rt) {
          return;
        }
        const manifest = await rt.engine.shareFile({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          readChunk: createBrowserFileChunkReader(file),
        });
        if (!isEntryLive(myGen, roomId, entry)) {
          return;
        }
        rt.chunkStorage.attachLocalSourceBlob(manifest.fileId, file);
        entry.files = mergeOrderedFiles(entry.files, [
          ...rt.engine.getFiles(),
          manifest,
        ]);
        const prog = rt.engine.getTransferProgress(manifest.fileId);
        entry.transfers.set(
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
        entry.metadata = {
          ...entry.metadata,
          lastActiveAt: Date.now(),
        };
        publishSnapshot(user.id);

        if (!isEntryLive(myGen, roomId, entry)) {
          return;
        }
        await Promise.all([
          vault.saveRoomFiles(user.id, roomId, entry.files),
          vault.saveRoom(user.id, entry.metadata, entry.roomKeys),
        ]);
      }
    },
    [isEntryLive, publishSnapshot, user, vault],
  );

  const downloadFile = useCallback(
    async (fileId: string): Promise<void> => {
      const selId = selectedRoomIdRef.current;
      const entry = selId ? roomsRef.current.get(selId) : undefined;
      const rt = entry?.activeRuntime;
      if (!user || !entry || !rt) return;

      await rt.engine.downloadFile(fileId);
      const prog = rt.engine.getTransferProgress(fileId);
      if (prog) {
        entry.transfers.set(fileId, { ...prog });
        publishSnapshot(user.id);
      }
    },
    [publishSnapshot, user],
  );

  const cancelDownload = useCallback(
    async (fileId: string): Promise<void> => {
      const selId = selectedRoomIdRef.current;
      const entry = selId ? roomsRef.current.get(selId) : undefined;
      const rt = entry?.activeRuntime;
      if (!user || !entry || !rt) return;

      await rt.engine.cancelDownload(fileId);
      const prog = rt.engine.getTransferProgress(fileId);
      if (prog) {
        entry.transfers.set(fileId, { ...prog });
        publishSnapshot(user.id);
      }
    },
    [publishSnapshot, user],
  );

  const saveFile = useCallback(async (manifest: FileManifest): Promise<void> => {
    const selId = selectedRoomIdRef.current;
    const entry = selId ? roomsRef.current.get(selId) : undefined;
    const rt = entry?.activeRuntime;
    if (!rt) return;

    await rt.chunkStorage.triggerBrowserDownload(
      manifest.fileId,
      manifest.fileName,
      manifest.mimeType,
    );
  }, []);

  const canSaveFile = useCallback((fileId: string): boolean => {
    const selId = selectedRoomIdRef.current;
    const entry = selId ? roomsRef.current.get(selId) : undefined;
    const rt = entry?.activeRuntime;
    return rt ? rt.chunkStorage.isSaveAvailable(fileId) : false;
  }, []);

  const clearJoinFailure = useCallback((): void => {
    setJoinFailure(null);
  }, []);

  const dismissSecurityEvent = useCallback((): void => {
    setSecurityEvent(null);
  }, []);

  const hydrating = user !== null && hydratedUserId !== user.id;
  const inRoom = !hydrating && snapshot.rooms.length > 0;

  return {
    hydrating,
    inRoom,
    joinPhase,
    joinFailure,
    clearJoinFailure,
    rooms: snapshot.rooms,
    selectedRoomId: snapshot.selectedRoomId,
    selectedRoomAlias: snapshot.selectedRoomAlias,
    selectedRoomStatus: snapshot.selectedRoomStatus,
    roomIdPrefix: snapshot.roomIdPrefix,
    localPeerId: snapshot.localPeerId,
    centerConnected: snapshot.centerConnected,
    peers: snapshot.peers,
    messages: snapshot.messages,
    files: snapshot.files,
    transfers: snapshot.transfers,
    securityEvent,
    dismissSecurityEvent,
    joinRoom,
    selectRoom,
    renameRoomAlias,
    togglePinRoom,
    leaveRoom,
    disconnectAllPreservingVault,
    wipeLocalVault,
    sendMessage,
    shareFiles,
    downloadFile,
    cancelDownload,
    saveFile,
    canSaveFile,
  };
}
