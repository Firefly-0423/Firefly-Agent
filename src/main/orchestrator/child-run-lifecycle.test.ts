import { expect, it } from "vitest";
import { settleChildExecution } from "./child-run-lifecycle";
import type { RunExecutionCoordinator } from "./harness/execution-coordinator";

it("late_settlement_keeps_closure_pending_until_actual_child_operation_settles", async () => {
  let settle!: () => void;
  const actual = new Promise<void>(resolve => { settle = resolve; });
  const order: string[] = [];
  const coordinator = { whenChildSettled: async (id: string) => { order.push(id); await actual; } } as RunExecutionCoordinator;
  const closing = settleChildExecution({ coordinator, childRunId: "child-A", close: async () => { order.push("closed"); } });
  await Promise.resolve();
  expect(order).toEqual(["child-A"]);
  settle(); await closing;
  expect(order).toEqual(["child-A", "closed"]);
});

it("closes only its child without waiting on its enclosing delegation group", async () => {
  const coordinator = { whenChildSettled: async () => undefined, whenSettled: () => { throw Error("self-group deadlock"); } } as unknown as RunExecutionCoordinator;
  let closed = false;
  await settleChildExecution({ coordinator, childRunId: "C", close: async () => { closed = true; } });
  expect(closed).toBe(true);
});
