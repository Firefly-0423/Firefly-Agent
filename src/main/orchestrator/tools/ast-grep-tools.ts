import { beginWriteBatch } from "./registry/file-write-evidence";
import * as fs from "fs";
import * as path from "path";
import { parse, type Edit, type SgNode } from "@ast-grep/napi";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDiffLine, ToolFileChange } from "../../../shared/chat-types";
import { finalizeFileChanges } from "./registry/tool-evidence";
import { reviewTrackerFor } from "../review/review-tracker-access";

const LOG_PREFIX = "[AstGrep]";
const EXTENSION_TO_LANG: Record<string, string> = { ".ts": "TypeScript", ".tsx": "Tsx", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "Jsx", ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".json": "Json", ".yaml": "Yaml", ".yml": "Yaml", ".css": "Css", ".html": "Html", ".c": "C", ".h": "C", ".cpp": "Cpp", ".cc": "Cpp", ".hpp": "Cpp", };
const SKIP_DIRS = new Set([ "node_modules", ".git", "dist", "release", "build", "out", ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv", ".worktrees", "worktrees", ]);
const SUPPORTED_LANGUAGES = Array.from(new Set(Object.values(EXTENSION_TO_LANG))).sort();
const LANG_TO_EXTENSIONS: Record<string, Set<string>> = {};
Object.entries(EXTENSION_TO_LANG).forEach(([extension, language]) => {
  (LANG_TO_EXTENSIONS[language] ??= new Set()).add(extension);
});
const MAX_FILES = 500;
const MAX_MATCHES_DEFAULT = 50;

interface CollectedFile { relPath: string; absPath: string; lang: string; }
interface SingleMatch { line: number; column: number; endLine: number; text: string; }
interface CommonArgs { pattern: string; language?: string; paths?: string[]; }
interface ReplaceResult { newSource: string; diffLines: ToolDiffLine[]; insertions: number; deletions: number; }

function workspaceContains(candidate: string, root: string): boolean {
  const absolute = path.resolve(root, candidate), normalized = path.normalize(root);
  return absolute === normalized || absolute.startsWith(normalized + path.sep);
}
function displayName(value: string): string {
  const slashes = value.replaceAll("\\", "/");
  if (slashes === "." || slashes === "./") return "";
  return slashes.startsWith("./") ? slashes.slice(2) : slashes;
}
function collectFiles(root: string, requested: string[], language?: string): { files: CollectedFile[]; skipped: string[] } {
  const extensions = language ? LANG_TO_EXTENSIONS[language] : undefined;
  const collected: CollectedFile[] = [], omitted: string[] = [];
  const descend = (absolute: string, relative: string): void => {
    if (collected.length >= MAX_FILES) return;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(absolute, { withFileTypes: true }); }
    catch { omitted.push(relative); return; }
    for (const child of children) {
      if (collected.length >= MAX_FILES) return;
      if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
      const name = relative ? `${relative}/${child.name}` : child.name;
      const location = path.join(absolute, child.name);
      if (child.isDirectory()) { descend(location, name); continue; }
      if (!child.isFile()) continue;
      const extension = path.extname(child.name).toLowerCase(), parser = EXTENSION_TO_LANG[extension];
      if (parser && (!extensions || extensions.has(extension))) collected.push({ relPath: name, absPath: location, lang: parser });
    }
  };
  for (const requestedPath of requested) {
    const absolute = path.resolve(root, requestedPath);
    if (!workspaceContains(absolute, root)) { omitted.push(requestedPath); continue; }
    let entry: fs.Stats;
    try { entry = fs.statSync(absolute); } catch { omitted.push(requestedPath); continue; }
    if (entry.isDirectory()) { descend(absolute, displayName(requestedPath)); continue; }
    const extension = path.extname(absolute).toLowerCase(), parser = EXTENSION_TO_LANG[extension];
    if (!parser || (extensions && !extensions.has(extension))) { omitted.push(requestedPath); continue; }
    collected.push({ relPath: displayName(requestedPath), absPath: absolute, lang: parser });
  }
  return { files: collected, skipped: omitted };
}
function searchOneFile(source: string, lang: string, pattern: string): SingleMatch[] {
  return parse(lang, source).root().findAll(pattern).map(node => {
    const location = node.range();
    return { line: location.start.line + 1, column: location.start.column + 1, endLine: location.end.line + 1, text: node.text() };
  });
}
function substitute(node: SgNode, template: string): string {
  const expanded = template.replace(/\$\$\$([A-Z][A-Z0-9_]*)/g, (_token, capture: string) => node.getMultipleMatches(capture).map(value => value.text()).join(", "));
  return expanded.replace(/\$([A-Z][A-Z0-9_]*)/g, (_token, capture: string) => {
    const value = node.getMatch(capture);
    return value ? value.text() : "";
  });
}
function replaceOneFile(source: string, lang: string, pattern: string, rewrite: string): ReplaceResult | null {
  const root = parse(lang, source).root(), found = root.findAll(pattern);
  if (!found.length) return null;
  found.sort((left, right) => left.range().start.index - right.range().start.index);
  const proposed: Edit[] = found.map(node => node.replace(substitute(node, rewrite)));
  const edits: Edit[] = [], nodes: SgNode[] = [];
  let boundary = -1;
  proposed.forEach((edit, index) => {
    if (edit.startPos < boundary) return;
    edits.push(edit);
    nodes.push(found[index]);
    boundary = edit.endPos;
  });
  const diff: ToolDiffLine[] = [];
  let added = 0, removed = 0;
  for (const node of nodes) {
    node.text().split("\n").forEach(text => { diff.push({ type: "remove", text }); removed++; });
    const expanded = substitute(node, rewrite);
    expanded.split("\n").forEach(text => { diff.push({ type: "add", text }); added++; });
  }
  return { newSource: root.commitEdits(edits), diffLines: diff, insertions: added, deletions: removed };
}
function parseCommonArgs(input: Record<string, unknown>): CommonArgs {
  const pattern = String(input.pattern ?? "").trim();
  if (!pattern) throw new Error("pattern 参数不能为空");
  let language: string | undefined, paths: string[] | undefined;
  if (input.language !== undefined) {
    language = String(input.language);
    if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error(`不支持的语言 "${language}"。支持：${SUPPORTED_LANGUAGES.join(", ")}`);
  }
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.some(value => typeof value !== "string")) throw new Error("paths 必须是字符串数组");
    paths = input.paths as string[];
  }
  return { pattern, language, paths };
}
const patternFailure = (failure: unknown): string => `pattern 无效：${failure instanceof Error ? failure.message : String(failure)}`;

