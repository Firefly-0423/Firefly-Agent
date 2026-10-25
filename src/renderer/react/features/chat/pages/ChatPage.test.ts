// @vitest-environment jsdom
import React, { act, createElement as element, useRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../../../shared/chat-types";
import type { ChatStoreApi } from "./chat-page-bridge";
import type { AgentRunInput } from "./run/AgentRunController";
import type { ChatMessageList } from "../components/ChatMessageList";
import type { ChatComposer } from "../components/ChatComposer";
import type { ChatPageNavigation } from "../components/ChatPageNavigation";
import { shouldListenForDeferredPlanEvents } from "./conversation-run-policy";
import { t } from "../../../i18n";

const surface = vi.hoisted(() => ({
  list: undefined as ComponentProps<typeof ChatMessageList> | undefined,
  composer: undefined as ComponentProps<typeof ChatComposer> | undefined,
  navigation: undefined as ComponentProps<typeof ChatPageNavigation> | undefined,
  runs: [] as AgentRunInput[],
  notice: vi.fn(), alert: vi.fn(async () => {}), confirm: vi.fn(async () => true),
}));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ notice: surface.notice, alert: surface.alert, confirm: surface.confirm }) }));
vi.mock("./run/AgentRunController", () => ({ AgentRunController: class {
  constructor(input: AgentRunInput) { surface.runs.push(input); }
  async start() {}
} }));
vi.mock("react-resizable-panels", () => ({
  Group: (props: { children: React.ReactNode; elementRef: React.Ref<HTMLDivElement> }) => element("div", { ref: props.elementRef }, props.children),
  Panel: (props: { children: React.ReactNode }) => element("div", null, props.children),
  Separator: () => null, useDefaultLayout: () => ({}), usePanelRef: () => useRef({ expand() {}, collapse() {} }),
}));
vi.mock("../components/ChatMessageList", () => ({ ChatMessageList: (props: ComponentProps<typeof ChatMessageList>) => { surface.list = props; return element("output", { "data-transcript": true }, props.messages.map(message => message.content).join("|")); } }));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: (props: ComponentProps<typeof ChatComposer>) => { surface.composer = props; return null; },
  parseComposerMessage: (_mode: string, text: string) => ({ rawContent: text, visibleContent: text }),
}));
vi.mock("../components/ChatPageNavigation", () => ({ ChatPageNavigation: (props: ComponentProps<typeof ChatPageNavigation>) => {
  surface.navigation = props;
  return element("nav", null,
    element("button", { id: "preferences", onClick: props.onOpenSettings }, "Preferences"),
    element("button", { id: "schedule", onClick: () => props.onTogglePanel("scheduled") }, "Scheduled tasks"));
} }));
vi.mock("../components/ChatPagePanelHost", () => ({ ChatPagePanelHost: ({ panel }: { panel: string }) => element("section", { "data-panel": panel }, panel) }));
vi.mock("../components/CodeRain", () => ({ CodeRain: () => null }));
vi.mock("../components/ChatPageInspector", () => ({ ChatPageInspector: () => null }));
import { ChatPage } from "./ChatPage";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
async function page(mode: "chat" | "code" = "chat") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })));
  const browserAlert = vi.spyOn(window, "alert").mockImplementation(() => {});
  const browserConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  localStorage.clear(); localStorage.setItem("firefly-react-last-mode", mode);
  surface.runs = []; surface.list = undefined; surface.composer = undefined; surface.navigation = undefined;
  surface.notice.mockClear(); surface.alert.mockClear(); surface.confirm.mockClear();
  const session: ChatSession = { id: "revision-session", mode, title: "Revision example", identityId: null, createdAt: 5, updatedAt: 5, messageCount: 2, messages: [
    { id: "original-question", role: "user", content: "Original question", at: 2 },
    { id: "original-answer", role: "model", content: "Original answer", at: 3 },
  ] };
  const replace = vi.fn(async (_id: string, offset: number, rows: ChatMessage[]) => { session.messages = [...session.messages.slice(0, offset), ...rows]; return session; });
  const openSettings = vi.fn(); vi.stubGlobal("sidebar", { openSettings });
  const store = {
    list: vi.fn(async (options?: { mode?: string }) => options?.mode === mode ? [session] : []),
    get: vi.fn(async () => session), replaceTail: replace,
    setActiveSession: vi.fn(async () => {}), pendingList: vi.fn(async () => []), pendingClaim: vi.fn(async () => ({ ok: true, claimed: false })),
    onChanged: () => () => {}, onReactSwitchSession: () => () => {}, notifyReactReady() {}, getRendererTargetId: () => "page-contracts",
    exportWorkMarkdown: vi.fn(async () => ({ ok: false, canceled: false })),
    pickWorkspaceFolder: vi.fn(async () => ({ ok: true, path: "C:/project", displayName: "Project" })),
    setWorkspace: vi.fn(async () => ({ ok: false, error: "fixture workspace failure" })),
  };
  vi.stubGlobal("chatStore", store as unknown as ChatStoreApi);
  const container = document.body.appendChild(document.createElement("article")); const renderer = createRoot(container);
  dispose = async () => { await act(async () => renderer.unmount()); container.remove(); };
  await act(async () => renderer.render(element(ChatPage)));
  expect(container.querySelector("header h1")?.textContent).toBe("Revision example");
  return { container, store, replace, openSettings, browserAlert, browserConfirm };
}

