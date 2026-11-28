import { expect, it, vi } from "vitest";
import { resolveInteraction } from "./interaction-resolution";

it.each([true, false])("clears a settled card and resumes its run only for ok=%s", async ok => {
  const host = { busy: vi.fn(), clear: vi.fn(), resume: vi.fn() };
  await resolveInteraction(() => Promise.resolve({ ok }), host);
  expect(host.busy.mock.calls).toEqual([[true], [false]]);
  expect(host.clear).toHaveBeenCalledOnce();
  expect(host.resume).toHaveBeenCalledTimes(ok ? 1 : 0);
});

it("keeps a card available for retry when the bridge rejects", async () => {
  const host = { busy: vi.fn(), clear: vi.fn(), resume: vi.fn() };
  await resolveInteraction(() => Promise.reject(new Error("offline")), host);
  expect(host.busy.mock.calls).toEqual([[true], [false]]);
  expect(host.clear).not.toHaveBeenCalled();
  expect(host.resume).not.toHaveBeenCalled();
});
