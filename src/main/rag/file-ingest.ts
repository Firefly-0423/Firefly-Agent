import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ImportedDocumentChunk, ImportedDocumentResult } from "./index";

// ───────────── 对外类型 ─────────────

export type AttachmentKind = "document" | "image" | "unsupported" | "empty" | "indexed" | "text";

/** 附件的各种形态，用 kind 区分；filePath / mime 在多数形态下可选。 */
export type Attachment =
  | { kind: "document"; name: string; filePath: string; mime?: string; status: "pending" | "done" | "error" }
  | { kind: "image"; name: string; filePath: string; mime?: string; status: "pending"; previewUrl?: string; caption?: string }
  | { kind: "unsupported"; name: string; reason: string; filePath?: string; mime?: string; status?: "error" }
  | { kind: "empty"; name: string; filePath?: string; mime?: string }
  | { kind: "text"; name: string; text: string; filePath?: string; mime?: string }
  | {
    kind: "indexed"; name: string; chunks: number; importId?: string; cached?: boolean;
    filePath?: string; mime?: string; reason?: string; retrievedChunks?: ImportedDocumentChunk[];
  };

/** 大文件索引时由调用方（index.ts）注入的导入实现（importDocument）的相关类型。 */
export type DocumentImportProgress = {
  status: "chunking" | "embedding" | "cached";
  completedChunks?: number;
  totalChunks?: number;
};
export type DocumentImportControl = {
  isCancelled?: () => boolean;
  onProgress?: (progress: DocumentImportProgress) => void;
};
export type ImportFn = (text: string, fileName: string, control?: DocumentImportControl) => Promise<ImportedDocumentResult>;
export type SearchImportedChunksFn = (query: string, importIds: string[], topK?: number) => Promise<ImportedDocumentChunk[]>;
export type DocumentImportOptions = {
  importDocument: ImportFn;
  getCachedImport?: (text: string) => Promise<Pick<ImportedDocumentResult, "importId" | "chunkCount"> | null>;
  putCachedImport?: (text: string, fileName: string, imported: ImportedDocumentResult) => Promise<void>;
  isCancelled?: () => boolean;
  onProgress?: (progress: DocumentImportProgress) => void;
};
export type DocumentImport = DocumentImportOptions | ImportFn;

/** 小文件与大文件（走 RAG）的字符数分界。 */
export const SMALL_THRESHOLD = 30_000;

// ───────────── 扩展名分类 ─────────────

const extSet = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

const TEXT_EXTS = extSet(`
  .txt .md .markdown .json .csv .tsv .log .xml .yaml .yml
  .js .mjs .ts .tsx .jsx .py .java .c .cpp .cc .h .hpp
  .rs .go .rb .php .sh .bash .css .scss .sql
  .ini .conf .toml .env .svg .html .htm
`);

export const IMAGE_EXTS = extSet(".png .jpg .jpeg .gif .bmp .webp");

const UNSUPPORTED_EXTS = extSet(`
  .zip .7z .rar .tar .gz
  .pdf .doc .docx .xls .xlsx .ppt .pptx
  .png .jpg .jpeg .gif .bmp .webp .ico
  .mp3 .mp4 .wav .avi .mov
  .exe .dll .so .dylib .bin
  .class .jar .pyc .o .a .wasm
`);

const IMAGE_MIME_BY_EXT = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".webp", "image/webp"],
]);

export const isTextExt = (ext: string): boolean => TEXT_EXTS.has(ext.toLowerCase());

export const isImageExt = (ext: string): boolean => IMAGE_EXTS.has(ext.toLowerCase());

export function getMimeFromExt(ext: string): string {
  return IMAGE_MIME_BY_EXT.get(ext.toLowerCase()) ?? "application/octet-stream";
}

export const isUnsupportedExt = (ext: string): boolean => UNSUPPORTED_EXTS.has(ext.toLowerCase());

export function isDocumentExt(ext: string): boolean {
  const lower = ext.toLowerCase();
  return lower === "" || isTextExt(lower);
}

/** 拖入时的待处理附件：图片以扩展名或 MIME 判定，与渲染端预览保持一致。 */
export function describePendingAttachment(filePath: string, mime?: string): Attachment {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const imageByExt = isImageExt(ext);

  if (imageByExt || (typeof mime === "string" && mime.startsWith("image/"))) {
    return {
      name,
      kind: "image",
      filePath,
      // 有扩展名时以扩展名为准；截图工具产物没有扩展名，退回调用方给的 MIME
      mime: imageByExt ? getMimeFromExt(ext) : (mime ?? getMimeFromExt(ext)),
      previewUrl: pathToFileURL(filePath).toString(),
      status: "pending",
    };
  }
  if (isDocumentExt(ext)) {
    return { name, kind: "document", filePath, status: "pending" };
  }
  const shownExt = ext || "（无扩展名）";
  return { name, kind: "unsupported", filePath, status: "error", reason: `暂不支持的文件格式 ${shownExt}` };
}

const BINARY_SCAN_BYTES = 8192;

/** 前 8KB 内出现 NUL 字节即视为二进制。 */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SCAN_BYTES).includes(0);
}

// ───────────── 大文本索引 ─────────────

const cancelledAttachment = (name: string): Attachment => ({ name, kind: "indexed", chunks: 0, reason: "cancelled" });

