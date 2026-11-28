import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type {
  ChatMessageEnvelope,
  FileManifest,
  UserProfile,
} from "@simpleim/contracts";
import type {
  ChatDeliveryStatus,
  SwarmTransferProgress,
  VerifiedPeerInfo,
} from "@simpleim/peer-core";
import { NoticeBanner } from "../../design-system/index.ts";
import { useFileDropzone } from "../../hooks/useFileDropzone.ts";
import { usePromptComposer } from "../../hooks/usePromptComposer.ts";
import type { JoinPhase, SecurityEvent } from "../../hooks/useRoomSession.ts";
import { useRoomViewportLock } from "../../hooks/useRoomViewportLock.ts";
import {
  formatAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type {
  RoomMeshConnectionStatus,
  RoomSummaryItem,
} from "../../state/room-list-vm.ts";
import {
  MessageTranscript,
  type TranscriptLocateRequest,
} from "./MessageTranscript.tsx";
import { PromptComposer } from "./PromptComposer.tsx";
import { RoomListRail } from "./RoomListRail.tsx";
import { RoomSidePane } from "./RoomSidePane.tsx";
import { RoomTopBar } from "./RoomTopBar.tsx";

export interface RoomScreenProps {
  readonly user: UserProfile;
  readonly localPeerId: string;
  readonly rooms: readonly RoomSummaryItem[];
  readonly selectedRoomId: string | null;
  readonly selectedRoomAlias: string | null;
  readonly selectedRoomStatus: RoomMeshConnectionStatus;
  readonly roomIdPrefix: string;
  readonly centerConnected: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly messages: readonly ChatMessageEnvelope[];
  readonly deliveryStates: ReadonlyMap<string, ChatDeliveryStatus>;
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly joinPhase: JoinPhase;
  readonly joinFailure: AppFailure | null;
  readonly onClearJoinFailure: () => void;
  readonly onJoinRoom: (passphrase: string, alias?: string) => Promise<boolean>;
  readonly onSelectRoom: (roomId: string) => Promise<void>;
  readonly onRenameRoomAlias: (
    roomId: string,
    alias: string | null,
  ) => Promise<void>;
  readonly onTogglePinRoom: (roomId: string) => Promise<void>;
  readonly securityEvent: SecurityEvent | null;
  readonly onDismissSecurityEvent: () => void;
  readonly onSendMessage: (
    body: string,
    replyToMsgId: string | null,
  ) => Promise<void>;
  readonly onRetryMessage: (msgId: string) => Promise<void>;
  readonly onShareFiles: (files: File[]) => Promise<void>;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly canSaveFile: (fileId: string) => boolean;
  readonly onReadFileBlob?: (
    fileId: string,
    mimeType: string,
  ) => Promise<Blob | null>;
  readonly onLeaveRoom: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  readonly onWipeAndSignOut: () => Promise<void>;
}

export function RoomScreen({
  user,
  localPeerId,
  rooms,
  selectedRoomId,
  selectedRoomAlias,
  selectedRoomStatus,
  roomIdPrefix,
  centerConnected,
  peers,
  messages,
  deliveryStates,
  files,
  transfers,
  joinPhase,
  joinFailure,
  onClearJoinFailure,
  onJoinRoom,
  onSelectRoom,
  onRenameRoomAlias,
  onTogglePinRoom,
  securityEvent,
  onDismissSecurityEvent,
  onSendMessage,
  onRetryMessage,
  onShareFiles,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  canSaveFile,
  onReadFileBlob,
  onLeaveRoom,
  onSignOut,
  onWipeAndSignOut,
}: RoomScreenProps): ReactElement {
  const { t } = useI18n();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const locateNonceRef = useRef(0);
  const [railOpen, setRailOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia("(max-width: 1024px)").matches;
  });
  const [locateRequest, setLocateRequest] =
    useState<TranscriptLocateRequest | null>(null);

  useRoomViewportLock(shellRef);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mq = window.matchMedia("(max-width: 1024px)");
    const sync = (): void => {
      setIsCompactViewport(mq.matches);
      if (!mq.matches) {
        setRailOpen(false);
        setSidebarOpen(false);
      }
    };
    sync();
    mq.addEventListener("change", sync);
    return () => {
      mq.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    setMoreMenuOpen(false);
  }, [selectedRoomId]);

  const closeDrawers = useCallback((): void => {
    setRailOpen(false);
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!railOpen && !sidebarOpen) {
      return;
    }
    const handleKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" && !ev.defaultPrevented) {
        ev.preventDefault();
        closeDrawers();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDrawers, railOpen, sidebarOpen]);

  const totalUnreadCount = useMemo(
    () => rooms.reduce((sum, item) => sum + item.unreadCount, 0),
    [rooms],
  );

  const composer = usePromptComposer({
    roomKey: selectedRoomId,
    onSendMessage,
    onShareFiles,
  });

  const dropzone = useFileDropzone({
    onFilesDropped: composer.stageFiles,
  });

  const handleLocateFile = useCallback((fileId: string): void => {
    setSidebarOpen(false);
    setMoreMenuOpen(false);
    setLocateRequest({
      itemKey: `file:${fileId}`,
      nonce: ++locateNonceRef.current,
    });
  }, []);

  const handleToggleRail = useCallback((): void => {
    setSidebarOpen(false);
    setMoreMenuOpen(false);
    setRailOpen((v) => !v);
  }, []);

  const handleToggleSidebar = useCallback((): void => {
    setMoreMenuOpen(false);
    if (isCompactViewport) {
      setRailOpen(false);
      setSidebarOpen((v) => !v);
    } else {
      setDesktopSidebarOpen((v) => !v);
    }
  }, [isCompactViewport]);

  const handleMoreMenuOpenChange = useCallback((next: boolean): void => {
    if (next) {
      setRailOpen(false);
      setSidebarOpen(false);
    }
    setMoreMenuOpen(next);
  }, []);

  const securityText =
    securityEvent === null
      ? null
      : securityEvent.kind === "peer_rejected"
        ? t("security.peerRejected", { reason: securityEvent.reason })
        : securityEvent.kind === "ice_failed"
          ? t("security.iceFailed")
          : formatAppFailure(securityEvent.failure, t);

  return (
    <div ref={shellRef} className="room-shell">
      <RoomTopBar
        roomIdPrefix={roomIdPrefix}
        roomAlias={selectedRoomAlias}
        connectionStatus={selectedRoomStatus}
        centerConnected={centerConnected}
        username={user.username}
        roomCount={rooms.length}
        totalUnreadCount={totalUnreadCount}
        peerCount={peers.length}
        fileCount={files.length}
        messageCount={messages.length}
        railOpen={railOpen}
        sidebarExpanded={isCompactViewport ? sidebarOpen : desktopSidebarOpen}
        moreMenuOpen={moreMenuOpen}
        onMoreMenuOpenChange={handleMoreMenuOpenChange}
        onToggleRail={handleToggleRail}
        onToggleSidebar={handleToggleSidebar}
        onLeaveRoom={onLeaveRoom}
        onSignOut={onSignOut}
        onWipeAndSignOut={onWipeAndSignOut}
        onActionError={composer.reportActionError}
      />

      <div
        className={`room-grid ${!desktopSidebarOpen ? "room-grid-sidebar-collapsed" : ""}`}
      >
        {railOpen || sidebarOpen ? (
          <div
            className="drawer-backdrop"
            data-testid="drawer-backdrop"
            aria-hidden="true"
            onClick={closeDrawers}
          />
        ) : null}
        <RoomListRail
          open={railOpen}
          rooms={rooms}
          selectedRoomId={selectedRoomId}
          joinPhase={joinPhase}
          joinFailure={joinFailure}
          onClearJoinFailure={onClearJoinFailure}
          onJoinRoom={onJoinRoom}
          onSelectRoom={onSelectRoom}
          onRenameRoomAlias={onRenameRoomAlias}
          onTogglePinRoom={onTogglePinRoom}
          onCloseMobileRail={() => setRailOpen(false)}
        />

        <main
          className="transcript-column"
          onDragEnter={dropzone.onDragEnter}
          onDragOver={dropzone.onDragOver}
          onDragLeave={dropzone.onDragLeave}
          onDrop={dropzone.onDrop}
        >
          {dropzone.dragActive ? (
            <div className="drop-mask" aria-hidden="true">
              <span className="drop-mask-label">{t("room.dropFiles")}</span>
            </div>
          ) : null}

          {securityText || composer.actionFailure ? (
            <div className="transcript-alerts">
              {securityText ? (
                <NoticeBanner
                  tone="warning"
                  dismissLabel={t("room.dismiss")}
                  onDismiss={onDismissSecurityEvent}
                >
                  {securityText}
                </NoticeBanner>
              ) : null}

              {composer.actionFailure ? (
                <NoticeBanner tone="error">
                  {formatAppFailure(composer.actionFailure, t)}
                </NoticeBanner>
              ) : null}
            </div>
          ) : null}

          <MessageTranscript
            roomId={selectedRoomId}
            messages={messages}
            files={files}
            transfers={transfers}
            canSaveFile={canSaveFile}
            onDownloadFile={onDownloadFile}
            onCancelDownload={onCancelDownload}
            onSaveFile={onSaveFile}
            onReadFileBlob={onReadFileBlob}
            onActionError={composer.reportActionError}
            deliveryStates={deliveryStates}
            localPeerId={localPeerId}
            currentUserId={user.id}
            onReply={composer.selectReplyTarget}
            onRetryMessage={(msgId) => {
              void onRetryMessage(msgId).catch(composer.reportActionError);
            }}
            locateRequest={locateRequest}
          />

          <PromptComposer composer={composer} />
        </main>

        <RoomSidePane
          open={sidebarOpen}
          peers={peers}
          files={files}
          transfers={transfers}
          localPeerId={localPeerId}
          canSaveFile={canSaveFile}
          onDownloadFile={onDownloadFile}
          onCancelDownload={onCancelDownload}
          onSaveFile={onSaveFile}
          onLocateFile={handleLocateFile}
          onActionError={composer.reportActionError}
        />
      </div>
    </div>
  );
}
