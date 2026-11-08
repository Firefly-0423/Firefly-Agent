// 把每轮每条目的快照写成 CSV（一行一条目一轮）
import * as fs from "fs";
import * as path from "path";
import type { SimResult } from "../sim-types";

const HEADER = [
  "round", "entryId", "intrinsicValue", "priority", "activation",
  "userSilence", "modelSilence", "state", "userHit", "modelHit",
].join(",");

type Snapshot = SimResult["snapshots"][number][number];

function csvRow(round: number, entry: Snapshot): string {
  const fields = [round, entry.entryId, entry.intrinsicValue, entry.priority,
    entry.activation.toFixed(3), entry.userSilence, entry.modelSilence, entry.state,
    entry.userHit ? 1 : 0, entry.modelHit ? 1 : 0];
  return fields.join(",");
}

export function exportCsv(result: SimResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, `${result.scenario}.csv`);
  const lines: string[] = [];
  result.snapshots.forEach((entries, round) => {
    for (const entry of entries) lines.push(csvRow(round, entry));
  });
  fs.writeFileSync(target, [HEADER, ...lines, ""].join("\n"), "utf8");
  return target;
}
