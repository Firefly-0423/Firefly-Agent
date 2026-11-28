// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useNavigationForwarders } from "./use-navigation-forwarders";

it("preserves callback identity while forwarding to the current actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = { openProject: vi.fn(), handleRenameSession: vi.fn(), handleDeleteSession: vi.fn(), handleTogglePinSession: vi.fn() };
  const second = { openProject: vi.fn(), handleRenameSession: vi.fn(), handleDeleteSession: vi.fn(), handleTogglePinSession: vi.fn() };
  const ref = { current: first };
  let callbacks!: ReturnType<typeof useNavigationForwarders>;
  function Screen() { callbacks = useNavigationForwarders(ref); return null; }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen)));
    const open = callbacks.openProject;
    ref.current = second;
    await act(async () => root.render(createElement(Screen)));
    expect(callbacks.openProject).toBe(open);
    callbacks.rename("s", "new"); callbacks.pin("s", true); callbacks.remove("s"); open("path");
    expect(second.handleRenameSession).toHaveBeenCalledWith("s", "new");
    expect(second.handleTogglePinSession).toHaveBeenCalledWith("s", true);
    expect(second.handleDeleteSession).toHaveBeenCalledWith("s");
    expect(second.openProject).toHaveBeenCalledWith("path");
    expect(first.openProject).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});
