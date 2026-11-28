import type { ReactElement, ReactNode } from "react";
import { BrandMark } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { AccountMenu } from "./AccountMenu.tsx";

export interface AppTopBarProps {
  readonly username?: string;
  readonly menuOpen?: boolean;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onLeaveRoom?: () => Promise<void>;
  readonly leaveRoomMessageCount?: number;
  readonly onSignOut?: () => Promise<void>;
  readonly onWipeAndSignOut?: () => Promise<void>;
  readonly onActionError?: (err: unknown) => void;
  readonly menuToggleTestId?: string;
  readonly menuTestId?: string;
  readonly rightSlot?: ReactNode;
  readonly children?: ReactNode;
}

export function AppTopBar({
  username,
  menuOpen,
  onMenuOpenChange,
  onLeaveRoom,
  leaveRoomMessageCount,
  onSignOut,
  onWipeAndSignOut,
  onActionError,
  menuToggleTestId,
  menuTestId,
  rightSlot,
  children,
}: AppTopBarProps): ReactElement {
  const { t } = useI18n();

  return (
    <header className="top-bar">
      <div className="top-bar-group top-bar-left">
        <div className="brand-prompt">
          <BrandMark className="brand-prompt-sigil" />
          <span className="brand-prompt-title">{t("app.title")}</span>
        </div>
        {children}
      </div>

      <div className="top-bar-group top-bar-right">
        {rightSlot}
        <AccountMenu
          username={username}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          onLeaveRoom={onLeaveRoom}
          leaveRoomMessageCount={leaveRoomMessageCount}
          onSignOut={onSignOut}
          onWipeAndSignOut={onWipeAndSignOut}
          onActionError={onActionError}
          toggleTestId={menuToggleTestId}
          menuTestId={menuTestId}
        />
      </div>
    </header>
  );
}
