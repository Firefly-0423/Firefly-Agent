// ───── L0：稳定画像 ─────

export type L0Profile = {
  updatedAt: number
  isPinned: boolean
  nickname: string
  preferredName: string
  occupation: string
  language: string
  longTermInterests: string
  permanentNote: string
}

// 暴露给模型的 L0 字段说明（键顺序会进入提示词）；isPinned、updatedAt 不对模型开放
const L0_FIELD_NOTES: Array<[keyof L0Profile, string]> = [
  ["preferredName", '用户希望被如何称呼、叫什么名字、昵称。例如："叫我开拓者""我叫小林""以后用我的昵称"'],
  ["occupation", '用户的职业、身份、工作。例如："我是前端工程师""我在做设计"'],
  ["longTermInterests", '用户的长期兴趣爱好（稳定的，不是临时的）。例如："我一直喜欢画画""我从小学钢琴"'],
  ["language", '用户常用的语言或地区习惯。例如："我习惯说中文""我是广东人"'],
  ["permanentNote", '其他不属于以上四类的稳定个人信息。例如："我有一只猫""我住在上海"'],
]
export const L0_FIELD_DESCRIPTIONS: Partial<Record<keyof L0Profile, string>> = Object.fromEntries(L0_FIELD_NOTES)

// ───── L1：近况 ─────

export type L1Profile = {
  generatedAt: number
  roundCount: number
  currentProject: string
  recentGoals: string
  recentPreferences: string
}

// ───── L2：片段记忆 ─────

export type L2SyncStatus = "pending_sync" | "synced" | "sync_failed"

export type L2MemoryStatus = "active" | "aging" | "archived" | "superseded" | "merged"

export type L2Memory = {
  // 标识与来源
  id: string
  sourceConversationId: string
  triggerText: string
  content: string
  /** 模型起的精炼标题，作为 Obsidian 文件名和 wikilink 锚点；没有时退回 id（l2_<ts>_<rand>），id 仍是内部主键并写进 frontmatter */
  slug?: string
  /** Judge 挑出的最有信息量的用户原话。召回时一并注入，让模型看到字面证据；只用于展示，审计与冲突检测用的 evidence.quoteSnippet 仍来自 triggerText */
  sourceQuote?: string
  sourceMessageIds?: string[]
  evidenceIds?: string[]
  // 向量库同步
  syncStatus?: L2SyncStatus
  ragId?: string
  embedding?: number[]
  // 压缩与冲突关系
  /** 压缩总结条目（由回顾阶段生成）时为 true */
  isSummary?: boolean
  /** 总结条目所压缩的原始条目 id */
  subEntryIds?: string[]
  /** 与本条语义矛盾的其他条目的 ragId */
  conflictWith?: string[]
  supersededBy?: string
  mergedInto?: string
  // 运行时指标
  status: L2MemoryStatus
  isPinned: boolean
  weight: number
  accessCount: number
  lastAccessedAt: number
  createdAt: number
  /** V5 DMAE 命中检测用的关键词，写入时由正文分词与 evidence 实体得出，缺失时 memory-store 会补 */
  keywords?: string[]
}

/** 可被本地召回：处于 active/aging，且已同步并拥有非空 ragId */
export function isL2LocallyRecallable(memory: L2Memory): boolean {
  const hasRagId = typeof memory.ragId === "string" && memory.ragId.length > 0
  const recallableStatus = memory.status === "active" || memory.status === "aging"
  return recallableStatus && memory.syncStatus === "synced" && hasRagId
}

// ───── 日志、冲突与证据 ─────

export type ReflectionLog = {
  type: "compression" | "l0_update" | "l1_update"
  id: string
  createdAt: number
  summary: string
  details?: string
}

export type ConflictResolverPriority = "none" | "idle" | "normal" | "high"
export type ConflictResolverStatus = "not_queued" | "queued" | "processing" | "resolved" | "failed"
export type MemoryConflictResolutionType = "unrelated" | "context_difference" | "preference_evolution" | "direct_conflict" | "uncertain"

