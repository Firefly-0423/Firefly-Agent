import { addL2MemoryVector } from "../rag/index"
import { appendMemoryTrace } from "./memory-trace"
import { memoryStore } from "./memory-store"
import type { ConflictLog, L2Memory, MemoryEvidence } from "./memory-types"
import { invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client"
import { parseMemoryResolveResult, validateMemoryResolveBusiness } from "./memory-schemas"

type ResolvableStatus = "active" | "aging" | "archived" | "superseded" | "merged"

export type MemoryConflictResolutionType =
  "unrelated" | "context_difference" | "preference_evolution" | "direct_conflict" | "uncertain"

export type MemoryConflictResolution = {
  confidence: number
  reason: string
  historicalSummary?: string
  currentSummary?: string
  resolvedSummary?: string
  resolutionType: MemoryConflictResolutionType
  actions: {
    clarificationNeeded?: boolean
    shouldAskUser?: boolean
    shouldUpdateCoreMemory?: boolean
    newMemoryStatus?: ResolvableStatus
    oldMemoryStatus?: ResolvableStatus
    createResolvedMemory: boolean
  }
}

export type ResolverPayload = {
  scoringSignals: ConflictLog["scoringSignals"]
  conflictScore: number
  oldEvidence: MemoryEvidence[]
  newEvidence: MemoryEvidence[]
  oldMemory: L2Memory
  newMemory: L2Memory
  conflictLog: ConflictLog
}

export type ResolverRunResult = {
  error?: string
  conflictLogId?: string
  status: "skip" | "resolved" | "failed" | "rate_limited"
}

export type ResolverRunOptions = {
  minIntervalMs?: number
  now?: number
}

const DEFAULT_RESOLVER_MIN_INTERVAL_MS = 60_000
let lastResolverRunAt: number | null = null

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 以冲突日志的源记忆为主体写一条 L2 trace */
function traceResolver(
  op: string,
  status: "ok" | "error",
  log: Pick<ConflictLog, "sourceL2Id" | "sourceRagId">,
  details: Record<string, unknown>,
  error?: string,
): void {
  appendMemoryTrace({
    op,
    layer: "L2",
    status,
    l2Id: log.sourceL2Id,
    ragId: log.sourceRagId,
    details,
    ...(error === undefined ? {} : { error }),
  })
}

/** 在已加载的 store 里按 id 找冲突日志 */
async function loadWithLog(conflictLogId: string) {
  const store = await memoryStore.load()
  const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
  return { store, log }
}

export async function buildResolverPayload(conflictLogId: string): Promise<ResolverPayload> {
  const { store, log: conflictLog } = await loadWithLog(conflictLogId)
  if (!conflictLog) throw new Error(`conflict log not found: ${conflictLogId}`)

  const newMemory = store.l2.find((m) => m.id === conflictLog.sourceL2Id)
  const oldMemory = store.l2.find((m) => m.id === conflictLog.targetL2Id)
  if (!newMemory) throw new Error(`source memory not found: ${conflictLog.sourceL2Id}`)
  if (!oldMemory) throw new Error(`target memory not found: ${conflictLog.targetL2Id}`)

  const newEvidence = await memoryStore.getEvidenceByMemoryId(newMemory.id)
  const oldEvidence = await memoryStore.getEvidenceByMemoryId(oldMemory.id)
  const payload: ResolverPayload = {
    scoringSignals: conflictLog.scoringSignals,
    conflictScore: conflictLog.conflictScore ?? 0,
    oldEvidence,
    newEvidence,
    oldMemory,
    newMemory,
    conflictLog,
  }
  return payload
}

function renderEvidence(items: MemoryEvidence[]): string {
  const rows = items.map((item) => {
    const conversation = item.conversationId ?? "unknown"
    return `- quote: ${item.quoteSnippet}\n  conversationId: ${conversation}\n  sourceStatus: ${item.sourceStatus}`
  })
  return rows.join("\n")
}

const RESOLVER_JSON_SHAPE =
  '{"resolutionType":"unrelated|context_difference|preference_evolution|direct_conflict|uncertain",' +
  '"resolvedSummary":"可选","currentSummary":"可选","historicalSummary":"可选","reason":"原因","confidence":0.0,' +
  '"actions":{"createResolvedMemory":false,"oldMemoryStatus":"active|aging|archived|superseded|merged",' +
  '"newMemoryStatus":"active|aging|archived|superseded|merged","shouldUpdateCoreMemory":false,' +
  '"shouldAskUser":false,"clarificationNeeded":false}}'

export function buildResolverMessages(payload: ResolverPayload): { systemPrompt: string; userPrompt: string } {
  // 一条记忆的展示块：标题、摘要、证据，末尾留一个空行
  const memoryBlock = (title: string, content: string, evidence: MemoryEvidence[]): string[] => [
    `${title}：\nsummary: ${content}`,
    `evidence:\n${renderEvidence(evidence) || "- none"}`,
    "",
  ]
  const sections: string[] = [
    "请判断以下两条用户记忆的关系，并只输出 JSON。\n",
    ...memoryBlock("旧记忆", payload.oldMemory.content, payload.oldEvidence),
    ...memoryBlock("新记忆", payload.newMemory.content, payload.newEvidence),
    `conflictScore: ${payload.conflictScore}\nscoringSignals: ${JSON.stringify(payload.scoringSignals ?? {})}\n`,
    "JSON 格式：",
    RESOLVER_JSON_SHAPE,
  ]

  return {
    systemPrompt: "你是谨慎的用户记忆冲突 Resolver。你只根据 summary 和 evidence 判断，不要编造事实，只输出 JSON。",
    userPrompt: sections.join("\n"),
  }
}

/** 兼容旧签名：把 buildResolverMessages 的结果转成 messages 数组 */
export function buildResolverMessagesAsArray(payload: ResolverPayload): Array<{ role: "system" | "user"; content: string }> {
  const built = buildResolverMessages(payload)
  return [
    { role: "system", content: built.systemPrompt },
    { role: "user", content: built.userPrompt },
  ]
}

export async function resolvePayload(payload: ResolverPayload): Promise<MemoryConflictResolution> {
  const { systemPrompt, userPrompt } = buildResolverMessages(payload)
  return invokeMemoryStructuredOutput<MemoryConflictResolution>({
    validateBusiness: validateMemoryResolveBusiness,
    parseSchema: parseMemoryResolveResult,
    maxOutputTokens: getDefaultMaxOutputTokens("resolve"),
    userPrompt,
    systemPrompt,
    operation: "resolve",
  })
}

async function markResolverProcessing(conflictLogId: string): Promise<void> {
  const found = await loadWithLog(conflictLogId)
  const { store, log } = found
  if (log === undefined) return
  log.resolverStatus = "processing"
  log.resolverStartedAt = Date.now()
  log.resolverAttemptCount = (log.resolverAttemptCount ?? 0) + 1
  await memoryStore.save(store)
  traceResolver("resolver.queue.processing", "ok", log, {
    conflictLogId: log.id,
    resolverAttemptCount: log.resolverAttemptCount,
  })
}

async function markResolverFailed(conflictLogId: string, error: unknown): Promise<void> {
  const found = await loadWithLog(conflictLogId)
  const { store, log } = found
  if (log === undefined) return
  log.resolverStatus = "failed"
  log.resolverFinishedAt = Date.now()
  await memoryStore.save(store)
  traceResolver(
    "resolver.queue.failed",
    "error",
    log,
    { conflictLogId: log.id, resolverAttemptCount: log.resolverAttemptCount ?? 0 },
    messageOf(error),
  )
}

/** 解析结果若新建了 L2，把它同步进向量库 */
async function syncResolvedMemoryToRag(log: ConflictLog): Promise<void> {
  if (!log.resolutionMemoryId || !log.resolutionType) return
  const store = await memoryStore.load()
  const created = store.l2.find((m) => m.id === log.resolutionMemoryId)
  if (!created || created.syncStatus === "synced") return

  try {
    const ragId = await addL2MemoryVector(created.content, created.id, {
      source: "memory_resolver",
      conflictLogId: log.id,
      resolutionType: log.resolutionType,
      sourceL2Id: log.sourceL2Id,
      targetL2Id: log.targetL2Id,
    })
    await memoryStore.markL2SyncStatus(created.id, "synced", ragId)
  } catch (err) {
    console.warn("[PMRS/Resolver] sync resolved memory to RAG failed:", err)
    const wrapped = err instanceof Error ? err : new Error(String(err))
    await memoryStore.markL2SyncStatus(created.id, "sync_failed", undefined, wrapped)
  }
}

export async function resolveNextConflict(options?: ResolverRunOptions): Promise<ResolverRunResult> {
  const now = options?.now ?? Date.now()
  const minInterval = options?.minIntervalMs ?? DEFAULT_RESOLVER_MIN_INTERVAL_MS

  const tooSoon = lastResolverRunAt !== null && now - lastResolverRunAt < minInterval
  if (tooSoon) {
    traceResolver("resolver.queue.rate_limited", "ok", { sourceL2Id: "", sourceRagId: "" }, {
      lastRunAt: lastResolverRunAt,
      now,
      minInterval,
    })
    return { status: "rate_limited" }
  }

  // 排队的冲突里取分数最高者，同分取先出现的
  const store = await memoryStore.load()
  let next: ConflictLog | undefined
  for (const log of store.conflictLogs ?? []) {
    if (log.resolverStatus !== "queued") continue
    if (!next || (log.conflictScore ?? 0) > (next.conflictScore ?? 0)) next = log
  }
  if (!next) return { status: "skip" }

  lastResolverRunAt = now
  const target = next

  try {
    await markResolverProcessing(target.id)
    const payload = await buildResolverPayload(target.id)
    const resolution = await resolvePayload(payload)
    const applied = await memoryStore.applyResolverResolution(target.id, resolution)
    if (applied) await syncResolvedMemoryToRag(applied)
    traceResolver("resolver.run.success", "ok", target, {
      conflictLogId: target.id,
      resolutionType: resolution.resolutionType,
      createdResolvedMemory: resolution.actions.createResolvedMemory === true,
    })
    return { status: "resolved", conflictLogId: target.id }
  } catch (err) {
    await markResolverFailed(target.id, err)
    const reason = messageOf(err)
    traceResolver("resolver.run.failed", "error", target, { conflictLogId: target.id }, reason)
    return { status: "failed", conflictLogId: target.id, error: reason }
  }
}

/** @deprecated Use resolveNextConflict instead. */
export const runResolverQueueOnce = resolveNextConflict;
