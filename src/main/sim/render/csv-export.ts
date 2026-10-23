// 把每轮每条目的快照写成 CSV（一行一条目一轮）
import * as fs from "fs";
import * as path from "path";
import type { SimResult } from "../sim-types";

const HEADER = [
  "round", "entryId", "intrinsicValue", "priority", "activation",
  "userSilence", "modelSilence", "state", "userHit", "modelHit",
].join(",");

export function exportCsv(result: SimResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, `${result.scenario}.csv`);
  const body: string[] = [HEADER];
  result.snapshots.forEach((frame, round) => {
    for (const s of frame) {
      body.push([
        round,
        s.entryId,
        s.intrinsicValue,
        s.priority,
        s.activation.toFixed(3),
        s.userSilence,
        s.modelSilence,
        s.state,
        s.userHit ? 1 : 0,
        s.modelHit ? 1 : 0,
      ].join(","));
    }
  });
  fs.writeFileSync(target, body.join("\n") + "\n", "utf8");
  return target;
}