async function executeAstGrepSearch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const root = ctx?.resolvedWorkspaceRoot;
  if (!root) return JSON.stringify({ success: false, matches: [], errors: ["未绑定工作区，无法执行代码搜索"] });
  let request: CommonArgs;
  try { request = parseCommonArgs(args); }
  catch (failure) { return JSON.stringify({ success: false, matches: [], errors: [String(failure instanceof Error ? failure.message : failure)] }); }
  const limit = Number.isInteger(args.maxMatches) && (args.maxMatches as number) >= 1 ? args.maxMatches as number : MAX_MATCHES_DEFAULT;
  const { files, skipped } = collectFiles(root, request.paths ?? ["."], request.language);
  const output: (SingleMatch & { file: string })[] = [], problems: string[] = [];
  let matchingFiles = 0, limited = false;
  try {
    for (const file of files) {
      if (output.length >= limit) { limited = true; break; }
      let source: string;
      try { source = fs.readFileSync(file.absPath, "utf8"); } catch { skipped.push(file.relPath); continue; }
      try {
        const found = searchOneFile(source, file.lang, request.pattern);
        if (found.length) matchingFiles++;
        for (const match of found) {
          if (output.length >= limit) { limited = true; break; }
          output.push({ ...match, file: file.relPath });
        }
      } catch (failure) { problems.push(`${file.relPath}: ${patternFailure(failure)}`); }
    }
  } catch (failure) { return JSON.stringify({ success: false, matches: [], errors: [patternFailure(failure)] }); }
  console.log(LOG_PREFIX, `search "${request.pattern.slice(0, 40)}" → ${output.length} 处 / ${matchingFiles} 个文件`);
  return JSON.stringify({ success: true, pattern: request.pattern, language: request.language ?? "auto", scannedFiles: files.length,
    filesWithMatches: matchingFiles, matchCount: output.length, truncated: limited, matches: output,
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}),
    ...(problems.length > 0 ? { parseErrors: problems.slice(0, 10) } : {}) });
}

