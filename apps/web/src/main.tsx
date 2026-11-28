import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/design-system.css";
import "./styles/workspace.css";
import { App } from "./App.tsx";
import {
  applyResolvedThemeToDocument,
  detectSystemPrefersDark,
  readStoredThemeMode,
  resolveEffectiveTheme,
} from "./theme/theme-engine.ts";

applyResolvedThemeToDocument(
  resolveEffectiveTheme(
    readStoredThemeMode() ?? "system",
    detectSystemPrefersDark(),
  ),
);

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
