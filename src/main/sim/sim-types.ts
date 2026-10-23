// 模拟器的数据形状定义（仅类型，无运行时代码）
import type { DmaeState, DmaeParams, WorldbookEntry } from "../rag/worldbook";

export interface Scenario {
  name: string;
  description: string;
  buildRounds(): Round[];
  buildEntries(): WorldbookEntry[];       // fixture → entry 解析
}

export interface SimStats {
  promptOccupancy: Map<string, number>;   // entryId → 占用率 0~1
  avgActiveLife: Map<string, number>;     // entryId → 一次激活平均持续轮数
  promptRanking: Map<number, string[]>;   // roundIdx → 该轮按 A 降序的 entryId 列表
  totalRounds: number;
}

export interface EntrySnapshot {
  entryId: string;
  intrinsicValue: number;
  priority: number;
  activation: number;
  userSilence: number;
  modelSilence: number;
  state: DmaeState;
  userHit: boolean;         // 本轮是否被 user 命中
  modelHit: boolean;        // 本轮是否被 model 命中
  recentUserHits: number[]; // V5.1 repeatWindow 内命中轮次
}

export interface Round {
  index: number;            // 0-based 轮次
  userText: string;         // 本轮用户输入
  modelText: string;        // 本轮模型回复（用于 modelHit 检测）
  note?: string;            // 调试注释
}

export interface SimResult {
  scenario: string;
  params: DmaeParams;
  entries: WorldbookEntry[];
  rounds: Round[];
  snapshots: EntrySnapshot[][];   // [roundIdx][entryIdx] = 该轮该条目的快照
  stats: SimStats;                // 由 render/stats.ts 计算填充
}
