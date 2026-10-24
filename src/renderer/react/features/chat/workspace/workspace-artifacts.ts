import type { ChatMessageItem } from "../components/ChatMessageList";
import type { TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import { normalizeToolTaskResult } from "../../../../../shared/task-result-evidence";
export interface WorkspaceChangedFile { toolId: string; change: ToolFileChange }
export interface WorkspaceRunOutput { id: string; sessionId: string; runId: string; messageId: string; tools: ToolExecutionRecord[]; files: WorkspaceChangedFile[]; tasks: TaskDelegationDisplayRecord[] }
/** Uses run/tool/lifecycle records only; assistant prose is never an artifact or completion signal. */
export function collectWorkspaceOutputs(sessionId: string, messages: readonly ChatMessageItem[]): WorkspaceRunOutput[] {
  return messages.flatMap(message => {
    if (!sessionId || !message.runId || message.role !== "assistant") return [];
    const tools = (message.toolExecutions ?? []).filter(tool => tool.status !== "running").map(tool => ({
      ...tool, taskResult: tool.name === "delegate_agent" ? normalizeToolTaskResult(tool.taskResult, message.runId) : undefined,
    }));
    const tasks = message.taskDelegations ?? [];
    if (!tools.length && !tasks.length) return [];
    return [{ id: `results:${sessionId}:${message.runId}`, sessionId, runId: message.runId, messageId: message.id,
      tools, tasks, files: tools.flatMap(tool => (tool.changes ?? []).map(change => ({ toolId: tool.id, change }))) }];
  });
}
export function workspaceFileRevision(sessionId: string, messages: readonly ChatMessageItem[]): string {
  return JSON.stringify([sessionId, ...collectWorkspaceOutputs(sessionId, messages).flatMap(output =>
    [...output.files.map(file => [output.runId, file.toolId, file.change]),
      ...output.tools.flatMap(tool => (tool.taskResult?.writes ?? []).map(write => [output.runId, tool.id, write]))])]);
}
/** Presentation convenience, never a security boundary: workspaceFiles still validates realpath in Main. */
export function workspaceRelativePath(file: string, root?: string): string | null {
  let path = file.replace(/\\/g, "/");
  if (!path || /[\0\r\n]/.test(path) || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return null;
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) {
    const prefix = root?.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (!root || !( /^[a-z]:/i.test(prefix) ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return null;
    path = path.slice(prefix.length);
  }
  const parts = path.split("/").filter(part => part !== "." && part !== "");
  return parts.length && !parts.includes("..") ? parts.join("/") : null;
}
export function createWorkspaceResultRevealer() {
  const seen = new Set<string>();
  return (sessionId: string, runId: string | undefined, tools: readonly ToolExecutionRecord[], activeSessionId: string | undefined): string | null => {
    if (!runId || !tools.some(tool => tool.status !== "running" && (tool.changes?.length || tool.taskResult))) return null;
    const id = `results:${sessionId}:${runId}`;
    if (seen.has(id)) return null;
    seen.add(id);
    return sessionId === activeSessionId ? id : null;
  };
}

/** A run's changed files open in a panel of their own; its tab id is derived from the run output's id. */
export const CHANGES_TAB_PREFIX = "changes:";
export const changesTabId = (outputId: string) => `${CHANGES_TAB_PREFIX}${outputId}`;
