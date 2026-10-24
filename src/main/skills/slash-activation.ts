// 把最近一条 user 消息里的 /skill 命令转成 skill 正文注入，或把它替换成一段系统提示。
// 三模适配：传入 mode 与 overrides 后，只激活当前会话模式允许的 skill。
import { parseSlashCommand, skillRegistry } from "./index";
import type { SkillMode, SkillModeOverrides } from "./types";

type ChatTurn = { role: string; content: string };
type SkillRecord = ReturnType<typeof skillRegistry.getById>;

function lastUserPosition<T extends { role: string }>(messages: T[]): number {
  for (let pos = messages.length - 1; pos >= 0; pos -= 1) {
    if (messages[pos].role === "user") return pos;
  }
  return -1;
}

/** 当前模式下该 skill 是否可见：覆盖层优先，其次看 skill 自身声明的 modes。 */
function visibleInMode(skill: SkillRecord, mode: SkillMode | undefined, overrides: SkillModeOverrides | undefined): boolean {
  if (!skill) return false;
  if (mode === undefined) return true;
  const forced = overrides ? overrides[skill.id]?.[mode] : undefined;
  if (forced !== undefined) return forced;
  return !skill.modes || skill.modes.includes(mode);
}

/**
 * 解析最近的 user 消息。
 * - 命中且可用：返回以 `[已激活 skill: …]` 开头的正文片段（注入 system，用户消息不变）。
 * - 命中但不可用：把该 user 消息改写成提示，返回空串。
 * - 未命中：返回空串，不干预消息。
 */
export function resolveSlashActivation<T extends ChatTurn>(messages: T[], mode?: SkillMode, overrides?: SkillModeOverrides): string {
  const pos = lastUserPosition(messages);
  if (pos < 0) return "";
  const userMsg = messages[pos];
  if (typeof userMsg.content !== "string") return "";

  const hit = parseSlashCommand(userMsg.content, skillRegistry.getAll().map((s) => s.id));
  if (!hit.hit || !hit.skillId) return "";
  const id = hit.skillId;
  const skill = skillRegistry.getById(id);

  if (skill && skill.enabled && skillRegistry.isAvailable(id) && visibleInMode(skill, mode, overrides)) {
    const text = skillRegistry.getBody(id);
    if (text === null) return "";
    console.log("[Firefly] /命令激活 skill:", id);
    return `\n\n---\n\n[已激活 skill: ${id}]\n${text}`;
  }

  const enabledIds = skillRegistry.getEnabled().map((s) => s.id).join(", ") || "(无)";
  messages[pos] = {
    ...userMsg,
    content: `[系统提示：skill 未启用、不存在或当前模式不可用: ${id}。可用 skill: ${enabledIds}]`,
  } as T;
  return "";
}
