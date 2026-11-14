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
import type { SecurityEvent } from "../../hooks/useRoomSession.ts";
import { formatAppFailure } from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { MessageTranscript } from "./MessageTranscript.tsx";
import { PromptComposer } from "./PromptComposer.tsx";
import { RoomSidePane } from "./RoomSidePane.tsx";
import { RoomTopBar } from "./RoomTopBar.tsx";

export interface RoomScreenProps {
  readonly user: UserProfile;
  readonly localPeerId: string;
  readonly roomIdPrefix: string;
  readonly centerConnected: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly messages: readonly ChatMessageEnvelope[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
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
}

export function RoomScreen({
  user,
  localPeerId,
  roomIdPrefix,
  centerConnected,
  peers,
  messages,
  files,
  transfers,
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
}: RoomScreenProps): ReactElement {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const composer = usePromptComposer({ onSendMessage });

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
        centerConnected={centerConnected}
        username={user.username}
        peerCount={peers.length}
        fileCount={files.length}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onLeaveRoom={onLeaveRoom}
        onSignOut={onSignOut}
      />

      <div className="room-grid">
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
