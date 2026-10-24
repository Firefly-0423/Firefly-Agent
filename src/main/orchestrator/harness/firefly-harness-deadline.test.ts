/**
 * 总超时必须作用于进行中的工作：到期时中止当前模型请求 / 工具，终态为 timeout（而不是等它们自己结束，
 * 也不能被记成用户取消）。ask_user 等待期间不计入，用户先取消则仍是 cancelled。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────

const { fakeAdapter, fakeStreamChatWithSdk, recordUsage, recordRequest } = vi.hoisted(() => {
  const adapter = {
    id: "fake",
    buildRequest: (req: unknown) => ({
      url: "https://fake.local/chat",
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
    parseResponse: (raw: unknown) => raw,
  };
  return {
    fakeAdapter: adapter,
    recordUsage: vi.fn(),
    recordRequest: vi.fn(),
    fakeStreamChatWithSdk: vi.fn(async (input: {
      adapter: typeof adapter;
      request: unknown;
      signal?: AbortSignal;
    }) => {
      const request = input.adapter.buildRequest(input.request);
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: input.signal,
      });
      return input.adapter.parseResponse(await response.json());
    }),
  };
});

vi.mock("../vendors", () => ({
  getAdapterForConfig: vi.fn(() => fakeAdapter),
  streamChatWithSdk: fakeStreamChatWithSdk,
  resolveTransport: vi.fn(() => "openai"),
}));

vi.mock("./tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
  persistToolDispatchResult: vi.fn(async (_call: unknown, result: unknown) => result),
}));

vi.mock("../../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordUsage, recordRequest }));

import { runFireflyHarness } from "./firefly-harness";
import { dispatchToolCall } from "./tool-dispatcher";
import type { ToolDispatchResult } from "./tool-dispatcher";
import type { HarnessEvent, HarnessInput } from "./types";
import type { ChatMessage, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";

const mockedDispatch = vi.mocked(dispatchToolCall);

// ── Helpers ────────────────────────────────────────────

function assistantResponse(opts: { text?: string; toolCalls?: ToolCall[] }): ChatResponse {
  const text = opts.text ?? "";
  const toolCalls = opts.toolCalls ?? [];
  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  return {
    assistantMessage,
    text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    raw: {},
  };
}

/** 构建一个可控的 fetch mock：返回 deferred 列表，每个 fetch 调用消费一个。 */
function deferredFetch(): {
  fn: (url: unknown, init?: unknown) => Promise<Response>;
  nextResolve: (resp: ChatResponse) => void;
  nextReject: (err: Error) => void;
  pendingAbort: () => void;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let pendingReject: ((err: Error) => void) | null = null;
  let pendingResolve: ((resp: ChatResponse) => void) | null = null;
  let pendingSignal: AbortSignal | null = null;

  const fn = vi.fn(async (_url: unknown, init?: unknown): Promise<Response> => {
    calls.push(init);
    pendingSignal = (init as { signal?: AbortSignal } | undefined)?.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      pendingResolve = (resp) => {
        resolve({
          ok: true,
          json: async () => resp,
        } as unknown as Response);
      };
      pendingReject = (err) => reject(err);
    });
  });

  return {
    fn,
    calls,
    nextResolve: (resp) => {
      const r = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      pendingSignal = null;
      r?.(resp);
    },
    nextReject: (err) => {
      const r = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      pendingSignal = null;
      r?.(err);
    },
    pendingAbort: () => {
      // 模拟 fetch 在 signal abort 时抛 AbortError
      if (pendingSignal?.aborted) {
        const r = pendingReject;
        pendingReject = null;
        pendingResolve = null;
        r?.(new DOMException("aborted", "AbortError"));
      }
    },
  };
}

const vendorConfig = {
  provider: "fake",
  baseUrl: "https://fake.local",
  model: "fake-model",
  apiKey: "fake-key",
} as unknown as HarnessInput["vendorConfig"];

function readTool(): ToolDefinition {
  return {
    id: "read_file",
    name: "Read File",
    description: "read a file",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    effectKind: "read",
    execute: vi.fn(),
  };
}

/** 收集所有 harness 事件，便于断言 final_answer 是否被发出。 */
function eventCollector(): { events: HarnessEvent[]; fn: (e: HarnessEvent) => void } {
  const events: HarnessEvent[] = [];
  return { events, fn: (e: HarnessEvent) => events.push(e) };
}

/** 断言取消终态不变量。 */
function assertCancelledTerminal(result: HarnessResult, events: HarnessEvent[]): void {
  // 恰好一个终止原因：cancelled
  expect(result.terminateReason).toBe("cancelled");
  expect(result.terminated).toBe(true);
  // 不生成 "最终回复被取消。" —— finalAnswer 必须为空
  expect(result.finalAnswer).toBe("");
  expect(result.finalAnswer).not.toContain("最终回复被取消");
  // 不得发 final_answer 事件
  const finalAnswerEvents = events.filter((e) => e.type === "final_answer");
  expect(finalAnswerEvents).toHaveLength(0);
  // terminal 字段：harness 内部可以不填（adapter 会映射），但如果填了必须是 cancelled
  if (result.terminal) {
    expect(result.terminal.status).toBe("cancelled");
    expect(result.terminal.externalEffectsMayContinue).toBe(true);
  }
}


