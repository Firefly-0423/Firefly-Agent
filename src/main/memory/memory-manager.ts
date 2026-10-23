import { memoryStore } from "./memory-store"
import type { L0WritableField } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { findPossibleConflictCandidate } from "./memory-conflict"
import { scoreMemoryConflict, type ConflictEvidenceLevel } from "./memory-conflict-score"
import { wasRecentlyInjectedMemory } from "./recent-injected-memory"
import { addL2MemoryVector, searchMemoryEntries } from "../rag/index"

type L1Field = "recentGoals" | "recentPreferences" | "currentProject"

const L1_FIELDS: readonly L1Field[] = ["recentGoals", "recentPreferences", "currentProject"]

const head = (text: string, n: number): string => text.slice(0, n)

/** 模型没给出合法 field 时，按关键词猜一个 L1 字段 */
function inferL1Field(content: string): L1Field {
  if (/目标|想要|计划|打算/.test(content)) return "recentGoals"
  if (/项目|在做|开发|写/.test(content)) return "currentProject"
  return "recentPreferences"
}

/** 优先采用模型返回的 field；缺失或不合法时退回关键词推断 */
export function resolveL1Field(field: string | undefined, content: string): L1Field {
  const given = L1_FIELDS.find((name) => name === field)
  return given ?? inferL1Field(content)
}

const CORRECTION_PHRASES = ["不是这样", "你记错了", "记错了", "我现在不这样", "现在不这样"]

const hasCorrectionIntent = (text: string): boolean => CORRECTION_PHRASES.some((p) => text.includes(p))

function impactOf(memory: L2Memory): "low" | "medium" | "high" {
  if (memory.isPinned) return "high"
  return memory.status === "active" ? "medium" : "low"
}

function isRejectedByJudge(candidate: MemoryCandidate): boolean {
  const overclaims = candidate.forbiddenOverclaims
  return candidate.shouldWrite === false || (!!overclaims && overclaims.length > 0)
}

const isUserExplicit = (candidate: MemoryCandidate): boolean =>
  candidate.certainty === "explicit" && candidate.attribution === "user_explicit"

export class MemoryManager {
  private async appendToPermanentNote(content: string): Promise<void> {
    const { permanentNote } = await memoryStore.getL0()
    const previous = permanentNote || ""
    await memoryStore.upsertL0Field("permanentNote", previous ? `${previous}；${content}` : content)
  }

  async writeMemory(candidates: MemoryCandidate[]): Promise<void> {
    for (const candidate of candidates) {
      if (isRejectedByJudge(candidate)) {
        console.log("[PMRS/Manager] 候选标记为不写入或存在过度概括，跳过")
        continue
      }

      switch (candidate.layer) {
        case "L0":
          await this.writeL0(candidate)
          break
        case "L1": {
          const target = resolveL1Field(candidate.field, candidate.content)
          await memoryStore.replaceL1Field(target, candidate.content)
          console.log(`[PMRS/Manager] L1 更新字段: ${target}`)
          break
        }
        case "L2":
          await this.writeL2(candidate)
          break
      }
    }
  }

  private async writeL0(candidate: MemoryCandidate): Promise<void> {
    if (!isUserExplicit(candidate)) {
      console.log("[PMRS/Manager] L0 候选不是用户明确事实，跳过自动写核心画像")
      return
    }

    const profile = await memoryStore.getL0()
    if (profile.isPinned) {
      console.log("[PMRS/Manager] L0 已锁定，跳过自动更新")
      return
    }

    if (!candidate.field) {
      console.warn("[PMRS/Manager] L0 候选缺少 field 字段，跳过自动写核心画像")
      return
    }
    if (!Object.keys(L0_FIELD_DESCRIPTIONS).includes(candidate.field)) {
      console.warn(`[PMRS/Manager] AI 返回非法字段 "${candidate.field}"，跳过自动写核心画像`)
      return
    }

    await memoryStore.upsertL0Field(candidate.field as L0WritableField, candidate.content)
    console.log(`[PMRS/Manager] L0 更新字段: ${candidate.field} = "${candidate.content.slice(0, 20)}"`)
  }

