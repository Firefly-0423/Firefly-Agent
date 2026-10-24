import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (_event: unknown, action?: string) => unknown>());
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "C:/repo" },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, action?: string) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  },
}));

const service = vi.hoisted(() => ({
  getState: vi.fn(async () => ({ available: false, errorCode: "QQ_MUSIC_SESSION_NOT_FOUND" })),
  control: vi.fn(async () => ({ commandSubmission: "accepted", playerStateObservation: "unchanged" })),
  shutdown: vi.fn(async () => ({ transportClosed: true, processTreeExited: true, runtimeRemoved: true })),
}));
vi.mock("./qqmusic-service", () => ({
  QqMusicService: vi.fn(function () { return service; }),
  createQqMusicExecutor: vi.fn(() => vi.fn()),
}));

const tools = vi.hoisted(() => [{ id: "music_get_playback_status", enabled: true }, { id: "music_control", enabled: true }]);
vi.mock("../orchestrator/tools/music-tools", () => ({ buildMusicTools: vi.fn(() => tools) }));
const registry = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: registry }));

import { bootstrapMusicService, resolveQqMusicScriptPath } from "./bootstrap";
import { IPC } from "../../shared/ipc-channels";

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  for (const tool of tools) tool.enabled = true;
});

describe("QQ Music bootstrap", () => {
  it("resolves the exact source script and registers only QQ channels and tools", () => {
    expect(resolveQqMusicScriptPath().replaceAll("\\", "/")).toBe("C:/repo/src/main/music/scripts/qqmusic_gsmtc.ps1");
    bootstrapMusicService();
    expect([...handlers.keys()].sort()).toEqual([IPC.MUSIC_QQ_CONTROL, IPC.MUSIC_QQ_GET_STATUS].sort());
    expect(registry.register.mock.calls.map(([tool]) => tool.id)).toEqual(tools.map((tool) => tool.id));
    expect(handlers.has(IPC.MUSIC_BEGIN_LOGIN)).toBe(false);
  });

  it("registers the tools switched off when the user has turned the music tool off", () => {
    bootstrapMusicService({ enabled: false });
    expect(tools.map((tool) => tool.enabled)).toEqual([false, false]);
    // 状态面板仍可读取，开关只管 Agent 能否调用
    expect(handlers.has(IPC.MUSIC_QQ_GET_STATUS)).toBe(true);
  });

  it("keeps the tools available by default", () => {
    bootstrapMusicService();
    expect(tools.map((tool) => tool.enabled)).toEqual([true, true]);
  });

  it("rejects invalid actions before calling the service", async () => {
    bootstrapMusicService();
    expect(() => handlers.get(IPC.MUSIC_QQ_CONTROL)?.(null, "other")).toThrow("QQ_MUSIC_INVALID_ACTION");
    expect(service.control).not.toHaveBeenCalled();
    await handlers.get(IPC.MUSIC_QQ_CONTROL)?.(null, "play");
    expect(service.control).toHaveBeenCalledWith("play");
  });

  it("unregisters both channels and tools once on shutdown", async () => {
    const bootstrap = bootstrapMusicService();
    await bootstrap.shutdown();
    await bootstrap.shutdown();
    expect(handlers.size).toBe(0);
    expect(registry.unregister.mock.calls.map(([id]) => id)).toEqual(tools.map((tool) => tool.id));
    expect(service.shutdown).toHaveBeenCalledOnce();
  });
});
