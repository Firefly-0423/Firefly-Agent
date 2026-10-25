import fs from "node:fs";
import type { TaskWriteEvidence, ModelExecutionEvent } from "../../shared/agent-execution-evidence";
import { fireflyDataDirectory } from "../storage/firefly-data-paths";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskSession, TaskSessionStatus, TodoItem, TodoStatus, TaskTraceRecord, TaskTranscriptMessage, TaskUncertainEffect, AgentSessionIdentity } from "../../shared/task-session";

const SESSIONS_DIR_NAME = "sessions";
const INDEX_FILE_NAME = "index.json";
const TRACE_LIMIT = 2_000;
const AGENT_SESSION_ID = /^agent-[a-f0-9]{64}$/;
const sharedStores = new Map<string, TaskSessionStore>();

export function getTaskSessionStore(userDataRoot: string): TaskSessionStore {
  const key = path.resolve(userDataRoot);
  let store = sharedStores.get(key);
  if (!store) {
    store = new TaskSessionStore(key);
    sharedStores.set(key, store);
  }
  return store;
}

export type CreateAgentSessionInput = {
  resolvedWorkspaceRoot?: string;
  mode: "work" | "code";
  sessionId: string;
  agent: AgentSessionIdentity;
  prompt: string;
  description: string;
  parentRunId: string;
  parentConversationId: string;
};

export type ResumeAgentSessionInput = {
  resolvedWorkspaceRoot: string;
  mode: "work" | "code";
  prompt: string;
  agent: AgentSessionIdentity;
  parentRunId: string;
  parentConversationId: string;
};

export type TaskSessionCheckpoint = {
  error?: { code: string; message: string };
  resultText?: string;
  executionEvents?: ModelExecutionEvent[];
  writes?: TaskWriteEvidence[];
  uncertainEffects?: TaskUncertainEffect[];
  todoItems?: TodoItem[];
  trace?: TaskTraceRecord[];
  messages?: TaskTranscriptMessage[];
  status?: TaskSessionStatus;
  recoveryRunId?: string | null;
  childRunId?: string;
  parentRunId?: string;
  completedAt?: number;
};

export type TaskSessionStoreOptions = {
  createChildRunId?: () => string;
  now?: () => number;
};

type TaskSessionIndexRow = {
  updatedAt: number;
  status: TaskSessionStatus;
  parentConversationId: string;
  id: string;
};

const TASK_STATUSES: readonly string[] = ["running", "completed", "failed", "cancelled", "interrupted"];
const TODO_STATUSES: readonly string[] = ["pending", "in_progress", "completed", "cancelled"];

function isTaskStatus(value: unknown): value is TaskSessionStatus {
  return TASK_STATUSES.includes(value as string);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return TODO_STATUSES.includes(value as string);
}

/** 逐项清洗待办：缺 id / 内容为空 / 状态非法的条目直接丢弃。 */
function cloneTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const kept: TodoItem[] = [];
  const blank = (text: unknown) => typeof text === "string" && text.trim().length === 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<TodoItem>;
    if (typeof candidate.id !== "string" || blank(candidate.id)) continue;
    if (typeof candidate.content !== "string" || blank(candidate.content)) continue;
    if (!isTodoStatus(candidate.status)) continue;
    const activeForm = typeof candidate.activeForm === "string" ? { activeForm: candidate.activeForm } : {};
    kept.push({ id: candidate.id, content: candidate.content, status: candidate.status, ...activeForm });
  }
  return kept;
}

function cloneUncertainEffects(value: unknown): TaskUncertainEffect[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("TASK_SESSION_READ_FAILED");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("TASK_SESSION_READ_FAILED");
    const effect = entry as Partial<TaskUncertainEffect>;
    if (typeof effect.id !== "string" || typeof effect.toolCallId !== "string"
      || typeof effect.fingerprint !== "string" || typeof effect.toolName !== "string"
      || typeof effect.message !== "string") throw new Error("TASK_SESSION_READ_FAILED");
    if (effect.argumentsUnavailable !== undefined && effect.argumentsUnavailable !== true) throw new Error("TASK_SESSION_READ_FAILED");
    if (effect.repeatAuthorization !== undefined
      && (effect.repeatAuthorization?.source !== "user"
        || !Number.isFinite(effect.repeatAuthorization.grantedAt))) {
      throw new Error("TASK_SESSION_READ_FAILED");
    }
    return {
      id: effect.id, toolCallId: effect.toolCallId, fingerprint: effect.fingerprint,
      toolName: effect.toolName, message: effect.message,
      ...(effect.argumentsUnavailable === true ? { argumentsUnavailable: true as const } : {}),
      ...(effect.repeatAuthorization ? { repeatAuthorization: { ...effect.repeatAuthorization } } : {}),
    };
  });
}


