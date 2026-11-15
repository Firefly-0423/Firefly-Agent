import { describe, expect, it } from "vitest";
import { exactly } from "./error-code.test-support";

const fail = (message: string) => () => { throw new Error(message); };

describe("exactly", () => {
  it("matches the whole message, not a substring", () => {
    expect(fail("MEMORY_INPUT_INVALID")).toThrow(exactly("MEMORY_INPUT_INVALID"));
    expect(fail("MEMORY_INPUT_INVALID_FALLBACK")).not.toThrow(exactly("MEMORY_INPUT_INVALID"));
    expect(fail("X_MEMORY_INPUT_INVALID")).not.toThrow(exactly("MEMORY_INPUT_INVALID"));
    expect(fail("MEMORY_INPUT_INVALID: detail")).not.toThrow(exactly("MEMORY_INPUT_INVALID"));
  });

  it("works with rejected promises", async () => {
    await expect(Promise.reject(new Error("MEMORY_SOURCE_STALE"))).rejects.toThrow(exactly("MEMORY_SOURCE_STALE"));
    await expect(Promise.reject(new Error("MEMORY_SOURCE_STALE_V2"))).rejects.not.toThrow(exactly("MEMORY_SOURCE_STALE"));
  });

  it("refuses anything that is not a stable error code", () => {
    expect(() => exactly("not a code")).toThrow("exactly() expects a stable error code");
    expect(() => exactly("")).toThrow("exactly() expects a stable error code");
  });
});
