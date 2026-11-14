import { useState, type FormEvent, type ReactElement } from "react";
import {
  Button,
  NoticeBanner,
  Tabs,
  TerminalBox,
  TextField,
} from "../../design-system/index.ts";
import type { AuthNoticeKey } from "../../hooks/useAuthSession.ts";
import {
  formatAppFailure,
  toAppFailure,
  type AppFailure,
} from "../../i18n/error-catalog.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  validateAuthInput,
  type AuthMode,
} from "../../state/validation.ts";
import { PreferenceControls } from "../preferences/PreferenceControls.tsx";

export interface AuthScreenProps {
  readonly onLogin: (params: {
    username: string;
    password: string;
  }) => Promise<void>;
  readonly onRegister: (params: {
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  readonly externalNoticeKey: AuthNoticeKey | null;
}

export function AuthScreen({
  onLogin,
  onRegister,
  externalNoticeKey,
}: AuthScreenProps): ReactElement {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AppFailure | null>(null);

  const switchMode = (next: AuthMode): void => {
    setMode(next);
    setFailure(null);
  };

  const handleSubmit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault();
    if (submitting) return;

    const validationError = validateAuthInput({
      mode,
      username,
      password,
      displayName,
    });
    if (validationError !== null) {
      setFailure({ kind: "validation", key: validationError });
      return;
    }

    const normalizedUsername = username.trim().toLowerCase();
    const trimmedDisplay = displayName.trim();

    setSubmitting(true);
    setFailure(null);
    try {
      if (mode === "login") {
        await onLogin({ username: normalizedUsername, password });
      } else {
        await onRegister({
          username: normalizedUsername,
          password,
          ...(trimmedDisplay.length > 0 ? { displayName: trimmedDisplay } : {}),
        });
      }
      setPassword("");
    } catch (err) {
      setFailure(toAppFailure(err));
    } finally {
      setSubmitting(false);
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
        <PreferenceControls />
      </header>

      <main className="centered-stage">
        <div className="dialog-column">
          <TerminalBox aria-labelledby="auth-heading">
            <div className="form-stack">
              <div className="dialog-header">
                <h1 id="auth-heading" className="dialog-title">
                  {mode === "login"
                    ? t("auth.title.login")
                    : t("auth.title.register")}
                </h1>
              </div>

              <Tabs
                ariaLabel={t("auth.tabAria")}
                activeId={mode}
                onChange={switchMode}
                disabled={submitting}
                items={[
                  {
                    id: "login",
                    label: t("auth.tab.login"),
                    testId: "auth-tab-login",
                  },
                  {
                    id: "register",
                    label: t("auth.tab.register"),
                    testId: "auth-tab-register",
                  },
                ]}
              />

              {externalNoticeKey && !failure ? (
                <NoticeBanner tone="info">{t(externalNoticeKey)}</NoticeBanner>
              ) : null}

              {failure ? (
                <NoticeBanner tone="error" testId="auth-error">
                  {formatAppFailure(failure, t)}
                </NoticeBanner>
              ) : null}

              <form
                className="form-stack"
                onSubmit={(ev) => void handleSubmit(ev)}
                noValidate
              >
                <TextField
                  id="auth-username-input"
                  testId="auth-username"
                  label={t("auth.field.username")}
                  showPromptSigil
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t("auth.field.usernamePlaceholder")}
                  value={username}
                  onChange={(ev) => setUsername(ev.target.value)}
                  disabled={submitting}
                  required
                />

                {mode === "register" ? (
                  <TextField
                    id="auth-display-input"
                    testId="auth-display-name"
                    label={t("auth.field.displayName")}
                    hint={t("auth.field.displayNameHint")}
                    type="text"
                    autoComplete="nickname"
                    placeholder={t("auth.field.displayNamePlaceholder")}
                    value={displayName}
                    onChange={(ev) => setDisplayName(ev.target.value)}
                    disabled={submitting}
                  />
                ) : null}

                <TextField
                  id="auth-password-input"
                  testId="auth-password"
                  label={t("auth.field.password")}
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder="••••••••"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  disabled={submitting}
                  required
                />

                <Button
                  type="submit"
                  variant="primary"
                  testId="auth-submit"
                  disabled={submitting}
                >
                  {submitting
                    ? mode === "login"
                      ? t("auth.submit.loginBusy")
                      : t("auth.submit.registerBusy")
                    : mode === "login"
                      ? t("auth.submit.login")
                      : t("auth.submit.register")}
                </Button>
              </form>
            </div>
          </TerminalBox>
        </div>
      </main>
    </div>
  );
}
