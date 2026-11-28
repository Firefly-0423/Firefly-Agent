// 场景一：咖啡生命周期（30 轮）
// 期望轨迹：前段提咖啡 → 长时间沉默后降到 Dormant、再到 Archived → 中段再提时复活 → 后段在中间区间震荡。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const COFFEE_FIXTURE = `## 咖啡
- 触发词: 咖啡, latte, 美式
- 内在价值: 45
- 优先级: 100

用户日常喜好，间接触发。
---

## 园艺
- 触发词: 园艺, gardening
- 内在价值: 90
- 优先级: 150

高权重中性主题，用于对比。
`;

// 每项为 [用户输入, 模型回复]；轮次序号由数组位置推导
const COFFEE_SCRIPT: ReadonlyArray<readonly [string, string]> = [
  // 起始：连续三轮聊咖啡
  ["今天想喝咖啡", "好呀，要 latte 还是美式？"],
  ["还是咖啡吧", "咖啡咖啡咖啡～"],
  ["咖啡咖啡", ""],
  // 转向园艺，咖啡处于沉默
  ["园艺最近怎么样", "园艺最近很热门。"],
  ["嗯", ""],
  ["今天天气不错", "是呢。"],
  ["嗯", ""],
  ["那好吧", ""],
  // 其他话题，咖啡持续沉默
  ["园艺", "园艺话题在呢。"],
  ["Blender 学了吗", "没呢。"],
  ["那猫呢", "猫很好。"],
  ["好吧", ""],
  // 更长的沉默
  ["嗯", ""],
  ["好的", ""],
  ["那就这样", ""],
  // 复活点：重新提到咖啡
  ["还是想喝咖啡", "好呀～"],
  // 收尾阶段：混合话题
  ["猫呢", ""],
  ["咖啡", ""],
  ["天气真好", "是呢。"],
  ["嗯", ""],
  ["园艺园艺", ""],
  ["今天下午", ""],
  ["咖啡", ""],
  ["猫猫猫", ""],
  ["嗯", ""],
  ["好", ""],
  ["Blender", ""],
  ["咖啡", ""],
  ["天气", ""],
  ["嗯", ""],
];

const COFFEE_ROUNDS: Round[] = COFFEE_SCRIPT.map(([userText, modelText], index) => ({
  index,
  userText,
  modelText,
}));

export const coffeeLifecycle: Scenario = {
  name: "coffee-lifecycle",
  description: "30 轮：单条目咖啡从触发→Dormant→Archived→复活→震荡",
  buildEntries: () => parseFixtureMarkdown(COFFEE_FIXTURE, "coffee-fixture"),
  buildRounds: () => COFFEE_ROUNDS,
};
