// 用户表情包的本地存储：
// 元数据登记在 userData/sticker-manifest.json，图片放在 userData/stickers/ 目录

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { FIREFLY_STICKERS } from "../../shared/firefly-stickers";
import { isRetiredStickerId } from "../../shared/retired-stickers";
import { BUILT_IN_STICKER_IDS } from "../../shared/sticker-types";
import type { UserStickerMeta, StickerConfigItem } from "../../shared/sticker-types";
import { buildLocalStickerUrl } from "./sticker-protocol";

type StickerTable = Record<string, UserStickerMeta>;

type ManifestFile = {
  schemaVersion: number;
  stickers: StickerTable;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const owns = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

const isBuiltInId = (id: string): boolean => BUILT_IN_STICKER_IDS.includes(id as any);

export function getStickersDir(): string {
  return path.join(app.getPath("userData"), "stickers");
}

const manifestPath = (): string => path.join(app.getPath("userData"), "sticker-manifest.json");

export function loadUserStickerManifest(): StickerTable {
  try {
    const where = manifestPath();
    if (!fs.existsSync(where)) return {};
    const content = JSON.parse(fs.readFileSync(where, "utf8")) as ManifestFile;
    return content.stickers ?? {};
  } catch (err) {
    console.error("[stickers] load manifest failed:", err);
    return {};
  }
}

function saveUserStickerManifest(stickers: StickerTable): void {
  const where = manifestPath();
  fs.mkdirSync(path.dirname(where), { recursive: true });
  const content: ManifestFile = { schemaVersion: 1, stickers };
  fs.writeFileSync(where, JSON.stringify(content, null, 2), "utf8");
}

/** id 是否已被内置、已下架或用户表情包占用 */
export function isStickerIdTaken(id: string): boolean {
  return isBuiltInId(id) || isRetiredStickerId(id) || id in loadUserStickerManifest();
}

/** 添加用户表情包：把图片复制进 stickers 目录，并登记到 manifest */
export async function addUserSticker(
  sourceFilePath: string,
  id: string,
  description: string,
  phrases: string[],
): Promise<void> {
  if (isStickerIdTaken(id)) throw new Error(`表情包 ID "${id}" 已存在`);

  const ext = path.extname(sourceFilePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error(`不支持的图片格式: ${ext}`);

  const targetDir = getStickersDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const file = `${id}${ext}`;
  fs.copyFileSync(sourceFilePath, path.join(targetDir, file));

  const manifest = loadUserStickerManifest();
  manifest[id] = { id, file, description, phrases, createdAt: Date.now() };
  saveUserStickerManifest(manifest);
}

/** 删除用户表情包：先删图片文件，再从 manifest 中移除 */
export async function deleteUserSticker(id: string): Promise<void> {
  const manifest = loadUserStickerManifest();
  if (isBuiltInId(id) && !owns(manifest, id)) {
    throw new Error(`内置表情包 "${id}" 不能删除，只能禁用`);
  }

  const meta = manifest[id];
  if (!meta) throw new Error(`表情包 "${id}" 不存在`);

  try {
    fs.unlinkSync(path.join(getStickersDir(), meta.file));
  } catch {
    // 文件可能已被手动删掉，忽略
  }

  delete manifest[id];
  saveUserStickerManifest(manifest);
}

/** 汇总当前内置与用户表情包的配置，沿用已保存的启用开关 */
export function getAllStickerConfig(stickerSettings: Record<string, boolean>): StickerConfigItem[] {
  const manifest = loadUserStickerManifest();
  const isOn = (id: string): boolean => stickerSettings[id] !== false;
  const result: StickerConfigItem[] = [];

  for (const sticker of FIREFLY_STICKERS) {
    if (owns(manifest, sticker.id)) continue;
    result.push({
      id: sticker.id,
      src: `/stickers/${sticker.file}`,
      enabled: isOn(sticker.id),
      builtIn: true,
      description: sticker.phrases.join("，"),
    });
  }

  for (const [id, meta] of Object.entries(manifest)) {
    const label = meta.phrases.length > 0 ? meta.phrases.join("，") : meta.description;
    result.push({ id, src: getLocalStickerUrl(meta.file), enabled: isOn(id), builtIn: false, description: label });
  }

  return result;
}

/** 用户表情包图片的本地协议 URL */
export function getLocalStickerUrl(file: string): string {
  return buildLocalStickerUrl(file);
}

/** 用户表情包文件在磁盘上的路径 */
export function getUserStickerFilePath(file: string): string {
  return path.join(getStickersDir(), file);
}
