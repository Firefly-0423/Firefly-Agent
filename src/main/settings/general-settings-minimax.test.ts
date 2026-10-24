import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "./general-settings";
import { syncVolcanoSearchMcp } from "./general-settings-lifecycle";
import { addMcpServer, listMcpServers, removeMcpServer } from "../orchestrator/mcp-manager";

vi.mock("../storage/storage-context", () => ({ getStorageContext: () => ({ profile: { kind: "production" } }) }));
vi.mock("electron", () => ({ nativeImage: {}, app: { setLoginItemSettings: vi.fn() } }));
vi.mock("../startup/locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../windows/window-state", () => ({ setGetCurrentAppIconPath: vi.fn() }));
vi.mock("../windows/broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../windows/app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("./model-settings", () => ({ getPublicModelConfig: vi.fn(), loadModelSettings: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ syncBuiltInToolToggles: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ listMcpServers: vi.fn(() => []), removeMcpServer: vi.fn(), addMcpServer: vi.fn() }));

const installedServer = {
  id: "minimax-web-search", name: "MiniMax搜索", connected: true,
  toolCount: 1, toolIds: ["minimax-web-search-web_search"], enabled: true,
};
const selected = { searchEngine: "minimax", searchMinimaxKey: " test-key " } as GeneralSettings;

describe("MiniMax search MCP re-registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listMcpServers).mockReturnValue([installedServer]);
    vi.mocked(removeMcpServer).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(addMcpServer).mockReset();
  });

  afterEach(() => {
    vi.mocked(listMcpServers).mockReturnValue([]);
    vi.restoreAllMocks();
  });

  it("reports reregistered when the replacement is added", async () => {
    vi.mocked(addMcpServer).mockResolvedValue({ ok: true, toolIds: ["minimax-web-search-web_search"] });

    expect(await syncVolcanoSearchMcp(selected)).toEqual({ mcpSyncResult: "reregistered" });
    expect(removeMcpServer).toHaveBeenCalledExactlyOnceWith("minimax-web-search");
    expect(addMcpServer).toHaveBeenCalledExactlyOnceWith({
      id: "minimax-web-search", name: "MiniMax搜索", transport: "stdio", command: "uvx",
      args: ["minimax-coding-plan-mcp", "-y"],
      env: { MINIMAX_API_KEY: "test-key", MINIMAX_API_HOST: "https://api.minimaxi.com" },
    });
  });

  it("surfaces a returned add failure instead of claiming success", async () => {
    vi.mocked(addMcpServer).mockResolvedValue({ ok: false, error: "synthetic connection failure", reason: "unreachable" });

    expect(await syncVolcanoSearchMcp(selected)).toEqual({ mcpSyncResult: "reregister_failed: synthetic connection failure" });
  });

  it.each(["remove", "add"])("keeps the exception result when %s rejects", async (step) => {
    const failure = new Error("synthetic MCP exception");
    vi.mocked(addMcpServer).mockResolvedValue({ ok: true, toolIds: [] });
    if (step === "remove") vi.mocked(removeMcpServer).mockRejectedValue(failure);
    else vi.mocked(addMcpServer).mockRejectedValue(failure);

    expect(await syncVolcanoSearchMcp(selected)).toEqual({ mcpSyncResult: "reregister_exception: Error: synthetic MCP exception" });
    if (step === "remove") expect(addMcpServer).not.toHaveBeenCalled();
  });
});
