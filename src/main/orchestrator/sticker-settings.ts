import fs from "node:fs";
import path from "node:path";
import type { StickerConfigItem } from "../../shared/sticker-types";
import { getStickerSettingsPath } from "../settings-store";
import { getAllStickerConfig } from "../stickers/sticker-storage";

let cachedFlags: Record<string, boolean> | null = null;

function readFlags(): Record<string, boolean> {
  const location = getStickerSettingsPath();
  let decoded: Record<string, unknown> = {};
  try {
    if (fs.existsSync(location)) decoded = JSON.parse(fs.readFileSync(location, "utf8"));
  } catch (failure) {
    console.error("[StickerSettings] failed to load sticker settings:", failure);
  }
  const flags: Record<string, boolean> = {};
  Object.keys(decoded).forEach((key) => { flags[key] = decoded[key] !== false; });
  return flags;
}

export function loadStickerSettings(): Record<string, boolean> {
  if (cachedFlags === null) cachedFlags = readFlags();
  return cachedFlags;
}

export function saveStickerSettings(settings: Record<string, boolean>): Record<string, boolean> {
  const location = getStickerSettingsPath();
  const parent = path.dirname(location);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const flags = loadStickerSettings();
  Object.assign(flags, settings);
  fs.writeFileSync(location, JSON.stringify(flags, null, 2), "utf-8");
  cachedFlags = flags;
  return cachedFlags;
}

export function setStickerEnabled(id: string, enabled: boolean): Record<string, boolean> {
  const flags = loadStickerSettings();
  flags[id] = enabled;
  return saveStickerSettings(flags);
}

export function getStickerManagerConfig(): StickerConfigItem[] {
  const flags = loadStickerSettings();
  return getAllStickerConfig(flags);
}

export function clearStickerSettingsCache(): void { cachedFlags = null; }
