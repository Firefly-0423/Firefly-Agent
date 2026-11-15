import { describe, expect, it } from "vitest";
import { parsePositiveIntOrThrow } from "./parse";

describe("parsePositiveIntOrThrow", () => {
  it.each([
    { input: "1", expected: 1 },
    { input: "42", expected: 42 },
    { input: "007", expected: 7 },
  ])("returns $expected for decimal text $input", ({ input, expected }) => {
    expect(parsePositiveIntOrThrow(input, new Error("unused"))).toBe(expected);
  });

  it.each(["", "0", "00", "-1", "1.5", "1e3", "0x10", " 7", "abc"])("throws the supplied value, not a new error, for %j", (input) => {
    const rejection = { code: "SETTINGS_INVALID_NUMBER" };
    let thrown: unknown;
    try { parsePositiveIntOrThrow(input, rejection); } catch (error) { thrown = error; }
    expect(thrown).toBe(rejection);
  });
});
