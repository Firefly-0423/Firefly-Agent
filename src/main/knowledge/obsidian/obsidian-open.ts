/**
 * 通过 obsidian:// 深链在 Obsidian 中打开笔记，交由系统 shell 处理。
 */

import { shell } from "electron";

/** 拼出 obsidian://open 深链：vault 与 file 必为查询参数，若有标题路径则以最末一级作为锚点。 */
function buildOpenLink(vaultName: string, filePath: string, headingPath?: string[]): string {
  const query = `vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
  const anchor = headingPath && headingPath.length > 0 ? `#${encodeURIComponent(headingPath[headingPath.length - 1])}` : "";
  return `obsidian://open?${query}${anchor}`;
}

type OpenNoteInput = { filePath: string; vaultName: string; headingPath?: string[] };

/**
 * 打开指定 Vault 中的笔记。
 *
 * @param vaultName Vault 所在文件夹名
 * @param filePath Vault 内的相对路径
 * @param headingPath 可选的标题层级，只取最后一级用于定位
 */
export async function openNote(input: OpenNoteInput): Promise<void> {
  const { vaultName, filePath, headingPath } = input;
  const link = buildOpenLink(vaultName, filePath, headingPath);
  await shell.openExternal(link);
}
