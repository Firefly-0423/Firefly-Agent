import { beginWriteBatch } from "./registry/file-write-evidence";
import * as fs from "fs";
import * as path from "path";
import { resolveContainedPath } from "./path-containment";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDiffLine, ToolFileChange } from "../../../shared/chat-types";
import { buildFullFileDiff, finalizeFileChanges } from "./registry/tool-evidence";
import { reviewTrackerFor } from "../review/review-tracker-access";

const LOG_PREFIX = "[ApplyPatch]";
interface UpdateChunkLine { type: "context" | "removal" | "addition"; content: string; }
interface UpdateChunk { lines: UpdateChunkLine[]; }
type PatchHunk = { type: "add"; path: string; content: string } | { type: "delete"; path: string } |
  { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };
interface ParseResult { hunks: PatchHunk[]; errors: string[]; }
interface ApplyResult { success: boolean; applied: string[]; errors: string[]; changes?: ToolFileChange[]; }

function withinRoot(candidate: string, root: string): boolean {
  return resolveContainedPath(root, candidate) !== null;
}

export function parsePatch(patchText: string): ParseResult {
  const rows = patchText.split("\n").map(row => row.replace(/\r$/, ""));
  const start = rows.findIndex(row => row.trim() === "*** Begin Patch");
  if (start < 0) return { hunks: [], errors: ["patch 必须以 *** Begin Patch 开头"] };
  const operations: PatchHunk[] = [], problems: string[] = [];
  let cursor = start + 1;
  while (cursor < rows.length) {
    const header = rows[cursor];
    if (header.trim() === "*** End Patch") break;
    if (header.startsWith("*** Update File: ")) {
      const name = header.slice("*** Update File: ".length).trim();
      cursor++;
      let destination: string | undefined;
      if (cursor < rows.length && rows[cursor].startsWith("*** Move to: ")) {
        destination = rows[cursor].slice("*** Move to: ".length).trim();
        cursor++;
      }
      const blocks: UpdateChunk[] = [];
      let active: UpdateChunk | null = null;
      while (cursor < rows.length && !rows[cursor].startsWith("*** ")) {
        const row = rows[cursor++];
        if (row.trim() === "@@") {
          if (active) blocks.push(active);
          active = { lines: [] };
          continue;
        }
        active ??= { lines: [] };
        const category = row.startsWith("+") ? "addition" : row.startsWith("-") ? "removal" : row.startsWith(" ") ? "context" : undefined;
        if (category) active.lines.push({ type: category, content: row.slice(1) });
        else if (row === "") active.lines.push({ type: "context", content: "" });
      }
      if (active) blocks.push(active);
      if (!blocks.length) problems.push(`${name}: Update File 不包含任何编辑块（缺少 @@ ... 内容）`);
      else operations.push({ type: "update", path: name, ...(destination ? { movePath: destination } : {}), chunks: blocks });
      continue;
    }
    if (header.startsWith("*** Add File: ")) {
      const name = header.slice("*** Add File: ".length).trim();
      cursor++;
      const body: string[] = [];
      while (cursor < rows.length && !rows[cursor].startsWith("*** ")) {
        const row = rows[cursor++];
        if (row.startsWith("+")) body.push(row.slice(1));
        else if (row === "") body.push("");
      }
      operations.push({ type: "add", path: name, content: body.join("\n") });
      continue;
    }
    if (header.startsWith("*** Delete File: ")) operations.push({ type: "delete", path: header.slice("*** Delete File: ".length).trim() });
    cursor++;
  }
  return { hunks: operations, errors: problems };
}

function image(block: UpdateChunk, excluded: UpdateChunkLine["type"]): string[] {
  return block.lines.filter(row => row.type !== excluded).map(row => row.content);
}
function spliceBlock(rows: string[], block: UpdateChunk, from: number): { lines: string[]; nextSearch: number; error?: string } {
  const expected = image(block, "addition");
  let offset = from;
  if (expected.length) {
    while (offset <= rows.length - expected.length && !expected.every((value, index) => rows[offset + index] === value)) offset++;
    if (offset > rows.length - expected.length) return {
      lines: rows, nextSearch: rows.length,
      error: `未找到匹配的上下文。期望找到:\n${expected.map(row => `  ${row}`).join("\n")}`,
    };
  }
  const replacement = image(block, "removal");
  return { lines: [...rows.slice(0, offset), ...replacement, ...rows.slice(offset + expected.length)], nextSearch: offset + replacement.length };
}

