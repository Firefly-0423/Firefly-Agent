// 场景三：休眠救援（10 轮）
// 回归目标：条目处于 Dormant 时，用户再次提到它，A 值应立刻回升而不是继续下滑。
// 旧逻辑里 userHit 没有清空沉默计数，导致衰减一直压过奖励，只能等跌到 Archived 才被兜底拉起；
// 现在命中时清零沉默计数，衰减变弱，奖励主导，A 值直接回升。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const RESCUE_FIXTURE = `## 咖啡
- 触发词: 咖啡
- 内在价值: 60
- 优先级: 100

测试用。
---

## 园艺
- 触发词: 园艺
- 内在价值: 90
- 优先级: 150

对比用。
`;

// 每项为 [用户输入, 模型回复, 注释]；轮次序号由数组位置推导
// 第 1 轮咖啡首次命中，A 被抬到 floor；第 2–8 轮沉默，A 逐步衰减进入 Dormant；
// 第 9 轮用户再提咖啡，A 应回升；第 10 轮观察走势。
const RESCUE_SCRIPT: ReadonlyArray<readonly [string, string, string]> = [
  ["今天想喝咖啡", "", "首命中→floor 60"],
  ["嗯", "", "沉默"],
  ["好的", "", "沉默"],
  ["园艺怎么样", "园艺很好。", "沉默 coffee"],
  ["嗯", "", "沉默"],
  ["天气不错", "是呢。", "沉默"],
  ["嗯", "", "沉默"],
  ["好吧", "", "沉默——coffee 应已 Dormant"],
  ["还是想喝咖啡", "", "★ 救援点：A 必须回升"],
  ["嗯", "", "观察趋势"],
];

const RESCUE_ROUNDS: Round[] = RESCUE_SCRIPT.map(([userText, modelText, note], index) => ({
  index,
  userText,
  modelText,
  note,
}));

export const dormantRescue: Scenario = {
  name: "dormant-rescue",
  description: "10 轮：Dormant 救援测试——R9 user 再提时 A 必须回升（验证 ms 重置修复）",
  buildEntries: () => parseFixtureMarkdown(RESCUE_FIXTURE, "rescue"),
  buildRounds: () => RESCUE_ROUNDS,
};
