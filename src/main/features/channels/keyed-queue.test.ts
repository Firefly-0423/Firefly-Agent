import { it, expect } from "vitest";
import { createKeyedQueue } from "./keyed-queue";

function latch() {
  let open!: () => void;
  const waiting = new Promise<void>(resolve => { open = resolve; });
  return { waiting, open };
}

it("lets another conversation finish while preserving FIFO within a conversation", async () => {
  const serial = createKeyedQueue();
  const gate = latch();
  const trace: string[] = [];
  const left = serial.run("room-blue", async () => { trace.push("blue entered"); await gate.waiting; trace.push("blue left"); });
  const next = serial.run("room-blue", async () => { trace.push("blue successor"); });
  await serial.run("room-green", async () => { trace.push("green completed"); });
  expect(trace).toStrictEqual(["blue entered", "green completed"]);
  gate.open();
  await Promise.all([left, next]);
  expect(trace).toStrictEqual(["blue entered", "green completed", "blue left", "blue successor"]);
});

it("counts the running job against capacity and frees its slot on completion", async () => {
  const serial = createKeyedQueue({ maxPendingPerKey: 1 });
  const gate = latch();
  const active = serial.run("limited-room", () => gate.waiting);
  await expect(serial.run("limited-room", async () => 1)).rejects.toThrow("queue_full:limited-room");
  gate.open();
  await active;
  await expect(serial.run("limited-room", async () => "slot available")).resolves.toEqual("slot available");
});

it("propagates a job failure without poisoning the next job", async () => {
  const serial = createKeyedQueue();
  const failure = serial.run("recovery-room", async () => { throw new Error("worker rejected input"); });
  const continuation = serial.run("recovery-room", async () => 37);
  await expect(failure).rejects.toThrow("worker rejected input");
  await expect(continuation).resolves.toEqual(37);
});