const toolCall = (id = "call-1"): ToolCall => ({ id, name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) });

function successResult(): ToolDispatchResult {
  return {
    outcome: "success", tool: "read_file", target: "/tmp/x", message: "ok", output: "ok", truncated: false, preview: "ok",
    rawResult: { toolId: "read_file", args: { path: "/tmp/x" }, output: "ok", status: "succeeded", terminal: true, retryable: false },
  };
}

/** 与 tool-runtime 一致：运行信号 = 外部取消信号 + 内部 owner；quiesceExecution 中止 owner。 */
function runtimeSignals(external?: AbortSignal) {
  const owner = new AbortController();
  const quiesce = vi.fn(() => owner.abort());
  const signal = external ? AbortSignal.any([external, owner.signal]) : owner.signal;
  return { signal, quiesce };
}

describe("FireflyHarness run deadline", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts an in-flight model request when the total time runs out and settles as timeout", async () => {
    const fetchMock = deferredFetch();
    vi.stubGlobal("fetch", fetchMock.fn);
    const events: HarnessEvent[] = [];
    const { signal, quiesce } = runtimeSignals();
    const started = Date.now();

    const promise = runFireflyHarness({
      systemPrompt: "test", messages: [{ role: "user", content: "hello" }], tools: [], vendorConfig,
      config: { totalTimeoutMs: 40 }, signal, quiesceExecution: quiesce, onEvent: (e) => events.push(e),
    });
    await vi.waitFor(() => expect(fetchMock.calls).toHaveLength(1));
    // 模型请求一直不返回；到期后信号被中止，fetch 以 AbortError 结束。
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    fetchMock.pendingAbort();
    const result = await promise;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(quiesce).toHaveBeenCalled();
    expect(result.terminateReason).toBe("timeout");
    expect(result.terminated).toBe(true);
    expect(result.finalAnswer).toContain("时间上限");
    expect(events.filter((e) => e.type === "final_answer")).toHaveLength(1);
  });

  it("aborts a running tool when the total time runs out and settles as timeout", async () => {
    const fetchMock = deferredFetch();
    vi.stubGlobal("fetch", fetchMock.fn);
    const { signal, quiesce } = runtimeSignals();
    // 工具遵守取消信号：被中止后才返回。
    mockedDispatch.mockImplementation(() => new Promise<ToolDispatchResult>((resolve) => {
      signal.addEventListener("abort", () => resolve(successResult()), { once: true });
    }));

    const promise = runFireflyHarness({
      systemPrompt: "test", messages: [{ role: "user", content: "do work" }], tools: [readTool()], vendorConfig,
      config: { totalTimeoutMs: 80 }, signal, quiesceExecution: quiesce,
    });
    fetchMock.nextResolve(assistantResponse({ toolCalls: [toolCall("call-1")] }));
    await vi.waitFor(() => expect(mockedDispatch).toHaveBeenCalled());
    const result = await promise;

    expect(signal.aborted).toBe(true);
    expect(quiesce).toHaveBeenCalled();
    expect(result.terminateReason).toBe("timeout");
  });

  it("keeps a user cancellation as cancelled even if the deadline passes while it settles", async () => {
    const fetchMock = deferredFetch();
    vi.stubGlobal("fetch", fetchMock.fn);
    const user = new AbortController();
    const { signal, quiesce } = runtimeSignals(user.signal);

    const promise = runFireflyHarness({
      systemPrompt: "test", messages: [{ role: "user", content: "hello" }], tools: [], vendorConfig,
      config: { totalTimeoutMs: 60 }, signal, quiesceExecution: quiesce,
    });
    await vi.waitFor(() => expect(fetchMock.calls).toHaveLength(1));
    user.abort();
    fetchMock.pendingAbort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await promise;

    expect(result.terminateReason).toBe("cancelled");
    expect(result.finalAnswer).toBe("");
  });

  it("does not abort anything when the total timeout is disabled", async () => {
    const fetchMock = deferredFetch();
    vi.stubGlobal("fetch", fetchMock.fn);
    const { signal, quiesce } = runtimeSignals();

    const promise = runFireflyHarness({
      systemPrompt: "test", messages: [{ role: "user", content: "hello" }], tools: [], vendorConfig,
      config: { totalTimeoutMs: 0 }, signal, quiesceExecution: quiesce,
    });
    await vi.waitFor(() => expect(fetchMock.calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(false);
    fetchMock.nextResolve(assistantResponse({ text: "完成。" }));
    const result = await promise;

    expect(result.terminateReason).toBeUndefined();
    expect(result.finalAnswer).toContain("完成");
  });
});
