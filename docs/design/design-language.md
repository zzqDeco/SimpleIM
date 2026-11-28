# SimpleIM Web Design Language

SimpleIM's Web client (`apps/web`) uses a **terminal-native design language** inspired by Claude Code: monospace typography first, warm terracotta accents, the `❯` brand prompt sigil, crisp small radii, high information density, and restrained semantic color.

All visual tokens live in [`apps/web/src/styles/tokens.css`](../../apps/web/src/styles/tokens.css), all reusable UI primitives live in [`apps/web/src/design-system/`](../../apps/web/src/design-system/), and every rule in this specification is enforced automatically by `bun run lint` (`tests/arch.test.ts` + `tests/design-tokens.test.ts`) and Playwright E2E regression tests (`e2e/web-cli-interop.pw.ts`).

---

## 1. Visual Principles

1. **Terminal Idiom, IM Clarity**: Monospace typography (`--font-mono`) with crisp CJK fallbacks, sharp small radii (`3px / 5px / 7px`), and hairline borders (`1px`) keep the workspace calm and scan-friendly without decorative clutter.
2. **Restrained Color & Clear Hierarchy**: Text uses three readable levels (`primary > secondary > muted`) differentiated by font size (`md / sm / xs`) and weight (`700 / 600`), never by low-contrast gray. Accent color is split by role (`--accent` for brand sigils/borders, `--accent-text` for readable text, `--accent-fill` / `--accent-fill-hover` for solid primary button & unread badge fills).
3. **WCAG AA Accessibility by Construction**: Every body-text token, interactive link, semantic status color, soft-tinted badge, and primary button fill meets `>= 4.5:1` contrast in both Dark and Light themes. Purely decorative separators (`·`, reply connector) use `--text-decorative` and are strictly restricted to whitelisted non-text selectors.
4. **Zero-FOUC Single-Source Themes**: Dark theme is the `:root` baseline; Light theme is defined **once** under `:root[data-theme="light"]` and activated pre-paint by the external CSP-safe script [`apps/web/public/theme-init.js`](../../apps/web/public/theme-init.js) without writing to `localStorage`.
5. **Cross-Platform Icon Consistency**: All UI icons render through `<Icon>` using a vendored subset of Lucide SVG paths (zero npm dependencies, `currentColor`, `1.75px` stroke). Color emojis (`\p{Extended_Pictographic}`) are prohibited in UI chrome and locale dictionaries.
6. **Responsive & Touch-First Discipline**: Unified single-row `AppTopBar` + `AccountMenu` across Auth, Lobby, and Room screens (`<= 44px` desktop, `<= 52px` touch, `<= 10%` viewport height); coarse-pointer touch targets expand to `>= 44×44` (`40px` visual minimum + `-2px` `::after` hit area); motion honors `prefers-reduced-motion: reduce`.

---

## 2. Design Tokens (`apps/web/src/styles/tokens.css`)

### 2.1 Typography

| Token | Value | Usage |
| :--- | :--- | :--- |
| `--font-mono` | `"JetBrains Mono", "SF Mono", ..., monospace` | Default UI & message font stack |
| `--font-sans` | System sans-serif + CJK fallback | Optional non-mono fallback |
| `--font-size-xs` | `11px` | Metadata: timestamps, tags, badges, counts, hints, section titles |
| `--font-size-sm` | `12px` | Secondary UI: small buttons, tabs, chips, author row, previews |
| `--font-size-md` | `13.5px` | Body copy: chat messages, inputs, notices, entity names, default buttons |
| `--font-size-lg` | `15px` | Emphasis: drag-and-drop overlay prompt |
| `--font-size-xl` | `17px` | Headings: dialog and card titles |
| `--font-size-touch-input` | `16px` | `@media (pointer: coarse)` form inputs (prevents iOS Safari auto-zoom) |
| `--font-size-code-inline` | `0.92em` | Relative inline markdown code sizing |
| `--font-weight-medium` | `600` | Buttons, tabs, labels, tags, emphasis |
| `--font-weight-bold` | `700` | Titles, author names, room names, unread badges |
| `--line-none` | `1` | Single glyphs, status dots, count badges |
| `--line-tight` | `1.25` | Buttons, tags, dividers, compact badges |
| `--line-normal` | `1.45` | General UI copy, inputs, confirm panels |
| `--line-relaxed` | `1.55` | Chat message prose & markdown paragraphs |

