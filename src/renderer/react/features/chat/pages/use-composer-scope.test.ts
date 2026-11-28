// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ options: undefined as { scopeKey: string; getActiveScope(): string } | undefined }));
vi.mock("../hooks/useComposerAttachments", () => ({ useComposerAttachments: (options: typeof seen.options) => { seen.options = options; return { attachments: [] }; } }));
import { useComposerScope } from "./use-composer-scope";

it("selects only the active conversation's draft, messages and interaction", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let result!: ReturnType<typeof useComposerScope>;
  const scope = { current: "s" };
  function Screen() {
    result = useComposerScope({ sessionId: "s", scopeKey: "s", activeScope: scope,
      drafts: { s: "draft" }, messages: { s: [{ id: "m", role: "user", content: "hello" }] },
      interactions: {}, patchAttachments: vi.fn() });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen)));
    expect(result.draft).toBe("draft");
    expect(result.messages).toHaveLength(1);
    expect(result.hasMessages).toBe(true);
    expect(result.interactionPending).toBe(0);
    scope.current = "other";
    expect(seen.options!.getActiveScope()).toBe("other");
  } finally { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});
