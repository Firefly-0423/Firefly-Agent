import { expect, it } from "vitest";
import { updateModeBusy } from "./mode-busy";

it("sets and clears one mode without disturbing another or mutating the input", () => {
  const original = { chat: true, work: true };
  const cleared = updateModeBusy(original, "chat", false);
  expect(cleared).toEqual({ work: true });
  expect(original).toEqual({ chat: true, work: true });
  expect(updateModeBusy(cleared, "code", true)).toEqual({ work: true, code: true });
});
