import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

export interface RoomMoreMenuProps {
  readonly open: boolean;
  readonly username: string;
  readonly messageCount: number;
  readonly onOpenChange: (next: boolean) => void;
  readonly onLeaveRoom: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  readonly onWipeAndSignOut: () => Promise<void>;
  readonly onActionError?: (err: unknown) => void;
}

type PendingDestructiveConfirm = "none" | "leave" | "wipe";

export function RoomMoreMenu({
  open,
  username,
  messageCount,
  onOpenChange,
  onLeaveRoom,
  onSignOut,
  onWipeAndSignOut,
  onActionError,
}: RoomMoreMenuProps): ReactElement {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pendingConfirm, setPendingConfirm] =
    useState<PendingDestructiveConfirm>("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPendingConfirm("none");
      return;
    }

    const handlePointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        onOpenChange(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onOpenChange(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  const runAction = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onOpenChange(false);
    } catch (err) {
      onActionError?.(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="more-menu-root">
      <Button
        variant="secondary"
        size="sm"
        testId="room-more-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("room.moreMenuAria")}
        onClick={() => onOpenChange(!open)}
      >
        <span aria-hidden="true">⋯</span>
        <span className="more-menu-btn-label">{t("room.moreMenuLabel")}</span>
      </Button>

      {open ? (
        <div
          className="more-menu-popover"
          data-testid="room-more-menu"
          role="menu"
          aria-label={t("room.moreMenuAria")}
        >
          <div className="more-menu-account">@{username}</div>

          <div className="more-menu-prefs">
            <PreferenceControls />
          </div>

          <div className="more-menu-divider" role="separator" />

          <div className="more-menu-actions">
            {pendingConfirm === "leave" ? (
              <div
                className="more-menu-wipe-confirm"
                data-testid="leave-room-confirm-panel"
              >
                <p className="more-menu-wipe-warning">
                  {t("room.leaveConfirmTitle", { count: messageCount })}
                </p>
                <div className="more-menu-wipe-buttons">
                  <Button
                    variant="secondary"
                    size="sm"
                    testId="leave-room-cancel-button"
                    disabled={busy}
                    onClick={() => setPendingConfirm("none")}
                  >
                    {t("room.leaveCancel")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    testId="leave-room-confirm-button"
                    disabled={busy}
                    onClick={() => void runAction(onLeaveRoom)}
                  >
                    {t("room.leaveConfirmAction")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="more-menu-action-btn"
                testId="leave-room-button"
                disabled={busy}
                onClick={() => setPendingConfirm("leave")}
              >
                {t("room.leave")}
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              className="more-menu-action-btn"
              testId="sign-out-button"
              disabled={busy}
              onClick={() => void runAction(onSignOut)}
            >
              {t("room.signOut")}
            </Button>
          </div>

          <div className="more-menu-divider" role="separator" />

          {pendingConfirm === "wipe" ? (
            <div
              className="more-menu-wipe-confirm"
              data-testid="wipe-vault-confirm-panel"
            >
              <p className="more-menu-wipe-warning">
                {t("room.wipeConfirmTitle")}
              </p>
              <div className="more-menu-wipe-buttons">
                <Button
                  variant="secondary"
                  size="sm"
                  testId="wipe-vault-cancel-button"
                  disabled={busy}
                  onClick={() => setPendingConfirm("none")}
                >
                  {t("room.wipeCancel")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  testId="wipe-vault-confirm-button"
                  disabled={busy}
                  onClick={() => void runAction(onWipeAndSignOut)}
                >
                  {t("room.wipeConfirmAction")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="danger"
              size="sm"
              className="more-menu-action-btn"
              testId="wipe-vault-button"
              disabled={busy}
              onClick={() => setPendingConfirm("wipe")}
            >
              {t("room.wipeSignOut")}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
