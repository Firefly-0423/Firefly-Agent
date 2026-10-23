import { describe, expect, it } from "vitest";
import { RunSettlementGate, SRunSettlementGate } from "./run-settlement";
import type { FireflyRunTerminalResult } from "../../shared/run-terminal";

describe("Terminal delivery arbitration", () => {
  it.each<FireflyRunTerminalResult>([
    { status: "runtime_error", reason: "E_MODEL_REQUEST_FAILED", externalEffectsMayContinue: true },
    { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true },
    { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
    { status: "success", externalEffectsMayContinue: false },
  ])("keeps the first $status result for every subsequent delivery", (terminal) => {
    const arbiter = new RunSettlementGate();
    expect([arbiter.get(), arbiter.isSettled()]).toEqual([null, false]);
    expect(arbiter.trySettle(terminal)).toEqual(true);
    expect(arbiter.isSettled()).toEqual(true);
    for (const replacement of [
      { status: "success", externalEffectsMayContinue: false },
      { status: "runtime_error", reason: "E_AGENT_GRAPH_TIMEOUT", externalEffectsMayContinue: true },
      { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true },
    ] satisfies FireflyRunTerminalResult[]) {
      expect(arbiter.trySettle(replacement)).toEqual(false);
      expect(arbiter.get()).toStrictEqual(terminal);
      expect(arbiter.isSettled()).toEqual(true);
    }
  });

  it("lets cancellation win before a success reservation", () => {
    expect(SRunSettlementGate).toBeTypeOf("function");
    const reservation = new SRunSettlementGate();
    expect(reservation.requestCancel()).toEqual(true);
    expect(reservation.reserve("success")).toEqual(false);
    expect(reservation.get()).toEqual("cancel_requested");
    expect(reservation.reserve("interrupted")).toEqual(true);
    expect(reservation.confirm("interrupted")).toEqual(true);
    expect(reservation.get()).toEqual("interrupted");
  });

  it("requires durable confirmation of the reserved result, including after unknown I/O", () => {
    for (const unknown of [false, true]) {
      const reservation = new SRunSettlementGate();
      expect(reservation.reserve("success")).toEqual(true);
      expect(reservation.get()).toEqual("success_reserved");
      expect(reservation.requestCancel()).toEqual(false);
      if (unknown) {
        expect(reservation.markUnknown()).toEqual(true);
        expect(reservation.get()).toEqual("unknown");
      }
      expect(reservation.confirm("interrupted")).toEqual(false);
      expect(reservation.confirm("success")).toEqual(true);
      expect(reservation.get()).toEqual("success");
      expect(reservation.requestCancel()).toEqual(false);
    }
  });

  it("rejects unreserved, conflicting, and repeated confirmations", () => {
    const reservation = new SRunSettlementGate();
    expect(reservation.confirm("success")).toEqual(false);
    expect(reservation.reserve("interrupted")).toEqual(true);
    expect(reservation.reserve("success")).toEqual(false);
    expect(reservation.requestCancel()).toEqual(false);
    expect(reservation.confirm("success")).toEqual(false);
    expect(reservation.confirm("interrupted")).toEqual(true);
    expect(reservation.confirm("interrupted")).toEqual(false);
  });
});
