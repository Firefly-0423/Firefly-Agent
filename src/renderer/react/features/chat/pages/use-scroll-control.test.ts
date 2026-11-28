// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useScrollControl } from "./use-scroll-control";

it("keeps the registration stable and calls the latest scrolling function", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let control!: ReturnType<typeof useScrollControl>;
  function Screen() { control = useScrollControl(); return null; }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen)));
    const register = control.register;
    const scroll = vi.fn();
    act(() => { register(scroll); control.setVisible(true); });
    expect(control.visible).toBe(true);
    expect(control.register).toBe(register);
    control.scroll();
    expect(scroll).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});
