import { t, useTranslation } from "../../../i18n";
import { MarkdownContent } from "./ChatMessageList";

export type PlanReviewPhase = "review" | "executing" | "completed" | "failed" | "cancelled";

const PHASE_NOTE_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.noteReview", executing: "planReview.noteExecuting",
  completed: "planReview.noteCompleted", failed: "planReview.noteFailed", cancelled: "planReview.noteCancelled",
};
const PHASE_DOT: Record<PlanReviewPhase, string> = {
  review: "is-review", executing: "is-executing", completed: "is-completed",
  failed: "is-failed", cancelled: "is-cancelled",
};
const PHASE_LABEL_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.tabReview", executing: "planReview.tabExecuting", completed: "planReview.tabCompleted",
  failed: "planReview.tabFailed", cancelled: "planReview.tabCancelled",
};
const ENTRY_LABEL_KEYS: Record<PlanReviewPhase, string> = {
  review: "planReview.entryReview", executing: "planReview.entryExecuting", completed: "planReview.entryCompleted",
  failed: "planReview.entryFailed", cancelled: "planReview.entryCancelled",
};

type PlanContentProps = { content: string; phase?: PlanReviewPhase };
export function PlanContent({ content, phase = "review" }: PlanContentProps) {
  const { t } = useTranslation();
  const note = t(PHASE_NOTE_KEYS[phase]);
  return <div className="ff-plan-content">
    <p className="ff-plan-content__note">{note}</p>
    <div className="ff-plan-content__body"><MarkdownContent content={content} /></div>
  </div>;
}

export function planTabLabel(phase: PlanReviewPhase): string { return t(PHASE_LABEL_KEYS[phase]); }
export function planTabDotClass(phase: PlanReviewPhase): string { return PHASE_DOT[phase]; }

type PlanEntryProps = { phase: PlanReviewPhase; onOpen: () => void };
export function PlanReviewEntry({ phase, onOpen }: PlanEntryProps) {
  const { t } = useTranslation();
  const dot = PHASE_DOT[phase];
  return <button onClick={onOpen} className={`ff-plan-entry is-${phase}`} type="button">
    <span aria-hidden="true" className={`ff-plan-entry__dot ${dot}`} />{t(ENTRY_LABEL_KEYS[phase])}
  </button>;
}