### 2.2 Spacing & Radii

| Token | Value | Token | Value |
| :--- | :--- | :--- | :--- |
| `--space-px` | `1px` | `--space-3` | `12px` |
| `--space-0-5` | `2px` | `--space-4` | `16px` |
| `--space-1` | `4px` | `--space-5` | `20px` |
| `--space-1-5` | `6px` | `--space-6` | `24px` |
| `--space-2` | `8px` | `--space-8` | `32px` |
| `--space-2-5` | `10px` | | |

| Radius Token | Value | Usage |
| :--- | :--- | :--- |
| `--radius-xs` | `3px` | Small buttons, tags, chips, inline code, selects |
| `--radius-sm` | `5px` | Default buttons, inputs, file cards, notices, confirm panels |
| `--radius-md` | `7px` | TerminalBox, message bubbles, menus, dialogs |
| `--radius-pill` | `999px` | Count badges, status dots, floating date pill, toast, jump-to-latest |

### 2.3 Layers (Z-Index), Motion & Touch

| Z-Index Token | Value | Usage |
| :--- | :--- | :--- |
| `--z-raised` | `2` | Hovered/focused compact message (`calc(var(--z-raised) + 1)` for hover action bar) |
| `--z-sticky` | `10` | Floating scroll date pill, jump-to-latest button, inline transcript toast |
| `--z-backdrop` | `20` | Overlay drawer backdrop |
| `--z-drawer` | `25` | Left room rail and right members/files overlay drawers |
| `--z-header` | `30` | Top application bar |
| `--z-popover` | `40` | `Menu` popovers (`AccountMenu`) |
| `--z-modal` | `50` | `Dialog` (`ImageLightbox`) and file drop mask |
| `--z-toast` | `60` | Global `ToastRegion` |

| Motion / Touch Token | Value | Reduced Motion / Purpose |
| :--- | :--- | :--- |
| `--duration-fast` | `120ms` | Hover & color transitions (`0ms` under `prefers-reduced-motion: reduce`) |
| `--duration-base` | `180ms` | Drawers, floating date pill, progress bar (`0ms` reduced) |
| `--duration-slow` | `240ms` | Quote-jump message highlight (`0ms` reduced) |
| `--duration-spin` | `900ms` | `Icon spin` loader animation (`0ms` reduced) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Standard deceleration easing |
| `--touch-visual-min` | `40px` | Visual minimum button size under `@media (pointer: coarse)` |
| `--touch-target-min` | `44px` | Effective touch hit target (`40px` + `::after` `-2px` inset) |

### 2.4 Color Palette & WCAG AA Contrast (`>= 4.5:1`)

Surfaces evaluated: `--bg-canvas`, `--bg-panel`, `--bg-elevated`, `--bg-input`, `--bg-user-msg` (plus `*-soft` overlays composited over container surfaces).

| Token | Dark Value | Dark Min Ratio | Light Value | Light Min Ratio | Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#141413` | — | `#faf9f6` | — | Primary app canvas |
| `--bg-panel` | `#1c1c1a` | — | `#ffffff` | — | Topbar, side rails, dialogs, peer bubble |
| `--bg-elevated` | `#242422` | — | `#f3f1ec` | — | Secondary buttons, cards, chips, menu items |
| `--bg-input` | `#181817` | — | `#ffffff` | — | TextField & composer input surface |
| `--bg-user-msg` | `#2e2e2b` | — | `#efede7` | — | Self message bubble |
| `--text-primary` | `#f2f1ed` | `12.05:1` | `#141413` | `15.75:1` | Primary text & headings |
| `--text-secondary` | `#c7c5bd` | `7.88:1` | `#3d3c38` | `9.43:1` | Secondary labels & controls |
| `--text-muted` | `#98968f` | `4.60:1` | `#6c6a63` | `4.62:1` | Timestamps, hints, placeholders, subtitles |
| `--text-decorative` | `#6b6962` | Decorative only | `#96938b` | Decorative only | Non-text separators only (`.ds-byline-sep`, `.ds-subline-glyph`) |
| `--text-inverse` | `#141413` | `5.85:1` on fill | `#ffffff` | `4.61:1` on fill | Text on `--accent-fill` / `--accent-fill-hover` |
| `--accent` | `#d77757` | Brand / border | `#c96442` | Brand / border | `BrandMark`, focus borders, progress bar |
| `--accent-text` | `#dc886c` | `5.05:1` | `#a04b2e` | `5.07:1` | Inline code, active tags, jump-to-latest, ext badges |
| `--accent-fill` | `#d77757` | `5.85:1` | `#bc5736` | `4.61:1` | Primary button & unread count badge background |
| `--accent-fill-hover` | `#e58b6d` | `7.24:1` | `#a44c2f` | `5.75:1` | Primary button hover background |
| `--interactive` | `#9da8fb` | `6.11:1` | `#4558ef` | `4.60:1` | Links & info status |
| `--status-success` | `#4eba65` | `5.54:1` | `#297135` | `5.10:1` | Online, cached, seeding |
| `--status-warning` | `#f5b82e` | `7.64:1` | `#815d1a` | `5.10:1` | P2P detached / security alerts |
| `--status-danger` | `#ff6b80` | `4.97:1` | `#ab2b3f` | `5.70:1` | Errors, retries, destructive confirmations |

