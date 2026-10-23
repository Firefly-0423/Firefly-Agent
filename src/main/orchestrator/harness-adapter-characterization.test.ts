import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const collaborators = vi.hoisted(() => ({
  root: "", run: vi.fn(), trace: [] as string[],
  store: { create: vi.fn(), checkpoint: vi.fn(), recordTool: vi.fn(), recordTools: vi.fn(), recordCompaction: vi.fn(), markTerminal: vi.fn() },
  finalize: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => collaborators.root } }));
vi.mock("./harness", async original => ({ ...await original<typeof import("./harness")>(), runFireflyHarness: collaborators.run }));
vi.mock("./harness/run-store", () => ({ getHarnessRunStore: () => collaborators.store }));
vi.mock("./review/run-review-tracker", () => ({ getRunReviewTracker: () => ({ finalizeReview: collaborators.finalize }) }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [], getById: vi.fn() } }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "Auditing policy" }));
import { runHarnessWithAdapter } from "./harness-adapter";
import { DEFAULT_HARNESS_CONFIG, type HarnessInput } from "./harness/types";

const result = () => ({ finalAnswer: "Audit ready", finalState: { todoItems: [], uncertainEffects: [] }, terminated: false, rounds: 2 });
const options = (runId: string) => ({
  runId, settings: { provider: "custom", model: "audit-model", apiKey: "", baseUrl: "https://fixture.invalid", contextWindowTokens: 96000 },
  messages: [{ role: "user", content: "Audit contracts" }], toolSystemContent: "", soulSystemBaseContent: "Workspace identity", executionMode: "work", conversationMode: "work",
});
beforeAll(() => { collaborators.root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-order-")); });
afterAll(() => fs.rmSync(collaborators.root, { recursive: true, force: true }));
beforeEach(() => {
  vi.resetAllMocks(); collaborators.trace.length = 0;
  collaborators.store.create.mockImplementation(() => collaborators.trace.push("persist initial"));
  collaborators.store.markTerminal.mockImplementation(() => { collaborators.trace.push("persist terminal"); return { createdAt: 83 }; });
  collaborators.finalize.mockImplementation(() => collaborators.trace.push("finalize review"));
  collaborators.run.mockImplementation(async () => { collaborators.trace.push("invoke harness"); return result(); });
});

describe("Adapter orchestration boundaries", () => {
  it("persists startup before execution and terminal truth before review and return", async () => {
    const response = await runHarnessWithAdapter(options("ordered-ochre") as never, new AbortController().signal, vi.fn());
    collaborators.trace.push("returned");
    expect(response.reply).toBe("Audit ready");
    expect(collaborators.trace).toEqual(["persist initial", "invoke harness", "persist terminal", "finalize review", "returned"]);
  });

  it("binds the Main memory guard once and checkpoints exclusively through its guarded sink", async () => {
    const unguarded = { checkpoint: vi.fn(async () => {}) }, guarded = { checkpoint: vi.fn(async () => {}) };
    const memoryRun = { call: vi.fn(), close: vi.fn(async () => {}), bindSink: vi.fn(() => guarded) };
    await runHarnessWithAdapter({ ...options("guarded-ochre"), memoryRun, transcriptSink: unguarded } as never, new AbortController().signal, vi.fn());
    expect(memoryRun.bindSink).toHaveBeenCalledWith(unguarded);
    expect(collaborators.run).toHaveBeenCalledWith(expect.objectContaining({ memoryRun, transcriptSink: guarded }));
    expect(guarded.checkpoint).toHaveBeenCalledOnce();
    expect(unguarded.checkpoint).not.toHaveBeenCalled();
  });

  it("preserves all checkpoint fields including a committed compaction epoch", async () => {
    const checkpoint = { messages: [], state: { todoItems: [], uncertainEffects: [] }, toolOutputs: [], rounds: 2, cache: { cacheEpoch: 5, epochReason: "compaction" }, at: 83 };
    collaborators.run.mockImplementation(async (input: HarnessInput) => { input.onCheckpoint!(checkpoint as never); return result(); });
    await runHarnessWithAdapter(options("checkpoint-ochre") as never, new AbortController().signal, vi.fn());
    const { at: _at, ...persisted } = checkpoint;
    expect(collaborators.store.checkpoint).toHaveBeenCalledWith("checkpoint-ochre", persisted);
  });

  it("writes every planned invocation through to the recoverable batch before terminal completion", async () => {
    const { HarnessRunStore } = await vi.importActual<typeof import("./harness/run-store")>("./harness/run-store");
    const durable = new HarnessRunStore(collaborators.root);
    collaborators.store.create.mockImplementation(input => durable.create(input));
    collaborators.store.recordTools.mockImplementation((id, calls) => durable.recordTools(id, calls));
    collaborators.store.markTerminal.mockImplementation((id, status) => durable.markTerminal(id, status));
    collaborators.run.mockImplementation(async (input: HarnessInput) => {
      input.onToolsPlanned!([
        { toolCallId: "inspect-ochre", toolName: "read_file", toolSideEffect: "read_only", status: "planned" },
        { toolCallId: "save-ochre", toolName: "write_file", toolSideEffect: "idempotent_mutation", status: "planned" },
      ]);
      expect(durable.get(input.runId!)?.toolCalls).toEqual([
        expect.objectContaining({ toolCallId: "inspect-ochre", sideEffect: "read_only", status: "planned" }),
        expect.objectContaining({ toolCallId: "save-ochre", sideEffect: "idempotent_mutation", status: "planned" }),
      ]);
      return result();
    });
    await runHarnessWithAdapter(options("batch-ochre") as never, new AbortController().signal, vi.fn());
    expect(durable.get("batch-ochre")?.status).toBe("completed");
  });

  it.each([undefined, 2])("preserves default parallelism and explicit override %s", async configured => {
    let effective: number | undefined;
    collaborators.run.mockImplementation(async (input: HarnessInput) => { effective = { ...DEFAULT_HARNESS_CONFIG, ...input.config }.maxParallelToolCalls; return result(); });
    await runHarnessWithAdapter({ ...options("capacity-ochre"), maxParallelToolCalls: configured } as never, new AbortController().signal, vi.fn());
    expect(effective).toBe(configured ?? 4);
  });
});
