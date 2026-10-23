import { searchMemory } from "../../../rag/index";
import type { ToolRiskLevel } from "../../../permission";
import type { ToolContext } from "./tool-context";
import type { ConversationMode } from "../../../../shared/chat-types";

export type ToolEffectKind = "read" | "mutation" | "verification" | "external_side_effect" | "unknown";
export type VerificationPolicy = "none" | "artifact" | "code" | "unknown";
export type ToolEffectResolver = (input: Record<string, unknown>) => ToolEffectKind;
export type ToolConcurrencyClassifier = (input: Record<string, unknown>) => boolean;
export type VerificationPolicyResolver = (input: Record<string, unknown>) => VerificationPolicy;

export type JsonSchemaProp =
  | { description?: string; type: string; default?: unknown; enum?: string[]; askAliases?: Record<string, unknown> }
  | { items: JsonSchemaProp; type: "array"; description?: string; default?: unknown; askAliases?: Record<string, unknown> }
  | { properties: Record<string, JsonSchemaProp>; type: "object"; required?: string[]; description?: string; default?: unknown; askAliases?: Record<string, unknown> };

export type ControlledInputPolicy = "context_ref" | "context_ref_array" | "tool_result"
  | { kind: string; type: "context_ref" } | { kind: string; type: "context_ref_array" } | { type: "tool_result" };

export function controlledInputType(restriction: ControlledInputPolicy): string {
  if (typeof restriction === "string") return restriction;
  return restriction.type;
}

export function controlledInputKind(restriction: ControlledInputPolicy): string | undefined {
  if (typeof restriction === "object" && "kind" in restriction) return restriction.kind;
  return undefined;
}

// 模型协议字段与 Runtime 策略共用定义，执行许可仍由调度层决定。
export interface ToolDefinition {
  id: string;
  description: string;
  name: string;
  enabled: boolean;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
  inputSchema: { required?: string[]; type: "object"; properties: Record<string, JsonSchemaProp> };
  catalogHint?: string;
  category?: string;
  capability?: string;
  controlledInput?: Record<string, ControlledInputPolicy>;
  modes?: ConversationMode[];
  risk?: ToolRiskLevel;
  chatBuiltin?: boolean;
  needsContext?: boolean;
  ledgerPolicy?: "success_terminal" | "bypass";
  deprecated?: boolean;
  isConcurrencySafe?: ToolConcurrencyClassifier;
  effectKind?: ToolEffectKind;
  effectResolver?: ToolEffectResolver;
  verificationPolicyResolver?: VerificationPolicyResolver;
  verificationPolicy?: VerificationPolicy;
}

export type ToolModeOverrides = Record<string, Partial<Record<ConversationMode, boolean>>>;

const retiredMemoryIds = new Set(["user_memory", "read_memory", "write_memory", "recall_history"]);

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private memoryBackend: "legacy" | "smh";

  constructor(configuration: { personalMemoryMode?: "legacy" | "smh" } = {}) {
    this.memoryBackend = configuration.personalMemoryMode ?? "legacy";
  }

  setPersonalMemoryMode(backend: "legacy" | "smh"): void { this.memoryBackend = backend; }

  private memoryIsRetired(toolId: string): boolean {
    return this.memoryBackend === "smh" && retiredMemoryIds.has(toolId);
  }

  register(definition: ToolDefinition): void {
    if (!retiredMemoryIds.has(definition.id)) {
      this.definitions.set(definition.id, definition);
      return;
    }
    const toolId = definition.id;
    const implementation = definition.execute;
    this.definitions.set(definition.id, {
      ...definition,
      execute: async (input, runContext) => {
        if (this.memoryIsRetired(toolId)) return "MEMORY_LEGACY_RETIRED";
        return implementation(input, runContext);
      },
    });
  }

  unregister(toolId: string): boolean { return this.definitions.delete(toolId); }

  setEnabled(toolId: string, active: boolean): void {
    const definition = this.definitions.get(toolId);
    if (definition) definition.enabled = active;
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.definitions.values()).filter(definition =>
      definition.enabled && !definition.deprecated && !this.memoryIsRetired(definition.id));
  }

  getEnabledToolsForMode(selected: ConversationMode, custom?: ToolModeOverrides): ToolDefinition[] {
    return Array.from(this.definitions.values()).filter(definition => {
      if (!definition.enabled || definition.deprecated || this.memoryIsRetired(definition.id)) return false;
      const chosen = custom?.[definition.id]?.[selected];
      if (chosen !== undefined) return chosen;
      return !definition.modes || definition.modes.includes(selected);
    });
  }

  getAllTools(): ToolDefinition[] { return Array.from(this.definitions.values()); }
  getById(toolId: string): ToolDefinition | undefined { return this.definitions.get(toolId); }
}

