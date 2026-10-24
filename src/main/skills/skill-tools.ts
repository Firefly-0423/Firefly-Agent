// 向 LLM 暴露 Skill 系统的两个元工具（不是每个 skill 各注册一个业务工具）：
//   invoke_skill：返回 skill 的 SKILL.md 正文与 references 清单
//   read_skill_reference：按需分页读取 references 或正文续页，并阻止同一轮内的重复读取
// 两个工具注册到现有 toolRegistry，两条 LLM 路径都从 registry 取用。

import { toolRegistry, type ToolEffectKind } from "../orchestrator/tools/registry/tool-registry";
import { skillRegistry } from "./skill-registry";
import { logger, LogTag } from "../logging/logger";
import { getToolRunScope, type ToolContext } from "../orchestrator/tools/registry/tool-context";

const TAG = "[SkillTools]";

// 工具返回值会一直留在对话里。单篇正文过大（xlsx、skill-creator、docx 的 openxml 参考）会拖垮单轮时限，
// 所以这里自己做分页截断。
const BODY_PAGE_CHARS = 6000;
const REF_PAGE_CHARS = 8000;

/** 当前运行是否允许使用某个 skill；没有快照时视为全部允许。 */
export function isSkillAllowedForRun(id: string, allowedSkillIds?: ReadonlySet<string>): boolean {
  if (!allowedSkillIds) return true;
  return allowedSkillIds.has(id);
}

/** 超长文本截到上限，并在末尾附上续读提示。前部通常是路由表和关键规则，所以保留开头。 */
function clipForContext(text: string, limit: number, hint: string): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  return `${head}\n\n[...正文过长已截断，仅显示前 ${limit} 字符。${hint}...]`;
}

/**
 * 每次运行各自的已读记录，以原始 ToolContext 的身份为键。
 * 调度器产生的逐调用副本共享同一个 scope；字符串形式的 runId 不能换来共享身份。
 */
let readLedger = new WeakMap<object, Set<string>>();

/** 清空已读记录。仅供隔离的调用方和测试使用。 */
export function resetReadRefs(): void {
  readLedger = new WeakMap();
}

/** 附加在 invoke_skill 结果末尾的执行纪律：够用即停，不重复读取，不做无目的的遍历。 */
const DISCIPLINE_FOOTER = [
  "",
  "",
  "---",
  "【执行纪律 — 必须遵守】",
  "1. 只读完成任务所需的最少 reference，读到能执行就立即开始，不要把所有文档都读一遍。",
  "2. 同一 reference 文件不要重复读取（系统会拦截重复读取）。",
  "3. 不要用 list_dir 遍历 templates/scripts 目录——模板和脚本路径上文已给出，直接用。",
  "4. 信息足够后立即用其他工具执行产出，不要继续研究。",
  "5. 若预计轮数紧张，优先输出可交付版本而非继续优化格式。",
].join("\n");

const INVOKE_DESCRIPTION = [
  "加载某个 skill 的详细执行指令。当你判断当前任务适用某 skill 时（见系统提示里的「可用 Skill」清单），调用此工具获取该 skill 的完整指令，再按指令用其他工具执行。",
  "",
  "何时用：系统提示的「可用 Skill」清单里某条 description 适用于当前任务。",
  "",
  "不要用于：清单里没有的 skill id。",
  "",
  "参数：skill_id（必填，skill 的 id，见清单里的标识）。",
  "",
  "返回：该 skill 的指令正文 + 可用的 references 文件清单。若正文引用了 references/xxx，需要详情时再用 read_skill_reference 读取。",
].join("\n");

const READ_DESCRIPTION = [
  "读取某 skill 的 references 附件内容。当 invoke_skill 返回的正文引用了 references/xxx 且你需要详情时调用。",
  "",
  "何时用：invoke_skill 返回的正文提到 references/xxx 且需要该附件的详细内容。",
  "",
  "不要用于：不在 invoke_skill 返回清单里的 ref。",
  "",
  "参数：skill_id（必填），ref（必填）；默认读取清单中的 reference。source=body 且 ref=SKILL.md 时续读该 Skill 正文。offset 为字符偏移，默认 0，每次最多 8000 字符。",
].join("\n");

function availableOrNone(): string {
  return skillRegistry.getEnabled().map((s) => s.id).join(", ") || "(无)";
}

function invokeEffect(args: Record<string, unknown>): ToolEffectKind {
  const id = String(args.skill_id || "");
  const found = skillRegistry.getById(id);
  if (!found) return "unknown";
  // 没有声明时只是 unknown 元数据，真正的工具权限仍由各自的检查决定。
  return found.effectKind ?? "unknown";
}

function readEffect(args: Record<string, unknown>): ToolEffectKind {
  if (args.source !== "body") return "read";
  const id = String(args.skill_id || "");
  return skillRegistry.getById(id)?.effectKind ?? "unknown";
}

// 参数说明会原样序列化后发给模型，所以属性顺序和每个属性内的键顺序保持固定。
const textParam = (description: string) => ({ type: "string" as const, description });

const INVOKE_SCHEMA = {
  type: "object" as const,
  properties: { skill_id: textParam("skill 的 id（见「可用 Skill」清单）") },
  required: ["skill_id"],
};

