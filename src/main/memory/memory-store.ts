import { ConflictLog, L0Profile, L1Profile, L2DmaeState, L2Memory, L2SyncStatus, MemoryConflictResolution, MemoryEvidence, MemoryStore, ReflectionLog } from "./memory-types"
import { appendMemoryTrace, type MemoryTraceEvent } from "./memory-trace"
import { isImportingMemory } from "./obsidian-sync-flag"
import { memoryFileExists, readMemoryFile, resolveMemoryPath, writeMemoryFile } from "./memory-store-io"
import { extractMemoryKeywords, createDefaultMemoryStore, boundMemorySnippet, isCurrentMemoryStore, CURRENT_MEMORY_SCHEMA_VERSION } from "./memory-store-defaults"

const QUOTE_SNIPPET_MAX = 300
const REFLECTION_LOG_CAP = 50
const CONFLICT_LOG_CAP = 100
const READ_FAILED_MESSAGE = "MEMORY_STORE_READ_FAILED: 记忆读取失败，原文件已保留"

const RESOLVER_PRIORITY_RANK: Record<string, number> = { none: 0, idle: 1, normal: 2, high: 3 }

export type L0WritableField = Exclude<keyof L0Profile, "updatedAt">
export type L1WritableField = keyof L1Profile
export type L2Input = Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status" | "keywords">

const newId = (prefix: string): string => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const freshDmaeState = (l2Id: string): L2DmaeState => ({
  l2Id,
  activation: 0,
  intrinsicValue: 0,
  userSilence: 0,
  modelSilence: 0,
  recentUserHits: [],
  state: "archived",
})

/** 记录一条 trace；字段顺序固定为 op、layer、status、l2Id、ragId、details */
function trace(
  op: string,
  layer: NonNullable<MemoryTraceEvent["layer"]>,
  target: { l2Id?: string; ragId?: string } | null,
  details?: Record<string, unknown>,
  outcome: { status?: MemoryTraceEvent["status"]; error?: string | null } = {},
): void {
  const event: MemoryTraceEvent = { op, layer, status: outcome.status ?? "ok" }
  if (target) {
    event.l2Id = target.l2Id
    event.ragId = target.ragId
  }
  if (details) event.details = details
  if (outcome.error !== undefined) event.error = outcome.error
  appendMemoryTrace(event)
}

/** trace details 里指向某条冲突日志的两个固定字段 */
const conflictRef = (log: ConflictLog) => ({ conflictLogId: log.id, targetL2Id: log.targetL2Id })

/** 日志类 trace 里常用的“以某条 L2 为主体”的写法 */
const l2Subject = (row: { id: string; ragId?: string }) => ({ l2Id: row.id, ragId: row.ragId })

function buildEvidence(memory: L2Memory, input: L2Input): MemoryEvidence {
  const quote = boundMemorySnippet(input.triggerText || input.content, QUOTE_SNIPPET_MAX)
  return {
    id: newId("ev"),
    memoryId: memory.id,
    quoteSnippet: quote ?? "",
    conversationId: input.sourceConversationId || undefined,
    messageIds: input.sourceMessageIds,
    createdAt: Date.now(),
    sourceStatus: "active",
  }
}

/** 为输入建出完整的 L2 记忆，并生成一条 evidence（其 id 已追加到 memory.evidenceIds） */
function composeL2(input: L2Input): { memory: L2Memory; evidence: MemoryEvidence } {
  const memory: L2Memory = {
    ...input,
    id: newId("l2"),
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    weight: 0,
    status: "active",
    syncStatus: input.syncStatus ?? (input.ragId ? "synced" : "pending_sync"),
    evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds : [],
    keywords: extractMemoryKeywords(`${input.content} ${input.triggerText}`),
  }
  const evidence = buildEvidence(memory, input)
  memory.evidenceIds = [...(memory.evidenceIds ?? []), evidence.id]
  return { memory, evidence }
}

/** 权重对应的状态：>=30 活跃，>=10 衰老，其余归档 */
function statusForWeight(weight: number): L2Memory["status"] {
  if (weight >= 30) return "active"
  return weight >= 10 ? "aging" : "archived"
}

const SYNC_TRACE_OP: Record<L2SyncStatus, string> = {
  synced: "l2.sync.success",
  sync_failed: "l2.sync.failure",
  pending_sync: "l2.sync.pending",
}

class MemoryStoreManager {
  private cache: MemoryStore | null = null
  private readFailed = false

