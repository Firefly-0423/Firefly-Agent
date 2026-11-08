import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { WorkReadScope } from "../../shared/chat-types";
import { DocumentTextError, extractDocumentText, isExtractedDocumentExt, legacyDocumentReason } from "../rag/document-text";

export const WORK_READ_MAX_BYTES = 10 * 1024 * 1024;
export const WORK_READ_PAGE_LINES = 2000;

type FileIdentity = { realPath: string; buffer: Buffer; sha256: string };

function readIdentity(filePath: string): FileIdentity {
  if (!path.isAbsolute(filePath)) throw new Error("文件路径不是绝对路径");
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Error("选择项不是文件");
  if (stat.size > WORK_READ_MAX_BYTES) throw new Error("文件超过 read_file 的 10MB 上限，无法读取；请先缩小文件");
  const buffer = fs.readFileSync(realPath);
  return { realPath, buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function countLines(text: string): number {
  let totalLines = 1;
  for (const character of text) if (character === "\n") totalLines++;
  return totalLines;
}

function scopeOf(identity: FileIdentity, totalLines: number): WorkReadScope {
  return { name: path.basename(identity.realPath), path: identity.realPath, sha256: identity.sha256, totalLines, endLine: totalLines, partialAccepted: false };
}

function textLines(identity: FileIdentity): number {
  const head = identity.buffer.subarray(0, Math.min(identity.buffer.length, 4096));
  let nullCount = 0;
  for (const byte of head) if (byte === 0) nullCount++;
  if (head.length > 0 && nullCount > head.length * 0.05) throw new Error("所选文件不是可读取的文本");
  return countLines(identity.buffer.toString("utf8"));
}

/** Read scope of a plain text file. Office and PDF files need {@link inspectWorkReadDocument}. */
export function inspectWorkReadFile(filePath: string): WorkReadScope {
  const identity = readIdentity(filePath);
  const ext = path.extname(identity.realPath);
  const legacy = legacyDocumentReason(ext);
  if (legacy) throw new Error(legacy);
  if (isExtractedDocumentExt(ext)) throw new Error("WORK_READ_SCOPE_NEEDS_EXTRACTION");
  return scopeOf(identity, textLines(identity));
}

/** Read scope of any file read_file accepts; .docx/.xlsx/.pptx/.pdf count the lines of their extracted text. */
export async function inspectWorkReadDocument(filePath: string): Promise<WorkReadScope> {
  const identity = readIdentity(filePath);
  const ext = path.extname(identity.realPath);
  if (!isExtractedDocumentExt(ext)) return inspectWorkReadFile(filePath);
  let text: string;
  try {
    text = await extractDocumentText(identity.buffer, ext);
  } catch (error) {
    throw new Error(error instanceof DocumentTextError ? error.message : `无法读取这个 ${ext} 文件`);
  }
  return scopeOf(identity, countLines(text));
}

export function isWorkReadScopeCurrent(scope: WorkReadScope): boolean {
  try {
    const current = readIdentity(scope.path);
    if (current.sha256 !== scope.sha256) return false;
    // Extracted text is a pure function of the bytes, so an unchanged hash means unchanged lines.
    if (isExtractedDocumentExt(path.extname(current.realPath))) return true;
    return textLines(current) === scope.totalLines;
  } catch {
    return false;
  }
}
