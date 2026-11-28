import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/design-system.css";
import "../styles/preview.css";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import { ThemeProvider } from "../theme/ThemeProvider.tsx";
import {
  applyResolvedThemeToDocument,
  detectSystemPrefersDark,
  readStoredThemeMode,
  resolveEffectiveTheme,
} from "../theme/theme-engine.ts";
import { Gallery } from "./Gallery.tsx";

applyResolvedThemeToDocument(
  resolveEffectiveTheme(
    readStoredThemeMode() ?? "system",
    detectSystemPrefersDark(),
  ),
);

const rootEl = document.getElementById("preview-root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <ThemeProvider>
        <I18nProvider>
          <Gallery />
        </I18nProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
