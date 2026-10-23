import React from "react";
import { useTranslation } from "../../../i18n";

export interface InterruptedRunNotice {
  todoCount: number;
  runId: string;
  rounds: number;
}
export interface SessionTakeoverNotice { sessionId: string }

export function FileDropOverlay({ visible: shown }: { visible: boolean }) {
  const { t: translate } = useTranslation();
  return shown ? <div className="ff-file-drop-overlay" aria-hidden="true">
    <span>{translate("workspaceNotices.fileDropHint")}</span>
  </div> : null;
}

type RecoveryProps = {
  onTakeover: () => void;
  onResume: (runId: string) => void;
  isRunning: boolean;
  activeSessionId?: string;
  sessionTakeover: SessionTakeoverNotice | null;
  interruptedRun: InterruptedRunNotice | null;
};

export function RunRecoveryNotices({ interruptedRun: stopped, sessionTakeover: takeover, activeSessionId: session, isRunning: running, onResume: resume, onTakeover: restart }: RecoveryProps) {
  const { t: translate } = useTranslation();
  if (running) return null;
  return <>
    {stopped && <div className="ff-harness-recovery">
      <span>{translate("workspaceNotices.interruptedRun", { rounds: stopped.rounds })}</span>
      <button type="button" onClick={() => resume(stopped.runId)}>{translate("workspaceNotices.resumeTask")}</button>
    </div>}
    {takeover && takeover.sessionId === session && <div className="ff-harness-recovery">
      <span>{translate("workspaceNotices.sessionTakeover")}</span>
      <button type="button" onClick={restart}>{translate("workspaceNotices.takeoverAndRestart")}</button>
    </div>}
  </>;
}

export function ContextCompressionNotice({ visible: shown }: { visible: boolean }) {
  const { t: translate } = useTranslation();
  return shown ? <div className="ff-compressing-context" aria-live="polite" aria-busy="true">
    <span>{translate("workspaceNotices.compressingContext")}</span>
  </div> : null;
}
