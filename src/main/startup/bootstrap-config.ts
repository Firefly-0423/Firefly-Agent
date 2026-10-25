import type { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings } from "../settings/model-settings";
import { loadUserProfile } from "../storage/settings-store";
import { setSearchConfig, setUserTimezoneConfig, setWeatherConfig } from "../orchestrator/tools/built-in-tools";
import { setEmailConfig } from "../orchestrator/tools/email-tools";
import { setTravelConfig } from "../orchestrator/tools/travel-tools";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "../orchestrator/vendors/runtime-settings";
import { setChoiceCardSender, setChoiceDismissSender } from "../chat/user-choice";
import { setAsrConfig } from "../asr/asr-config";
import { reactChatWindow } from "../windows/window-state";

export type BootstrapConfigContext = { loadGeneralSettings: () => GeneralSettings };

function getReactChatWindow(): BrowserWindow | null {
  return reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow : null;
}
function sendChatCustomEvent(eventName: string, card: unknown, run?: { runId?: string }): void {
  const chat = getReactChatWindow();
  if (chat) chat.webContents.send(IPC.AGUI_EVENT, {
    type: "CUSTOM", name: eventName, value: card, ...(run?.runId ? { runId: run.runId } : {}),
  });
}

export function bootstrapConfigGetters(environment: BootstrapConfigContext): void {
  const { loadGeneralSettings: readSettings } = environment;
  const setting = <K extends keyof GeneralSettings>(key: K): (() => GeneralSettings[K]) => () => readSettings()[key];

  setVendorRuntimeSettingsGetter(() => resolveVendorRuntimeSettings(loadModelSettings()));
  setWeatherConfig(
    () => loadUserProfile().defaultCity,
    setting("weatherSource"), setting("amapKey"),
    (forecast, execution) => sendChatCustomEvent("firefly.weather", forecast, execution),
    setting("weatherEnabled"),
  );
  setUserTimezoneConfig(() => loadUserProfile().timezone);
  setChoiceCardSender((choice) => sendChatCustomEvent("firefly.choice", choice));
  setChoiceDismissSender((settled) => sendChatCustomEvent("firefly.choice.dismiss", settled));
  setSearchConfig(setting("searchEngine"), setting("searchBochaKey"), setting("searchTavilyKey"), setting("searchAnySearchKey"));
  setTravelConfig(setting("amapKey"), setting("travelEnabled"));
  setEmailConfig(
    setting("emailEnabled"), setting("emailSmtpHost"), setting("emailSmtpPort"), setting("emailSmtpSecure"),
    setting("emailSmtpUser"), setting("emailSmtpPass"), setting("emailFromName"),
  );
  setAsrConfig(() => {
    const preferences = readSettings();
    if (preferences.asrEngine === "mossland") return { engine: "mossland", apiKey: preferences.asrMosslandKey };
    if (preferences.asrEngine !== "aliyun") return null;
    return {
      engine: "aliyun", appKey: preferences.asrAliyunAppKey, accessKeyId: preferences.asrAliyunAccessKeyId,
      accessKeySecret: preferences.asrAliyunAccessKeySecret, language: preferences.asrLanguage,
    };
  });
}
