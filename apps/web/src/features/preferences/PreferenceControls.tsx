import type { ChangeEvent, ReactElement } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { isLocaleCode } from "../../i18n/registry.ts";
import { useTheme } from "../../theme/ThemeProvider.tsx";
import type { ThemeMode } from "../../theme/types.ts";

const THEME_ITEMS: readonly {
  readonly mode: ThemeMode;
  readonly labelKey:
    | "prefs.theme.system"
    | "prefs.theme.dark"
    | "prefs.theme.light";
  readonly testId: string;
}[] = [
  {
    mode: "system",
    labelKey: "prefs.theme.system",
    testId: "theme-mode-system",
  },
  {
    mode: "dark",
    labelKey: "prefs.theme.dark",
    testId: "theme-mode-dark",
  },
  {
    mode: "light",
    labelKey: "prefs.theme.light",
    testId: "theme-mode-light",
  },
];

export function PreferenceControls(): ReactElement {
  const { mode, setMode } = useTheme();
  const { locale, locales, setLocale, t } = useI18n();

  const handleLocaleChange = (ev: ChangeEvent<HTMLSelectElement>): void => {
    const raw = ev.target.value;
    if (isLocaleCode(raw)) {
      setLocale(raw);
    }
  };

  return (
    <div className="top-bar-group">
      <div
        className="theme-switcher"
        role="group"
        aria-label={t("prefs.themeAria")}
      >
        {THEME_ITEMS.map((item) => (
          <button
            key={item.mode}
            type="button"
            data-testid={item.testId}
            className="theme-switcher-btn"
            aria-pressed={mode === item.mode}
            onClick={() => setMode(item.mode)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <select
        data-testid="locale-select"
        className="ds-select"
        aria-label={t("prefs.languageAria")}
        value={locale}
        onChange={handleLocaleChange}
      >
        {locales.map((opt) => (
          <option key={opt.code} value={opt.code}>
            {opt.nativeLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