function evidenceFailure(): never { throw new Error("TASK_SESSION_READ_FAILED"); }
function evidenceId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
}
function cloneWriteEvidence(value: unknown, agentId: string): TaskWriteEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return evidenceFailure();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return evidenceFailure();
    const item = entry as Partial<TaskWriteEvidence>;
    if (!evidenceId(item.path) || !evidenceId(item.canonicalPath) || item.agentId !== agentId
      || !evidenceId(item.childRunId) || !evidenceId(item.toolCallId)
      || !["applied", "partially_applied", "unknown", "not_applied"].includes(item.state ?? "")
      || !Array.isArray(item.eventIds) || !item.eventIds.every(evidenceId)) return evidenceFailure();
    const version = (input: unknown): { sha256?: string; version?: string } | undefined => {
      if (input === undefined) return undefined;
      if (!input || typeof input !== "object" || Array.isArray(input)) return evidenceFailure();
      const data = input as { sha256?: unknown; version?: unknown };
      if (data.sha256 !== undefined && (typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(data.sha256))) return evidenceFailure();
      if (data.version !== undefined && !evidenceId(data.version)) return evidenceFailure();
      return { ...(typeof data.sha256 === "string" ? { sha256: data.sha256 } : {}), ...(typeof data.version === "string" ? { version: data.version } : {}) };
    };
    const before = version(item.before), after = version(item.after);
    return { path: item.path, canonicalPath: item.canonicalPath, agentId, childRunId: item.childRunId, toolCallId: item.toolCallId,
      state: item.state!, ...(before ? { before } : {}), ...(after ? { after } : {}), eventIds: [...item.eventIds] };
  });
}
function cloneExecutionEvents(value: unknown, agentId: string): ModelExecutionEvent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return evidenceFailure();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return evidenceFailure();
    const item = entry as Partial<ModelExecutionEvent>;
    if (!evidenceId(item.id) || !evidenceId(item.clockDomainId) || item.agentId !== agentId
      || !evidenceId(item.parentRunId) || !evidenceId(item.childRunId) || !evidenceId(item.executionId)
      || !Number.isSafeInteger(item.seq) || item.seq! < 1 || !Number.isFinite(item.monotonicMs) || item.monotonicMs! < 0
      || !["start", "end", "terminal"].includes(item.phase ?? "")
      || item.terminal !== undefined && (!["completed", "failed", "cancelled"].includes(item.terminal) || item.phase === "start")) return evidenceFailure();
    return { id: item.id, seq: item.seq!, monotonicMs: item.monotonicMs!, clockDomainId: item.clockDomainId, agentId,
      parentRunId: item.parentRunId, childRunId: item.childRunId, executionId: item.executionId, phase: item.phase!, ...(item.terminal ? { terminal: item.terminal } : {}) };
  });
}

function isTaskSession(value: unknown): value is TaskSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<TaskSession>;
  if (session.schemaVersion !== 2 || !isAgentIdentity(session.agent)) return false;
  const textFields = [session.id, session.parentConversationId, session.parentRunId, session.childRunId, session.description];
  if (!textFields.every((field) => typeof field === "string")) return false;
  const listsOk = Array.isArray(session.messages) && Array.isArray(session.trace);
  const timesOk = typeof session.createdAt === "number" && typeof session.updatedAt === "number";
  return (session.mode === "work" || session.mode === "code") && isTaskStatus(session.status) && listsOk && timesOk;
}

function isAgentIdentity(value: unknown): value is AgentSessionIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<AgentSessionIdentity>;
  const nonBlank = (text: unknown): boolean => typeof text === "string" && text.trim().length > 0;
  return nonBlank(identity.id) && nonBlank(identity.modelProfile) && nonBlank(identity.savedModelProfileId);
}

function cloneSession(session: TaskSession): TaskSession {
  return JSON.parse(JSON.stringify(session)) as TaskSession;
}

/**
 * 任务私有会话的存储。不依赖 Electron，便于测试；生产环境启动时传入 app.getPath("userData")。
 */
export class TaskSessionStore {
  private readonly now: () => number;
  private readonly createChildRunId: () => string;
  private readonly taskRoot: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private index = new Map<string, TaskSessionIndexRow>();