export const toolRegistry = new ToolRegistry();

export function resolveEffectKind(
  definition: ToolDefinition | undefined, input: Record<string, unknown>,
): ToolEffectKind {
  if (!definition) return "unknown";
  return definition.effectResolver ? definition.effectResolver(input) : definition.effectKind ?? "unknown";
}

export function resolveVerificationPolicy(
  definition: ToolDefinition | undefined, input: Record<string, unknown>,
): VerificationPolicy {
  if (!definition) return "none";
  return definition.verificationPolicyResolver
    ? definition.verificationPolicyResolver(input) : definition.verificationPolicy ?? "none";
}

function retrievedText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const entry = payload as { text?: unknown; entry?: { text?: unknown } };
  if (typeof entry.entry?.text === "string") return entry.entry.text;
  return typeof entry.text === "string" ? entry.text : "";
}

toolRegistry.register({
  "id": "imported_docs",
  "name": "导入文档",
  "description": "在用户上传导入的文档/小说/文件范围内做语义检索，返回相关片段。\n\n何时用：\n- 用户提到「文件」「文档」「小说」，或消息包含「已上传文件」标记\n- 用户问的内容可能在导入的文档里\n- 用户要「在文档里找 xxx」「小说里有没有写到 yyy」\n\n不要用于：\n- 本机任意路径的文件（那是 read_file）\n- 用户的历史对话记忆（那是 user_memory）\n- 联网信息（那是 web_search）\n\n参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。",
  "enabled": true,
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜索关键词"
      },
      "topK": {
        "type": "number",
        "description": "返回条数，默认5"
      }
    },
    "required": [
      "query"
    ]
  },
  execute: async (input) => {
    const matches = await searchMemory(String(input.query), "imported_doc", Number(input.topK) || 5);
    return matches.map((entry: unknown) => String(entry)).join("\n");
  },
});
toolRegistry.register({
  "id": "user_memory",
  "name": "用户记忆",
  "description": "查询用户的历史记忆、个人信息、过往对话中提到的事实。\n\n何时用：\n- 用户说「你还记得」「我之前说过」「以前」「上次」等指代词\n- 用户问自己的偏好/习惯/背景（「我喜欢什么」「我是做什么的」）\n- 需要确认用户曾经提过的具体信息\n\n不要用于：\n- 当前对话最近几轮能看到的内容\n- 导入文档内容（那是 imported_docs）\n- 用户从没提过的信息（查不到就老实说不知道）\n\n参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。",
  "enabled": true,
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜索关键词"
      },
      "topK": {
        "type": "number",
        "description": "返回条数，默认5"
      }
    },
    "required": [
      "query"
    ]
  },
  execute: async (input) => {
    const matches = await searchMemory(String(input.query), "user_memory", Number(input.topK) || 5);
    return matches.map(retrievedText).filter(Boolean).join("\n");
  },
});

type L2OverviewItem = { status: string; createdAt: number; title: string; id: string };

function profileRows(profile: Record<string, unknown>, columns: [string, string][]): string[] {
  const rows: string[] = [];
  for (const [name, label] of columns) {
    const content = String(profile[name] ?? "").trim();
    if (content) rows.push(`- ${label}: ${content}`);
  }
  if (!rows.length) rows.push("- （空）");
  return rows;
}

