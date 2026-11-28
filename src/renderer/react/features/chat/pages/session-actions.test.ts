import { expect, it, vi } from "vitest";
import { sessionActions } from "./session-actions";
import type { ChatStoreApi } from "./chat-page-bridge";

it("trims names, ignores empty names, and only reselects after successful deletion", async () => {
  const store = { rename: vi.fn().mockResolvedValue(null), delete: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), setPinned: vi.fn().mockResolvedValue(null) } as unknown as ChatStoreApi;
  const refresh = vi.fn();
  const actions = sessionActions(() => store, refresh);
  await actions.rename("chat", "s", "   ");
  expect(store.rename).not.toHaveBeenCalled();
  await actions.rename("chat", "s", "  name  ");
  expect(store.rename).toHaveBeenCalledWith("s", "name");
  await actions.remove("work", "s");
  await actions.remove("work", "s");
  await actions.pin("code", "s", true);
  expect(refresh.mock.calls).toEqual([["chat", false], ["work", true], ["code", false]]);
});
