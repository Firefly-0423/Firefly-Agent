import { expect, it, vi } from "vitest";
import type { ChatSession } from "../../../../../shared/chat-types";
import { reviseLastTurn } from "./last-turn-revision";

function fixture() {
  const session = { id: "s", mode: "chat", title: "x", identityId: null, createdAt: 0, updatedAt: 0,
    messages: [{ id: "u", role: "user", content: "old", at: 1 }, { id: "a", role: "model", content: "answer", at: 2 }] } as ChatSession;
  const store = { get: vi.fn(async () => session), replaceTail: vi.fn(async (_id, _index, rows) => ({ ...session, messages: rows })) };
  return { store, publish: vi.fn(), start: vi.fn(), newId: () => "fresh", now: () => 42 };
}

it("rechecks persisted message identities before changing the tail", async () => {
  const host = fixture();
  expect(await reviseLastTurn({ sessionId: "s", userId: "stale", assistantId: "a", disposition: "keep_user" }, host)).toBe(false);
  expect(host.store.replaceTail).not.toHaveBeenCalled();
  expect(host.start).not.toHaveBeenCalled();
});

it("trims an edit, persists it, and dispatches a rewind anchored at the original user turn", async () => {
  const host = fixture();
  expect(await reviseLastTurn({ sessionId: "s", userId: "u", assistantId: "a", disposition: "replace_user", content: "  revised  " }, host)).toBe(true);
  expect(host.store.replaceTail).toHaveBeenCalledWith("s", 0, [expect.objectContaining({ id: "u", content: "revised", at: 42 })]);
  expect(host.start).toHaveBeenCalledWith(expect.objectContaining({ assistantId: "fresh", transcriptRewind: { anchorUserTurnId: "u", disposition: "replace_user" } }));
  expect(host.publish).toHaveBeenCalledOnce();
});

it("refuses a whitespace-only edit before writing", async () => {
  const host = fixture();
  expect(await reviseLastTurn({ sessionId: "s", userId: "u", assistantId: "a", disposition: "replace_user", content: "  " }, host)).toBe(false);
  expect(host.store.replaceTail).not.toHaveBeenCalled();
});
