import { AsyncLocalStorage } from "node:async_hooks";
/**
 * 会话轨迹的权威存储，属于 CTA 第一阶段。
 *
 * 数据分成两个文件，格式与 runStore 的 session JSON、events JSONL 保持一致：
 *   transcript.jsonl 逐行追加，每条记录一行 JSON，写完即刷盘；
 *   snapshot.json 是物化检查点，先写临时文件再 rename 替换。
 *
 * 约定如下：
 *   每个会话有独立的写队列，文件操作逐个执行，seq 也只在队列内分配；
 *   追加前检查末行是否完整，崩溃遗留的半行只裁掉尾部，之前的合法记录全部保留；
 *   幂等规则：entryId 以先写入者为准；user 条目以 (turnId, revision) 作次级键，语义相同则吸收，内容冲突则抛出 TRANSCRIPT_IDEMPOTENCY_CONFLICT；
 *   读取时先等队列空闲，再从快照的 throughSeq 开始回放 JSONL 增量，并重建幂等索引。
 */

import fs from "node:fs";
import path from "node:path";
import { ephemeralConversations } from "../ephemeral-conversations";
import { assertValidTranscriptDraft, userRevisionKey, type TranscriptAppendInput, type TranscriptEntry, type TranscriptSnapshot } from "./conversation-transcript-types";

import { assertSAssistantAppend, assertSAssistantSettlement, classifySAssistantSettlement } from "./conversation-transcript-settlement";

export class TranscriptPersistenceError extends Error {
  constructor(cause: unknown) {
    super("TRANSCRIPT_S_PERSISTENCE_UNKNOWN", {cause});
  }
}
const ROOT_DIR_NAME = "transcripts"; // userData 下的子目录名
const JSONL_FILE_NAME = "transcript.jsonl"; // 追加日志
const SNAPSHOT_FILE_NAME = "snapshot.json"; // 物化快照
const SCHEMA_VERSION = 1; // 快照的 schema 版本

export type TranscriptMutation = "append" | "delete" | "repair";

/** Optional trusted Main append gate; no IPC/caller JSON callbacks. */
export interface TranscriptAppendGuard {throughSeq:number;validate:(ticket:object)=>Promise<void>;commit:(write:()=>Promise<TranscriptEntry>,ticket:object)=>Promise<TranscriptEntry>}

export type ConversationTranscriptStoreOptions = { now?: () => number };

type LoadedConversationState = {
  seenUserRevisions: Set<string>;
  seenEntryIds: Set<string>;
  /** 全部条目里的最大 seq（快照条目加上增量行）。 */
  maxSeq: number;
  /** 快照的基线 seq，没有快照时为 0。 */
  throughSeq: number;
  entries: TranscriptEntry[];
};

/** 会话 id 不能为空，也不能含路径分隔符或是 "." / ".."，以免逃出 transcripts 目录。 */
function validConversationId(conversationId: string): boolean {
  const reserved = [".", ".."];
  const hasSeparator = conversationId.includes("/") || conversationId.includes("\\");
  return conversationId.length > 0 && !hasSeparator && !reserved.includes(conversationId);
}

/** 深度比较两个值，对象键的先后顺序不影响结果；供幂等语义判断使用。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => deepEqual(value, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.some((key, i) => key !== rightKeys[i])) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

/** 幂等比较时跳过信封字段 seq / at / id（次级键命中时 id 必然不同），其余字段要求完全一致。 */
function sameSemanticContent(input: TranscriptAppendInput, existing: TranscriptEntry): boolean {
  const { seq: _seq, at: _at, id: _id, ...storedBody } = existing;
  const { at: _inputAt, id: _inputId, ...draftBody } = input;
  return deepEqual(draftBody, storedBody);
}

export class ConversationTranscriptStore {
  private readonly now: () => number;
  private readonly root: string;
  /** 每个会话的写队列尾部（已结算的 Promise），所有文件操作都从这里串行排队。 */
  private readonly heldTickets = new WeakMap<object,{sessionId:string;phase:"validate"|"other";readActive:boolean;snapshot?:TranscriptSnapshot;busy:boolean;pending:Set<Promise<unknown>>;failed:boolean;failure?:unknown}>();
  private readonly guardReadScope = new AsyncLocalStorage<object>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly mutationObservers = new Map<string, (kind: TranscriptMutation, entry?: TranscriptEntry,ticket?:object) => Promise<void>>();

  constructor(userDataRoot: string, options?: ConversationTranscriptStoreOptions) {
    this.root = path.join(userDataRoot, ROOT_DIR_NAME);
    this.now = options?.now ?? (() => Date.now());
  }

