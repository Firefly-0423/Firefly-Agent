// 内置型号输入模态目录（只是数据，不含逻辑）。
//
// 这里只是“厂商接口没说清、或没有模型清单接口”时的回落，不是权威：
// 档案里的显式声明（厂商接口记录 / 用户覆盖）永远优先，判定入口见 multimodal.ts 的 resolveInputModalities。
//
// 规则按顺序匹配，取第一条命中的；越具体的规则越靠前。
// pattern 是正则源码，按不区分大小写编译；vendor 缺省表示任何厂商都适用（跨家族托管场景，如自定义端点）。
// 依据注释只记仓库里有据可查的型号族（capabilities.ts 的厂商备注、presets.ts 注释），
// 另加用户明确指定的家族（gpt-4o / 4.1 / 5 / 6、claude、gemini、kimi k2.5–k2.7）。

import type { InputModality } from "../../../shared/input-modalities";

export interface ModelModalityCatalogEntry {
  /** capability id（如 "minimax" / "deepseek"）；缺省 = 任何厂商。 */
  vendor?: string;
  /** 型号名正则源码。"厂商/型号"（OpenRouter 风格）按裸型号名也会匹配。 */
  pattern: string;
  /** 该型号族声明的输入模态。 */
  input: readonly InputModality[];
}

export const MODEL_MODALITY_CATALOG: readonly ModelModalityCatalogEntry[] = [
  // MiniMax：M3 原生多模态（image_url / video_url）。
  { pattern: "^MiniMax-M3(?:$|[-_])", input: ["text", "image"] },
  // DeepSeek：V4.1 Flash 原生视觉；旧名 v4-flash / v4-flash-vision-exp 为别名；v4-pro 不支持。
  { vendor: "deepseek", pattern: "^(?:deepseek-)?(?:v4-)?flash(?:$|-)", input: ["text", "image"] },
  // 智谱：视觉版 glm-5v-turbo / glm-4v 系列；默认 glm-5.x 不支持。
  { pattern: "^glm-(?:\\d+(?:\\.\\d+)?v|4v)(?:$|-)", input: ["text", "image"] },
  // Kimi：k2.7-code 支持 image_url（capabilities.ts）；k2.5 / k2.6 为用户指定家族。
  { pattern: "^kimi-k2\\.[567](?:$|[-.])", input: ["text", "image"] },
  // 通义千问：视觉版 qwen-vl 系列；默认 qwen-max 不支持。
  { pattern: "^qwen[\\w.-]*-vl(?:$|-)", input: ["text", "image"] },
  // OpenAI：gpt-4o / gpt-4.1 / gpt-5 / gpt-6 系列（用户指定）。
  { pattern: "^gpt-(?:4o|4\\.1|5|6)(?:$|[-.])", input: ["text", "image"] },
  // Claude：全系 image content block（capabilities.ts + 用户指定）。
  { pattern: "^claude-", input: ["text", "image"] },
  // Gemini：全系（用户指定）。
  { pattern: "^gemini-", input: ["text", "image"] },
  // 小米 MiMo：mimo-v2.5 为视觉模型；mimo-v2.5-pro 不适合做视觉（presets.ts 注释）。
  { pattern: "^mimo-v2\\.5(?:$|-(?!pro))", input: ["text", "image"] },
  // 名字里带视觉标记的型号（如 *-vision-exp、qwen-vl-*、qvq-*），跨厂商生效。
  { pattern: "(?:^|[-_.])(?:vision|vl)(?:$|[-_.])|^qvq(?:$|[-_.])", input: ["text", "image"] },
];
