import { expect, it, vi } from "vitest";
import { cancelSelectedRun } from "./cancel-run";

it("marks a pre-ack cancellation before sending an unscoped cancel", async () => {
  const pending = new Set<string>();
  const host = { patch: vi.fn(), cancelUnscoped: vi.fn(async () => {}), cancelRun: vi.fn(async () => {}), pending };
  await cancelSelectedRun("s", { assistantId: "a", mode: "work" }, host);
  expect(pending.has("s")).toBe(true);
  expect(host.cancelUnscoped).toHaveBeenCalledOnce();
  expect(host.cancelRun).not.toHaveBeenCalled();
  expect(host.patch).toHaveBeenCalledWith("work", "a", expect.objectContaining({ loading: false, streaming: false }));
});

it("cancels an acknowledged run by id without marking pre-ack state", async () => {
  const host = { patch: vi.fn(), cancelUnscoped: vi.fn(async () => {}), cancelRun: vi.fn(async () => {}), pending: new Set<string>() };
  await cancelSelectedRun("s", { assistantId: "a", mode: "chat", runId: "r" }, host);
  expect(host.cancelRun).toHaveBeenCalledWith("r");
  expect(host.pending.size).toBe(0);
});
