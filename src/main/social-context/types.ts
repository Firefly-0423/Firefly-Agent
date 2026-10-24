export type ValidatedSocialAtomOperation =
  | {
      operation: "add";
      atom: SocialAtom;
    }
  | {
      operation: "supersede";
      atom: SocialAtom;
      targetAtomId: string;
    }
  | {
      operation: "resolve";
      targetAtomId: string;
      evidenceTurnId: string;
      evidenceQuote: string;
    };

// 会话原子：长期/短期事实，或等待用户回应的开放话题。
export interface SocialAtom {
  id: string;
  conversationId: string;
  type: SocialAtomType;
  content: string;
  evidenceTurnId: string;
  evidenceQuote: string;
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

export interface SocialExtractionInput {
  conversationId: string;
  userTurn: SocialTurnEvidence & { role: "user" };
  assistantTurn: SocialTurnEvidence & { role: "assistant" };
  retrievedAtoms: SocialAtom[];
  now: number;
}

export type SocialAtomStatus = "active" | "superseded" | "resolved";
export type SocialAtomType = "long_term" | "short_term" | "open_loop";
