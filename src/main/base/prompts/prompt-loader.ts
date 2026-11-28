import * as fs from "node:fs";
import { findPromptPath } from "../storage/external-content-paths";

/**
 * 读取 prompts 目录下的 Markdown/文本文件。
 * 找不到或读取失败都返回空字符串，调用方不会因缺 prompt 而崩溃。
 */
export function loadPromptFile(filename: string): string {
  try {
    const located = findPromptPath(filename);
    return located ? fs.readFileSync(located, "utf8").trim() : "";
  } catch {
    return "";
  }
}
