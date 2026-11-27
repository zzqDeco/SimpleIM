import type { ReactElement } from "react";
import { Button, StatusIcon } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { RoomMeshConnectionStatus } from "../../state/room-list-vm.ts";
import { formatRoomFingerprint } from "../../utils/format.ts";
import { RoomMoreMenu } from "./RoomMoreMenu.tsx";

export interface RoomTopBarProps {
  readonly roomIdPrefix: string;
  readonly roomAlias: string | null;
  readonly connectionStatus: RoomMeshConnectionStatus;
  readonly centerConnected: boolean;
  readonly username: string;
  readonly roomCount: number;
  readonly totalUnreadCount: number;
  readonly peerCount: number;
  readonly fileCount: number;
  readonly railOpen: boolean;
  readonly sidebarExpanded: boolean;
  readonly moreMenuOpen: boolean;
  readonly onMoreMenuOpenChange: (next: boolean) => void;
  readonly onToggleRail: () => void;
  readonly onToggleSidebar: () => void;
  readonly onLeaveRoom: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  readonly onWipeAndSignOut: () => Promise<void>;
  readonly onActionError?: (err: unknown) => void;
}

export function RoomTopBar({
  roomIdPrefix,
  roomAlias,
  connectionStatus,
  centerConnected,
  username,
  roomCount,
  totalUnreadCount,
  peerCount,
  fileCount,
  railOpen,
  sidebarExpanded,
  moreMenuOpen,
  onMoreMenuOpenChange,
  onToggleRail,
  onToggleSidebar,
  onLeaveRoom,
  onSignOut,
  onWipeAndSignOut,
  onActionError,
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
      <div className="top-bar-group top-bar-left">
        <div className="brand-prompt">
          <span className="brand-prompt-sigil" aria-hidden="true">
            ❯
          </span>
          <span>{t("app.title")}</span>
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="drawer-toggle-btn rooms-toggle-btn"
          testId="rooms-drawer-toggle"
          aria-expanded={railOpen}
          aria-controls="room-list-rail"
          onClick={onToggleRail}
        >
          <span>{t("room.roomsToggle", { count: roomCount })}</span>
          {totalUnreadCount > 0 ? (
            <span
              className="top-bar-unread-dot"
              data-testid="rooms-total-unread"
            >
              {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
            </span>
          ) : null}
        </Button>

        <span className="room-chip room-chip-title">
          <span className="room-chip-strong">{roomAlias ?? fingerprint}</span>
          {roomAlias ? (
            <span className="room-chip-hash">{fingerprint}</span>
          ) : null}
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
          <span className="connection-badge-label">{badgeLabel}</span>
        </div>
      </div>

      <div className="top-bar-group top-bar-right">
        <Button
          variant="secondary"
          size="sm"
          className="sidebar-toggle-btn"
          testId="sidebar-drawer-toggle"
          aria-expanded={sidebarExpanded}
          aria-controls="room-sidebar"
          onClick={onToggleSidebar}
        >
          {t("room.drawerToggle", { peers: peerCount, files: fileCount })}
        </Button>

        <RoomMoreMenu
          open={moreMenuOpen}
          username={username}
          onOpenChange={onMoreMenuOpenChange}
          onLeaveRoom={onLeaveRoom}
          onSignOut={onSignOut}
          onWipeAndSignOut={onWipeAndSignOut}
          onActionError={onActionError}
        />
      </div>
    </header>
  );
}
