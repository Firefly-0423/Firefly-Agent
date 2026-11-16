import { describe, expect, it } from "vitest";
import { interactionOwner } from "./interaction-owner";

const runs = { a: { runId: "run-a" }, b: { runId: "run-b" }, idle: {} };

// The visible conversation is no longer an input: whichever one the user is looking at, a card goes to its run's owner or nowhere.
describe("interaction owner (ChatPage G1, G3)", () => {
  it.each([
    { name: "a known background run goes to its owner", runId: "run-b", owner: "b" },
    { name: "a known run in the foreground goes to its owner", runId: "run-a", owner: "a" },
    { name: "an unknown run has no owner", runId: "run-gone", owner: undefined },
    { name: "a request without a run id has no owner", runId: undefined, owner: undefined },
    { name: "an empty run id has no owner", runId: "", owner: undefined },
  ])("$name", ({ runId, owner }) => {
    expect(interactionOwner(runs, runId)).toBe(owner);
  });
});