test.each([["code", true], ["chat", true], ["work", false], ["learn", false]] as const)("deferred plan subscription in %s is %s", (mode, enabled) => {
  expect(shouldListenForDeferredPlanEvents(mode)).toBe(enabled);
});
test("the rail preferences action requests General exactly once", async () => {
  const view = await page(); await act(async () => view.container.querySelector<HTMLButtonElement>("#preferences")!.click());
  expect(view.openSettings.mock.calls).toEqual([["general"]]);
});
test("scheduled tasks toggle a main-window panel without opening any settings section", async () => {
  const view = await page();
  expect(surface.navigation).not.toHaveProperty("onOpenScheduledTasks");
  await act(async () => view.container.querySelector<HTMLButtonElement>("#schedule")!.click());
  expect(view.container.querySelector('[data-panel="scheduled"]')).not.toBeNull();
  expect(view.openSettings.mock.calls).toEqual([]);
  await act(async () => view.container.querySelector<HTMLButtonElement>("#schedule")!.click());
  expect(view.container.querySelector('[data-panel="scheduled"]')).toBeNull();
});
test("short export failures use error notices through feedback", async () => {
  const view = await page(); await act(async () => surface.navigation!.onExportSession("revision-session"));
  expect(surface.notice).toHaveBeenCalledWith({ tone: "error", message: t("sidebar.exportFailed") });
  expect(view.browserAlert.mock.calls).toEqual([]); expect(view.browserConfirm.mock.calls).toEqual([]);
});
test("a project created from the sidebar dialog unlocks the composer for its first task", async () => {
  await page("code");
  await act(async () => surface.navigation!.onNewProjectTask!("E:/demo-workspace", "demo-workspace"));
  expect(surface.composer!.workspaceName).toBe("demo-workspace");
});
test("workspace failures use a readable feedback alert", async () => {
  const view = await page("code"); await act(async () => surface.composer!.onChooseWorkspace?.());
  expect(surface.alert).toHaveBeenCalledWith({ tone: "error", title: t("chatPage.setWorkspaceFailedTitle"), message: t("chatPage.setWorkspaceFailed", { error: "fixture workspace failure" }) });
  expect(view.browserAlert.mock.calls).toEqual([]); expect(view.browserConfirm.mock.calls).toEqual([]);
});
test.each(["edit", "regenerate"] as const)("%s dispatches the original user id as its transcript rewind anchor", async action => {
  const view = await page(); let accepted: boolean | undefined;
  await act(async () => { accepted = action === "edit"
    ? await surface.list!.onEditLastUserMessage!("original-question", "Edited question")
    : await surface.list!.onRegenerateLastResponse!("original-question", "original-answer"); });
  expect(accepted).toBe(true); expect(view.replace).toHaveBeenCalledTimes(1);
  expect(view.replace.mock.calls[0]).toEqual(["revision-session", 0, [expect.objectContaining({ id: "original-question", role: "user", content: action === "edit" ? "Edited question" : "Original question" })]]);
  expect(surface.runs).toHaveLength(1);
  expect(surface.runs[0]).toMatchObject({ targetMode: "chat", sessionId: "revision-session", userMessageId: "original-question", transcriptRewind: { anchorUserTurnId: "original-question", disposition: action === "edit" ? "replace_user" : "keep_user" } });
});
