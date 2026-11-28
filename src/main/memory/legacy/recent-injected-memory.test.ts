import { beforeEach, expect, it } from "vitest";
import { clearRecentMemoryInjections as clear, recordRecentMemoryInjection as record,
  recordRecentMemorySearchEntries as search, getRecentlyInjectedMemoryIds as ids,
  wasRecentlyInjectedMemory as contains } from "./recent-injected-memory";

beforeEach(clear);
it("returns recorded ids in injection order and reports absent ids", () => {
  record(["note:tea", "note:walk"], 4200);
  expect(ids(4200)).toEqual(["note:tea", "note:walk"]);
  expect(["note:tea", "note:walk", "note:none"].map(id => contains(id, 4200))).toEqual([true, true, false]);
});
it("retains the exact ten-minute boundary and expires one millisecond later", () => {
  record(["note:expiry"], 7200);
  expect(contains("note:expiry", 607200)).toBe(true);
  expect(contains("note:expiry", 607201)).toBe(false);
});
it("refreshes an existing id without adding a second record", () => {
  record(["note:refresh"], 3000);
  record(["note:refresh"], 9000);
  expect(ids(9000)).toEqual(["note:refresh"]);
  expect(contains("note:refresh", 609000)).toBe(true);
});
it("accepts nonempty string metadata ids rather than text or numeric metadata", () => {
  search([{ text: "ignored id in prose", metadata: {} }, { text: "numeric", metadata: { l2Id: 87 } },
    { text: "selected", metadata: { l2Id: "note:metadata" } }, { text: "empty", metadata: { l2Id: "" } }], 5600);
  expect(ids(5600)).toEqual(["note:metadata"]);
});
