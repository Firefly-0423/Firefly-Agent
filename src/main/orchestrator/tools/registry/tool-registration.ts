import { registerBrowserWorkspaceTool } from "../browser-workspace-tool";
import type { BrowserWorkspaceExecutor } from "../../../browser/browser-workspace-executor";
import { loadGeneralSettings } from "../../../settings/settings-facade";
import { loadModelSettings } from "../../../settings/model-settings";
import type { GeneralSettings } from "../../../settings/general-settings";
import { registerEmailTools } from "../email-tools";
import { registerObsidianTools } from "../../../knowledge/obsidian/obsidian-tools";
import { registerDocumentTools } from "../document-tools";
import "../fs-tools";
import { registerLifeTools, setTranslateConfig } from "../life-tools";
import { registerRecallHistoryTool } from "../history-tools";
import { registerSearchCodeTool, registerSearchTextTool } from "../search-code-tools";
import { registerApplyPatchTool } from "../apply-patch-tools";
import { registerAstGrepTools } from "../ast-grep-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "../travel-tools";
import type { GitService } from "../../../code-git/git-service";
import { registerCodeGitTools } from "../git-tools";
import type { LspManager } from "../../../lsp/manager";
import { registerLspTool } from "../lsp-tool";
import "../built-in-tools";
import { MUSIC_TOOL_IDS } from "../music-tools";

export function syncBuiltInToolToggles(preferences: GeneralSettings): void {
  toolRegistry.setEnabled("weather", preferences.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", preferences.travelEnabled);
  MUSIC_TOOL_IDS.forEach(toolId => toolRegistry.setEnabled(toolId, preferences.musicEnabled));
}

export function registerAllTools(services: {
  codeGitService: GitService; lspManager: LspManager;
  browserWorkspace?: BrowserWorkspaceExecutor; personalMemoryMode?: "legacy" | "smh";
}): void {
  toolRegistry.setPersonalMemoryMode(services.personalMemoryMode ?? "legacy");
  registerBrowserWorkspaceTool(services.browserWorkspace ?? (async () => ({ ok: false, code: "network_unavailable" })), toolRegistry);
  registerObsidianTools();
  registerCodeGitTools(services.codeGitService, toolRegistry);
  registerLspTool(services.lspManager, toolRegistry);

  // 保持启动时的工具插入次序。
  for (const install of [registerSearchCodeTool, registerSearchTextTool, registerApplyPatchTool, registerAstGrepTools]) install();
  registerRecallHistoryTool({ personalMemoryMode: services.personalMemoryMode });
  registerDocumentTools();
  setTranslateConfig(() => {
    const modelSettings = loadModelSettings();
    if (!modelSettings.apiKey) return null;
    return {
      provider: modelSettings.provider, baseUrl: modelSettings.baseUrl, model: modelSettings.model,
      apiKey: modelSettings.apiKey, explicitTransport: modelSettings.explicitTransport,
    };
  });
  for (const install of [registerLifeTools, registerTravelTools, registerEmailTools]) install();
  syncBuiltInToolToggles(loadGeneralSettings());
}
