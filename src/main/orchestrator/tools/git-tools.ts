import type { GitDiffQuery, GitLogQuery, GitService, TrustedGitContext } from "../../code-git/git-service";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolFileChange } from "../../../shared/chat-types";
import { finalizeFileChanges, parseUnifiedPatch } from "./registry/tool-evidence";

function trustedRepository(context: ToolContext | undefined): TrustedGitContext {
  if (context?.mode !== "code") throw new Error("Git 工具只允许在 Code 模式使用");
  if (!context.conversationId || !context.resolvedWorkspaceRoot) throw new Error("当前 Code 对话尚未绑定工作目录");
  return { sessionId: context.conversationId, mode: "code", workspaceRoot: context.resolvedWorkspaceRoot };
}
function requiredText(input: Record<string, unknown>, property: string): string {
  const supplied = input[property];
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  throw new Error(`缺少有效参数：${property}`);
}
function maybeText(input: Record<string, unknown>, property: string): string | undefined {
  return input[property] === undefined ? undefined : requiredText(input, property);
}
function pathList(input: Record<string, unknown>, property: string): string[] {
  const supplied = input[property];
  if (!Array.isArray(supplied) || supplied.some(value => typeof value !== "string" || !value.trim())) throw new Error(`缺少有效参数：${property}`);
  return supplied.map(value => value.trim());
}

