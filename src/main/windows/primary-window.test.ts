import { expect, vi, it, describe } from "vitest";
import { openPrimaryWindow } from "./primary-window";
import type { WindowActivationRequest } from "../application/window-activation";

describe("Primary window activation contract", () => {
  it("emits exactly one chat activation and excludes sidebar activation", () => {
    const dispatch = vi.fn<(request: WindowActivationRequest) => void>();
    openPrimaryWindow({ requestActivation: dispatch });
    expect(dispatch.mock.calls).toEqual([[{ kind: "chat" }]]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].kind).not.toEqual("sidebar");
  });
});
