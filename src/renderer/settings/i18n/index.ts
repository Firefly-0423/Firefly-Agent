import { initWindowI18n } from "../../i18n-runtime";
import chineseCopy from "./zh-CN.json";
import englishCopy from "./en.json";

// 设置页使用独立词典，复用窗口语言生命周期。
const settingsResources = {
  en: { translation: englishCopy }, "zh-CN": { translation: chineseCopy },
};
initWindowI18n({ resources: settingsResources, fallbackLng: "zh-CN", lng: "zh-CN" });

export {
  t, useTranslation, setLocale, subscribeLocaleChanged, applyTranslations,
} from "../../i18n-runtime";
