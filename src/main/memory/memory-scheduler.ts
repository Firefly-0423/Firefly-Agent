import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import type { ExtractedEntity } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8
const RESOLVER_INTERVAL = 5
const COMPRESSION_INTERVAL = 20
const DECAY_INTERVAL = 50

export type MemorySchedulerDeps = {
  runDecay: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  runReflectionAndCompression: () => Promise<void>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  /** judge 顺带抽出的命名实体直接入库，不额外调用 LLM */
  ingestEntities: (entities: ExtractedEntity[]) => void
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
}

/** 执行一步辅助任务；失败只打警告，不向上抛 */
async function softly(step: () => Promise<unknown>, warning: string): Promise<void> {
  try {
    await step()
  } catch (err) {
    console.warn(warning, err)
  }
}

type SequencedTurn = MemoryJudgeTurn & { seq: number }

export class MemoryScheduler {
  private recentTurns: SequencedTurn[] = []
  private nextTurnSeq = 0

  constructor(private readonly deps: MemorySchedulerDeps) {}

  scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
    this.nextTurnSeq += 1
    const seq = this.nextTurnSeq
    const keepAtMost = MEMORY_JUDGE_CONTEXT_TURNS * 2
    this.recentTurns.push({ seq, userInput, assistantReply })
    if (this.recentTurns.length > keepAtMost) {
      this.recentTurns = this.recentTurns.slice(-keepAtMost)
    }

    const job = this.deps.enqueueTask("MemoryMaintenance", () => this.runQueuedMemoryWrite(seq, conversationId))
    job.catch((e) => {
      console.error("[PMRS/Scheduler] 记忆写入失败，不影响主流程", e)
    })
  }

  private async judgeAndStore(seq: number, conversationId?: string): Promise<void> {
    const turns = this.recentTurns
      .filter((t) => t.seq <= seq)
      .slice(-MEMORY_JUDGE_CONTEXT_TURNS)
      .map((t) => ({ userInput: t.userInput, assistantReply: t.assistantReply }))
    const verdict = await this.deps.judgeMemory(turns, conversationId ?? "default")

    if (verdict.candidates.length > 0) {
      await this.deps.writeMemory(verdict.candidates)
    }
    if (verdict.entities.length > 0) {
      this.deps.ingestEntities(verdict.entities)
    }
  }

  private async runQueuedMemoryWrite(seq: number, conversationId?: string): Promise<void> {
    const profile = await this.deps.getL1()
    const round = (profile.roundCount || 0) + 1
    const due = (interval: number): boolean => round % interval === 0

    if (due(MEMORY_JUDGE_INTERVAL)) {
      try {
        await this.judgeAndStore(seq, conversationId)
      } catch (err) {
        console.error("[PMRS/Scheduler] Judge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    await this.deps.replaceL1Field("roundCount", round)

    if (due(RESOLVER_INTERVAL)) {
      await softly(() => this.deps.runResolverQueueOnce(), "[PMRS/Scheduler] Resolver 队列处理失败，不影响主流程")
    }

    if (due(COMPRESSION_INTERVAL)) {
      console.log("[PMRS/Scheduler] 达到 20 轮，触发回顾 + 片段压缩")
      await this.deps.runReflectionAndCompression()
    }

    if (due(DECAY_INTERVAL)) {
      await softly(() => this.deps.runDecay(), "[PMRS/Scheduler] L2 权重衰减失败，不影响主流程")
    }
  }
}

const defaultSchedulerDeps: MemorySchedulerDeps = {
  runDecay: () => memoryManager.runDecay(),
  runResolverQueueOnce,
  runReflectionAndCompression,
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  getL1: () => memoryStore.getL1(),
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  enqueueTask: enqueueLLMTask,
}

export const memoryScheduler = new MemoryScheduler(defaultSchedulerDeps)
