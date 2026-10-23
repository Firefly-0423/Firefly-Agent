// 注释里的 "V5 §x" / "v4.0 §x" 指 DMAE 世界书升级设计稿的章节编号。
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { WORLDBOOK_CONSTANTS } from "./worldbook-constants";
import { logger, LogTag } from "../logger";

// ───────────── 条目定义 ─────────────

export type WorldbookEntry = {
  id: string;
  enabled: boolean;
  keywords: string[];
  content: string;
  /** 作者设定的重要度，仅用于同分排序，不参与 DMAE 打分 */
  priority: number;
  /** 常驻条目：每次都注入，绕过 DMAE */
  permanent: boolean;
  /** 长期价值基准（固定值）：决定首次激活底线与遗忘阻力，不影响奖励 */
  intrinsicValue: number;
  /** 连带触发词：本条被用户命中时，一次性带出匹配这些词的其他条目；空数组表示不连带 */
  linkTriggers: string[];
};

/**
 * DMAE 引擎使用的通用条目形状。
 * WorldbookEntry 与 L2Memory 都可以通过适配器满足它，从而共用同一个引擎。
 */
export interface DmaeEntry {
  id: string;
  keywords: string[];        // 用于命中检测；L2 记忆用正文分词或证据实体
  intrinsicValue: number;    // 抗遗忘强度；L2 召回时按名次临时赋值
  permanent: boolean;        // 常驻则绕过 DMAE；L2 的 isPinned 对应这里
  enabled: boolean;
}

/**
 * 每个条目的运行时状态，以 entry.id 为键单独保存。
 * 不挂在 WorldbookEntry 上，因为 loadFromDirectory 会整体替换条目数组，挂上去重载就丢了。
 */
export interface EntryState {
  activation: number;       // 取值 0..MaxScore
  userSilence: number;      // 距离上次用户命中过了几轮
  modelSilence: number;     // 距离上次模型命中过了几轮
  recentUserHits: number[]; // V5 §5.5：重复统计窗口内的用户命中轮次
  // 没有 state 字段：状态由 (activation, 阈值) 推导，由业务层负责
}

export type DmaeState = "Active" | "Dormant" | "Archived";

/**
 * DMAE 可调参数（v5.1 规范）。这些只是默认值而不是定论，之后通过 Simulator 调整。
 * 公式：
 *   Ru* = Bu × (1 + γ · ln(1+U_old)) × G_sat × G_repeat   （仅用户命中）
 *   Rm  = Bm × e^(−λ·U_old)                               （仅模型命中且条目 Active）
 *   D   = (α·U_new² + β·M_new²) / √I
 *   G_sat     = (1 - A_old/A_max)^p
 *   G_repeat  = 1 / (1 + ρ · n_w)
 */
export interface DmaeParams {
  maxScore: number;             // 100：激活值上界
  promptThreshold: number;      // 30：达到此值才进入 Prompt（业务层使用）
  /** 用户基础奖励：每次用户命中至少增加多少 */
  userRewardBase: number;       // Bu = 20
  /** 久别重逢增益：ln(1+U_old) 的系数，越大则久未提及后再命中的奖励越高 */
  wakeGamma: number;            // γ = 0.5
  /** 模型基础奖励：模型命中且条目 Active 时的奖励上限 */
  modelRewardBase: number;      // Bm = 8
  /** 模型奖励衰减率：U_old 越大，Rm 越快趋近 0 */
  wakeLambda: number;           // λ = 0.3
  /** 用户沉默权重：用户不提及时衰减的快慢（按"8 轮跌破阈值"反推为 1.5） */
  decayAlpha: number;           // α = 1.5（世界书沿用 V4 值；L2 专用实例可调高）
  /** 模型沉默权重：模型不复述时衰减的快慢（需满足 α > β） */
  decayBeta: number;            // β = 0.3（世界书沿用 V4 值；L2 专用实例可调低）
  /** 重复抑制强度：越大则短期内重复命中的奖励越低 */
  repeatRho: number;            // ρ = 0.5
  /** 饱和抑制幂次：决定接近上界时奖励被压缩的速度 */
  satPower: number;             // p = 2
  /** 重复统计窗口：最近多少轮内的命中算作重复 */
  repeatWindow: number;         // w = 6
  /** 唤醒补偿：Archived 条目复活时在阈值之上额外给的初始激活（A_init = T_active + B_w） */
  wakeBonus: number;            // B_w = 5
}

