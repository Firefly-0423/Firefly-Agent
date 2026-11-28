import { IPC } from "../../shared/ipc-channels";
import type { ApprovalRequest, ApprovalSettledPayload } from "../../shared/permission-approval";

type PlanStateChange = {
    conversationId: string;
    state: string;
};

/** window.settings 的权限档位、计划模式、运行审批、随堂测验与截图快捷键方法。 */
export function createSettingsApprovalMethods(ipcRenderer: Electron.IpcRenderer) {
    return {
        getPermissionLevel: () => {
            return ipcRenderer.invoke(IPC.PERMISSION_GET_LEVEL);
        },
        setPermissionLevel: (level: string) => {
            return ipcRenderer.invoke(IPC.PERMISSION_SET_LEVEL, level);
        },
        setPlanMode: (message: {
            conversationId: string;
            target: "on" | "off";
            workspaceRoot?: string;
        }) => {
            return ipcRenderer.invoke(IPC.PLAN_SET_MODE, message);
        },
        getPlanState: (conversationId: string) => {
            return ipcRenderer.invoke(IPC.PLAN_GET_STATE, { conversationId });
        },
        onPlanStateChanged: (receive: (message: PlanStateChange) => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, message: PlanStateChange) => {
                return receive(message);
            };
            ipcRenderer.on(IPC.PLAN_STATE_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PLAN_STATE_CHANGED, forwardEvent);
            };
        },
        onPermissionApprovalRequest: (receive: (req: ApprovalRequest) => void): (() => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, req: Parameters<typeof receive>[0]) => {
                return receive(req);
            };
            ipcRenderer.on(IPC.PERMISSION_APPROVAL_REQUEST, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_REQUEST, forwardEvent);
            };
        },
        resolvePermissionApproval: (entityId: string, allowed: boolean): Promise<{
            ok: boolean;
        }> => {
            return ipcRenderer.invoke(IPC.PERMISSION_APPROVAL_RESOLVE, { id: entityId, allowed });
        },
        onPermissionApprovalSettled: (receive: (settlement: ApprovalSettledPayload) => void): (() => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, settlement: Parameters<typeof receive>[0]) => {
                return receive(settlement);
            };
            ipcRenderer.on(IPC.PERMISSION_APPROVAL_SETTLED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_SETTLED, forwardEvent);
            };
        },
        onPopQuizRequest: (receive: (card: {
            quizId: string;
            runId: string;
            intro: string;
            questions: unknown[];
        }) => void): (() => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, card: Parameters<typeof receive>[0]) => {
                return receive(card);
            };
            ipcRenderer.on(IPC.POP_QUIZ_REQUEST, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.POP_QUIZ_REQUEST, forwardEvent);
            };
        },
        resolvePopQuiz: (submission: unknown): Promise<{
            ok: boolean;
            error?: string;
            graded?: unknown[];
        }> => {
            return ipcRenderer.invoke(IPC.POP_QUIZ_RESOLVE, submission);
        },
        skipPopQuiz: (quizId: string): Promise<{
            ok: boolean;
            error?: string;
        }> => {
            return ipcRenderer.invoke(IPC.POP_QUIZ_SKIP, { quizId });
        },
        onPopQuizSettled: (receive: (settlement: {
            quizId: string;
            runId?: string;
            reason: "submitted" | "skipped" | "cancelled";
        }) => void): (() => void) => {
            const forwardEvent = (_ipcEvent: Electron.IpcRendererEvent, settlement: Parameters<typeof receive>[0]) => {
                return receive(settlement);
            };
            ipcRenderer.on(IPC.POP_QUIZ_SETTLED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.POP_QUIZ_SETTLED, forwardEvent);
            };
        },
        beginScreenshotHotkeyCapture: () => {
            return ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_START);
        },
        endScreenshotHotkeyCapture: () => {
            return ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_END);
        },
    };
}
