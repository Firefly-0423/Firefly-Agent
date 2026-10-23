import type { ConversationMode } from "../../shared/chat-types";
import type { SkillEntry, SkillMode, SkillModeOverrides } from "../skills/types";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import { filterToolsBySearchBackend, type SearchBackend } from "./search-backend-filter";

export interface RunCapabilities {
  skillIds: ReadonlySet<string>;
  skills: readonly SkillEntry[];
  toolIds: ReadonlySet<string>;
  tools: readonly ToolDefinition[];
  mode: ConversationMode;
}
export interface ResolveRunCapabilitiesInput {
  skillRegistry: { getEnabledForMode(mode: SkillMode, overrides?: SkillModeOverrides): SkillEntry[] };
  toolRegistry: { getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] };
  chatToolsEnabled?: boolean;
  skillModeOverrides?: SkillModeOverrides;
  toolModeOverrides?: ToolModeOverrides;
  activeSearchBackend: SearchBackend;
  mode: ConversationMode;
}

export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilities {
  if (input.mode !== "chat" && input.mode !== "work" && input.mode !== "code") {
    throw new Error("INVALID_CONVERSATION_MODE");
  }
  let enabled: ToolDefinition[];
  let selectedSkills: SkillEntry[];
  if (input.mode === "chat") {
    enabled = input.toolRegistry.getEnabledToolsForMode("chat", input.toolModeOverrides)
      .filter((entry) => entry.chatBuiltin === true);
    if (input.chatToolsEnabled) {
      const opted = input.toolRegistry.getEnabledToolsForMode("chat", input.toolModeOverrides)
        .filter((entry) => input.toolModeOverrides?.[entry.id]?.chat === true);
      enabled = [...enabled];
      for (const entry of opted) {
        if (!enabled.some((present) => present.id === entry.id)) enabled.push(entry);
      }
    }
    const filtered = filterToolsBySearchBackend(enabled, input.activeSearchBackend);
    return { mode: input.mode, tools: filtered, toolIds: new Set(filtered.map((entry) => entry.id)), skills: [], skillIds: new Set() };
  }
  enabled = input.toolRegistry.getEnabledToolsForMode(input.mode, input.toolModeOverrides);
  const filtered = filterToolsBySearchBackend(enabled, input.activeSearchBackend);
  selectedSkills = input.skillRegistry.getEnabledForMode(input.mode, input.skillModeOverrides);
  return { mode: input.mode, tools: filtered, toolIds: new Set(filtered.map((entry) => entry.id)), skills: selectedSkills, skillIds: new Set(selectedSkills.map((entry) => entry.id)) };
}