export const DEFAULT_DMAE_PARAMS: DmaeParams = {
  // 上界与注入阈值
  maxScore: 100, promptThreshold: 30,
  // 奖励
  userRewardBase: 20, wakeGamma: 0.5, modelRewardBase: 8, wakeLambda: 0.3,
  // 衰减
  decayAlpha: 1.5, decayBeta: 0.3,
  // 门控与唤醒
  repeatRho: 0.5, satPower: 2, repeatWindow: 6, wakeBonus: 5,
};

// ───────────── 策略接口（v4.0 起框架固定） ─────────────

export type RewardContext<T extends DmaeEntry = DmaeEntry> = {
  params: DmaeParams;
  entry: T;
  snap: { activation: number; userSilence: number; modelSilence: number };
  /** V5 §5.5：当前重复窗口内的用户命中次数（含本轮） */
  recentHitCount: number;
};
export type DecayContext<T extends DmaeEntry = DmaeEntry> = {
  params: DmaeParams;
  entry: T;
  /** 本轮更新后的沉默计数 */
  snap: { userSilence: number; modelSilence: number };
};

export interface RewardStrategy<T extends DmaeEntry = DmaeEntry> {
  // v4.0 §4：用户命中奖励 Ru = Bu × (1 + γ·ln(1+U_old))，只在 userHit 时被调用。
  userReward(ctx: RewardContext<T>): number;

  // v4.0 §5：模型维护奖励 Rm = Bm × e^(−λ·U_old)，只在 modelHit 且条目 Active 时调用，
  // 调用方负责把结果限制在 D 以内。
  modelReward(ctx: RewardContext<T>): number;
}

export interface DecayStrategy<T extends DmaeEntry = DmaeEntry> {
  compute(ctx: DecayContext<T>): number;
}

// V5.1 的两个门控：饱和抑制与重复抑制
function gateSaturation(activation: number, p: number, aMax: number): number {
  return activation >= aMax ? 0 : Math.pow(1 - activation / aMax, p);
}

function gateRepeat(hitCount: number, rho: number): number {
  return 1 / (1 + rho * hitCount);
}

/**
 * V5.1 默认奖励策略：
 *   Ru* = Bu × (1 + γ·ln(1 + U_old)) × G_sat × G_rep   [V5 §5.6]
 *   Rm  = Bm × e^(−λ·U_old)                            [V5 §5.3]
 * 内在价值 I 不参与奖励，避免高价值条目涨得快又忘得慢而长期霸榜。
 */
export class DefaultRewardStrategy<T extends DmaeEntry = DmaeEntry> implements RewardStrategy<T> {
  userReward({ snap, params, recentHitCount }: RewardContext<T>): number {
    const wake = 1 + params.wakeGamma * Math.log(1 + snap.userSilence);
    const saturation = gateSaturation(snap.activation, params.satPower, params.maxScore);
    const repeat = gateRepeat(recentHitCount, params.repeatRho);
    return params.userRewardBase * wake * saturation * repeat;
  }

  modelReward({ snap, params }: RewardContext<T>): number {
    return params.modelRewardBase * Math.exp(-params.wakeLambda * snap.userSilence);
  }
}

/**
 * v3.4 默认衰减策略：Decay = (α·US² + β·MS²) / sqrt(I)。
 * 平方使遗忘随沉默轮数加速（§8.1）；I 只体现在分母的阻力上：价值越高忘得越慢。
 */
export class QuadraticResistanceDecay<T extends DmaeEntry = DmaeEntry> implements DecayStrategy<T> {
  compute({ entry, snap, params }: DecayContext<T>): number {
    const value = Math.max(WORLDBOOK_CONSTANTS.MIN_INTRINSIC_VALUE, entry.intrinsicValue);
    const pressure = params.decayAlpha * snap.userSilence ** 2 + params.decayBeta * snap.modelSilence ** 2;
    return pressure * (1 / Math.sqrt(value));
  }
}

/** 由激活值推导状态：<=0 为 Archived，>=阈值为 Active，其余为 Dormant。 */
export function deriveState(activation: number, threshold: number): DmaeState {
  if (activation <= 0) return "Archived";
  return activation >= threshold ? "Active" : "Dormant";
}

// ───────────── 通用 DMAE 引擎 ─────────────

export type DmaeManagerOptions<T extends DmaeEntry = DmaeEntry> = {
  debug?: boolean;
  params?: Partial<DmaeParams>;
  decayStrategy?: DecayStrategy<T>;
  rewardStrategy?: RewardStrategy<T>;
};

