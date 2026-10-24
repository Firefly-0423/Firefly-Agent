import { LspManager, type LspExecutionContext } from "../../lsp/manager";
import { LSP_OPERATIONS, type LspOperation, type LspQuery } from "../../lsp/types";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition } from "./registry/tool-registry";

type LspManagerPort = Pick<LspManager, "execute">;

function textOption(input: Record<string, unknown>, property: string): string | undefined {
  const supplied = input[property];
  if (supplied === undefined) return undefined;
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  throw new Error(`${property} 必须是非空字符串`);
}
function positionOption(input: Record<string, unknown>, property: string): number | undefined {
  const supplied = input[property];
  if (supplied === undefined) return undefined;
  if (Number.isInteger(supplied) && (supplied as number) >= 1) return supplied as number;
  throw new Error(`${property} 必须是从 1 开始的整数`);
}
function opaqueItem(supplied: unknown): Record<string, unknown> | undefined {
  if (supplied === undefined) return undefined;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) return supplied as Record<string, unknown>;
  throw new Error("item 必须是调用层级条目对象");
}
function trustedWorkspace(context: ToolContext | undefined): LspExecutionContext {
  if (context?.mode !== "code") throw new Error("LSP 工具只允许在 Code 模式使用");
  const root = context.resolvedWorkspaceRoot;
  if (!root) throw new Error("当前 Code 对话尚未绑定工作目录");
  return { resolvedWorkspaceRoot: root, signal: context.signal };
}
function queryFrom(input: Record<string, unknown>): LspQuery {
  const accepted = new Set(["operation", "filePath", "line", "character", "query", "item"]);
  if (Object.keys(input).some(property => !accepted.has(property))) throw new Error("不支持的 LSP 参数");
  const operation = input.operation;
  if (typeof operation !== "string" || !LSP_OPERATIONS.includes(operation as LspOperation)) throw new Error("operation 必须是受支持的 LSP 操作");
  return { operation: operation as LspOperation, filePath: textOption(input, "filePath"),
    line: positionOption(input, "line"), character: positionOption(input, "character"),
    query: textOption(input, "query"), item: opaqueItem(input.item) };
}

export function createLspTool(manager: LspManagerPort): ToolDefinition {
  return {
    id: "lsp",     name: "代码语义查询",
    description: "仅在 Code 模式中，通过用户已安装的语言服务器查询定义、引用、悬停、符号和诊断；不会修改文件或安装软件。",     enabled: true,
    modes: ["code"],     risk: "fs-read",
    effectKind: "read",     verificationPolicy: "none",
    needsContext: true,     inputSchema: { type: "object", properties: { operation: { type: "string", enum: [...LSP_OPERATIONS], description: "语义查询类型" }, filePath: { type: "string", description: "绑定工作目录内的相对文件路径；workspaceSymbol 不需要。" }, line: { type: "number", description: "从 1 开始的行号；位置类操作需要。" }, character: { type: "number", description: "从 1 开始的字符号；位置类操作需要。" }, query: { type: "string", description: "workspaceSymbol 的搜索词。" }, item: { type: "object", description: "仅 incomingCalls/outgoingCalls 使用：prepareCallHierarchy 返回的条目。" }, }, required: ["operation"], },
    execute: async (args, ctx) => {
      const request = queryFrom(args);
      const workspace = trustedWorkspace(ctx);
      const response = await manager.execute(request, workspace);
      return JSON.stringify(response);
    },
  };
}
export function registerLspTool(
  manager: LspManagerPort,
  registry: Pick<import("./registry/tool-registry").ToolRegistry, "register">,
): void {
  const definition = createLspTool(manager);
  registry.register(definition);
}
