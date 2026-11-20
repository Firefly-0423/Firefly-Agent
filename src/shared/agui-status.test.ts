import { expect, it, vi } from "vitest";
import { createAguiApi } from "../preload/agui";
import { IPC } from "./ipc-channels";
it("passes exact candidate identities through the batch status IPC and returns its result", async () => {
  const result = [{ assistantTurnId: "assistant", phase: "unavailable" }];
  const invoke = vi.fn().mockResolvedValue(result);
  const api = createAguiApi({ invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() });
  const request = { sessionId: "session", candidates: [{ assistantTurnId: "assistant", runId: "run" }] };
  expect(await api.getRunStatus(request)).toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.AGUI_RUN_STATUS, request);
});
