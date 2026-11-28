import type { ReactElement, RefObject } from "react";
import {
  Button,
  CountBadge,
  Icon,
  StatusDot,
} from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { RoomMeshConnectionStatus } from "../../state/room-list-vm.ts";
import { formatRoomFingerprint } from "../../utils/format.ts";
import { AppTopBar } from "../shell/AppTopBar.tsx";

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
  readonly messageCount: number;
  readonly railOpen: boolean;
  readonly sidebarExpanded: boolean;
  readonly moreMenuOpen: boolean;
  readonly railToggleRef?: RefObject<HTMLButtonElement | null>;
  readonly sidebarToggleRef?: RefObject<HTMLButtonElement | null>;
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
  messageCount,
  railOpen,
  sidebarExpanded,
  moreMenuOpen,
  railToggleRef,
  sidebarToggleRef,
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

  const dotStatus =
    badgeState === "connected"
      ? "online"
      : badgeState === "detached"
        ? "warning"
        : "offline";

  const roomsLabel = t("room.roomsToggle", { count: roomCount });
  const drawerLabel = t("room.drawerToggle", {
    peers: peerCount,
    files: fileCount,
  });

  const sidebarToggle = (
    <Button
      ref={sidebarToggleRef}
      variant="secondary"
      size="sm"
      className="sidebar-toggle-btn"
      testId="sidebar-drawer-toggle"
      aria-label={drawerLabel}
      aria-expanded={sidebarExpanded}
      aria-controls="room-sidebar"
      onClick={onToggleSidebar}
    >
      <span className="top-bar-btn-icon" aria-hidden="true">
        <Icon name="users" size={16} />
      </span>
      <span className="top-bar-btn-count" aria-hidden="true">
        {peerCount}
      </span>
      <span className="top-bar-btn-text">{drawerLabel}</span>
    </Button>
  );

  return (
    <AppTopBar
      username={username}
      menuOpen={moreMenuOpen}
      onMenuOpenChange={onMoreMenuOpenChange}
      onLeaveRoom={onLeaveRoom}
      leaveRoomMessageCount={messageCount}
      onSignOut={onSignOut}
      onWipeAndSignOut={onWipeAndSignOut}
      onActionError={onActionError}
      menuToggleTestId="room-more-menu-toggle"
      menuTestId="room-more-menu"
      rightSlot={sidebarToggle}
    >
      <Button
        ref={railToggleRef}
        variant="secondary"
        size="sm"
        className="drawer-toggle-btn rooms-toggle-btn"
        testId="rooms-drawer-toggle"
        aria-label={roomsLabel}
        aria-expanded={railOpen}
        aria-controls="room-list-rail"
        onClick={onToggleRail}
      >
        <span className="top-bar-btn-icon" aria-hidden="true">
          <Icon name="menu" size={16} />
        </span>
        <span className="top-bar-btn-text">{roomsLabel}</span>
        {totalUnreadCount > 0 ? (
          <CountBadge
            value={totalUnreadCount}
            label={`${totalUnreadCount}`}
            testId="rooms-total-unread"
            className="top-bar-unread-dot"
          />
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
        className="room-chip connection-badge-chip"
        title={badgeHint}
      >
        <StatusDot status={dotStatus} />
        <span className="connection-badge-label">{badgeLabel}</span>
      </div>
    </AppTopBar>
  );
}
