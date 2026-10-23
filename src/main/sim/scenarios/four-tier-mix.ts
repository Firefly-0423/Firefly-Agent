// 场景二：四档混合（100 轮）
// 四档内在价值（90 / 70 / 45 / 15）加一个常驻条目。
// 每轮按档位权重抽一个关键词作为用户输入；约三分之一的轮次模型会复述近期提过的关键词。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

// 内联 fixture：模拟器自带，编译产物无需额外拷贝 .md
const MIX_FIXTURE = `## 测试常驻
- 触发词: 常驻测试, fixture_permanent
- 常驻: 是
- 内在价值: 100
- 优先级: 200

fixture permanent 条目，验证旁路（始终注入，不进 DMAE）。
---

## 流萤主角
- 触发词: 流萤, Firefly, 萨姆, 星核猎手
- 内在价值: 90
- 优先级: 200

流萤是核心角色。原作经历不代表当前用户的共同经历。
---

## 星核猎手同伴
- 触发词: 卡芙卡, 银狼, 刃, 艾利欧
- 内在价值: 70
- 优先级: 150

原作人物关系。
---

## 咖啡
- 触发词: 咖啡, latte, 美式, espresso
- 内在价值: 45
- 优先级: 100

用户日常喜好。
---

## Blender
- 触发词: Blender, blender, 建模, 渲染
- 内在价值: 45
- 优先级: 100

用户 3D 创作工具。
---

## 猫
- 触发词: 猫, 小猫, 喵, 撸猫
- 内在价值: 45
- 优先级: 100

生活兴趣。
---

## 星穹铁道
- 触发词: 星穹铁道, 星铁, 穹, 列车
- 内在价值: 45
- 优先级: 100

用户玩的游戏。
---

## 今天下午
- 触发词: 今天下午, 刚才, 刚刚
- 内在价值: 15
- 优先级: 80

临时事件。
---

## 上周电影
- 触发词: 上周, 上次, 电影, 影院
- 内在价值: 15
- 优先级: 80

临时事件。
---

## 天气
- 触发词: 天气, 下雨, 出太阳, 阴天
- 内在价值: 15
- 优先级: 80

日常闲聊。
---
`;

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