  append(conversationId: string, input: TranscriptAppendInput, guard?: TranscriptAppendGuard): Promise<TranscriptEntry> {
    // 入队前先做协议校验，非法草稿快速失败且不占队列
    assertValidTranscriptDraft(input);
    const sWrite = input.kind === "assistant_settlement" || input.kind === "assistant" && Object.hasOwn(input, "sSettlement");
    if (sWrite)
      input = structuredClone(input);
    return this.enqueue(conversationId, async () => {
      const ticket=Object.freeze({}),held={sessionId:conversationId,phase:"other" as "validate"|"other",readActive:false,snapshot:undefined as TranscriptSnapshot|undefined,busy:false,pending:new Set<Promise<unknown>>(),failed:false,failure:undefined as unknown};
      if(guard)this.heldTickets.set(ticket,held);
      try {
      const state = await this.loadState(conversationId);
      if (guard) {
        held.snapshot=structuredClone({schemaVersion:SCHEMA_VERSION,throughSeq:state.maxSeq,entries:state.entries,seenEntryIds:[...state.seenEntryIds],seenUserRevisions:[...state.seenUserRevisions]});
        if (state.maxSeq !== guard.throughSeq)
          throw Error("MEMORY_CONTEXT_TRANSCRIPT_STALE");
        held.phase="validate";held.readActive=true;
        try { await this.guardReadScope.run(ticket,()=>guard.validate(ticket)); } finally {
          held.phase="other";held.readActive=false;
          await Promise.allSettled([...held.pending]);
          if(held.failed)throw held.failure;
        }
      }
      // 幂等主键：entryId 已存在，first-write-wins，返回原条目
      const existingById = state.entries.find((entry) => entry.id === input.id);
      if (existingById) {
        if (guard)
          throw Error("MEMORY_CONTEXT_STREAM_RUN_REUSED");
        if (existingById.kind !== input.kind)
          throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        if (input.kind === "assistant_settlement" && existingById.kind === "assistant_settlement") {
          const { safeReason: _a, ...expected } = input.payload, { safeReason: _b, ...persisted } = existingById.payload;
          if (!deepEqual(expected, persisted) || classifySAssistantSettlement(state.entries, input.payload.binding.assistantEntryId) !== input.payload.result)
            throw Error("TRANSCRIPT_S_SETTLEMENT_CONFLICT");
          try { await this.syncJsonl(conversationId); }
          catch (error) { throw new TranscriptPersistenceError(error); }
        }
        else if (sWrite && !sameSemanticContent(input, existingById))
          throw Error("TRANSCRIPT_S_BINDING_INVALID");
        return existingById;
      }
      // user 次级键 (turnId, revision)：同键语义等价吸收返回持有者，内容不同抛冲突
      if (input.kind === "user" && input.turnId && input.revision) {
        const holder = state.entries.find((entry) => entry.kind === "user" && entry.turnId === input.turnId && entry.revision === input.revision);
        if (holder) {
          if (sameSemanticContent(input, holder))
            return holder;
          throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        }
      }
      if (input.kind === "assistant_settlement")
        assertSAssistantSettlement(state.entries, input);
      else if (input.kind === "assistant" && input.sSettlement)
        assertSAssistantAppend(state.entries, {
          runId: input.runId!, assistantTurnId: input.turnId!, userTurnId: input.sSettlement.userTurnId, userRevision: input.sSettlement.userRevision,
        });
      // seq 只在队列内分配：现有最大 seq + 1（快照基线 + 已重放增量）
      const entry = { ...input, seq: state.maxSeq + 1, at: input.at ?? this.now() } as TranscriptEntry;
      await this.beforeMutation(conversationId, "append", structuredClone(entry),guard?ticket:undefined);
      const dir = this.conversationDir(conversationId);
      const memory = this.memoryOf(conversationId);
      if (!memory) await fs.promises.mkdir(dir, { recursive: true });
      // The final Main gate calls this write directly while holding its coordinator.
      let dispatched = false;
      const write = async () => {
        if(guard&&held.failed)throw held.failure;
        if(guard&&held.pending.size)throw Error("TRANSCRIPT_HELD_READ_PENDING");
        dispatched = true;
        if (memory) memory.log += `${JSON.stringify(entry)}\n`;
        else await fs.promises.appendFile(path.join(dir, JSONL_FILE_NAME), `${JSON.stringify(entry)}\n`, "utf8");
        if (sWrite)
          await this.syncJsonl(conversationId);
        return entry;
      };
      try {
        if(!guard)return await write();
        held.readActive=true;
        try{return await this.guardReadScope.run(ticket,()=>guard.commit(write,ticket))}
        finally{held.readActive=false;await Promise.allSettled([...held.pending]);if(held.failed)throw held.failure}
      }
      catch (error) {
        if (sWrite && dispatched)
          throw new TranscriptPersistenceError(error);
        throw error;
      }
      } finally { this.heldTickets.delete(ticket); }
    });
  }

