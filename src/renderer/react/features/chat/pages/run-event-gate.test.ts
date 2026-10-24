import { it, expect } from "vitest";
import { RunEventGate } from "./run-event-gate";

it("buffers arrival order until acknowledgement and then accepts only the acknowledged identity", () => {
  const filter = new RunEventGate<{ runId?: string; type: string }>();
  const arrivals = [
    { runId: "unrelated", type: "RUN_STARTED" },
    { runId: "accepted-27", type: "RUN_STARTED" },
    { type: "TEXT_MESSAGE_CONTENT" },
    { runId: "accepted-27", type: "TEXT_MESSAGE_CONTENT" },
  ];
  for (const event of arrivals) expect(filter.accept(event)).toStrictEqual([]);
  expect(filter.bind("accepted-27")).toStrictEqual([arrivals[1], arrivals[3]]);
  expect(filter.accept({ runId: "unrelated", type: "TEXT_MESSAGE_CONTENT" })).toStrictEqual([]);
  expect(filter.accept({ type: "TEXT_MESSAGE_CONTENT" })).toStrictEqual([]);
  const live = { runId: "accepted-27", type: "TEXT_MESSAGE_CONTENT" };
  expect(filter.accept(live)).toStrictEqual([live]);
  expect(filter.bind("accepted-27")).toStrictEqual([]);
});