const freshState = (): EntryState => ({ activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] });

export class DmaeManager<T extends DmaeEntry> {
  private readonly state = new Map<string, EntryState>();
  private readonly params: DmaeParams;
  private readonly debug: boolean;
  private readonly rewardStrategy: RewardStrategy<T>;
  private readonly decayStrategy: DecayStrategy<T>;

  constructor(options: DmaeManagerOptions<T> = {}) {
    const { params, rewardStrategy, decayStrategy, debug } = options;
    this.params = { ...DEFAULT_DMAE_PARAMS, ...(params ?? {}) };
    this.debug = debug ?? true;
    this.rewardStrategy = rewardStrategy ?? new DefaultRewardStrategy<T>();
    this.decayStrategy = decayStrategy ?? new QuadraticResistanceDecay<T>();
  }

  getParams(): DmaeParams { return this.params; }

  getDebug(): boolean { return this.debug; }

  /** 初始化或重置单个条目的状态。 */
  initEntry(id: string): void {
    this.state.set(id, freshState());
  }

  removeEntry(id: string): void { this.state.delete(id); }

  clear(): void { this.state.clear(); }

  /** 批量登记条目（例如加载世界书或 L2 列表）；常驻和禁用的条目不进状态表。 */
  initEntries(entries: readonly T[]): void {
    this.state.clear();
    entries
      .filter((e) => e.enabled && !e.permanent)
      .forEach((e) => this.state.set(e.id, freshState()));
  }

  getState(id: string): EntryState | undefined { return this.state.get(id); }

  setState(id: string, st: EntryState): void { this.state.set(id, st); }

  /** V5.1 主循环：根据本轮用户/模型文本更新所有条目的激活值，返回被用户命中的条目 id。 */
  updateActivation(entries: readonly T[], userText: string, modelText: string, turn = 0): Set<string> {
    const userSide = userText ?? "";
    const modelSide = modelText ?? "";
    const { params } = this;
    const ceiling = params.maxScore;
    const threshold = params.promptThreshold;
    const trace: Array<{ id: string; aOld: number; aNew: number; reason: string }> = [];
    const userHits = new Set<string>();

    for (const entry of entries) {
      if (!entry.enabled || entry.permanent || entry.keywords.length === 0) continue;

      const hitByUser = entry.keywords.some((kw) => userSide.includes(kw));
      const hitByModel = entry.keywords.some((kw) => modelSide.includes(kw));
      if (hitByUser) userHits.add(entry.id);

      const st = this.state.get(entry.id);
      if (!st) continue;

      const prevActivation = st.activation;
      const prevUserSilence = st.userSilence;
      const prevModelSilence = st.modelSilence;
      const prevState = deriveState(prevActivation, threshold);

      // 本轮没被任何一方提到的 Archived 条目无需计算
      if (prevState === WORLDBOOK_CONSTANTS.STATES.ARCHIVED && !hitByUser && !hitByModel) continue;

      // 唤醒阶段（V5 §7.4）：Archived 被用户命中时从阈值之上重新起步
      const woke = hitByUser && prevState === WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE;
      const baseline = woke ? Math.min(ceiling, threshold + params.wakeBonus) : prevActivation;

      const userSilence = hitByUser ? 0 : prevUserSilence + 1;
      const modelSilence = hitByUser || hitByModel ? 0 : prevModelSilence + 1;

      // V5.5：维护重复统计窗口
      const windowStart = turn - params.repeatWindow;
      const hitsBefore = hitByUser ? [...st.recentUserHits, turn] : st.recentUserHits;
      const hitsInWindow = hitsBefore.filter((t) => t > windowStart);
      const recentHitCount = hitsInWindow.length;

      const userReward = hitByUser
        ? this.rewardStrategy.userReward({
            entry,
            snap: { activation: baseline, userSilence: prevUserSilence, modelSilence: prevModelSilence },
            params,
            recentHitCount,
          })
        : 0;

      const decay = this.decayStrategy.compute({
        entry,
        snap: { userSilence, modelSilence },
        params,
      });

      // 模型奖励只给原本 Active 的条目，并被限制在 decay 之内，保证 Rm < D
      let modelReward = 0;
      if (hitByModel && prevState === WORLDBOOK_CONSTANTS.STATES.ACTIVE) {
        const raw = this.rewardStrategy.modelReward({
          entry,
          snap: { activation: prevActivation, userSilence: prevUserSilence, modelSilence: prevModelSilence },
          params,
          recentHitCount,
        });
        modelReward = Math.max(0, Math.min(raw, decay - WORLDBOOK_CONSTANTS.EPSILON));
      }

      const next = Math.max(0, Math.min(ceiling, baseline + userReward + modelReward - decay));

      st.activation = next;
      st.userSilence = userSilence;
      st.modelSilence = modelSilence;
      st.recentUserHits = hitsInWindow;

      const worthLogging = hitByUser || hitByModel || woke || Math.abs(next - prevActivation) >= 0.05;
      if (this.debug && worthLogging) {
        const parts: string[] = [];
        if (woke) parts.push(`wake→${baseline.toFixed(1)}`);
        if (hitByUser) parts.push(`U+${userReward.toFixed(2)}`);
        if (hitByModel) parts.push(`M+${modelReward.toFixed(2)}`);
        if (decay > 0) parts.push(`D-${decay.toFixed(2)}`);
        trace.push({ id: entry.id, aOld: prevActivation, aNew: next, reason: parts.join(" ") });
      }
    }

    if (this.debug && trace.length > 0) {
      console.log(`[DMAE] update: ${trace.length} entries changed`);
      trace.slice(0, 12).forEach((t) => {
        console.log(`  ${t.id}: ${t.aOld.toFixed(1)} → ${t.aNew.toFixed(1)}  (${t.reason})`);
      });
    }

    return userHits;
  }