async function readDiff(service: GitService, input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const query: GitDiffQuery = {};
  if (input.ref !== undefined) query.ref = requiredText(input, "ref");
  if (input.staged !== undefined) query.staged = input.staged === true || input.staged === "true";
  if (input.paths !== undefined) query.paths = pathList(input, "paths");
  if (input.maxPatchLines !== undefined) query.maxPatchLines = Number(input.maxPatchLines);
  const response = await service.diff(trustedRepository(context), query);
  const sections = response.patch.split(/(?=^diff --git )/m).filter(section => section.startsWith("diff --git"));
  const byPath = new Map<string, string>();
  for (const section of sections) {
    const header = section.match(/^diff --git a\/(.+?) b\//m);
    if (header) byPath.set(header[1], section);
  }
  const evidence: ToolFileChange[] = response.perFile.map(file => ({
    file: file.file, kind: "modified", insertions: file.insertions, deletions: file.deletions,
    ...(byPath.has(file.file) ? { diff: parseUnifiedPatch(byPath.get(file.file)!) } : {}),
  }));
  return JSON.stringify({ ...response, changes: finalizeFileChanges(evidence) });
}
async function readHistory(service: GitService, input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const query: GitLogQuery = {};
  if (input.ref !== undefined) query.ref = requiredText(input, "ref");
  if (input.path !== undefined) query.path = requiredText(input, "path");
  if (input.maxCount !== undefined) query.maxCount = Number(input.maxCount);
  return JSON.stringify(await service.log(trustedRepository(context), query));
}

export function createCodeGitTools(gitService: GitService): ToolDefinition[] {
  return [
    {
      id: "git_status",       name: "Git 状态",
      description: "读取当前 Code 工作区的 Git 分支、变更和同步状态。",       enabled: true,
      modes: ["code"],       risk: "fs-read",
      effectKind: "read",       verificationPolicy: "none",
      needsContext: true,       inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => { const trusted = trustedRepository(ctx); return JSON.stringify(await gitService.getStatusForSession(trusted.sessionId)); },
    },
    {
      id: "git_init",       name: "初始化 Git 仓库",
      description: "仅在用户明确要求时，为当前 Code 工作区初始化 Git 仓库。",       enabled: true,
      modes: ["code"],       risk: "fs-write",
      effectKind: "mutation",       verificationPolicy: "artifact",
      needsContext: true,       inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => gitService.initRepository(trustedRepository(ctx)),
    },
    {
      id: "git_commit",       name: "提交 Git 变更",
      description: "把用户确认的仓库内文件加入暂存并创建一次 Git 提交。",       enabled: true,
      modes: ["code"],       risk: "fs-write",
      effectKind: "mutation",       verificationPolicy: "artifact",
      needsContext: true,       inputSchema: { type: "object", properties: { message: { type: "string", description: "提交信息" }, paths: { type: "array", description: "要提交的仓库内相对路径", items: { type: "string" } }, }, required: ["message", "paths"], },
      execute: async (args, ctx) => gitService.commit(trustedRepository(ctx), requiredText(args, "message"), pathList(args, "paths")),
    },
    {
      id: "git_switch_branch",       name: "切换 Git 分支",
      description: "切换到现有分支，或按用户请求创建并切换新分支。",       enabled: true,
      modes: ["code"],       risk: "fs-write",
      effectKind: "mutation",       verificationPolicy: "artifact",
      needsContext: true,       inputSchema: { type: "object", properties: { branch: { type: "string", description: "目标分支名称" }, create: { type: "string", description: "是否创建新分支，true 或 false", enum: ["true", "false"], default: "false" }, }, required: ["branch"], },
      execute: async (args, ctx) => gitService.switchBranch(trustedRepository(ctx), requiredText(args, "branch"), args.create === true || args.create === "true"),
    },
    {
      id: "git_push",       name: "推送 Git 提交",
      description: "把当前分支推送到用户指定的远端；不会强制推送。",       enabled: true,
      modes: ["code"],       risk: "shell",
      effectKind: "external_side_effect",       verificationPolicy: "none",
      needsContext: true,       inputSchema: { type: "object", properties: { remote: { type: "string", description: "远端名称，默认 origin", default: "origin" } }, },
      execute: async (args, ctx) => gitService.push(trustedRepository(ctx), maybeText(args, "remote")),
    },
    {
      id: "git_revert",       name: "回退 Git 提交",
      description: "为指定提交创建一个新的 revert 提交，不会重写历史。",       enabled: true,
      modes: ["code"],       risk: "fs-write",
      effectKind: "mutation",       verificationPolicy: "artifact",
      needsContext: true,       inputSchema: { type: "object", properties: { commit: { type: "string", description: "要回退的提交 hash" } }, required: ["commit"], },
      execute: async (args, ctx) => gitService.revert(trustedRepository(ctx), requiredText(args, "commit")),
    },
    {
      id: "git_diff",       name: "查看 Git 差异",
      description: "查看当前工作区的 Git diff（改动内容）。默认对比工作区 vs HEAD；staged=true 查看已暂存的改动；可用 ref 指定其他基准（分支名、tag、commit hash），paths 限定文件。\n" + "何时用：提交前自查改动、review 用户未提交的修改、revert 前确认影响面。",       enabled: true,
      modes: ["code"],       risk: "fs-read",
      effectKind: "read",       verificationPolicy: "none",
      needsContext: true,       inputSchema: { type: "object", properties: { ref: { type: "string", description: "基准 ref（分支/tag/hash），默认 HEAD" }, staged: { type: "boolean", description: "true=已暂存的改动，false=工作区改动（默认）" }, paths: { type: "array", items: { type: "string" }, description: "限定仓库内相对路径" }, maxPatchLines: { type: "number", description: "patch 最多返回行数，默认 400，超出截断" }, }, },
      execute: (args, ctx) => readDiff(gitService, args, ctx),
    },
    {
      id: "git_log",       name: "查看 Git 历史",
      description: "查看提交历史（hash、日期、作者、提交信息）。可用 ref 指定分支，path 查看单文件历史，maxCount 控制条数（默认 20）。\n" + "何时用：了解某个文件为什么被改、找某次改动的提交 hash（配合 git_revert）、梳理近期变更。",       enabled: true,
      modes: ["code"],       risk: "fs-read",
      effectKind: "read",       verificationPolicy: "none",
      needsContext: true,       inputSchema: { type: "object", properties: { ref: { type: "string", description: "分支/tag/hash；默认当前分支" }, path: { type: "string", description: "限定单个文件的仓库内相对路径" }, maxCount: { type: "number", description: "最多返回条数（1-200），默认 20" }, }, },
      execute: (args, ctx) => readHistory(gitService, args, ctx),
    },
  ];
}
export function registerCodeGitTools(
  gitService: GitService,
  registry: Pick<import("./registry/tool-registry").ToolRegistry, "register">,
): void {
  const definitions = createCodeGitTools(gitService);
  definitions.forEach(definition => registry.register(definition));
}
