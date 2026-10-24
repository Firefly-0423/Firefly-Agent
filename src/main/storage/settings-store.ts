import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type UserProfile = {
  /** 性别：secret（保密）、male、female */
  gender: string;
  /** 默认城市：天气等需要定位的工具用它，留空时由模型向用户询问 */
  defaultCity: string;
  avatarPath: string;
  timezone: string;
  birthday: string;
  callPreference: string;
  nickname: string;
};

const BLANK = "";

// 键的顺序决定落盘 JSON 的字段顺序，不要调整
export const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: BLANK,
  callPreference: BLANK,
  birthday: BLANK,
  timezone: "Asia/Shanghai",
  avatarPath: BLANK,
  defaultCity: BLANK,
  gender: "secret",
};

const dataPath = (...parts: string[]): string => path.join(app.getPath("userData"), ...parts);

export const getSettingsPath = (): string => dataPath("model-settings.json");
export const getGeneralSettingsPath = (): string => dataPath("app-settings.json");
export const getUserProfilePath = (): string => dataPath("user-profile.json");
export const getAvatarPath = (): string => dataPath("avatar.png");
export const getRagStorePath = (): string => dataPath("rag-data", "memory-store.json");
export const getStickerSettingsPath = (): string => dataPath("sticker-settings.json");

export function loadUserProfile(): UserProfile {
  try {
    const location = getUserProfilePath();
    if (!fs.existsSync(location)) return DEFAULT_USER_PROFILE;
    const saved: Partial<UserProfile> = JSON.parse(fs.readFileSync(location, "utf8"));
    return Object.assign({}, DEFAULT_USER_PROFILE, saved);
  } catch {
    return DEFAULT_USER_PROFILE;
  }
}

export function saveUserProfile(profile: Partial<UserProfile>): UserProfile {
  const merged = Object.assign({}, loadUserProfile(), profile);
  const location = getUserProfilePath();
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
