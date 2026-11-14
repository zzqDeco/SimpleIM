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
  LOCALE_OPTIONS,
  resolveInitialLocale,
  translate,
  writeStoredLocale,
} from "./registry.ts";
import type {
  InterpolationParams,
  LocaleCode,
  LocaleOption,
  TranslateFn,
  TranslationKey,
} from "./types.ts";

export interface I18nContextValue {
  readonly locale: LocaleCode;
  readonly locales: readonly LocaleOption[];
  readonly setLocale: (next: LocaleCode) => void;
  readonly t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [locale, setLocaleState] = useState<LocaleCode>(() =>
    resolveInitialLocale(),
  );

  const setLocale = useCallback((next: LocaleCode): void => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  const t = useCallback<TranslateFn>(
    (key: TranslationKey, params?: InterpolationParams): string =>
      translate(locale, key, params),
    [locale],
  );

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.title = translate(locale, "app.title");
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      locales: LOCALE_OPTIONS,
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
