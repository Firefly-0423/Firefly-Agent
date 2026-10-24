// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelConnectionSnapshot } from "../../../../../shared/model-connection-types";
import { setUiLocale, t } from "../../../i18n";
import { ChatPageNavigation, type ChatPageNavigationProps } from "./ChatPageNavigation";

vi.mock("./AppUpdateEntry", () => ({ AppUpdateEntry: () => null }));
vi.mock("./ConversationSidebar", () => ({ ConversationSidebar: () => null }));

let root: Root;
let host: HTMLDivElement;
let changed: ((snapshot: ModelConnectionSnapshot) => void) | undefined;
let snapshot: ModelConnectionSnapshot;
let getSnapshot: ReturnType<typeof vi.fn>;
const openApiSettings = vi.fn();
const testConnection = vi.fn();
const props: ChatPageNavigationProps = {
  collapsed: true, activePanel: null, mode: "chat", sessions: [], sessionListStatus: "ready",
  onToggleCollapsed() {}, onModeChange() {}, onNewTask() {}, onTogglePanel() {}, onSelectSession() {},
  onOpenProject() {}, onRenameSession() {}, onDeleteSession() {}, onTogglePinSession() {}, onExportSession() {},
  onMinimize() {}, onMaximize() {}, onCloseWindow() {}, onOpenSettings() {},
};
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setUiLocale("zh-CN");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  snapshot = { defaultProfileId: "default", profiles: [
    { profileId: "default", revision: 1, state: "connected", checkedAt: 1_791_000_000_000 },
    { profileId: "selected", revision: 2, state: "unverified" },
  ] };
  getSnapshot = vi.fn(async () => snapshot);
  Object.assign(window, { modelConfig: {
    getConnectionSnapshot: getSnapshot,
    onConnectionChanged(callback: (value: ModelConnectionSnapshot) => void) {
      changed = callback;
      return () => { changed = undefined; };
    },
  }, settings: { testConnection } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  delete window.modelConfig;
  delete (window as unknown as { settings?: unknown }).settings;
});
async function render(activeModelProfileId?: string) {
  await act(async () => root.render(React.createElement(ChatPageNavigation, {
    ...props, activeModelProfileId, onOpenApiSettings: openApiSettings,
  })));
}
function lamp() {
  const node = host.querySelector<HTMLButtonElement>(".ff-model-connection");
  expect(node, "a real snapshot indicator remains in the persistent rail").not.toBeNull();
  return node!;
}

it("uses the selected saved profile, then the effective default or first fallback", async () => {
  await render("selected");
  expect(lamp().dataset.state).toBe("unverified");
  expect(lamp().title).toContain(t("ui.connectionUnverified"));
  expect(host.querySelector(".ff-page-sidebar")?.contains(lamp())).toBe(false);
  await render("default");
  expect(lamp().dataset.state).toBe("connected");
  await render("deleted-selection");
  expect(lamp().dataset.state).toBe("connected");
  act(() => changed!({ defaultProfileId: "deleted-default", profiles: [{ profileId: "first", revision: 4, state: "failed", reason: "test_failed" }] }));
  expect(lamp().dataset.state).toBe("failed");
  expect(lamp().title).toContain(t("ui.connectionTestFailed"));
});

it("shows checking, failure reason/time and save invalidation from actual bridge events", async () => {
  await render("selected");
  act(() => changed!({ profiles: [{ profileId: "selected", revision: 3, state: "checking" }] }));
  expect(lamp().dataset.state).toBe("checking");
  expect(lamp().title).toContain(t("ui.connectionChecking"));
  act(() => changed!({ profiles: [{ profileId: "selected", revision: 3, state: "failed", checkedAt: 1_791_000_000_000, reason: "test_error" }] }));
  expect(lamp().title).toContain(t("ui.connectionTestError"));
  expect(lamp().title).toContain(t("ui.connectionCheckedAt", { time: new Date(1_791_000_000_000).toLocaleString("zh-CN") }));
  act(() => changed!({ profiles: [{ profileId: "selected", revision: 4, state: "unverified" }] }));
  expect(lamp().dataset.state).toBe("unverified");
  expect(lamp().title).not.toContain(t("ui.connectionTestError"));
  expect(getSnapshot).toHaveBeenCalledOnce();
  expect(testConnection).not.toHaveBeenCalled();
});

it("keeps a newer event when the initial snapshot request completes late", async () => {
  let resolveRead!: (value: ModelConnectionSnapshot) => void;
  getSnapshot.mockImplementation(() => new Promise<ModelConnectionSnapshot>(resolve => { resolveRead = resolve; }));
  await render("selected");
  act(() => changed!({ profiles: [{ profileId: "selected", revision: 8, state: "unverified" }] }));
  await act(async () => resolveRead({ profiles: [{ profileId: "selected", revision: 7, state: "connected" }] }));
  expect(lamp().dataset.state).toBe("unverified");
});

it("opens API Settings without testing a provider and translates accessible status", async () => {
  await render("default");
  act(() => setUiLocale("en"));
  expect(lamp().getAttribute("aria-label")).toContain("Last test passed");
  expect(lamp().title).toContain("last manual connection test");
  act(() => lamp().click());
  expect(openApiSettings).toHaveBeenCalledOnce();
  expect(testConnection).not.toHaveBeenCalled();
});

it("stays gray for empty, missing bridge, rejected read or unknown state", async () => {
  snapshot = { profiles: [] };
  await render();
  expect(lamp().dataset.state).toBe("unverified");
  act(() => changed!({ profiles: [{ profileId: "fixture", revision: 1, state: "future-state" }] } as unknown as ModelConnectionSnapshot));
  expect(lamp().dataset.state).toBe("unverified");
  act(() => root.unmount());
  expect(changed).toBeUndefined();
  root = createRoot(host);
  getSnapshot.mockRejectedValueOnce(new Error("fixture IPC unavailable"));
  await render();
  expect(lamp().dataset.state).toBe("unverified");
  act(() => root.unmount()); root = createRoot(host); delete window.modelConfig;
  await render();
  expect(lamp().dataset.state).toBe("unverified");
});
