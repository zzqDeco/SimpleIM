import { useState, type ReactElement } from "react";
import {
  BrandMark,
  Button,
  Byline,
  ConfirmPanel,
  CountBadge,
  Dialog,
  Divider,
  ICON_NAMES,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  NoticeBanner,
  ProgressBar,
  StatusDot,
  StatusIcon,
  Subline,
  Tabs,
  Tag,
  TerminalBox,
  TextField,
  Toast,
  ToastRegion,
  type DialogSize,
  type ToastTone,
} from "../design-system/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import type { ThemeMode } from "../theme/types.ts";

interface ColorSwatchSpec {
  readonly token: string;
  readonly swatchClass: string;
  readonly darkHex: string;
  readonly lightHex: string;
  readonly note: string;
}

interface TextContrastSpec {
  readonly token: string;
  readonly sampleClass: string;
  readonly darkHex: string;
  readonly darkMinRatio: string;
  readonly lightHex: string;
  readonly lightMinRatio: string;
}

const SURFACE_SWATCHES: readonly ColorSwatchSpec[] = [
  {
    token: "--bg-canvas",
    swatchClass: "preview-swatch-bg-canvas",
    darkHex: "#141413",
    lightHex: "#faf9f6",
    note: "Primary canvas",
  },
  {
    token: "--bg-panel",
    swatchClass: "preview-swatch-bg-panel",
    darkHex: "#1c1c1a",
    lightHex: "#ffffff",
    note: "Topbar, rails, dialogs, peer bubble",
  },
  {
    token: "--bg-elevated",
    swatchClass: "preview-swatch-bg-elevated",
    darkHex: "#242422",
    lightHex: "#f3f1ec",
    note: "Secondary controls, cards, chips",
  },
  {
    token: "--bg-input",
    swatchClass: "preview-swatch-bg-input",
    darkHex: "#181817",
    lightHex: "#ffffff",
    note: "Inputs & composer frame",
  },
  {
    token: "--bg-user-msg",
    swatchClass: "preview-swatch-bg-user-msg",
    darkHex: "#2e2e2b",
    lightHex: "#efede7",
    note: "Self message bubble",
  },
  {
    token: "--accent",
    swatchClass: "preview-swatch-accent",
    darkHex: "#d77757",
    lightHex: "#c96442",
    note: "BrandMark, focus borders, progress bar",
  },
  {
    token: "--accent-fill",
    swatchClass: "preview-swatch-accent-fill",
    darkHex: "#d77757",
    lightHex: "#bc5736",
    note: "Primary button fill (5.85 / 4.61 on inverse)",
  },
  {
    token: "--accent-fill-hover",
    swatchClass: "preview-swatch-accent-fill-hover",
    darkHex: "#e58b6d",
    lightHex: "#a44c2f",
    note: "Primary hover fill (7.24 / 5.75 on inverse)",
  },
];

const TEXT_CONTRAST_SPECS: readonly TextContrastSpec[] = [
  {
    token: "--text-primary",
    sampleClass: "preview-text-primary",
    darkHex: "#f2f1ed",
    darkMinRatio: "12.05:1",
    lightHex: "#141413",
    lightMinRatio: "15.75:1",
  },
  {
    token: "--text-secondary",
    sampleClass: "preview-text-secondary",
    darkHex: "#c7c5bd",
    darkMinRatio: "7.88:1",
    lightHex: "#3d3c38",
    lightMinRatio: "9.43:1",
  },
  {
    token: "--text-muted",
    sampleClass: "preview-text-muted",
    darkHex: "#98968f",
    darkMinRatio: "4.60:1",
    lightHex: "#6c6a63",
    lightMinRatio: "4.62:1",
  },
  {
    token: "--accent-text",
    sampleClass: "preview-text-accent",
    darkHex: "#dc886c",
    darkMinRatio: "5.05:1",
    lightHex: "#a04b2e",
    lightMinRatio: "5.07:1",
  },
  {
    token: "--interactive",
    sampleClass: "preview-text-interactive",
    darkHex: "#9da8fb",
    darkMinRatio: "6.11:1",
    lightHex: "#4558ef",
    lightMinRatio: "4.60:1",
  },
  {
    token: "--status-success",
    sampleClass: "preview-text-success",
    darkHex: "#4eba65",
    darkMinRatio: "5.54:1",
    lightHex: "#297135",
    lightMinRatio: "5.10:1",
  },
  {
    token: "--status-warning",
    sampleClass: "preview-text-warning",
    darkHex: "#f5b82e",
    darkMinRatio: "7.64:1",
    lightHex: "#815d1a",
    lightMinRatio: "5.10:1",
  },
  {
    token: "--status-danger",
    sampleClass: "preview-text-danger",
    darkHex: "#ff6b80",
    darkMinRatio: "4.97:1",
    lightHex: "#ab2b3f",
    lightMinRatio: "5.70:1",
  },
];

