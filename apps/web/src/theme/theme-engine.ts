import {
  THEME_MODES,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode,
} from "./types.ts";

export interface StorageReaderWriter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return (
    typeof value === "string" &&
    (THEME_MODES as readonly string[]).includes(value)
  );
}

export function readStoredThemeMode(
  storage?: StorageReaderWriter | null,
): ThemeMode | null {
  try {
    const target =
      storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (!target) return null;
    const raw = target.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredThemeMode(
  mode: ThemeMode,
  storage?: StorageReaderWriter | null,
): void {
  try {
    const target =
      storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (!target) return;
    target.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore restricted storage contexts
  }
}

export function detectSystemPrefersDark(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveEffectiveTheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

export function nextThemeMode(current: ThemeMode): ThemeMode {
  switch (current) {
    case "system":
      return "dark";
    case "dark":
      return "light";
    case "light":
      return "system";
  }
}

export function applyResolvedThemeToDocument(
  resolved: ResolvedTheme,
  doc?: Document | null,
): void {
  const target = doc ?? (typeof document !== "undefined" ? document : null);
  if (!target) return;
  target.documentElement.dataset.theme = resolved;
  const meta = target.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", resolved);
  }
}
