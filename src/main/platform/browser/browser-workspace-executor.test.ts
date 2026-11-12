import { expect, it, vi } from "vitest";
import { createBrowserWorkspaceExecutor } from "./browser-workspace-executor";
import type { TrustedBrowserOwner } from "./browser-service";

it("rejects window workspace DTOs at the Agent executor boundary", async () => {
  const signal = new AbortController().signal;
  const owner = { conversationId: "conversation", signal } as TrustedBrowserOwner;
  const executeAgent = vi.fn(async () => ({ ok: true as const, value: {
    browserId: "manual", conversationId: null, workspaceId: "window", requestId: 1,
    closed: false, loading: false, url: "https://example.com/", pendingUrl: null,
    canGoBack: false, canGoForward: false, error: null,
  } }));
  const execute = createBrowserWorkspaceExecutor({ currentOwner: () => owner,
    service: () => ({ executeAgent }), isRunCurrent: () => true });
  expect(await execute({ operation: "open" }, { userQuery: "", conversationId: "conversation", runId: "run", signal }))
    .toEqual({ ok: false, code: "owner_mismatch" });
});