  /** Re-read and sync a complete exact marker after uncertain append acknowledgement; never retries a write. */
  confirmSAssistantSettlement(conversationId: string, draft: Extract<TranscriptAppendInput, {kind: "assistant_settlement"}>): Promise<boolean> {
    assertValidTranscriptDraft(draft);
    const expected = structuredClone(draft);
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId), found = state.entries.find(entry => entry.id === expected.id);
      if (!found || found.kind !== "assistant_settlement")
        return false;
      const { safeReason: _a, ...a } = found.payload, { safeReason: _b, ...b } = expected.payload;
      if (!deepEqual(a, b) || found.runId !== expected.runId || found.turnId !== expected.turnId
        || classifySAssistantSettlement(state.entries, expected.payload.binding.assistantEntryId) !== expected.payload.result)
        return false;
      await this.syncJsonl(conversationId);
      return true;
    });
  }

  /**
   * A temporary conversation (see ephemeral-conversations) is kept in this process's memory
   * and never touches disk. The same log and snapshot semantics apply to the in-memory text.
   */
  private readonly ephemeralState = new Map<string, { log: string; snapshot: string | null }>();
  private memoryOf(conversationId: string): { log: string; snapshot: string | null } | undefined {
    if (!ephemeralConversations.has(conversationId)) return undefined;
    let state = this.ephemeralState.get(conversationId);
    if (!state) { state = { log: "", snapshot: null }; this.ephemeralState.set(conversationId, state); }
    return state;
  }

  private async syncJsonl(conversationId: string): Promise<void> {
    if (this.memoryOf(conversationId)) return;
    const handle = await fs.promises.open(path.join(this.conversationDir(conversationId), JSONL_FILE_NAME), "r+");
    try {
      await handle.sync();
    }
    finally {
      await handle.close();
    }
  }

  read(conversationId: string): Promise<TranscriptSnapshot> {
    return this.enqueue(conversationId, async () => this.toSnapshot(await this.loadState(conversationId)));
  }

  checkpoint(conversationId: string): Promise<TranscriptSnapshot> {
    return this.enqueue(conversationId, async () => {
      const snapshot = this.toSnapshot(await this.loadState(conversationId));
      const dir = this.conversationDir(conversationId);
      const memory = this.memoryOf(conversationId);
      if (memory) {
        memory.snapshot = JSON.stringify(snapshot);
        return snapshot;
      }
      await fs.promises.mkdir(dir, { recursive: true });
      // 先写到临时文件，再 rename 覆盖正式快照，JSONL 本身不改动
      const scratch = path.join(dir, `${SNAPSHOT_FILE_NAME}.${process.pid}.tmp`);
      await fs.promises.writeFile(scratch, JSON.stringify(snapshot), "utf8");
      await fs.promises.rename(scratch, path.join(dir, SNAPSHOT_FILE_NAME));
      return snapshot;
    });
  }

  /** 把已加载的状态整理成对外的快照结构，字段顺序固定。 */
  private toSnapshot(state: LoadedConversationState): TranscriptSnapshot {
    return { schemaVersion: SCHEMA_VERSION, throughSeq: state.maxSeq, entries: state.entries, seenEntryIds: [...state.seenEntryIds], seenUserRevisions: [...state.seenUserRevisions] };
  }

  waitForIdle(conversationId: string): Promise<void> {
    const pending = this.queues.get(conversationId);
    return pending ? pending.then(() => undefined) : Promise.resolve();
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.enqueue(conversationId, async () => {
      await this.beforeMutation(conversationId, "delete");
      if (this.memoryOf(conversationId)) { this.ephemeralState.delete(conversationId); return; }
      await fs.promises.rm(this.conversationDir(conversationId), { recursive: true, force: true });
    });
  }


  /** A single trusted Main observer; inactive by default for ordinary stores. */
  observeMutations(conversationId: string, before: (kind: TranscriptMutation, entry?: TranscriptEntry,ticket?:object) => Promise<void>): () => void {
    this.conversationDir(conversationId);
    if (this.mutationObservers.has(conversationId)) throw new Error("TRANSCRIPT_OBSERVER_EXISTS");
    this.mutationObservers.set(conversationId, before);
    return () => {
      if (this.mutationObservers.get(conversationId) === before) this.mutationObservers.delete(conversationId);
    };
  }

  /** Serialize a trusted readonly acquisition without loading or repairing source state. */
  withReadonlyBarrier<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    this.conversationDir(conversationId);
    return this.enqueue(conversationId, operation);
  }

  /** Exact opaque queue ownership, usable only by the current guarded validation callback. */
  async withHeldReadonlyBarrier<T>(ticket:object,conversationId:string,root:string,operation:()=>Promise<T>):Promise<T> {
    const held=this.heldTickets.get(ticket);
    if(!held||held.phase!=="validate"||held.busy||held.sessionId!==conversationId||path.resolve(root)!==path.resolve(this.root))throw Error("TRANSCRIPT_HELD_TICKET_DENIED");
    held.busy=true;
    const pending=Promise.resolve().then(operation);held.pending.add(pending);
    try{return await pending}catch(error){if(!held.failed){held.failed=true;held.failure=error}throw error}finally{held.pending.delete(pending);held.busy=false}
  }

  /** Reentrant read of the immutable pre-append view, only in this exact guard's async scope. */
  async withHeldReadLease<T>(ticket:object,conversationId:string,operation:(read:()=>Promise<TranscriptSnapshot>)=>Promise<T>):Promise<T>{
    const held=this.heldTickets.get(ticket);
    if(!held||!held.readActive||!held.snapshot||held.sessionId!==conversationId||this.guardReadScope.getStore()!==ticket)throw Error("TRANSCRIPT_HELD_TICKET_DENIED");
    let active=true;
    const read=async()=>{
      if(!active||!held.readActive||this.heldTickets.get(ticket)!==held||this.guardReadScope.getStore()!==ticket)throw Error("TRANSCRIPT_LEASE_EXPIRED");
      return structuredClone(held.snapshot!);
    };
    const pending=Promise.resolve().then(()=>operation(read));held.pending.add(pending);
    try{return await pending}catch(error){if(!held.failed){held.failed=true;held.failure=error}throw error}
    finally{active=false;held.pending.delete(pending)}
  }

  /** Hold the existing queue through the consumer's read/validate/publish operation. */
  withReadLease<T>(conversationId: string, operation: (read: () => Promise<TranscriptSnapshot>) => Promise<T>): Promise<T> {
    this.conversationDir(conversationId);
    const ticket=this.guardReadScope.getStore();
    if(ticket){
      const held=this.heldTickets.get(ticket);
      if(!held||!held.readActive)return Promise.reject(Error("TRANSCRIPT_HELD_TICKET_DENIED"));
      if(held.sessionId===conversationId)return this.withHeldReadLease(ticket,conversationId,operation);
    }
    return this.enqueue(conversationId, async () => {
      let active = true;
      let pending: Promise<LoadedConversationState> | undefined;
      const read = async (): Promise<TranscriptSnapshot> => {
        if (!active) throw new Error("TRANSCRIPT_LEASE_EXPIRED");
        if (!pending) {
          pending = this.loadState(conversationId);
          void pending.catch(() => undefined);
        }
        const state = await pending;
        return structuredClone({
          schemaVersion: SCHEMA_VERSION,
          throughSeq: state.maxSeq,
          entries: state.entries,
          seenEntryIds: [...state.seenEntryIds],
          seenUserRevisions: [...state.seenUserRevisions],
        });
      };
      try { return await operation(read); }
      finally {
        active = false;
        // Even a consumer that forgot to await its read cannot release the queue early.
        await pending?.then(() => undefined, () => undefined);
      }
    });
  }

  private async beforeMutation(conversationId: string, kind: TranscriptMutation, entry?: TranscriptEntry,ticket?:object): Promise<void> {
    await this.mutationObservers.get(conversationId)?.(kind, entry,ticket);
  }

  /** 解析会话目录，先校验 id，防止路径穿越。 */
  private conversationDir(conversationId: string): string {
    if (!validConversationId(conversationId)) throw new Error("TRANSCRIPT_INVALID_CONVERSATION_ID");
    return path.join(this.root, conversationId);
  }

  /** 串行执行：同一会话的操作按入队顺序一个个来，前一个失败不会卡住后面的。 */
  private enqueue<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(conversationId) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(conversationId, tail);
    return run.finally(() => {
      if (this.queues.get(conversationId) === tail) this.queues.delete(conversationId);
    });
  }

  /** 加载会话状态：尾行修复、快照基线，再把 seq 大于 throughSeq 的 JSONL 行重放进来。 */
  private async loadState(conversationId: string): Promise<LoadedConversationState> {
    const dir = this.conversationDir(conversationId);
    const jsonlFile = path.join(dir, JSONL_FILE_NAME); // 日志路径，仅在磁盘模式下用到

    const memory = this.memoryOf(conversationId);
    let text = memory ? memory.log : "";
    if (!memory) {
      // 新会话还没有日志文件，按空日志处理；其他错误照常上抛
      text = await fs.promises.readFile(jsonlFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
    }

    // 尾行容错：只修剪非空的未终止或不可解析的尾行，保留此前所有合法条目
    const { kept, lines } = repairTruncatedTail(text);
    if (kept !== text) {
      await this.beforeMutation(conversationId, "repair");
      if (memory) memory.log = kept;
      else {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.truncate(jsonlFile, Buffer.byteLength(kept, "utf8"));
      }
    }

    const base: TranscriptSnapshot | null = memory
      ? (memory.snapshot ? JSON.parse(memory.snapshot) as TranscriptSnapshot : null)
      : await this.readSnapshotFile(dir);
    const throughSeq = base?.throughSeq ?? 0;
    const entries: TranscriptEntry[] = [...(base?.entries ?? [])];
    const seenEntryIds = new Set<string>(base?.seenEntryIds ?? []);
    const seenUserRevisions = new Set<string>(base?.seenUserRevisions ?? []);

    for (const line of lines) {
      if (line.trim() === "") continue;
      const entry = parseEntryRow(line);
      if (entry.seq <= throughSeq) continue;
      entries.push(entry);
      seenEntryIds.add(entry.id);
      if (entry.kind === "user" && entry.turnId && typeof entry.revision === "number") {
        seenUserRevisions.add(userRevisionKey(entry.turnId, entry.revision));
      }
    }

    const maxSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), throughSeq);
    return { entries, throughSeq, maxSeq, seenEntryIds, seenUserRevisions };
  }

  /** 读取磁盘快照：文件不存在时返回 null；schema 版本不符同样视为没有快照。 */
  private async readSnapshotFile(dir: string): Promise<TranscriptSnapshot | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(dir, SNAPSHOT_FILE_NAME), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = JSON.parse(raw) as TranscriptSnapshot;
    return parsed?.schemaVersion === SCHEMA_VERSION ? parsed : null;
  }
}

