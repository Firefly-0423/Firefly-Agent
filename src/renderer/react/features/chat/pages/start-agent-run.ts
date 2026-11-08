import { aguiApi, chatStore } from "./chat-page-bridge";
import { AgentRunController, type AgentRunDeps, type AgentRunInput } from "./run/AgentRunController";

/** Resolve bridges at dispatch time so reconnects are visible to the next run. */
export async function startAgentRun(input: AgentRunInput, ports: Omit<AgentRunDeps, "api" | "store">): Promise<void> {
  const controller = new AgentRunController(input, { ...ports, api: aguiApi(), store: chatStore() });
  await controller.start();
}
