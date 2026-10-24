import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { ContextError } from "../memory-context/context-contracts";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { AgentExecutionError } from "../orchestrator/run-execution-status";
import { initializeStorageContext } from "../storage/storage-context";
import { resolveRuntimeProfile } from "../startup/runtime-profile";

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), root: "", failure: undefined as unknown,
  stream: vi.fn(async () => { throw boundary.failure; }),
}));
vi.mock("electron", () => ({
  app: { getPath: () => boundary.root }, BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => boundary.handlers.set(channel, fn), on: vi.fn(), removeListener: vi.fn() },
}));
// Only the external model stream is fake; ChatLoop, FireflyAgent and AG-UI bridge are real.
vi.mock("../orchestrator/vendors/sdk-stream/runtime", () => ({ streamChatWithSdk: boundary.stream }));
vi.mock("../chats/chats-store", () => ({
  getSession: (id: string) => ({ id, mode: "chat" }), getPendingMessages: () => [],
  markPendingAdjust: vi.fn(), resetPendingAdjustByRun: vi.fn(),
}));

boundary.root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-failure-chain-"));
initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", "--firefly-isolation-root=" + boundary.root], env: {}, isPackaged: false, productionAppData: boundary.root + "-production-unopened" }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.stream.mockClear(); });
afterAll(() => fs.rmSync(boundary.root, { recursive: true, force: true }));

it.each([
  [new ContextError("MEMORY_CONTEXT_BUDGET_EXCEEDED"), "MEMORY_CONTEXT_BUDGET_EXCEEDED", "context"],
  [new AgentRuntimeError("E_MODEL_HTTP_ERROR", "HTTP 503 SYNTHETIC_PROVIDER_SECRET"), "E_MODEL_HTTP_ERROR", "model"],
  [new AgentExecutionError("private wrapper", { phase: "context", successfulTools: [], createdArtifacts: [], taskCompletionConfirmed: false }, { cause: new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "SYNTHETIC_PROVIDER_SECRET") }), "E_MODEL_REQUEST_TIMEOUT", "model"],
  [Object.assign(new Error("SYNTHETIC_PROVIDER_SECRET"), { source: "model", code: "PRIVATE_UNRECOGNIZED_CODE" }), "E_HARNESS_FAILURE", "runtime"],
  [new ContextError("MEMORY_CONTEXT_SETTLEMENT_UNKNOWN"), "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN", "context", true],
] as const)("no-tool Chat preserves safe metadata through the real agent and bridge: %s", async (error, code, source, failClose) => {
  boundary.failure = error; boundary.handlers.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const network = vi.fn(() => { throw Error("UNEXPECTED_REAL_NETWORK"); }); vi.stubGlobal("fetch", network);
  const { registerAgUiIpc } = await import("./agui-bridge"), sent: unknown[] = [], finished = vi.fn(async () => ({ sticker: null }));
  registerAgUiIpc(async () => ({ options: {
    settings: { provider: "OpenAI", baseUrl: "https://synthetic.invalid/v1", model: "synthetic", apiKey: "synthetic-only", contextWindowTokens: 128000 },
    messages: [{ role: "user", content: "hello" }], tools: [], timeoutMs: 5000, toolSystemContent: "", soulSystemBaseContent: "",
    ...(failClose ? { openMemoryRun: async () => ({ call: async () => { throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "SYNTHETIC_PROVIDER_SECRET"); }, close: async () => { throw error; } } as any) } : {}),
  }, latestUserText: "hello" }), finished, () => null);
  await boundary.handlers.get(IPC.AGUI_RUN)!({ sender: { isDestroyed: () => false, send: (_channel: string, event: unknown) => sent.push(event) } }, { sessionId: "chat-safe-failure", messages: [{ role: "user", content: "hello" }] });
  await expect.poll(() => sent.find((event: any) => event.type === "RUN_ERROR")).toMatchObject({ type: "RUN_ERROR", code, message: code, errorSource: source });
  expect(boundary.stream).toHaveBeenCalledTimes(failClose ? 0 : 1); expect(network).not.toHaveBeenCalled(); expect(finished).not.toHaveBeenCalled();
  expect(sent.filter((event: any) => event.type === "RUN_ERROR")).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toMatch(/SYNTHETIC_PROVIDER_SECRET|private wrapper|PRIVATE_UNRECOGNIZED_CODE|HTTP 503/);
});