  constructor(root: string, options: TaskSessionStoreOptions = {}) {
    this.taskRoot = fireflyDataDirectory(root, "tasks");
    this.sessionsDir = path.join(this.taskRoot, SESSIONS_DIR_NAME);
    this.indexPath = path.join(this.taskRoot, INDEX_FILE_NAME);
    this.now = options.now ?? Date.now;
    this.createChildRunId = options.createChildRunId ?? randomUUID;
    this.initialize();
  }

  createAgent(input: CreateAgentSessionInput): TaskSession {
    if (!isAgentIdentity(input.agent)) throw new Error("AGENT_IDENTITY_INVALID");
    if (!AGENT_SESSION_ID.test(input.sessionId)) throw new Error("AGENT_SESSION_ID_INVALID");
    if (this.get(input.sessionId)) throw new Error("AGENT_SESSION_EXISTS");
    return this.createPrivateSession(input);
  }

  private createPrivateSession(input: CreateAgentSessionInput): TaskSession {
    const now = this.now();
    const workspace = input.resolvedWorkspaceRoot ? { resolvedWorkspaceRoot: input.resolvedWorkspaceRoot } : {};
    const session: TaskSession = {
      schemaVersion: 2, id: input.sessionId, parentConversationId: input.parentConversationId, parentRunId: input.parentRunId,
      childRunId: this.createChildRunId(), description: input.description, agent: { ...input.agent }, mode: input.mode,
      ...workspace, status: "running", messages: [{ role: "user", content: input.prompt }], trace: [], todoItems: [], uncertainEffects: [],
      createdAt: now, updatedAt: now,
    };
    this.write(session);
    return cloneSession(session);
  }

  get(taskId: string): TaskSession | null {
    const session = this.read(taskId);
    return session ? cloneSession(session) : null;
  }

  listForParent(parentConversationId: string): TaskSession[] {
    return [...this.index.values()]
      .filter((row) => row.parentConversationId === parentConversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((row) => {
        const session = this.read(row.id);
        return session ? [cloneSession(session)] : [];
      });
  }

  resumeAgent(taskId: string, input: ResumeAgentSessionInput): TaskSession {
    const session = this.require(taskId);
    if (session.parentConversationId !== input.parentConversationId) throw new Error("TASK_PARENT_MISMATCH");
    if (session.agent?.id !== input.agent.id) throw new Error("AGENT_IDENTITY_MISMATCH");
    if (session.agent.modelProfile !== input.agent.modelProfile
      || session.agent.savedModelProfileId !== input.agent.savedModelProfileId) throw new Error("AGENT_MODEL_PROFILE_CHANGED");
    if (session.mode !== input.mode) throw new Error("AGENT_MODE_MISMATCH");
    if (session.resolvedWorkspaceRoot !== input.resolvedWorkspaceRoot) throw new Error("AGENT_WORKSPACE_MISMATCH");
    return this.resumePrivateSession(session, input);
  }

  private resumePrivateSession(session: TaskSession, input: Pick<ResumeAgentSessionInput, "parentRunId" | "prompt">): TaskSession {
    if (session.status === "running") throw new Error("TASK_ALREADY_RUNNING");

    // 清掉上一轮的结果字段，再以新的子运行重新进入 running
    Object.assign(session, {
      parentRunId: input.parentRunId, childRunId: this.createChildRunId(), status: "running" as const,
      resultText: undefined, error: undefined, completedAt: undefined,
    });
    session.messages.push({ role: "user", content: input.prompt });
    session.updatedAt = this.now();
    const copy = cloneSession(session);
    this.write(session);
    return copy;
  }

  /** 把增量补丁合并进会话并落盘；只给出的字段才会被改动。 */
  checkpoint(taskId: string, delta: TaskSessionCheckpoint): TaskSession {
    const session = this.require(taskId);
    if (delta.parentRunId !== undefined) session.parentRunId = delta.parentRunId;
    if (delta.childRunId !== undefined) session.childRunId = delta.childRunId;
    if (delta.recoveryRunId !== undefined) {
      if (delta.recoveryRunId === null) delete session.recoveryRunId;
      else if (evidenceId(delta.recoveryRunId)) session.recoveryRunId = delta.recoveryRunId;
      else evidenceFailure();
    }
    if (delta.status !== undefined) session.status = delta.status;
    if (delta.messages !== undefined) session.messages = cloneSession({ ...session, messages: delta.messages }).messages;
    if (delta.trace !== undefined) session.trace = delta.trace.slice(-TRACE_LIMIT);
    if (delta.todoItems !== undefined) session.todoItems = cloneTodoItems(delta.todoItems);
    if (delta.uncertainEffects !== undefined) session.uncertainEffects = cloneUncertainEffects(delta.uncertainEffects);
    if (delta.writes !== undefined) session.writes = cloneWriteEvidence(delta.writes, session.agent.id);
    if (delta.executionEvents !== undefined) session.executionEvents = cloneExecutionEvents(delta.executionEvents, session.agent.id);
    if (delta.resultText !== undefined) session.resultText = delta.resultText;
    if (delta.error !== undefined) session.error = { ...delta.error };
    if (delta.completedAt !== undefined) session.completedAt = delta.completedAt;
    session.updatedAt = this.now();
    const copy = cloneSession(session);
    this.write(session);
    return copy;
  }

  private initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.readIndex();

    let changed = false;
    for (const filename of fs.readdirSync(this.sessionsDir)) {
      if (!/^agent-[a-f0-9]{64}\.json$/.test(filename)) continue;
      const id = filename.slice(0, -".json".length);
      if (this.index.has(id)) continue;
      const session = this.read(id);
      if (!session || session.id !== id || session.schemaVersion !== 2) throw new Error("AGENT_SESSION_IDENTITY_INVALID");
      this.index.set(id, this.indexRow(session));
      changed = true;
    }
    // 上次进程退出时仍处于 running 的会话，统一改为 interrupted
    for (const row of [...this.index.values()]) {
      const session = this.read(row.id);
      if (!session || session.status !== "running") continue;
      const recovered: TaskSession = { ...session, status: "interrupted", updatedAt: this.now() };
      this.writeSession(recovered);
      this.index.set(recovered.id, this.indexRow(recovered));
      changed = true;
    }
    if (changed) this.writeIndex();
  }

