// Skill 的 /命令解析。纯函数，不依赖 registry：只认调用方给出的已知 id，其余 / 开头的输入原样放行。

export interface SlashParseResult {
  hit: boolean;
  skillId?: string;
}

const SLASH_HEAD = /^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/;

/**
 * 判断用户输入是否形如 /skill-id 且 id 在已知列表中。
 * id 只允许小写字母、数字与短横线；语法不合或不在列表中都返回 hit:false。
 */
export function parseSlashCommand(text: string, knownSkillIds: string[]): SlashParseResult {
  const found = text.match(SLASH_HEAD);
  if (found === null) return { hit: false };
  const candidate = found[1];
  return knownSkillIds.includes(candidate)
    ? { hit: true, skillId: candidate }
    : { hit: false };
}
