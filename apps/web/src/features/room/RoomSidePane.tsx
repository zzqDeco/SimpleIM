import { useEffect, useRef, type ReactElement } from "react";
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
  readonly inert?: boolean;
  readonly peers: readonly VerifiedPeerInfo[];
  readonly files: readonly FileManifest[];
  readonly transfers: ReadonlyMap<string, SwarmTransferProgress>;
  readonly localPeerId: string;
  readonly canSaveFile: (fileId: string) => boolean;
  readonly onDownloadFile: (fileId: string) => Promise<void>;
  readonly onCancelDownload: (fileId: string) => Promise<void>;
  readonly onSaveFile: (manifest: FileManifest) => Promise<void>;
  readonly onLocateFile?: (fileId: string) => void;
  readonly onActionError: (err: unknown) => void;
}

export function RoomSidePane({
  open,
  inert = false,
  peers,
  files,
  transfers,
  localPeerId,
  canSaveFile,
  onDownloadFile,
  onCancelDownload,
  onSaveFile,
  onLocateFile,
  onActionError,
}: RoomSidePaneProps): ReactElement {
  const { t } = useI18n();
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    el.inert = inert;
  }, [inert]);

  return (
    <aside
      ref={asideRef}
      id="room-sidebar"
      className={open ? "side-pane side-pane-open" : "side-pane"}
      aria-label={t("room.sidebarAria")}
      aria-hidden={inert || undefined}
      tabIndex={-1}
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
        onLocateFile={onLocateFile}
        onActionError={onActionError}
      />
    </aside>
  );
}
