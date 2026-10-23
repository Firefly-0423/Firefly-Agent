/**
 * 日志标签名。输出时标签占 16 个字符的列，超长会被截断，所以名字尽量短。
 */
const TAGS = [
  "Runtime",
  "Electron",
  "BuiltinTools",
  "FsTools",
  "LifeTools",
  "TravelTools",
  "EmailTools",
  "Skills",
  "SkillTools",
  "TodoStore",
  "MCP",
  "Permission",
  "Firefly",
  "Worldbook",
  "EntityGraph",
  "RAG",
  "Reranker",
  "InboundServer",
  "Channels",
  "Feishu",
  "Wechat",
  "StickerEmbed",
  "AgUiBridge",
  "Call",
  "ASR",
] as const;

type TagName = (typeof TAGS)[number];

export const LogTag = Object.fromEntries(TAGS.map((name) => [name, name])) as { readonly [K in TagName]: K };

export type LogTagKey = keyof typeof LogTag;
