import { describe, expect, test } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createPluginWorkspaceService } from "./workspace-service";

type Row = { workspaceRoot: string; displayName: string };

function makeService(table: Map<string, Row>, signal?: AbortSignal) {
  const lookups: string[] = [];
  const service = createPluginWorkspaceService({
    reader: {
      getWorkspaceBinding(id: string) {
        lookups.push(id);
        return table.get(id);
      },
    },
    signal,
  });
  return { service, lookups };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    expect(isPluginHostError(e)).toBe(true);
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("getBinding 正常路径", () => {
  test("把存储字段映射为 conversationId/root/displayName", async () => {
    const { service } = makeService(
      new Map([["chat-A", { workspaceRoot: "/home/u/repo", displayName: "repo" }]]),
    );
    expect(await service.getBinding("chat-A")).toEqual({
      conversationId: "chat-A",
      root: "/home/u/repo",
      displayName: "repo",
    });
  });

  test("存储行里多余的字段不会泄漏到返回值", async () => {
    const row = { workspaceRoot: "/w", displayName: "w", secretToken: "x", pinned: true };
    const { service } = makeService(new Map([["c", row as Row]]));
    const result = await service.getBinding("c");
    expect(Object.keys(result as object).sort()).toEqual(["conversationId", "displayName", "root"]);
  });

  test("不同会话互不干扰", async () => {
    const { service } = makeService(
      new Map<string, Row>([
        ["a", { workspaceRoot: "/a", displayName: "A" }],
        ["b", { workspaceRoot: "/b", displayName: "B" }],
      ]),
    );
    expect((await service.getBinding("b"))?.root).toBe("/b");
    expect((await service.getBinding("a"))?.root).toBe("/a");
  });
});

describe("getBinding 缺失绑定", () => {
  test("未知会话得到 null 而不是异常", async () => {
    const { service } = makeService(new Map());
    await expect(service.getBinding("nope")).resolves.toBeNull();
  });
});

describe("getBinding 参数与停止信号", () => {
  test.each([["空字符串", ""], ["数字", 42], ["null", null], ["undefined", undefined]])(
    "非法 id（%s）报 E_INVALID_ARGUMENT 且不查询存储",
    async (_label, bad) => {
      const { service, lookups } = makeService(new Map());
      expect(await codeOf(service.getBinding(bad as unknown as string))).toBe("E_INVALID_ARGUMENT");
      expect(lookups).toEqual([]);
    },
  );

  test("信号已中止时报 E_PLUGIN_STOPPING 且不查询存储", async () => {
    const ac = new AbortController();
    const { service, lookups } = makeService(new Map([["x", { workspaceRoot: "/", displayName: "" }]]), ac.signal);
    ac.abort();
    expect(await codeOf(service.getBinding("x"))).toBe("E_PLUGIN_STOPPING");
    expect(lookups).toHaveLength(0);
  });

  test("停止优先于参数校验", async () => {
    const ac = new AbortController();
    ac.abort();
    const { service } = makeService(new Map(), ac.signal);
    expect(await codeOf(service.getBinding(""))).toBe("E_PLUGIN_STOPPING");
  });

  test("中止之前的调用仍然成功", async () => {
    const ac = new AbortController();
    const { service } = makeService(new Map([["x", { workspaceRoot: "/r", displayName: "r" }]]), ac.signal);
    expect((await service.getBinding("x"))?.root).toBe("/r");
    ac.abort();
    expect(await codeOf(service.getBinding("x"))).toBe("E_PLUGIN_STOPPING");
  });
});