const READ_SCHEMA = {
  type: "object" as const,
  properties: {
    skill_id: textParam("skill 的 id"),
    ref: textParam("references 文件名（必须命中 invoke_skill 返回的清单）"),
    source: { type: "string" as const, enum: ["reference", "body"], description: "默认 reference；body 只允许 ref=SKILL.md" },
    offset: { type: "number" as const, description: "非负整数字符偏移，默认 0" },
  },
  required: ["skill_id", "ref"],
};

async function runInvoke(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const id = String(args.skill_id || "");
  if (!isSkillAllowedForRun(id, ctx?.allowedSkillIds)) {
    return `[invoke_skill] E_SKILL_UNAVAILABLE_IN_MODE: ${id}`;
  }
  const found = skillRegistry.getById(id);
  if (!found || !found.enabled || !skillRegistry.isAvailable(id)) {
    return `[invoke_skill] skill not found: ${id}。可用 skill: ${availableOrNone()}`;
  }
  const text = skillRegistry.getBody(id);
  if (text === null) {
    return `[invoke_skill] 读取 skill 正文失败: ${id}`;
  }
  let refBlock = "";
  if (found.references.length) {
    const lines = found.references.map((r) => `- ${r}`).join("\n");
    refBlock = `\n\n可用 references（需要详情时调 read_skill_reference 读取）：\n${lines}`;
  }
  console.log(TAG, "invoke_skill:", id, `bodyLen=${text.length}`);
  const nextCall = `read_skill_reference({skill_id: ${JSON.stringify(id)}, source: "body", ref: "SKILL.md", offset: ${BODY_PAGE_CHARS}})`;
  const clipped = clipForContext(text, BODY_PAGE_CHARS, `继续正文请调用 ${nextCall}`);
  return `[已加载 skill: ${id}]\nSkill 本地目录（仅用于定位资源，不授权执行）：${found.dirPath}\n${clipped}${refBlock}${DISCIPLINE_FOOTER}`;
}

/** 取得本次运行专属的已读集合；没有可信上下文时只给一份临时集合。 */
function seenSetFor(ctx?: ToolContext): Set<string> {
  const scope = ctx ? getToolRunScope(ctx) : undefined;
  if (!scope) return new Set<string>();
  const existing = readLedger.get(scope);
  if (existing) return existing;
  const fresh = new Set<string>();
  readLedger.set(scope, fresh);
  return fresh;
}

function validReadArgs(source: unknown, offset: unknown, ref: string): boolean {
  if (source !== "reference" && source !== "body") return false;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return false;
  return source !== "body" || ref === "SKILL.md";
}

async function runRead(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const id = String(args.skill_id || "");
  const ref = String(args.ref || "");
  if (!isSkillAllowedForRun(id, ctx?.allowedSkillIds)) {
    return `[read_skill_reference] E_SKILL_UNAVAILABLE_IN_MODE: ${id}`;
  }
  const found = skillRegistry.getById(id);
  if (!found || !found.enabled || !skillRegistry.isAvailable(id)) {
    return `[read_skill_reference] skill not found: ${id}`;
  }

  const source = args.source ?? "reference";
  const offset = args.offset ?? 0;
  if (!validReadArgs(source, offset, ref)) return "[read_skill_reference] E_SKILL_READ_ARGUMENT";
  const start = offset as number;

  const seen = seenSetFor(ctx);
  const key = [id, source, ref, start].join("/");
  if (seen.has(key)) {
    const unread = found.references.filter((r) => !seen.has(`${id}/reference/${r}/0`)).join(", ");
    return `[read_skill_reference] "${ref}" 已在本轮读过，内容已在对话中，不要重复读取。`
      + `如需其他文件，可读：${unread || "(全部已读)"}`;
  }

  const content = source === "body" ? skillRegistry.getBody(id) : skillRegistry.getReference(id, ref);
  if (content === null) {
    return `[read_skill_reference] 读取失败（ref 不在清单或文件不存在）: ${ref}。可用: ${found.references.join(", ") || "(无)"}`;
  }
  if (start > 0 && start >= content.length) return "[read_skill_reference] E_SKILL_READ_ARGUMENT";

  seen.add(key);
  console.log(TAG, "read_skill_reference:", id, ref, `len=${content.length}`);
  const end = start + REF_PAGE_CHARS;
  const page = content.slice(start, end);
  if (end >= content.length) return page;
  const call = `read_skill_reference({skill_id: ${JSON.stringify(id)}, source: ${JSON.stringify(source)}, ref: ${JSON.stringify(ref)}, offset: ${end}})`;
  return `${page}

[继续请调用 ${call}]`;
}

/** 注册两个元工具。启动阶段调用一次；它们只读本地 skill 文件，因此标记为 safe。 */
export function registerSkillTools(): void {
  toolRegistry.register({
    id: "invoke_skill",
    name: "调用 Skill",
    description: INVOKE_DESCRIPTION,
    enabled: true,
    risk: "safe",
    effectKind: "read" as const,
    effectResolver: invokeEffect,
    inputSchema: INVOKE_SCHEMA,
    needsContext: true,
    execute: runInvoke,
  });

  toolRegistry.register({
    id: "read_skill_reference",
    name: "读取 Skill 附件",
    description: READ_DESCRIPTION,
    enabled: true,
    risk: "safe",
    effectKind: "read" as const,
    effectResolver: readEffect,
    verificationPolicy: "none" as const,
    inputSchema: READ_SCHEMA,
    needsContext: true,
    execute: runRead,
  });

  logger.info(LogTag.SkillTools, "registered: invoke_skill / read_skill_reference");
}
