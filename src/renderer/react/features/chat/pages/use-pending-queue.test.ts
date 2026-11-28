// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ChatStoreApi } from "./chat-page-bridge";
import type { PendingQueueFlowHost } from "./pending-queue-flow";
import { usePendingQueue } from "./use-pending-queue";

it("keeps a stable flow while reconciling a session queue and its removal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const row = { id: "m", rawContent: "hello", visibleContent: "hello", enqueuedAt: 1 };
  const pendingList = vi.fn().mockResolvedValue([row]);
  const host = { getStore: () => ({ pendingList } as unknown as ChatStoreApi), isSessionBusy: () => false,
    hasRenderedMessage: () => false, appendMessages: vi.fn(), prepareImageAttachments: vi.fn(),
    refreshSessions: vi.fn(), startRun: vi.fn(), reportError: vi.fn() } as Omit<PendingQueueFlowHost, "replaceProjection">;
  let page!: ReturnType<typeof usePendingQueue>;
  function Screen() { page = usePendingQueue(host); return null; }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Screen)));
    const flow = page.flow;
    await act(async () => flow.syncProjection("s"));
    expect(page.queues.s).toEqual([row]);
    expect(page.flow).toBe(flow);
    pendingList.mockResolvedValue(null);
    await act(async () => flow.syncProjection("s"));
    expect(page.queues.s).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  }
});
