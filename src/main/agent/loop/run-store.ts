import fs from "node:fs";
import { fireflyDataDirectory } from "../../base/storage/firefly-data-paths";
import path from "node:path";
import { ephemeralConversations } from "../../base/storage/ephemeral-conversations";
import type { ChatMessage } from "../../model/providers/types";
import { INITIAL_AGENT_LOOP_CACHE_STATE, type SideEffectKind, type AgentLoopCacheState, type AgentState } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";

export type AgentRunStatus = "failed" | "cancelled" | "completed" | "interrupted" | "running";
export type PersistedToolCallStatus = "not_executed" | "unknown" | "committed" | "started" | "planned";
export type AgentRunRequestSnapshot = {
  workspaceRoot?: string; enabledToolIds?: string[]; toolSchemaFingerprint: string; promptFingerprint: string;
  mode?: string; reasoning?: string; contextWindowTokens: number; model: string; provider: string;
};
export type PersistedToolCall = {
  updatedAt: number; status: PersistedToolCallStatus; sideEffect: SideEffectKind; toolName: string; toolCallId: string;
};
export type AgentRunSession = {
  resumedFromRunId?: string; completedAt?: number; updatedAt: number; createdAt: number;
  request: AgentRunRequestSnapshot; cache: AgentLoopCacheState; rounds: number; toolCalls: PersistedToolCall[];
  toolOutputs: ToolOutputRef[]; state: AgentState; messages: ChatMessage[]; status: AgentRunStatus;
  runId: string; conversationId: string; schemaVersion: 1;
};
export type CreateAgentRunInput = {
  resumedFromRunId?: string; cache?: AgentLoopCacheState; state?: AgentState; request: AgentRunRequestSnapshot;
  messages: ChatMessage[]; runId: string; conversationId: string;
};
export type AgentRunCheckpoint = {
  request?: AgentRunRequestSnapshot; cache?: AgentLoopCacheState; rounds?: number; toolOutputs?: ToolOutputRef[];
  todoItems?: AgentState["todoItems"]; state?: AgentState; messages?: ChatMessage[];
};
export type AgentRunStoreOptions = { now?: () => number };
/** What context assembly and recovery checks need from a run: identity, status and tool execution, never messages. */
export type AgentRunEvidence = Pick<AgentRunSession, "runId" | "conversationId" | "status" | "toolCalls">;
/** Persisted runs kept parsed in memory; every write goes through this store, so a cached run is never stale. */
const LOADED_RUN_LIMIT = 24;
type IndexRow = { updatedAt: number; status: AgentRunStatus; runId: string; conversationId: string };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function validRunId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}
function isRunStatus(value: unknown): value is AgentRunStatus {
  return value === "running" || value === "interrupted" || value === "completed" || value === "cancelled" || value === "failed";
}
function isCacheState(value: unknown): value is AgentLoopCacheState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentLoopCacheState>;
  if (typeof candidate.cacheEpoch !== "number" || !Number.isInteger(candidate.cacheEpoch) || !(candidate.cacheEpoch > 0)) return false;
  return candidate.epochReason === "run_start" || candidate.epochReason === "compaction" || candidate.epochReason === "recovery"
    || candidate.epochReason === "model_changed" || candidate.epochReason === "tool_catalog_changed" || candidate.epochReason === "prompt_version_changed";
}
function isSession(value: unknown): value is AgentRunSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<AgentRunSession>;
  return entry.schemaVersion === 1 && typeof entry.conversationId === "string"
    && typeof entry.runId === "string" && validRunId(entry.runId) && isRunStatus(entry.status)
    && Array.isArray(entry.messages) && !!entry.state && Array.isArray(entry.state.todoItems) && Array.isArray(entry.state.uncertainEffects)
    && Array.isArray(entry.toolOutputs) && Array.isArray(entry.toolCalls) && typeof entry.rounds === "number"
    && (entry.cache === undefined || isCacheState(entry.cache)) && !!entry.request
    && typeof entry.createdAt === "number" && typeof entry.updatedAt === "number";
}
function indexEntry(session: AgentRunSession): IndexRow {
  return { conversationId: session.conversationId, runId: session.runId, status: session.status, updatedAt: session.updatedAt };
}
export class AgentRunStore {
  private readonly directory: string;
  private readonly indexFile: string;
  private readonly clock: () => number;
  private readonly rows = new Map<string, IndexRow>();
  private readonly volatile = new Map<string, AgentRunSession>();
  private readonly loaded = new Map<string, AgentRunSession>();
  /** Evidence of every run read or written in this process; small, so it is kept for the store's lifetime. */
  private readonly evidenceByRun = new Map<string, AgentRunEvidence>();
  private pendingIndex: ReturnType<typeof setTimeout> | undefined;
  private writes = 0;
  private characters = 0;
  private checkpoints = 0;
  constructor(userDataRoot: string, options: AgentRunStoreOptions = {}) {
    const rootDirectory = fireflyDataDirectory(userDataRoot, "runs");
    this.directory = path.join(rootDirectory, "sessions");
    this.indexFile = path.join(rootDirectory, "index.json");
    this.clock = options.now ?? Date.now;
    this.initialize();
  }
  create(input: CreateAgentRunInput): AgentRunSession {
    if (!input.conversationId || !validRunId(input.runId)) throw new Error("AGENT_RUN_INVALID_ID");
    if (this.get(input.runId)?.status === "running") throw new Error("AGENT_RUN_EXISTS");
    const timestamp = this.clock();
    const created: AgentRunSession = {
      schemaVersion: 1, conversationId: input.conversationId, runId: input.runId, status: "running",
      messages: copy(input.messages), state: copy(input.state ?? { todoItems: [], uncertainEffects: [] }),
      toolOutputs: [], toolCalls: [], rounds: 0, cache: copy(input.cache ?? INITIAL_AGENT_LOOP_CACHE_STATE), request: copy(input.request),
      ...(input.resumedFromRunId ? { resumedFromRunId: input.resumedFromRunId } : {}), createdAt: timestamp, updatedAt: timestamp,
    };
    this.persist(created, "now");
    this.journal(created, "run_created");
    return copy(created);
  }
  get(runId: string): AgentRunSession | null {
    const found = this.load(runId);
    return found ? copy(found) : null;
  }
  /** The whole run (same as get); named for TranscriptRunReader.session. */
  session(runId: string): AgentRunSession | null { return this.get(runId); }
  /** A light read for hot paths: copies only the run's identity, status and tool calls. */
  evidence(runId: string): AgentRunEvidence | null {
    if (!validRunId(runId)) return null;
    const known = this.volatile.get(runId) ?? this.evidenceByRun.get(runId) ?? this.load(runId);
    return known ? { runId: known.runId, conversationId: known.conversationId, status: known.status, toolCalls: copy(known.toolCalls) } : null;
  }
  private noteEvidence(session: AgentRunSession): void {
    this.evidenceByRun.set(session.runId, { runId: session.runId, conversationId: session.conversationId, status: session.status, toolCalls: copy(session.toolCalls) });
  }
  getLatestInterrupted(conversationId: string): AgentRunSession | null {
    const latest = Array.from(this.rows.values()).filter((entry) => entry.conversationId === conversationId && entry.status === "interrupted")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return latest ? this.get(latest.runId) : null;
  }
  checkpoint(runId: string, patch: AgentRunCheckpoint): AgentRunSession {
    const current = this.mustLoad(runId);
    if (patch.messages !== undefined) current.messages = copy(patch.messages);
    if (patch.state !== undefined) current.state = copy(patch.state);
    if (patch.todoItems !== undefined) current.state.todoItems = copy(patch.todoItems);
    if (patch.toolOutputs !== undefined) current.toolOutputs = copy(patch.toolOutputs);
    if (patch.rounds !== undefined) current.rounds = patch.rounds;
    if (patch.cache !== undefined) current.cache = copy(patch.cache);
    if (patch.request !== undefined) current.request = copy(patch.request);
    current.updatedAt = this.clock();
    this.checkpoints++;
    this.persist(current);
    this.journal(current, "checkpoint");
    return copy(current);
  }
  recordTool(runId: string, input: Omit<PersistedToolCall, "updatedAt">): AgentRunSession { return this.recordTools(runId, [input]); }
  recordTools(runId: string, inputs: readonly Omit<PersistedToolCall, "updatedAt">[]): AgentRunSession {
    const current = this.mustLoad(runId);
    if (inputs.length === 0) return copy(current);
    const timestamp = this.clock();
    for (const update of inputs) {
      const merged: PersistedToolCall = { ...update, updatedAt: timestamp };
      const position = current.toolCalls.findIndex((call) => call.toolCallId === update.toolCallId);
      if (position >= 0) current.toolCalls[position] = merged;
      else current.toolCalls.push(merged);
    }
    current.updatedAt = timestamp;
    this.persist(current);
    for (const update of inputs) this.journal(current, `tool_${update.status}`, { toolCallId: update.toolCallId });
    return copy(current);
  }
  recordCompaction(runId: string, input: { status: "started" | "committed"; messageCountBefore: number; messageCountAfter?: number }): void {
    const current = this.mustLoad(runId);
    this.journal(current, `compaction_${input.status}`, { messageCountBefore: input.messageCountBefore,
      ...(input.messageCountAfter !== undefined ? { messageCountAfter: input.messageCountAfter } : {}) });
  }
  markTerminal(runId: string, status: Exclude<AgentRunStatus, "running" | "interrupted">): AgentRunSession {
    const current = this.mustLoad(runId);
    current.status = status;
    current.completedAt = this.clock();
    current.updatedAt = current.completedAt;
    this.persist(current, "now");
    this.journal(current, `run_${status}`);
    console.log(`[AgentRunStore] run=${runId} terminal=${status} diskWrites=${this.writes} diskBytes=${this.characters} checkpoints=${this.checkpoints}`);
    return copy(current);
  }
  deleteConversation(conversationId: string): void {
    const matches = Array.from(this.rows.values()).filter((entry) => entry.conversationId === conversationId);
    let hadDiskData = false;
    for (const entry of matches) {
      this.loaded.delete(entry.runId);
      this.evidenceByRun.delete(entry.runId);
      if (this.volatile.delete(entry.runId)) { this.rows.delete(entry.runId); continue; }
      hadDiskData = true;
      const snapshot = this.sessionPath(entry.runId);
      if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
      const events = this.eventPath(entry.runId);
      if (fs.existsSync(events)) fs.unlinkSync(events);
      this.rows.delete(entry.runId);
    }
    if (hadDiskData || !matches.length) this.writeIndexNow();
  }
  private initialize(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    this.readIndex();
    let dirty = false;
    for (const entry of Array.from(this.rows.values())) {
      if (!fs.existsSync(this.sessionPath(entry.runId))) {
        this.rows.delete(entry.runId);
        dirty = true;
        continue;
      }
      const current = this.load(entry.runId);
      if (!current) continue;
      if (current.status === "running") {
        current.status = "interrupted";
        current.updatedAt = this.clock();
        this.persist(current, "now");
        this.journal(current, "run_interrupted");
        dirty = true;
      } else if (entry.status !== current.status || entry.updatedAt !== current.updatedAt) {
        this.rows.set(entry.runId, indexEntry(current));
        dirty = true;
      }
    }
    if (dirty) this.writeIndexNow();
  }
  private mustLoad(runId: string): AgentRunSession {
    const current = this.load(runId);
    if (current) return current;
    throw new Error("AGENT_RUN_NOT_FOUND");
  }
  private load(runId: string): AgentRunSession | null {
    if (!validRunId(runId)) return null;
    const memory = this.volatile.get(runId);
    if (memory) return memory;
    const cached = this.loaded.get(runId);
    if (cached) { this.remember(cached); return cached; }
    const filename = this.sessionPath(runId);
    if (!fs.existsSync(filename)) return null;
    let session: AgentRunSession;
    try {
      const decoded = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
      if (!isSession(decoded)) throw new Error("AGENT_RUN_READ_FAILED");
      session = { ...decoded, cache: isCacheState(decoded.cache) ? decoded.cache : { ...INITIAL_AGENT_LOOP_CACHE_STATE } };
    } catch { throw new Error("AGENT_RUN_READ_FAILED: 原文件已保留"); }
    this.remember(session);
    this.noteEvidence(session);
    return session;
  }
  private remember(session: AgentRunSession): void {
    this.loaded.delete(session.runId);
    this.loaded.set(session.runId, session);
    if (this.loaded.size > LOADED_RUN_LIMIT) this.loaded.delete(this.loaded.keys().next().value!);
  }
  private persist(session: AgentRunSession, mode: "now" | "lazy" = "lazy"): void {
    const memoryOnly = this.volatile.has(session.runId) || ephemeralConversations.has(session.conversationId);
    if (memoryOnly) this.volatile.set(session.runId, session);
    else {
      // Callers mutate the loaded session before persisting it. If the write fails, memory must not stay ahead of
      // disk: forget the cached copy so the next read sees what was actually saved.
      try { this.atomicWrite(this.sessionPath(session.runId), session); }
      catch (failure) { this.loaded.delete(session.runId); this.evidenceByRun.delete(session.runId); throw failure; }
      this.remember(session); this.noteEvidence(session);
    }
    this.rows.set(session.runId, indexEntry(session));
    if (memoryOnly) return;
    if (mode === "now") this.writeIndexNow();
    else this.writeIndexLazy();
  }
  private readIndex(): void {
    if (!fs.existsSync(this.indexFile)) return;
    try {
      const decoded = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as unknown;
      if (!Array.isArray(decoded)) throw new Error("AGENT_RUN_INDEX_READ_FAILED");
      for (const item of decoded) {
        if (!item || typeof item !== "object") throw new Error("AGENT_RUN_INDEX_READ_FAILED");
        const row = item as Partial<IndexRow>;
        if (typeof row.conversationId !== "string" || typeof row.runId !== "string" || !validRunId(row.runId)
          || !isRunStatus(row.status) || typeof row.updatedAt !== "number") throw new Error("AGENT_RUN_INDEX_READ_FAILED");
        this.rows.set(row.runId, row as IndexRow);
      }
    } catch { throw new Error("AGENT_RUN_INDEX_READ_FAILED: 原文件已保留"); }
  }
  private writeIndexLazy(): void {
    if (this.pendingIndex !== undefined) return;
    this.pendingIndex = setTimeout(() => {
      this.pendingIndex = undefined;
      try { this.writeIndexNow(); }
      catch (failure) { console.warn("[AgentRunStore] lazy index write failed:", failure); }
    }, 500);
  }
  private writeIndexNow(): void {
    if (this.pendingIndex !== undefined) { clearTimeout(this.pendingIndex); this.pendingIndex = undefined; }
    this.atomicWrite(this.indexFile, Array.from(this.rows.values()).filter((entry) => !this.volatile.has(entry.runId)));
  }
  private journal(session: AgentRunSession, type: string, data?: Record<string, unknown>): void {
    if (!this.volatile.has(session.runId)) fs.appendFileSync(this.eventPath(session.runId), `${JSON.stringify({ at: session.updatedAt, type, ...data })}\n`, "utf8");
  }
  private sessionPath(runId: string): string { return path.join(this.directory, `${runId}.json`); }
  private eventPath(runId: string): string { return path.join(this.directory, `${runId}.events.jsonl`); }
  private atomicWrite(file: string, value: unknown): void {
    const staging = `${file}.${process.pid}.tmp`;
    const serialized = JSON.stringify(value);
    fs.writeFileSync(staging, serialized, "utf8");
    fs.renameSync(staging, file);
    this.writes++;
    this.characters += serialized.length;
  }
}
const storesByRoot = new Map<string, AgentRunStore>();
export function getAgentRunStore(userDataRoot: string): AgentRunStore {
  const root = path.resolve(userDataRoot);
  const known = storesByRoot.get(root);
  if (known) return known;
  const created = new AgentRunStore(root);
  storesByRoot.set(root, created);
  return created;
}
