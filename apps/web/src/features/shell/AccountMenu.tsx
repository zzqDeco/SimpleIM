import { useEffect, useState, type ReactElement } from "react";
import {
  ConfirmPanel,
  IconButton,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
} from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

export interface AccountMenuProps {
  readonly username?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onLeaveRoom?: () => Promise<void>;
  readonly leaveRoomMessageCount?: number;
  readonly onSignOut?: () => Promise<void>;
  readonly onWipeAndSignOut?: () => Promise<void>;
  readonly onActionError?: (err: unknown) => void;
  readonly toggleTestId?: string;
  readonly menuTestId?: string;
}

type PendingDestructiveConfirm = "none" | "leave" | "wipe";

export function AccountMenu({
  username,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onLeaveRoom,
  leaveRoomMessageCount = 0,
  onSignOut,
  onWipeAndSignOut,
  onActionError,
  toggleTestId = "account-menu-toggle",
  menuTestId = "account-menu",
}: AccountMenuProps): ReactElement {
  const { t } = useI18n();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] =
    useState<PendingDestructiveConfirm>("none");
  const [busy, setBusy] = useState(false);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    controlledOnOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) {
      setPendingConfirm("none");
    }
  }, [open]);

  const runAction = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (err) {
      onActionError?.(err);
    } finally {
      setBusy(false);
    }
  };

  const hasAccountActions = Boolean(onLeaveRoom || onSignOut);
  const hasWipeAction = Boolean(onWipeAndSignOut);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={t("room.moreMenuAria")}
      testId={menuTestId}
      trigger={(triggerProps) => (
        <IconButton
          ref={triggerProps.ref}
          icon="ellipsis"
          size="sm"
          variant="secondary"
          label={t("room.moreMenuAria")}
          testId={toggleTestId}
          aria-expanded={triggerProps["aria-expanded"]}
          aria-haspopup={triggerProps["aria-haspopup"]}
          aria-controls={triggerProps["aria-controls"]}
          onClick={triggerProps.onClick}
        />
      )}
    >
      {username ? (
        <div className="more-menu-account">@{username}</div>
      ) : null}

      <MenuSection className="more-menu-prefs">
        <PreferenceControls />
      </MenuSection>

      {hasAccountActions ? (
        <>
          <MenuSeparator />
          <MenuSection className="more-menu-actions">
            {onLeaveRoom ? (
              pendingConfirm === "leave" ? (
                <ConfirmPanel
                  title={t("room.leaveConfirmTitle", {
                    count: leaveRoomMessageCount,
                  })}
                  confirmLabel={t("room.leaveConfirmAction")}
                  cancelLabel={t("room.leaveCancel")}
                  tone="danger"
                  busy={busy}
                  testId="leave-room-confirm-panel"
                  confirmTestId="leave-room-confirm-button"
                  cancelTestId="leave-room-cancel-button"
                  onCancel={() => setPendingConfirm("none")}
                  onConfirm={() => void runAction(onLeaveRoom)}
                />
              ) : (
                <MenuItem
                  icon="door-open"
                  disabled={busy}
                  closeOnSelect={false}
                  testId="leave-room-button"
                  onSelect={() => setPendingConfirm("leave")}
                >
                  {t("room.leave")}
                </MenuItem>
              )
            ) : null}

            {onSignOut ? (
              <MenuItem
                icon="log-out"
                disabled={busy}
                closeOnSelect={false}
                testId="sign-out-button"
                onSelect={() => void runAction(onSignOut)}
              >
                {onLeaveRoom ? t("room.signOut") : t("lobby.signOut")}
              </MenuItem>
            ) : null}
          </MenuSection>
        </>
      ) : null}

      {hasWipeAction && onWipeAndSignOut ? (
        <>
          <MenuSeparator />
          <MenuSection>
            {pendingConfirm === "wipe" ? (
              <ConfirmPanel
                title={t("room.wipeConfirmTitle")}
                confirmLabel={t("room.wipeConfirmAction")}
                cancelLabel={t("room.wipeCancel")}
                tone="danger"
                busy={busy}
                testId="wipe-vault-confirm-panel"
                confirmTestId="wipe-vault-confirm-button"
                cancelTestId="wipe-vault-cancel-button"
                onCancel={() => setPendingConfirm("none")}
                onConfirm={() => void runAction(onWipeAndSignOut)}
              />
            ) : (
              <MenuItem
                icon="trash-2"
                tone="danger"
                disabled={busy}
                closeOnSelect={false}
                testId="wipe-vault-button"
                onSelect={() => setPendingConfirm("wipe")}
              >
                {onLeaveRoom ? t("room.wipeSignOut") : t("lobby.wipeSignOut")}
              </MenuItem>
            )}
          </MenuSection>
        </>
      ) : null}
    </Menu>
  );
}
