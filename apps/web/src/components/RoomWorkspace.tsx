import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type {
  ChatMessageEnvelope,
  FileManifest,
  UserProfile,
} from "@simpleim/contracts";
import type {
  SwarmTransferProgress,
  VerifiedPeerInfo,
} from "@simpleim/peer-core";
import {
  formatBytes,
  formatMessageTime,
  formatRoomFingerprint,
  formatSha256Prefix,
  formatSpeedMBps,
} from "../utils/format.ts";
import { SafeMarkdown } from "../utils/markdown.tsx";

export interface RoomWorkspaceProps {
  user: UserProfile;
  localPeerId: string;
  roomIdPrefix: string;
  centerConnected: boolean;
  peers: VerifiedPeerInfo[];
  messages: ChatMessageEnvelope[];
  files: FileManifest[];
  transfers: ReadonlyMap<string, SwarmTransferProgress>;
  securityNotice: string | null;
  onDismissNotice: () => void;
  onSendMessage: (body: string, replyToMsgId: string | null) => Promise<void>;
  onShareFiles: (files: File[]) => Promise<void>;
  onDownloadFile: (fileId: string) => Promise<void>;
  onCancelDownload: (fileId: string) => Promise<void>;
  onSaveFile: (manifest: FileManifest) => Promise<void>;
  canSaveFile: (fileId: string) => boolean;
  onLeaveRoom: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

function formatStatusLabel(status: SwarmTransferProgress["status"]): string {
  switch (status) {
    case "announced":
      return "Announced";
    case "downloading":
      return "Downloading";
    case "seeding":
      return "Seeding";
    case "paused":
      return "Paused";
    case "error":
      return "Error";
  }
}

export function RoomWorkspace({
  user,
  localPeerId,
  roomIdPrefix,
  centerConnected,
  peers,
  messages,
  files,
  transfers,
  securityNotice,
  onDismissNotice,
  onSendMessage,
  onShareFiles,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  canSaveFile,
  onLeaveRoom,
  onSignOut,
}: RoomWorkspaceProps): ReactElement {
  const [draft, setDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatMessageEnvelope | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const messageById = useMemo(() => {
    const map = new Map<string, ChatMessageEnvelope>();
    for (const msg of messages) {
      map.set(msg.msgId, msg);
    }
    return map;
  }, [messages]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const submitChat = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    setActionError(null);
    const replyId = replyTarget?.msgId ?? null;
    try {
      await onSendMessage(trimmed, replyId);
      setDraft("");
      setReplyTarget(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleComposerSubmit = (ev: FormEvent<HTMLFormElement>): void => {
    ev.preventDefault();
    void submitChat();
  };

  const handleTextareaKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      void submitChat();
    }
  };

  const handleFileInputChange = (ev: ChangeEvent<HTMLInputElement>): void => {
    const selected = ev.target.files ? Array.from(ev.target.files) : [];
    ev.target.value = "";
    if (selected.length === 0) return;
    setActionError(null);
    void onShareFiles(selected).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : "Failed to share file");
    });
  };

