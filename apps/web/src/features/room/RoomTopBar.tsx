import type { ReactElement } from "react";
import { Button, StatusIcon } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { formatRoomFingerprint } from "../../utils/format.ts";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

export interface RoomTopBarProps {
  readonly roomIdPrefix: string;
  readonly centerConnected: boolean;
  readonly username: string;
  readonly peerCount: number;
  readonly fileCount: number;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly onLeaveRoom: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
}

export function RoomTopBar({
  roomIdPrefix,
  centerConnected,
  username,
  peerCount,
  fileCount,
  sidebarOpen,
  onToggleSidebar,
  onLeaveRoom,
  onSignOut,
}: RoomTopBarProps): ReactElement {
  const { t } = useI18n();

  return (
    <header className="top-bar">
      <div className="top-bar-group">
        <div className="brand-prompt">
          <span className="brand-prompt-sigil" aria-hidden="true">
            ❯
          </span>
          <span>{t("app.title")}</span>
        </div>

        <span className="room-chip">
          <span className="room-chip-strong">
            {formatRoomFingerprint(roomIdPrefix)}
          </span>
        </span>

        <div
          role="status"
          aria-live="polite"
          data-testid="connection-badge"
          data-connection-state={centerConnected ? "connected" : "detached"}
          className="room-chip"
          title={
            centerConnected
              ? t("room.status.onlineHint")
              : t("room.status.detachedHint")
          }
        >
          <StatusIcon status={centerConnected ? "online" : "offline"} />
          <span>
            {centerConnected
              ? t("room.status.online")
              : t("room.status.detached")}
          </span>
        </div>
      </div>

      <div className="top-bar-group">
        <Button
          variant="secondary"
          size="sm"
          className="drawer-toggle-btn"
          aria-expanded={sidebarOpen}
          aria-controls="room-sidebar"
          onClick={onToggleSidebar}
        >
          {t("room.drawerToggle", { peers: peerCount, files: fileCount })}
        </Button>

        <span className="user-handle">@{username}</span>

        <PreferenceControls />

        <Button
          variant="secondary"
          size="sm"
          testId="leave-room-button"
          onClick={() => void onLeaveRoom()}
        >
          {t("room.leave")}
        </Button>

        <Button
          variant="danger"
          size="sm"
          testId="sign-out-button"
          onClick={() => void onSignOut()}
        >
          {t("room.signOut")}
        </Button>
      </div>
    </header>
  );
}
