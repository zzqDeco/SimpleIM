import { useState, type FormEvent, type ReactElement } from "react";
import type { UserProfile } from "@simpleim/contracts";

export type JoinPhase = "idle" | "deriving" | "connecting";

export interface JoinRoomViewProps {
  user: UserProfile;
  joinPhase: JoinPhase;
  error: string | null;
  onJoinRoom: (passphrase: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function JoinRoomView({
  user,
  joinPhase,
  error,
  onJoinRoom,
  onSignOut,
}: JoinRoomViewProps): ReactElement {
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = joinPhase !== "idle";
  const activeError = localError ?? error;

  const handleSubmit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault();
    if (busy) return;

    const normalized = passphrase.normalize("NFC");
    const byteLen = new TextEncoder().encode(normalized).byteLength;
    if (byteLen < 1 || byteLen > 256) {
      setLocalError("Room passphrase must be between 1 and 256 UTF-8 bytes.");
      return;
    }

    setLocalError(null);
    const secretToDerive = passphrase;
    setPassphrase("");
    await onJoinRoom(secretToDerive);
  };

  return (
    <div className="centered-shell">
      <header className="shell-topbar">
        <div className="brand-lockup">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          <span>SimpleIM</span>
          <span className="brand-subtitle">Zero-Knowledge Room KDF</span>
        </div>

        <div className="header-right">
          <span className="peer-count-pill">
            {user.displayName} (@{user.username})
          </span>
          <button
            type="button"
            data-testid="sign-out-button"
            className="btn btn-secondary btn-sm"
            onClick={() => void onSignOut()}
            disabled={busy}
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="centered-main">
        <section
          className="crypto-card crypto-card-wide"
          aria-labelledby="join-room-heading"
        >
          <div className="card-eyebrow">Client-Only Argon2id + HKDF</div>
          <h1 id="join-room-heading" className="card-title">
            Join Encrypted Room
          </h1>
          <p className="card-description">
            Anyone deriving the same passphrase enters the same P2P room. Your
            passphrase never touches the server, URL bar, or browser storage.
          </p>

          {activeError ? (
            <div
              className="alert-banner alert-error"
              role="alert"
              style={{ marginBottom: 14 }}
            >
              {activeError}
            </div>
          ) : null}

          <div aria-live="polite" role="status">
            {joinPhase === "deriving" ? (
              <div
                className="alert-banner alert-info"
                data-testid="kdf-status"
                style={{ marginBottom: 14 }}
              >
                <span className="spinner-dot" aria-hidden="true" />
                <span>Deriving 64 MiB Argon2id room keys…</span>
              </div>
            ) : joinPhase === "connecting" ? (
              <div
                className="alert-banner alert-info"
                data-testid="kdf-status"
                style={{ marginBottom: 14 }}
              >
                <span className="spinner-dot" aria-hidden="true" />
                <span>Issuing Ed25519 peer certificate &amp; joining mesh…</span>
              </div>
            ) : null}
          </div>

          <form
            className="form-stack"
            onSubmit={(ev) => void handleSubmit(ev)}
            autoComplete="off"
            noValidate
          >
            <div className="field-group">
              <div className="field-label-row">
                <label htmlFor="room-passphrase-input" className="field-label">
                  Shared Room Passphrase
                </label>
                <span className="field-hint">1–256 UTF-8 bytes · NFC</span>
              </div>
              <div className="passphrase-input-wrap">
                <input
                  id="room-passphrase-input"
                  data-testid="room-passphrase"
                  type={showPassphrase ? "text" : "password"}
                  className="text-input text-input-mono"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Enter shared secret passphrase…"
                  value={passphrase}
                  onChange={(ev) => {
                    setPassphrase(ev.target.value);
                    if (localError) setLocalError(null);
                  }}
                  disabled={busy}
                  required
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  aria-pressed={showPassphrase}
                  onClick={() => setShowPassphrase((v) => !v)}
                  disabled={busy}
                >
                  {showPassphrase ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <button
              type="submit"
              data-testid="room-join-submit"
              className="btn btn-primary"
              disabled={busy}
            >
              {joinPhase === "deriving"
                ? "Deriving 64 MiB Argon2id room keys…"
                : joinPhase === "connecting"
                  ? "Connecting to Signaling…"
                  : "Join Encrypted Room"}
            </button>
          </form>

          <div className="guarantees-box">
            <h2 className="guarantees-title">Zero-Knowledge P2P Guarantees</h2>
            <ul className="guarantees-list">
              <li>
                <span className="guarantee-check" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>64 MiB Argon2id + HKDF-SHA256</strong> expands orthogonal
                  signaling, auth, and chat keys inside a dedicated Web Worker.
                </span>
              </li>
              <li>
                <span className="guarantee-check" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>HELLO_AUTH Channel Binding</strong> verifies server{" "}
                  <code>PeerIdentityCert</code>, shared <code>roomAuthKey</code>, and
                  both peers&apos; DTLS SHA-256 fingerprints before quarantine lifts.
                </span>
              </li>
              <li>
                <span className="guarantee-check" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>Center-Detached Survival</strong>: active WebRTC{" "}
                  <code>RTCDataChannel</code>s continue chatting &amp; Swarm seeding
                  even if the signaling server goes offline.
                </span>
              </li>
              <li>
                <span className="guarantee-check" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>OPFS 64 KiB Swarm Storage</strong> streams SHA-256 verified
                  chunks directly to Worker OPFS without RAM bloat.
                </span>
              </li>
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