/** 解析日志中的一行；格式不对（无法解析，或缺少 id / seq）时抛出 TRANSCRIPT_CORRUPT_ROW。 */
function parseEntryRow(line: string): TranscriptEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // 中间行损坏属于数据损坏，直接报错（尾行已在修复步骤里处理掉）
    throw new Error("TRANSCRIPT_CORRUPT_ROW");
  }
  const candidate = value as TranscriptEntry;
  const wellFormed = Boolean(candidate) && typeof candidate === "object" && typeof candidate.id === "string" && typeof candidate.seq === "number";
  if (!wellFormed) throw new Error("TRANSCRIPT_CORRUPT_ROW");
  return candidate;
}

/**
 * 裁掉被截断的尾行，返回保留下来的文本，以及可以安全解析的完整行。
 * 没有换行结尾的最后一行是崩溃留下的半行，即便碰巧能解析也不信任，直接截到最后一个换行。
 */
function repairTruncatedTail(text: string): { kept: string; lines: string[] } {
  if (text === "") return { kept: "", lines: [] };
  const body = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const lines = body.split("\n");
  lines.pop(); // split 之后末尾必然多出一个空串，去掉它
  // 从尾部往前清理：空行丢弃；遇到第一个能解析的非空行就停下
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === "") {
      lines.pop();
      continue;
    }
    try {
      JSON.parse(last);
      break;
    } catch {
      lines.pop();
    }
  }
  const kept = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return { kept, lines };
}

const storeCache = new Map<string, ConversationTranscriptStore>();

/** 同一个根目录只创建一份 store，从而共享同一套会话写队列。 */
export function getConversationTranscriptStore(userDataRoot: string): ConversationTranscriptStore {
  const cacheKey = path.resolve(userDataRoot);
  const cached = storeCache.get(cacheKey);
  if (cached) return cached;
  const created = new ConversationTranscriptStore(userDataRoot);
  storeCache.set(cacheKey, created);
  return created;
}
