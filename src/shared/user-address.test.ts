import { describe, expect, it } from "vitest";
import { resolveUserAddress } from "./user-address";

describe("user address", () => {
  it("prioritizes explicit call preference over nickname", () => {
    expect(resolveUserAddress({ callPreference: "  星星  ", nickname: "小王" })).toBe("星星");
  });

  it("keeps a saved nickname when the call preference is blank", () => {
    expect(resolveUserAddress({ callPreference: "  ", nickname: " 小王 " })).toBe("小王");
  });

  it("uses 开拓者 only when neither preference nor nickname is set", () => {
    expect(resolveUserAddress({})).toBe("开拓者");
    expect(resolveUserAddress(null)).toBe("开拓者");
  });
});
