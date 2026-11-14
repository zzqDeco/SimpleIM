import { useCallback, useState, type ReactElement } from "react";
import type {
  ChatMessageEnvelope,
  FileManifest,
  UserProfile,
} from "@simpleim/contracts";
import type {
  SwarmTransferProgress,
  VerifiedPeerInfo,
} from "@simpleim/peer-core";
import { NoticeBanner } from "../../design-system/index.ts";
import { useFileDropzone } from "../../hooks/useFileDropzone.ts";
import { usePromptComposer } from "../../hooks/usePromptComposer.ts";
import type { JoinPhase, SecurityEvent } from "../../hooks/useRoomSession.ts";
import {
  formatAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type {
  RoomMeshConnectionStatus,
  RoomSummaryItem,
} from "../../state/room-list-vm.ts";
import { MessageTranscript } from "./MessageTranscript.tsx";
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
  readonly onShareFiles: (files: File[]) => Promise<void>;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly canSaveFile: (fileId: string) => boolean;
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
  onShareFiles,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  canSaveFile,
  onLeaveRoom,
  onSignOut,
  onWipeAndSignOut,
}: RoomScreenProps): ReactElement {
  const { t } = useI18n();
  const [railOpen, setRailOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const composer = usePromptComposer({
    roomKey: selectedRoomId,
    onSendMessage,
  });

  const shareSelectedFiles = useCallback(
    (selected: File[]): void => {
      composer.setActionFailure(null);
      void onShareFiles(selected).catch(composer.reportActionError);
    },
    [composer, onShareFiles],
  );

  const dropzone = useFileDropzone({
    onFilesDropped: shareSelectedFiles,
  });

  const securityText =
    securityEvent === null
      ? null
      : securityEvent.kind === "peer_rejected"
        ? t("security.peerRejected", { reason: securityEvent.reason })
        : formatAppFailure(securityEvent.failure, t);

  return (
    <div className="room-shell">
      <RoomTopBar
        roomIdPrefix={roomIdPrefix}
        roomAlias={selectedRoomAlias}
        connectionStatus={selectedRoomStatus}
        centerConnected={centerConnected}
        username={user.username}
        roomCount={rooms.length}
        peerCount={peers.length}
        fileCount={files.length}
        railOpen={railOpen}
        sidebarOpen={sidebarOpen}
        onToggleRail={() => {
          setSidebarOpen(false);
          setRailOpen((v) => !v);
        }}
        onToggleSidebar={() => {
          setRailOpen(false);
          setSidebarOpen((v) => !v);
        }}
        onLeaveRoom={onLeaveRoom}
        onSignOut={onSignOut}
        onWipeAndSignOut={onWipeAndSignOut}
      />

      <div className="room-grid">
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
            messages={messages}
            localPeerId={localPeerId}
            currentUserId={user.id}
            onReply={composer.selectReplyTarget}
          />

          <PromptComposer
            composer={composer}
            onAttachFiles={shareSelectedFiles}
          />
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
          onActionError={composer.reportActionError}
        />
      </div>
    </div>
  );
}