  /** 返回激活值达到阈值的条目，按激活值降序（通用层没有 priority 概念）。 */
  getActiveEntries(entries: readonly T[], threshold?: number): T[] {
    const limit = threshold ?? this.params.promptThreshold;
    const activationOf = (e: T) => this.state.get(e.id)!.activation;
    return entries
      .filter((e) => {
        if (!e.enabled || e.permanent) return false;
        const st = this.state.get(e.id);
        return !!st && deriveState(st.activation, limit) === WORLDBOOK_CONSTANTS.STATES.ACTIVE;
      })
      .sort((a, b) => activationOf(b) - activationOf(a));
  }
}

// ───────────── 世界书管理器 ─────────────

export type WorldbookManagerOptions = {
  debug?: boolean;
  params?: Partial<DmaeParams>;
  decayStrategy?: DecayStrategy<WorldbookEntry>;
  rewardStrategy?: RewardStrategy<WorldbookEntry>;
  /** 持久化预留位：目前传入也不读写，重启后状态归零 */
  stateFile?: string;
};

// 元数据行里可能出现的字段（冒号可为中文或英文，除 常驻/优先级 只认英文冒号）
const KEYWORD_SPLIT = /[,，、]/;
const NO_LINK_VALUES = ["无", "none", "-"];

const splitList = (raw: string): string[] => raw.split(KEYWORD_SPLIT).map((k) => k.trim()).filter(Boolean);

const startsWithAny = (line: string, prefixes: string[]): boolean => prefixes.some((p) => line.startsWith(p));

const both = (label: string): string[] => [`- ${label}:`, `- ${label}：`];

export class WorldbookManager {
  private readonly worldbookDir: string;
  private readonly dmae: DmaeManager<WorldbookEntry>;
  private readonly stateFile?: string;
  private entries: WorldbookEntry[] = [];
  // One-Shot 连带：本轮用户命中后顺带触发的条目，不进 DMAE 状态表，仅本轮有效
  private lastCascadeEntries: WorldbookEntry[] = [];

  // 最终注入条数上限（见 worldbook-constants.ts）
  private static readonly MAX_ACTIVE = WORLDBOOK_CONSTANTS.MAX_ACTIVE;

  // 条目未写内在价值时采用的默认值（见 worldbook-constants.ts）
  private static readonly DEFAULT_INTRINSIC_VALUE = WORLDBOOK_CONSTANTS.DEFAULT_INTRINSIC_VALUE;

  constructor(worldbookDir: string, options: WorldbookManagerOptions = {}) {
    const { params, rewardStrategy, decayStrategy, debug, stateFile } = options;
    this.worldbookDir = worldbookDir;
    this.stateFile = stateFile;
    this.dmae = new DmaeManager<WorldbookEntry>({ params, rewardStrategy, decayStrategy, debug });
  }

