import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { WorkReadScope } from "../../shared/chat-types";

export const WORK_READ_MAX_BYTES = 10 * 1024 * 1024;
export const WORK_READ_PAGE_LINES = 2000;

export function inspectWorkReadFile(filePath: string): WorkReadScope {
  if (!path.isAbsolute(filePath)) throw new Error("文件路径不是绝对路径");
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Error("选择项不是文件");
  if (stat.size > WORK_READ_MAX_BYTES) throw new Error("文件超过 read_file 的 10MB 上限，无法读取；请先缩小文件");
  const buffer = fs.readFileSync(realPath);
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  let nullCount = 0;
  for (const byte of head) if (byte === 0) nullCount++;
  if (head.length > 0 && nullCount > head.length * 0.05) throw new Error("所选文件不是可读取的文本");
  const text = buffer.toString("utf8");
  let totalLines = 1;
  for (const character of text) if (character === "\n") totalLines++;
  return {
    name: path.basename(realPath),
    path: realPath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    totalLines,
    endLine: totalLines,
    partialAccepted: false,
  };
}

export function isWorkReadScopeCurrent(scope: WorkReadScope): boolean {
  try {
    const current = inspectWorkReadFile(scope.path);
    return current.sha256 === scope.sha256 && current.totalLines === scope.totalLines;
  } catch {
    return false;
  }
}
