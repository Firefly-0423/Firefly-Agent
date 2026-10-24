import { beginWriteBatch } from "./registry/file-write-evidence";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { toolRegistry, type VerificationPolicy } from "./registry/tool-registry";
import { captionImage } from "../vision-captioner";
import type { ToolContext } from "./registry/tool-context";
import type { ToolFileChange } from "../../../shared/chat-types";
import { buildFullFileDiff, buildReplacedDiff, countLines, finalizeFileChanges } from "./registry/tool-evidence";
import { checkOverwriteDrop, overwriteDropMessage } from "./overwrite-guard";
import { logger, LogTag } from "../../logger";
import { ToolExecutionError } from "./registry/tool-execution-error";
import { app } from "electron";
import { reviewTrackerFor } from "../review/review-tracker-access";
import { assertWorkspacePathFallback } from "./workspace-boundary";
import { readWorkspaceFile, listWorkspaceDirectory, withWorkspaceWrite, type WorkspaceSnapshot, type WorkspaceWriteLease } from "./workspace-handle";

const LOG_PREFIX = "[FsTools]";
const READ_MAX_BYTES = 10 * 1024 * 1024;
const LIST_MAX_ENTRIES = 200;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);
function absolutePath(value: string): string | null { return value && path.isAbsolute(value) ? path.normalize(value) : null; }
function statOrNull(location: string): fs.Stats | null { try { return fs.statSync(location); } catch { return null; } }
function observedStat(snapshot: WorkspaceSnapshot | undefined, location: string) {
  if (!snapshot) return statOrNull(location);
  return snapshot.exists ? { size: snapshot.size, isFile: () => snapshot.kind === "file", isDirectory: () => snapshot.kind === "directory" } : null;
}
function formatBytes(value: number): string {
  if (value < 1024) return value + "B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + "KB";
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + "MB";
  return (value / 1024 / 1024 / 1024).toFixed(2) + "GB";
}
function lineWindow(text: string, start: number, maximum: number): { rows: string[]; count: number } {
  const rows: string[] = [];
  let count = 1, current = 1, offset = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text.charCodeAt(cursor) !== 10) continue;
    if (current >= start && rows.length < maximum) {
      const end = cursor > offset && text.charCodeAt(cursor - 1) === 13 ? cursor - 1 : cursor;
      rows.push(text.slice(offset, end));
    }
    current++;
    count++;
    offset = cursor + 1;
  }
  if (current >= start && rows.length < maximum) rows.push(text.slice(offset));
  return { rows, count };
}
async function executeReadFile(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const supplied = String(args.path || "").trim(), location = absolutePath(supplied);
  if (!location) {
    console.log(LOG_PREFIX, "read_file 非绝对路径:", supplied, "cwd=", process.cwd());
    return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "path 必须是绝对路径: " + supplied, retryable: false });
  }
  const observed = await readWorkspaceFile(location, context, READ_MAX_BYTES);
  if (!observed) assertWorkspacePathFallback(location, "read", context);
  const entry = observedStat(observed, location);
  if (!entry) {
    console.log(LOG_PREFIX, "read_file 文件不存在:", location, "raw=", supplied, "cwd=", process.cwd());
    return JSON.stringify({ success: false, errorCode: "FILE_NOT_FOUND", error: "文件不存在或无法访问: " + location + "。不要重复读取相同路径，请先用 search_text 或 list_dir 重新定位文件。", retryable: true });
  }
  if (!entry.isFile()) return JSON.stringify({ success: false, errorCode: "NOT_A_FILE", error: "不是文件（是目录或其它）: " + location, retryable: false });
  let canonical: string;
  try { canonical = observed ? observed.canonicalPath! : fs.realpathSync(location); }
  catch { return JSON.stringify({ success: false, errorCode: "FILE_CHANGED", error: "文件在读取前发生变化", retryable: false }); }
  const confirmed = context?.workReadScopes?.find(scope => scope.path === canonical);
  if (!confirmed && context?.workReadScopes?.some(scope => scope.path === location)) return JSON.stringify({ success: false, errorCode: "FILE_CHANGED", error: "文件身份已变化，确认范围失效", retryable: false });
  const start = Math.max(1, Math.floor(Number(args.startLine) || 1));
  const requested = Math.max(1, Math.min(2000, Math.floor(Number(args.maxLines) || 500)));
  if (confirmed && start > confirmed.endLine) return JSON.stringify({ success: false, errorCode: "OUTSIDE_CONFIRMED_RANGE", error: "请求行号超出用户确认的读取范围", retryable: false });
  const maximum = confirmed ? Math.min(requested, confirmed.endLine - start + 1) : requested;
  console.log(LOG_PREFIX, "read_file:", location, "size=" + formatBytes(entry.size), "lines=" + start + "..+" + maximum);
  let bytes: Buffer;
  try { bytes = observed ? observed.bytes ?? Buffer.alloc(0) : fs.readFileSync(location); }
  catch (failure) { return JSON.stringify({ success: false, errorCode: "READ_FAILED", error: "读取失败: " + errorText(failure), retryable: false }); }
  if (bytes.length > READ_MAX_BYTES || (observed && observed.size > READ_MAX_BYTES)) return JSON.stringify({ success: false, errorCode: "FILE_TOO_LARGE",
    error: `文件超过 ${formatBytes(READ_MAX_BYTES)}（当前 ${formatBytes(entry.size)}），read_file 暂不支持读取。可用 search_text 直接获取匹配行的上下文。`,
    path: location, size: formatBytes(entry.size), retryable: false });
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (confirmed && (digest !== confirmed.sha256 || entry.size !== bytes.length)) return JSON.stringify({ success: false, errorCode: "FILE_CHANGED", error: "文件内容已变化，确认范围失效", retryable: false });
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096));
  let zeroes = 0;
  for (let index = 0; index < prefix.length; index++) if (prefix[index] === 0) zeroes++;
  if (zeroes > prefix.length * 0.05) return JSON.stringify({ success: false, errorCode: "BINARY_FILE",
    error: "这看起来是二进制文件，read_file 只支持文本。如果是图片，请改用 read_image。", path: location, size: formatBytes(entry.size), retryable: false });
  const text = bytes.toString("utf8"), selected = lineWindow(text, start, maximum);
  const end = start + selected.rows.length - 1;
  const response = { path: location, canonicalPath: canonical, startLine: start, endLine: end, totalLines: selected.count, sha256: digest,
    content: selected.rows.map((row, index) => String(start + index).padStart(5, " ") + " | " + row).join("\n"),
    truncated: false, ...(confirmed && requested > maximum ? { scopeLimited: true } : {}) };
  console.log(LOG_PREFIX, "read_file 完成: lines=" + start + ".." + end + "/" + selected.count);
  return JSON.stringify(response);
}
toolRegistry.register({
  id: "read_file",   name: "读取文件",
  description: "读取本地文本文件（小说、笔记、代码、配置、日志等）。返回带行号的文本内容。" + "支持最大 10MB 的文本文件；totalLines 是真实总行数，可用 startLine/maxLines 精确翻页。\n" + "文件超过 10MB 会明确报错，改用 search_text 直接获取匹配行的上下文。\n\n" + "何时用：\n" + "- 用户消息里出现任何本地文件路径、文件名、扩展名（.txt/.md/.json/.py/.log 等）\n" + "- 用户问'这个文件写了什么''看看 xxx'\n" + "- 需要拿文件实际内容才能回答的问题\n\n" + "不要用于：\n" + "- 凭印象猜内容（绝对不行，必须先 read）\n" + "- 读图片 → read_image\n" + "- 列目录 → list_dir\n\n" + "参数：path (必填，绝对路径)，startLine (可选，默认 1)，maxLines (可选，默认 500)。",   enabled: true,
  risk: "fs-read",   modes: ["code", "work"],
  effectKind: "read" as const,   isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,   inputSchema: { type: "object", properties: { path: { type: "string", description: "要读的文件绝对路径，例如 'C:\\\\Users\\\\me\\\\notes.txt'" }, startLine: { type: "number", description: "起始行号，默认 1" }, maxLines: { type: "number", description: "最多读多少行，默认 500，最大 2000" }, }, required: ["path"], },
  execute: executeReadFile,
});

