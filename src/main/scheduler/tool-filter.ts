import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import type { ScheduledTask } from "./types";

export function filterToolsForTask(task: ScheduledTask, allTools: ToolDefinition[]): ToolDefinition[] {
  const active = allTools.filter((t) => t.enabled);
  if (task.toolMode === "all-enabled") return active;

  const whitelist = new Set(task.allowedToolIds);
  return active.filter((t) => whitelist.has(t.id));
}