async function indexLargeText(text: string, name: string, documentImport: DocumentImport): Promise<Attachment> {
  const opts: DocumentImportOptions =
    typeof documentImport === "function" ? { importDocument: documentImport } : documentImport;

  if (opts.isCancelled?.()) return cancelledAttachment(name);

  if (opts.getCachedImport) {
    try {
      const hit = await opts.getCachedImport(text);
      if (hit) {
        opts.onProgress?.({ status: "cached", completedChunks: hit.chunkCount, totalChunks: hit.chunkCount });
        return { name, kind: "indexed", chunks: hit.chunkCount, importId: hit.importId, cached: true };
      }
    } catch (err) {
      console.warn("[RAG] document cache lookup failed:", err);
    }
  }

  try {
    const control: DocumentImportControl = { isCancelled: opts.isCancelled, onProgress: opts.onProgress };
    const wantsControl = Boolean(control.isCancelled || control.onProgress);
    const imported = wantsControl
      ? await opts.importDocument(text, name, control)
      : await opts.importDocument(text, name);

    if (opts.isCancelled?.()) return cancelledAttachment(name);

    if (opts.putCachedImport) {
      try {
        await opts.putCachedImport(text, name, imported);
      } catch (err) {
        console.warn("[RAG] document cache write failed:", err);
      }
    }
    const { chunkCount, importId } = imported;
    return { name, kind: "indexed", chunks: chunkCount, importId };
  } catch (err: any) {
    const reason = err?.message || String(err);
    return { name, kind: "indexed", chunks: 0, reason };
  }
}

// ───────────── 单文件摄入 ─────────────

/**
 * 摄入一个文件。
 * @param filePath 绝对路径
 * @param documentImport 大文件时使用的导入实现（通常包装 importDocument）
 */
export async function ingestOneFile(filePath: string, documentImport: DocumentImport): Promise<Attachment> {
  const name = path.basename(filePath);

  let info: fs.Stats;
  try {
    info = fs.statSync(filePath);
  } catch (err: any) {
    return { name, kind: "unsupported", reason: err?.code || String(err) };
  }
  if (!info.isFile()) return { name, kind: "unsupported", reason: "不是文件" };

  const ext = path.extname(filePath).toLowerCase();
  if (isUnsupportedExt(ext)) {
    return { name, kind: "unsupported", reason: `暂不支持的文件格式 ${ext}（MVP-0 仅支持文本）` };
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err: any) {
    return { name, kind: "unsupported", reason: err?.code || String(err) };
  }

  if (isBinary(raw)) {
    // 文本扩展名却含 NUL 字节，和未知扩展名的二进制给不同提示
    const reason = isTextExt(ext) ? `文件 ${ext} 含二进制数据，暂不支持` : "二进制文件，暂不支持";
    return { name, kind: "unsupported", reason };
  }

  const text = raw.toString("utf-8");
  if (!text.trim()) return { name, kind: "empty" };
  if (text.length > SMALL_THRESHOLD) return indexLargeText(text, name, documentImport);
  return { name, kind: "text", text };
}

// ───────────── 目录遍历 ─────────────

/**
 * 递归列出目录下所有非隐藏文件的绝对路径；
 * 遇到无权限等异常就跳过对应条目，不抛出。
 */
export function walkDir(dirPath: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dirPath, entry);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) files.push(...walkDir(full));
        else if (st.isFile()) files.push(full);
      } catch {
        // 无权限或已被删除
      }
    }
  } catch {
    // 目录无法读取
  }
  return files;
}

// ───────────── 批量摄入 ─────────────

type PathEntry = { absPath: string; displayName: string };

/**
 * 批量摄入文件或目录：目录展开后逐个处理，并按 realpath 去重。
 */
export async function ingestPaths(paths: string[], documentImport: DocumentImport): Promise<Attachment[]> {
  // 展开目录；显示名为相对于输入目录的路径
  const expanded: PathEntry[] = [];
  for (const input of paths) {
    try {
      const st = fs.statSync(input);
      if (st.isDirectory()) {
        for (const child of walkDir(input)) {
          expanded.push({ absPath: child, displayName: path.relative(input, child) });
        }
      } else if (st.isFile()) {
        expanded.push({ absPath: input, displayName: path.basename(input) });
      }
    } catch {
      // 路径不存在
    }
  }

  const visited = new Set<string>();
  const unique: PathEntry[] = [];
  for (const entry of expanded) {
    let real: string;
    try {
      real = fs.realpathSync(entry.absPath);
    } catch {
      continue; // 失效的符号链接
    }
    if (visited.has(real)) continue;
    visited.add(real);
    unique.push({ ...entry, absPath: real });
  }

  const attachments: Attachment[] = [];
  for (const { absPath, displayName } of unique) {
    const attachment = await ingestOneFile(absPath, documentImport);
    attachments.push({ ...attachment, name: displayName, filePath: absPath });
  }
  return attachments;
}

export async function processDocumentsForChat(
  filePaths: string[], query: string, documentImport: DocumentImport, searchImportedChunks: SearchImportedChunksFn,
): Promise<Attachment[]> {
  const failed = (filePath: string, reason: string): Attachment => ({
    name: path.basename(filePath),
    kind: "unsupported",
    filePath,
    status: "error",
    reason,
  });
  const out: Attachment[] = [];

  for (const filePath of filePaths) {
    try {
      const processed = await ingestPaths([filePath], documentImport);
      if (processed.length === 0) {
        out.push(failed(filePath, "文件不存在或无法读取"));
        continue;
      }

      for (const attachment of processed) {
        const canSearch = attachment.kind === "indexed" && attachment.importId && query.trim();
        if (canSearch) {
          try {
            attachment.retrievedChunks = await searchImportedChunks(query, [attachment.importId!]);
          } catch (err: any) {
            attachment.reason = err?.message || String(err);
          }
        }
        out.push(attachment);
      }
    } catch (err: any) {
      out.push(failed(filePath, err?.message || String(err)));
    }
  }
  return out;
}
