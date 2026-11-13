import { useState, type FormEvent, type ReactElement } from "react";
import { isValidPassword, isValidUsername } from "@simpleim/contracts";

export interface AuthViewProps {
  onLogin: (params: { username: string; password: string }) => Promise<void>;
  onRegister: (params: {
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  externalNotice?: string | null;
}

export function AuthView({
  onLogin,
  onRegister,
  externalNotice,
}: AuthViewProps): ReactElement {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (next: "login" | "register"): void => {
    setMode(next);
    setError(null);
  };

  const handleSubmit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault();
    if (submitting) return;

    const normalizedUsername = username.trim().toLowerCase();
    if (!isValidUsername(normalizedUsername)) {
      setError("Username must be 3–24 characters using a-z, 0-9, _ or -.");
      return;
    }

    if (mode === "register") {
      if (!isValidPassword(password)) {
        setError("Password must be between 8 and 128 characters.");
        return;
      }
      const trimmedDisplay = displayName.trim();
      if (trimmedDisplay.length > 32) {
        setError("Display name must be at most 32 characters.");
        return;
      }
    } else if (password.length === 0) {
      setError("Please enter your account password.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await onLogin({ username: normalizedUsername, password });
      } else {
        await onRegister({
          username: normalizedUsername,
          password,
          ...(displayName.trim().length > 0
            ? { displayName: displayName.trim() }
            : {}),
        });
      }
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="centered-shell">
      <header className="shell-topbar">
        <div className="brand-lockup">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          <span>SimpleIM</span>
          <span className="brand-subtitle">E2EE WebRTC Mesh</span>
        </div>
      </header>

      <main className="centered-main">
        <section className="crypto-card" aria-labelledby="auth-heading">
          <div className="card-eyebrow">Ed25519 Identity Authority</div>
          <h1 id="auth-heading" className="card-title">
            {mode === "login" ? "Sign in to SimpleIM" : "Create your identity"}
          </h1>
          <p className="card-description">
            The central server verifies your account and issues short-lived{" "}
            <code>Ed25519</code> peer certificates without ever seeing room keys or
            messages.
          </p>

          <nav className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              data-testid="auth-tab-login"
              className="auth-tab"
              onClick={() => switchMode("login")}
            >
              Sign In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              data-testid="auth-tab-register"
              className="auth-tab"
              onClick={() => switchMode("register")}
            >
              Create Account
            </button>
          </nav>

          {externalNotice && !error ? (
            <div className="alert-banner alert-info" role="status" style={{ marginBottom: 14 }}>
              <span>{externalNotice}</span>
            </div>
          ) : null}

          {error ? (
            <div
              className="alert-banner alert-error"
              role="alert"
              data-testid="auth-error"
              style={{ marginBottom: 14 }}
            >
              {error}
            </div>
          ) : null}

          <form className="form-stack" onSubmit={(ev) => void handleSubmit(ev)} noValidate>
            <div className="field-group">
              <div className="field-label-row">
                <label htmlFor="auth-username-input" className="field-label">
                  Username
                </label>
                <span className="field-hint">a-z, 0-9, _, -</span>
              </div>
              <input
                id="auth-username-input"
                data-testid="auth-username"
                type="text"
                className="text-input text-input-mono"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="alice"
                value={username}
                onChange={(ev) => setUsername(ev.target.value)}
                disabled={submitting}
                required
              />
            </div>

            {mode === "register" ? (
              <div className="field-group">
                <div className="field-label-row">
                  <label htmlFor="auth-display-input" className="field-label">
                    Display Name
                  </label>
                  <span className="field-hint">Optional (1–32 chars)</span>
                </div>
                <input
                  id="auth-display-input"
                  data-testid="auth-display-name"
                  type="text"
                  className="text-input"
                  autoComplete="nickname"
                  placeholder="Alice"
                  value={displayName}
                  onChange={(ev) => setDisplayName(ev.target.value)}
                  disabled={submitting}
                />
              </div>
            ) : null}

            <div className="field-group">
              <div className="field-label-row">
                <label htmlFor="auth-password-input" className="field-label">
                  Password
                </label>
                <span className="field-hint">
                  {mode === "register" ? "8–128 chars" : "Required"}
                </span>
              </div>
              <input
                id="auth-password-input"
                data-testid="auth-password"
                type="password"
                className="text-input"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder="••••••••••••"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <button
              type="submit"
              data-testid="auth-submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting
                ? mode === "login"
                  ? "Signing in…"
                  : "Creating account…"
                : mode === "login"
                  ? "Sign In"
                  : "Create Account"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
