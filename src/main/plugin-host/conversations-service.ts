import type {
  PluginConversationMessage,
  PluginConversationPage,
  PluginConversationSummary,
  PluginConversationsService,
  PluginMessagePage,
  PluginMessagePageInput,
} from "../../plugins/api";
import type { ChatMessage, ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import { pluginHostError } from "./errors";

interface PageBounds {
  defaultSize: number;
  maxSize: number;
}

const SESSION_PAGE: PageBounds = { defaultSize: 20, maxSize: 100 };
const MESSAGE_PAGE: PageBounds = { defaultSize: 50, maxSize: 100 };

/** 会话存储的只读视图：真实实现是 chats-store，测试注入内存假件。 */
export interface PluginChatsStoreReader {
  listSessions(): ChatSessionMeta[];
  getSession(id: string): ChatSession | null;
}

export interface PluginConversationsServiceOptions {
  reader: PluginChatsStoreReader;
  /** 插件停止信号；触发后每次调用都以 E_PLUGIN_STOPPING 失败。 */
  signal?: AbortSignal;
}

// 游标是带版本号的不透明令牌，便于将来改格式时明确拒绝旧令牌。
interface SessionCursor {
  v: 1;
  kind: "list";
  offset: number;
}

interface MessageCursor {
  v: 1;
  kind: "messages";
  conversationId: string;
  /** 首次请求时冻结的包含式起点。 */
  from?: string;
  /** 首次请求时冻结的包含式终点。 */
  through?: string;
  /** 上一页最后一条原始消息在会话消息数组中的下标。 */
  lastIndex: number;
}

function invalidArgument(message: string) {
  return pluginHostError("E_INVALID_ARGUMENT", message);
}

function sealCursor(body: SessionCursor | MessageCursor): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function openCursorObject(token: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw invalidArgument("非法分页游标");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw invalidArgument("非法分页游标");
  }
  return decoded as Record<string, unknown>;
}

function openSessionCursor(token: string): SessionCursor {
  const body = openCursorObject(token);
  const offsetOk = Number.isInteger(body.offset) && (body.offset as number) >= 0;
  if (body.v !== 1 || body.kind !== "list" || !offsetOk) {
    throw invalidArgument("非法会话列表游标");
  }
  return body as unknown as SessionCursor;
}

function openMessageCursor(token: string): MessageCursor {
  const body = openCursorObject(token);
  const shapeOk = body.v === 1
    && body.kind === "messages"
    && typeof body.conversationId === "string"
    && Number.isInteger(body.lastIndex)
    && (body.lastIndex as number) >= 0
    && (body.from === undefined || typeof body.from === "string")
    && (body.through === undefined || typeof body.through === "string");
  if (!shapeOk) {
    throw invalidArgument("非法消息分页游标");
  }
  return body as unknown as MessageCursor;
}

function resolvePageSize(requested: number | undefined, bounds: PageBounds, label: string): number {
  if (requested === undefined) return bounds.defaultSize;
  if (!Number.isInteger(requested) || requested < 1 || requested > bounds.maxSize) {
    throw invalidArgument(`非法${label}页大小: ${String(requested)}（1-${bounds.maxSize}）`);
  }
  return requested;
}

function projectSession(meta: ChatSessionMeta): PluginConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(meta.updatedAt).toISOString(),
  };
}

function projectMessage(message: ChatMessage): PluginConversationMessage {
  return {
    id: message.id,
    role: message.role === "model" ? "assistant" : "user",
    text: message.content,
    at: new Date(message.at).toISOString(),
  };
}

/**
 * 解析边界消息对应的下标区间（包含式）。边界消失时直接报错，
 * 绝不退化为“扩展到最新消息”。
 */
function locateSpan(
  messages: ChatMessage[],
  from: string | undefined,
  through: string | undefined,
): { start: number; end: number } {
  let start = 0;
  let end = messages.length - 1;
  if (from !== undefined) {
    const index = messages.findIndex((message) => message.id === from);
    if (index === -1) {
      throw pluginHostError("E_NOT_FOUND", `起点消息不存在于会话: ${from}`);
    }
    start = index;
  }
  if (through !== undefined) {
    const index = messages.findIndex((message) => message.id === through);
    if (index === -1) {
      throw pluginHostError("E_NOT_FOUND", `终点消息不存在于会话: ${through}`);
    }
    end = index;
  }
  if (start > end) {
    throw invalidArgument("起点消息在终点消息之后");
  }
  return { start, end };
}

