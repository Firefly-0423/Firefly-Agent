import { describeRunStage, type AgentRunStage } from "./run-presentation";
import "./RunExperience.css";

export function RunStageIndicator({ stage }: { stage: AgentRunStage }) {
  return (
    <span className={`ff-run-stage ff-run-stage--${stage.kind}`} role="status" aria-live="polite">
      <span className="ff-run-stage__pulse" aria-hidden="true" />
      <span>{describeRunStage(stage)}</span>
    </span>
  );
}