  private require(taskId: string): TaskSession {
    const session = this.read(taskId);
    if (!session) throw new Error("TASK_NOT_FOUND");
    return session;
  }

  private read(taskId: string): TaskSession | null {
    if (!AGENT_SESSION_ID.test(taskId)) return null;
    const file = path.join(this.sessionsDir, `${taskId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isTaskSession(parsed) || parsed.recoveryRunId !== undefined && !evidenceId(parsed.recoveryRunId)) throw new Error("TASK_SESSION_READ_FAILED");
      return {
        ...parsed,
        todoItems: cloneTodoItems(parsed.todoItems),
        uncertainEffects: cloneUncertainEffects(parsed.uncertainEffects),
        ...(parsed.writes === undefined ? {} : { writes: cloneWriteEvidence(parsed.writes, parsed.agent.id) }),
        ...(parsed.executionEvents === undefined ? {} : { executionEvents: cloneExecutionEvents(parsed.executionEvents, parsed.agent.id) }),
      };
    } catch {
      throw new Error("TASK_SESSION_READ_FAILED: 原文件已保留");
    }
  }

  private write(session: TaskSession): void {
    const previous = this.index.get(session.id);
    this.index.set(session.id, this.indexRow(session));
    try {
      this.writeIndex();
      this.writeSession(session);
    } catch (error) {
      if (previous) this.index.set(session.id, previous);
      else this.index.delete(session.id);
      throw error;
    }
  }

  private writeSession(session: TaskSession): void {
    const target = path.join(this.sessionsDir, `${session.id}.json`);
    this.atomicWrite(target, session);
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath, [...this.index.values()]);
  }

  private readIndex(): void {
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("TASK_INDEX_READ_FAILED");
      for (const row of parsed) {
        if (!row || typeof row !== "object") throw new Error("TASK_INDEX_READ_FAILED");
        const candidate = row as Partial<TaskSessionIndexRow>;
        const wellFormed = typeof candidate.id === "string" && typeof candidate.parentConversationId === "string"
          && isTaskStatus(candidate.status) && typeof candidate.updatedAt === "number";
        if (!wellFormed) throw new Error("TASK_INDEX_READ_FAILED");
        if (AGENT_SESSION_ID.test(candidate.id!)) this.index.set(candidate.id!, candidate as TaskSessionIndexRow);
      }
    } catch {
      throw new Error("TASK_INDEX_READ_FAILED: 原文件已保留");
    }
  }

  private indexRow(session: TaskSession): TaskSessionIndexRow {
    const { updatedAt, status, parentConversationId, id } = session;
    return { id, parentConversationId, status, updatedAt };
  }

  /** 先写到同目录的临时文件，再 rename 覆盖，避免写到一半时留下残缺的 JSON。 */
  private atomicWrite(filePath: string, value: unknown): void {
    const staging = `${filePath}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(staging, filePath);
  }
}
