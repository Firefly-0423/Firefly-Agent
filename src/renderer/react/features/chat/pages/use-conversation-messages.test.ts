// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

type Feed = { getActiveSessionId(): string | undefined; persistMessage(sessionId: string, message: unknown): void };
const listeners = vi.hoisted(() => ({ scheduler: undefined as Feed | undefined, mirror: undefined as Feed | undefined }));
vi.mock("../hooks/useSchedulerEvents", () => ({ useSchedulerEvents: (host: Feed) => { listeners.scheduler = host; } }));
vi.mock("../hooks/useChannelMirrorEvents", () => ({ useChannelMirrorEvents: (host: Feed) => { listeners.mirror = host; } }));
import { useConversationMessages } from "./use-conversation-messages";

it("routes both incoming feeds to the latest active session and persists scheduled messages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const append = vi.fn();
  vi.stubGlobal("chatStore", { append });
  let active = "one";
  function Screen() { useConversationMessages(() => active, () => "chat"); return null; }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen)));
    active = "two";
    expect(listeners.scheduler!.getActiveSessionId()).toBe("two");
    expect(listeners.mirror!.getActiveSessionId()).toBe("two");
    const message = { id: "m", role: "user", content: "hello", at: 1 };
    listeners.scheduler!.persistMessage("two", message);
    expect(append).toHaveBeenCalledWith("two", message);
  } finally { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});
