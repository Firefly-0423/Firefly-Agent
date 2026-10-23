import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({ root: "", run: vi.fn(), permission: vi.fn(), lookup: vi.fn() }));
vi.mock("./harness", async original => ({ ...await original<typeof import("./harness")>(), runFireflyHarness: services.run }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [], getById: services.lookup } }));
vi.mock("../permission", () => ({ checkPermission: services.permission, getCurrentLevel: () => "read-only" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "Fixture execution instructions" }));
vi.mock("electron", () => ({ app: { getPath: () => services.root } }));
import { runHarnessWithAdapter } from "./harness-adapter";
import type { HarnessInput } from "./harness";

beforeAll(() => { services.root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-owned-signal-")); });
afterAll(() => { fs.rmSync(services.root, { recursive: true, force: true }); });
beforeEach(() => {
  services.run.mockReset(); services.permission.mockReset(); services.lookup.mockReset();
  services.run.mockResolvedValue({ finalAnswer: "Finished audit", finalState: { uncertainEffects: [], todoItems: [] }, terminated: true, rounds: 1 });
});
const settings = { provider: "custom", baseUrl: "https://fixture.invalid", apiKey: "", model: "fixture", contextWindowTokens: 96000 };
const options = (runId: string) => ({ runId, settings, messages: [{ role: "user", content: "Inspect the workspace" }], timeoutMs: 45000, toolSystemContent: "", soulSystemBaseContent: "", executionMode: "work" });

describe("Adapter ownership of cancellation and approval", () => {
  it("shares its owned signal across tools, permission and clarification, without aborting its caller", async () => {
    const caller = new AbortController(), clarify = vi.fn(async () => ({ answers: [] }));
    services.lookup.mockReturnValue({ id: "read_file", name: "Read document", description: "Inspect a document", risk: "safe" });
    services.permission.mockResolvedValue({ allowed: true });
    await runHarnessWithAdapter({ ...options("signal-ochre"), requestUserClarification: clarify } as never, caller.signal, vi.fn());
    const input = services.run.mock.calls[0][0] as HarnessInput;
    expect(input.signal).not.toBe(caller.signal);
    expect(input.toolContext?.signal).toBe(input.signal);
    expect(input.quiesceExecution).toEqual(expect.any(Function));
    await input.checkPermission!("read_file", { path: "inventory.md" });
    expect(services.permission).toHaveBeenCalledWith(expect.objectContaining({ runId: "signal-ochre", signal: input.signal }));
    await input.requestUserClarification!({ question: "Continue the audit?" });
    expect(clarify).toHaveBeenCalledExactlyOnceWith({ question: "Continue the audit?" }, input.signal);
    input.quiesceExecution!();
    expect(input.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("forwards noninteractive allow-all policy without opening an approval request", async () => {
    services.lookup.mockReturnValue({ id: "write_file", name: "Write document", description: "Save a document", risk: "dangerous" });
    await runHarnessWithAdapter({ ...options("mobile-ochre"), harnessInteractiveTools: false, permissionMode: "allow_all" } as never, new AbortController().signal, vi.fn());
    const input = services.run.mock.calls[0][0] as HarnessInput;
    expect(input.includeInteractiveTools).toBe(false);
    expect(input.toolContext?.permissionMode).toBe("allow_all");
    await expect(input.checkPermission!("write_file", { path: "inventory.md" })).resolves.toBe(true);
    expect(services.permission).not.toHaveBeenCalled();
  });
});
