import * as fs from "fs";
import * as path from "path";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";

const LOG_PREFIX = "[SearchText]";
const MAX_MATCHES = 100;
const MAX_CONTEXT_LINES = 5;
const MAX_LINE_LENGTH = 500;
const MAX_FILE_SIZE = 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30000;
const IGNORED_DIRS = new Set([ ".git", ".svn", ".hg", "node_modules", "bower_components", "dist", "build", "out", "output", "release", ".next", ".nuxt", ".cache", "__pycache__", ".pytest_cache", ".idea", ".vscode", "coverage", ".nyc_output", "target", "vendor", ".venv", "venv", ".worktrees", "worktrees", ]);
const IGNORED_EXTS = new Set([ ".exe", ".dll", ".so", ".dylib", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".mp3", ".mp4", ".wav", ".avi", ".mov", ".zip", ".tar", ".gz", ".rar", ".7z", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".woff", ".woff2", ".ttf", ".eot", ".pyc", ".pyo", ".class", ".o", ".obj", ]);
interface SearchMatch { path: string; line: number; column?: number; preview: string; before: string[]; after: string[]; }
interface SearchResult { matches: SearchMatch[]; totalMatches: number; returnedMatches: number; truncated: boolean; }

function safeStat(location: string): fs.Stats | null {
  try { return fs.statSync(location); } catch { return null; }
}
function inside(candidate: string, root: string): boolean {
  const absolute = path.resolve(root, candidate), normalized = path.normalize(root);
  return absolute.startsWith(normalized + path.sep) || absolute === normalized;
}
function excluded(location: string): boolean { return IGNORED_EXTS.has(path.extname(location).toLowerCase()); }
function matchesGlob(location: string, input: string): boolean {
  const pattern = input.includes("/") || input.startsWith("**/") ? input : "**/" + input;
  const body = pattern.replace(/\./g, "\\.").replace(/\*\*/g, "⟨GLOBSTAR⟩").replace(/\*/g, "[^/]*").replace(/⟨GLOBSTAR⟩/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp("^" + body + "$").test(location);
}
function searchFile(absolute: string, relative: string, needle: string, mode: "literal" | "regex", sensitive: boolean,
  context: number, _maximum: number, remaining: number, signal?: AbortSignal): SearchMatch[] {
  if (remaining <= 0) return [];
  const entry = safeStat(absolute);
  if (!entry || !entry.isFile() || entry.size > MAX_FILE_SIZE) return [];
  const found: SearchMatch[] = [];
  let rows: string[];
  try { rows = fs.readFileSync(absolute, "utf8").split("\n"); } catch { return []; }
  let expression: RegExp;
  try {
    const pattern = mode === "regex" ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expression = new RegExp(pattern, sensitive ? "g" : "gi");
  } catch { return []; }
  for (let index = 0; index < rows.length; index++) {
    if (signal?.aborted) break;
    if (found.length >= remaining) break;
    const row = rows[index];
    if (row.length > MAX_LINE_LENGTH || !row.match(expression)) continue;
    expression.lastIndex = 0;
    const column = row.search(expression);
    const preceding: string[] = [], following: string[] = [];
    for (let offset = Math.max(0, index - context); offset < index; offset++) preceding.push(rows[offset].slice(0, MAX_LINE_LENGTH));
    for (let offset = index + 1; offset <= Math.min(rows.length - 1, index + context); offset++) following.push(rows[offset].slice(0, MAX_LINE_LENGTH));
    found.push({ path: relative, line: index + 1, column: column >= 0 ? column + 1 : undefined,
      preview: row.slice(0, MAX_LINE_LENGTH), before: preceding, after: following });
  }
  return found;
}
function searchTree(directory: string, root: string, needle: string, mode: "literal" | "regex", sensitive: boolean,
  context: number, maximum: number, globs: string[] | undefined, signal?: AbortSignal, omitted?: Set<string>): SearchMatch[] {
  const found: SearchMatch[] = [];
  const visit = (current: string): void => {
    if (signal?.aborted || found.length >= maximum) return;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (signal?.aborted || found.length >= maximum) return;
      const absolute = path.join(current, child.name), relative = path.relative(root, absolute);
      if (child.isDirectory()) {
        if (IGNORED_DIRS.has(child.name)) omitted?.add(child.name);
        else visit(absolute);
      } else if (child.isFile()) {
        if (excluded(child.name)) continue;
        if (globs && globs.length > 0 && !globs.some(pattern => matchesGlob(relative, pattern))) continue;
        found.push(...searchFile(absolute, relative, needle, mode, sensitive, context, maximum, maximum - found.length, signal));
      }
    }
  };
  visit(directory);
  return found;
}

