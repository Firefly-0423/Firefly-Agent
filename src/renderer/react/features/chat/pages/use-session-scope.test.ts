// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSessionScope } from "./use-session-scope";

it("keeps references stable and exposes the latest mode, session and draft scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let result!: ReturnType<typeof useSessionScope>;
  function Screen({ mode }: { mode: "chat" | "work" }) {
    result = useSessionScope(mode, { chat: "s" });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen, { mode: "chat" })));
    const modeRef = result.activeModeRef;
    expect(result.scopeKey).toBe("s");
    await act(async () => root.render(createElement(Screen, { mode: "work" })));
    expect(result.activeModeRef).toBe(modeRef);
    expect(modeRef.current).toBe("work");
    expect(result.activeScopeRef.current).toBe("mode:work");
    expect(result.activeSessionIdsRef.current.chat).toBe("s");
  } finally { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});
