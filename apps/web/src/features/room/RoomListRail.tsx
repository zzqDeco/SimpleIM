import { useState, type FormEvent, type ReactElement } from "react";
import {
  Button,
  NoticeBanner,
  StatusIcon,
  TextField,
} from "../../design-system/index.ts";
import type { JoinPhase } from "../../hooks/useRoomSession.ts";
import {
  formatAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { RoomSummaryItem } from "../../state/room-list-vm.ts";
import {
  MAX_ROOM_ALIAS_CHARS,
  validateRoomPassphrase,
} from "../../state/validation.ts";
import { formatRoomFingerprint } from "../../utils/format.ts";

export interface RoomListRailProps {
  readonly open: boolean;
  readonly rooms: readonly RoomSummaryItem[];
  readonly selectedRoomId: string | null;
  readonly joinPhase: JoinPhase;
  readonly joinFailure: AppFailure | null;
  readonly onClearJoinFailure: () => void;
  readonly onJoinRoom: (passphrase: string, alias?: string) => Promise<boolean>;
  readonly onSelectRoom: (roomId: string) => Promise<void>;
  readonly onRenameRoomAlias: (
    roomId: string,
    alias: string | null,
  ) => Promise<void>;
  readonly onTogglePinRoom: (roomId: string) => Promise<void>;
  readonly onCloseMobileRail?: () => void;
}

export function RoomListRail({
  open,
  rooms,
  selectedRoomId,
  joinPhase,
  joinFailure,
  onClearJoinFailure,
  onJoinRoom,
  onSelectRoom,
  onRenameRoomAlias,
  onTogglePinRoom,
  onCloseMobileRail,
}: RoomListRailProps): ReactElement {
  const { t } = useI18n();
  const [addOpen, setAddOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [alias, setAlias] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [localFailure, setLocalFailure] = useState<AppFailure | null>(null);

  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingAliasValue, setEditingAliasValue] = useState("");

  const busy = joinPhase !== "idle";
  const activeFailure = localFailure ?? joinFailure;

  const handleToggleAdd = (): void => {
    setAddOpen((prev) => {
      const next = !prev;
      if (!next) {
        setPassphrase("");
        setAlias("");
        setLocalFailure(null);
        onClearJoinFailure();
      }
      return next;
    });
  };

  const handleAddSubmit = async (
    ev: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    ev.preventDefault();
    if (busy) return;

    const validationError = validateRoomPassphrase(passphrase);
    if (validationError !== null) {
      setLocalFailure({ kind: "validation", key: validationError });
      return;
    }

    setLocalFailure(null);
    onClearJoinFailure();
    const secretToDerive = passphrase;
    const aliasToSave = alias;
    setPassphrase("");

    const ok = await onJoinRoom(secretToDerive, aliasToSave);
    if (ok) {
      setAlias("");
      setAddOpen(false);
      onCloseMobileRail?.();
    }
  };

  const handleSaveRename = async (
    ev: FormEvent<HTMLFormElement>,
    roomId: string,
  ): Promise<void> => {
    ev.preventDefault();
    await onRenameRoomAlias(roomId, editingAliasValue);
    setEditingRoomId(null);
    setEditingAliasValue("");
  };

  return (
    <aside
      id="room-list-rail"
      data-testid="room-list-rail"
      aria-label={t("room.railAria")}
      className={`room-rail ${open ? "room-rail-open" : ""}`}
    >
      <div className="room-rail-header">
        <div className="side-section-header">
          <h2 className="side-section-title">{t("room.rail.heading")}</h2>
          <Button
            variant="secondary"
            size="sm"
            testId="open-join-room-drawer"
            aria-expanded={addOpen}
            onClick={handleToggleAdd}
            disabled={busy}
          >
            {addOpen ? t("room.rail.cancelAdd") : t("room.rail.addButton")}
          </Button>
        </div>

        {addOpen ? (
          <form
            className="room-rail-add-box"
            onSubmit={(ev) => void handleAddSubmit(ev)}
            autoComplete="off"
            noValidate
          >
            {activeFailure ? (
              <NoticeBanner tone="error">
                {formatAppFailure(activeFailure, t)}
              </NoticeBanner>
            ) : null}

            {busy ? (
              <NoticeBanner tone="info" loading>
                {joinPhase === "deriving"
                  ? t("lobby.phase.deriving")
                  : t("lobby.phase.connecting")}
              </NoticeBanner>
            ) : null}

            <TextField
              id="rail-room-passphrase"
              testId="rail-join-passphrase"
              label={t("lobby.field.passphrase")}
              showPromptSigil
              type={showPassphrase ? "text" : "password"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("lobby.field.passphrasePlaceholder")}
              value={passphrase}
              onChange={(ev) => {
                setPassphrase(ev.target.value);
                if (localFailure) setLocalFailure(null);
                if (joinFailure) onClearJoinFailure();
              }}
              disabled={busy}
              required
              trailingSlot={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    showPassphrase
                      ? t("lobby.passphrase.hideAria")
                      : t("lobby.passphrase.showAria")
                  }
                  aria-pressed={showPassphrase}
                  onClick={() => setShowPassphrase((v) => !v)}
                  disabled={busy}
                >
                  {showPassphrase
                    ? t("lobby.passphrase.hide")
                    : t("lobby.passphrase.show")}
                </Button>
              }
            />

            <TextField
              id="rail-room-alias"
              testId="rail-join-alias"
              label={t("lobby.field.alias")}
              hint={t("lobby.field.aliasHint")}
              type="text"
              autoComplete="off"
              maxLength={MAX_ROOM_ALIAS_CHARS}
              placeholder={t("lobby.field.aliasPlaceholder")}
              value={alias}
              onChange={(ev) => setAlias(ev.target.value)}
              disabled={busy}
            />

            <Button
              type="submit"
              variant="primary"
              size="sm"
              testId="rail-join-submit"
              disabled={busy}
            >
              {joinPhase === "deriving"
                ? t("lobby.phase.deriving")
                : joinPhase === "connecting"
                  ? t("lobby.phase.connecting")
                  : t("lobby.submit.idle")}
            </Button>
          </form>
        ) : null}
      </div>

      <div className="room-rail-list">
        {rooms.map((item) => {
          const isSelected = item.roomId === selectedRoomId;
          const fingerprint = formatRoomFingerprint(item.roomIdPrefix);
          const statusKind =
            item.connectionStatus === "connected"
              ? "online"
              : item.connectionStatus === "detached"
                ? "warning"
                : "offline";

          return (
            <div
              key={item.roomId}
              data-testid={`room-item-${item.roomIdPrefix}`}
              data-room-selected={isSelected ? "true" : "false"}
              className={`room-item ${isSelected ? "room-item-active" : ""}`}
            >
              <button
                type="button"
                className="room-item-select"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => {
                  void onSelectRoom(item.roomId);
                  onCloseMobileRail?.();
                }}
              >
                <div className="room-item-top">
                  <div className="room-item-title-group">
                    <StatusIcon status={statusKind} />
                    {item.pinned ? (
                      <span className="room-pin-glyph" aria-hidden="true">
                        ★
                      </span>
                    ) : null}
                    <span className="room-item-name">
                      {item.alias ?? fingerprint}
                    </span>
                    {item.alias ? (
                      <span className="room-item-fingerprint">
                        {fingerprint}
                      </span>
                    ) : null}
                  </div>

                  {item.unreadCount > 0 ? (
                    <span
                      className="room-unread-badge"
                      data-testid="room-unread-badge"
                    >
                      {item.unreadCount > 99 ? "99+" : item.unreadCount}
                    </span>
                  ) : item.connectionStatus === "standby" ? (
                    <span className="room-standby-tag">
                      {t("room.status.standby")}
                    </span>
                  ) : null}
                </div>

                <div className="room-item-preview">
                  {item.lastMessagePreview ? (
                    <>
                      <span className="room-item-preview-author">
                        @{item.lastMessageAuthor}:
                      </span>{" "}
                      <span>{item.lastMessagePreview}</span>
                    </>
                  ) : (
                    <span>{t("room.rail.emptyPreview")}</span>
                  )}
                </div>
              </button>

              {editingRoomId === item.roomId ? (
                <form
                  className="room-alias-form"
                  onSubmit={(ev) => void handleSaveRename(ev, item.roomId)}
                >
                  <input
                    type="text"
                    className="room-alias-input"
                    data-testid="room-alias-input"
                    maxLength={MAX_ROOM_ALIAS_CHARS}
                    placeholder={t("room.rail.renamePlaceholder")}
                    value={editingAliasValue}
                    onChange={(ev) => setEditingAliasValue(ev.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    testId="room-alias-save"
                  >
                    {t("room.rail.renameSave")}
                  </Button>
                </form>
              ) : (
                <div className="room-item-actions">
                  <button
                    type="button"
                    className="room-item-action-btn"
                    data-testid={`room-pin-${item.roomIdPrefix}`}
                    onClick={() => void onTogglePinRoom(item.roomId)}
                  >
                    {item.pinned ? t("room.rail.unpin") : t("room.rail.pin")}
                  </button>
                  <button
                    type="button"
                    className="room-item-action-btn"
                    data-testid={`room-rename-${item.roomIdPrefix}`}
                    onClick={() => {
                      setEditingRoomId(item.roomId);
                      setEditingAliasValue(item.alias ?? "");
                    }}
                  >
                    {t("room.rail.rename")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
