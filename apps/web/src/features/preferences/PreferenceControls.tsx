import type { ChangeEvent, ReactElement } from "react";
import { Icon, IconButton, type IconName } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { isLocaleCode } from "../../i18n/registry.ts";
import { useTheme } from "../../theme/ThemeProvider.tsx";
import type { ThemeMode } from "../../theme/types.ts";

const THEME_ITEMS: readonly {
  readonly mode: ThemeMode;
  readonly icon: IconName;
  readonly labelKey:
    | "prefs.theme.system"
    | "prefs.theme.dark"
    | "prefs.theme.light";
  readonly testId: string;
}[] = [
  {
    mode: "system",
    icon: "monitor",
    labelKey: "prefs.theme.system",
    testId: "theme-mode-system",
  },
  {
    mode: "dark",
    icon: "moon",
    labelKey: "prefs.theme.dark",
    testId: "theme-mode-dark",
  },
  {
    mode: "light",
    icon: "sun",
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
    <div className="prefs-stack">
      <div
        className="theme-switcher"
        role="group"
        aria-label={t("prefs.themeAria")}
      >
        {THEME_ITEMS.map((item) => (
          <IconButton
            key={item.mode}
            icon={item.icon}
            size="sm"
            variant="ghost"
            label={t(item.labelKey)}
            pressed={mode === item.mode}
            testId={item.testId}
            className="theme-switcher-btn"
            onClick={() => setMode(item.mode)}
          />
        ))}
      </div>

      <div className="locale-select-row">
        <Icon name="languages" size={16} className="locale-select-icon" />
        <select
          data-testid="locale-select"
          className="ds-select locale-select-control"
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
    </div>
  );
}
