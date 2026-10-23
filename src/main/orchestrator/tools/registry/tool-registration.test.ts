import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerBrowserWorkspaceTool: vi.fn(),
  loadGeneralSettings: vi.fn(),
  loadModelSettings: vi.fn(),
  registerEmailTools: vi.fn(),
  registerObsidianTools: vi.fn(),
  registerDocumentTools: vi.fn(),
  registerLifeTools: vi.fn(),
  setTranslateConfig: vi.fn(),
  registerRecallHistoryTool: vi.fn(),
  registerSearchCodeTool: vi.fn(),
  registerSearchTextTool: vi.fn(),
  registerApplyPatchTool: vi.fn(),
  registerAstGrepTools: vi.fn(),
  registerTravelTools: vi.fn(),
  registerCodeGitTools: vi.fn(),
  registerLspTool: vi.fn(),
  toolRegistry: {
    setEnabled: vi.fn(),
    setPersonalMemoryMode: vi.fn(),
  },
  MUSIC_TOOL_IDS: ["music_get_playback_status", "music_control"],
}));

vi.mock("../browser-workspace-tool", () => ({
  registerBrowserWorkspaceTool: mocks.registerBrowserWorkspaceTool,
}));
vi.mock("../../../settings/settings-facade", () => ({
  loadGeneralSettings: mocks.loadGeneralSettings,
}));
vi.mock("../../../settings/model-settings", () => ({
  loadModelSettings: mocks.loadModelSettings,
}));
vi.mock("../email-tools", () => ({ registerEmailTools: mocks.registerEmailTools }));
vi.mock("../../../knowledge/obsidian/obsidian-tools", () => ({
  registerObsidianTools: mocks.registerObsidianTools,
}));
vi.mock("../document-tools", () => ({ registerDocumentTools: mocks.registerDocumentTools }));
vi.mock("../fs-tools", () => ({}));
vi.mock("../life-tools", () => ({
  registerLifeTools: mocks.registerLifeTools,
  setTranslateConfig: mocks.setTranslateConfig,
}));
vi.mock("../history-tools", () => ({
  registerRecallHistoryTool: mocks.registerRecallHistoryTool,
}));
vi.mock("../search-code-tools", () => ({
  registerSearchCodeTool: mocks.registerSearchCodeTool,
  registerSearchTextTool: mocks.registerSearchTextTool,
}));
vi.mock("../apply-patch-tools", () => ({
  registerApplyPatchTool: mocks.registerApplyPatchTool,
}));
vi.mock("../ast-grep-tools", () => ({ registerAstGrepTools: mocks.registerAstGrepTools }));
vi.mock("./tool-registry", () => ({ toolRegistry: mocks.toolRegistry }));
vi.mock("../travel-tools", () => ({ registerTravelTools: mocks.registerTravelTools }));
vi.mock("../git-tools", () => ({ registerCodeGitTools: mocks.registerCodeGitTools }));
vi.mock("../lsp-tool", () => ({ registerLspTool: mocks.registerLspTool }));
vi.mock("../built-in-tools", () => ({}));
vi.mock("../music-tools", () => ({ MUSIC_TOOL_IDS: mocks.MUSIC_TOOL_IDS }));

import { registerAllTools, syncBuiltInToolToggles } from "./tool-registration";

const generalSettings = {
  weatherEnabled: true,
  travelEnabled: false,
  musicEnabled: true,
};
const modelSettings = {
  provider: "deepseek",
  baseUrl: "https://api.example.test",
  model: "demo",
  apiKey: "secret",
  explicitTransport: "openai" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadGeneralSettings.mockReturnValue(generalSettings);
  mocks.loadModelSettings.mockReturnValue(modelSettings);
});

