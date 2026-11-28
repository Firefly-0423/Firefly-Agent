import type { EntrySnapshot, SimResult, SimStats } from "../sim-types";

export function computeStats(result: SimResult): SimStats {
  const owners = new Map<string, SimResult["entries"][number]>();
  const shares = new Map<string, number>();
  const streaks = new Map<string, number[]>();
  for (const item of result.entries) {
    if (!owners.has(item.id)) owners.set(item.id, item);
  }
  for (const item of result.entries) {
    shares.set(item.id, 0);
    streaks.set(item.id, []);
  }
  const turns = result.snapshots.length;
  const positions = new Map<number, string[]>();
  result.snapshots.forEach((snapshots, turn) => {
    positions.set(turn, snapshots.filter((snapshot) => {
      const owner = owners.get(snapshot.entryId);
      return owner !== undefined && !owner.permanent && snapshot.activation > 0;
    }).sort((left, right) => right.activation - left.activation).map((snapshot) => snapshot.entryId));
    for (const snapshot of snapshots) {
      if (snapshot.state === "Active") shares.set(snapshot.entryId, (shares.get(snapshot.entryId) ?? 0) + 1);
    }
  });
  for (const [identifier, activeCount] of shares) shares.set(identifier, turns > 0 ? activeCount / turns : 0);
  for (const item of result.entries) {
    const observations = result.snapshots.map((snapshots) => snapshots.find((snapshot) => snapshot.entryId === item.id))
      .filter((snapshot): snapshot is EntrySnapshot => snapshot !== undefined);
    let length = 0;
    const spans = streaks.get(item.id)!;
    for (const observation of observations) {
      if (observation.state === "Active") length++;
      else if (length > 0) { spans.push(length); length = 0; }
    }
    if (length > 0) spans.push(length);
  }
  const means = new Map<string, number>();
  for (const [identifier, spans] of streaks) {
    const sum = spans.reduce((accumulator, length) => accumulator + length, 0);
    means.set(identifier, spans.length > 0 ? sum / spans.length : 0);
  }
  return { promptOccupancy: shares, avgActiveLife: means, promptRanking: positions, totalRounds: turns };
}

export function printStats(result: SimResult): void {
  const metrics = result.stats;
  const dynamicEntries = result.entries.filter((item) => !item.permanent);
  const config = result.params;
  console.log("\n=== 3 类统计 ===");
  console.log(`参数: Bu=${config.userRewardBase} γ=${config.wakeGamma} Bm=${config.modelRewardBase} λ=${config.wakeLambda} α=${config.decayAlpha} β=${config.decayBeta} threshold=${config.promptThreshold}`);
  console.log(`总轮数: ${metrics.totalRounds}\n`);
  console.log("--- Prompt 占用率（多少轮处于 Active）---");
  const usage = dynamicEntries.map((item) => ({ identifier: item.id, intrinsic: item.intrinsicValue, ratio: metrics.promptOccupancy.get(item.id) ?? 0 }))
    .sort((left, right) => right.ratio - left.ratio);
  for (const item of usage) {
    const glyphs = "█".repeat(Math.round(item.ratio * 40));
    console.log(`  ${item.identifier.padEnd(40)}  I=${String(item.intrinsic).padStart(3)}  ${(item.ratio * 100).toFixed(1).padStart(5)}%  ${glyphs}`);
  }
  console.log("\n--- 平均寿命（一次激活平均持续轮数）---");
  const lifetimes = dynamicEntries.map((item) => ({ identifier: item.id, intrinsic: item.intrinsicValue, mean: metrics.avgActiveLife.get(item.id) ?? 0 }))
    .sort((left, right) => right.mean - left.mean);
  for (const item of lifetimes) console.log(`  ${item.identifier.padEnd(40)}  I=${String(item.intrinsic).padStart(3)}  ${item.mean.toFixed(2).padStart(6)} 轮/次`);
  console.log("\n--- 每轮 Prompt 排名（每 5 轮抽样）---");
  const interval = Math.max(1, Math.floor(metrics.totalRounds / 20));
  for (let turn = 0; turn < metrics.totalRounds; turn += interval) {
    const leaders = (metrics.promptRanking.get(turn) ?? []).slice(0, 5);
    if (leaders.length === 0) continue;
    const labels = leaders.map((identifier, rank) => `${rank + 1}.${identifier.split("_").slice(-2).join("_")}`);
    console.log(`  R${String(turn).padStart(3)}: ${labels.join("  ")}`);
  }
}
