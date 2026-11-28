import { expect, it, vi } from "vitest";
import type { AgentRunDeps, AgentRunInput } from "./run/AgentRunController";

const captured = vi.hoisted(() => ({ calls: [] as unknown[][], start: vi.fn(async () => {}) }));
vi.mock("./run/AgentRunController", () => ({ AgentRunController: class {
  constructor(...args: unknown[]) { captured.calls.push(args); }
  start = captured.start;
} }));
import { startAgentRun } from "./start-agent-run";

it("binds the current renderer bridges to the supplied host and starts once", async () => {
  const api = {}, store = {};
  vi.stubGlobal("window", { agui: api, chatStore: store });
  captured.calls.length = 0; captured.start.mockClear();
  const input = {} as AgentRunInput;
  const ports = { host: {}, registries: {}, startRun: vi.fn() } as unknown as Omit<AgentRunDeps, "api" | "store">;
  try {
    await startAgentRun(input, ports);
    expect(captured.calls).toEqual([[input, { ...ports, api, store }]]);
    expect(captured.start).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
