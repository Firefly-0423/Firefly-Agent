import { expect, it } from "vitest";
import { interactionOwner } from "./interaction-owner";

it("routes to the run owner before considering the visible session", () => {
  const runs = { a: { runId: "one" }, b: { runId: "two" } };
  expect(interactionOwner(runs, "two", "a")).toBe("b");
  expect(interactionOwner(runs, "unknown", "a")).toBe("a");
  expect(interactionOwner(runs, "unknown", undefined)).toBeUndefined();
});
