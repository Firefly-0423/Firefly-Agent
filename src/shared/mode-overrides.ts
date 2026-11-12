import type { ConversationMode } from "./chat-types";

/** 按工具 id 记录的逐模式启用覆盖。 */
export type ToolModeOverrides = Record<string, Partial<Record<ConversationMode, boolean>>>;

/** 提供 skill 的会话模式：chat 不提供任何 skill。 */
export type SkillMode = "work" | "code";

/** 按 skillId 记录的逐模式可见性覆盖。 */
export type SkillModeOverrides = {
  [skillId: string]: { [M in SkillMode]?: boolean };
};
