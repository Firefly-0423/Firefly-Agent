import { useTranslation } from "../../../i18n";
import type { TaskPlanPresentation } from "./run-presentation";
import "./RunExperience.css";

type TaskPlanStepStatus = NonNullable<TaskPlanPresentation["steps"][number]["status"]>;
const STATUS_LABEL_KEYS: Record<TaskPlanStepStatus, string> = {
  pending: "taskPlan.statusPending", running: "taskPlan.statusRunning",
  completed: "taskPlan.statusCompleted", failed: "taskPlan.statusFailed",
};

export function TaskPlanCard({ plan }: { plan: TaskPlanPresentation }) {
  const { t } = useTranslation();
  const steps = plan.steps.map(({ id, title, status: value }) => {
    const status = value ?? "pending";
    return <li className={`is-${status}`} key={id}>
      <span aria-hidden="true" className="ff-task-plan-card__marker" />
      <span>{title}</span><small>{t(STATUS_LABEL_KEYS[status])}</small>
    </li>;
  });
  return <section aria-label={t("taskPlan.panelAria")} className="ff-task-plan-card">
    <header><span>{t("taskPlan.title")}</span>{plan.title && <strong>{plan.title}</strong>}</header>
    <ol>{steps}</ol>
  </section>;
}
