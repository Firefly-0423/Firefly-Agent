import type { ConversationMode } from "../../shared/chat-types";
import { buildModePrompt } from "./mode-prompt-profile";
import { buildToolCatalog } from "./tools/registry/tool-catalog";
import type { ToolDefinition } from "./tools/registry/tool-registry";

export function buildSystemPrompt(promptName: string): string {
  let selected: ConversationMode = "work";
  if (promptName.startsWith("chat") || promptName.startsWith("talk")) selected = "chat";
  return buildModePrompt(selected);
}

export function buildToolSystemPrompt(_mode: ConversationMode, enabledTools: ReadonlyArray<ToolDefinition>): string {
  const sections = ["## 当前可用工具", buildToolCatalog(enabledTools as ToolDefinition[])];
  return sections.filter(Boolean).join("\n\n");
}

export function buildSoulSystemBasePrompt(promptName: string): string {
  const base = buildSystemPrompt(promptName);
  return base;
}
