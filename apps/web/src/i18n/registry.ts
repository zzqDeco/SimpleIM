import { en } from "./locales/en.ts";
import { es } from "./locales/es.ts";
import { ja } from "./locales/ja.ts";
import { ko } from "./locales/ko.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { zhTW } from "./locales/zh-TW.ts";
import {
  LOCALE_CODES,
  LOCALE_STORAGE_KEY,
  type InterpolationParams,
  type LocaleCode,
  type LocaleOption,
  type TranslationKey,
  type TranslationSchema,
} from "./types.ts";

export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { code: "zh-CN", nativeLabel: "简体中文" },
  { code: "zh-TW", nativeLabel: "繁體中文" },
  { code: "en", nativeLabel: "English" },
  { code: "ja", nativeLabel: "日本語" },
  { code: "ko", nativeLabel: "한국어" },
  { code: "es", nativeLabel: "Español" },
];

export const TRANSLATIONS: Readonly<Record<LocaleCode, TranslationSchema>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  ja,
  ko,
  es,
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isLocaleCode(value: unknown): value is LocaleCode {
  return (
    typeof value === "string" &&
    (LOCALE_CODES as readonly string[]).includes(value)
  );
}

export function matchLanguageTag(rawTag: string): LocaleCode | null {
  const normalized = rawTag.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("zh")) {
    if (
      normalized.includes("-tw") ||
      normalized.includes("-hk") ||
      normalized.includes("-mo") ||
      normalized.includes("-hant")
    ) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  if (normalized === "ja" || normalized.startsWith("ja-")) {
    return "ja";
  }
  if (normalized === "ko" || normalized.startsWith("ko-")) {
    return "ko";
  }
  if (normalized === "es" || normalized.startsWith("es-")) {
    return "es";
  }
  return null;
}

export function detectBrowserLocale(
  navigatorLanguages?: readonly string[],
): LocaleCode {
  const candidates: string[] = [];
  if (navigatorLanguages && navigatorLanguages.length > 0) {
    candidates.push(...navigatorLanguages);
  } else if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      candidates.push(...navigator.languages);
    }
    if (typeof navigator.language === "string" && navigator.language.length > 0) {
      candidates.push(navigator.language);
    }
  }

  for (const tag of candidates) {
    const matched = matchLanguageTag(tag);
    if (matched !== null) {
      return matched;
    }
  }
  return "en";
}

export function readStoredLocale(storage?: StorageLike | null): LocaleCode | null {
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== "undefined"
          ? window.localStorage
          : null;
    if (!target) {
      return null;
    }
    const raw = target.getItem(LOCALE_STORAGE_KEY);
    return isLocaleCode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(
  locale: LocaleCode,
  storage?: StorageLike | null,
): void {
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== "undefined"
          ? window.localStorage
          : null;
    if (!target) {
      return;
    }
    target.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage quota or sandbox errors
  }
}

export function resolveInitialLocale(
  storage?: StorageLike | null,
  navigatorLanguages?: readonly string[],
): LocaleCode {
  return readStoredLocale(storage) ?? detectBrowserLocale(navigatorLanguages);
}

export function translate(
  locale: LocaleCode,
  key: TranslationKey,
  params?: InterpolationParams,
): string {
  const template = TRANSLATIONS[locale][key] ?? TRANSLATIONS.en[key];
  if (!params) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, token: string) => {
    const val = params[token];
    return val !== undefined ? String(val) : `{${token}}`;
  });
}
