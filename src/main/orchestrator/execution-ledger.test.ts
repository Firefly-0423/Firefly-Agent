import { describe, it, expect, vi } from "vitest";
import { ExecutionLedger, ExecutionLedgerStore } from "./execution-ledger";

const invocation = { logicalInvocationId: "agenda-run:export-8", capability: "agenda.export", targetRefs: ["ctx_agenda"], args: { destination: "calendar.ics" } };

describe("Logical invocation replay", () => {
  it.each([true, undefined])("replays a successful terminal=%s operation exactly once", async (terminal) => {
    const ledger = new ExecutionLedger();
    const effect = vi.fn(async () => ({ status: "succeeded" as const, output: "Export ready", ...(terminal === undefined ? {} : { terminal }) }));
    expect((await ledger.execute(invocation, effect)).cached).toEqual(false);
    expect((await ledger.execute(invocation, effect)).cached).toEqual(true);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "succeeded" as const, terminal: false, output: "Still exporting" },
    { status: "failed" as const, errorCode: "E_FAIL", output: "Export failed" },
  ])("reruns an uncached $status result with terminal=$terminal", async (outcome) => {
    const ledger = new ExecutionLedger(), effect = vi.fn(async () => outcome);
    expect((await ledger.execute(invocation, effect)).cached).toEqual(false);
    expect((await ledger.execute(invocation, effect)).cached).toEqual(false);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("permits a retry after failure but rejects conflicting request facts", async () => {
    const ledger = new ExecutionLedger();
    const effect = vi.fn().mockResolvedValueOnce({ status: "failed", output: "Disconnected", errorCode: "E_FAIL" }).mockResolvedValueOnce({ status: "succeeded", output: "Export ready" });
    expect((await ledger.execute(invocation, effect)).outcome.status).toEqual("failed");
    expect((await ledger.execute(invocation, effect)).outcome.status).toEqual("succeeded");
    expect(effect).toHaveBeenCalledTimes(2);
    await expect(ledger.execute({ ...invocation, args: { destination: "different.ics" } }, effect)).rejects.toMatchObject({ code: "E_LOGICAL_INVOCATION_CONFLICT" });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("treats a distinct model invocation as a new operation even with identical arguments", async () => {
    const ledger = new ExecutionLedger(), effect = vi.fn(async () => ({ status: "succeeded" as const, output: "Export ready" }));
    await ledger.execute(invocation, effect);
    await ledger.execute({ ...invocation, logicalInvocationId: "agenda-run:export-9" }, effect);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("shares ledgers within one turn scope and isolates other turns", () => {
    const ledgers = new ExecutionLedgerStore();
    const original = ledgers.forScope("agenda:turn-8");
    expect(ledgers.forScope("agenda:turn-8")).toBe(original);
    expect(ledgers.forScope("agenda:turn-9")).not.toBe(original);
  });
});
