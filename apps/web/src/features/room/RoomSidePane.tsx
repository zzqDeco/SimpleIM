import type { ReactElement } from "react";
import type { FileManifest } from "@simpleim/contracts";
import type {
  SwarmTransferProgress,
  VerifiedPeerInfo,
} from "@simpleim/peer-core";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { FileListSection } from "./FileListSection.tsx";
import { PeerListSection } from "./PeerListSection.tsx";

export interface RoomSidePaneProps {
  readonly open: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly localPeerId: string;
  readonly canSaveFile: (fileId: string) => boolean;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly onActionError: (err: unknown) => void;
}

export function RoomSidePane({
  open,
  peers,
  files,
  transfers,
  localPeerId,
  canSaveFile,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  onActionError,
}: RoomSidePaneProps): ReactElement {
  const { t } = useI18n();

  return (
    <aside
      id="room-sidebar"
      className={open ? "side-pane side-pane-open" : "side-pane"}
      aria-label={t("room.sidebarAria")}
    >
      <PeerListSection peers={peers} />
      <FileListSection
        files={files}
        transfers={transfers}
        localPeerId={localPeerId}
        canSaveFile={canSaveFile}
        onDownloadFile={onDownloadFile}
        onCancelDownload={onCancelDownload}
        onSaveFile={onSaveFile}
        onActionError={onActionError}
      />
    </aside>
  );
}