async function executeAstGrepReplace(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const root = ctx?.resolvedWorkspaceRoot;
  if (!root) return JSON.stringify({ success: false, changed: [], errors: ["未绑定工作区，无法执行代码改写"] });
  let request: CommonArgs;
  try { request = parseCommonArgs(args); }
  catch (failure) { return JSON.stringify({ success: false, changed: [], errors: [String(failure instanceof Error ? failure.message : failure)] }); }
  const template = String(args.rewrite ?? ""), previewOnly = args.dryRun !== false;
  const { files, skipped } = collectFiles(root, request.paths ?? ["."], request.language);
  const plans: Array<{ file: string; matchCount: number; preview?: string }> = [];
  const problems: string[] = [], evidence: ToolFileChange[] = [];
  const writes = new Map<string, string>();
  for (const file of files) {
    let source: string;
    try { source = fs.readFileSync(file.absPath, "utf8"); } catch { skipped.push(file.relPath); continue; }
    try {
      const found = searchOneFile(source, file.lang, request.pattern);
      if (!found.length) continue;
      const replacement = replaceOneFile(source, file.lang, request.pattern, template);
      if (replacement === null || replacement.newSource === source) continue;
      plans.push({ file: file.relPath, matchCount: found.length,
        ...(plans.length < 3 ? { preview: `${file.relPath}: ${found.length} 处，示例 → ${found[0].text.slice(0, 80)}` } : {}) });
      evidence.push({ file: file.relPath, kind: "modified", insertions: replacement.insertions, deletions: replacement.deletions, diff: replacement.diffLines });
      writes.set(file.absPath, replacement.newSource);
    } catch (failure) { problems.push(`${file.relPath}: ${patternFailure(failure)}`); }
  }
  const count = plans.reduce((sum, entry) => sum + entry.matchCount, 0);
  const finalized = finalizeFileChanges(evidence);
  if (previewOnly) {
    console.log(LOG_PREFIX, `replace(dryRun) "${request.pattern.slice(0, 40)}" → ${plans.length} 文件 ${count} 处`);
    return JSON.stringify({ success: true, dryRun: true, pattern: request.pattern, rewrite: template, filesToChange: plans.length,
      totalMatches: count, planned: plans.map(entry => ({ file: entry.file, matchCount: entry.matchCount })), changes: finalized,
      ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}),
      ...(problems.length > 0 ? { parseErrors: problems.slice(0, 10) } : {}), note: "这是预览。确认无误后用 dryRun: false 重新调用以实际写入。" });
  }
  const batch = beginWriteBatch(ctx, [...writes.keys()]);
  if (ctx?.runId) {
    const review = reviewTrackerFor();
    for (const absolute of writes.keys()) review.captureBefore(ctx.runId, absolute, absolute.slice(root.length + 1).replaceAll("\\", "/"), undefined, ctx);
  }
  const completed: string[] = [];
  for (const [absolute, content] of writes) {
    try {
      await batch.run([absolute], () => fs.writeFileSync(absolute, content, "utf8"));
      completed.push(absolute.slice(root.length + 1).replaceAll("\\", "/"));
    } catch (failure) { problems.push(`${absolute}: ${failure instanceof Error ? failure.message : String(failure)}`); }
  }
  writes.clear();
  console.log(LOG_PREFIX, `replace "${request.pattern.slice(0, 40)}" → 写入 ${completed.length} 个文件`);
  return JSON.stringify({ success: problems.length === 0, dryRun: false, pattern: request.pattern, rewrite: template, changedFiles: completed.length,
    totalMatches: count, changed: completed, changes: finalizeFileChanges(evidence.filter(change => completed.includes(change.file))),
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}), ...(problems.length > 0 ? { errors: problems.slice(0, 10) } : {}) });
}

