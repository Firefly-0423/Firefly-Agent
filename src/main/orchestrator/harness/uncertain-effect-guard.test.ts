import { describe, expect, it } from "vitest";
import { findBlockingUncertainEffect, isBlockedByUncertainEffect, resolveUncertainEffect } from "./uncertain-effect-guard";
import type { AgentState, UncertainEffect } from "./types";

describe("Unconfirmed external operations", () => {
  const pending = (suffix: string): UncertainEffect => ({
    toolName: "publish_report", toolCallId: `request-${suffix}`, fingerprint: `digest-${suffix}`,
    id: `record-${suffix}`, message: "Remote acknowledgement missing",
  });
  const context = (...effects: UncertainEffect[]): AgentState => ({ todoItems: [], uncertainEffects: effects });

  it("prevents only a recorded effect when the arguments are known", () => {
    const effect = pending("amber");
    const current = context(effect);
    expect([isBlockedByUncertainEffect(current, effect.fingerprint),
      isBlockedByUncertainEffect(current, "digest-blue"),
      isBlockedByUncertainEffect(context(), effect.fingerprint)]).toEqual([true, false, false]);
    expect(findBlockingUncertainEffect(current, effect.fingerprint)).toBe(effect);
  });

  it("confirmation removes the selected request while retaining other records in order", () => {
    const removed = pending("amber");
    const retained = pending("blue");
    const current = context(removed, retained);
    resolveUncertainEffect(current, removed.toolCallId);
    expect(current.uncertainEffects).toStrictEqual([retained]);
    expect(current.uncertainEffects[0].id).toBe("record-blue");
    expect(isBlockedByUncertainEffect(current, removed.fingerprint)).toBe(false);
    expect(isBlockedByUncertainEffect(current, retained.fingerprint)).toBe(true);
  });

  it("guards the entire tool when the recorded arguments are unavailable", () => {
    const effect = { ...pending("unknown"), argumentsUnavailable: true };
    expect(isBlockedByUncertainEffect(context(effect), "new-digest", "publish_report")).toBe(true);
    expect(isBlockedByUncertainEffect(context(effect), "new-digest", "read_report")).toBe(false);
  });
});
