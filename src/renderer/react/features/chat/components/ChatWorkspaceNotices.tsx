import React from "react";
import { useTranslation } from "../../../i18n";

export interface InterruptedRunNotice {
  todoCount: number;
  runId: string;
  rounds: number;
}
export interface SessionTakeoverNotice { phase: "offered" | "waiting" | "stuck" }

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
  sessionTakeover?: SessionTakeoverNotice;
  interruptedRun: InterruptedRunNotice | null;
};

export function RunRecoveryNotices({ interruptedRun: stopped, sessionTakeover: takeover, isRunning: running, onResume: resume, onTakeover: restart }: RecoveryProps) {
  const { t: translate } = useTranslation();
  return <>
    {!running && !takeover && stopped && <div className="ff-harness-recovery">
      <span>{translate("workspaceNotices.interruptedRun", { rounds: stopped.rounds })}</span>
      <button type="button" onClick={() => resume(stopped.runId)}>{translate("workspaceNotices.resumeTask")}</button>
    </div>}
    {!running && takeover?.phase === "offered" && <div className="ff-harness-recovery">
      <span>{translate("workspaceNotices.sessionTakeover")}</span>
      <button type="button" onClick={restart}>{translate("workspaceNotices.takeoverAndRestart")}</button>
    </div>}
    {takeover?.phase === "waiting" && <div className="ff-harness-recovery" aria-busy="true">
      <button type="button" disabled>{translate("workspaceNotices.takeoverWaiting")}</button>
    </div>}
    {takeover?.phase === "stuck" && <div className="ff-harness-recovery">
      <span role="status">{translate("workspaceNotices.takeoverStuck")}</span>
      <button type="button" onClick={restart}>{translate("workspaceNotices.takeoverRetry")}</button>
    </div>}
  </>;
}

export function ContextCompressionNotice({ visible: shown }: { visible: boolean }) {
  const { t: translate } = useTranslation();
  return shown ? <div className="ff-compressing-context" aria-live="polite" aria-busy="true">
    <span>{translate("workspaceNotices.compressingContext")}</span>
  </div> : null;
}
