import { useCallback, useSyncExternalStore } from "react";
import i18next, { type Resource, type i18n as I18nInstance } from "i18next";

export interface WindowI18nOptions {
  lng?: string;
  fallbackLng?: string;
  resources: Resource;
}

let hasStarted = false;
export function initWindowI18n(options: WindowI18nOptions): I18nInstance {
  if (!hasStarted) {
    hasStarted = true;
    const initialLanguage = options.lng ?? options.fallbackLng ?? "zh-CN";
    void i18next.init({
      lng: initialLanguage,
      fallbackLng: options.fallbackLng ?? "zh-CN",
      resources: options.resources,
      interpolation: { escapeValue: false },
      parseMissingKeyHandler: (missing) => missing,
    });
  }
  return i18next;
}

export const t: I18nInstance["t"] = i18next.t.bind(i18next);
export function getLocale(): string { return i18next.language; }
export function setLocale(locale: string): void {
  if (!locale.trim()) return;
  void i18next.changeLanguage(locale.trim());
}
export function subscribeLocaleChanged(onChange: (locale: string) => void): () => void {
  const relay = (language: string) => onChange(language);
  i18next.on("languageChanged", relay);
  return () => { i18next.off("languageChanged", relay); };
}

export function applyTranslations(rootEl: ParentNode = document): () => void {
  function refresh(): void {
    const operations: Array<[string, (element: HTMLElement, key: string) => void]> = [
      ["data-i18n", (element, key) => { element.textContent = t(key); }],
      ["data-i18n-placeholder", (element, key) => {
        if ("placeholder" in element) (element as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key);
      }],
      ["data-i18n-title", (element, key) => { element.title = t(key); }],
      ["data-i18n-aria-label", (element, key) => { element.setAttribute("aria-label", t(key)); }],
    ];
    for (const [attribute, write] of operations) {
      rootEl.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((element) => {
        const translationKey = element.getAttribute(attribute);
        if (translationKey) write(element, translationKey);
      });
    }
  }
  refresh();
  return subscribeLocaleChanged(refresh);
}

export function useTranslation() {
  const locale = useSyncExternalStore(subscribeLocaleChanged, getLocale, getLocale);
  const translate = useCallback((key: string, options?: Record<string, unknown>) => i18next.t(key, options), [locale]);
  return { t: translate, locale };
}
