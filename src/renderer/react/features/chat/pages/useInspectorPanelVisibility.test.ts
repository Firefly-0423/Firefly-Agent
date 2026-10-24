// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useInspectorPanelVisibility } from "./useInspectorPanelVisibility";

const state = vi.hoisted(() => ({ panelRef: { current: null as PanelImperativeHandle | null } }));
vi.mock("react-resizable-panels", () => ({ usePanelRef: () => state.panelRef }));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); state.panelRef.current = null; });

it("waits for the actual group layout before expanding a newly registered inspector", () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let ready = false;
  const expand = vi.fn(() => { if (!ready) throw new Error("Panel constraints not found for Panel inspector"); });
  const collapse = vi.fn();
  const panel = { expand, collapse, getSize: vi.fn(), isCollapsed: vi.fn(), resize: vi.fn() };
  state.panelRef.current = panel;
  let handle!: ReturnType<typeof useInspectorPanelVisibility>;
  function Harness({ visible }: { visible: boolean }) { handle = useInspectorPanelVisibility(visible); return null; }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  act(() => root.render(createElement(Harness, { visible: true })));
  expect(expand).not.toHaveBeenCalled();
  ready = true;
  act(() => handle.onLayoutChange({ chat: 60, inspector: 40 }));
  expect(expand).toHaveBeenCalledOnce();
  act(() => root.render(createElement(Harness, { visible: false })));
  expect(collapse).toHaveBeenCalledOnce();
  act(() => handle.onLayoutChange({ chat: 100 }));
  const replacement = { ...panel, expand: vi.fn() };
  state.panelRef.current = replacement;
  act(() => root.render(createElement(Harness, { visible: true })));
  expect(replacement.expand).not.toHaveBeenCalled();
  act(() => handle.onLayoutChange({ chat: 60, inspector: 40 }));
  expect(replacement.expand).toHaveBeenCalledOnce();
});

it("retries incomplete live registration without reopening a user-collapsed layout", () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const expand = vi.fn(), collapse = vi.fn();
  const panel = { expand, collapse, getSize: vi.fn(), isCollapsed: vi.fn(), resize: vi.fn() };
  state.panelRef.current = panel;
  let liveLayout: Record<string, number> | undefined;
  const groupRef = { current: { getLayout: () => liveLayout } } as any;
  let handle!: ReturnType<typeof useInspectorPanelVisibility>;
  function Harness({ visible }: { visible: boolean }) { handle = useInspectorPanelVisibility(visible, groupRef); return null; }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  act(() => root.render(createElement(Harness, { visible: true })));
  act(() => handle.onLayoutChange({ chat: 60, inspector: 40 }));
  expect(expand).not.toHaveBeenCalled();
  liveLayout = { chat: 100, inspector: 0 };
  act(() => handle.onLayoutChange(liveLayout!));
  expect(expand).toHaveBeenCalledOnce();
  act(() => handle.onLayoutChange({ chat: 100, inspector: 0 }));
  expect(expand).toHaveBeenCalledOnce();
  liveLayout = undefined;
  act(() => root.render(createElement(Harness, { visible: false })));
  expect(collapse).not.toHaveBeenCalled();
  liveLayout = { chat: 100, inspector: 0 };
  act(() => handle.onLayoutChange(liveLayout!));
  expect(collapse).toHaveBeenCalledOnce();
});
