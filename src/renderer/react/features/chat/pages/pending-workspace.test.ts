import { expect, it, vi } from "vitest";
import { bindPendingWorkspace } from "./pending-workspace";

it("updates the displayed name only on success and clears a pending choice on either result", async () => {
  const bound = vi.fn(), clear = vi.fn();
  const setWorkspace = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
  const host = { store: () => ({ setWorkspace }), bound, clear };
  await bindPendingWorkspace("s", { path: "p", displayName: "Project" }, host);
  expect(bound).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledOnce();
  await bindPendingWorkspace("s", { path: "p", displayName: "Project" }, host);
  expect(bound).toHaveBeenCalledWith("Project");
  expect(clear).toHaveBeenCalledTimes(2);
  await bindPendingWorkspace("s", undefined, host);
  expect(setWorkspace).toHaveBeenCalledTimes(2);
});
