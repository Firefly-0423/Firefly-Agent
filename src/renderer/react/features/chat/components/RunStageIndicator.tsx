import { describeRunStage, type AgentRunStage } from "./run-presentation";
import "./RunExperience.css";

/** dot=false while the run header already spins, so a live run shows one moving mark; the settled green or red dot stays. */
export function RunStageIndicator({ stage, dot = true }: { stage: AgentRunStage; dot?: boolean }) {
  return (
    <span className={`ff-run-stage ff-run-stage--${stage.kind}`} role="status" aria-live="polite">
      {dot && <span className="ff-run-stage__pulse" aria-hidden="true" />}
      <span>{describeRunStage(stage)}</span>
    </span>
  );
}
