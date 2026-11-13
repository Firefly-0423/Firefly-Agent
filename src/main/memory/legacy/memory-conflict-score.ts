import type { ConflictResolverPriority, ConflictScoringSignals } from "./memory-types"

export type ConflictEvidenceLevel = "none" | "one_side" | "both"
export type ConflictCandidateSource = "local" | "rag" | "recent_injection"

/** 一次冲突打分所需的全部信号 */
export type ConflictScoreInput = {
  activeTarget: boolean
  evidence: ConflictEvidenceLevel
  candidateSource: ConflictCandidateSource
  impactScope?: "low" | "medium" | "high"
  ragScore?: number
  correctionIntent?: boolean
  localContradiction?: boolean
  recentInjection?: boolean
  recentlyResolvedSamePair?: boolean
}

export type ConflictScoreResult = {
  scoringSignals: ConflictScoringSignals
  resolverPriority: ConflictResolverPriority
  conflictScore: number
}

const EVIDENCE_WEIGHT: Record<ConflictEvidenceLevel, number> = { both: 15, one_side: 8, none: 0 }
const IMPACT_WEIGHT: Record<"low" | "medium" | "high", number> = { high: 10, medium: 6, low: 3 }

function ragWeight(ragScore: number | undefined): number {
  if (ragScore === undefined) return 0
  return ragScore >= 0.75 ? 25 : ragScore >= 0.45 ? 18 : 10
}

function toPriority(score: number): ConflictResolverPriority {
  return score >= 75 ? "high" : score >= 55 ? "normal" : score >= 35 ? "idle" : "none"
}

/** 键的顺序会随冲突日志落盘，保持 correctionIntent → … → penalties */
function buildSignals(
  input: ConflictScoreInput,
  ragCandidate: boolean,
  recentInjection: boolean,
  penalties: string[],
): ConflictScoringSignals {
  const signals: ConflictScoringSignals = {};
  signals.correctionIntent = input.correctionIntent === true;
  signals.ragCandidate = ragCandidate;
  signals.recentInjection = recentInjection;
  signals.evidenceAvailable = input.evidence !== "none";
  signals.localContradiction = input.localContradiction === true;
  signals.impactScope = input.impactScope ?? "low";
  signals.penalties = penalties;
  return signals;
}

export function scoreMemoryConflict(input: ConflictScoreInput): ConflictScoreResult {
  const ragCandidate = input.candidateSource === "rag" || input.ragScore !== undefined
  const recentInjection = input.candidateSource === "recent_injection" || input.recentInjection === true

  const gains = [
    input.correctionIntent ? 20 : 0,
    ragCandidate ? ragWeight(input.ragScore) : 0,
    recentInjection ? 20 : 0,
    EVIDENCE_WEIGHT[input.evidence] ?? 0,
    input.localContradiction ? 10 : 0,
    IMPACT_WEIGHT[input.impactScope as "low"] ?? 0,
  ]
  const deductions: Array<[boolean, number, string]> = [
    [!input.activeTarget, 25, "archived_only_target"],
    [input.evidence === "none", 20, "missing_evidence"],
    [!!input.recentlyResolvedSamePair, 25, "recently_resolved_same_pair"],
  ]
  const applied = deductions.filter(([hit]) => hit)

  let raw = 0
  for (const g of gains) raw += g
  for (const [, cost] of applied) raw -= cost
  const conflictScore = Math.max(0, Math.min(100, Math.round(raw)))

  const blocked = input.candidateSource === "local" || !input.activeTarget || input.evidence === "none"
  const resolverPriority: ConflictResolverPriority = blocked ? "none" : toPriority(conflictScore)

  return {
    conflictScore,
    resolverPriority,
    scoringSignals: buildSignals(input, ragCandidate, recentInjection, applied.map(([, , name]) => name)),
  }
}
