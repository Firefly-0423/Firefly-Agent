// 注入 system prompt 的 Skill 清单与自动激活段落。纯函数，不读取 registry 或文件系统。

import type { SkillEntry } from "./types";

// 清单头采用流程式表述：先逐项做语义匹配，再决定是否调用基础工具。
// 匹配依据是能力是否适用于当前任务，而不是关键词是否重合。
const SELECTION_PREAMBLE = `## Skill 选择
以下 Skill 均为用户当前明确启用的能力。

在选择基础工具或直接回复用户之前，必须先执行 Skill 匹配判断：

1. 逐项检查下方 Skill 的 description。
2. 判断该 Skill 描述的能力是否适用于完成当前用户任务。
3. 如果一个或多个 Skill 适用，必须先调用 invoke_skill(skill_id) 加载对应完整规则，再继续任务。
4. 不要仅因为你自己已经知道如何完成任务，就跳过适用的 Skill。
5. 如果没有任何 Skill 适用，则正常使用基础工具或直接回复。

Skill 清单：`;

const AUTO_INJECT_PREAMBLE = [
  "## 自动激活 Skill 指令",
  "以下 Skill 已通过能力门控，当前对话必须直接遵循其完整规则，无需再次调用 invoke_skill。",
  "",
];

const SOUL_REPLY_PREAMBLE = [
  "## 自动激活 Skill 回复策略",
  "以下内容只约束自然语言回复；当前阶段没有工具能力，不得输出工具名、调用标记或工具协议。",
  "",
];

const SOUL_SECTION_PATTERN = /^## Soul 回复策略\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m;

const isAutoInjected = (skill: SkillEntry): boolean => skill.enabled && skill.manifest?.autoInject === true;

/** 生成 system prompt 中的 Skill 清单段；没有启用项时返回空串。 */
export function buildSkillCatalog(skills: SkillEntry[]): string {
  const active = skills.filter((skill) => skill.enabled);
  if (!active.length) return "";
  const rows = active.map((skill) => {
    const toolTag = skill.tools?.length ? ` [tools: ${skill.tools.join(", ")}]` : "";
    const autoTag = skill.manifest?.autoInject === true ? " [自动注入：无需再次调用 invoke_skill]" : "";
    return `- ${skill.id}: ${skill.description}${toolTag}${autoTag}`;
  });
  return [SELECTION_PREAMBLE, ...rows].join("\n");
}

type BodyReader = (id: string) => string | null;

// 逐个已自动注入的 skill 取出片段，拼成「前言 + 小节」；没有任何片段时返回空串。
function assembleInjected(
  skills: SkillEntry[],
  preamble: string[],
  pick: (skill: SkillEntry) => string | undefined,
): string {
  const parts: string[] = [];
  for (const skill of skills) {
    if (!isAutoInjected(skill)) continue;
    const piece = pick(skill);
    if (piece) parts.push(`### ${skill.id}\n${piece}`);
  }
  return parts.length ? preamble.concat(parts).join("\n") : "";
}

/** 为声明了 autoInject 的已启用 Skill 注入完整正文；读取失败的条目直接跳过。 */
export const buildAutoInjectedSkillContext = (skills: SkillEntry[], getBody: BodyReader): string =>
  assembleInjected(skills, AUTO_INJECT_PREAMBLE, (skill) => getBody(skill.id)?.trim());

/**
 * chat 模式没有工具，只取 Skill 正文中名为「Soul 回复策略」的小节。
 * 其余的工具流程不能暴露给这种模式，否则模型会把工具协议写成普通文字。
 */
export const buildAutoInjectedSoulContext = (skills: SkillEntry[], getBody: BodyReader): string =>
  assembleInjected(skills, SOUL_REPLY_PREAMBLE, (skill) =>
    SOUL_SECTION_PATTERN.exec(getBody(skill.id) ?? "")?.[1]?.trim());
