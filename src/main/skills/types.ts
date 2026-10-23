// Skill 子系统的共享类型。id 即目录名（kebab-case），是对外唯一标识；name 只用于展示。

import type { ToolEffectKind } from "../orchestrator/tools/registry/tool-registry";

/** 会话模式：chat 不提供任何 skill。 */
export type SkillMode = "work" | "code";

/** 按 skillId 记录的逐模式可见性覆盖。 */
export type SkillModeOverrides = {
  [skillId: string]: { [M in SkillMode]?: boolean };
};

export interface SkillManifest {
  id: string;
  entry: string;
  version: string;
  dependencies: string[];
  defaultEnabled: boolean;
  autoInject?: boolean;
  autoPlayPolicy?: string;
  /** 快捷路径命中时的执行方式。 */
  defaultExecutionMode?: "direct" | "plan";
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  dirPath: string;
  bodyPath: string;
  source: "builtin" | "user";
  enabled: boolean;
  references: string[];
  version?: string;
  tools?: string[];
  manifest?: SkillManifest;
  /** 缺省按 unknown 处理，不会借此获得任何工具权限。 */
  effectKind?: ToolEffectKind;
  /** 缺省表示 work/code 两种模式都可用；覆盖层优先于此字段。 */
  modes?: SkillMode[];
  /** 为 true 则设置面板不展示（如系统级语气校准 skill）。 */
  hiddenFromUi?: boolean;
  /** 外部宿主核验后的元数据；仅有此字段并不代表可以读取正文。 */
  external?: { reason?: string; status: "ready" | "reimport-required" };
}

/** frontmatter 解析结果；body 是剥离 frontmatter 后剩下的正文。 */
export interface ParsedSkill
  extends Pick<SkillEntry, "tools" | "version" | "effectKind" | "modes" | "hiddenFromUi"> {
  body: string;
  description: string;
  name: string;
}
