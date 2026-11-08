// 场景二：四档混合（100 轮）
// 四档内在价值（90 / 70 / 45 / 15）加一个常驻条目。
// 每轮按档位权重抽一个关键词作为用户输入；约三分之一的轮次模型会复述近期提过的关键词。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

// 内联 fixture：模拟器自带，编译产物无需额外拷贝 .md
type MixRow = [string, string, boolean, string, string, string];
const MIX_ROWS: MixRow[] = [
  ["测试常驻","常驻测试, fixture_permanent",true,"100","200","fixture permanent 条目，验证旁路（始终注入，不进 DMAE）。"],
  ["流萤主角","流萤, Firefly, 萨姆, 星核猎手",false,"90","200","流萤是核心角色。原作经历不代表当前用户的共同经历。"],
  ["星核猎手同伴","卡芙卡, 银狼, 刃, 艾利欧",false,"70","150","原作人物关系。"],
  ["咖啡","咖啡, latte, 美式, espresso",false,"45","100","用户日常喜好。"],
  ["Blender","Blender, blender, 建模, 渲染",false,"45","100","用户 3D 创作工具。"],
  ["猫","猫, 小猫, 喵, 撸猫",false,"45","100","生活兴趣。"],
  ["星穹铁道","星穹铁道, 星铁, 穹, 列车",false,"45","100","用户玩的游戏。"],
  ["今天下午","今天下午, 刚才, 刚刚",false,"15","80","临时事件。"],
  ["上周电影","上周, 上次, 电影, 影院",false,"15","80","临时事件。"],
  ["天气","天气, 下雨, 出太阳, 阴天",false,"15","80","日常闲聊。"],
];
const MIX_LABELS = ["- 触发词","- 常驻","- 内在价值","- 优先级"];
const MIX_FIXTURE = MIX_ROWS.map(([title, keys, permanent, value, priority, content]) => {
  const [keywordsLabel, permanentLabel, valueLabel, priorityLabel] = MIX_LABELS;
  const lines = [`## ${title}`, `${keywordsLabel}: ${keys}`];
  if (permanent) lines.push(`${permanentLabel}: 是`);
  lines.push(`${valueLabel}: ${value}`, `${priorityLabel}: ${priority}`, "", content, "---\n");
  return lines.join("\n");
}).join("\n");

interface Tier {
  tier: string;
  I: number;
  weight: number;
  keywords: string[];
}

// 各档关键词池；"high" 档的词必须与 fixture 中 "流萤主角" 的触发词一致，否则生成的轮次无法命中
const TIERS: Tier[] = [
  { tier: "high",     I: 90, weight: 0.2, keywords: ["流萤", "Firefly", "萨姆", "星核猎手"] },
  { tier: "mid-high", I: 70, weight: 0.3, keywords: ["卡芙卡", "银狼", "刃"] },
  { tier: "mid",      I: 45, weight: 0.3, keywords: ["咖啡", "Blender", "猫", "星穹铁道"] },
  { tier: "low",      I: 15, weight: 0.2, keywords: ["今天下午", "天气", "上周"] },
];

// 线性同余伪随机数，同一 seed 可复现
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function drawTierKeyword(next: () => number): { tier: string; kw: string } {
  const roll = next();
  let cumulative = 0;
  for (const t of TIERS) {
    cumulative += t.weight;
    if (roll < cumulative) {
      return { tier: t.tier, kw: t.keywords[Math.floor(next() * t.keywords.length)] };
    }
  }
  const fallback = TIERS[TIERS.length - 1];
  return { tier: fallback.tier, kw: fallback.keywords[0] };
}

export function buildMixRounds(totalRounds: number = 100, seed: number = 42): Round[] {
  const next = lcg(seed);
  const rounds: Round[] = [];
  const recent: string[] = [];   // 最近提过的关键词（最多 8 个），供模型复述

  for (let i = 0; i < totalRounds; i++) {
    const silenceRoll = next();
    if (silenceRoll < 0.15 && i > 0) {
      rounds.push({ index: i, userText: "嗯", modelText: "", note: "silence" });
      continue;
    }
    const { tier, kw } = drawTierKeyword(next);
    let modelText = "";
    const echoRoll = next();
    if (echoRoll < 0.33 && recent.length > 0) {
      const echoed = recent[Math.floor(next() * recent.length)];
      modelText = `对，${echoed}，我同意。`;
    }
    rounds.push({
      index: i,
      userText: `聊${kw}`,
      modelText,
      note: `tier=${tier} kw=${kw}`,
    });
    recent.push(kw);
    if (recent.length > 8) recent.shift();
  }
  return rounds;
}

export const fourTierMix: Scenario = {
  name: "four-tier-mix",
  description: "100 轮：4 档 I（90/70/45/15）+ 1 permanent，验证不霸榜 / 快速归 0 / 久别复活 / model 不加分",
  buildEntries: () => parseFixtureMarkdown(MIX_FIXTURE, "mix"),
  buildRounds: () => buildMixRounds(100, 42),
};
