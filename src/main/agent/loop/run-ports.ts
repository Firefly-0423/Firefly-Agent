// 运行循环（agent loop）对上层的接口。loop 只依赖这里的类型；runtime / memory-runtime 实现它们，
// 并从原来的文件重新导出，调用方不用改。这样 loop 不需要引用比自己高的模块。
import type { SdkStreamRunInput } from "../../model/providers/sdk-stream/runtime";
import type { ChatResponse } from "../../model/providers/types";
import type { TranscriptSink } from "./transcript-sink";
import type { TaskSessionStatus } from "../../../shared/task-session";
import type { TaskWriteEvidence, ModelExecutionEvent } from "../../../shared/agent-execution-evidence";

export type AgentLoopEvent = {
  contextUsage?: import("../../../shared/context-usage").ContextUsageSnapshot;
  taskPlan?: unknown;
  snapshot?: unknown;
  status?: string;
  content?: string;
  totalUsage?: unknown;
  stepName?: string;
  toolCallName?: string;
  toolCallId?: string;
  delta?: string;
  role?: string;
  messageId?: string;
  type: string;
};
export type AgentLoopSettings = {
  contextWindowTokens: number;
  reasoningLevels?: import("../../../shared/reasoning").ReasoningLevelsConfig;
  reasoning?: import("../../../shared/reasoning").ReasoningPreference;
  explicitTransport?: "openai" | "anthropic" | "responses";
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
};
export interface MainMemoryRun {
  call(input: SdkStreamRunInput): Promise<ChatResponse>;
  bindSink(sink: TranscriptSink): TranscriptSink;
  close(): Promise<void>;
}
export interface DelegationScope { groupId: string; toolCallId: string }
export interface AgentExecuteRequest { agentId: string; prompt: string }
export interface AgentExecuteResult { agentId: string; sessionId: string; status: TaskSessionStatus; text: string; writes?: TaskWriteEvidence[]; executionEvents?: ModelExecutionEvent[]; error?: { code: string; message: string } }
