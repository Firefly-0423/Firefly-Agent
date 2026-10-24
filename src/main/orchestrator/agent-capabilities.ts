import type { AgentProfile } from "../../shared/agent-profile";
import type { SkillEntry } from "../skills/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { RunCapabilities } from "./run-capabilities";

const CHILD_BLOCKED_TOOLS = new Set(["task", "delegate_agent", "ask_user", "ask_user_choice", "confirm_uncertain_effect"]);

export function resolveAgentCapabilities(
  profile: AgentProfile,
  mode: "work" | "code",
  parentTools: readonly ToolDefinition[],
  parentSkills: readonly SkillEntry[],
): RunCapabilities {
  if (!profile.supportedModes.includes(mode)) throw new Error("AGENT_MODE_UNAVAILABLE");
  const allowedTools = new Set(profile.allowedToolIds);
  const allowedSkills = new Set(profile.allowedSkillIds);
  const tools = parentTools.filter(tool => allowedTools.has(tool.id) && !CHILD_BLOCKED_TOOLS.has(tool.id));
  const skills = parentSkills.filter(skill => allowedSkills.has(skill.id));
  return { mode, tools, toolIds: new Set(tools.map(tool => tool.id)), skills, skillIds: new Set(skills.map(skill => skill.id)) };
}