/** 游标携带的会话与显式参数必须一致，且冻结边界不得被改写。 */
function ensureCursorAgrees(cursor: MessageCursor, input: PluginMessagePageInput): void {
  if (cursor.conversationId !== input.conversationId) {
    throw invalidArgument("分页游标与请求的会话不一致");
  }
  if (input.fromMessageId !== undefined && input.fromMessageId !== cursor.from) {
    throw invalidArgument("fromMessageId 与分页游标冻结的起点不一致");
  }
  if (input.throughMessageId !== undefined && input.throughMessageId !== cursor.through) {
    throw invalidArgument("throughMessageId 与分页游标冻结的终点不一致");
  }
}

/**
 * 只读会话服务。消息分页的核心约束是边界冻结：首次请求时把起止消息 id
 * 写进游标，后续页沿用这组边界，因此之后追加的轮次不会混入已开始的分页。
 */
export function createPluginConversationsService(
  options: PluginConversationsServiceOptions,
): PluginConversationsService {
  const { reader, signal } = options;

  function ensureRunning(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，会话服务不可用");
    }
  }

  return {
    async list(input): Promise<PluginConversationPage> {
      ensureRunning();
      const pageSize = resolvePageSize(input?.limit, SESSION_PAGE, "会话列表");
      let offset = 0;
      if (input?.cursor !== undefined) {
        offset = openSessionCursor(input.cursor).offset;
      }
      // 列表不承诺跨并发编辑的一致快照，直接按当前顺序切片。
      const sessions = reader.listSessions();
      const page: PluginConversationPage = {
        items: sessions.slice(offset, offset + pageSize).map(projectSession),
      };
      const nextOffset = offset + pageSize;
      if (nextOffset < sessions.length) {
        page.nextCursor = sealCursor({ v: 1, kind: "list", offset: nextOffset });
      }
      return page;
    },

    async getMessages(input: PluginMessagePageInput): Promise<PluginMessagePage> {
      ensureRunning();
      if (!input || typeof input.conversationId !== "string" || !input.conversationId) {
        throw invalidArgument(`非法会话 id: ${String(input?.conversationId)}`);
      }
      const pageSize = resolvePageSize(input.limit, MESSAGE_PAGE, "消息");

      const cursor = input.cursor !== undefined ? openMessageCursor(input.cursor) : undefined;
      if (cursor) {
        ensureCursorAgrees(cursor, input);
      }
      // 游标里冻结的边界优先，否则使用本次请求的边界。
      const from = cursor?.from ?? input.fromMessageId;
      const through = cursor?.through ?? input.throughMessageId;

      const session = reader.getSession(input.conversationId);
      if (!session) {
        throw pluginHostError("E_NOT_FOUND", `会话不存在: ${input.conversationId}`);
      }
      const messages = session.messages;
      const { start, end } = locateSpan(messages, from, through);

      if (cursor && cursor.lastIndex >= messages.length) {
        throw invalidArgument("分页游标已失效");
      }
      const resumeAfter = cursor ? cursor.lastIndex : -1;

      const items: PluginConversationMessage[] = [];
      let nextCursor: string | undefined;
      // 仅投影 user/assistant；其他内部角色跳过，但下标照常推进，
      // 保证下一页从正确的位置续上。
      for (let index = Math.max(resumeAfter + 1, start); index <= end; index++) {
        const message = messages[index];
        if (message.role !== "user" && message.role !== "model") continue;
        if (items.length === pageSize) {
          nextCursor = sealCursor({
            v: 1,
            kind: "messages",
            conversationId: input.conversationId,
            from,
            through,
            lastIndex: index - 1,
          });
          break;
        }
        items.push(projectMessage(message));
      }

      const range: PluginMessagePage["range"] = {
        ...(from !== undefined ? { fromMessageId: from } : {}),
        ...(through !== undefined ? { throughMessageId: through } : {}),
      };
      return { items, nextCursor, range };
    },
  };
}
