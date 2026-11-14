import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  applyResolvedThemeToDocument,
  detectSystemPrefersDark,
  nextThemeMode,
  readStoredThemeMode,
  resolveEffectiveTheme,
  writeStoredThemeMode,
} from "./theme-engine.ts";
import type { ResolvedTheme, ThemeMode } from "./types.ts";

export interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (next: ThemeMode) => void;
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [mode, setModeState] = useState<ThemeMode>(
    () => readStoredThemeMode() ?? "system",
  );
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    detectSystemPrefersDark(),
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (ev: MediaQueryListEvent): void => {
      setSystemDark(ev.matches);
    };
    setSystemDark(mql.matches);
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);

  const resolvedTheme = useMemo(
    () => resolveEffectiveTheme(mode, systemDark),
    [mode, systemDark],
  );

  useEffect(() => {
    applyResolvedThemeToDocument(resolvedTheme);
  }, [resolvedTheme]);

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next);
    writeStoredThemeMode(next);
  }, []);

  const cycleMode = useCallback((): void => {
    setModeState((prev) => {
      const next = nextThemeMode(prev);
      writeStoredThemeMode(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedTheme,
      setMode,
      cycleMode,
    }),
    [mode, resolvedTheme, setMode, cycleMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