  async load(): Promise<MemoryStore> {
    if (this.readFailed) throw new Error(READ_FAILED_MESSAGE)
    if (this.cache) return this.cache

    const file = resolveMemoryPath()
    if (!file) {
      this.cache = createDefaultMemoryStore()
      return this.cache
    }

    if (!memoryFileExists(file)) {
      this.cache = createDefaultMemoryStore()
      await this.save(this.cache)
      trace("store.init", "store", null, { schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION })
      return this.cache
    }

    try {
      const onDisk = readMemoryFile(file)
      if (!isCurrentMemoryStore(onDisk)) throw new Error("Unsupported memory format")
      this.cache = onDisk
    } catch {
      this.readFailed = true
      throw new Error(READ_FAILED_MESSAGE)
    }
    return this.cache
  }

  async save(doc: MemoryStore): Promise<void> {
    if (this.readFailed) throw new Error(READ_FAILED_MESSAGE)
    const file = resolveMemoryPath()
    if (!file) {
      this.cache = doc
      return
    }
    if (!this.cache && memoryFileExists(file)) await this.load()
    writeMemoryFile(file, doc)
    this.cache = doc
    // 记忆已变更，通知 Obsidian 绑定做防抖同步；从 Obsidian 回流期间跳过，避免互相触发。
    // 标志是同步读取的（叶子模块）；这里用动态 import 只是为了绕开与 obsidian-exporter 的循环依赖。
    if (isImportingMemory()) return
    import("./obsidian-exporter").then(({ notifyMemoryChanged }) => notifyMemoryChanged()).catch(() => {})
  }

  // ───── L0 / L1 ─────

  async getL0(): Promise<L0Profile> {
    return (await this.load()).l0
  }

  async upsertL0Field(field: L0WritableField, value: L0Profile[L0WritableField]): Promise<void> {
    const doc = await this.load()
    doc.l0 = { ...doc.l0, [field]: value, updatedAt: Date.now() }
    await this.save(doc)
    trace("l0.update", "L0", null, { fields: [field] })
  }

  async updateL0(patch: Partial<L0Profile>): Promise<void> {
    const pairs = Object.entries(patch) as Array<[keyof L0Profile, L0Profile[keyof L0Profile]]>
    for (const [field, value] of pairs) {
      if (field === "updatedAt") continue
      await this.upsertL0Field(field, value as L0Profile[L0WritableField])
    }
  }

  async getL1(): Promise<L1Profile> {
    return (await this.load()).l1
  }

  async replaceL1Field(field: L1WritableField, value: L1Profile[L1WritableField]): Promise<void> {
    const doc = await this.load()
    doc.l1 = { ...doc.l1, [field]: value }
    await this.save(doc)
    trace("l1.update", "L1", null, { fields: [field] })
  }

  async updateL1(patch: Partial<L1Profile>): Promise<void> {
    const pairs = Object.entries(patch) as Array<[L1WritableField, L1Profile[L1WritableField]]>
    for (const [field, value] of pairs) {
      await this.replaceL1Field(field, value)
    }
  }

  // ───── L2 增删改 ─────

  async addL2Memory(input: L2Input): Promise<L2Memory> {
    const doc = await this.load()
    const { memory, evidence } = composeL2(input)

    doc.l2.push(memory)
    doc.evidence = doc.evidence ?? []
    doc.evidence.push(evidence)
    doc.l2DmaeStates = doc.l2DmaeStates ?? []
    doc.l2DmaeStates.push(freshDmaeState(memory.id))
    await this.save(doc)

    trace("l2.add", "L2", l2Subject(memory), { isSummary: memory.isSummary === true, syncStatus: memory.syncStatus })
    trace("evidence.add", "L2", { l2Id: memory.id }, { evidenceId: evidence.id, sourceStatus: evidence.sourceStatus })
    return memory
  }

  async addL2(input: L2Input): Promise<L2Memory> {
    return this.addL2Memory(input)
  }

  /** 批量新增（压缩总结用） */
  async addL2Batch(inputs: L2Input[]): Promise<L2Memory[]> {
    const doc = await this.load()
    doc.l2DmaeStates = doc.l2DmaeStates ?? []
    const created: L2Memory[] = []

    for (const input of inputs) {
      const { memory, evidence } = composeL2(input)
      doc.l2.push(memory)
      doc.evidence = doc.evidence ?? []
      doc.evidence.push(evidence)
      doc.l2DmaeStates.push(freshDmaeState(memory.id))
      created.push(memory)
    }
    await this.save(doc)

    trace("l2.add.batch", "L2", null, { ids: created.map((m) => m.id), count: created.length })
    for (const memory of created) {
      const ids = memory.evidenceIds
      trace("evidence.add", "L2", { l2Id: memory.id }, { evidenceId: ids?.[ids.length - 1], sourceStatus: "active" })
    }
    return created
  }

