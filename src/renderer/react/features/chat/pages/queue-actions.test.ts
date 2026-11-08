import { expect, it, vi } from "vitest";
import type { ChatStoreApi } from "./chat-page-bridge";
import { queueActions } from "./queue-actions";

it("refreshes after removal succeeds and reports failure without refreshing", async () => {
  const pendingRemove = vi.fn().mockResolvedValueOnce({ ok: false, error: "offline" }).mockResolvedValueOnce({ ok: true });
  const sync = vi.fn();
  const error = vi.fn();
  const actions = queueActions({ getStore: () => ({ pendingRemove } as unknown as ChatStoreApi), sync, error,
    edit: vi.fn(), parse: () => ({ rawContent: "", visibleContent: "" }) });
  await actions.remove("s", "m");
  expect(error).toHaveBeenCalledWith("offline");
  expect(sync).not.toHaveBeenCalled();
  await actions.remove("s", "m");
  expect(sync).toHaveBeenCalledWith("s");
});

it("does not submit an empty edited message", async () => {
  const edit = vi.fn();
  const actions = queueActions({ getStore: () => undefined, sync: vi.fn(), error: vi.fn(), edit,
    parse: () => ({ rawContent: "", visibleContent: "" }) });
  expect(await actions.edit("s", "chat", "m", "  ")).toBe(false);
  expect(edit).not.toHaveBeenCalled();
});
