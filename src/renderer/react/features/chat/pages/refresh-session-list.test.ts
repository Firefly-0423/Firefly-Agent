import { expect, it, vi } from "vitest";
import { refreshSessionList } from "./refresh-session-list";

it("ignores stale responses and keeps the selected session when still present", async () => {
  const list = vi.fn(async () => [{ id: "a" }, { id: "b" }]);
  const apply = vi.fn(), select = vi.fn(), clear = vi.fn();
  const host = { list, generation: () => 2, active: () => "b", apply, select, clear };
  await refreshSessionList("chat", true, 1, host);
  expect(apply).not.toHaveBeenCalled();
  await refreshSessionList("chat", true, 2, host);
  expect(select).toHaveBeenCalledWith("b", "chat", 2);
  expect(clear).not.toHaveBeenCalled();
});

it("clears the selected session only when selection was requested and the list is empty", async () => {
  const apply = vi.fn(), select = vi.fn(), clear = vi.fn();
  const host = { list: vi.fn(async () => []), generation: () => 0, active: () => undefined, apply, select, clear };
  await refreshSessionList("work", false, undefined, host);
  expect(clear).not.toHaveBeenCalled();
  await refreshSessionList("work", true, undefined, host);
  expect(clear).toHaveBeenCalledWith("work");
});
