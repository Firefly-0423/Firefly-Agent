import { createSettingsCoreMethods } from "./core";
import { createSettingsExtensionMethods } from "./extensions";
import { createSettingsChannelMethods } from "./channels";
import { createSettingsApprovalMethods } from "./approvals";

/** 拼装 window.settings：四个切片按原对象的键序展开，结果与拆分前同构。 */
export function createSettingsApi(ipcRenderer: Electron.IpcRenderer) {
    return {
        ...createSettingsCoreMethods(ipcRenderer),
        ...createSettingsExtensionMethods(ipcRenderer),
        ...createSettingsChannelMethods(ipcRenderer),
        ...createSettingsApprovalMethods(ipcRenderer),
    };
}
