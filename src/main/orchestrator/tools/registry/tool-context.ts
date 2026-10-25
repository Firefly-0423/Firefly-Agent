import type { ChatMessage } from "../../vendors";
import { ContextRefRegistry } from "../../context-ref-registry";
import type { ConversationMode, WorkReadScope } from "../../../../shared/chat-types";
import type { AgentFileAccessLevel } from "../../../permission/permission-policy";
import type { ExecutionScope, LeafPermit, RunExecutionCoordinator } from "../../harness/execution-coordinator";

export const contextRefRegistry = new ContextRefRegistry();

// 权限与工作目录由 Main 提供，不能从模型参数恢复。
export interface ToolContext {
  userQuery: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  conversationId?: string;
  ownerSessionId?: string;
  runId?: string;
  mode?: ConversationMode;
  resolvedWorkspaceRoot?: string;
  contextRefs?: ContextRefRegistry;
  allowedSkillIds?: ReadonlySet<string>;
  workReadScopes?: readonly WorkReadScope[];
  fileAccessLevel?: AgentFileAccessLevel;
  permissionMode?: "normal" | "allow_all";
  authorizedToolCall?: { args: Record<string, unknown>; approvalRequired: boolean; toolId: string };
  revalidateToolPermission?: (toolId: string, args: Record<string, unknown>, approvalRequired: boolean) => boolean;
  execution?: { scope: ExecutionScope; permit?: LeafPermit; coordinator: RunExecutionCoordinator };
}

const invocationScopes = new WeakMap<ToolContext, object>();

export function getToolRunScope(runContext: ToolContext): object {
  const existing = invocationScopes.get(runContext);
  if (existing) return existing;
  const identity = Object.freeze({});
  invocationScopes.set(runContext, identity);
  return identity;
}

export function createToolInvocationContext(
  runContext: ToolContext,
  callContext: Pick<ToolContext, "execution" | "authorizedToolCall">,
): ToolContext {
  const combined = { ...runContext, ...callContext };
  invocationScopes.set(combined, getToolRunScope(runContext));
  return combined;
}

export function extractLastUserQuery(history: ChatMessage[]): string {
  let cursor = history.length;
  while (cursor > 0) {
    const entry = history[--cursor];
    if (entry.role !== "user") continue;
    const body: unknown = entry.content;
    if (typeof body === "string") return body;
    if (!Array.isArray(body)) return "";
    return (body as Array<{ type?: string; text?: string }>)
      .filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map(part => part.text as string).join(" ");
  }
  return "";
}