async function executeSearchCode(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const needle = String(args.query || "").trim();
  if (!needle) return JSON.stringify({ success: false, errorCode: "INVALID_QUERY", error: "query 不能为空", retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });
  const mode: "literal" | "regex" = args.mode === "regex" ? "regex" : "literal";
  const maximum = Math.min(MAX_MATCHES, Math.max(1, Number(args.maxMatches) || 20));
  const context = Math.min(MAX_CONTEXT_LINES, Math.max(0, Number(args.contextLines) || 2));
  const sensitive = args.caseSensitive === true;
  const locations = Array.isArray(args.paths) ? args.paths.map(String) : ["."];
  const globs = Array.isArray(args.fileGlobs) ? args.fileGlobs.map(String) : undefined;
  const root = ctx?.resolvedWorkspaceRoot ?? path.resolve(process.cwd()), signal = ctx?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("搜索超时")), SEARCH_TIMEOUT_MS); });
  try {
    const pending = (async (): Promise<SearchResult & { searchType?: string; message?: string; rejectedPaths?: string[]; skippedDirs?: string[] }> => {
      const found: SearchMatch[] = [], rejected: string[] = [], omitted = new Set<string>();
      for (const location of locations) {
        if (signal?.aborted) break;
        if (found.length >= maximum) break;
        const absolute = path.resolve(root, location);
        if (!inside(absolute, root)) { console.warn(LOG_PREFIX, "路径逃逸检测拒绝:", location); rejected.push(location); continue; }
        const entry = safeStat(absolute);
        if (!entry) continue;
        if (entry.isDirectory()) {
          found.push(...searchTree(absolute, root, needle, mode, sensitive, context, maximum - found.length, globs, signal, omitted));
        } else if (entry.isFile()) {
          const relative = path.relative(root, absolute);
          if (excluded(path.basename(absolute))) continue;
          if (globs && globs.length > 0 && !globs.some(pattern => matchesGlob(relative, pattern))) continue;
          found.push(...searchFile(absolute, relative, needle, mode, sensitive, context, maximum, maximum - found.length, signal));
        }
      }
      let message: string | undefined;
      if (rejected.length > 0 && found.length === 0) message = `路径 ${rejected.join(", ")} 在工作区外被拒绝，搜索未执行。search_text 只能搜索工作区内文件。要确认工作区外文件是否存在，请用 list_dir 或 run_shell。`;
      else if (rejected.length > 0) message = `路径 ${rejected.join(", ")} 在工作区外被拒绝，已跳过。`;
      else if (found.length === 0) message = "未找到匹配内容。这不代表目标文件不存在——search_text 搜索的是文件内容，不是文件名。要查找文件请用 list_dir。";
      if (omitted.size > 0) {
        const note = `已排除镜像/依赖目录：${[...omitted].slice(0, 5).join(", ")}。这些目录里的内容不是当前工作区代码，不参与匹配。`;
        message = message ? `${message} ${note}` : note;
      }
      return { matches: found.slice(0, maximum), totalMatches: found.length, returnedMatches: Math.min(found.length, maximum), truncated: found.length > maximum,
        searchType: "content", ...(message ? { message } : {}), ...(rejected.length > 0 ? { rejectedPaths: rejected } : {}),
        ...(omitted.size > 0 ? { skippedDirs: [...omitted].slice(0, 10) } : {}) };
    })();
    const response = await Promise.race([pending, timeout]);
    if (timer) clearTimeout(timer);
    console.log(LOG_PREFIX, `搜索完成: query="${needle}" mode=${mode} matches=${response.returnedMatches}/${response.totalMatches} truncated=${response.truncated}`);
    return JSON.stringify(response);
  } catch (failure) {
    if (timer) clearTimeout(timer);
    const message = failure instanceof Error ? failure.message : String(failure);
    console.error(LOG_PREFIX, "搜索失败:", message);
    return JSON.stringify({ success: false, errorCode: "SEARCH_FAILED", error: message, retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });
  }
}