  async updateL2RecallStats(id: string, delta = 1): Promise<void> {
    const doc = await this.load()
    const row = doc.l2.find((m) => m.id === id)
    if (!row) return

    if (row.status !== "active" && row.status !== "aging") {
      trace(
        "l2.weight.update",
        "L2",
        l2Subject(row),
        { delta, memoryStatus: row.status, reason: "not_recallable" },
        { status: "skip" },
      )
      return
    }

    const wasActive = row.status === "active"
    row.weight = Math.max(0, Math.min(100, row.weight + delta))
    row.lastAccessedAt = Date.now()
    row.accessCount += 1
    row.status = row.isPinned || wasActive || row.weight >= 30 ? "active" : "aging"

    await this.save(doc)
    trace("l2.weight.update", "L2", l2Subject(row), {
      delta,
      weight: row.weight,
      accessCount: row.accessCount,
      memoryStatus: row.status,
    })
  }

  async updateL2Weight(id: string, delta: number): Promise<void> {
    await this.updateL2RecallStats(id, delta)
  }

  async pinL2(id: string, pinned: boolean): Promise<void> {
    const doc = await this.load()
    const row = doc.l2.find((m) => m.id === id)
    if (!row) return
    row.isPinned = pinned
    row.status = pinned ? "active" : statusForWeight(row.weight)
    await this.save(doc)
    trace("l2.pin", "L2", l2Subject(row), { pinned, memoryStatus: row.status })
  }

  async deleteL2(id: string): Promise<void> {
    const doc = await this.load()
    doc.l2 = doc.l2.filter((m) => m.id !== id)
    doc.evidence = (doc.evidence ?? []).filter((ev) => ev.memoryId !== id)
    await this.save(doc)
    trace("l2.delete", "L2", { l2Id: id })
  }

  async markL2SyncStatus(id: string, syncStatus: L2SyncStatus, ragId?: string, error?: unknown): Promise<L2Memory | null> {
    const doc = await this.load()
    const row = doc.l2.find((m) => m.id === id)
    if (!row) return null
    row.syncStatus = syncStatus
    if (ragId) row.ragId = ragId
    await this.save(doc)

    let errorText: string | null = null
    if (error instanceof Error) errorText = error.message
    else if (error) errorText = String(error)
    trace(
      SYNC_TRACE_OP[syncStatus] ?? "l2.sync.pending",
      "L2",
      l2Subject(row),
      { syncStatus },
      { status: syncStatus === "sync_failed" ? "error" : "ok", error: errorText },
    )
    return row
  }

  async markL2Conflict(id: string, conflictRagId: string): Promise<L2Memory | null> {
    const doc = await this.load()
    const row = doc.l2.find((m) => m.id === id)
    if (!row) return null
    const known = row.conflictWith ?? []
    if (known.includes(conflictRagId)) return null

    row.conflictWith = [...known, conflictRagId]
    if (!row.isPinned && row.status === "active") row.status = "aging"

    await this.save(doc)
    trace("l2.conflict.mark", "L2", l2Subject(row), { conflictRagId, memoryStatus: row.status })
    return row
  }

  /**
   * 只改某条 L2 的正文（Obsidian 回流使用），不动 status / weight / createdAt 等运行时字段。
   * 正文有变化时重算 keywords（DMAE 命中检测依赖它），并置为 pending_sync：
   * 向量重建前该记忆不参与语义召回，避免命中旧向量里的旧文本。
   * id 不存在返回 null；内容没变则不保存，直接返回原记忆。
   */
  async updateL2Content(id: string, content: string): Promise<L2Memory | null> {
    const doc = await this.load()
    const row = doc.l2.find((m) => m.id === id)
    if (!row) return null
    if (row.content === content) return row

    row.content = content
    row.keywords = extractMemoryKeywords(`${content} ${row.triggerText}`)
    row.syncStatus = "pending_sync"
    await this.save(doc)
    trace("l2.import-content", "L2", l2Subject(row), { source: "obsidian-import" })
    return row
  }

  async getAllL2(): Promise<L2Memory[]> {
    return (await this.load()).l2
  }

  async getEvidenceByMemoryId(memoryId: string): Promise<MemoryEvidence[]> {
    const doc = await this.load()
    return (doc.evidence ?? []).filter((ev) => ev.memoryId === memoryId)
  }

  /** 批量改状态 */
  async updateL2Status(ids: string[], status: L2Memory["status"]): Promise<void> {
    const doc = await this.load()
    doc.l2.filter((m) => ids.includes(m.id)).forEach((m) => {
      m.status = status
    })
    await this.save(doc)
    trace("l2.status.batch", "L2", null, { ids, memoryStatus: status })
  }

