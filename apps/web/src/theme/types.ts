export const THEME_MODES = ["system", "dark", "light"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "simpleim.theme";
