import assert from "node:assert/strict";
import { it as test } from "vitest";
import { isPidExecuting } from "../../scripts/testing/process-liveness.mjs";

const linux = (stat: string) => ({ platform: "linux", probe: () => {}, readStat: () => stat });
test("an unreaped zombie cannot execute even while signal zero succeeds", () => {
  assert.equal(isPidExecuting(42, linux("42 (worker (child)) Z 1 42 0")), false);
});
test("a dead Linux task is not executing", () => {
  assert.equal(isPidExecuting(42, linux("42 (worker) X 1 42 0")), false);
});
test("running, sleeping and stopped tasks remain alive for the kill assertion", () => {
  for (const state of ["R", "S", "D", "T", "I"]) {
    assert.equal(isPidExecuting(42, linux(`42 (worker) ${state} 1 42 0`)), true);
  }
});
test("missing PID is dead; permission denial cannot prove death", () => {
  assert.equal(isPidExecuting(null), false);
  assert.equal(isPidExecuting(42, { probe: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), false);
  assert.equal(isPidExecuting(42, { probe: () => { throw Object.assign(new Error(), { code: "EPERM" }); } }), true);
});
test("unreadable or malformed Linux state conservatively remains alive", () => {
  assert.equal(isPidExecuting(42, linux("malformed")), true);
  assert.equal(isPidExecuting(42, { ...linux(""), readStat: () => { throw new Error("unreadable"); } }), true);
});
test("Windows uses the PID probe without consulting procfs", () => {
  assert.equal(isPidExecuting(42, { platform: "win32", probe: () => {}, readStat: () => { throw new Error("unexpected procfs read"); } }), true);
});
