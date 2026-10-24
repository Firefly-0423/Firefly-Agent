import type { TaskWriteEvidence, ModelExecutionEvent } from "./agent-execution-evidence";

// 私有子任务会话：可跨进程序列化的契约

export type TaskSessionStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TaskDelegationPresentationStatus = "running" | "completed" | "failed" | "cancelled";

export type TodoItem = { activeForm?: string; status: TodoStatus; content: string; id: string };

/** 保留 Harness 协议消息需要的可序列化字段，避免把 Main 的 vendor 类型引进 shared */
export type TaskTranscriptMessage = {
  [key: string]: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: unknown[];
  content: string;
  role: string;
};

export type TaskTraceRecord = {
  status?: string;
  content?: string;
  label?: string;
  phase?: "start" | "delta" | "end";
  kind: "round" | "progress" | "reasoning" | "tool" | "todo" | "terminal";
  at: number;
  id: string;
};

export type TaskUncertainEffect = {
  repeatAuthorization?: { source: "user"; grantedAt: number };
  message: string;
  toolName: string;
  /** 历史上已启动的调用参数无法解析时，保守拦截该工具直到用户确认 */
  argumentsUnavailable?: true;
  fingerprint: string;
  toolCallId: string;
  id: string;
};

export type AgentSessionIdentity = { savedModelProfileId: string; modelProfile: string; id: string };

export type TaskSession = {
  completedAt?: number;
  updatedAt: number;
  createdAt: number;
  error?: { code: string; message: string };
  resultText?: string;
  executionEvents?: ModelExecutionEvent[];
  /** 可选：旧会话没有历史证据可推断 */
  writes?: TaskWriteEvidence[];
  uncertainEffects?: TaskUncertainEffect[];
  todoItems: TodoItem[];
  trace: TaskTraceRecord[];
  messages: TaskTranscriptMessage[];
  status: TaskSessionStatus;
  resolvedWorkspaceRoot?: string;
  mode: "work" | "code";
  agent: AgentSessionIdentity;
  description: string;
  /** 前一次未完成 run 的精确收尾标记，仅由 Main 的恢复流程设置与清除 */
  recoveryRunId?: string;
  childRunId: string;
  parentRunId: string;
  parentConversationId: string;
  id: string;
  schemaVersion: 2;
};

/** 父流程可见的最小委托信息，不含子任务 prompt 与私有轨迹 */
export type TaskDelegationPresentation = {
  status: TaskDelegationPresentationStatus;
  assetFileName: string;
  nickname: string;
  description: string;
  taskId: string;
  invocationId: string;
};
