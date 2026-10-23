import { describe, expect, it } from "vitest";
import { shortEffortLabel } from "./ModelEffortControl";

describe("shortEffortLabel", () => {
  it("shortens the long mode names so every stop fits under the slider", () => {
    expect(shortEffortLabel("跟随模型")).toBe("自动");
    expect(shortEffortLabel("关闭")).toBe("关");
    expect(shortEffortLabel("开启")).toBe("开");
    expect(shortEffortLabel("始终开启")).toBe("常开");
  });

  it("keeps effort level names as they are", () => {
    for (const label of ["low", "medium", "high", "xhigh", "max"]) expect(shortEffortLabel(label)).toBe(label);
  });
});