export function formatMemoryOverview(
  core: Record<string, unknown>, recent: Record<string, unknown>, memories: L2OverviewItem[],
): string {
  const overview = ["== 核心画像（L0）=="];
  overview.push(...profileRows(core, [
    ["preferredName", "称呼"], ["occupation", "职业"], ["longTermInterests", "长期兴趣"],
    ["language", "语言习惯"], ["permanentNote", "固定备注"],
  ]));
  if (core.isPinned === true) overview.push("（画像已被用户锁定，工具写入会被跳过）");
  overview.push("", "== 近期状态（L1）==");
  overview.push(...profileRows(recent, [
    ["recentGoals", "近期目标"], ["recentPreferences", "近期偏好"], ["currentProject", "当前项目"],
  ]));
  const size = memories.length;
  overview.push("", `== 对话记忆（L2，共 ${size} 条，列出最新 ${Math.min(size, 50)} 条）==`);
  if (size === 0) overview.push("- （空）");
  else {
    const newest = [...memories].sort((left, right) => right.createdAt - left.createdAt).slice(0, 50);
    for (const memory of newest) {
      const day = new Date(memory.createdAt).toISOString().slice(0, 10);
      overview.push(`- [${memory.id}] ${memory.title} · ${memory.status} · ${day}`);
    }
  }
  overview.push("", "带 id 参数可读取单条 L2 全文。");
  return overview.join("\n");
}

export function buildWriteCandidate(request: {
  layer: string; content: string; field?: string; slug?: string; sourceQuote?: string; triggerText: string;
}): {
  layer: "L0" | "L1" | "L2"; content: string; field?: string; slug?: string; sourceQuote?: string;
  confidence: number; certainty: "explicit"; attribution: "user_explicit"; shouldWrite: true; triggerText: string;
} | null {
  const destination = request.layer.toUpperCase();
  if (destination !== "L0" && destination !== "L1" && destination !== "L2") return null;
  if (!request.content.trim()) return null;
  return {
    layer: destination,
    content: request.content.trim(),
    field: request.field?.trim() || undefined,
    slug: destination === "L2" ? request.slug?.trim() || undefined : undefined,
    sourceQuote: destination === "L2" ? request.sourceQuote?.trim() || undefined : undefined,
    confidence: 1, certainty: "explicit", attribution: "user_explicit", shouldWrite: true,
    triggerText: request.triggerText,
  };
}

toolRegistry.register({
  "id": "read_memory",
  "name": "通读记忆",
  "description": "完整读取自己的三层记忆（核心画像 L0 / 近期状态 L1 / 对话记忆 L2），直接读存储、不走语义检索。\n\n何时用：\n- 用户说「你到底记得我什么」「看看你的记忆」「你都记了些啥」\n- user_memory 检索没命中但用户坚称说过（检索是抽查，这个是通读）\n- 需要核对记忆内容是否准确/过时（用户说「你记错了」）\n\n不要用于：\n- 语义模糊的主题查询（「我喜欢的颜色」→ 用 user_memory 更省 token）\n- 导入文档内容（那是 imported_docs）\n\n参数：无参 = 概览（L0/L1 全量 + L2 目录最新 50 条）；id (可选，L2 条目 id) = 读该条全文。",
  "enabled": true,
  "effectKind": "read",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "L2 条目 id（来自概览列表），传入则读该条全文"
      }
    }
  },
  execute: async (input) => {
    const { memoryStore: storage } = require("../../../memory/memory-store") as typeof import("../../../memory/memory-store");
    const requestedId = String(input.id || "").trim();
    if (requestedId) {
      const collection = await storage.getAllL2();
      const memory = collection.find(entry => entry.id === requestedId);
      if (!memory) return `[错误] 找不到 L2 条目: ${requestedId}（先无参调用拿概览列表）`;
      const detail = [
        `id: ${memory.id}`, `标题: ${memory.slug || "（无）"}`, `内容: ${memory.content}`,
      ];
      if (memory.sourceQuote) detail.push(`用户原话: ${memory.sourceQuote}`);
      detail.push(
        `状态: ${memory.status}${memory.isPinned ? " · 已置顶" : ""}`,
        `创建: ${new Date(memory.createdAt).toISOString().slice(0, 10)} · 最近使用: ${new Date(memory.lastAccessedAt).toISOString().slice(0, 10)} · 使用 ${memory.accessCount} 次`,
      );
      return detail.join("\n");
    }
    const [core, recent, collection] = await Promise.all([storage.getL0(), storage.getL1(), storage.getAllL2()]);
    const directory: L2OverviewItem[] = collection.map(memory => ({
      id: memory.id,
      title: memory.slug || (memory.content.length > 40 ? memory.content.slice(0, 40) + "…" : memory.content),
      createdAt: memory.createdAt, status: memory.status,
    }));
    return formatMemoryOverview(core as unknown as Record<string, unknown>, recent as unknown as Record<string, unknown>, directory);
  },
});

