// L2 工作记忆模拟运行器：复用通用 DmaeManager 与 L2 适配层，全程在内存中进行，不读写 memory.json。
import { DefaultRewardStrategy, DmaeManager, QuadraticResistanceDecay, deriveState } from "../rag/worldbook";
import type { L2Fixture } from "./scenarios/l2-working-memory";
import { L2_FIXTURES, L2_ROUNDS } from "./scenarios/l2-working-memory";
import type { Round } from "./sim-types";
import { L2_DMAE_PARAMS, L2_INTRINSIC_BY_RANK } from "../memory/l2-dmae-manager";
import type { L2Memory } from "../memory/memory-types";

const RECALL_TOP_K = 4;

interface L2DmaeEntry {
  id: string;
  keywords: string[];
  intrinsicValue: number;
  permanent: boolean;
  enabled: boolean;
  l2: L2Memory;
}

type L2Manager = DmaeManager<L2DmaeEntry>;

// L2Memory → DMAE 条目
function toDmaeEntry(l2: L2Memory, intrinsicValue: number): L2DmaeEntry {
  return {
    id: l2.id,
    keywords: l2.keywords ?? [],
    intrinsicValue,
    permanent: l2.isPinned,
    enabled: l2.status !== "archived",
    l2,
  };
}

// 把 fixture 补全成 L2Memory（时间戳统一取当前时刻，计数类字段归零）
function materialize(fixtures: L2Fixture[]): L2Memory[] {
  const now = Date.now();
  return fixtures.map((f) => ({
    ...f,
    sourceConversationId: "sim",
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    weight: 0,
    isPinned: false,
    status: "active" as const,
  }));
}

// 以关键词命中数近似向量召回：只保留命中数大于 0 的条目，取前 k 个 id
function recall(userText: string, pool: L2Memory[], k: number): string[] {
  return pool
    .map((l2) => ({
      id: l2.id,
      hits: (l2.keywords ?? []).filter((kw) => userText.includes(kw)).length,
    }))
    .sort((a, b) => b.hits - a.hits)
    .filter((row) => row.hits > 0)
    .slice(0, k)
    .map((row) => row.id);
}

// 已归档的条目被召回时，直接拉回到阈值附近（wake-up）
function wakeIfArchived(mgr: L2Manager, id: string): void {
  const st = mgr.getState(id);
  if (!st) return;
  if (deriveState(st.activation, L2_DMAE_PARAMS.promptThreshold) !== "Archived") return;
  const revived = Math.min(
    L2_DMAE_PARAMS.maxScore,
    L2_DMAE_PARAMS.promptThreshold + L2_DMAE_PARAMS.wakeBonus,
  );
  mgr.setState(id, { ...st, activation: revived });
}

function printRound(
  mgr: L2Manager,
  pool: L2Memory[],
  assigned: Map<string, number>,
  round: Round,
  recalled: string[],
): void {
  console.log(`\n--- Round ${round.index + 1} ---`);
  console.log(`User: ${round.userText}`);
  console.log(`Recalled: [${recalled.join(", ")}]`);
  for (const l2 of pool) {
    const st = mgr.getState(l2.id)!;
    const state = deriveState(st.activation, L2_DMAE_PARAMS.promptThreshold);
    const I = assigned.get(l2.id) ?? 0;
    console.log(
      `  ${l2.id.padEnd(12)} A=${st.activation.toFixed(1).padStart(5)} US=${st.userSilence.toString().padStart(2)} MS=${st.modelSilence.toString().padStart(2)} I=${I.toString().padStart(2)} state=${state}`,
    );
  }
}

function simulate(): void {
  const mgr: L2Manager = new DmaeManager<L2DmaeEntry>({
    params: L2_DMAE_PARAMS,
    rewardStrategy: new DefaultRewardStrategy<L2DmaeEntry>(),
    decayStrategy: new QuadraticResistanceDecay<L2DmaeEntry>(),
    debug: false,
  });

  const pool = materialize(L2_FIXTURES);
  mgr.initEntries(pool.map((l2) => toDmaeEntry(l2, 0)));

  // 每条 L2 当前被赋予的 I，由召回位次决定
  const assigned = new Map<string, number>();

  console.log("V5 L2 Working Memory Simulator");
  console.log("Params:", JSON.stringify(L2_DMAE_PARAMS));
  console.log("I gradient by rank:", L2_INTRINSIC_BY_RANK);
  console.log("=".repeat(80));

  for (const round of L2_ROUNDS) {
    const recalled = recall(round.userText, pool, RECALL_TOP_K);

    recalled.forEach((id, rank) => {
      const tierIndex = Math.min(rank, L2_INTRINSIC_BY_RANK.length - 1);
      assigned.set(id, L2_INTRINSIC_BY_RANK[tierIndex]);
      wakeIfArchived(mgr, id);
    });

    const entries = pool.map((l2) => toDmaeEntry(l2, assigned.get(l2.id) ?? 0));
    mgr.updateActivation(entries, round.userText, round.modelText, round.index);

    printRound(mgr, pool, assigned, round, recalled);
  }
}

simulate();
