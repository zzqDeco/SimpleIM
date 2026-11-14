import type { ReactElement } from "react";
import { Button, StatusIcon } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { RoomMeshConnectionStatus } from "../../state/room-list-vm.ts";
import { formatRoomFingerprint } from "../../utils/format.ts";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

export interface RoomTopBarProps {
  readonly roomIdPrefix: string;
  readonly roomAlias: string | null;
  readonly connectionStatus: RoomMeshConnectionStatus;
  readonly centerConnected: boolean;
  readonly username: string;
  readonly roomCount: number;
  readonly peerCount: number;
  readonly fileCount: number;
  readonly railOpen: boolean;
  readonly sidebarOpen: boolean;
  readonly onToggleRail: () => void;
  readonly onToggleSidebar: () => void;
  readonly onLeaveRoom: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  readonly onWipeAndSignOut: () => Promise<void>;
}

export function RoomTopBar({
  roomIdPrefix,
  roomAlias,
  connectionStatus,
  centerConnected,
  username,
  roomCount,
  peerCount,
  fileCount,
  railOpen,
  sidebarOpen,
  onToggleRail,
  onToggleSidebar,
  onLeaveRoom,
  onSignOut,
  onWipeAndSignOut,
}: RoomTopBarProps): ReactElement {
  const { t } = useI18n();
  const fingerprint = formatRoomFingerprint(roomIdPrefix);

  const badgeState =
    connectionStatus === "standby"
      ? "standby"
      : centerConnected
        ? "connected"
        : "detached";

  const badgeHint =
    badgeState === "connected"
      ? t("room.status.onlineHint")
      : badgeState === "standby"
        ? t("room.status.standbyHint")
        : t("room.status.detachedHint");

  const badgeLabel =
    badgeState === "connected"
      ? t("room.status.online")
      : badgeState === "standby"
        ? t("room.status.standby")
        : t("room.status.detached");

  return (
    <header className="top-bar">
      <div className="top-bar-group">
        <div className="brand-prompt">
          <span className="brand-prompt-sigil" aria-hidden="true">
            ❯
          </span>
          <span>{t("app.title")}</span>
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="drawer-toggle-btn"
          testId="rooms-drawer-toggle"
          aria-expanded={railOpen}
          aria-controls="room-list-rail"
          onClick={onToggleRail}
        >
          {t("room.roomsToggle", { count: roomCount })}
        </Button>

        <span className="room-chip">
          <span className="room-chip-strong">{roomAlias ?? fingerprint}</span>
          {roomAlias ? <span>{fingerprint}</span> : null}
        </span>

        <div
          role="status"
          aria-live="polite"
          data-testid="connection-badge"
          data-connection-state={badgeState}
          className="room-chip"
          title={badgeHint}
        >
          <StatusIcon
            status={badgeState === "connected" ? "online" : "offline"}
          />
          <span>{badgeLabel}</span>
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
          variant="secondary"
          size="sm"
          testId="sign-out-button"
          onClick={() => void onSignOut()}
        >
          {t("room.signOut")}
        </Button>

        <Button
          variant="danger"
          size="sm"
          testId="wipe-vault-button"
          onClick={() => void onWipeAndSignOut()}
        >
          {t("room.wipeSignOut")}
        </Button>
      </div>
    </header>
  );
}
