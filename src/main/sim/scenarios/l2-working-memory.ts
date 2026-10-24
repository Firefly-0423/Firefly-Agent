// L2 工作记忆场景（直接面向 L2Memory，用关键词重叠模拟向量召回的 top-4 作为 userHit）
// 关注点：
//   - 首轮召回的四条应被唤醒并进入 active；
//   - 连续沉默数轮后，末位的条目先归档；
//   - 位次靠前的条目随后也会归档；
//   - 已归档条目被再次召回时，应被 wake-up 拉回阈值附近。
import type { Round } from "../sim-types";

export interface L2Fixture {
  id: string;
  content: string;
  triggerText: string;
  keywords: string[];
}

export const L2_FIXTURES: L2Fixture[] = [
  {
    id: "l2_coffee",
    content: "用户每天早上都要喝咖啡",
    triggerText: "我每天早上都要喝咖啡",
    keywords: ["咖啡", "早上", "喝"],
  },
  {
    id: "l2_cat",
    content: "用户养了一只叫咪咪的猫",
    triggerText: "我养了只猫叫咪咪",
    keywords: ["猫", "咪咪"],
  },
  {
    id: "l2_run",
    content: "用户习惯周末去公园跑步",
    triggerText: "我周末去公园跑步",
    keywords: ["跑步", "公园", "周末"],
  },
  {
    id: "l2_music",
    content: "用户最近沉迷爵士乐",
    triggerText: "我最近很喜欢爵士乐",
    keywords: ["爵士", "音乐"],
  },
  {
    id: "l2_rain",
    content: "用户喜欢下雨天待在家里",
    triggerText: "我喜欢下雨天待在家",
    keywords: ["下雨", "家"],
  },
];

// 每项为 [用户输入, 模型回复]；轮次序号由数组位置推导
const L2_SCRIPT: ReadonlyArray<readonly [string, string]> = [
  // 第 1 轮：提到咖啡与猫、跑步，召回 top-4（coffee、cat、run、music）
  ["早上好，我刚喝完咖啡，准备带咪咪去公园跑步", "今天也是活力满满的一天呢，爵士乐还要听吗？"],
  // 第 2 轮：仍围绕 top-4 展开
  ["对，跑步时我一般听爵士", "爵士配跑步，节奏刚好。"],
  // 第 3 轮：继续命中，衰减开始累积
  ["咪咪也很喜欢公园", "猫咪的确喜欢户外。"],
  // 第 4 轮：话题转走，四条进入纯衰减
  ["今天工作好忙", "加油呀。"],
  // 第 5 轮：继续沉默
  ["午饭吃什么好呢", "想吃什么呢？"],
  // 第 6 轮：召回 rain，此前的 music 应已归档，观察 wake-up
  ["今天下雨了， rain 场景被召回", "下雨天适合在家。"],
  // 第 7–10 轮：持续沉默，观察衰减曲线
  ["嗯", ""],
  ["哦", ""],
  ["行", ""],
  ["好", ""],
];

export const L2_ROUNDS: Round[] = L2_SCRIPT.map(([userText, modelText], index) => ({
  index,
  userText,
  modelText,
}));
