import type { ToolCall, ChatMessage } from "../vendors/types";
import { tryParseToolCallArgs, toolCallFingerprint, type HarnessCacheState, type AgentState } from "./types";
import type { HarnessRunSession } from "./run-store";

export type HarnessRecoveryEnvironment = { enabledToolIds?: string[]; model?: string; provider?: string; workspaceRoot?: string };
export type PreparedHarnessRecovery = { recoveryContext: string; cache: HarnessCacheState; state: AgentState; messages: ChatMessage[] };

export function prepareHarnessRecovery(session: HarnessRunSession, environment: HarnessRecoveryEnvironment): PreparedHarnessRecovery {
  if (session.status !== "interrupted") throw new Error("HARNESS_RECOVERY_NOT_INTERRUPTED");
  if (session.request.workspaceRoot && environment.workspaceRoot !== session.request.workspaceRoot) throw new Error("HARNESS_RECOVERY_WORKSPACE_MISMATCH");
  const transcript = JSON.parse(JSON.stringify(session.messages)) as ChatMessage[];
  const restored = JSON.parse(JSON.stringify(session.state)) as AgentState;
  const paired = new Set(transcript.flatMap((entry) => entry.role === "tool" && entry.toolCallId ? [entry.toolCallId] : []));
  const declared = new Map<string, ToolCall>();
  for (const entry of transcript) for (const call of entry.toolCalls ?? []) declared.set(call.id, call);
  const recorded = new Map(session.toolCalls.map((entry) => [entry.toolCallId, entry]));
  for (const call of declared.values()) {
    const pending = restored.uncertainEffects.find((entry) => entry.toolCallId === call.id);
    const parsed = tryParseToolCallArgs(call);
    if (pending && parsed === undefined) pending.argumentsUnavailable = true;
    if (paired.has(call.id)) continue;
    const lifecycle = recorded.get(call.id);
    const dispatched = lifecycle?.status === "started" || lifecycle?.status === "unknown";
    if (dispatched && lifecycle?.sideEffect !== "read_only") {
      const identity = toolCallFingerprint(call.name, parsed ?? {});
      if (!pending) restored.uncertainEffects.push({
        id: `${session.runId}:${call.id}`, toolCallId: call.id, fingerprint: identity,
        ...(parsed === undefined ? { argumentsUnavailable: true as const } : {}),
        toolName: call.name, message: "该外部副作用在应用中断时尚未确认结果",
      });
    }
    transcript.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({
      outcome: dispatched ? "unknown_after_interruption" : "not_executed_after_interruption", tool: call.name,
      message: dispatched ? "应用在该副作用完成前中断；不得自动重放，先查证或询问用户。" : "应用在工具执行完成前中断；请根据当前任务自行决定是否重新读取。",
    }) });
  }
  const notices: string[] = [];
  if (environment.provider && environment.model && (environment.provider !== session.request.provider || environment.model !== session.request.model)) {
    notices.push(`模型已变化：原为 ${session.request.provider}/${session.request.model}，当前为 ${environment.provider}/${environment.model}。`);
  }
  if (environment.enabledToolIds && session.request.enabledToolIds) {
    const available = new Set(environment.enabledToolIds);
    const absent = session.request.enabledToolIds.filter((name) => !available.has(name));
    if (absent.length > 0) notices.push(`恢复时不可用的旧工具：${absent.join(", ")}。不得假装调用成功。`);
  }
  return { messages: transcript, state: restored, cache: { cacheEpoch: session.cache.cacheEpoch + 1, epochReason: "recovery" },
    recoveryContext: [
      `这是从意外中断的运行 ${session.runId} 恢复的任务。`, `已完成轮数：${session.rounds}；Todo 是可变工作笔记，应据真实进展更新。`,
      "中断中的外部副作用已标为未知：不得自动重放，必须先查证、询问用户，或诚实说明无法确认。",
      ...notices,
    ].join("\n"),
  };
}
