import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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
import { HttpApiError, HttpAuthClient } from "./api/http-client.ts";
import { AuthView } from "./components/AuthView.tsx";
import { JoinRoomView, type JoinPhase } from "./components/JoinRoomView.tsx";
import { RoomWorkspace } from "./components/RoomWorkspace.tsx";
import { deriveRoomKeysOffThread } from "./crypto/kdf-client.ts";
import {
  createBrowserFileChunkReader,
  OpfsChunkStorageAdapter,
} from "./storage/opfs-chunk-storage.ts";
import { BrowserSignalingClient } from "./transport/browser-signaling.ts";
import { BrowserWebRtcTransportFactory } from "./transport/browser-webrtc.ts";

interface ActiveRoomRuntime {
  engine: RoomPeerEngine;
  roomKeys: DerivedRoomKeys;
  localSignKeyPair: Ed25519KeyPair;
  chunkStorage: OpfsChunkStorageAdapter;
  localPeerId: string;
  roomIdPrefix: string;
}

function mergeOrderedMessages(
  existing: ChatMessageEnvelope[],
  incoming: ChatMessageEnvelope[],
): ChatMessageEnvelope[] {
  const byId = new Map<string, ChatMessageEnvelope>();
  for (const m of existing) {
    byId.set(m.msgId, m);
  }
  for (const m of incoming) {
    byId.set(m.msgId, m);
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      a.lamport - b.lamport ||
      a.createdAt - b.createdAt ||
      a.msgId.localeCompare(b.msgId),
  );
}

function mergeOrderedFiles(
  existing: FileManifest[],
  incoming: FileManifest[],
): FileManifest[] {
  const byId = new Map<string, FileManifest>();
  for (const f of existing) {
    byId.set(f.fileId, f);
  }
  for (const f of incoming) {
    byId.set(f.fileId, f);
  }
  return Array.from(byId.values());
}