  /** 读取世界书目录下全部 .md 文件。 */
  async loadFromDirectory(): Promise<void> {
    if (!existsSync(this.worldbookDir)) {
      console.warn("[Worldbook] directory not found:", this.worldbookDir);
      return;
    }

    const files = readdirSync(this.worldbookDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      console.warn("[Worldbook] no .md files found in:", this.worldbookDir);
      return;
    }

    const loaded = files.flatMap((file) =>
      this.parseMarkdown(readFileSync(join(this.worldbookDir, file), "utf8"), file),
    );
    this.entries = loaded;

    // 非常驻条目从 activation=0（Archived 冷态）开始；常驻条目始终注入，不分配状态
    this.dmae.initEntries(this.entries);
    this.loadState();

    const nonPermanent = this.entries.filter((e) => e.enabled && !e.permanent).length;
    logger.info(LogTag.Worldbook, `loaded ${loaded.length} entries from ${files.length} files; DMAE state initialized for ${nonPermanent} non-permanent entries`);
  }

  /** 直接用内存中的条目初始化（不读磁盘），供模拟器和测试走与生产相同的初始化路径。 */
  loadFromEntries(entries: WorldbookEntry[]): void {
    this.dmae.initEntries((this.entries = entries));
    this.loadState();
  }

  /**
   * 解析 Markdown：
   *   ## 条目名
   *   - 触发词: 词1, 词2, 词3
   *   - 常驻: 是
   *   - 优先级: 200
   *   - 内在价值: 60       （兼容 初始分 / initial_score / intrinsic_value）
   *
   *   正文……
   *   ---
   */
  private parseMarkdown(content: string, fileName: string): WorldbookEntry[] {
    const parsed: WorldbookEntry[] = [];
    const lines = content.split("\n");
    const keywordPrefixes = both("触发词");
    const valuePrefixes = ["初始分", "initial_score", "内在价值", "intrinsic_value"].flatMap(both);
    const linkPrefixes = ["连带触发词", "连带触发", "link_triggers"].flatMap(both);

    let cursor = 0;
    while (cursor < lines.length) {
      const heading = lines[cursor].trim();
      cursor++;
      if (!heading.startsWith("## ")) continue;

      const title = heading.replace(/^## /, "").trim();

      let keywords: string[] = [], linkTriggers: string[] = [];
      let permanent = false, priority = 5;
      let intrinsicValue = WorldbookManager.DEFAULT_INTRINSIC_VALUE;

      // 标题之后紧跟的 "- 字段: 值" 元数据行
      metadata: while (cursor < lines.length) {
        const meta = lines[cursor].trim();

        if (startsWithAny(meta, keywordPrefixes)) {
          keywords = splitList(meta.replace(/^-\s*触发词[：:]/, "").trim());
        } else if (meta.startsWith("- 常驻:")) {
          const flag = meta.replace(/^-\s*常驻:/, "").trim();
          permanent = flag === "是" || flag === "yes" || flag === "true";
        } else if (meta.startsWith("- 优先级:")) {
          priority = parseInt(meta.replace(/^-\s*优先级:/, "").trim()) || 5;
        } else if (startsWithAny(meta, valuePrefixes)) {
          const num = parseFloat(meta.replace(/^-\s*(初始分|initial_score|内在价值|intrinsic_value)[：:]/, "").trim());
          intrinsicValue = Number.isFinite(num) ? num : WorldbookManager.DEFAULT_INTRINSIC_VALUE;
        } else if (startsWithAny(meta, linkPrefixes)) {
          const raw = meta.replace(/^-\s*(连带触发词|连带触发|link_triggers)[：:]/, "").trim();
          // 空值、"无"、"none"、"-" 都表示不连带
          if (raw && !NO_LINK_VALUES.includes(raw)) linkTriggers = splitList(raw);
        } else if (meta.startsWith("---")) {
          cursor++; // 分隔线：元数据到此结束
          break metadata;
        } else if (meta === "" || meta.startsWith("# ")) {
          break metadata;
        } else if (!meta.startsWith("- ")) {
          break metadata; // 正文行
        }
        // 其余以 "- " 开头的未知字段直接跳过
        cursor++;
      }

      // 正文一直收集到下一个 ## 标题或 --- 分隔线
      const body: string[] = [];
      while (cursor < lines.length) {
        const raw = lines[cursor];
        const trimmed = raw.trim();
        if (trimmed.startsWith("## ") || trimmed === "---") break;
        body.push(raw);
        cursor++;
      }

      const text = body.join("\n").trim();
      if (!text) continue;
      parsed.push({
        id: `wb_${fileName.replace(/\.md$/, "")}_${title.replace(/\s+/g, "_")}`,
        keywords,
        content: text,
        priority,
        permanent,
        enabled: true,
        intrinsicValue,
        linkTriggers,
      });
    }

    return parsed;
  }

  /** DMAE 打分，之后再追加 One-Shot 连带触发。 */
  updateActivation(userText: string, modelText: string, turn = 0): void {
    const userHitIds = this.dmae.updateActivation(this.entries, userText, modelText, turn);

    // One-Shot 连带（不进 DMAE 状态表，仅本轮有效），三条硬约束防止死循环：
    //   1. 只有用户命中的条目才有连带权，被带出的条目不再继续连带（最多一层）；
    //   2. 目标已经被用户直接命中则跳过；
    //   3. 同一条目本轮只带出一次。
    this.lastCascadeEntries = [];
    const alreadyAdded = new Set<string>();

    for (const source of this.entries) {
      if (!userHitIds.has(source.id)) continue;
      if (source.linkTriggers.length === 0) continue;
      if (source.permanent || !source.enabled) continue;

      const targets = this.entries.filter(
        (e) => e.enabled && !e.permanent && e.keywords.some((kw) => source.linkTriggers.includes(kw)),
      );
      for (const target of targets) {
        if (userHitIds.has(target.id) || alreadyAdded.has(target.id)) continue;
        alreadyAdded.add(target.id);
        this.lastCascadeEntries.push(target);
      }
    }

    if (this.dmae.getDebug() && this.lastCascadeEntries.length > 0) {
      console.log(`[Worldbook/Cascade] ${this.lastCascadeEntries.length} entries one-shot injected: ${this.lastCascadeEntries.map((e) => e.id).join(", ")}`);
    }
  }

  /** 本轮 One-Shot 连带触发的条目（仅供注入使用），已经是 Active 注入的条目不重复返回。 */
  getCascadeEntries(): WorldbookEntry[] {
    const injected = new Set(
      this.dmae
        .getActiveEntries(this.entries)
        .slice(0, WorldbookManager.MAX_ACTIVE)
        .map((e) => e.id),
    );
    return this.lastCascadeEntries.filter((e) => !injected.has(e.id));
  }

  /**
   * 业务层注入：取 deriveState(activation, promptThreshold) 为 Active 的条目，
   * 按激活值降序、同分按 priority 降序，截取 MAX_ACTIVE 条。
   */
  getActiveEntries(promptThreshold?: number): string[] {
    const threshold = promptThreshold ?? this.dmae.getParams().promptThreshold;
    const activationOf = (e: WorldbookEntry) => this.dmae.getState(e.id)!.activation;

    const active = (this.dmae.getActiveEntries(this.entries, threshold) as WorldbookEntry[])
      .sort((a, b) => activationOf(b) - activationOf(a) || b.priority - a.priority)
      .slice(0, WorldbookManager.MAX_ACTIVE);

    if (this.dmae.getDebug() && active.length > 0) {
      console.log(`[Worldbook/DMAE] active entries injected: ${active.length} (threshold=${threshold})`);
    }
    // 带上标题，让模型知道这段设定说的是谁；标题由 id（wb_<文件>_<标题>）还原
    return active.map((e) => {
      const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
      return `【${title}】\n${e.content}`;
    });
  }

  /** 常驻条目：始终注入，绕过 DMAE。 */
  getPermanentEntries(): string[] {
    const always = this.entries.filter((e) => e.enabled && e.permanent);
    always.sort((a, b) => b.priority - a.priority);
    return always.map((e) => e.content);
  }

  /** 所有登记过的触发词（旧接口，为兼容保留）。 */
  getAllTriggerWords(): string[] {
    return [...new Set(this.entries.flatMap((e) => e.keywords))];
  }

  get entriesCount(): number {
    return this.entries.length;
  }

  // 只读访问器，供模拟器和调试使用
  getEntries(): readonly WorldbookEntry[] { return this.entries; }

  getState(id: string): EntryState | undefined { return this.dmae.getState(id); }

  // 持久化预留位（v1 不做任何事，后续接入与 JsonVectorStore 类似的同步 JSON）
  private loadState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: 读取 stateFile 并还原到 dmae；当前重启后归零，已确认 v1 接受
  }

  private saveState(): void {
    if (!this.stateFile) return;
    // TODO v1.1: 把 dmae 状态序列化写入 stateFile
  }
}
