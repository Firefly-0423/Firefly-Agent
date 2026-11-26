import { IPC } from "../shared/ipc-channels";

export interface SchedulerIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createSchedulerEventsApi(ipcRenderer: SchedulerIpcRenderer) {
    return {
        onEvent: (receive: (eventData: unknown) => void) => {
            const forwardEvent = (_ipcEvent: unknown, eventData: unknown) => {
                try {
                    receive(eventData);
                }
                catch (listenerFailure) {
                    console.error("[Preload] scheduler listener抛错:", listenerFailure);
                }
            };
            ipcRenderer.on(IPC.SCHEDULER_EVENT, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.SCHEDULER_EVENT, forwardEvent);
            };
        },
    };
}

export function createSchedulerApi(ipcRenderer: SchedulerIpcRenderer) {
    return {
        list: () => {
            return ipcRenderer.invoke(IPC.SCHEDULER_LIST);
        },
        add: (request: unknown) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_ADD, request);
        },
        update: (entityId: string, patch: unknown) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_UPDATE, entityId, patch);
        },
        delete: (entityId: string) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_DELETE, entityId);
        },
        toggle: (entityId: string, active: boolean) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_TOGGLE, entityId, active);
        },
        fireNow: (entityId: string) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_FIRE_NOW, entityId);
        },
        getHistory: (taskId: string, limit?: number) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_GET_HISTORY, taskId, limit);
        },
        getTools: () => {
            return ipcRenderer.invoke(IPC.SCHEDULER_GET_TOOLS);
        },
        listPluginProposals: () => {
            return ipcRenderer.invoke(IPC.SCHEDULER_PLUGIN_PROPOSALS_LIST);
        },
        confirmPluginProposal: (taskId: string, revision: string) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_PLUGIN_PROPOSALS_CONFIRM, taskId, revision);
        },
        rejectPluginProposal: (taskId: string) => {
            return ipcRenderer.invoke(IPC.SCHEDULER_PLUGIN_PROPOSALS_REJECT, taskId);
        },
    };
}
