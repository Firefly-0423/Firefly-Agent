import type { AgentExecutionMode, FireflyRunOptions } from "../orchestrator/firefly-agent";
import type { ChannelToolSandbox } from "./settings-store";
import type { ChannelChatType, ChannelId } from "./types";

export type ChannelAgentPolicy = {
  permissionMode: NonNullable<FireflyRunOptions["permissionMode"]>;
  includeInteractiveTools: boolean;
  exposeTools: boolean;
  executionMode: AgentExecutionMode;
};

export function resolveChannelAgentPolicy(toolSandbox: ChannelToolSandbox, context?: { channel?: ChannelId; chatType?: ChannelChatType }): ChannelAgentPolicy {
  const groupRestricted = (context?.channel === "qq" || context?.channel === "qqbot") && context.chatType === "group";
  const toolsAllowed = !groupRestricted && toolSandbox !== "off";
  return {
    executionMode: toolsAllowed ? "work" : "chat",
    exposeTools: toolsAllowed,
    includeInteractiveTools: false,
    permissionMode: toolsAllowed ? "allow_all" : "normal",
  };
}

export function enforceChannelAgentPolicy(options: FireflyRunOptions, policy: ChannelAgentPolicy): void {
  options.harnessInteractiveTools = policy.includeInteractiveTools;
  options.permissionMode = policy.permissionMode;
  if (!policy.exposeTools) {
    options.tools = [];
    options.toolSystemContent = "";
    options.skillLayerContent = "";
    const capabilities = options.capabilities;
    if (capabilities) options.capabilities = { ...capabilities, tools: [], toolIds: new Set<string>() };
  }
}
