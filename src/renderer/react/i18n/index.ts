import i18next from "i18next";
import { useSyncExternalStore, useCallback } from "react";
import english from "./en.json";
import chinese from "./zh-CN.json";

export const UI_LOCALE_FALLBACK = "zh-CN";

void i18next.init({
  lng: UI_LOCALE_FALLBACK, fallbackLng: UI_LOCALE_FALLBACK,
  resources: { en: { translation: english }, "zh-CN": { translation: chinese } },
  interpolation: { escapeValue: false }, parseMissingKeyHandler: (missing) => missing,
});

export async function initUiLocale(): Promise<void> {
  try {
    const preferences = await window.chat?.getGeneralSettings?.();
    const chosen = preferences?.language;
    if (typeof chosen === "string" && chosen.trim() && chosen !== UI_LOCALE_FALLBACK) {
      await i18next.changeLanguage(chosen.trim());
    }
  } catch { return; }
}

export function setUiLocale(locale: string): void {
  if (!locale.trim()) return;
  void i18next.changeLanguage(locale.trim());
}

export const t = i18next.t.bind(i18next);

function subscribe(notify: () => void): () => void {
  i18next.on("languageChanged", notify);
  return () => { i18next.off("languageChanged", notify); };
}

export function useTranslation() {
  const language = useSyncExternalStore(subscribe, () => i18next.language, () => i18next.language);
  const lookup = useCallback((key: string, options?: Record<string, unknown>) => i18next.t(key, options), [language]);
  return { t: lookup, locale: language };
}