export function registerSearchCodeTool(): void {
  toolRegistry.register({
    id: "search_code",     name: "搜索代码",
    deprecated: true,     description: "【已废弃】请改用 search_text。旧 search_code 存在精度问题：纯文本匹配会命中注释和字符串，且 workspaceRoot 依赖 process.cwd()。",
    enabled: true,     risk: "safe",
    modes: ["code", "work"],     effectKind: "read" as const,
    isConcurrencySafe: () => true,     verificationPolicy: "none" as const,
    needsContext: true,     inputSchema: { type: "object", properties: { query: { type: "string", description: "搜索文本" }, paths: { type: "array", description: "搜索路径（相对于工作区根目录，默认 '.'）", items: { type: "string" } }, fileGlobs: { type: "array", description: "文件过滤 glob（如 '*.ts', 'src/**/*.js'）", items: { type: "string" } }, mode: { type: "string", enum: ["literal", "regex"], description: "搜索模式：literal（默认）或 regex" }, maxMatches: { type: "number", description: "最多返回匹配数（默认 20，上限 100）" }, contextLines: { type: "number", description: "上下文行数（默认 2，上限 5）" }, caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" }, }, required: ["query"], },
    execute: executeSearchCode,
  });
  console.log(LOG_PREFIX, "已注册：search_code (deprecated)");
}
export function registerSearchTextTool(): void {
  toolRegistry.register({
    id: "search_text",     name: "文本搜索",
    catalogHint: "【文本级】在工作区文件内容中搜索字面文本或正则表达式，返回路径、行号和上下文。",     description: "在当前工作区的真实文件内容中实时搜索字面文本或正则表达式，返回匹配的文件路径、行号和少量上下文。\n\n" + "何时用：\n" + "- 已知某个字面文本（URL、错误消息、硬编码字符串）在哪些文件里\n" + "- 用正则表达式查找符合模式的文本片段\n" + "- 快速定位包含特定字符串的文件\n\n" + "不要用于：\n" + "- 判断某个函数/类是否存在（纯文本会命中注释/字符串）→ 用 ast_grep_search 或 lsp\n" + "- 读取完整文件内容 → read_file\n" + "- 列出目录结构 → list_dir\n" + "- 查找文件名 → list_dir 或 Glob\n" + "- 修改代码 → str_replace/apply_patch\n\n" + "参数：query（搜索文本），mode（可选，literal 默认 / regex 正则），paths（可选，搜索路径），" + "fileGlobs（可选，文件过滤如 '*.ts' 自动扩展为 '**/*.ts'），" + "maxMatches（可选，最多返回数），contextLines（可选，上下文行数），caseSensitive（可选，区分大小写）。",
    enabled: true,     risk: "safe",
    modes: ["code", "work"],     effectKind: "read" as const,
    isConcurrencySafe: () => true,     verificationPolicy: "none" as const,
    needsContext: true,     inputSchema: { type: "object", properties: { query: { type: "string", description: "要搜索的文本" }, mode: { type: "string", enum: ["literal", "regex"], description: "搜索模式：literal（默认，字面匹配）或 regex（正则表达式）" }, paths: { type: "array", description: "搜索路径（相对于工作区根目录，默认 '.'）", items: { type: "string" } }, fileGlobs: { type: "array", description: "文件过滤 glob（如 '*.ts' 会自动扩展为 '**/*.ts' 覆盖子目录）", items: { type: "string" } }, maxMatches: { type: "number", description: "最多返回匹配数（默认 20，上限 100）" }, contextLines: { type: "number", description: "上下文行数（默认 2，上限 5）" }, caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" }, }, required: ["query"], },
    execute: executeSearchCode,
  });
  console.log(LOG_PREFIX, "已注册：search_text");
}