  const handleDragEnter = (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.dataTransfer.types.includes("Files")) {
      dragDepthRef.current += 1;
      setDragActive(true);
    }
  };

  const handleDragOver = (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const handleDragLeave = (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = (ev: DragEvent<HTMLElement>): void => {
    ev.preventDefault();
    ev.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const dropped = ev.dataTransfer.files ? Array.from(ev.dataTransfer.files) : [];
    if (dropped.length === 0) return;
    setActionError(null);
    void onShareFiles(dropped).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : "Failed to share dropped file");
    });
  };

  const activeDownloadCount = useMemo(() => {
    let count = 0;
    for (const f of files) {
      const p = transfers.get(f.fileId);
      if (p?.status === "downloading") count++;
    }
    return count;
  }, [files, transfers]);

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div className="header-left">
          <div className="brand-lockup">
            <span className="brand-glyph" aria-hidden="true">
              S
            </span>
            <span>SimpleIM</span>
          </div>

          <span className="room-badge" title="Derived roomId short fingerprint">
            Room {formatRoomFingerprint(roomIdPrefix)}
          </span>

          <div
            role="status"
            aria-live="polite"
            data-testid="connection-badge"
            className={`status-pill ${
              centerConnected ? "status-pill-connected" : "status-pill-detached"
            }`}
            title={
              centerConnected
                ? "Connected to ephemeral WebSocket signaling relay for new peer discovery"
                : "Signaling WebSocket is disconnected; active P2P WebRTC DataChannels remain alive directly"
            }
          >
            <span className="status-pill-dot" aria-hidden="true" />
            <span>
              {centerConnected
                ? "Center Signaling Active"
                : "P2P Direct · Center Detached"}
            </span>
          </div>

          <span className="peer-count-pill">
            {peers.length} Verified {peers.length === 1 ? "Peer" : "Peers"}
          </span>
        </div>

        <div className="header-right">
          <button
            type="button"
            className="btn btn-secondary btn-sm mobile-drawer-toggle"
            aria-expanded={sidebarOpen}
            aria-controls="room-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Peers ({peers.length}) · Files ({files.length})
          </button>

          <span className="brand-subtitle">@{user.username}</span>

          <button
            type="button"
            data-testid="leave-room-button"
            className="btn btn-secondary btn-sm"
            onClick={() => void onLeaveRoom()}
          >
            Leave Room
          </button>

          <button
            type="button"
            data-testid="sign-out-button"
            className="btn btn-danger-ghost btn-sm"
            onClick={() => void onSignOut()}
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="workspace-body">
        <main
          className="chat-column"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragActive ? (
            <div className="drop-overlay" aria-hidden="true">
              <div className="drop-overlay-title">
                Drop files to seed via WebRTC Swarm
              </div>
              <div className="drop-overlay-sub">
                64 KiB binary chunks · SHA-256 per-chunk verification · Worker OPFS
              </div>
            </div>
          ) : null}

          {securityNotice || actionError ? (
            <div className="workspace-Inline-alerts">
              {securityNotice ? (
                <div className="alert-banner alert-warning" role="status">
                  <span>{securityNotice}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={onDismissNotice}
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
              {actionError ? (
                <div className="alert-banner alert-error" role="alert">
                  {actionError}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className="message-stream"
            role="log"
            aria-live="polite"
            aria-label="Encrypted room chat messages"
          >
            {messages.length === 0 ? (
              <div className="empty-stream">
                <p className="empty-stream-title">End-to-End Encrypted P2P Mesh Ready</p>
                <p className="empty-stream-desc">
                  Messages and Swarm file manifests flow directly over{" "}
                  <code>RTCDataChannel</code>s sealed with{" "}
                  <code>XChaCha20-Poly1305</code> and signed with{" "}
                  <code>Ed25519</code>.
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const author = msg.authorCert.payload;
                const isSelf = author.peerId === localPeerId;
                const runtimeLabel = author.clientKind === "cli" ? "CLI" : "Web";
                const repliedMsg = msg.replyToMsgId
                  ? messageById.get(msg.replyToMsgId)
                  : undefined;

                return (
                  <article
                    key={msg.msgId}
                    className={`message-card ${isSelf ? "message-card-self" : ""}`}
                  >
                    <div className="message-meta">
                      <div className="author-badge">
                        <span
                          className="verified-shield"
                          title="Signed with verified Ed25519 PeerIdentityCert"
                        >
                          VERIFIED
                        </span>
                        <span className="author-display">{author.displayName}</span>
                        <span className="author-handle">
                          @{author.username} · {runtimeLabel}
                        </span>
                        <span className="client-tag">
                          {author.clientKind.toUpperCase()}
                        </span>
                      </div>

                      <div className="message-actions">
                        <time
                          className="message-time"
                          dateTime={new Date(msg.createdAt).toISOString()}
                        >
                          {formatMessageTime(msg.createdAt)}
                        </time>
                        <button
                          type="button"
                          className="reply-btn"
                          onClick={() => {
                            setReplyTarget(msg);
                            composerRef.current?.focus();
                          }}
                        >
                          Reply
                        </button>
                      </div>
                    </div>

                    {msg.replyToMsgId ? (
                      <div className="quoted-reply">
                        <span className="quoted-reply-author">
                          {repliedMsg
                            ? `@${repliedMsg.authorCert.payload.username}`
                            : "Referenced message"}
                        </span>
                        <span>
                          {repliedMsg
                            ? repliedMsg.body.slice(0, 120) +
                              (repliedMsg.body.length > 120 ? "…" : "")
                            : msg.replyToMsgId.slice(0, 8)}
                        </span>
                      </div>
                    ) : null}

                    <SafeMarkdown content={msg.body} />
                  </article>
                );
              })
            )}
            <div ref={streamEndRef} />
          </div>

          <form className="composer-bar" onSubmit={handleComposerSubmit}>
            {replyTarget ? (
              <div className="composer-reply-banner">
                <span>
                  Replying to{" "}
                  <strong>@{replyTarget.authorCert.payload.username}</strong>:{" "}
                  {replyTarget.body.slice(0, 80)}
                  {replyTarget.body.length > 80 ? "…" : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setReplyTarget(null)}
                >
                  Cancel
                </button>
              </div>
            ) : null}

            <div className="composer-row">
              <input
                ref={fileInputRef}
                data-testid="file-input"
                type="file"
                multiple
                className="sr-only"
                aria-label="Attach files to share via P2P Swarm"
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                className="btn btn-secondary"
                title="Share file via P2P Swarm"
                onClick={() => fileInputRef.current?.click()}
              >
                Attach
              </button>

              <textarea
                ref={composerRef}
                data-testid="chat-input"
                className="composer-textarea"
                rows={1}
                placeholder="Write an encrypted message… (Enter to send, Shift+Enter for newline)"
                aria-label="Encrypted chat message"
                value={draft}
                onChange={(ev) => setDraft(ev.target.value)}
                onKeyDown={handleTextareaKeyDown}
              />

              <button
                type="submit"
                data-testid="chat-send"
                className="btn btn-primary"
                disabled={sending || draft.trim().length === 0}
              >
                Send
              </button>
            </div>
          </form>
        </main>

        <aside
          id="room-sidebar"
          className={`workspace-sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
          aria-label="Verified room peers and Swarm file transfers"
        >
          <section className="sidebar-section" aria-labelledby="peers-heading">
            <div className="section-heading-row">
              <h2 id="peers-heading" className="section-heading">
                Verified Peers
              </h2>
              <span className="section-count">{peers.length}</span>
            </div>

            <div data-testid="peer-list" className="peer-items">
              {peers.length === 0 ? (
                <p className="sidebar-empty">
                  No verified peers connected yet. Share the room passphrase with
                  another Web or CLI client.
                </p>
              ) : (
                peers.map((peer) => (
                  <div key={peer.peerId} className="peer-card">
                    <div className="peer-card-identity">
                      <div className="peer-card-top">
                        <span
                          className="verified-shield"
                          title="HELLO_AUTH mutual DTLS SHA-256 + Ed25519 + roomAuthKey verified"
                        >
                          HELLO_AUTH
                        </span>
                        <span className="peer-name">{peer.displayName}</span>
                        <span className="client-tag">
                          {peer.clientKind.toUpperCase()}
                        </span>
                      </div>
                      <span className="peer-username">@{peer.username}</span>
                    </div>

                    <span className="peer-rtt" title="Measured P2P DataChannel RTT">
                      {peer.rttMs !== null ? `${Math.round(peer.rttMs)} ms` : "— ms"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="sidebar-section" aria-labelledby="swarm-files-heading">
            <div className="section-heading-row">
              <h2 id="swarm-files-heading" className="section-heading">
                Swarm Files
              </h2>
              <span className="section-count">{files.length}</span>
            </div>

            <div className="sr-only" role="status" aria-live="polite">
              {files.length} swarm files available, {activeDownloadCount} downloading
            </div>

            <div data-testid="file-list" className="file-items">
              {files.length === 0 ? (
                <p className="sidebar-empty">
                  No Swarm files announced yet. Click Attach or drop a file into the
                  chat pane.
                </p>
              ) : (
                files.map((manifest) => {
                  const isOwnSeed = manifest.senderCert.payload.peerId === localPeerId;
                  const progress = transfers.get(manifest.fileId);
                  const status: SwarmTransferProgress["status"] =
                    progress?.status ?? (isOwnSeed ? "seeding" : "announced");
                  const completedChunks =
                    progress?.completedChunks ??
                    (status === "seeding" ? manifest.totalChunks : 0);
                  const pct =
                    manifest.totalChunks === 0
                      ? status === "seeding"
                        ? 100
                        : 0
                      : Math.min(
                          100,
                          Math.round((completedChunks / manifest.totalChunks) * 100),
                        );
                  const seedCount =
                    progress?.availableSeeders ?? (isOwnSeed ? 1 : 0);
                  const peerChunkCount =
                    progress?.availablePeersWithChunks ?? seedCount;
                  const speedBytesPerSec = progress?.downloadSpeedBytesPerSec ?? 0;
                  const saveReady =
                    status === "seeding" && canSaveFile(manifest.fileId);

                  return (
                    <div key={manifest.fileId} className="file-card">
                      <div className="file-card-header">
                        <span className="file-name">{manifest.fileName}</span>
                        <span
                          className={`transfer-badge transfer-badge-${status}`}
                        >
                          {formatStatusLabel(status)}
                        </span>
                      </div>

                      <div className="file-meta-row">
                        <span>{formatBytes(manifest.fileSize)}</span>
                        <span title={`Full SHA-256: ${manifest.fileSha256}`}>
                          SHA-256 {formatSha256Prefix(manifest.fileSha256)}
                        </span>
                      </div>

                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-label={`${manifest.fileName} transfer progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                      >
                        <div
                          className="progress-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      <div className="file-stats-row">
                        <span>
                          Seeds / Peers: {seedCount} / {peerChunkCount}
                        </span>
                        <span>{formatSpeedMBps(speedBytesPerSec)}</span>
                      </div>

                      {progress?.errorMessage ? (
                        <div className="alert-banner alert-error">
                          {progress.errorMessage}
                        </div>
                      ) : null}

                      <div className="file-actions-row">
                        {status === "announced" ||
                        status === "paused" ||
                        status === "error" ? (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              setActionError(null);
                              void onDownloadFile(manifest.fileId).catch(
                                (err: unknown) => {
                                  setActionError(
                                    err instanceof Error
                                      ? err.message
                                      : "Download failed",
                                  );
                                },
                              );
                            }}
                          >
                            Download
                          </button>
                        ) : null}

                        {status === "downloading" ? (
                          <button
                            type="button"
                            className="btn btn-danger-ghost btn-sm"
                            onClick={() => {
                              void onCancelDownload(manifest.fileId);
                            }}
                          >
                            Cancel
                          </button>
                        ) : null}

                        {saveReady ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              void onSaveFile(manifest).catch((err: unknown) => {
                                setActionError(
                                  err instanceof Error
                                    ? err.message
                                    : "Failed to save file",
                                );
                              });
                            }}
                          >
                            Save File
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
