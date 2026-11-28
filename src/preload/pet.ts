import { IPC } from "../shared/ipc-channels";

export interface PetIpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
    removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => unknown;
}

export function createFireflyApi(ipcRenderer: PetIpcRenderer) {
    return {
        minimize: () => {
            return ipcRenderer.send(IPC.WINDOW_MINIMIZE);
        },
        setInteractive: (interactive: boolean) => {
            return ipcRenderer.invoke(IPC.WINDOW_SET_INTERACTIVE, interactive);
        },
        moveTo: (x: number, y: number) => {
            return ipcRenderer.send(IPC.WINDOW_MOVE_TO, x, y);
        },
        setDragging: (isDragging: boolean) => {
            return ipcRenderer.send(IPC.WINDOW_SET_DRAGGING, isDragging);
        },
        getCursorPosition: () => {
            return ipcRenderer.invoke(IPC.WINDOW_GET_CURSOR_POSITION);
        },
        onPetZoom: (receive: (zoom: number) => void) => {
            const forwardEvent = (_ipcEvent: unknown, zoom: number) => {
                return receive(zoom);
            };
            ipcRenderer.on(IPC.PET_ZOOM, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PET_ZOOM, forwardEvent);
            };
        },
        onPetVisibilityChanged: (receive: (visible: boolean) => void) => {
            const forwardEvent = (_ipcEvent: unknown, visible: boolean) => {
                return receive(visible);
            };
            ipcRenderer.on(IPC.PET_VISIBILITY_CHANGED, forwardEvent);
            return () => {
                return ipcRenderer.removeListener(IPC.PET_VISIBILITY_CHANGED, forwardEvent);
            };
        },
    };
}
