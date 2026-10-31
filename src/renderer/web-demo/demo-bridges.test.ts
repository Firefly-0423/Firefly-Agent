// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMode } from "../../shared/chat-types";
import type { CodeGitStatus } from "../../shared/code-git-types";
import type { AguiApi, AguiEvent, ChatStoreApi, PermissionApprovalRequest, SettingsApprovalApi } from "../react/features/chat/pages/chat-page-bridge";
import { installDemoBridges, scriptSteps } from "./demo-bridges";
import { demoTurn, type DemoLang } from "./demo-content";

type DemoWindow = Window & { chatStore: ChatStoreApi; agui: AguiApi; settings: SettingsApprovalApi; codeGit: { getStatus(id: string): Promise<CodeGitStatus> } };
const demo = () => window as unknown as DemoWindow;

describe("demo scripts", () => {
  for (const lang of ["zh", "en"] as DemoLang[]) for (const mode of ["chat", "work", "code"] as ConversationMode[]) for (const turn of [0, 1, 5]) {
    it(`${lang} ${mode} turn ${turn} starts, pairs every tool call and finishes successfully`, () => {
      const steps = scriptSteps(demoTurn(mode, turn, lang), "run-1", 3);
      const events = steps.flatMap(step => step.kind === "event" ? [step.event] : []);
      expect(events[0]?.type).toBe("RUN_STARTED");
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { status: "success" } });
      const started = events.filter(event => event.type === "TOOL_CALL_START").map(event => event.toolCallId);
      expect(events.filter(event => event.type === "TOOL_CALL_END").map(event => event.toolCallId)).toEqual(started);
      expect(events.every(event => event.runId === "run-1")).toBe(true);
      const approvals = steps.filter(step => step.kind === "approval");
      for (const approval of approvals) expect(started).toContain(approval.toolCallId);
    });
  }
});

describe("demo bridges", () => {
  const network = { fetch: vi.fn(), open: vi.fn(), socket: vi.fn() };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", network.fetch);
    vi.stubGlobal("WebSocket", network.socket);
    vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(network.open);
    installDemoBridges("zh");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(network.fetch).not.toHaveBeenCalled();
    expect(network.socket).not.toHaveBeenCalled();
    expect(network.open).not.toHaveBeenCalled();
  });

  async function runToEnd(sessionId: string, answer: (request: PermissionApprovalRequest) => boolean) {
    const events: AguiEvent[] = [];
    demo().agui.onEvent(event => events.push(event));
    demo().settings.onPermissionApprovalRequest(request => { void demo().settings.resolvePermissionApproval(request.id, answer(request)); });
    const started = await demo().agui.run({ sessionId, assistantTurnId: "a", userTurnId: "u", messages: [] });
    expect(started.success).toBe(true);
    for (let tick = 0; tick < 400 && !events.some(event => event.type === "RUN_FINISHED"); tick++) await vi.advanceTimersByTimeAsync(100);
    return events;
  }

  it("lists one sample conversation per mode", async () => {
    for (const mode of ["chat", "work", "code"] as ConversationMode[]) {
      const listed = await demo().chatStore.list({ mode });
      expect(listed.map(entry => entry.mode)).toEqual([mode]);
    }
  });

  it("plays a Code run through both approvals, and the Git summary shows the changed file", async () => {
    expect((await demo().codeGit.getStatus("demo-code")).files).toEqual([]);
    const asked: string[] = [];
    const events = await runToEnd("demo-code", request => { asked.push(request.risk); return true; });
    expect(asked).toEqual(["fs-write", "shell"]);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { status: "success" } });
    expect(events.some(event => event.type === "CUSTOM" && event.name === "firefly.context.usage")).toBe(true);
    const status = await demo().codeGit.getStatus("demo-code");
    expect(status.files).toMatchObject([{ path: "src/main.rs", kind: "modified", insertions: 6, deletions: 1 }]);
    expect(status.branch?.current).toBe("main");
  });

  it("stops at a declined step: the tool fails, nothing is recorded as changed, and the run still finishes", async () => {
    const events = await runToEnd("demo-code", () => false);
    expect(events.find(event => event.type === "TOOL_CALL_RESULT" && event.status === "failed")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect((await demo().codeGit.getStatus("demo-code")).files).toEqual([]);
  });

  it("refuses desktop-only actions instead of pretending they worked", async () => {
    expect(await demo().chatStore.pickWorkspaceFolder()).toMatchObject({ ok: false });
    expect(await demo().chatStore.exportWorkMarkdown("demo-work")).toMatchObject({ ok: false });
  });
});
