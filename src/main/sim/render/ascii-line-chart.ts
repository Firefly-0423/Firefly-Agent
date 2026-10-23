// 折线图：每个动态条目一张，横轴为轮次，纵轴为 A 值，并用字符标注状态
import type { SimResult } from "../sim-types";

const COLS = 60;
const ROWS = 12;

interface Point {
  round: number;
  a: number;
  state: string;
}

export function renderLineCharts(result: SimResult): void {
  console.log("\n=== ASCII 折线图（每条目一张）===");
  const yMax = result.params.maxScore;
  const threshold = result.params.promptThreshold;
  for (const entry of result.entries) {
    if (entry.permanent) {
      console.log(`\n[permanent] ${entry.id} (常驻旁路，不进 DMAE)`);
      continue;
    }
    const points: Point[] = [];
    result.snapshots.forEach((frame, round) => {
      const hit = frame.find((s) => s.entryId === entry.id);
      if (hit) points.push({ round, a: hit.activation, state: hit.state });
    });
    plot(entry.id, entry.intrinsicValue, points, result.snapshots.length, yMax, threshold);
  }
}

// 把纵坐标值映射到网格行号（越大越靠上）
function rowOf(value: number, yMax: number): number {
  return Math.round((1 - value / yMax) * (ROWS - 1));
}

function plot(
  title: string,
  intrinsicValue: number,
  points: Point[],
  totalRounds: number,
  yMax: number,
  threshold: number,
): void {
  console.log(`\n${title}  (I=${intrinsicValue})`);
  if (points.length === 0) {
    console.log("  (no data)");
    return;
  }
  const canvas: string[][] = Array.from({ length: ROWS }, () => new Array<string>(COLS).fill(" "));

  // 先画阈值线，再画 I 线（I 线覆盖阈值线）
  const thresholdRow = rowOf(threshold, yMax);
  const intrinsicRow = rowOf(intrinsicValue, yMax);
  for (let x = 0; x < COLS; x++) {
    const tick = x % 5 === 0;
    if (thresholdRow >= 0 && thresholdRow < ROWS) canvas[thresholdRow][x] = tick ? ":" : "·";
    if (intrinsicRow >= 0 && intrinsicRow < ROWS) canvas[intrinsicRow][x] = tick ? "-" : "·";
  }

  for (const p of points) {
    const x = Math.round((p.round / Math.max(1, totalRounds - 1)) * (COLS - 1));
    const y = rowOf(p.a, yMax);
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
      canvas[y][x] = pointGlyph(p.state);
    }
  }

  for (let row = 0; row < ROWS; row++) {
    const value = Math.round((1 - row / (ROWS - 1)) * yMax);
    console.log(`${String(value).padStart(3)} |${canvas[row].join("")}|`);
  }
  console.log(`    0${"-".repeat(COLS)}${totalRounds - 1}`);
  console.log(`    [█=Active  ▒=Dormant  ·=Archived  :·=threshold(${threshold})  -·=I值(${intrinsicValue})]`);
}

function pointGlyph(state: string): string {
  if (state === "Active") return "█";
  if (state === "Dormant") return "▒";
  return "·";
}
