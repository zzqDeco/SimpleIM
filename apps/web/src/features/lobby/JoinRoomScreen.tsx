import { useState, type FormEvent, type ReactElement } from "react";
import type { UserProfile } from "@simpleim/contracts";
import {
  Button,
  NoticeBanner,
  TerminalBox,
  TextField,
} from "../../design-system/index.ts";
import type { JoinPhase } from "../../hooks/useRoomSession.ts";
import {
  formatAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  MAX_ROOM_ALIAS_CHARS,
  validateRoomPassphrase,
} from "../../state/validation.ts";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

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
      <header className="top-bar">
        <div className="brand-prompt">
          <span className="brand-prompt-sigil" aria-hidden="true">
            ❯
          </span>
          <span>{t("app.title")}</span>
        </div>

        <div className="top-bar-group">
          <span className="user-handle">@{user.username}</span>
          <PreferenceControls />
          <Button
            variant="secondary"
            size="sm"
            testId="sign-out-button"
            onClick={() => void onSignOut()}
            disabled={busy}
          >
            {t("lobby.signOut")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            testId="wipe-vault-button"
            onClick={() => void onWipeAndSignOut()}
            disabled={busy}
          >
            {t("lobby.wipeSignOut")}
          </Button>
        </div>
      </header>

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
