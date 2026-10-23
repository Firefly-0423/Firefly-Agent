import { describe, expect, it } from "vitest";
import {
  SHADOW_COUNTERS,
  SHADOW_REFUSALS,
  SHADOW_STOP_REASONS,
  SHADOW_STORE_LIMITS,
} from "./shadow-store-contracts";
import { SHADOW_DROP_REASONS } from "./shadow-contracts";

describe("shadow store contracts", () => {
  it("publishes the frozen storage limits", () => {
    expect(SHADOW_STORE_LIMITS).toEqual({
      defaultDailyCap: 50,
      maxDailyCap: 1000,
      maxRecordsPerActor: 5000,
      statsRetentionDays: 90,
    });
    expect(Object.isFrozen(SHADOW_STORE_LIMITS)).toBe(true);
  });

  it("exposes the supported stop reasons and refusals in order", () => {
    expect(SHADOW_STOP_REASONS).toEqual(["quota", "rate-limit"]);
    expect(SHADOW_REFUSALS).toEqual([
      "disabled",
      "generation-changed",
      "source-unavailable",
      "duplicate",
      "cap-reached",
      "stopped",
      "not-reserved",
      "storage-full",
    ]);
  });

  it("derives one counter for every drop and refusal outcome", () => {
    for (const reason of SHADOW_DROP_REASONS) {
      expect(SHADOW_COUNTERS).toContain(`drop:${reason}`);
    }
    for (const refusal of SHADOW_REFUSALS) {
      expect(SHADOW_COUNTERS).toContain(`refuse:${refusal}`);
      expect(SHADOW_COUNTERS).toContain(`discard:${refusal}`);
    }
    expect(SHADOW_COUNTERS).toContain("sent");
    expect(SHADOW_COUNTERS).toContain("candidates");
    expect(SHADOW_COUNTERS).toContain("downgraded");
    expect(SHADOW_COUNTERS).toContain("skip:empty");
    expect(SHADOW_COUNTERS).toContain("error:timeout");
    expect(SHADOW_COUNTERS).toContain("cancel:restart");
  });

  it("keeps all counter names unique and frozen", () => {
    expect(new Set(SHADOW_COUNTERS).size).toBe(SHADOW_COUNTERS.length);
    expect(Object.isFrozen(SHADOW_COUNTERS)).toBe(true);
  });
});
