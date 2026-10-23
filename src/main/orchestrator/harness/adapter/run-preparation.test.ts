import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const collaborators = vi.hoisted(() => ({
  plan: vi.fn(), layers: vi.fn(), transcript: vi.fn(), create: vi.fn(), lookup: vi.fn(), recover: vi.fn(), enabled: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "D:\\isolated-profile") } }));
vi.mock("./plan-lifecycle", () => ({ preparePlanRunContext: collaborators.plan }));
vi.mock("./prompt-builder", () => ({ buildHarnessPromptLayers: collaborators.layers, materializeHarnessStartTranscript: collaborators.transcript }));
vi.mock("../run-store", () => ({ getHarnessRunStore: () => ({ create: collaborators.create, get: collaborators.lookup }) }));
vi.mock("../run-recovery", () => ({ prepareHarnessRecovery: collaborators.recover }));
vi.mock("../../tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: collaborators.enabled } }));
import { prepareHarnessRun } from "./run-preparation";

beforeEach(() => {
  vi.resetAllMocks();
  collaborators.plan.mockResolvedValue({ planState: undefined });
  collaborators.layers.mockReturnValue({ stablePrefix: "Reusable system layer", runtimeContext: "Current workspace", mode: "work" });
  collaborators.transcript.mockImplementation(({ messages }) => [...messages, { role: "user", content: "Prepared runtime facts" }]);
  collaborators.enabled.mockReturnValue([]);
});

const options = () => ({
  runId: "preflight-copper", conversationId: "thread-copper", conversationMode: "work",
  settings: { provider: "custom", baseUrl: "https://model.invalid/v1", model: "test-model", apiKey: "" },
  messages: [{ role: "user", content: "Audit this workspace" }], toolSystemContent: "", soulSystemBaseContent: "Project persona",
});

describe("Run preparation persistence boundary", () => {
  it("materializes runtime facts before persisting the final transcript and static prompt identity", async () => {
    const prepared = await prepareHarnessRun(options() as never, new AbortController().signal);
    expect(collaborators.transcript.mock.invocationCallOrder[0]).toBeLessThan(collaborators.create.mock.invocationCallOrder[0]);
    expect(collaborators.create).toHaveBeenCalledTimes(1);
    expect(prepared.runId).toEqual("preflight-copper");
    expect(prepared.systemPrompt).toEqual("Reusable system layer");
    expect(prepared.runMessages).toEqual([
      { role: "user", content: "Audit this workspace" }, { role: "user", content: "Prepared runtime facts" },
    ]);
    expect(collaborators.create).toHaveBeenCalledWith({
      conversationId: "thread-copper", runId: "preflight-copper", messages: prepared.runMessages,
      request: {
        provider: "custom", model: "test-model", contextWindowTokens: undefined, mode: "work",
        promptFingerprint: createHash("sha256").update(JSON.stringify("Reusable system layer")).digest("hex"),
        toolSchemaFingerprint: createHash("sha256").update("[]").digest("hex"), enabledToolIds: [],
      },
    });
    expect(prepared.harnessPromptLayers).toEqual({ stablePrefix: "Reusable system layer", mode: "work" });
  });

  it("rejects an unidentified run before touching plan state or the store", async () => {
    await expect(prepareHarnessRun({ ...options(), runId: "" } as never, new AbortController().signal)).rejects.toThrow(
      "[HarnessAdapter] options.runId is required. FireflyAgent.runWithEvents must populate it before invoking the adapter.",
    );
    expect(collaborators.plan).not.toHaveBeenCalled();
    expect(collaborators.create).not.toHaveBeenCalled();
  });
});
