import { expect, it, vi } from "vitest";
import { installSingleInstanceGuard } from "./single-instance";

it("registers activation only for the process that owns the instance lock", () => {
  for (const ownsLock of [true, false]) {
    const activate = vi.fn();
    const application = { on: vi.fn(), quit: vi.fn(), requestSingleInstanceLock: vi.fn(() => ownsLock) };
    expect(installSingleInstanceGuard(application, activate)).toBe(ownsLock);
    expect(application.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    if (ownsLock) {
      expect(application.quit).not.toHaveBeenCalled();
      expect(application.on).toHaveBeenCalledExactlyOnceWith("second-instance", activate);
      application.on.mock.calls[0][1]();
      expect(activate).toHaveBeenCalledTimes(1);
    } else {
      expect(application.quit).toHaveBeenCalledTimes(1);
      expect(application.on).not.toHaveBeenCalled();
    }
  }
});
