import React, { useId, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import { getCharacterPortraitByAssetFileName } from "../../../character-portraits";
import { useChatInspectorActions } from "./inspector-actions";
import './RunExperience.css';

// 每种状态对应一个符号（不是文案）和一个 i18n key。t() 不能放在模块顶层，所以文案仍然在组件内求值。
type DelegationStatusView = { marker: string; textKey: string };
const STATUS_VIEW: Record<TaskDelegationDisplayRecord["status"], DelegationStatusView> = {
  running: { marker: "◌", textKey: "taskDelegation.statusRunning" },
  completed: { marker: "✓", textKey: "taskDelegation.statusCompleted" },
  failed: { marker: "×", textKey: "taskDelegation.statusFailed" },
  cancelled: { marker: "×", textKey: "taskDelegation.statusCancelled" },
};

export function TaskDelegationRow({ delegation }: { delegation: TaskDelegationDisplayRecord }) {
  return <TaskDelegationDisclosure key={delegation.invocationId} delegation={delegation} />;
}

function TaskDelegationDisclosure({ delegation }: { delegation: TaskDelegationDisplayRecord }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // useId keeps duplicate historical renderings distinct without exposing private task data.
  // https://react.dev/reference/react/useId
  const detailsId = useId();
  // Inside the chat the row opens the result in the right-hand panel; elsewhere it unfolds the public description in place.
  const { openDelegation } = useChatInspectorActions();
  const portraitUrl = getCharacterPortraitByAssetFileName(delegation.assetFileName);
  return (
    <div className={`ff-task-delegation is-${delegation.status}`}>
      <button type="button" className="ff-task-delegation__summary"
        {...(openDelegation ? { title: t("taskDelegation.openResult") } : { "aria-expanded": expanded, "aria-controls": detailsId })}
        onClick={() => { if (openDelegation) openDelegation(delegation.taskId); else setExpanded(value => !value); }}
        onKeyDown={event => {
          if (openDelegation || event.key !== "Escape" || !expanded) return;
          event.stopPropagation(); setExpanded(false); event.currentTarget.focus();
        }}>
        <span className="ff-task-delegation__marker" aria-hidden="true">{STATUS_VIEW[delegation.status].marker}</span>
        {portraitUrl && <img className="ff-task-delegation__avatar" src={portraitUrl} alt="" />}
        <span className="ff-task-delegation__copy">
          <span className="ff-task-delegation__assignee">
            <span className="ff-task-delegation__lead">{t("taskDelegation.delegatedTo")}</span>{" "}
            <span className="ff-task-delegation__nickname">{delegation.nickname}</span>
          </span>
          <span className="ff-task-delegation__description">{delegation.description}</span>
        </span>
        <span className="ff-task-delegation__status" role="status" aria-live="polite" aria-atomic="true">{t(STATUS_VIEW[delegation.status].textKey)}</span>
        <svg className="ff-task-delegation__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {!openDelegation && <div id={detailsId} className="ff-task-delegation__details" hidden={!expanded}>
        <p>{delegation.description}</p>
        <dl><dt>{t("taskDelegation.taskReference")}</dt><dd>{delegation.taskId}</dd></dl>
      </div>}
    </div>
  );
}