---

## 3. Iconography Specification

- **Source**: Vendored subset of [Lucide Icons](https://lucide.dev) (`v0.475.0`, ISC License) stored in [`apps/web/src/design-system/icons/lucide-paths.ts`](../../apps/web/src/design-system/icons/lucide-paths.ts). Adding new icons requires adding only their SVG path/shape data there—never adding an icon npm package.
- **Sizes & Stroke**: Only `16` (default) or `20` px; `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- **Accessibility**:
  - Decorative icons inside labeled buttons/tags omit `label` (`aria-hidden="true" focusable="false"`).
  - Standalone meaningful icons pass `label` (`role="img" aria-label={label}`).
  - `IconButton` requires `label` (rendered as both `aria-label` and `title`).
- **Special Indicators**:
  - `❯` is rendered exclusively via `<BrandMark />` (purely decorative, `aria-hidden="true"`).
  - Online/offline/warning presence dots are rendered via CSS `<StatusDot />`, never `●` / `○` characters.
- **Curated Set (31 icons)**: `menu`, `ellipsis`, `users`, `cloud-upload`, `cloud-check`, `check`, `x`, `triangle-alert`, `info`, `loader-circle`, `pin`, `arrow-down`, `corner-down-right`, `paperclip`, `send`, `download`, `hard-drive-download`, `locate`, `eye`, `eye-off`, `reply`, `rotate-ccw`, `door-open`, `log-out`, `trash-2`, `monitor`, `moon`, `sun`, `languages`, `file`, `image`.

---

## 4. Component Catalog (`apps/web/src/design-system/`)

| Component | Purpose & Key Props |
| :--- | :--- |
| `BrandMark` | Renders the decorative `❯` terminal brand sigil. |
| `Icon` | Renders a vendored Lucide SVG icon (`name`, `size?: 16 \| 20`, `label?`, `spin?`). |
| `StatusDot` | CSS presence indicator (`status: "online" \| "offline" \| "warning"`, `label?`). |
| `StatusIcon` | Semantic status visual used by `NoticeBanner` (delegates to `StatusDot` / `Icon`). |
| `Button` | Primary/secondary/ghost/danger action (`size: "sm" \| "md"`, `leadingIcon?`, `loading?`, `block?`). Expands to `44×44` hit target on coarse pointers. |
| `IconButton` | Icon-only action (`icon`, required `label`, `variant`, `size`, `pressed?`, `badge?: number \| "dot"`). Expands to `44×44` hit target on coarse pointers. |
| `CountBadge` | Unread / numeric counter (`value`, `max = 99`, `variant: "solid" \| "dot"`, `label`). |
| `Tag` | Compact status/metadata pill (`tone`, `icon?`, optional `onClick` rendering a `<button>` for retry actions). |
| `ConfirmPanel` | Two-step confirmation box for destructive actions (`title`, `description?`, `tone`, `busy?`). Auto-focuses **Cancel** on mount. |
| `Menu` | Popover menu (`Menu`, `MenuSection`, `MenuItem`, `MenuSeparator`) with outside-click, `Escape`, focus restoration, and arrow/Home/End roving. |
| `Dialog` | Modal dialog (`size: "sm" \| "md" \| "fullscreen"`) with `role="dialog"`, `aria-modal="true"`, Tab focus trap, `Escape`/backdrop close, and focus restoration. |
| `Toast` / `ToastRegion` | Transient polite status announcement (`tone`, `message`, `durationMs = 2400`, optional `action`). |
| `NoticeBanner` | Inline status/warning/error callout (`tone`, `loading?`, optional dismiss action). |
| `ProgressBar` | Accessible `role="progressbar"` file transfer indicator (`percent`, `complete?`, `ariaLabel`). |
| `Tabs` | Segmented tab list (`ariaLabel`, `activeId`, `items`, `onChange`). |
| `TextField` | Labeled input with optional prompt sigil, hint, and `trailingSlot` (e.g. passphrase visibility `IconButton`). |
| `TerminalBox` | Framed panel container for centered Auth/Lobby forms. |
| `Byline` / `Subline` / `Divider` | Compact metadata separator (`·`), reply connector (`corner-down-right`), and horizontal hairline divider. |

### Unified Application Shell (`apps/web/src/features/shell/`)

- `AppTopBar` + `AccountMenu` provide one consistent single-row top bar across **Auth**, **Lobby**, and **Room**:
  - **Auth**: Brand (`❯ SimpleIM`, `❯` only at `<= 360px`) + `⋯` (`PreferenceControls`).
  - **Lobby**: Brand + `⋯` (`@username`, `PreferenceControls`, Sign Out, 2-step Wipe & Sign Out).
  - **Room**: Brand + Rooms drawer toggle + Room title + Connection `StatusDot` + Members/Files toggle + `⋯` (`@username`, `PreferenceControls`, 2-step Leave Room, Sign Out, 2-step Wipe & Sign Out).

---

## 5. Do's and Don'ts (Anti-Patterns)

| Anti-Pattern (Forbidden) | Correct Pattern | Enforcement |
| :--- | :--- | :--- |
| Native `<button>` in `apps/web/src/features/**/*.tsx` | Use `Button`, `IconButton`, or `Tag onClick` (rare exceptions require `// ds-allow-raw-button: <reason>`) | `tests/arch.test.ts` |
| Hardcoded colors (`#...`, `rgb(...)`), raw `font-size: <n>px`, numeric `line-height` / `font-weight` / `z-index`, `<n>ms`, px `border-radius`, or px `padding`/`margin`/`gap`/`inset` in `styles/*.css` | Reference semantic tokens from `tokens.css` (`0` / `1px` / `-1px` / `env(...)` whitelisted) | `tests/design-tokens.test.ts` |
| Using `--text-decorative` on readable copy or referencing removed `--text-dim` | Use `--text-muted` for readable secondary text; `--text-decorative` is whitelisted to `.ds-byline-sep` and `.ds-subline-glyph` | `tests/design-tokens.test.ts` |
| Color emojis (`👥`, `☁️`, `⚠️`, etc.) in TSX or i18n dictionaries | Use `<Icon name="..." />` or `<StatusDot />` | `apps/web/tests/web.test.ts` & `e2e/web-cli-interop.pw.ts` |
| Importing business hooks/state/features into `design-system/` or `preview/` | Keep `design-system/` pure (`react` & `./` only) and `preview/` isolated to `design-system/`, `theme/`, `i18n/` | `tests/arch.test.ts` |
| Single-click destructive actions (Leave Room / Wipe Cache) | Wrap destructive actions inside `ConfirmPanel` (Cancel focused by default) | `AccountMenu` & E2E tests |
| Duplicating light theme tokens in `@media (prefers-color-scheme: light)` | Keep `:root[data-theme="light"]` as the sole light-theme definition backed by `public/theme-init.js` | `tests/design-tokens.test.ts` |
| Calling `scrollIntoView()` inside `MessageTranscript` | Use container-local `scrollTop` math to avoid shifting iOS Safari `.room-shell` | `MessageTranscript` & E2E tests |

---

## 6. Local Component Preview Gallery (Dev-Only)

Run the Vite dev server and open the standalone component preview entry:

```sh
bun run --cwd apps/web dev
# Open http://localhost:5173/preview.html
```

- Showcases the complete dark/light color palette with WCAG contrast annotations, typography/spacing/radii/z-index/motion scales, all 31 icons, and every `design-system/` primitive across variants, sizes, and interactive states (including simulated Desktop vs. Coarse-Touch target modes).
- `apps/web/preview.html` is **excluded from production builds** (`bun run build:web` only emits `index.html` and app assets; verified automatically by tests).
