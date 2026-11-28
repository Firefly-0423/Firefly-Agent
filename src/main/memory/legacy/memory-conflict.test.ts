import { describe, it, expect } from "vitest";
import { findPossibleConflictCandidate } from "./memory-conflict";
describe("lexical conflict candidate gating", () => {
    it("treats opposite preferences on a concrete topic as low-confidence evidence", () => {
        const result = findPossibleConflictCandidate("用户不喜欢榴莲", "用户喜欢榴莲");
        expect(result.isCandidate).toEqual(true);
        expect(result.confidence).toBeLessThan(0.5);
    });
    it.each([
        ["用户不喜欢榴莲", "用户喜欢草莓"],
        ["用户因为无法远行而难过", "用户有过食物过敏的不良经历"],
    ])("does not infer conflict between different topics: %s", (incoming, existing) => {
        expect(findPossibleConflictCandidate(incoming, existing).isCandidate).toEqual(false);
    });
});