const THEME_BUTTONS: readonly {
  readonly mode: ThemeMode;
  readonly icon: "monitor" | "moon" | "sun";
  readonly label: string;
}[] = [
  { mode: "system", icon: "monitor", label: "System theme" },
  { mode: "dark", icon: "moon", label: "Dark theme" },
  { mode: "light", icon: "sun", label: "Light theme" },
];

export function Gallery(): ReactElement {
  const { mode, resolvedTheme, setMode } = useTheme();
  const [touchSim, setTouchSim] = useState(false);
  const [activeTab, setActiveTab] = useState<"tokens" | "states">("tokens");
  const [fieldValue, setFieldValue] = useState("shared-secret");
  const [showSecret, setShowSecret] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogSize, setDialogSize] = useState<DialogSize | null>(null);
  const [activeToast, setActiveToast] = useState<{
    readonly seq: number;
    readonly tone: ToastTone;
    readonly message: string;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<"idle" | "confirmed" | "cancelled">("idle");

  const showToast = (tone: ToastTone, message: string): void => {
    setActiveToast((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      tone,
      message,
    }));
  };

  return (
    <div className={`preview-page ${touchSim ? "preview-touch-sim" : ""}`}>
      <header className="preview-header">
        <div className="preview-header-brand">
          <BrandMark />
          <span>SimpleIM Design System Preview</span>
          <Tag tone="accent">{resolvedTheme}</Tag>
          {touchSim ? <Tag tone="info">Touch 44x44</Tag> : null}
        </div>

        <div className="preview-header-controls">
          <div className="preview-row" role="group" aria-label="Theme mode">
            {THEME_BUTTONS.map((btn) => (
              <IconButton
                key={btn.mode}
                icon={btn.icon}
                size="sm"
                variant="secondary"
                label={btn.label}
                pressed={mode === btn.mode}
                onClick={() => setMode(btn.mode)}
              />
            ))}
          </div>

          <Button
            variant={touchSim ? "primary" : "secondary"}
            size="sm"
            aria-pressed={touchSim}
            onClick={() => setTouchSim((v) => !v)}
          >
            {touchSim ? "Touch 44x44: ON" : "Simulate Touch"}
          </Button>
        </div>
      </header>

      <main className="preview-main">
        {/* 1. Palette & WCAG AA Contrast */}
        <section
          className="preview-section"
          data-testid="preview-section-palette"
          aria-labelledby="preview-palette-heading"
        >
          <h1 id="preview-palette-heading" className="preview-section-title">
            1. Color Palette & WCAG AA Contrast
          </h1>
          <p className="preview-section-desc">
            Active theme: {resolvedTheme}. Every body-text token and primary
            button fill passes WCAG AA (&gt;= 4.5:1) across all 5 surfaces.
          </p>

          <h2 className="preview-subsection-title">Surfaces & Accent Fills</h2>
          <div className="preview-grid">
            {SURFACE_SWATCHES.map((item) => (
              <div key={item.token} className="preview-card">
                <div className={`preview-swatch-bar ${item.swatchClass}`} />
                <span className="preview-token-name">{item.token}</span>
                <span className="preview-token-meta">
                  {resolvedTheme === "dark" ? item.darkHex : item.lightHex} ·{" "}
                  {item.note}
                </span>
              </div>
            ))}
          </div>

          <h2 className="preview-subsection-title">
            Text & Semantic Tokens (WCAG AA Min Contrast)
          </h2>
          <div className="preview-grid">
            {TEXT_CONTRAST_SPECS.map((spec) => (
              <div key={spec.token} className="preview-card">
                <span className={`preview-text-sample ${spec.sampleClass}`}>
                  Aa 永 SimpleIM
                </span>
                <span className="preview-token-name">{spec.token}</span>
                <span className="preview-token-meta">
                  {resolvedTheme === "dark"
                    ? `${spec.darkHex} · min ${spec.darkMinRatio}`
                    : `${spec.lightHex} · min ${spec.lightMinRatio}`}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 2. Typography, Spacing, Radii, Layers & Motion Scales */}
        <section
          className="preview-section"
          data-testid="preview-section-scales"
          aria-labelledby="preview-scales-heading"
        >
          <h2 id="preview-scales-heading" className="preview-section-title">
            2. Typography, Spacing, Radii, Layers & Motion
          </h2>

          <div className="preview-stack">
            <div className="preview-fs-xl">
              --font-size-xl (17px) — Dialog & Screen Headings
            </div>
            <div className="preview-fs-lg">
              --font-size-lg (15px) — Dropzone Emphasis
            </div>
            <div className="preview-fs-touch">
              --font-size-touch-input (16px) — Coarse-Pointer Input Anti-Zoom
            </div>
            <div className="preview-fs-md">
              --font-size-md (13.5px) — Chat Transcript Body & Inputs
            </div>
            <div className="preview-fs-sm">
              --font-size-sm (12px) — Secondary Controls, Chips & Previews
            </div>
            <div className="preview-fs-xs">
              --font-size-xs (11px) — Timestamps, Tags, Counts & Section Headers
            </div>
          </div>

          <Divider />

          <div className="preview-row">
            <Tag tone="neutral">--space-px: 1px</Tag>
            <Tag tone="neutral">--space-0-5: 2px</Tag>
            <Tag tone="neutral">--space-1: 4px</Tag>
            <Tag tone="neutral">--space-1-5: 6px</Tag>
            <Tag tone="neutral">--space-2: 8px</Tag>
            <Tag tone="neutral">--space-2-5: 10px</Tag>
            <Tag tone="neutral">--space-3: 12px</Tag>
            <Tag tone="neutral">--space-4: 16px</Tag>
            <Tag tone="neutral">--space-5: 20px</Tag>
            <Tag tone="neutral">--space-6: 24px</Tag>
            <Tag tone="neutral">--space-8: 32px</Tag>
          </div>

          <div className="preview-row">
            <Tag tone="accent">--radius-xs: 3px</Tag>
            <Tag tone="accent">--radius-sm: 5px</Tag>
            <Tag tone="accent">--radius-md: 7px</Tag>
            <Tag tone="accent">--radius-pill: 999px</Tag>
            <Tag tone="info">--duration-fast: 120ms</Tag>
            <Tag tone="info">--duration-base: 180ms</Tag>
            <Tag tone="info">--duration-slow: 240ms</Tag>
            <Tag tone="info">--z-raised(2)..--z-toast(60)</Tag>
          </div>
        </section>

        {/* 3. Icons, BrandMark & Status Indicators */}
        <section
          className="preview-section"
          data-testid="preview-section-icons"
          aria-labelledby="preview-icons-heading"
        >
          <h2 id="preview-icons-heading" className="preview-section-title">
            3. Vendored Lucide Icons ({ICON_NAMES.length}), BrandMark & StatusDot
          </h2>

          <div className="preview-row">
            <BrandMark />
            <span>BrandMark</span>
            <StatusDot status="online" label="Online" />
            <span>online</span>
            <StatusDot status="warning" label="Detached" />
            <span>warning</span>
            <StatusDot status="offline" label="Offline" />
            <span>offline</span>
            <StatusIcon status="success" />
            <StatusIcon status="warning" />
            <StatusIcon status="error" />
            <StatusIcon status="info" />
            <StatusIcon status="loading" />
          </div>

          <div className="preview-icon-grid">
            {ICON_NAMES.map((name) => (
              <div key={name} className="preview-icon-cell">
                <div className="preview-icon-sizes">
                  <Icon
                    name={name}
                    size={16}
                    spin={name === "loader-circle"}
                  />
                  <Icon
                    name={name}
                    size={20}
                    spin={name === "loader-circle"}
                  />
                </div>
                <span className="preview-token-meta">{name}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 4. Buttons & IconButtons */}
        <section
          className="preview-section"
          data-testid="preview-section-buttons"
          aria-labelledby="preview-buttons-heading"
        >
          <h2 id="preview-buttons-heading" className="preview-section-title">
            4. Button & IconButton States
          </h2>

          <h3 className="preview-subsection-title">Button — md & sm</h3>
          <div className="preview-row">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="primary" leadingIcon="send">
              Leading Icon
            </Button>
            <Button variant="primary" loading>
              Loading
            </Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
          </div>
          <div className="preview-row">
            <Button variant="primary" size="sm" leadingIcon="download">
              Download (sm)
            </Button>
            <Button variant="secondary" size="sm" leadingIcon="hard-drive-download">
              Save (sm)
            </Button>
            <Button variant="ghost" size="sm" leadingIcon="reply">
              Reply (sm)
            </Button>
            <Button variant="danger" size="sm" leadingIcon="trash-2">
              Delete (sm)
            </Button>
          </div>

          <h3 className="preview-subsection-title">IconButton & CountBadge</h3>
          <div className="preview-row">
            <IconButton icon="menu" size="sm" variant="secondary" label="Menu sm" badge={3} />
            <IconButton icon="ellipsis" size="sm" variant="secondary" label="More sm" />
            <IconButton icon="users" size="md" variant="secondary" label="Members md" badge="dot" />
            <IconButton icon="pin" size="md" variant="ghost" label="Pinned" pressed />
            <IconButton icon="send" size="md" variant="primary" label="Send" />
            <IconButton icon="trash-2" size="md" variant="danger" label="Delete" />
            <IconButton icon="x" size="md" variant="ghost" label="Disabled" disabled />
            <CountBadge value={4} label="4 unread" />
            <CountBadge value={128} label="128 unread" />
            <CountBadge value={1} variant="dot" label="Unread dot" />
          </div>
        </section>

        {/* 5. Form Controls & Text Primitives */}
        <section
          className="preview-section"
          data-testid="preview-section-inputs"
          aria-labelledby="preview-inputs-heading"
        >
          <h2 id="preview-inputs-heading" className="preview-section-title">
            5. TextField, Tabs, Byline & Subline
          </h2>

          <div className="preview-narrow-box preview-stack">
            <Tabs
              ariaLabel="Preview tabs"
              activeId={activeTab}
              onChange={setActiveTab}
              items={[
                { id: "tokens", label: "Tokens" },
                { id: "states", label: "States" },
              ]}
            />

            <TextField
              id="preview-passphrase"
              label="Passphrase"
              hint="Client-side Argon2id"
              showPromptSigil
              type={showSecret ? "text" : "password"}
              value={fieldValue}
              onChange={(ev) => setFieldValue(ev.target.value)}
              trailingSlot={
                <IconButton
                  icon={showSecret ? "eye-off" : "eye"}
                  size="sm"
                  variant="ghost"
                  label={showSecret ? "Hide secret" : "Show secret"}
                  pressed={showSecret}
                  onClick={() => setShowSecret((v) => !v)}
                />
              }
            />

            <TextField
              id="preview-disabled"
              label="Disabled field"
              value="read-only"
              disabled
              onChange={() => {}}
            />

            <Byline>
              <span>@alice</span>
              <span>WEB</span>
              <span>12 ms</span>
            </Byline>

            <Subline>
              <span>@bob: Quoted reply preview using corner-down-right</span>
            </Subline>
          </div>
        </section>

        {/* 6. Tags, Notices, ProgressBar & Toast */}
        <section
          className="preview-section"
          data-testid="preview-section-feedback"
          aria-labelledby="preview-feedback-heading"
        >
          <h2 id="preview-feedback-heading" className="preview-section-title">
            6. Tag, NoticeBanner, ProgressBar & Toast
          </h2>

          <div className="preview-row">
            <Tag tone="neutral">WEB</Tag>
            <Tag tone="accent" icon="cloud-upload">
              Caching 42%
            </Tag>
            <Tag tone="success" icon="cloud-check">
              Cached 24h
            </Tag>
            <Tag tone="warning" icon="triangle-alert">
              Detached
            </Tag>
            <Tag
              tone="danger"
              icon="rotate-ccw"
              onClick={() => showToast("info", "Retry clicked")}
            >
              Retry (button)
            </Tag>
            <Tag tone="info" icon="info">
              Info
            </Tag>
          </div>

          <div className="preview-stack">
            <NoticeBanner tone="info" loading>
              Deriving Argon2id room keys…
            </NoticeBanner>
            <NoticeBanner
              tone="warning"
              dismissLabel="Dismiss"
              onDismiss={() => showToast("warning", "Warning dismissed")}
            >
              Signaling offline; active P2P channels remain connected.
            </NoticeBanner>
            <NoticeBanner tone="error">
              Chunk SHA-256 verification failed.
            </NoticeBanner>
            <ProgressBar percent={65} ariaLabel="Download progress" />
            <ProgressBar percent={100} complete ariaLabel="Complete progress" />
          </div>

          <div className="preview-row">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => showToast("info", "Info toast announcement")}
            >
              Show Info Toast
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => showToast("success", "Saved to disk")}
            >
              Show Success Toast
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => showToast("error", "Original message unavailable")}
            >
              Show Error Toast
            </Button>
          </div>
        </section>

        {/* 7. Overlays: ConfirmPanel, Menu, Dialog & TerminalBox */}
        <section
          className="preview-section"
          data-testid="preview-section-overlays"
          aria-labelledby="preview-overlays-heading"
        >
          <h2 id="preview-overlays-heading" className="preview-section-title">
            7. ConfirmPanel, Menu, Dialog & TerminalBox
          </h2>

          <div className="preview-row">
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="start"
              label="Preview actions menu"
              trigger={(props) => (
                <Button
                  ref={props.ref}
                  variant="secondary"
                  size="sm"
                  leadingIcon="ellipsis"
                  aria-expanded={props["aria-expanded"]}
                  aria-haspopup={props["aria-haspopup"]}
                  aria-controls={props["aria-controls"]}
                  onClick={props.onClick}
                >
                  Open Menu
                </Button>
              )}
            >
              <MenuSection>
                <MenuItem
                  icon="door-open"
                  onSelect={() => showToast("info", "Leave selected")}
                >
                  Leave room
                </MenuItem>
                <MenuItem
                  icon="log-out"
                  onSelect={() => showToast("info", "Sign out selected")}
                >
                  Sign out
                </MenuItem>
              </MenuSection>
              <MenuSeparator />
              <MenuSection>
                <MenuItem
                  icon="trash-2"
                  tone="danger"
                  onSelect={() => showToast("error", "Wipe selected")}
                >
                  Wipe & sign out
                </MenuItem>
              </MenuSection>
            </Menu>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDialogSize("sm")}
            >
              Open Dialog (sm)
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDialogSize("fullscreen")}
            >
              Open Dialog (fullscreen)
            </Button>
          </div>

          <div className="preview-narrow-box preview-stack">
            <TerminalBox>
              <div className="preview-stack">
                <ConfirmPanel
                  title="Delete 128 local messages and room keys?"
                  description="You will need to re-enter the passphrase to rejoin."
                  confirmLabel="Confirm Leave"
                  cancelLabel="Cancel"
                  tone="danger"
                  onCancel={() => setConfirmState("cancelled")}
                  onConfirm={() => setConfirmState("confirmed")}
                />
                {confirmState !== "idle" ? (
                  <span className="preview-token-meta">
                    Last confirm panel action: {confirmState}
                  </span>
                ) : null}
              </div>
            </TerminalBox>
          </div>
        </section>
      </main>

      <Dialog
        open={dialogSize !== null}
        onClose={() => setDialogSize(null)}
        title={`Dialog (${dialogSize ?? "md"})`}
        subtitle="ESC or backdrop closes and restores focus"
        size={dialogSize ?? "md"}
        closeLabel="Close dialog"
        footer={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setDialogSize(null)}
          >
            Done
          </Button>
        }
      >
        <p className="md-paragraph">
          Accessible modal dialog with focus trap and keyboard dismissal.
        </p>
      </Dialog>

      {activeToast ? (
        <ToastRegion placement="bottom-center">
          <Toast
            key={activeToast.seq}
            tone={activeToast.tone}
            message={activeToast.message}
            onDismiss={() => setActiveToast(null)}
          />
        </ToastRegion>
      ) : null}
    </div>
  );
}
