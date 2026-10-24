import { describe, expect, it } from "vitest";
import { normalizeUiIcon } from "../shared/ui-icon";

describe("ui icon settings", () => {
  it.each([
    ["firefly", "firefly"],
    ["classic", "firefly"],
    ["unknown", "firefly"],
    [undefined, "firefly"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiIcon(input)).toBe(expected);
  });
});
