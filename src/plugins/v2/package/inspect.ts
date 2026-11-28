import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILE_NAME, validateManifest } from "../../../shared/plugin-manifest";
import type { ManifestError, PluginManifestV1 } from "../../../shared/plugin-manifest";
import { checkPackageBoundary } from "./boundary";

export type InspectResult =
  | { ok: true; manifest: PluginManifestV1; files: string[]; errors: [] }
  | { ok: false; manifest?: undefined; files?: undefined; errors: ManifestError[] };

function fail(code: ManifestError["code"], message: string): InspectResult {
  return { ok: false, errors: [{ code, path: "", message }] };
}

/** 读取并校验一个插件包目录：清单结构 + 包边界。清单不合法时不再检查文件。 */
export async function inspectPackage(dir: string, options: { hostVersion: string }): Promise<InspectResult> {
  const root = path.resolve(dir);
  try {
    if (!(await stat(root)).isDirectory()) return fail("manifest_missing", `不是目录: ${dir}`);
  } catch {
    return fail("manifest_missing", `目录不存在: ${dir}`);
  }

  let text: string;
  try {
    text = await readFile(path.join(root, MANIFEST_FILE_NAME), "utf8");
  } catch {
    return fail("manifest_missing", `找不到 ${MANIFEST_FILE_NAME}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return fail("manifest_json", `${MANIFEST_FILE_NAME} 不是合法 JSON: ${(error as Error).message}`);
  }

  const result = validateManifest(data, options);
  if (!result.ok) return { ok: false, errors: result.errors };

  const boundary = await checkPackageBoundary(root, result.manifest);
  if (boundary.errors.length > 0) return { ok: false, errors: boundary.errors };
  return { ok: true, manifest: result.manifest, files: boundary.files, errors: [] };
}