async function executeListDir(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const supplied = String(args.path || "").trim(), directory = absolutePath(supplied);
  if (!directory) return "[错误] path 必须是绝对路径";
  const observed = await listWorkspaceDirectory(directory, context);
  if (!observed) assertWorkspacePathFallback(directory, "read", context);
  const entry = observed ? { isDirectory: () => true } : statOrNull(directory);
  if (!entry) return "[错误] 目录不存在或无法访问: " + directory;
  if (!entry.isDirectory()) return "[错误] 不是目录: " + directory;
  const hidden = args.showHidden === true, filter = typeof args.filter === "string" ? args.filter.trim() : "";
  console.log(LOG_PREFIX, "list_dir:", directory, "showHidden=" + hidden);
  let children: Array<Pick<fs.Dirent, "name" | "isDirectory" | "isFile" | "isSymbolicLink">>;
  try { children = observed ? observed.map(child => ({ name: child.name, isDirectory: () => child.kind === "directory", isFile: () => child.kind === "file", isSymbolicLink: () => false }))
    : fs.readdirSync(directory, { withFileTypes: true }); }
  catch (failure) { return "[错误] 读取目录失败: " + errorText(failure); }
  if (!hidden) children = children.filter(child => !child.name.startsWith("."));
  children.sort((left, right) => {
    const a = left.isDirectory() ? 0 : 1, b = right.isDirectory() ? 0 : 1;
    return a !== b ? a - b : left.name.localeCompare(right.name);
  });
  const limited = children.length > LIST_MAX_ENTRIES, visible = limited ? children.slice(0, LIST_MAX_ENTRIES) : children;
  const pictures = children.filter(child => child.isFile() && IMAGE_EXTS.has(path.extname(child.name).toLowerCase())).length;
  const output: string[] = ["dir: " + directory,
    "count: " + children.length + (pictures > 0 ? " (其中图片 " + pictures + " 张)" : "") +
    (filter ? " (filter: " + filter + ")" : "") + (limited ? " (仅显示前 " + LIST_MAX_ENTRIES + " 项)" : ""), ""];
  for (const child of visible) {
    const full = path.join(directory, child.name);
    if (child.isDirectory()) output.push("[D] " + child.name + "/");
    else if (child.isFile()) {
      const stat = observed ? observed.find(item => item.name === child.name) : statOrNull(full), size = stat ? "  " + formatBytes(stat.size) : "";
      const extension = path.extname(child.name).toLowerCase(), tag = IMAGE_EXTS.has(extension) ? "  [图片]" : "";
      output.push("[F] " + child.name + size + tag);
    } else if (child.isSymbolicLink()) output.push("[L] " + child.name);
    else output.push("[?] " + child.name);
  }
  return output.join("\n");
}
toolRegistry.register({
  id: "list_dir",   name: "列出目录",
  description: "列出某个目录下的子目录和文件。输出会对图片文件标注 [图片]，并在 count 行汇总图片数量。\n\n" + "何时用：\n" + "- 用户问'我那里有什么文件''看看 D:/小说 下面''有几张图片'\n" + "- 用户提到目录名但不知道里面有什么\n" + "- 想确认某个文件是否存在于某个目录\n\n" + "不要用于：\n" + "- 读具体文件内容 → read_file\n" + "- 用户给了完整文件路径 → 直接 read_file\n\n" + "参数：path (必填，绝对路径)，showHidden (可选，是否显示以 . 开头的隐藏项，默认 false)。",   enabled: true,
  risk: "fs-read",   modes: ["code", "work"],
  effectKind: "read" as const,   isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,   inputSchema: { type: "object", properties: { path: { type: "string", description: "要列举的目录绝对路径" }, showHidden: { type: "boolean", description: "是否包含隐藏项（以 . 开头），默认 false" }, }, required: ["path"], },
  execute: executeListDir,
});

