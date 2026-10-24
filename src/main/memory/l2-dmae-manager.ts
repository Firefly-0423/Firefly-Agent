import { DmaeEntry, DmaeManager, DmaeParams, DefaultRewardStrategy, deriveState, QuadraticResistanceDecay } from "../rag/worldbook"
import { L2Memory, L2DmaeState } from "./memory-types"
import { memoryStore } from "./memory-store"

// V5 的 L2 专用 DMAE 参数（取值已与用户确认）
export const L2_DMAE_PARAMS: DmaeParams = {
  // 分数范围与注入门槛
  promptThreshold: 30,
  maxScore: 100,
  // 奖励：用户命中 / 模型命中
  modelRewardBase: 4,
  userRewardBase: 10,
  // 唤醒
  wakeBonus: 5,
  wakeGamma: 0.5,
  wakeLambda: 0.3,
  // 衰减
  decayBeta: 0.2,
  decayAlpha: 1.0,
  // 重复命中抑制
  repeatWindow: 6,
  repeatRho: 0.5,
  satPower: 2,
}

// 向量召回前 4 名依次赋予的内在价值 I；
// 第 1 名约能活跃 4 轮，第 2、3 名约 3 轮，第 4 名约 2 轮
export const L2_INTRINSIC_BY_RANK = [36, 8, 8, 1]

interface L2DmaeEntry extends DmaeEntry {
  l2: L2Memory
}

type EngineState = {
  activation: number
  userSilence: number
  modelSilence: number
  recentUserHits: number[]
}

const toEngineState = (s: EngineState): EngineState => ({
  activation: s.activation,
  userSilence: s.userSilence,
  modelSilence: s.modelSilence,
  recentUserHits: s.recentUserHits,
})

function toDmaeEntry(l2: L2Memory, state: L2DmaeState): L2DmaeEntry {
  return {
    l2,
    enabled: l2.status !== "archived",
    permanent: l2.isPinned,
    intrinsicValue: state.intrinsicValue,
    keywords: l2.keywords ?? [],
    id: l2.id,
  }
}

function blankDmaeState(l2Id: string): L2DmaeState {
  return {
    state: "archived",
    recentUserHits: [],
    modelSilence: 0,
    userSilence: 0,
    intrinsicValue: 0,
    activation: 0,
    l2Id,
  }
}

/**
 * L2 工作记忆的 DMAE 管理器：
 * - 用 V5 的 L2 参数和按位次分配的 I 梯度
 * - 向量召回的前 K 条按用户命中处理，未召回但关键词命中的也计入命中
 * - 热层条目参与更新，已归档且未命中的跳过
 * - 状态持久化在 memory.json 的 l2DmaeStates
 */
export class L2DmaeManager {
  private dmae = new DmaeManager<L2DmaeEntry>({
    debug: false,
    decayStrategy: new QuadraticResistanceDecay<L2DmaeEntry>(),
    rewardStrategy: new DefaultRewardStrategy<L2DmaeEntry>(),
    params: L2_DMAE_PARAMS,
  })

  // 召回器按位次给出的 I，只缓存在内存里
  private intrinsicValues = new Map<string, number>()

  // 调用方没传轮次时自增使用
  private turnCounter = 0

  private loaded = false

  /** 把 memory.json 中保存的状态全部装进引擎 */
  async loadStates(): Promise<void> {
    const saved = await memoryStore.getAllL2DmaeStates()
    this.dmae.clear()
    this.intrinsicValues.clear()
    saved.forEach((s) => {
      this.dmae.setState(s.l2Id, toEngineState(s))
      this.intrinsicValues.set(s.l2Id, s.intrinsicValue)
    })
    this.loaded = true
  }

  /** 按召回位次写入 I；若条目当前处于 Archived，先唤醒到 promptThreshold + wakeBonus */
  setRecalledIntrinsicValues(recalledIds: string[]): void {
    const { promptThreshold, maxScore, wakeBonus } = this.dmae.getParams()
    const lastRank = L2_INTRINSIC_BY_RANK.length - 1
    recalledIds.forEach((id, rank) => {
      const prior = this.dmae.getState(id) ?? { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] }
      this.intrinsicValues.set(id, L2_INTRINSIC_BY_RANK[Math.min(rank, lastRank)])
      const wasArchived = deriveState(prior.activation, promptThreshold) === "Archived"
      const activation = wasArchived ? Math.min(maxScore, promptThreshold + wakeBonus) : prior.activation
      this.dmae.setState(id, { ...prior, activation })
    })
  }

  private buildEntries(list: L2Memory[]): L2DmaeEntry[] {
    const threshold = this.dmae.getParams().promptThreshold
    return list.map((l2) => {
      const current = this.dmae.getState(l2.id) ?? blankDmaeState(l2.id)
      const merged = {
        ...current,
        l2Id: l2.id,
        intrinsicValue: this.intrinsicValues.get(l2.id) ?? 0,
        state: deriveState(current.activation, threshold) as any,
      }
      return toDmaeEntry(l2, merged)
    })
  }

  /**
   * 跑一轮 DMAE 更新。
   * recalledIds 已按向量相似度排好序；turn 缺省时使用内部自增轮次。
   */
  async updateActivation(l2List: L2Memory[], userText: string, modelText: string, recalledIds: string[], turn?: number): Promise<void> {
    if (!this.loaded) await this.loadStates()
    const turnNo = turn ?? ++this.turnCounter

    for (const l2 of l2List) {
      if (this.dmae.getState(l2.id)) continue
      const created = await memoryStore.initL2DmaeStateIfMissing(l2.id)
      this.dmae.setState(created.l2Id, toEngineState(created))
    }

    this.setRecalledIntrinsicValues(recalledIds)

    this.dmae.updateActivation(this.buildEntries(l2List), userText, modelText, turnNo)

    await this.syncToStore()
  }

  /** 可注入 prompt 的 L2：置顶的永远在前，其余取激活的并按引擎排序，最多 maxCount 条 */
  async getActiveL2ForPrompt(l2List: L2Memory[], maxCount = 4): Promise<L2Memory[]> {
    if (!this.loaded) await this.loadStates()

    const pinned = l2List.filter((l2) => l2.isPinned)
    const candidates = l2List.filter((l2) => !l2.isPinned && l2.status !== "archived")
    const active = this.dmae.getActiveEntries(this.buildEntries(candidates), this.dmae.getParams().promptThreshold)
    return [...pinned, ...active.map((e) => e.l2)].slice(0, maxCount)
  }

  /** 把引擎状态逐条写回 memory.json（引擎的 Map 不可遍历，只能按 store 里已有的 id 取） */
  private async syncToStore(): Promise<void> {
    const threshold = this.dmae.getParams().promptThreshold
    for (const stored of await memoryStore.getAllL2DmaeStates()) {
      const live = this.dmae.getState(stored.l2Id)
      if (!live) continue
      await memoryStore.updateL2DmaeState(stored.l2Id, {
        activation: live.activation,
        intrinsicValue: this.intrinsicValues.get(stored.l2Id) ?? stored.intrinsicValue,
        userSilence: live.userSilence,
        modelSilence: live.modelSilence,
        recentUserHits: live.recentUserHits,
        state: deriveState(live.activation, threshold) as L2DmaeState["state"],
      })
    }
  }
}

export const l2DmaeManager = new L2DmaeManager()
