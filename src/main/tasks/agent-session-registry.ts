import path from "node:path";
import { createHash } from "node:crypto";
import type { TaskSession } from "../../shared/task-session";
import { TaskSessionStore } from "./task-session-store";

export interface AcquireAgentSessionInput {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  resolvedWorkspaceRoot: string;
  agentId: string;
  modelProfile: string;
  savedModelProfileId: string;
  description: string;
  prompt: string;
}

export class AgentSessionRegistry {
  constructor(private readonly store: TaskSessionStore) {}

  acquire(input: AcquireAgentSessionInput): TaskSession {
    if (!input.savedModelProfileId.trim() || !input.modelProfile.trim()) throw new Error("AGENT_MODEL_PROFILE_REQUIRED");
    if (!input.agentId.trim() || !input.parentConversationId.trim() || !input.prompt.trim()) throw new Error("AGENT_SESSION_INPUT_INVALID");
    if (!path.isAbsolute(input.resolvedWorkspaceRoot)) throw new Error("AGENT_WORKSPACE_REQUIRED");
    const workspace = path.resolve(input.resolvedWorkspaceRoot);
    const agent = { id: input.agentId, modelProfile: input.modelProfile, savedModelProfileId: input.savedModelProfileId };
    const sessionId = `agent-${createHash("sha256").update(JSON.stringify([input.parentConversationId, workspace, input.agentId])).digest("hex")}`;
    const session = this.store.get(sessionId);
    if (session) {
      return this.store.resumeAgent(session.id, {
        agent, parentConversationId: input.parentConversationId, parentRunId: input.parentRunId,
        mode: input.mode, resolvedWorkspaceRoot: workspace, prompt: input.prompt,
      });
    }
    return this.store.createAgent({
      sessionId, agent, parentConversationId: input.parentConversationId, parentRunId: input.parentRunId,
      description: input.description, prompt: input.prompt, mode: input.mode, resolvedWorkspaceRoot: workspace,
    });
  }
}