export type ConflictScoringSignals = {
  penalties?: string[]
  impactScope?: "low" | "medium" | "high"
  correctionIntent?: boolean
  localContradiction?: boolean
  ragCandidate?: boolean
  recentInjection?: boolean
  evidenceAvailable?: boolean
}

export type ConflictLog = {
  // 基本信息
  id: string
  createdAt: number
  status: "candidate" | "pending" | "confirmed" | "dismissed" | "resolved" | "clarification_needed"
  detector: "local" | "llm" | "manual"
  reason: string
  confidence: number
  // 评分与排队
  conflictScore?: number
  resolverPriority?: ConflictResolverPriority
  scoringSignals?: ConflictScoringSignals
  resolverStatus?: ConflictResolverStatus
  resolverQueuedAt?: number
  resolverStartedAt?: number
  resolverFinishedAt?: number
  resolverAttemptCount?: number
  // 解决结果
  resolutionType?: MemoryConflictResolutionType
  resolutionMemoryId?: string
  resolutionReason?: string
  resolutionConfidence?: number
  clarificationNeeded?: boolean
  shouldAskUser?: boolean
  // 冲突双方
  targetRagId?: string
  sourceRagId?: string
  targetL2Id: string
  sourceL2Id: string
}

export type MemoryConflictResolution = {
  reason: string
  confidence: number
  resolutionType: MemoryConflictResolutionType
  currentSummary?: string
  historicalSummary?: string
  resolvedSummary?: string
  actions: {
    createResolvedMemory: boolean
    newMemoryStatus?: L2MemoryStatus
    oldMemoryStatus?: L2MemoryStatus
    clarificationNeeded?: boolean
    shouldAskUser?: boolean
    shouldUpdateCoreMemory?: boolean
  }
}

export type MemoryEvidence = {
  id: string
  memoryId: string
  createdAt: number
  sourceStatus: "active" | "archived" | "deleted"
  quoteSnippet: string
  contextAfterSnippet?: string
  contextBeforeSnippet?: string
  conversationId?: string
  messageIds?: string[]
}

// ───── Judge 输入输出 ─────

export type MemoryCandidate = {
  attribution?: "user_explicit" | "assistant_inferred" | "mixed"
  certainty?: "explicit" | "inferred" | "uncertain"
  stability?: "one_off" | "situational" | "stable"
  importance?: "low" | "medium" | "high"
  layer: "L0" | "L1" | "L2"
  content: string
  triggerText: string
  confidence: number
  field?: string
  summary?: string
  reason?: string
  contextSummary?: string
  shouldWrite?: boolean
  evidenceQuotes?: string[]
  forbiddenOverclaims?: string[]
  /** 仅 L2 候选使用：精炼标题，不超过 20 字，只含中文/字母/数字/下划线/连字符；缺失时文件名退回内部 id */
  slug?: string
  /** 仅 L2 候选使用：最有信息量的对话原话，不超过 500 字；L0/L1 的该字段一律丢弃 */
  sourceQuote?: string
  /** 由调度层注入而非模型输出，用于 L2 回溯来源会话 */
  sourceConversationId?: string
}

export type MemoryJudgeTurn = {
  assistantReply: string
  userInput: string
}

// ───── DMAE 状态与整库结构 ─────

/** V5 L2 热层 DMAE 运行时状态，随 memory.json 持久化；archived 条目不参与热层更新 */
export type L2DmaeState = {
  l2Id: string
  state: "active" | "dormant" | "archived"
  activation: number
  intrinsicValue: number
  modelSilence: number
  userSilence: number
  recentUserHits: number[]
}

export type MemoryStore = {
  l2: L2Memory[]
  l1: L1Profile
  l0: L0Profile
  schemaVersion: number
  reflectionLogs?: ReflectionLog[]
  conflictLogs?: ConflictLog[]
  evidence?: MemoryEvidence[]
  /** L2 热层 DMAE 状态（V5） */
  l2DmaeStates?: L2DmaeState[]
  /** @deprecated Use schemaVersion for memory.json migrations. */
  version: number
}