toolRegistry.register({
  "id": "write_memory",
  "name": "更新记忆",
  "description": "把用户明确要求记住的信息写入记忆（L0 核心画像 / L1 近期状态 / L2 对话记忆）。\n\n何时用（仅限用户主动要求）：\n- 用户说「记住……」「更新你的记忆」「把这个记下来」「别忘了……」\n- 用户纠正旧记忆：「不是 X，是 Y」\n\n不要用于：\n- 普通对话中自行判断值得记的信息（那是后台反思系统的事，不要主动调用本工具）\n- 当前对话里临时记的东西（对话上下文本身就是记忆）\n\n参数：layer (必填，L0/L1/L2)，content (必填，要记住的内容)；\nfield (L0 可选：preferredName/occupation/longTermInterests/language/permanentNote；L1 可选：recentGoals/recentPreferences/currentProject，缺省按内容自动分流)；\nslug (L2 可选，≤20 字标题)，sourceQuote (L2 可选，用户原话)。",
  "enabled": true,
  "effectKind": "mutation",
  "verificationPolicy": "none",
  "inputSchema": {
    "type": "object",
    "properties": {
      "layer": {
        "type": "string",
        "description": "目标层级：L0（核心画像）/ L1（近期状态）/ L2（对话记忆）"
      },
      "content": {
        "type": "string",
        "description": "要写入的内容"
      },
      "field": {
        "type": "string",
        "description": "L0/L1 目标字段（可选，缺省自动判定）"
      },
      "slug": {
        "type": "string",
        "description": "L2 标题（可选，≤20 字）"
      },
      "sourceQuote": {
        "type": "string",
        "description": "L2 用户原话（可选）"
      }
    },
    "required": [
      "layer",
      "content"
    ]
  },
  execute: async (input, runContext) => {
    const proposed = buildWriteCandidate({
      layer: String(input.layer || ""), content: String(input.content || ""),
      field: input.field ? String(input.field) : undefined,
      slug: input.slug ? String(input.slug) : undefined,
      sourceQuote: input.sourceQuote ? String(input.sourceQuote) : undefined,
      triggerText: runContext?.userQuery || String(input.content).slice(0, 50),
    });
    if (!proposed) return "[错误] 参数无效：layer 必须是 L0/L1/L2，content 不能为空";
    const { memoryManager: writer } = require("../../../memory/memory-manager") as typeof import("../../../memory/memory-manager");
    const { memoryStore: storage } = require("../../../memory/memory-store") as typeof import("../../../memory/memory-store");
    if (proposed.layer === "L0") {
      const profile = await storage.getL0();
      if (profile.isPinned) return "[跳过] 核心画像已被用户锁定（记忆面板里可解锁），本次未写入";
    }
    await writer.writeMemory([proposed]);
    return `已写入 ${proposed.layer}${proposed.field ? `（字段 ${proposed.field}）` : ""}: ${proposed.content.slice(0, 60)}${proposed.content.length > 60 ? "…" : ""}`;
  },
});