function validateOperation(operation: PatchHunk, root: string, problems: string[]): void {
  const absolute = path.resolve(root, operation.path);
  if (!withinRoot(absolute, root)) { problems.push(`路径逃逸: ${operation.path} 在工作区外`); return; }
  switch (operation.type) {
    case "add":
      if (fs.existsSync(absolute)) problems.push(`文件已存在，无法新增: ${operation.path}`);
      return;
    case "delete":
      if (!fs.existsSync(absolute)) problems.push(`文件不存在，无法删除: ${operation.path}`);
      return;
    case "update": {
      if (!fs.existsSync(absolute)) { problems.push(`文件不存在，无法更新: ${operation.path}`); return; }
      let rows = fs.readFileSync(absolute, "utf8").split(/\r?\n/), position = 0;
      for (let index = 0; index < operation.chunks.length; index++) {
        const preview = spliceBlock(rows, operation.chunks[index], position);
        if (preview.error) { problems.push(`${operation.path}: 第 ${index + 1} 个编辑块未找到匹配的上下文`); break; }
        rows = preview.lines;
        position = preview.nextSearch;
      }
      if (operation.movePath) {
        const destination = path.resolve(root, operation.movePath);
        if (!withinRoot(destination, root)) problems.push(`移动目标路径逃逸: ${operation.movePath}`);
        else if (fs.existsSync(destination)) problems.push(`移动目标已存在，无法覆盖: ${operation.movePath}`);
      }
    }
  }
}

export function applyPatchHunks(hunks: PatchHunk[], workspaceRoot: string, ctx?: ToolContext): ApplyResult {
  const completed: string[] = [], problems: string[] = [];
  const evidence: ToolFileChange[] = [];
  for (const operation of hunks) validateOperation(operation, workspaceRoot, problems);
  if (problems.length) return { success: false, applied: [], errors: problems };
  const targets = hunks.flatMap(operation => [path.resolve(workspaceRoot, operation.path),
    ...(operation.type === "update" && operation.movePath ? [path.resolve(workspaceRoot, operation.movePath)] : [])]);
  const batch = beginWriteBatch(ctx, targets);
  if (ctx?.runId) {
    const review = reviewTrackerFor();
    for (const operation of hunks) {
      const absolute = path.resolve(workspaceRoot, operation.path);
      review.captureBefore(ctx.runId, absolute, operation.path, undefined, ctx);
      if (operation.type === "update" && operation.movePath) review.recordRename(ctx.runId, absolute, path.resolve(workspaceRoot, operation.movePath), operation.path, operation.movePath);
    }
  }
  for (const operation of hunks) {
    const absolute = path.resolve(workspaceRoot, operation.path);
    try {
      // Earlier hunks may have changed a source or destination since prevalidation.
      if (!withinRoot(absolute, workspaceRoot)) throw new Error(`路径逃逸: ${operation.path}`);
      if (operation.type === "update" && operation.movePath) {
        const destination = path.resolve(workspaceRoot, operation.movePath);
        if (!withinRoot(destination, workspaceRoot)) throw new Error(`移动目标路径逃逸: ${operation.movePath}`);
        if (fs.existsSync(destination)) throw new Error(`移动目标已存在，无法覆盖: ${operation.movePath}`);
      }
      switch (operation.type) {
        case "add": {
          const parent = path.dirname(absolute);
          batch.runSync([absolute], () => {
            if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
            fs.writeFileSync(absolute, operation.content, "utf8");
          });
          completed.push(`新增文件: ${operation.path}`);
          const rows = operation.content.split("\n");
          evidence.push({ file: operation.path, kind: "added", insertions: rows.length, deletions: 0, diff: buildFullFileDiff(rows, "add") });
          break;
        }
        case "delete": {
          const original = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
          batch.runSync([absolute], () => fs.unlinkSync(absolute));
          completed.push(`删除文件: ${operation.path}`);
          const rows = original.split("\n");
          evidence.push({ file: operation.path, kind: "deleted", insertions: 0, deletions: rows.length, diff: buildFullFileDiff(rows, "remove") });
          break;
        }
        case "update": {
          const original = fs.readFileSync(absolute, "utf8");
          const newline = original.includes("\r\n") ? "\r\n" : "\n";
          let rows = original.split(/\r?\n/), position = 0, failed = false, added = 0, removed = 0;
          const diff: ToolDiffLine[] = [];
          for (const block of operation.chunks) {
            const modified = spliceBlock(rows, block, position);
            if (modified.error) { problems.push(`${operation.path}: ${modified.error}`); failed = true; break; }
            rows = modified.lines;
            position = modified.nextSearch;
            for (const row of block.lines) {
              if (row.type === "addition") { diff.push({ type: "add", text: row.content }); added++; }
              else if (row.type === "removal") { diff.push({ type: "remove", text: row.content }); removed++; }
              else diff.push({ type: "context", text: row.content });
            }
          }
          if (failed) continue;
          if (operation.movePath) {
            const destination = path.resolve(workspaceRoot, operation.movePath), parent = path.dirname(destination);
            batch.runSync([absolute, destination], () => {
              if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
              // Refuse a destination created after validation; leave the source intact on collision.
              fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL);
              fs.writeFileSync(destination, rows.join(newline), "utf8");
              fs.unlinkSync(absolute);
            });
            completed.push(`更新并移动: ${operation.path} → ${operation.movePath}`);
            evidence.push({ file: operation.movePath, kind: "renamed", insertions: added, deletions: removed, diff });
          } else {
            batch.runSync([absolute], () => fs.writeFileSync(absolute, rows.join(newline), "utf8"));
            completed.push(`更新文件: ${operation.path}`);
            evidence.push({ file: operation.path, kind: "modified", insertions: added, deletions: removed, diff });
          }
        }
      }
    } catch (failure) { problems.push(`${operation.path}: ${failure instanceof Error ? failure.message : String(failure)}`); }
  }
  return { success: problems.length === 0, applied: completed, errors: problems, changes: finalizeFileChanges(evidence) };
}

