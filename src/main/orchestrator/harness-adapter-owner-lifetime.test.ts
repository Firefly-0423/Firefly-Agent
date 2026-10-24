import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { fakeLLM, paths } = vi.hoisted(() => ({ fakeLLM: vi.fn(), paths: { userData: "" } }));
vi.mock("electron", () => ({ app: {
  getPath: () => { if (!paths.userData) throw new Error("synthetic userData not ready"); return paths.userData; },
  on: () => undefined,
} }));
vi.mock("./harness/harness-llm", () => ({ callLLM: fakeLLM, summarizeHistory: vi.fn() }));
vi.mock("../permission", () => ({ getCurrentLevel: () => "full", checkPermission: vi.fn(async () => ({ allowed: true })) }));

import { runHarnessWithAdapter } from "./harness-adapter";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import { startShellJob, stopShellJob, waitForShellJob } from "./tools/builtin-tools/shell-job-manager";
import type { ToolContext } from "./tools/registry/tool-context";

beforeEach(() => {
  paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-main-owner-lifetime-"));
  fakeLLM.mockReset();
});
afterEach(() => {
  fs.rmSync(paths.userData, { recursive: true, force: true });
  paths.userData = "";
});

it("Main adapter model failure quiesces only its owned retained process before actual terminal drain", async () => {
  const external = new AbortController();
  let job: ReturnType<typeof startShellJob> | undefined;
  let context: ToolContext | undefined;
  const background: ToolDefinition = {
    id: "synthetic_main_owner_background", name: "synthetic background", description: "synthetic", enabled: true,
    risk: "safe", effectKind: "unknown", inputSchema: { type: "object", properties: {} },
    execute: async (_args, received) => {
      context = received;
      const execution = received!.execution!;
      job = startShellJob({
        spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env,
          cwd: paths.userData, windowsVerbatimArguments: false, ranViaSandbox: false },
        command: "synthetic Main retained Node process", shell: "node", logDir: paths.userData,
        executionScope: execution.scope, signal: received!.signal,
      });
      execution.coordinator.retainUntil(execution.permit!, job.completion);
      return "synthetic background launched";
    },
  };
  toolRegistry.register(background);
  const call = { id: "main-background", name: background.id, arguments: "{}" };
  fakeLLM.mockResolvedValueOnce({ assistantMessage: { role: "assistant", content: "", toolCalls: [call] },
    text: "", toolCalls: [call], finishReason: "tool_calls", raw: {} })
    .mockRejectedValueOnce(new Error("synthetic Main model failure"));
  let returned = false;
  const pending = runHarnessWithAdapter({
    runId: "synthetic-main-owner", conversationId: "synthetic-main-conversation", conversationMode: "code",
    resolvedWorkspaceRoot: paths.userData, tools: [background],
    settings: { provider: "synthetic", baseUrl: "http://127.0.0.1:1", model: "synthetic", apiKey: "" },
    messages: [{ role: "user", content: "synthetic Main background" }], toolSystemContent: "", soulSystemBaseContent: "synthetic",
    timeoutMs: 0,
  } as never, external.signal, vi.fn()).then(result => { returned = true; return result; });
  try {
    await expect.poll(() => fakeLLM.mock.calls.length).toBe(2);
    // The background tool returned before the second model request. Error terminal
    // must now stop its owned process; it must not wait for an external cancel.
    await expect.poll(() => returned).toBe(true);
    const result = await pending;
    expect(result.terminal.status).toBe("runtime_error");
    expect(context!.signal).not.toBe(external.signal);
    expect(context!.signal!.aborted).toBe(true);
    expect(external.signal.aborted).toBe(false);
    expect(context!.execution!.scope).toMatchObject({ agentId: "main", childRunId: "synthetic-main-owner", parentRunId: "synthetic-main-owner" });
    expect((await waitForShellJob(job!.jobId, 0))?.status).toBe("stopped");
    await job!.completion;
  } finally {
    if (job) { stopShellJob(job.jobId); await job.completion; }
    await pending;
    toolRegistry.unregister(background.id);
  }
});
