import type { SettingsApi } from "./settings/shared/types";
import type { DesktopAsrApi } from "../shared/desktop-asr";
import type { BrowserAvailabilityApi } from "../shared/browser-availability";
import type { ModelConfigApi } from "../shared/model-connection-types";
import type { AppUpdateApi } from "../shared/app-update";
import type { ReviewRestoreOutcome, ReviewSnapshot } from "../shared/review-types";
import type { StickerManagerApi } from "../shared/sticker-types";
import type { PluginPanelApi, PluginManagementApi } from "../shared/plugin-management";
import type { WorkspaceSaveResult, WorkspaceReadResult, WorkspaceListResult } from "../shared/workspace-files-types";
import type { OpenInAppOpenResult, OpenInAppListResult } from "../shared/open-in-app-types";

interface ReviewApi {
  restore: (runId: string) => Promise<ReviewRestoreOutcome>;
  get: (runId: string) => Promise<ReviewSnapshot | null>;
}
interface WorkspaceFilesApi {
  save: (sessionId: string, relPath: string, content: string, editVersion: string) => Promise<WorkspaceSaveResult>;
  read: (sessionId: string, relPath: string) => Promise<WorkspaceReadResult>;
  list: (sessionId: string, relPath: string) => Promise<WorkspaceListResult>;
}
interface OpenInAppApi {
  open: (sessionId: string, appId: string) => Promise<OpenInAppOpenResult>;
  listApps: (sessionId: string) => Promise<OpenInAppListResult>;
}
interface ChatWindowApi {
  getGeneralSettings: () => Promise<{ language?: string }>;
  getImagePreview: (filePath: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  getEnabledStickers: () => Promise<Array<{ id: string; src: string }>>;
  endWindowDrag: () => void;
  startWindowDrag: () => void;
  isMaximized: () => Promise<boolean>;
  toggleMaximize: () => void;
  close: () => void;
  minimize: () => void;
}
declare global {
  interface Window {
    settings?: SettingsApi;
    stickerManager?: StickerManagerApi;
    chat?: ChatWindowApi;
    toast?: ToastRendererApi;
    pluginPanel?: PluginPanelApi;
    plugins?: PluginManagementApi;
    appUpdate?: AppUpdateApi;
    openInApp?: OpenInAppApi;
    workspaceFiles?: WorkspaceFilesApi;
    review?: ReviewApi;
    modelConfig?: ModelConfigApi;
    manualBrowserWorkspace?: import("../shared/manual-browser").ManualBrowserWorkspaceApi;
    manualBrowser?: BrowserAvailabilityApi;
    desktopAsr?: DesktopAsrApi;
  }
}
export {};