export function App(): ReactElement {
  const authClientRef = useRef<HttpAuthClient | null>(null);
  if (!authClientRef.current) {
    authClientRef.current = new HttpAuthClient();
  }
  const authClient = authClientRef.current;

  const runtimeRef = useRef<ActiveRoomRuntime | null>(null);
  const joinGenRef = useRef(0);

  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [joinPhase, setJoinPhase] = useState<JoinPhase>("idle");
  const [joinError, setJoinError] = useState<string | null>(null);

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
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);

  const teardownActiveRoom = useCallback(async (): Promise<void> => {
    joinGenRef.current += 1;
    const rt = runtimeRef.current;
    runtimeRef.current = null;

    setInRoom(false);
    setJoinPhase("idle");
    setRoomIdPrefix("");
    setLocalPeerId("");
    setCenterConnected(false);
    setPeers([]);
    setMessages([]);
    setFiles([]);
    setTransfers(new Map());
    setSecurityNotice(null);

    if (!rt) return;

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
  }, []);

  useEffect(() => {
    let cancelled = false;

    const unsubscribeCrossTab = authClient.onCrossTabSessionReset((nextUser) => {
      void teardownActiveRoom().then(() => {
        if (cancelled) return;
        setUser(nextUser);
        setJoinError(null);
        if (nextUser === null) {
          setAuthNotice("Signed out from another browser tab.");
        }
      });
    });

    void authClient
      .getMe()
      .then((restoredUser) => {
        if (!cancelled) {
          setUser(restoredUser);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBootstrapping(false);
        }
      });

    const handlePageHide = (): void => {
      void teardownActiveRoom();
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", handlePageHide);
      unsubscribeCrossTab();
      void teardownActiveRoom();
    };
  }, [authClient, teardownActiveRoom]);

  const handleLogin = async (params: {
    username: string;
    password: string;
  }): Promise<void> => {
    await teardownActiveRoom();
    const loggedIn = await authClient.login(params);
    setAuthNotice(null);
    setJoinError(null);
    setUser(loggedIn);
  };

  const handleRegister = async (params: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<void> => {
    await teardownActiveRoom();
    const registered = await authClient.register(params);
    setAuthNotice(null);
    setJoinError(null);
    setUser(registered);
  };

  const handleSignOut = async (): Promise<void> => {
    await teardownActiveRoom();
    try {
      await authClient.logout();
    } finally {
      setUser(null);
      setJoinError(null);
    }
  };

  const handleJoinRoom = async (passphrase: string): Promise<void> => {
    if (!user) return;
    await teardownActiveRoom();

    const myGen = ++joinGenRef.current;
    setJoinError(null);
    setJoinPhase("deriving");

    let derivedKeys: DerivedRoomKeys | null = null;
    let signKeyPair: Ed25519KeyPair | null = null;
    let chunkStorage: OpfsChunkStorageAdapter | null = null;
    let engine: RoomPeerEngine | null = null;

    try {
      derivedKeys = await deriveRoomKeysOffThread(passphrase);
      if (joinGenRef.current !== myGen) {
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

      if (joinGenRef.current !== myGen) {
        wipeRoomKeys(derivedKeys);
        signKeyPair.privateKeyBytes.fill(0);
        return;
      }

      const signaling = new BrowserSignalingClient({ peerId });
      const transportFactory = new BrowserWebRtcTransportFactory();
      chunkStorage = new OpfsChunkStorageAdapter();

      const activeEngine = createRoomPeerEngine({
        localPeerId: peerId,
        localCert: cert,
        localSignKeyPair: signKeyPair,
        serverSignPubKey: meta.serverSignPubKey,
        roomKeys: derivedKeys,
        iceServers: meta.iceServers,
        signaling,
        transportFactory,
        chunkStorage,
        events: {
          onCenterConnectionChange: (connected) => {
            if (joinGenRef.current !== myGen) return;
            setCenterConnected(connected);
          },
          onPeersChange: (nextPeers) => {
            if (joinGenRef.current !== myGen) return;
            setPeers([...nextPeers]);
          },
          onPeerAuthRejected: (_remotePeerId, reason) => {
            if (joinGenRef.current !== myGen) return;
            setSecurityNotice(
              `Quarantined peer failed HELLO_AUTH verification (${reason}) and was disconnected.`,
            );
          },
          onChatMessage: (msg) => {
            if (joinGenRef.current !== myGen) return;
            setMessages((prev) =>
              mergeOrderedMessages(prev, [
                ...activeEngine.getMessages(),
                msg,
              ]),
            );
          },
          onFileAnnounced: (manifest) => {
            if (joinGenRef.current !== myGen) return;
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
            if (joinGenRef.current !== myGen) return;
            setTransfers((prev) => {
              const next = new Map(prev);
              next.set(progress.fileId, { ...progress });
              return next;
            });
          },
          onTransferCompleted: (manifest) => {
            if (joinGenRef.current !== myGen) return;
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
            if (joinGenRef.current !== myGen) return;
            setSecurityNotice(err.message);
          },
        },
      });
      engine = activeEngine;

      runtimeRef.current = {
        engine: activeEngine,
        roomKeys: derivedKeys,
        localSignKeyPair: signKeyPair,
        chunkStorage,
        localPeerId: peerId,
        roomIdPrefix: derivedKeys.roomIdPrefix,
      };

      await activeEngine.start();

      if (joinGenRef.current !== myGen) {
        await teardownActiveRoom();
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
      runtimeRef.current = null;
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

      if (joinGenRef.current === myGen) {
        setJoinPhase("idle");
        if (
          err instanceof HttpApiError &&
          (err.status === 401 || err.code === "csrf_invalid")
        ) {
          setUser(null);
          setAuthNotice("Please sign in again to issue a fresh peer certificate.");
        } else {
          setJoinError(
            err instanceof Error ? err.message : "Failed to join encrypted room",
          );
        }
      }
    }
  };

  const handleSendMessage = async (
    body: string,
    replyToMsgId: string | null,
  ): Promise<void> => {
    const rt = runtimeRef.current;
    if (!rt) {
      throw new Error("Room session is not active");
    }
    const sent = await rt.engine.sendChatMessage(body, replyToMsgId);
    setMessages((prev) =>
      mergeOrderedMessages(prev, [...rt.engine.getMessages(), sent]),
    );
  };

  const handleShareFiles = async (selectedFiles: File[]): Promise<void> => {
    const rt = runtimeRef.current;
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
  };

  const handleDownloadFile = async (fileId: string): Promise<void> => {
    const rt = runtimeRef.current;
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
  };

  const handleCancelDownload = async (fileId: string): Promise<void> => {
    const rt = runtimeRef.current;
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
  };

  const handleSaveFile = async (manifest: FileManifest): Promise<void> => {
    const rt = runtimeRef.current;
    if (!rt) return;
    await rt.chunkStorage.triggerBrowserDownload(
      manifest.fileId,
      manifest.fileName,
      manifest.mimeType,
    );
  };

  const canSaveFile = (fileId: string): boolean => {
    const rt = runtimeRef.current;
    return rt ? rt.chunkStorage.isSaveAvailable(fileId) : false;
  };

  if (bootstrapping) {
    return (
      <div className="centered-shell">
        <main className="centered-main">
          <div className="alert-banner alert-info" role="status">
            <span className="spinner-dot" aria-hidden="true" />
            <span>Initializing SimpleIM workspace…</span>
          </div>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthView
        onLogin={handleLogin}
        onRegister={handleRegister}
        externalNotice={authNotice}
      />
    );
  }

  if (!inRoom) {
    return (
      <JoinRoomView
        user={user}
        joinPhase={joinPhase}
        error={joinError}
        onJoinRoom={handleJoinRoom}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <RoomWorkspace
      user={user}
      localPeerId={localPeerId}
      roomIdPrefix={roomIdPrefix}
      centerConnected={centerConnected}
      peers={peers}
      messages={messages}
      files={files}
      transfers={transfers}
      securityNotice={securityNotice}
      onDismissNotice={() => setSecurityNotice(null)}
      onSendMessage={handleSendMessage}
      onShareFiles={handleShareFiles}
      onDownloadFile={handleDownloadFile}
      onCancelDownload={handleCancelDownload}
      onSaveFile={handleSaveFile}
      canSaveFile={canSaveFile}
      onLeaveRoom={teardownActiveRoom}
      onSignOut={handleSignOut}
    />
  );
}
