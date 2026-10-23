import { describe, expect, test } from "vitest";
import type { ChatMessage, ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import { isPluginHostError } from "../../plugins/api";
import { createPluginConversationsService } from "./conversations-service";

const T0 = Date.UTC(2028, 4, 1, 12, 0, 0);

interface Row {
  id: string;
  title: string;
  mode: "chat" | "work" | "code";
  updatedAt: number;
  messages: ChatMessage[];
}

function turn(id: string, who: string, content: string, offset = 0): ChatMessage {
  return { id, role: who as ChatMessage["role"], content, at: T0 + offset * 1000 };
}

/** 构造 n 条交替的 user/model 消息，id 为 m0..m(n-1)。 */
function dialogue(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => turn(`m${i}`, i % 2 === 0 ? "user" : "model", `line ${i}`, i));
}

function world(rows: Row[]) {
  return {
    rows,
    reader: {
      // 与存储一致：listSessions 按最近更新倒序。
      listSessions: (): ChatSessionMeta[] =>
        [...rows]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((r) => ({
            id: r.id,
            title: r.title,
            mode: r.mode,
            identityId: null,
            createdAt: T0,
            updatedAt: r.updatedAt,
            messageCount: r.messages.length,
          })),
      getSession: (id: string): ChatSession | null => {
        const r = rows.find((x) => x.id === id);
        return r
          ? { id: r.id, title: r.title, mode: r.mode, identityId: null, messages: r.messages, createdAt: T0, updatedAt: r.updatedAt, schemaVersion: 1 }
          : null;
      },
    },
  };
}

function manyRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${String(i).padStart(3, "0")}`,
    title: `Title ${i}`,
    mode: "chat" as const,
    updatedAt: T0 + (count - i) * 60_000, // s000 最新
    messages: [],
  }));
}

async function rejectCode(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    // 契约要求抛出的是宿主错误实例，只带 code 字段的普通对象不算。
    expect(isPluginHostError(e)).toBe(true);
    return (e as { code?: string }).code;
  }
  return "no-error";
}

function b64(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("list：投影与分页", () => {
  test("空存储返回空页且没有 nextCursor", async () => {
    const svc = createPluginConversationsService({ reader: world([]).reader });
    expect(await svc.list()).toEqual({ items: [] });
  });

  test("只输出 id/title/mode/createdAt/updatedAt，时间为 ISO 串", async () => {
    const w = world([{ id: "only", title: "唯一", mode: "code", updatedAt: T0 + 5000, messages: [] }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const { items } = await svc.list();
    expect(items).toEqual([
      {
        id: "only",
        title: "唯一",
        mode: "code",
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0 + 5000).toISOString(),
      },
    ]);
  });

  test("默认页大小 20，顺着游标走完全部且不重不漏", async () => {
    const svc = createPluginConversationsService({ reader: world(manyRows(45)).reader });
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(cursor ? { cursor } : undefined);
      sizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
    expect(seen).toEqual(manyRows(45).map((r) => r.id));
  });

  test("恰好填满最后一页时不给出 nextCursor", async () => {
    const svc = createPluginConversationsService({ reader: world(manyRows(10)).reader });
    const page = await svc.list({ limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeUndefined();
  });

  test("limit 可自定义，上限 100 可用，101 与 0 被拒绝", async () => {
    const svc = createPluginConversationsService({ reader: world(manyRows(150)).reader });
    expect((await svc.list({ limit: 3 })).items).toHaveLength(3);
    expect((await svc.list({ limit: 100 })).items).toHaveLength(100);
    expect(await rejectCode(svc.list({ limit: 101 }))).toBe("E_INVALID_ARGUMENT");
    expect(await rejectCode(svc.list({ limit: 0 }))).toBe("E_INVALID_ARGUMENT");
  });

  test.each([-1, 1.5, Number.NaN])("limit=%s 被拒绝", async (limit) => {
    const svc = createPluginConversationsService({ reader: world(manyRows(3)).reader });
    expect(await rejectCode(svc.list({ limit }))).toBe("E_INVALID_ARGUMENT");
  });

  test.each([
    ["不是 base64 JSON", "%%%"],
    ["JSON 数组", b64([1])],
    ["缺 offset", b64({ v: 1, kind: "list" })],
    ["负 offset", b64({ v: 1, kind: "list", offset: -5 })],
    ["小数 offset", b64({ v: 1, kind: "list", offset: 2.5 })],
    ["版本不对", b64({ v: 2, kind: "list", offset: 1 })],
    ["种类不对", b64({ v: 1, kind: "messages", offset: 1 })],
  ])("坏游标被拒绝：%s", async (_n, cursor) => {
    const svc = createPluginConversationsService({ reader: world(manyRows(5)).reader });
    expect(await rejectCode(svc.list({ cursor }))).toBe("E_INVALID_ARGUMENT");
  });

  test("游标越过末尾得到空页", async () => {
    const svc = createPluginConversationsService({ reader: world(manyRows(5)).reader });
    const page = await svc.list({ cursor: b64({ v: 1, kind: "list", offset: 50 }) });
    expect(page).toEqual({ items: [] });
  });
});

describe("getMessages：内容与边界", () => {
  const base = () => world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(6) }]);

  test("不带边界时从头返回，model 映射为 assistant，并带 ISO 时间", async () => {
    const svc = createPluginConversationsService({ reader: base().reader });
    const page = await svc.getMessages({ conversationId: "c" });
    expect(page.items.map((m) => [m.id, m.role, m.text])).toEqual([
      ["m0", "user", "line 0"],
      ["m1", "assistant", "line 1"],
      ["m2", "user", "line 2"],
      ["m3", "assistant", "line 3"],
      ["m4", "user", "line 4"],
      ["m5", "assistant", "line 5"],
    ]);
    expect(page.items[2].at).toBe(new Date(T0 + 2000).toISOString());
    expect(page.nextCursor).toBeUndefined();
    expect(page.range).toEqual({});
  });

  test("消息投影不包含推理等内部字段", async () => {
    const msgs = dialogue(2);
    msgs[1] = { ...msgs[1], reasoning: "hidden thoughts" };
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: msgs }]);
    const page = await createPluginConversationsService({ reader: w.reader }).getMessages({ conversationId: "c" });
    expect(Object.keys(page.items[1]).sort()).toEqual(["at", "id", "role", "text"]);
  });

  test("起止边界都是包含式的，range 回显边界", async () => {
    const svc = createPluginConversationsService({ reader: base().reader });
    const page = await svc.getMessages({ conversationId: "c", fromMessageId: "m1", throughMessageId: "m3" });
    expect(page.items.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(page.range).toEqual({ fromMessageId: "m1", throughMessageId: "m3" });
  });

  test("起点与终点相同则只返回那一条", async () => {
    const svc = createPluginConversationsService({ reader: base().reader });
    const page = await svc.getMessages({ conversationId: "c", fromMessageId: "m4", throughMessageId: "m4" });
    expect(page.items.map((m) => m.id)).toEqual(["m4"]);
  });

  test("只给起点或只给终点时 range 只含对应一项", async () => {
    const svc = createPluginConversationsService({ reader: base().reader });
    expect((await svc.getMessages({ conversationId: "c", fromMessageId: "m5" })).range).toEqual({ fromMessageId: "m5" });
    expect((await svc.getMessages({ conversationId: "c", throughMessageId: "m0" })).range).toEqual({ throughMessageId: "m0" });
  });

  test("非 user/model 的内部角色被跳过，分页仍然连续", async () => {
    const msgs = [
      turn("a", "user", "A"),
      turn("x1", "tool", "internal"),
      turn("b", "model", "B"),
      turn("x2", "system", "internal"),
      turn("c", "user", "C"),
    ];
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: msgs }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual(["a", "b"]);
    const second = await svc.getMessages({ conversationId: "c", limit: 2, cursor: first.nextCursor });
    expect(second.items.map((m) => m.id)).toEqual(["c"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("getMessages：分页与冻结边界", () => {
  test("按 limit 翻页，各页拼起来等于完整序列", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(11) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.getMessages({ conversationId: "c", limit: 4, cursor });
      ids.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(ids).toEqual(Array.from({ length: 11 }, (_, i) => `m${i}`));
  });

  test("恰好整除时最后一页没有 nextCursor", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(4) }]);
    const page = await createPluginConversationsService({ reader: w.reader }).getMessages({ conversationId: "c", limit: 4 });
    expect(page.nextCursor).toBeUndefined();
  });

  test("默认页大小 50，最大 100，超出被拒", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(130) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    expect((await svc.getMessages({ conversationId: "c" })).items).toHaveLength(50);
    expect((await svc.getMessages({ conversationId: "c", limit: 100 })).items).toHaveLength(100);
    expect(await rejectCode(svc.getMessages({ conversationId: "c", limit: 101 }))).toBe("E_INVALID_ARGUMENT");
    expect(await rejectCode(svc.getMessages({ conversationId: "c", limit: 0 }))).toBe("E_INVALID_ARGUMENT");
  });

  test("首次请求指定的终点被冻结，之后追加的消息不会出现在后续页", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(6) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2, throughMessageId: "m5" });
    w.rows[0].messages.push(turn("late1", "user", "new"), turn("late2", "model", "newer"));
    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await svc.getMessages({ conversationId: "c", limit: 2, cursor });
      rest.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
    }
    expect(rest).toEqual(["m2", "m3", "m4", "m5"]);
  });

  test("后续页的 range 沿用首页的冻结边界", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(8) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2, fromMessageId: "m1", throughMessageId: "m6" });
    const second = await svc.getMessages({ conversationId: "c", limit: 2, cursor: first.nextCursor });
    expect(second.range).toEqual({ fromMessageId: "m1", throughMessageId: "m6" });
    expect(second.items.map((m) => m.id)).toEqual(["m3", "m4"]);
  });

  test("与冻结值一致的显式边界可以和游标同时提交", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(8) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2, fromMessageId: "m0", throughMessageId: "m7" });
    const second = await svc.getMessages({
      conversationId: "c",
      limit: 2,
      cursor: first.nextCursor,
      fromMessageId: "m0",
      throughMessageId: "m7",
    });
    expect(second.items.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  test("与冻结值不同的显式边界（含只给其中一个冻结项时多给另一个）被拒绝", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(8) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2, fromMessageId: "m0" });
    const cursor = first.nextCursor;
    expect(await rejectCode(svc.getMessages({ conversationId: "c", cursor, fromMessageId: "m1" }))).toBe("E_INVALID_ARGUMENT");
    expect(await rejectCode(svc.getMessages({ conversationId: "c", cursor, throughMessageId: "m7" }))).toBe("E_INVALID_ARGUMENT");
  });

  test("游标不能用于另一个会话", async () => {
    const w = world([
      { id: "A", title: "A", mode: "chat", updatedAt: T0, messages: dialogue(6) },
      { id: "B", title: "B", mode: "chat", updatedAt: T0, messages: dialogue(6) },
    ]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const { nextCursor } = await svc.getMessages({ conversationId: "A", limit: 2 });
    expect(await rejectCode(svc.getMessages({ conversationId: "B", cursor: nextCursor }))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("getMessages：错误路径", () => {
  const sample = () =>
    createPluginConversationsService({
      reader: world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(6) }]).reader,
    });

  test("会话不存在 -> E_NOT_FOUND", async () => {
    expect(await rejectCode(sample().getMessages({ conversationId: "ghost" }))).toBe("E_NOT_FOUND");
  });

  test("边界消息不存在 -> E_NOT_FOUND", async () => {
    expect(await rejectCode(sample().getMessages({ conversationId: "c", fromMessageId: "nope" }))).toBe("E_NOT_FOUND");
    expect(await rejectCode(sample().getMessages({ conversationId: "c", throughMessageId: "nope" }))).toBe("E_NOT_FOUND");
  });

  test("起点晚于终点 -> E_INVALID_ARGUMENT", async () => {
    expect(
      await rejectCode(sample().getMessages({ conversationId: "c", fromMessageId: "m4", throughMessageId: "m2" })),
    ).toBe("E_INVALID_ARGUMENT");
  });

  test.each(["", undefined, 5, null])("非法会话 id %j -> E_INVALID_ARGUMENT", async (id) => {
    expect(await rejectCode(sample().getMessages({ conversationId: id as never }))).toBe("E_INVALID_ARGUMENT");
  });

  test.each([
    ["乱码", "###"],
    ["种类错", b64({ v: 1, kind: "list", offset: 0 })],
    ["缺会话", b64({ v: 1, kind: "messages", lastIndex: 0 })],
    ["lastIndex 为负", b64({ v: 1, kind: "messages", conversationId: "c", lastIndex: -1 })],
    ["from 类型错", b64({ v: 1, kind: "messages", conversationId: "c", lastIndex: 0, from: 3 })],
  ])("坏游标：%s", async (_n, cursor) => {
    expect(await rejectCode(sample().getMessages({ conversationId: "c", cursor }))).toBe("E_INVALID_ARGUMENT");
  });

  test("翻页期间冻结的边界消息被删除 -> E_NOT_FOUND，而不是扩展到最新", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(8) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 2, throughMessageId: "m6" });
    w.rows[0].messages = w.rows[0].messages.filter((m) => m.id !== "m6");
    expect(await rejectCode(svc.getMessages({ conversationId: "c", cursor: first.nextCursor }))).toBe("E_NOT_FOUND");
  });

  test("会话被截短使游标位置落到末尾之外 -> E_INVALID_ARGUMENT", async () => {
    const w = world([{ id: "c", title: "c", mode: "chat", updatedAt: T0, messages: dialogue(8) }]);
    const svc = createPluginConversationsService({ reader: w.reader });
    const first = await svc.getMessages({ conversationId: "c", limit: 5 });
    w.rows[0].messages = w.rows[0].messages.slice(0, 2);
    expect(await rejectCode(svc.getMessages({ conversationId: "c", cursor: first.nextCursor }))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("停止信号", () => {
  test("中止后 list 与 getMessages 都报 E_PLUGIN_STOPPING", async () => {
    const ac = new AbortController();
    const svc = createPluginConversationsService({ reader: world(manyRows(2)).reader, signal: ac.signal });
    expect((await svc.list()).items).toHaveLength(2);
    ac.abort();
    expect(await rejectCode(svc.list())).toBe("E_PLUGIN_STOPPING");
    expect(await rejectCode(svc.getMessages({ conversationId: "s000" }))).toBe("E_PLUGIN_STOPPING");
    expect(await rejectCode(svc.list({ limit: 9999 }))).toBe("E_PLUGIN_STOPPING");
  });
});
