type NewAtom = { operation: "add"; atom: SocialAtom };
type Replacement = { operation: "supersede"; atom: SocialAtom; targetAtomId: string };
type Resolution = { operation: "resolve"; targetAtomId: string; evidenceTurnId: string; evidenceQuote: string };

export type ValidatedSocialAtomOperation = NewAtom | Replacement | Resolution;

// 会话原子：长期/短期事实，或等待用户回应的开放话题。
interface AtomIdentity {
  id: string;
  conversationId: string;
}

interface AtomEvidence {
  evidenceTurnId: string;
  evidenceQuote: string;
}

export interface SocialAtom extends AtomIdentity, AtomEvidence {
  type: SocialAtomType;
  content: string;
  createdAt: number;
  expiresAt?: number;
  status: SocialAtomStatus;
  supersededByAtomId?: string;
  resolvedByTurnId?: string;
}

export interface SocialTurnEvidence {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface SocialExtractionInput extends Pick<AtomIdentity, "conversationId"> {
  userTurn: SocialTurnEvidence & { role: "user" };
  assistantTurn: SocialTurnEvidence & { role: "assistant" };
  retrievedAtoms: SocialAtom[];
  now: number;
}

export type SocialAtomStatus = "active" | "superseded" | "resolved";
export type SocialAtomType = "long_term" | "short_term" | "open_loop";