const PATTERN_SYNTAX_DOC = "pattern 语法：写一段普通代码作为模板。$VAR 匹配并捕获单个节点，$$ 匹配单个任意节点，$$$ 匹配任意数量节点（含零）。\n" + "例：\n" + '- "console.log($$$ARGS)" 匹配所有 console.log 调用\n' + '- "function $NAME($$$) { $$$ }" 匹配所有函数声明\n' + 'rewrite 中可引用捕获的 $VAR。';
const LANGUAGES_DOC = `支持的语言：${SUPPORTED_LANGUAGES.join("、")}（language 不传时按文件扩展名自动识别）`;
export function registerAstGrepTools(): void {
  toolRegistry.register({
    id: "ast_grep_search",     name: "AST 代码搜索",
    description: "用 AST 结构模式在代码中搜索（语法级，非文本匹配）。\n\n" + "何时用：\n" + "- 找某种代码结构（所有 console.log 调用、所有 new Error(...)、某种 API 用法模式）\n" + "- 文本搜索会误伤注释/字符串里的同名内容时\n" + "- 重构前先摸清影响面\n\n" + "不要用于：\n" + "- 纯文本搜索（用 search_text）\n" + "- 找符号定义/引用（用 lsp 的 workspaceSymbol/findReferences，语义级更精确）\n\n" + PATTERN_SYNTAX_DOC + "\n\n" + LANGUAGES_DOC + "\n\n" + "参数：pattern（必填），paths（可选，相对工作区的文件/目录，默认全工作区），language（可选），maxMatches（可选，默认 50）。",     enabled: true,
    risk: "fs-read",     modes: ["code", "work"],
    effectKind: "read" as const,     verificationPolicy: "none" as const,
    needsContext: true,     inputSchema: { type: "object", properties: { pattern: { type: "string", description: "AST 模式（一段普通代码作模板，$$$/$$/$VAR 为通配符）" }, paths: { type: "array", items: { type: "string" }, description: "相对工作区的文件或目录列表，默认 [\".\"]" }, language: { type: "string", enum: SUPPORTED_LANGUAGES, description: "限定语言；不传则按扩展名自动识别" }, maxMatches: { type: "number", description: "最多返回匹配数，默认 50" }, }, required: ["pattern"], },
    execute: executeAstGrepSearch,
  });
  toolRegistry.register({
    id: "ast_grep_replace",     name: "AST 批量改写",
    description: "用 AST 结构模式批量改写代码（语法级，保持未匹配区域原样、保留换行符）。\n\n" + "何时用：\n" + "- 同一代码模式的大量机械改写（API 迁移、错误调用规范化、测试断言格式统一）\n" + "- 文本替换会误伤注释/字符串时\n\n" + "不要用于：\n" + "- 单文件单处修改（用 str_replace 更直接）\n" + "- 精确改名某个符号（用 lsp rename 语义级改名，ast-grep 不区分同名符号）\n" + "- 复杂多行结构调整（用 apply_patch）\n\n" + "流程：先 dryRun=true（默认）预览影响面，确认后 dryRun=false 写入。\n\n" + PATTERN_SYNTAX_DOC + "\n\n" + LANGUAGES_DOC + "\n\n" + "参数：pattern（必填），rewrite（必填，替换模板），paths（可选），language（可选），dryRun（可选，默认 true 只预览）。",     enabled: true,
    risk: "fs-write",     modes: ["code", "work"],
    effectKind: "mutation" as const,     verificationPolicy: "code" as const,
    needsContext: true,     inputSchema: { type: "object", properties: { pattern: { type: "string", description: "AST 模式（一段普通代码作模板）" }, rewrite: { type: "string", description: "替换模板，可引用 pattern 中捕获的 $VAR" }, paths: { type: "array", items: { type: "string" }, description: "相对工作区的文件或目录列表，默认 [\".\"]" }, language: { type: "string", enum: SUPPORTED_LANGUAGES, description: "限定语言" }, dryRun: { type: "boolean", description: "true=只预览不写文件（默认），false=实际写入" }, }, required: ["pattern", "rewrite"], },
    execute: executeAstGrepReplace,
  });
  console.log(LOG_PREFIX, "已注册：ast_grep_search / ast_grep_replace");
}
