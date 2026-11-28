import { describe, it, expect } from "vitest";
import { scoreMemoryConflict } from "./memory-conflict-score";
describe("resolver priority from conflict evidence", () => {
    it("never promotes lexical-only evidence to the resolver", () => {
        const result = scoreMemoryConflict({ candidateSource: "local", activeTarget: true, evidence: "both", localContradiction: true });
        expect(result.conflictScore).toBeLessThan(35);
        expect(result.resolverPriority).toEqual("none");
        expect(result.scoringSignals).toMatchObject({ ragCandidate: false, localContradiction: true });
    });
    it.each([
        [false, false, 0.8, 35, "idle"], [true, false, 0.85, 55, "normal"], [true, true, 0.9, 75, "high"],
    ])("ranks corrections=%s and recent-injection=%s", (correctionIntent, recentInjection, ragScore, floor, priority) => {
        const result = scoreMemoryConflict({ candidateSource: "rag", ragScore, correctionIntent, recentInjection, evidence: "both", activeTarget: true, localContradiction: true });
        expect(result.conflictScore).toBeGreaterThanOrEqual(floor);
        expect(result.resolverPriority).toEqual(priority);
        expect(result.scoringSignals).toMatchObject({ ragCandidate: true, evidenceAvailable: true, correctionIntent, recentInjection });
    });
    it("disqualifies an archived target without evidence and reports both penalties", () => {
        const result = scoreMemoryConflict({ candidateSource: "rag", ragScore: 0.9, evidence: "none", activeTarget: false });
        expect(result.resolverPriority).toEqual("none");
        expect(result.scoringSignals.penalties).toEqual(["archived_only_target", "missing_evidence"]);
    });
});