  async archiveL2Batch(ids: string[]): Promise<void> {
    await this.updateL2Status(ids, "archived")
  }

  async decayL2Weights(delta = 1): Promise<number> {
    const doc = await this.load()
    let changed = 0

    for (const row of doc.l2) {
      const exempt = row.isPinned || row.status === "archived" || row.weight <= 0
      if (exempt) continue
      row.weight = Math.max(0, row.weight - delta)
      row.status = statusForWeight(row.weight)
      changed++
    }

    if (changed > 0) await this.save(doc)
    trace("l2.decay", "L2", null, { delta, changed }, { status: changed > 0 ? "ok" : "skip" })
    return changed
  }

  // ───── 回顾日志 ─────

  async appendReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    const doc = await this.load()
    const entry: ReflectionLog = {
      ...log,
      id: newId("ref"),
      createdAt: Date.now(),
    }
    doc.reflectionLogs = doc.reflectionLogs ?? []
    doc.reflectionLogs.push(entry)
    // 最多保留最近 50 条，防止文件膨胀
    if (doc.reflectionLogs.length > REFLECTION_LOG_CAP) {
      doc.reflectionLogs = doc.reflectionLogs.slice(-REFLECTION_LOG_CAP)
    }
    await this.save(doc)
    trace("reflection.log.add", "reflection", null, { type: entry.type, id: entry.id })
  }

  async addReflectionLog(log: Omit<ReflectionLog, "id" | "createdAt">): Promise<void> {
    await this.appendReflectionLog(log)
  }

  async getReflectionLogs(): Promise<ReflectionLog[]> {
    return (await this.load()).reflectionLogs ?? []
  }

  // ───── 冲突日志与 Resolver 队列 ─────

  async appendConflictLog(log: Omit<ConflictLog, "id" | "createdAt">): Promise<ConflictLog> {
    const doc = await this.load()
    const entry: ConflictLog = {
      ...log,
      id: newId("conf"),
      createdAt: Date.now(),
    }
    doc.conflictLogs = doc.conflictLogs ?? []
    doc.conflictLogs.push(entry)
    if (doc.conflictLogs.length > CONFLICT_LOG_CAP) {
      doc.conflictLogs = doc.conflictLogs.slice(-CONFLICT_LOG_CAP)
    }
    await this.save(doc)
    trace("conflict.log.add", "L2", { l2Id: entry.sourceL2Id, ragId: entry.sourceRagId }, {
      ...conflictRef(entry),
      detector: entry.detector,
      conflictStatus: entry.status,
    })
    return entry
  }

  async getConflictLogs(): Promise<ConflictLog[]> {
    return (await this.load()).conflictLogs ?? []
  }

  async scoreConflictLog(
    id: string,
    score: Pick<ConflictLog, "conflictScore" | "resolverPriority" | "scoringSignals">,
  ): Promise<ConflictLog | null> {
    const doc = await this.load()
    const log = (doc.conflictLogs ?? []).find((entry) => entry.id === id)
    if (!log) return null

    log.conflictScore = score.conflictScore
    log.resolverPriority = score.resolverPriority
    log.scoringSignals = score.scoringSignals

    const queueable = log.status === "candidate" && score.resolverPriority !== "none"
    const newlyQueued = queueable && log.resolverStatus !== "queued"
    if (queueable) {
      log.resolverStatus = "queued"
      log.resolverQueuedAt = log.resolverQueuedAt ?? Date.now()
    } else {
      log.resolverStatus = "not_queued"
      log.resolverQueuedAt = undefined
    }
    log.resolverAttemptCount = log.resolverAttemptCount ?? 0

    await this.save(doc)
    const subject = { l2Id: log.sourceL2Id, ragId: log.sourceRagId }
    trace("conflict.score", "L2", subject, {
      ...conflictRef(log),
      conflictScore: log.conflictScore,
      resolverPriority: log.resolverPriority,
      scoringSignals: log.scoringSignals,
    })
    if (newlyQueued) {
      trace("resolver.queue.add", "L2", subject, {
        ...conflictRef(log),
        resolverPriority: log.resolverPriority,
        conflictScore: log.conflictScore,
      })
    }
    return log
  }

  /** 排队中的候选，按优先级降序，同级先入队者在前 */
  async getResolverQueue(limit = 20): Promise<ConflictLog[]> {
    const doc = await this.load()
    const rank = (log: ConflictLog): number => RESOLVER_PRIORITY_RANK[log.resolverPriority ?? "none"]
    const queuedAt = (log: ConflictLog): number => log.resolverQueuedAt ?? log.createdAt
    const waiting = (doc.conflictLogs ?? []).filter((log) =>
      log.status === "candidate"
      && log.resolverStatus === "queued"
      && log.resolverPriority !== undefined
      && log.resolverPriority !== "none")
    waiting.sort((a, b) => (rank(b) - rank(a)) || (queuedAt(a) - queuedAt(b)))
    return waiting.slice(0, limit)
  }

  async applyResolverResolution(conflictLogId: string, resolution: MemoryConflictResolution): Promise<ConflictLog | null> {
    const doc = await this.load()
    const log = (doc.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
    if (!log) return null
    const newMemory = doc.l2.find((m) => m.id === log.sourceL2Id)
    const oldMemory = doc.l2.find((m) => m.id === log.targetL2Id)
    if (!newMemory || !oldMemory) return null

    const { actions } = resolution
    let resolutionMemoryId: string | undefined
    const summaryText = resolution.resolvedSummary?.trim()
    if (actions.createResolvedMemory && summaryText) {
      const merged: L2Memory = {
        content: summaryText,
        triggerText: resolution.reason,
        sourceConversationId: newMemory.sourceConversationId || oldMemory.sourceConversationId,
        sourceMessageIds: [...(oldMemory.sourceMessageIds ?? []), ...(newMemory.sourceMessageIds ?? [])],
        isPinned: false,
        syncStatus: "pending_sync",
        evidenceIds: [...(oldMemory.evidenceIds ?? []), ...(newMemory.evidenceIds ?? [])],
        id: newId("l2"),
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        weight: 0,
        status: "active",
        keywords: extractMemoryKeywords(`${summaryText} ${resolution.reason}`),
      }
      doc.l2.push(merged)
      resolutionMemoryId = merged.id
    }

    const retire = (memory: L2Memory, status: L2Memory["status"] | undefined): void => {
      if (!status) return
      memory.status = status
      if (!resolutionMemoryId) return
      if (status === "superseded") memory.supersededBy = resolutionMemoryId
      if (status === "merged") memory.mergedInto = resolutionMemoryId
    }
    retire(oldMemory, actions.oldMemoryStatus)
    retire(newMemory, actions.newMemoryStatus)

    log.resolverStatus = "resolved"
    log.resolverFinishedAt = Date.now()
    log.resolutionType = resolution.resolutionType
    log.resolutionMemoryId = resolutionMemoryId
    log.resolutionReason = resolution.reason
    log.resolutionConfidence = resolution.confidence
    log.shouldAskUser = actions.shouldAskUser === true
    log.clarificationNeeded = actions.clarificationNeeded === true

    if (resolution.resolutionType === "unrelated") log.status = "dismissed"
    else if (actions.clarificationNeeded || actions.shouldAskUser) log.status = "clarification_needed"
    else log.status = "resolved"

    await this.save(doc)
    trace("resolver.resolution.apply", "L2", { l2Id: log.sourceL2Id, ragId: log.sourceRagId }, {
      ...conflictRef(log),
      resolutionType: log.resolutionType,
      resolutionMemoryId,
      conflictStatus: log.status,
    })
    return log
  }

  // ───── V5 L2 DMAE 状态 ─────

  async getL2DmaeState(l2Id: string): Promise<L2DmaeState | undefined> {
    const doc = await this.load()
    return (doc.l2DmaeStates ?? []).find((s) => s.l2Id === l2Id)
  }

  async getAllL2DmaeStates(): Promise<L2DmaeState[]> {
    return (await this.load()).l2DmaeStates ?? []
  }

  async updateL2DmaeState(l2Id: string, patch: Partial<L2DmaeState>): Promise<L2DmaeState | undefined> {
    const doc = await this.load()
    doc.l2DmaeStates = doc.l2DmaeStates ?? []
    const index = doc.l2DmaeStates.findIndex((s) => s.l2Id === l2Id)
    if (index === -1) return undefined
    const updated = { ...doc.l2DmaeStates[index], ...patch, l2Id }
    doc.l2DmaeStates[index] = updated
    await this.save(doc)
    return updated
  }

  async initL2DmaeStateIfMissing(l2Id: string): Promise<L2DmaeState> {
    const present = await this.getL2DmaeState(l2Id)
    if (present) return present
    const doc = await this.load()
    doc.l2DmaeStates = doc.l2DmaeStates ?? []
    const state = freshDmaeState(l2Id)
    doc.l2DmaeStates.push(state)
    await this.save(doc)
    return state
  }
}

export const memoryStore = new MemoryStoreManager()
