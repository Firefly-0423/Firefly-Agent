import { beforeEach, expect, it, vi } from "vitest";
import { applyScheduledExecutionPolicy, createSchedulerRunner } from "./scheduler-runner";
import { requireBackgroundMemoryIngress } from "../memory-context/background-memory-ingress";
import type { ScheduledTask } from "./types";

const agent = vi.hoisted(() => ({ result: { reply: "Garden reviewed", terminal: undefined as undefined | { status: string } },
  failure: undefined as Error | undefined, options: undefined as any, barrier: undefined as Promise<void> | undefined }));
vi.mock("../orchestrator/firefly-agent", () => ({
  FireflyAgent: class {
    get lastResult() { return agent.result; }
    runWithEvents(options: unknown) {
      agent.options = options;
      return { subscribe: (observer: { complete(): void; error(error: Error): void }) => {
        void Promise.resolve().then(async () => { await agent.barrier; agent.failure ? observer.error(agent.failure) : observer.complete(); });
        return { unsubscribe() {} };
      } };
    }
  },
}));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [] } }));
beforeEach(() => { agent.result = { reply: "Garden reviewed", terminal: undefined }; agent.failure = undefined; agent.options = undefined; agent.barrier = undefined; });
function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "garden-task", title: "Garden review", prompt: "Review the seedlings", enabled: true,
    schedule: { kind: "daily", timeOfDay: "14:00" }, nextFireAt: null, toolMode: "allow-list", allowedToolIds: [],
    createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...patch };
}
function dependencies() {
  let tick = 0;
  return { buildOptions: vi.fn(async () => ({ messages: [{ role: "user", content: "Review the seedlings" }],
    settings: { provider: "garden-provider", baseUrl: "", model: "orchid", apiKey: "", contextWindowTokens: 64000 }, timeoutMs: 45000 })),
    getChatWebContents: () => null, recordHistory: vi.fn(), id: () => "garden-run",
    now: () => new Date(Date.UTC(2026, 9, 21, 6) + ++tick * 1000) };
}
const publisher = () => ({ publishTurnStarted: vi.fn(), publishTurnFinished: vi.fn(), publishSchedulerFinished: vi.fn() });
it("applies unattended Work policy without replacing the supplied conversation messages", async () => {
  const original = await dependencies().buildOptions();
  const options = applyScheduledExecutionPolicy({ ...original, toolSystemContent: "Garden tools", soulSystemBaseContent: "Garden persona" } as never);
  expect(options).toMatchObject({ executionMode: "work", conversationMode: "work", harnessInteractiveTools: false, permissionMode: "allow_all" });
  expect(options.messages).toEqual([{ role: "user", content: "Review the seedlings" }]);
});
it("publishes exact lifecycle identities and duration without inventing a desktop conversation", async () => {
  const publishLifecycle = publisher(), runner = createSchedulerRunner({ ...dependencies(), publishLifecycle } as never);
  expect((await runner.runScheduledTask(task(), new Date(), false)).ok).toBe(true);
  const identity = { source: "scheduler", runId: "garden-run", mode: "work", taskId: "garden-task", schedulerRunId: "garden-run" };
  expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledWith(identity);
  expect(publishLifecycle.publishTurnStarted.mock.calls[0][0]).not.toHaveProperty("conversationId");
  expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledExactlyOnceWith({ ...identity, status: "success", durationMs: 1000 });
  expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith({ taskId: "garden-task", schedulerRunId: "garden-run", status: "success", durationMs: 1000 });
});
it("publishes the task's frozen chat mode on both turn events", async () => {
  const publishLifecycle = publisher(), runner = createSchedulerRunner({ ...dependencies(), publishLifecycle } as never);
  await runner.runScheduledTask(task({ mode: "chat" }), new Date(), false);
  expect(publishLifecycle.publishTurnStarted.mock.calls[0][0].mode).toBe("chat");
  expect(publishLifecycle.publishTurnFinished.mock.calls[0][0].mode).toBe("chat");
});
it.each(["timeout", "runtime_error"] as const)("publishes %s instead of success for unsuccessful agent completion", async status => {
  if (status === "timeout") agent.result = { reply: "Partial garden review", terminal: { status } };
  else agent.failure = new Error("Garden model unavailable");
  const publishLifecycle = publisher(), runner = createSchedulerRunner({ ...dependencies(), publishLifecycle } as never);
  const result = await runner.runScheduledTask(task(), new Date(), false);
  if (status === "runtime_error") {
    expect(result.ok).toBe(false);
    expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledTimes(1);
  }
  expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ status, schedulerRunId: "garden-run" }));
  expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith(expect.objectContaining({ status }));
});
it("runs successfully when no lifecycle publisher is supplied", async () => {
  expect((await createSchedulerRunner(dependencies() as never).runScheduledTask(task(), new Date(), false)).ok).toBe(true);
});
it("binds system-trusted background memory ingress to the saved profile and real run identity", async () => {
  const prepareBackgroundRun = vi.fn(async (input: any) => {
    const ingress = requireBackgroundMemoryIngress(input.ingress);
    expect(ingress).toMatchObject({ entry: "scheduler", instructionText: "Review the seedlings", sourceTrust: "system" });
    expect(input).not.toHaveProperty("readParentGrant");
    return { sessionId: ingress.sessionId, signal: ingress.signal, transcriptSink: {}, openMemoryRun: vi.fn(), close: vi.fn(async () => {}) };
  });
  const deps = dependencies();
  deps.buildOptions.mockResolvedValue({ ...await deps.buildOptions(), modelProfileId: "garden-profile" } as never);
  const runner = createSchedulerRunner({ ...deps, memoryHost: { prepareBackgroundRun } } as never);
  expect((await runner.runScheduledTask(task(), new Date(), false)).ok).toBe(true);
  expect(prepareBackgroundRun).toHaveBeenCalledWith(expect.objectContaining({ modelProfileId: "garden-profile", runId: "garden-run", instructionText: "Review the seedlings" }));
  expect(agent.options).toMatchObject({ runId: "garden-run", conversationId: expect.stringMatching(/^scheduler-/), modelProfileId: "garden-profile", openMemoryRun: expect.any(Function) });
  expect(agent.options.permissionMode).toBe("allow_all");
});
it("fails closed when the saved memory profile is unavailable", async () => {
  const prepareBackgroundRun = vi.fn();
  const runner = createSchedulerRunner({ ...dependencies(), memoryHost: { prepareBackgroundRun } } as never);
  expect(await runner.runScheduledTask(task(), new Date(), false)).toMatchObject({ ok: false, error: "MEMORY_RUN_PROFILE_DENIED" });
  expect(prepareBackgroundRun).not.toHaveBeenCalled();
  expect(agent.options).toBeUndefined();
});
it("aborts on shutdown and waits for the actual agent subscription to settle", async () => {
  let release!: () => void;
  agent.barrier = new Promise(resolve => { release = resolve; });
  const runner = createSchedulerRunner(dependencies() as never), pending = runner.runScheduledTask(task(), new Date(), false);
  await vi.waitFor(() => expect(agent.options).toBeDefined());
  let closed = false;
  const closing = runner.close().then(() => { closed = true; });
  expect(agent.options.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await pending;
  await closing;
  expect(closed).toBe(true);
});
