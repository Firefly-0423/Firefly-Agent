// DMAE 模拟器入口：解析命令行 → 选场景 → 驱动真实的 WorldbookManager → 输出 CSV、统计、折线图与条形图
// 算法本体位于 ../rag/worldbook，这里只做驱动与展示，不改动算法。
import * as path from "path";
import {
  WorldbookManager,
  deriveState,
  DEFAULT_DMAE_PARAMS,
  type DmaeParams,
  type WorldbookEntry,
} from "../rag/worldbook";
import { coffeeLifecycle } from "./scenarios/coffee-lifecycle";
import { fourTierMix } from "./scenarios/four-tier-mix";
import { dormantRescue } from "./scenarios/dormant-rescue";
import type { EntrySnapshot, Round, Scenario, SimResult } from "./sim-types";
import { computeStats, printStats } from "./render/stats";
import { exportCsv } from "./render/csv-export";
import { renderLineCharts } from "./render/ascii-line-chart";
import { renderBars } from "./render/ascii-bars";

type ScenarioKey = "coffee" | "mix" | "rescue";

interface CliOptions {
  scenario: ScenarioKey;
  overrides: Partial<DmaeParams>;
  sweepValues: number[] | null;
  outputDir: string;
  charts: boolean;
  bars: boolean;
}

const SCENARIOS: Record<ScenarioKey, Scenario> = {
  coffee: coffeeLifecycle,
  mix: fourTierMix,
  rescue: dormantRescue,
};

// 带数值的开关：flag → DmaeParams 字段
const NUMERIC_FLAGS: ReadonlyArray<readonly [string, keyof DmaeParams]> = [
  ["--wakeGamma", "wakeGamma"],
  ["--modelRewardBase", "modelRewardBase"],
  ["--wakeLambda", "wakeLambda"],
  ["--alpha", "decayAlpha"],
  ["--beta", "decayBeta"],
  ["--threshold", "promptThreshold"],
];

const VALUE_FLAGS = new Map<string, (opts: CliOptions, raw: string) => void>([
  ["--scenario", (o, raw) => { o.scenario = raw as ScenarioKey; }],
  ["--outputDir", (o, raw) => { o.outputDir = raw; }],
  ["--userRewardBase", (o, raw) => {
    if (raw.includes(",")) {
      o.sweepValues = raw.split(",").map(Number).filter(Number.isFinite);
    } else {
      o.overrides.userRewardBase = Number(raw);
    }
  }],
  ...NUMERIC_FLAGS.map(([flag, field]): [string, (o: CliOptions, raw: string) => void] => [
    flag,
    (o, raw) => { o.overrides[field] = Number(raw); },
  ]),
]);

const SWITCH_FLAGS = new Map<string, (opts: CliOptions) => void>([
  ["--no-charts", (o) => { o.charts = false; }],
  ["--no-bars", (o) => { o.bars = false; }],
]);

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    scenario: "coffee",
    overrides: {},
    sweepValues: null,
    outputDir: path.join(process.cwd(), "sim-result", "v3.4"),
    charts: true,
    bars: true,
  };
  for (let i = 0; i < argv.length; i++) {
    // 同时接受 --key=value 与 --key value
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq >= 0 ? token.slice(0, eq) : token;

    const toggle = SWITCH_FLAGS.get(flag);
    if (toggle) {
      toggle(opts);
      continue;
    }
    const handler = VALUE_FLAGS.get(flag);
    if (!handler) continue;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    handler(opts, inline ?? argv[++i]);
  }
  return opts;
}

function getScenario(name: string): Scenario {
  if (Object.prototype.hasOwnProperty.call(SCENARIOS, name)) {
    return SCENARIOS[name as ScenarioKey];
  }
  throw new Error(`Unknown scenario: ${name}`);
}

function snapshotOf(
  mgr: WorldbookManager,
  entry: WorldbookEntry,
  round: Round,
  params: DmaeParams,
): EntrySnapshot {
  const st = mgr.getState(entry.id);
  const activation = st?.activation ?? 0;
  return {
    entryId: entry.id,
    intrinsicValue: entry.intrinsicValue,
    priority: entry.priority,
    activation,
    userSilence: st?.userSilence ?? 0,
    modelSilence: st?.modelSilence ?? 0,
    state: deriveState(activation, params.promptThreshold),
    userHit: entry.keywords.some((kw: string) => round.userText.includes(kw)),
    modelHit: entry.keywords.some((kw: string) => round.modelText.includes(kw)),
    recentUserHits: st?.recentUserHits ?? [],
  };
}

function runScenario(scenario: Scenario, params: DmaeParams): SimResult {
  // 通过公开接口 loadFromEntries 注入条目，不做反射
  const mgr = new WorldbookManager("", { params, debug: false });
  mgr.loadFromEntries(scenario.buildEntries());

  const rounds = scenario.buildRounds();
  const entries = mgr.getEntries();
  const snapshots: EntrySnapshot[][] = rounds.map((round, turn) => {
    mgr.updateActivation(round.userText, round.modelText, turn);
    return entries.map((e) => snapshotOf(mgr, e, round, params));
  });

  const draft = {
    scenario: scenario.name,
    params,
    entries: [...entries],
    rounds,
    snapshots,
  };
  return { ...draft, stats: computeStats(draft as SimResult) };
}

const SWEEP_TIERS = [90, 70, 45, 15];
const SWEEP_HEADER = "Bu       |  I=90 占用%  |  I=70 占用%  |  I=45 占用%  |  I=15 占用%  |  avgLife(I=45)";
const SWEEP_RULE = "---------|---------------|---------------|---------------|---------------|---------------";

function occupancyCell(result: SimResult, intrinsic: number): string {
  const hit = result.entries.find((e) => Math.abs(e.intrinsicValue - intrinsic) < 1 && !e.permanent);
  const pct = hit ? (result.stats.promptOccupancy.get(hit.id) ?? 0) * 100 : 0;
  return pct.toFixed(1).padStart(5);
}

function midTierLife(result: SimResult): string {
  const hit = result.entries.find((e) => Math.abs(e.intrinsicValue - 45) < 1 && !e.permanent);
  return hit ? (result.stats.avgActiveLife.get(hit.id) ?? 0).toFixed(2) : "-";
}

function runSweep(scenario: Scenario, base: DmaeParams, values: number[]): void {
  console.log(`\n=== Parameter Sweep: userRewardBase = [${values.join(", ")}] on ${scenario.name} ===\n`);
  console.log(SWEEP_HEADER);
  console.log(SWEEP_RULE);
  for (const v of values) {
    const result = runScenario(scenario, { ...base, userRewardBase: v });
    const cells = SWEEP_TIERS.map((I) => occupancyCell(result, I));
    const label = String(v).padStart(7);
    console.log(`${label}  |  ${cells.join("        |  ")}        |  ${midTierLife(result)}`);
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const scenario = getScenario(opts.scenario);
  const rule = "=".repeat(40);

  console.log(`\n${rule}`);
  console.log(`  DMAE v3.4 Simulator`);
  console.log(`  Scenario: ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(rule);

  const base: DmaeParams = { ...DEFAULT_DMAE_PARAMS, ...opts.overrides };
  if (opts.sweepValues) {
    runSweep(scenario, base, opts.sweepValues);
    return;
  }

  console.log(`参数: ${JSON.stringify(base, null, 2)}`);
  const result = runScenario(scenario, base);

  const csvFile = exportCsv(result, opts.outputDir);
  console.log(`\nCSV 写入: ${csvFile}`);

  printStats(result);
  if (opts.charts) renderLineCharts(result);
  if (opts.bars) renderBars(result);
}

main();
