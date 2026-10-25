import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { DEFAULT_CHAT_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../shared/timeout-types";

let remembered: TimeoutSettings | null = null;
const settingsFile = () => path.join(app.getPath("userData"), "timeout-settings.json");
function readSettings(): TimeoutSettings {
  try {
    const location = settingsFile();
    if (!fs.existsSync(location)) return { ...DEFAULT_TIMEOUT_SETTINGS };
    const decoded = JSON.parse(fs.readFileSync(location, "utf8")) as Partial<TimeoutSettings> | null;
    return { testTimeout: decoded?.testTimeout || 15000,
      chatRequestTimeout: decoded?.chatRequestTimeout || DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
      userChoiceTimeout: decoded?.userChoiceTimeout || 60000,
      profileMinimumRemainingBudgetMs: decoded?.profileMinimumRemainingBudgetMs || -1,
      modelRequestTimeoutSec: decoded?.modelRequestTimeoutSec };
  } catch (failure) {
    console.error("[Firefly] load settings failed:", failure);
    return { ...DEFAULT_TIMEOUT_SETTINGS };
  }
}
export function getTimeoutSettings(): TimeoutSettings {
  if (remembered === null) remembered = readSettings();
  return remembered;
}
export function saveTimeoutSettings(settings: Partial<TimeoutSettings>): TimeoutSettings {
  const shared = getTimeoutSettings();
  Object.assign(shared, settings);
  const location = settingsFile();
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, JSON.stringify(shared, null, 2), "utf8");
  return shared;
}
