import { describe, expect, it, vi } from "vitest";
import { copyMainResponsesRequest, copyResponseJson } from "./response-request-snapshot";
import type { ChatRequest } from "./types";

const FAILURE = "MEMORY_CONTEXT_COUNTER_UNSUPPORTED";

function unsupported(): never {
  throw new Error("CUSTOM_FAILURE");
}

describe("copyResponseJson", () => {
  it("copies JSON primitives and containers by value", () => {
    expect(copyResponseJson(null)).toBeNull();
    expect(copyResponseJson("text")).toBe("text");
    expect(copyResponseJson(true)).toBe(true);
    expect(copyResponseJson(2.5)).toBe(2.5);

    const source = { a: 1, b: [true, null, "x"], c: { d: 0 } };
    const copy = copyResponseJson(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.b).not.toBe(source.b);
    expect(copy.c).not.toBe(source.c);
  });

  it("uses the canonical key order and round-trips through JSON", () => {
    expect(Object.keys(copyResponseJson({ b: 1, a: 2 }))).toEqual(["a", "b"]);
    expect(copyResponseJson({ n: 1 })).not.toHaveProperty("toJSON");
  });

  it("omits undefined fields when asked, but rejects them otherwise", () => {
    const source = { kept: 1, dropped: undefined, nested: { kept: true, dropped: undefined } };
    expect(copyResponseJson(source, true)).toEqual({ kept: 1, nested: { kept: true } });
    expect(() => copyResponseJson(source)).toThrow(FAILURE);

    const decision = vi.fn((path: readonly string[], key: string) => path.length === 0 && key === "top");
    expect(copyResponseJson({ top: undefined, kept: 1 }, decision)).toEqual({ kept: 1 });
    expect(decision).toHaveBeenCalledWith([], "top");
    expect(decision).toHaveBeenCalledTimes(1);
  });

  it("supports omission predicates for nested paths", () => {
    const source = { messages: [{ content: "hi", name: undefined }, { content: "yo", name: undefined }] };
    const omitName = (path: readonly string[], key: string) =>
      path.length === 2 && path[0] === "messages" && key === "name";
    expect(copyResponseJson(source, omitName)).toEqual({
      messages: [{ content: "hi" }, { content: "yo" }],
    });
  });

  it("rejects non-finite numbers, functions, symbols and undefined at the top level", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, () => 1]) {
      expect(() => copyResponseJson(value)).toThrow(FAILURE);
    }
  });

  it("rejects class instances and prototypes carrying toJSON", () => {
    class Box {
      constructor(readonly value = 1) {}
    }
    expect(() => copyResponseJson(new Box())).toThrow(FAILURE);

    const withToJson = { toJSON: () => "hijacked" };
    expect(() => copyResponseJson(withToJson)).toThrow(FAILURE);

    const date = new Date(0);
    expect(() => copyResponseJson(date)).toThrow(FAILURE);
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => 42);
    const source = Object.defineProperty({}, "value", { get: getter, enumerable: true });
    expect(() => copyResponseJson(source)).toThrow(FAILURE);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects non-enumerable and symbol-keyed fields", () => {
    const hidden = Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false });
    expect(() => copyResponseJson(hidden)).toThrow(FAILURE);
    expect(() => copyResponseJson({ [Symbol("s")]: 1 })).toThrow(FAILURE);
  });

  it("rejects sparse arrays and arrays with extra own properties", () => {
    expect(() => copyResponseJson([1, , 3] as unknown[])).toThrow(FAILURE);
    const array = [1, 2] as unknown[] & { extra?: number };
    array.extra = 3;
    expect(() => copyResponseJson(array)).toThrow(FAILURE);
  });

  it("copies array length and dense values", () => {
    expect(copyResponseJson([0, "a", false])).toEqual([0, "a", false]);
    const nested = [[1], { a: [2] }];
    const copy = copyResponseJson(nested);
    expect(copy).toEqual(nested);
    expect(copy[0]).not.toBe(nested[0]);
  });

  it("rejects nesting deeper than 32 levels", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) value = [value];
    expect(() => copyResponseJson(value)).toThrow(FAILURE);
  });

  it("rejects objects with more than 10001 own keys", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 10002; index += 1) wide[`k${index}`] = index;
    expect(() => copyResponseJson(wide)).toThrow(FAILURE);
  });

  it("rejects values whose canonical JSON exceeds 8 MiB", () => {
    expect(() => copyResponseJson("x".repeat(8 * 1024 * 1024 + 1))).toThrow(FAILURE);
  });

  it("routes every failure through the supplied fail callback", () => {
    const fail = vi.fn(() => {
      throw new Error("CUSTOM_FAILURE");
    });
    expect(() => copyResponseJson({ fn: () => 1 }, false, fail)).toThrow("CUSTOM_FAILURE");
    expect(fail).toHaveBeenCalledTimes(2);
    expect(() => copyResponseJson({ value: undefined }, false, unsupported)).toThrow("CUSTOM_FAILURE");
  });

  it("uses the default unsupported failure for the default callback", () => {
    expect(() => copyResponseJson({ fn: () => 1 })).toThrow(FAILURE);
  });
});