async function executeApplyPatch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const input = String(args.patch || "").trim();
  if (!input) return JSON.stringify({ success: false, applied: [], errors: ["patch 参数不能为空"] });
  const root = ctx?.resolvedWorkspaceRoot;
  if (!root) return JSON.stringify({ success: false, applied: [], errors: ["未绑定工作区，无法执行文件编辑"] });
  const parsed = parsePatch(input);
  if (parsed.errors.length) return JSON.stringify({ success: false, applied: [], errors: parsed.errors });
  if (!parsed.hunks.length) return JSON.stringify({ success: false, applied: [], errors: ["patch 不包含任何操作"] });
  console.log(LOG_PREFIX, `解析到 ${parsed.hunks.length} 个 hunk`);
  const response = applyPatchHunks(parsed.hunks, root, ctx);
  if (response.success) console.log(LOG_PREFIX, `成功: ${response.applied.length} 个操作`);
  else console.warn(LOG_PREFIX, `失败: ${response.errors.length} 个错误`);
  return JSON.stringify(response);
}

export function registerApplyPatchTool(): void {
  toolRegistry.register({
    id: "apply_patch",     name: "编辑文件",
    description: "使用结构化补丁格式批量编辑文件。支持新增、修改、删除文件，以及多文件多段编辑。\n\n" + "补丁格式（Codex 标准）：\n" + "*** Begin Patch\n" + "*** Update File: src/foo.ts\n" + "@@\n" + " context line\n" + "-removed line\n" + "+added line\n" + "\n" + "*** Add File: src/new.ts\n" + "+new file content\n" + "\n" + "*** Delete File: src/old.ts\n" + "*** End Patch\n\n" + "行类型：\n" + "- 空格开头 = 上下文（不变，用于定位）\n" + "- 开头 = 删除行\n" + "+ 开头 = 新增行\n" + "- 空行 = 上下文空行\n" + "- @@ 分隔同一文件内的多个编辑块\n" + "- *** Move to: newpath 可在 Update File 后移动文件\n\n" + "安全机制：\n" + "- 所有路径必须在当前工作区内\n" + "- 修改前会预验证全部匹配，任一失败则全部不执行\n" + "- 保留原始文件换行符（CRLF/LF）\n\n" + "参数：patch（完整的补丁文本）。",     enabled: true,
    risk: "fs-write",     modes: ["code", "work"],
    effectKind: "mutation" as const,     verificationPolicy: "code" as const,
    inputSchema: { type: "object", properties: { patch: { type: "string", description: "完整的补丁文本，以 *** Begin Patch 开头，*** End Patch 结尾", }, }, required: ["patch"], },
    execute: executeApplyPatch,
  });
  console.log(LOG_PREFIX, "已注册：apply_patch");
}
