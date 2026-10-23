import type { ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import { AskUserPanel, PermissionPanel, PopQuizPanel } from "./InteractionPanel";
import { resolveComposerSlot, type ComposerInteraction } from "./run-presentation";
import type { PopQuizGradedQuestion, PopQuizSubmission } from "../../../../../shared/pop-quiz";
import "./RunExperience.css";

type ComposerSlotProps = {
  onQuizSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
  onQuizSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: PopQuizGradedQuestion[] }>;
  onPermissionDecision?: (interactionId: string, allowed: boolean) => void;
  onIgnore?: (interactionId: string) => void;
  onAnswer?: (interactionId: string, answer: unknown) => void;
  interactionPending?: number;
  interactionBusy?: boolean;
  interaction?: ComposerInteraction;
  composer: ReactNode;
};

export function ComposerSlot({ composer: input, interaction: card, interactionBusy: locked = false, interactionPending: waiting = 0, onAnswer: answer, onIgnore: ignore, onPermissionDecision: decide, onQuizSubmit: submitQuiz, onQuizSkip: skipQuiz }: ComposerSlotProps) {
  const { t: translate } = useTranslation();
  const placement = resolveComposerSlot(card);
  const ask = card?.kind === "ask" && <div className="ff-composer-slot__interaction">
    <AskUserPanel interaction={card} disabled={locked}
      onAnswer={(value) => answer?.(card.id, value)} onIgnore={() => ignore?.(card.id)} />
  </div>;
  const permission = card?.kind === "permission" && <div className="ff-composer-slot__interaction">
    <PermissionPanel interaction={card} disabled={locked} onDecision={(allowed) => decide?.(card.id, allowed)} />
  </div>;
  const quiz = card?.kind === "quiz" && <div className="ff-composer-slot__interaction">
    <PopQuizPanel interaction={card} disabled={locked} onSubmit={submitQuiz} onSkip={skipQuiz} />
  </div>;
  return <div className={`ff-composer-slot is-${placement}`}>
    <div className="ff-composer-slot__composer" aria-hidden={card ? true : undefined}>{input}</div>
    {card && waiting > 0 && <span className="ff-composer-slot__pending" role="status">
      {translate("interaction.pendingMore", { count: waiting })}
    </span>}
    {ask}
    {permission}
    {quiz}
  </div>;
}