function resolveWritePath(rawPath: string, workspaceRoot?: string): string | null {
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  const relativeName = path.normalize(rawPath).replace(/\\/g, "/");
  if (relativeName.includes("..")) return null;
  const root = path.resolve(workspaceRoot || app.getPath("desktop"));
  const location = path.resolve(root, relativeName), relative = path.relative(root, location);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : location;
}
async function executeWriteFile(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const supplied = String(args.path || "").trim(), location = resolveWritePath(supplied, ctx?.resolvedWorkspaceRoot);
  if (!location) throw new ToolExecutionError("E_PATH_NOT_ABSOLUTE", "path 必须是绝对路径，或不含 .. 的相对文件名（相对路径以工作区/桌面为根）", "invalid_arguments");
  const text = typeof args.content === "string" ? args.content : "";
  return withWorkspaceWrite(location, ctx, args.createDirs !== false, lease => lease
    ? executeHandleWriteFile(args, ctx, location, text, lease)
    : executePathWriteFile(args, ctx, location, text));
}
async function executePathWriteFile(args: Record<string, unknown>, ctx: ToolContext | undefined, location: string, text: string): Promise<string> {
  const append = args.append === true, mkdir = args.createDirs !== false;
  assertWorkspacePathFallback(location, "write", ctx);
  const existed = fs.existsSync(location);
  let previous: string | null = null;
  if (existed) {
    try { previous = fs.readFileSync(location, "utf8"); }
    catch (failure) { throw new ToolExecutionError("E_READ_BEFORE_OVERWRITE_FAILED", "写前读取原文件失败，已拒绝覆盖写: " + errorText(failure), "permission_denied"); }
    if (!append) {
      const decision = checkOverwriteDrop(previous, text);
      if (decision.blocked) throw new ToolExecutionError("E_OVERWRITE_DROP_BLOCKED", overwriteDropMessage(decision), "runtime_safety", false, "not_applied");
    }
  }
  console.log(LOG_PREFIX, "write_file:", location, "bytes=" + Buffer.byteLength(text, "utf8"), append ? "(append)" : "(overwrite)");
  const batch = beginWriteBatch(ctx, [location]);
  await batch.run([location], async () => {
    assertWorkspacePathFallback(location, "write", ctx);
    if (mkdir) {
      try { fs.mkdirSync(path.dirname(location), { recursive: true }); }
      catch (failure) { throw new ToolExecutionError("E_CREATE_PARENT_FAILED", "创建父目录失败: " + errorText(failure), "permission_denied"); }
    }
    if (ctx?.runId) {
      const review = reviewTrackerFor();
      assertWorkspacePathFallback(location, "write", ctx);
      review.captureBefore(ctx.runId, location, undefined, undefined, ctx);
    }
    try {
      if (append) {
        const separator = previous !== null && previous.length > 0 && !previous.endsWith("\n");
        fs.appendFileSync(location, (separator ? "\n" : "") + text, "utf8");
      } else fs.writeFileSync(location, text, "utf8");
    } catch (failure) { throw new ToolExecutionError("E_WRITE_FILE_FAILED", "写入失败: " + errorText(failure), "semantic_failure", false, "unknown"); }
  });
  let written: fs.Stats;
  try { assertWorkspacePathFallback(location, "write", ctx, "unknown"); written = fs.statSync(location); }
  catch (failure) {
    if (failure instanceof ToolExecutionError) throw failure;
    throw new ToolExecutionError("E_WRITE_EVIDENCE_FAILED", "写入完成但无法确认文件状态: " + errorText(failure), "partial_failure", false, "unknown");
  }
  return writeFileResult(location, text, append, existed, previous, written);
}
async function executeHandleWriteFile(args: Record<string, unknown>, ctx: ToolContext | undefined, location: string, text: string, lease: WorkspaceWriteLease): Promise<string> {
  const append = args.append === true;
  const previous = lease.before.exists ? lease.before.bytes!.toString("utf8") : null;
  if (previous !== null && !append) {
    const decision = checkOverwriteDrop(previous, text);
    if (decision.blocked) throw new ToolExecutionError("E_OVERWRITE_DROP_BLOCKED", overwriteDropMessage(decision), "runtime_safety", false, "not_applied");
  }
  let after: WorkspaceSnapshot | undefined = lease.before;
  const batch = beginWriteBatch(ctx, [location], { before: () => lease.before, after: () => after });
  const review = ctx?.runId ? reviewTrackerFor() : undefined;
  await batch.run([location], async () => {
    review?.captureBefore(ctx!.runId!, location, undefined, lease.before, ctx);
    const separator = append && previous !== null && previous.length > 0 && !previous.endsWith("\n");
    // Once commit starts, a missing native after-image stays unknown.
    after = undefined;
    review?.recordHandleAfter(ctx!.runId!, location);
    after = await lease.commit(Buffer.from((separator ? "\n" : "") + text, "utf8"), append ? "append" : "replace");
  });
  return writeFileResult(location, text, append, lease.before.exists, previous, { size: after!.size, isFile: () => after!.kind === "file" });
}
function writeFileResult(location: string, text: string, append: boolean, existed: boolean, previous: string | null, written: { size: number; isFile(): boolean }): string {
  const added = countLines(text);
  const change: ToolFileChange = append || !existed
    ? { file: location, kind: "added", insertions: added, deletions: 0, diff: buildFullFileDiff(added === 0 ? [] : text.split("\n").slice(0, added), "add") }
    : { file: location, kind: "modified", insertions: added, deletions: countLines(previous ?? ""),
        diff: buildReplacedDiff((previous ?? "").replace(/\r\n/g, "\n").split("\n"), text.replace(/\r\n/g, "\n").split("\n")) };
  return JSON.stringify({ success: true, tool: "write_file", path: location, append, exists: written.isFile(), sizeBytes: written.size,
    writtenBytes: Buffer.byteLength(text, "utf8"), changes: finalizeFileChanges([change]) });
}
function resolveWriteFilePolicy(args: Record<string, unknown>): VerificationPolicy {
  const supplied = String(args.path ?? ""), normalized = supplied.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? "", extension = normalized.slice(normalized.lastIndexOf("."));
  const configuration = new Set(["package.json", "tsconfig.json", "tsconfig.main.json", "tsconfig.preload.json", "vite.config.ts", "vite.config.js", "vitest.config.ts",
    ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".prettierrc", "babel.config.js", "babel.config.json", "webpack.config.js"]);
  if (configuration.has(name)) return "code";
  const code = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs", ".rb", ".php", ".swift", ".kt"];
  if (code.includes(extension)) return "code";
  const artifacts = [".docx", ".xlsx", ".pdf", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp", ".ico", ".mp3", ".mp4", ".zip", ".tar", ".gz"];
  if (artifacts.includes(extension)) return "artifact";
  if ([".json", ".md", ".html", ".htm", ".yml", ".yaml", ".xml", ".toml", ".ini", ".env"].includes(extension)) {
    if (/\/src\/|\/test[s]?\//.test(normalized)) return "code";
    if (/\/dist\/|\/build\/|\/output\//.test(normalized)) return "artifact";
  }
  return "unknown";
}
toolRegistry.register({
  id: "write_file",   name: "写入文件",
  description: "把文本内容写入本地文件，覆盖或追加。会自动创建父目录。\n" + "覆盖已有大文件时若新内容行数骤降过半会被拒绝（防输出截断毁文件），此时改用 str_replace 做局部修改。\n" + "笔记很长时不要一次性写入：先写前半部分，再用 append=true 续写后半部分。\n\n" + "何时用：\n" + "- 用户要保存生成的笔记、改写后的文本、配置\n" + "- 用户要写笔记 / 纯文本文件（.md / .txt）\n" + "- 用户要新建文件\n" + "- 需要持久化一段内容到磁盘\n\n" + "不要用于：\n" + "- 修改已有文件的局部内容（用 str_replace/apply_patch 更安全）\n" + "- 生成 Excel/Word/PDF 文档（用对应专用工具）\n" + "- 写入危险系统路径\n\n" + "path 两种给法：绝对路径；或相对文件名（可含子目录，如 '笔记.md'、'test/report.md'）——" + "绑定项目时落到项目根目录，未绑定时落到桌面。\n" + "参数：path，content (要写的字符串)，append (可选，true=追加，默认 false=覆盖)，createDirs (可选，默认 true)。",   enabled: true,
  risk: "fs-write",   modes: ["code", "work"],
  effectKind: "mutation" as const,   verificationPolicyResolver: resolveWriteFilePolicy,
  inputSchema: { type: "object", properties: { path: { type: "string", description: "目标文件绝对路径，或相对文件名（可含子目录，如 '笔记.md'；绑定项目时落到项目根目录，未绑定时落到桌面）" }, content: { type: "string", description: "要写入的文本内容（UTF-8）" }, append: { type: "boolean", description: "true=追加，false=覆盖（默认）" }, createDirs: { type: "boolean", description: "是否自动创建父目录，默认 true" }, }, required: ["path", "content"], },
  execute: executeWriteFile,
});

async function loadCaptionVisionConfigLazy(): Promise<import("../image-router").CaptionVisionConfig> {
  const storage = await import("../../settings/model-settings");
  const selected = storage.resolveModelSettingsProfile(storage.loadModelSettings());
  const routing = await import("../image-router");
  return routing.resolveCaptionVisionConfig(selected);
}
async function executeReadImage(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const supplied = String(args.path || "").trim(), location = absolutePath(supplied);
  if (!location) return "[错误] path 必须是绝对路径";
  const observed = await readWorkspaceFile(location, ctx, IMAGE_MAX_BYTES);
  if (!observed) assertWorkspacePathFallback(location, "read", ctx);
  const entry = observedStat(observed, location);
  if (!entry) return "[错误] 文件不存在或无法访问: " + location;
  if (!entry.isFile()) return "[错误] 不是文件: " + location;
  if (entry.size > IMAGE_MAX_BYTES) return "[错误] 图片过大（>" + formatBytes(IMAGE_MAX_BYTES) + "），当前 " + formatBytes(entry.size);
  const extension = path.extname(location).toLowerCase();
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml" };
  const mime = types[extension];
  if (!mime) return "[错误] 不支持的图片格式: " + extension + "（支持 png/jpg/jpeg/gif/webp/bmp/svg）";
  console.log(LOG_PREFIX, "read_image:", location, "mime=" + mime, "size=" + formatBytes(entry.size));
  let bytes: Buffer;
  try { bytes = observed ? observed.bytes! : fs.readFileSync(location); }
  catch (failure) { return "[错误] 读取失败: " + errorText(failure); }
  const routing = await loadCaptionVisionConfigLazy();
  if (!routing.ok) return "[错误·配置] " + routing.error;
  const question = ctx?.userQuery ?? "";
  const description = await captionImage({ base64: bytes.toString("base64"), mime }, question, routing.config);
  return description;
}
toolRegistry.register({
  id: "read_image",   name: "读取图片",
  description: "读取本地图片文件，交给视觉模型分析后返回文字描述。支持 png/jpg/jpeg/gif/webp/bmp/svg，最大 5MB。\n\n" + "何时用：\n" + "- 用户提到截图、图片，想知道内容\n" + "- 用户说'看看这张图''图片里是什么'\n" + "- 环境信息里说'当前模型支持查看图片'时\n\n" + "不要用于：\n" + "- 环境信息说'不支持查看图片'时（直接告诉用户看不了，不要调）\n" + "- 读文本文件 → read_file\n" + "- 批量读图（逐张调用，不要一次性塞多张）\n\n" + "若未配置视觉模型会返回错误，届时如实告诉用户看不了。" + "参数：path (必填，绝对路径)。",   enabled: true,
  risk: "fs-read",   modes: ["code", "work"],
  effectKind: "read" as const,   verificationPolicy: "none" as const,   needsContext: true,   inputSchema: { type: "object", properties: { path: { type: "string", description: "图片文件绝对路径" }, }, required: ["path"], },
  execute: executeReadImage,
});
logger.info(LogTag.FsTools, "registered: read_file / list_dir / write_file / read_image");