describe("syncBuiltInToolToggles", () => {
  it("maps the three user-facing toggles onto their tool ids", () => {
    syncBuiltInToolToggles(generalSettings);

    expect(mocks.toolRegistry.setEnabled).toHaveBeenCalledTimes(4);
    expect(mocks.toolRegistry.setEnabled).toHaveBeenCalledWith("weather", true);
    expect(mocks.toolRegistry.setEnabled).toHaveBeenCalledWith("plan_trip", false);
    for (const id of mocks.MUSIC_TOOL_IDS) {
      expect(mocks.toolRegistry.setEnabled).toHaveBeenCalledWith(id, true);
    }
  });

  it("propagates disabled values", () => {
    syncBuiltInToolToggles({ weatherEnabled: false, travelEnabled: false, musicEnabled: false });

    for (const [id, enabled] of mocks.toolRegistry.setEnabled.mock.calls) {
      expect(["weather", "plan_trip", ...mocks.MUSIC_TOOL_IDS]).toContain(id);
      expect(enabled).toBe(false);
    }
  });
});

describe("registerAllTools", () => {
  it("registers every tool family with the real registry and its dependencies", () => {
    const deps = {
      codeGitService: { id: "git" },
      lspManager: { id: "lsp" },
      browserWorkspace: vi.fn(),
    };

    registerAllTools(deps as never);

    expect(mocks.toolRegistry.setPersonalMemoryMode).toHaveBeenCalledWith("legacy");
    expect(mocks.registerBrowserWorkspaceTool).toHaveBeenCalledWith(
      deps.browserWorkspace,
      mocks.toolRegistry,
    );
    expect(mocks.registerObsidianTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerCodeGitTools).toHaveBeenCalledWith(
      deps.codeGitService,
      mocks.toolRegistry,
    );
    expect(mocks.registerLspTool).toHaveBeenCalledWith(deps.lspManager, mocks.toolRegistry);
    expect(mocks.registerSearchCodeTool).toHaveBeenCalledTimes(1);
    expect(mocks.registerSearchTextTool).toHaveBeenCalledTimes(1);
    expect(mocks.registerApplyPatchTool).toHaveBeenCalledTimes(1);
    expect(mocks.registerAstGrepTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerRecallHistoryTool).toHaveBeenCalledWith({
      personalMemoryMode: undefined,
    });
    expect(mocks.registerDocumentTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerLifeTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerTravelTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerEmailTools).toHaveBeenCalledTimes(1);
    expect(mocks.loadGeneralSettings).toHaveBeenCalledTimes(1);
    expect(mocks.toolRegistry.setEnabled).toHaveBeenCalledWith("weather", true);
  });

  it("passes the personal memory mode through and defaults to legacy", () => {
    registerAllTools({
      codeGitService: {},
      lspManager: {},
      personalMemoryMode: "smh",
    } as never);

    expect(mocks.toolRegistry.setPersonalMemoryMode).toHaveBeenCalledWith("smh");
    expect(mocks.registerRecallHistoryTool).toHaveBeenCalledWith({ personalMemoryMode: "smh" });
  });

  it("supplies a network-unavailable executor when browser workspace is absent", async () => {
    registerAllTools({ codeGitService: {}, lspManager: {} } as never);

    const executor = mocks.registerBrowserWorkspaceTool.mock.calls[0][0];
    await expect(executor({ operation: "observe" })).resolves.toEqual({
      ok: false,
      code: "network_unavailable",
    });
  });

  it("derives translate configuration from current model settings", () => {
    let translateConfig: (() => unknown) | undefined;
    mocks.setTranslateConfig.mockImplementation((factory: () => unknown) => {
      translateConfig = factory;
    });

    registerAllTools({ codeGitService: {}, lspManager: {} } as never);
    expect(translateConfig).toBeTypeOf("function");
    expect(translateConfig!()).toEqual({
      provider: "deepseek",
      baseUrl: "https://api.example.test",
      model: "demo",
      apiKey: "secret",
      explicitTransport: "openai",
    });

    mocks.loadModelSettings.mockReturnValue({ ...modelSettings, apiKey: "" });
    expect(translateConfig!()).toBeNull();
  });

  it("re-reads model settings for each translate request", () => {
    let translateConfig: (() => unknown) | undefined;
    mocks.setTranslateConfig.mockImplementation((factory: () => unknown) => {
      translateConfig = factory;
    });

    registerAllTools({ codeGitService: {}, lspManager: {} } as never);
    translateConfig!();
    translateConfig!();

    expect(mocks.loadModelSettings).toHaveBeenCalledTimes(2);
  });
});
