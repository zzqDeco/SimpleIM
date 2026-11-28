import { useState, type FormEvent, type ReactElement } from "react";
import type { UserProfile } from "@simpleim/contracts";
import {
  Button,
  IconButton,
  NoticeBanner,
  TerminalBox,
  TextField,
} from "../../design-system/index.ts";
import type { JoinPhase } from "../../hooks/useRoomSession.ts";
import {
  formatAppFailure,
  toAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  MAX_ROOM_ALIAS_CHARS,
  validateRoomPassphrase,
} from "../../state/validation.ts";
import { AppTopBar } from "../shell/AppTopBar.tsx";

export interface JoinRoomScreenProps {
  readonly user: UserProfile;
  readonly joinPhase: JoinPhase;
  readonly joinFailure: AppFailure | null;
  readonly onClearJoinFailure: () => void;
  readonly onJoinRoom: (passphrase: string, alias?: string) => Promise<boolean>;
  readonly onSignOut: () => Promise<void>;
  readonly onWipeAndSignOut: () => Promise<void>;
}

export function JoinRoomScreen({
  user,
  joinPhase,
  joinFailure,
  onClearJoinFailure,
  onJoinRoom,
  onSignOut,
  onWipeAndSignOut,
}: JoinRoomScreenProps): ReactElement {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [alias, setAlias] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [localFailure, setLocalFailure] = useState<AppFailure | null>(null);

  const busy = joinPhase !== "idle";
  const activeFailure = localFailure ?? joinFailure;

  const handleSubmit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
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
    }
  };

  return (
    <div className="screen-shell">
      <AppTopBar
        username={user.username}
        onSignOut={onSignOut}
        onWipeAndSignOut={onWipeAndSignOut}
        onActionError={(err) => setLocalFailure(toAppFailure(err))}
      />

      <main className="centered-stage">
        <div className="dialog-column">
          <TerminalBox aria-labelledby="join-room-heading">
            <div className="form-stack">
              <div className="dialog-header">
                <h1 id="join-room-heading" className="dialog-title">
                  {t("lobby.title")}
                </h1>
                <p className="dialog-subtitle">{t("lobby.subtitle")}</p>
              </div>

              {activeFailure ? (
                <NoticeBanner tone="error">
                  {formatAppFailure(activeFailure, t)}
                </NoticeBanner>
              ) : null}

              <div aria-live="polite">
                {joinPhase === "deriving" ? (
                  <NoticeBanner tone="info" loading testId="kdf-status">
                    {t("lobby.phase.deriving")}
                  </NoticeBanner>
                ) : joinPhase === "connecting" ? (
                  <NoticeBanner tone="info" loading testId="kdf-status">
                    {t("lobby.phase.connecting")}
                  </NoticeBanner>
                ) : null}
              </div>

              <form
                className="form-stack"
                onSubmit={(ev) => void handleSubmit(ev)}
                autoComplete="off"
                noValidate
              >
                <TextField
                  id="room-passphrase-input"
                  testId="room-passphrase"
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
                    <IconButton
                      icon={showPassphrase ? "eye-off" : "eye"}
                      size="sm"
                      variant="ghost"
                      label={
                        showPassphrase
                          ? t("lobby.passphrase.hideAria")
                          : t("lobby.passphrase.showAria")
                      }
                      pressed={showPassphrase}
                      onClick={() => setShowPassphrase((v) => !v)}
                      disabled={busy}
                    />
                  }
                />

                <TextField
                  id="room-alias-input"
                  testId="room-alias"
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
                  block
                  loading={busy}
                  testId="room-join-submit"
                  disabled={busy}
                >
                  {joinPhase === "deriving"
                    ? t("lobby.phase.deriving")
                    : joinPhase === "connecting"
                      ? t("lobby.phase.connecting")
                      : t("lobby.submit.idle")}
                </Button>
              </form>
            </div>
          </TerminalBox>
        </div>
      </main>
    </div>
  );
}