  private async writeL2(candidate: MemoryCandidate): Promise<void> {
    type NewL2 = Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status">
    // 键顺序会原样进入 memory.json：content → triggerText → sourceConversationId → embedding → isPinned → syncStatus
    const input: NewL2 = Object.assign(
      { content: candidate.content, triggerText: candidate.triggerText },
      { sourceConversationId: candidate.sourceConversationId ?? "" },
      { embedding: [] as number[], isPinned: false, syncStatus: "pending_sync" as const },
    )
    // slug 是模型起的精炼标题；缺失时 obsidian-exporter 会拿内部 id 当文件名
    if (candidate.slug) input.slug = candidate.slug
    // 原文片段只用于展示，没有就不带
    if (candidate.sourceQuote) input.sourceQuote = candidate.sourceQuote

    const created = await memoryStore.addL2Memory(input)

    let ragId: string
    try {
      ragId = await addL2MemoryVector(candidate.content, created.id, {
        triggerText: candidate.triggerText,
        confidence: candidate.confidence,
      })
      await memoryStore.markL2SyncStatus(created.id, "synced", ragId)
    } catch (err) {
      await memoryStore.markL2SyncStatus(created.id, "sync_failed", undefined, err)
      console.warn("[PMRS/Manager] L2 已写入，但 RAG 同步失败:", err)
      return
    }

    console.log(`[PMRS/Manager] L2 写入: "${head(candidate.content, 30)}"（l2Id: ${created.id}, ragId: ${ragId}）`)

    try {
      await this.detectAndMarkConflicts(candidate.content, created.id, ragId, candidate.triggerText)
    } catch (err) {
      console.warn("[PMRS/Manager] 冲突检测失败:", err)
    }
  }

  /** 新记忆写入后，与现有 active/aging 记忆比对，发现疑似矛盾就打标并记日志 */
  private async detectAndMarkConflicts(content: string, newL2Id: string, newRagId: string, triggerText: string): Promise<void> {
    const everything = await memoryStore.getAllL2()
    const comparable = everything.filter(
      (m) => (m.status === "active" || m.status === "aging") && m.ragId && m.ragId !== newRagId,
    )

    const neighbours = await searchMemoryEntries(content, "user_memory", 5, { recordRecall: false })
    if (neighbours.length === 0) return

    // metadata.l2Id 能精确定位到 L2 的优先使用
    const byL2Id = new Map<string, (typeof neighbours)[number]>()
    neighbours.forEach((entry) => {
      const id = entry.metadata?.l2Id
      if (typeof id === "string" && id.length > 0) byL2Id.set(id, entry)
    })

    for (const existing of comparable) {
      const viaMetadata = byL2Id.get(existing.id)
      const hit = viaMetadata ?? neighbours.find((entry) =>
        entry.text === existing.content ||
        existing.content.includes(entry.text.slice(0, 20)) ||
        entry.text.includes(existing.content.slice(0, 20)))
      if (!hit) continue

      const suspect = findPossibleConflictCandidate(content, existing.content)
      if (!suspect.isCandidate) continue

      // 本地词法规则只给出“疑似”，不判定真伪
      const marked = await memoryStore.markL2Conflict(existing.id, newRagId)
      if (!marked) continue

      const logDraft: Parameters<typeof memoryStore.appendConflictLog>[0] = Object.assign(
        { status: "candidate" as const, sourceL2Id: newL2Id, targetL2Id: existing.id },
        { sourceRagId: newRagId, targetRagId: existing.ragId },
        { reason: suspect.reason ?? "possible local lexical contradiction" },
        { confidence: suspect.confidence, detector: "local" as const },
      )
      const log = await memoryStore.appendConflictLog(logDraft)
      const injectedRecently = wasRecentlyInjectedMemory(existing.id)
      const source = injectedRecently ? "recent_injection" : viaMetadata ? "rag" : "local"
      const score = scoreMemoryConflict({
        impactScope: impactOf(existing),
        activeTarget: existing.status !== "archived",
        localContradiction: true,
        recentInjection: wasRecentlyInjectedMemory(existing.id),
        evidence: await this.getEvidenceLevel(newL2Id, existing.id),
        correctionIntent: hasCorrectionIntent(triggerText),
        ragScore: viaMetadata ? hit.score : undefined,
        candidateSource: source,
      })
      await memoryStore.scoreConflictLog(log.id, score)
      console.log(`[PMRS/Manager] ⚠️ 发现疑似记忆冲突候选: "${head(existing.content, 30)}" ↔ "${head(content, 30)}"`)
    }
  }

  private async getEvidenceLevel(sourceL2Id: string, targetL2Id: string): Promise<ConflictEvidenceLevel> {
    const [fromSource, fromTarget] = await Promise.all([
      memoryStore.getEvidenceByMemoryId(sourceL2Id),
      memoryStore.getEvidenceByMemoryId(targetL2Id),
    ])
    const sides = Number(fromSource.length > 0) + Number(fromTarget.length > 0)
    return sides === 2 ? "both" : sides === 1 ? "one_side" : "none"
  }

  /** 片段权重衰减；目前由外部手动触发，调度策略以后统一放在 memory-scheduler */
  async runDecay(): Promise<void> {
    const updated = await memoryStore.decayL2Weights()
    console.log(`[PMRS/Manager] L2 权重衰减完成，更新 ${updated} 条`)
  }
}

export const memoryManager = new MemoryManager()
