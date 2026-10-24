import * as path from "path";
import * as fs from "fs";
import type { ToolContext } from "../registry/tool-context";
import type { ToolDefinition } from "../registry/tool-registry";
import { readResponseBytes, withPublicResponse } from "../network-guard";

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const LOG_PREFIX = "[BuiltinTools]";
const DANGEROUS_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".lnk", ".jar", ".sh",
]);
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/x-icon": ".ico", "image/avif": ".avif",
  "application/pdf": ".pdf", "application/zip": ".zip", "application/x-7z-compressed": ".7z",
  "application/gzip": ".gz", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg",
  "video/mp4": ".mp4", "video/webm": ".webm", "text/plain": ".txt", "application/json": ".json",
};

function hasDangerousChars(name: string): boolean { return /[<>:"|?*]/.test(name); }

function resolveOutputPath(name: string, workspaceRoot?: string): string | null {
  const relativeName = path.normalize(name).replace(/\\/g, "/");
  if (relativeName.includes("..") || path.isAbsolute(relativeName)) return null;
  let base: string;
  if (workspaceRoot) base = path.resolve(workspaceRoot);
  else {
    const desktop = require("electron") as typeof import("electron");
    base = desktop.app.getPath("desktop");
  }
  const destination = path.resolve(base, relativeName);
  const offset = path.relative(base, destination);
  if (offset === ".." || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) return null;
  // Check every existing ancestor so links above missing directories cannot escape.
  try {
    const canonicalBase = fs.realpathSync(base);
    let current = base;
    let resolved = canonicalBase;
    for (const segment of offset.split(path.sep)) {
      current = path.join(current, segment);
      let exists = true;
      try { fs.lstatSync(current); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") return null;
        exists = false;
      }
      // An existing dangling link fails realpath rather than becoming a new path.
      resolved = exists ? fs.realpathSync(current) : path.join(resolved, segment);
      const relative = path.relative(canonicalBase, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    }
    return resolved;
  } catch { return null; }
}

function filenameFromUrl(address: string): string | null {
  try {
    const segments = new URL(address).pathname;
    const leaf = decodeURIComponent(segments.split("/").filter(Boolean).pop() || "");
    return !leaf || !leaf.includes(".") || leaf.startsWith(".") ? null : leaf;
  } catch { return null; }
}

async function executeDownloadFile(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const address = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(address)) return "[错误] url 必须以 http:// 或 https:// 开头";
  let name = String(input.filename || "").trim();
  if (!name) name = filenameFromUrl(address) || "";
  if (!name) name = "download";
  if (hasDangerousChars(name)) return "[错误] filename 含非法字符（<>:\"|?*）";
  const destination = resolveOutputPath(name, context?.resolvedWorkspaceRoot);
  if (!destination) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + name;
  if (DANGEROUS_EXTS.has(path.extname(destination).toLowerCase())) return "[错误] 禁止下载可执行/脚本文件: " + path.extname(destination);
  console.log(LOG_PREFIX, "download_file:", address, "->", destination);
  const deadline = new AbortController();
  const idle = setTimeout(() => deadline.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  const cancellation = context?.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
  try {
    return await withPublicResponse(address, {
      signal: cancellation,
      headers: { "User-Agent": "Mozilla/5.0 (Firefly Agent) Chrome/120 Safari/537.36", Accept: "*/*" },
    }, async (response) => {
      if (!response.ok) return "[错误] HTTP " + response.status + " " + response.statusText;
      if (!response.body) return "[错误] 响应无内容（空 body）";
      const size = Number(response.headers.get("content-length") || 0);
      if (size && size > DOWNLOAD_MAX_BYTES) return `[错误] 文件过大：${size} 字节超过上限 ${DOWNLOAD_MAX_BYTES} 字节`;
      let target = destination;
      if (path.extname(destination) === "") {
        const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const suffix = CONTENT_TYPE_EXT[mime];
        if (!suffix) return "[错误] 无法确定文件扩展名（Content-Type: " + (mime || "未知") + "），请显式传入 filename 参数（如 cat.png）";
        target = destination + suffix;
      }
      const finalName = name + target.slice(destination.length);
      if (resolveOutputPath(finalName, context?.resolvedWorkspaceRoot) !== target) {
        return "[错误] 路径不合法（符号链接或目录联接超出工作区或已变化）";
      }
      try {
        fs.lstatSync(target);
        return "[错误] 目标文件已存在，请指定不同的 filename: " + finalName;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      const { bytes: contents } = await readResponseBytes(response, DOWNLOAD_MAX_BYTES, false, () => idle.refresh());
      const bytes = contents.length;
      const checked = resolveOutputPath(finalName, context?.resolvedWorkspaceRoot);
      if (!checked || checked !== target) return "[错误] 路径不合法（下载期间路径已变化）";
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });
      if (resolveOutputPath(finalName, context?.resolvedWorkspaceRoot) !== target) return "[错误] 路径不合法（目录已变化）";
      // Source: https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags
      fs.writeFileSync(target, contents, { flag: "wx" });
      const humanSize = bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MiB" : Math.round(bytes / 1024) + " KiB";
      console.log(LOG_PREFIX, "已下载:", target, `(${bytes} bytes)`);
      return `[download_file] 已保存：${target}（${humanSize}）`;
    });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "EEXIST") return "[错误] 目标文件已存在，请指定不同的 filename";
    const detail = failure instanceof Error ? failure.message : String(failure);
    return "[错误] 下载失败: " + detail;
  } finally { deadline.abort(); clearTimeout(idle); }
}

export const downloadFileTool: ToolDefinition = {
  "id": "download_file",
  "name": "下载文件",
  "description": "从 URL 下载文件（图片/压缩包/音频/PDF 等二进制）保存到本地磁盘，返回保存路径。下载的文件归用户使用，你只拿到路径。\n\n何时用：\n- 用户说'把这个图片存下来''下载这个链接的文件'\n- 对话或网页里出现图片 URL，用户想要本地副本\n- 需要获取文件本体（而不是读内容）时\n\n不要用于：\n- 想读网页/文档的文字内容 → 用 fetch_url（省 token）\n- 生成 Excel/Word/PDF/Markdown 文档 → 用 write_* 系列\n- 下载可执行文件（.exe/.bat 等，会被拒绝）\n\n参数：url (必填，完整 http(s) 地址)，filename (可选，保存的相对路径+文件名如 images/cat.png；缺省从 URL 推断，推断不出时按 Content-Type 补扩展名)。\n保存位置：绑定项目时存到项目目录，否则存到桌面。上限 64MiB。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "code",
    "work"
  ],
  "needsContext": true,
  "effectKind": "mutation",
  "verificationPolicy": "artifact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "要下载的完整 URL（必须包含 https:// 或 http://）"
      },
      "filename": {
        "type": "string",
        "description": "保存的相对路径+文件名（如 images/cat.png），可选"
      }
    },
    "required": [
      "url"
    ]
  },
  execute: executeDownloadFile,
};
