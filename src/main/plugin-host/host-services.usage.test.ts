import { beforeEach, describe, expect, test, vi } from "vitest";

const usage = vi.hoisted(() => ({ recordPluginCall: vi.fn() }));
vi.mock("../storage/token-usage-store", () => usage);

import { createHostServiceFactory } from "./host-services";

function llmFor(pluginId: string, generateText: (...args: any[]) => Promise<string>) {
  const factory = createHostServiceFactory({
    pluginDataRoot: "n/a",
    channelManager: { has: () => false },
    llm: { generateText } as never,
    storage: {} as never,
    chatsReader: {} as never,
    schedulerStore: {} as never,
  });
  const deps = factory.createForPlugin({
    pluginId,
    signal: new AbortController().signal,
    trackResource: (() => () => undefined) as never,
  });
  return deps.llm!;
}

beforeEach(() => {
  usage.recordPluginCall.mockReset();
});

describe("插件 LLM 调用计数", () => {
  test("每次 generateText 记一次并归到发起插件名下，参数与返回值原样透传", async () => {
    const inner = vi.fn(async () => "reply-text");
    const llm = llmFor("plugin-x", inner);
    const msgs = [{ role: "user" as const, content: "ping" }];
    expect(await llm.generateText(msgs, { purpose: "probe" } as never)).toBe("reply-text");
    expect(inner).toHaveBeenCalledWith(msgs, { purpose: "probe" });
    expect(usage.recordPluginCall.mock.calls).toEqual([["plugin-x"]]);
  });

  test("多次调用累计，不同插件各记各的", async () => {
    const inner = async () => "z";
    const first = llmFor("one", inner);
    const second = llmFor("two", inner);
    await first.generateText([]);
    await first.generateText([]);
    await second.generateText([]);
    expect(usage.recordPluginCall.mock.calls.map((c) => c[0])).toEqual(["one", "one", "two"]);
  });

  test("底层调用失败时错误照常抛出（计数已发生）", async () => {
    const llm = llmFor("p", async () => {
      throw new Error("upstream down");
    });
    await expect(llm.generateText([])).rejects.toThrow("upstream down");
    expect(usage.recordPluginCall).toHaveBeenCalledTimes(1);
  });
});
