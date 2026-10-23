export type LocaleContext = {
  asrLanguage?: string;
  memoryLanguage: string;
  responseLanguage: string;
  weatherLanguage: string;
  dateLocale: string;
  uiLocale: string;
};

const initialLocale: LocaleContext = {
  uiLocale: "zh-CN", dateLocale: "zh-CN", weatherLanguage: "zh",
  responseLanguage: "zh-CN", memoryLanguage: "zh-CN", asrLanguage: "zh",
};
const activeLocale: LocaleContext = { ...initialLocale };

function cleanSetting(input: unknown, standard: string): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  return standard;
}

function languagePrefix(tag: string, supported: readonly string[]): string {
  const folded = tag.toLowerCase();
  return supported.find((prefix) => folded.startsWith(prefix)) ?? "en";
}

export function updateLocaleContext(patch: Partial<LocaleContext>): void {
  if (patch.uiLocale !== undefined) {
    const selectedUi = cleanSetting(patch.uiLocale, initialLocale.uiLocale);
    activeLocale.uiLocale = selectedUi;
    if (patch.weatherLanguage === undefined) {
      activeLocale.weatherLanguage = languagePrefix(selectedUi, ["zh", "en", "ja", "ko"]);
    }
    if (patch.memoryLanguage === undefined) activeLocale.memoryLanguage = selectedUi;
    if (patch.asrLanguage === undefined) {
      activeLocale.asrLanguage = languagePrefix(selectedUi, ["zh", "en"]);
    }
  }
  for (const field of ["dateLocale", "weatherLanguage", "responseLanguage", "memoryLanguage"] as const) {
    if (patch[field] !== undefined) activeLocale[field] = cleanSetting(patch[field], initialLocale[field]);
  }
  if (patch.asrLanguage !== undefined) {
    activeLocale.asrLanguage = cleanSetting(patch.asrLanguage, initialLocale.asrLanguage ?? "zh");
  }
}

export function getLocaleContext(): Readonly<LocaleContext> { return activeLocale; }
export function getDateLocale(): string { return activeLocale.dateLocale; }
export function getWeatherLanguage(): string { return activeLocale.weatherLanguage; }
export function getMemoryLanguage(): string { return activeLocale.memoryLanguage; }
export function getAsrLanguage(): string | undefined { return activeLocale.asrLanguage; }