describe("copyMainResponsesRequest", () => {
  function request(): ChatRequest {
    return {
      model: "model-a",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: "hi",
          toolCalls: undefined,
          toolCallId: undefined,
          name: undefined,
          thinking: "reason",
        },
      ],
      tools: undefined,
      toolChoiceIntent: undefined,
      temperature: undefined,
      topP: undefined,
      stream: undefined,
      frequencyPenalty: 0.5,
    };
  }

  it("drops only the known optional request and message fields", () => {
    const copied = copyMainResponsesRequest(request());
    expect(copied).toEqual({
      model: "model-a",
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "hi", thinking: "reason" },
      ],
      frequencyPenalty: 0.5,
    });
    expect(copied.messages[1]).not.toHaveProperty("toolCalls");
    expect(copied.messages[1]).not.toHaveProperty("toolCallId");
    expect(copied.messages[1]).not.toHaveProperty("name");
    expect(copied).not.toHaveProperty("tools");
  });

  it("keeps defined optional values and message data", () => {
    const source = request();
    source.temperature = 0;
    source.topP = 0.9;
    source.stream = true;
    source.maxTokens = 1000;
    source.tools = [{ name: "t", description: "d", parameters: { type: "object" } }];
    source.toolChoiceIntent = { mode: "must_call", toolName: "t" };
    source.messages[1].toolCalls = [{ id: "c1", name: "t", arguments: "{}" }];
    source.messages[1].toolCallId = "call-1";
    source.messages[1].name = "assistant-name";
    expect(copyMainResponsesRequest(source)).toEqual(source);
  });

  it("still fails on undefined optional fields outside the omission policy", () => {
    const source = request();
    source.maxTokens = undefined;
    const fail = vi.fn(() => {
      throw new Error("CUSTOM_FAILURE");
    });
    expect(() => copyMainResponsesRequest(source, fail)).toThrow("CUSTOM_FAILURE");
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("only omits message fields for canonical numeric message indexes", () => {
    const source: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      extraBody: { name: undefined, toolCalls: undefined },
    };
    expect(() => copyMainResponsesRequest(source)).toThrow(FAILURE);
  });

  it("rejects undefined array elements instead of dropping them", () => {
    const source = { messages: [undefined] } as unknown as ChatRequest;
    expect(() => copyMainResponsesRequest(source)).toThrow(FAILURE);
  });

  it("returns a detached copy that does not share arrays with the input", () => {
    const source = request();
    const copied = copyMainResponsesRequest(source);
    copied.messages.push({ role: "user", content: "later" });
    expect(source.messages).toHaveLength(2);
  });
});
