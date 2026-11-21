import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, type PluginRuntime } from "./context";
import { createPluginEventBus } from "./events";
import { createPluginPromptRegistry } from "./prompts";
import type {
  FireflyPlugin,
  PluginConversationMessage,
  PluginDeps,
  PluginManifest,
  PluginTool,
  PluginTurnFinishedEvent,
} from "./types";

const repoRoot = path.resolve(__dirname, "../..");

function createTempStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "firefly-example-lifecycle-"));
}

function loadFreshPlugin<T extends FireflyPlugin>(
  relativePath: string,
  customRequire?: (id: string) => unknown,
): T {
  const absPath = path.join(repoRoot, relativePath);
  const raw = fs.readFileSync(absPath, "utf8");
  const code = relativePath.endsWith(".ts")
    ? ts.transpileModule(raw, {
        fileName: absPath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          strict: true,
        },
      }).outputText
    : raw;
  const mod = { exports: {} as unknown };
  const localRequire = createRequire(absPath);
  const wrappedRequire = (id: string) => customRequire?.(id) ?? localRequire(id);
  const execute = new Function("require", "module", "exports", "__filename", "__dirname", code);
  execute(wrappedRequire, mod, mod.exports, absPath, path.dirname(absPath));
  const exported = mod.exports as { default?: T } & T;
  return (exported.default ?? exported) as T;
}

type ActivatedSession = {
  plugin: FireflyPlugin;
  ctx: ReturnType<typeof createContext>;
  tools: Map<string, PluginTool>;
  ipc: Map<string, (...args: unknown[]) => unknown>;
  prompts: ReturnType<typeof createPluginPromptRegistry>;
  bus: ReturnType<typeof createPluginEventBus>;
  stop: () => Promise<string[]>;
};

async function activateSession(options: {
  pluginId: string;
  entryPath: string;
  storageDir: string;
  requirements?: PluginManifest["deps"];
  services?: PluginDeps;
  pluginInstance?: FireflyPlugin;
  customRequire?: (id: string) => unknown;
}): Promise<ActivatedSession> {
  const tools = new Map<string, PluginTool>();
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const prompts = createPluginPromptRegistry();
  const bus = createPluginEventBus();
  const plugin = options.pluginInstance ?? loadFreshPlugin<FireflyPlugin>(options.entryPath, options.customRequire);

  const runtime: PluginRuntime = {
    toolRegistry: {
      register: (tool) => { tools.set(tool.id, tool); },
      unregister: (id) => tools.delete(id),
    },
    channelManager: {
      has: () => false,
      register: () => {},
      startOne: async () => {},
      unregister: async () => true,
    },
    registerIpc: (channel, handler) => { ipc.set(channel, handler); },
    unregisterIpc: (channel) => { ipc.delete(channel); },
    promptRegistry: prompts,
    hostServices: {
      createForPlugin: () => options.services ?? {},
    },
  };

  const ctx = createContext(options.pluginId, options.storageDir, runtime, bus, options.requirements);
  await plugin.register(ctx);

  const stop = async (): Promise<string[]> => {
    const order: string[] = ["beginStop"];
    // 按 src/plugins/manager.ts 的真实停止顺序执行
    ctx.beginStop();
    if (plugin.unregister) {
      order.push("unregister");
      await plugin.unregister();
    }
    order.push("dispose");
    await ctx.dispose();
    return order;
  };

  return { plugin, ctx, tools, ipc, prompts, bus, stop };
}

let tempDirs: string[] = [];
const activeSessions: ActivatedSession[] = [];

function trackTempDir(): string {
  const dir = createTempStorageRoot();
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  while (activeSessions.length) {
    const session = activeSessions.pop()!;
    try {
      await session.ctx.dispose();
    } catch {
      // 忽略清理异常，确保后续目录删除
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin examples real host lifecycle & JSON persistence", () => {
  it("weather-tool persists lastCity across unregister -> dispose -> JSON roundtrip and restores on restart", async () => {
    const storageDir = trackTempDir();
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ latitude: 31.23, longitude: 121.47 }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ current: { temperature_2m: 22, relative_humidity_2m: 60, wind_speed_10m: 12 } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const secrets = { get: vi.fn(async () => undefined), set: vi.fn(), delete: vi.fn() };
    const session1 = await activateSession({
      pluginId: "weather-tool",
      entryPath: "examples/weather-tool/index.ts",
      storageDir,
      requirements: ["secrets"],
      services: { secrets },
    });
    activeSessions.push(session1);

    const firstReply = await session1.tools.get("weather-tool_query")!.execute({ city: "上海" });
    expect(firstReply).toBe("上海 当前 22°C，湿度 60%，风速 12 km/h（Open-Meteo）");

    const order = await session1.stop();
    expect(order).toEqual(["beginStop", "unregister", "dispose"]);

    const persistedFile = path.join(storageDir, "lastCity.json");
    expect(fs.existsSync(persistedFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(persistedFile, "utf8"))).toBe("上海");

    fetchMock.mockClear();
    const session2 = await activateSession({
      pluginId: "weather-tool",
      entryPath: "examples/weather-tool/index.ts",
      storageDir,
      requirements: ["secrets"],
      services: { secrets },
    });
    activeSessions.push(session2);

    const secondReply = await session2.tools.get("weather-tool_query")!.execute({});
    expect(secondReply).toBe("上海 当前 22°C，湿度 60%，风速 12 km/h（Open-Meteo）");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`name=${encodeURIComponent("上海")}`);
  });

  it("weather-tool does not write undefined or crash real JSON storage when stopped without any query", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storageDir = trackTempDir();
    const secrets = { get: vi.fn(async () => undefined), set: vi.fn(), delete: vi.fn() };
    const session = await activateSession({
      pluginId: "weather-tool",
      entryPath: "examples/weather-tool/index.ts",
      storageDir,
      requirements: ["secrets"],
      services: { secrets },
    });
    activeSessions.push(session);

    await expect(session.stop()).resolves.toEqual(["beginStop", "unregister", "dispose"]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(storageDir, "lastCity.json"))).toBe(false);
  });

  it("long-term-memory paginates all message pages, skips turns without finalMessageId, and roundtrips Map via JSON", async () => {
    const storageDir = trackTempDir();
    const pages: PluginConversationMessage[][] = [
      [
        { id: "m1", role: "user", text: "第一页问题", at: "2026-11-19T10:00:00Z" },
        { id: "m2", role: "assistant", text: "第一页回复", at: "2026-11-19T10:00:01Z" },
      ],
      [
        { id: "m3", role: "user", text: "第二页补充", at: "2026-11-19T10:00:02Z" },
        { id: "m4", role: "assistant", text: "第二页确认", at: "2026-11-19T10:00:03Z" },
      ],
      [
        { id: "m5", role: "user", text: "第三页收尾", at: "2026-11-19T10:00:04Z" },
        { id: "m6", role: "assistant", text: "第三页结论", at: "2026-11-19T10:00:05Z" },
      ],
    ];
    const getMessages = vi.fn(async (input: { cursor?: string }) => {
      if (!input.cursor) {
        return { items: pages[0], nextCursor: "cursor-2", range: { fromMessageId: "m1", throughMessageId: "m6" } };
      }
      if (input.cursor === "cursor-2") {
        return { items: pages[1], nextCursor: "cursor-3", range: { fromMessageId: "m1", throughMessageId: "m6" } };
      }
      return { items: pages[2], range: { fromMessageId: "m1", throughMessageId: "m6" } };
    });
    const generateText = vi.fn(async () => "确认三页方案并定稿");

    const session1 = await activateSession({
      pluginId: "long-term-memory",
      entryPath: "examples/long-term-memory/index.ts",
      storageDir,
      requirements: ["llm", "conversations"],
      services: {
        llm: { generateText },
        conversations: {
          list: async () => ({ items: [] }),
          getMessages,
        },
      },
    });
    activeSessions.push(session1);

    const completeEvent: PluginTurnFinishedEvent = {
      eventId: "evt-1",
      timestamp: "2026-11-19T10:00:06Z",
      runId: "run-1",
      source: "desktop",
      mode: "chat",
      status: "success",
      conversationId: "conv-1",
      inputMessageId: "m1",
      finalMessageId: "m6",
    };
    await session1.bus.emit("host:turn:finished", completeEvent);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));

    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(getMessages.mock.calls.map((call) => call[0])).toEqual([
      { conversationId: "conv-1", fromMessageId: "m1", throughMessageId: "m6", limit: 50 },
      { conversationId: "conv-1", cursor: "cursor-2", limit: 50 },
      { conversationId: "conv-1", cursor: "cursor-3", limit: 50 },
    ]);
    const promptMessages = generateText.mock.calls[0]?.[0] as Array<{ content: string }>;
    expect(promptMessages[1]?.content).toContain("第一页问题");
    expect(promptMessages[1]?.content).toContain("第二页确认");
    expect(promptMessages[1]?.content).toContain("第三页结论");

    const missingFinalEvent: PluginTurnFinishedEvent = {
      eventId: "evt-2",
      timestamp: "2026-11-19T10:01:00Z",
      runId: "run-2",
      source: "desktop",
      mode: "chat",
      status: "success",
      conversationId: "conv-missing-final",
      inputMessageId: "m10",
    };
    await session1.bus.emit("host:turn:finished", missingFinalEvent);
    await Promise.resolve();
    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(generateText).toHaveBeenCalledTimes(1);

    const order = await session1.stop();
    expect(order).toEqual(["beginStop", "unregister", "dispose"]);

    const memoriesPath = path.join(storageDir, "memories.json");
    expect(fs.existsSync(memoriesPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(memoriesPath, "utf8"))).toEqual({
      "conv-1": ["确认三页方案并定稿"],
    });

    const session2 = await activateSession({
      pluginId: "long-term-memory",
      entryPath: "examples/long-term-memory/index.ts",
      storageDir,
      requirements: ["llm", "conversations"],
      services: {
        llm: { generateText },
        conversations: {
          list: async () => ({ items: [] }),
          getMessages,
        },
      },
    });
    activeSessions.push(session2);

    const recall = session2.tools.get("long-term-memory_recall")!;
    expect(await recall.execute({ conversationId: "conv-1" })).toBe("1. 确认三页方案并定稿");
    expect(await recall.execute({})).toBe("conv-1: 1 条");

    const promptAddition = await session2.prompts.build({
      source: "conversation",
      mode: "chat",
      conversationId: "conv-1",
    });
    expect(promptAddition).toContain("确认三页方案并定稿");
  });

  it("scheduled-automation preserves owned task IDs across stop, JSON storage roundtrip, and restart", async () => {
    const storageDir = trackTempDir();
    const makeScheduler = () => ({
      createTask: vi.fn(async (input: { title: string; prompt: string; schedule: { kind: "daily"; timeOfDay: string } }) => ({
        id: "task-alpha",
        title: input.title,
        prompt: input.prompt,
        mode: "chat" as const,
        schedule: input.schedule,
        allowedToolIds: [],
        enabled: false,
        nextFireAt: null,
        createdAt: "",
        updatedAt: "",
      })),
      listTasks: vi.fn(async () => []),
      updateTask: vi.fn(async (id: string, changes: { title?: string }) => ({
        id,
        title: changes.title ?? "晨会提醒",
        prompt: "整理议程",
        mode: "chat" as const,
        schedule: { kind: "daily" as const, timeOfDay: "09:00" },
        allowedToolIds: [],
        enabled: false,
        nextFireAt: null,
        createdAt: "",
        updatedAt: "",
      })),
      deleteTask: vi.fn(async () => true),
      getHistory: vi.fn(async () => []),
    });

    const scheduler1 = makeScheduler();
    const session1 = await activateSession({
      pluginId: "scheduled-automation",
      entryPath: "examples/scheduled-automation/index.ts",
      storageDir,
      requirements: ["scheduler"],
      services: { scheduler: scheduler1 },
    });
    activeSessions.push(session1);

    const createdMsg = await session1.tools.get("scheduled-automation_create")!.execute({
      title: "晨会提醒",
      prompt: "整理议程",
      timeOfDay: "09:00",
    });
    expect(createdMsg).toContain("已创建任务「晨会提醒」");

    expect(await session1.stop()).toEqual(["beginStop", "unregister", "dispose"]);
    const ownedPath = path.join(storageDir, "ownTaskIds.json");
    expect(JSON.parse(fs.readFileSync(ownedPath, "utf8"))).toEqual(["task-alpha"]);

    const scheduler2 = makeScheduler();
    const session2 = await activateSession({
      pluginId: "scheduled-automation",
      entryPath: "examples/scheduled-automation/index.ts",
      storageDir,
      requirements: ["scheduler"],
      services: { scheduler: scheduler2 },
    });
    activeSessions.push(session2);

    expect(await session2.tools.get("scheduled-automation_update")!.execute({ taskId: "task-other", title: "越权修改" })).toBe("只能更新本插件创建的任务");
    expect(scheduler2.updateTask).not.toHaveBeenCalled();

    const updatedMsg = await session2.tools.get("scheduled-automation_update")!.execute({
      taskId: "task-alpha",
      title: "晨会改期提醒",
    });
    expect(updatedMsg).toBe("已更新「晨会改期提醒」；当前状态: 停用。");
    expect(scheduler2.updateTask).toHaveBeenCalledExactlyOnceWith("task-alpha", { title: "晨会改期提醒" });

    expect(await session2.tools.get("scheduled-automation_delete")!.execute({ taskId: "task-alpha" })).toBe("已删除");
    expect(scheduler2.deleteTask).toHaveBeenCalledExactlyOnceWith("task-alpha");
    await session2.stop();
    expect(JSON.parse(fs.readFileSync(ownedPath, "utf8"))).toEqual([]);
  });

  it("system-status discovers system drive dynamically without hardcoded C drive and resets CPU/network baselines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));

    let cpuSampleIndex = 0;
    const cpuSamples = [
      [{ model: "Mock CPU", times: { user: 100, nice: 0, sys: 50, idle: 350, irq: 0 } }],
      [{ model: "Mock CPU", times: { user: 130, nice: 0, sys: 60, idle: 410, irq: 0 } }],
      // 异常采样：idle 回退不应算成有效占用率
      [{ model: "Mock CPU", times: { user: 140, nice: 0, sys: 70, idle: 390, irq: 0 } }],
      // 重启后的首次与第二次采样
      [{ model: "Mock CPU", times: { user: 200, nice: 0, sys: 80, idle: 420, irq: 0 } }],
      [{ model: "Mock CPU", times: { user: 220, nice: 0, sys: 80, idle: 500, irq: 0 } }],
    ];
    let netSampleIndex = 0;
    const netSamples = [
      { r: 1000, s: 500 },
      { r: 3000, s: 1500 },
      // 异常采样：计数器回退
      { r: 1200, s: 300 },
      // 重启后的首次与第二次采样
      { r: 5000, s: 1000 },
      { r: 7000, s: 2000 },
    ];

    const execScripts: string[] = [];
    let dynamicDiskStdout = "E 21474836480 85899345920";
    let envDiskStdout = "D 53687091200 53687091200";
    const fakeOs = {
      cpus: vi.fn(() => cpuSamples[Math.min(cpuSampleIndex, cpuSamples.length - 1)]),
      totalmem: vi.fn(() => 16 * 1024 ** 3),
      freemem: vi.fn(() => 8 * 1024 ** 3),
      uptime: vi.fn(() => 7200),
      type: vi.fn(() => "Windows_NT"),
      release: vi.fn(() => "10.0.22631"),
      arch: vi.fn(() => "x64"),
    };
    const fakeChildProcess = {
      execFile: vi.fn((command: string, argv: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (command === "nvidia-smi") {
          cb(new Error("no gpu"), "", "");
          return;
        }
        const script = argv[argv.length - 1] ?? "";
        execScripts.push(script);
        if (script.includes("ConvertTo-Json")) {
          const sample = netSamples[Math.min(netSampleIndex++, netSamples.length - 1)];
          cb(null, JSON.stringify({ disks: [], net: sample, bat: null, gpuEngine: null }), "");
          return;
        }
        if (script.includes("Win32_OperatingSystem")) {
          cb(null, dynamicDiskStdout, "");
          return;
        }
        cb(null, envDiskStdout, "");
      }),
    };

    const plugin = loadFreshPlugin<FireflyPlugin>("examples/system-status/index.cjs", (id) => {
      if (id === "node:os") return fakeOs;
      if (id === "node:child_process") return fakeChildProcess;
      return undefined;
    });

    const storageDir = trackTempDir();
    const session1 = await activateSession({
      pluginId: "system-status",
      entryPath: "examples/system-status/index.cjs",
      storageDir,
      pluginInstance: plugin,
    });
    activeSessions.push(session1);

    // 1. 系统盘按环境变量动态确定，不再写死 C
    vi.stubEnv("SystemDrive", "D:");
    vi.stubEnv("SYSTEMDRIVE", "D:");
    vi.stubEnv("SystemRoot", "D:\\Windows");
    vi.stubEnv("SYSTEMROOT", "D:\\Windows");
    vi.stubEnv("windir", "D:\\Windows");
    vi.stubEnv("WINDIR", "D:\\Windows");
    const envDiskText = await session1.tools.get("system-status_disk")!.execute({});
    expect(envDiskText).toBe("磁盘 D: 已用 50.0 GB / 100.0 GB（50.0%），剩余 50.0 GB");
    const envDiskScript = execScripts.at(-1)!;
    expect(envDiskScript).toContain("$letter = 'D'");
    expect(envDiskScript).not.toMatch(/["']C:?["']/i);

    // 2. 缺失盘符环境变量时，用 WMI 动态发现系统盘
    for (const key of ["SystemDrive", "SYSTEMDRIVE", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
      vi.stubEnv(key, "");
    }
    const wmiDiskText = await session1.tools.get("system-status_disk")!.execute({});
    expect(wmiDiskText).toBe("磁盘 E: 已用 20.0 GB / 100.0 GB（20.0%），剩余 80.0 GB");
    const wmiDiskScript = execScripts.at(-1)!;
    expect(wmiDiskScript).toContain("Win32_OperatingSystem");
    expect(wmiDiskScript).not.toMatch(/Get-PSDrive\s+-Name\s+["']C["']|DeviceID=['"]C:['"]/i);

    // 3. 首次采样缺少基准：CPU 与网络速率必须为 null，且 status 文本不给出伪造 CPU 占用
    const snapshotHandler = session1.ipc.get("plugin:system-status:snapshot")!;
    const firstSnap = (await snapshotHandler()) as { cpuPercent: number | null; networkBytesPerSecond: number | null };
    expect(firstSnap.cpuPercent).toBeNull();
    expect(firstSnap.networkBytesPerSecond).toBeNull();
    const miscScript = execScripts.find((script) => script.includes("ConvertTo-Json"))!;
    expect(miscScript).toContain("Property -eq 'ReceivedBytes'");
    expect(miscScript).toContain("Property -eq 'SentBytes'");
    expect(miscScript).not.toContain("$net.ReceivedBytes");

    // 4. 第二次采样按真实差分计算（总增量 100、空闲增量 60 => 40%；网络增量 3000B / 2s => 1500B/s）
    cpuSampleIndex = 1;
    vi.advanceTimersByTime(2000);
    const secondSnap = (await snapshotHandler()) as { cpuPercent: number | null; networkBytesPerSecond: number | null };
    expect(secondSnap.cpuPercent).toBe(40);
    expect(secondSnap.networkBytesPerSecond).toBe(1500);

    // 5. 异常回退采样应返回 null 而非错误数值
    cpuSampleIndex = 2;
    vi.advanceTimersByTime(2000);
    const invalidSnap = (await snapshotHandler()) as { cpuPercent: number | null; networkBytesPerSecond: number | null };
    expect(invalidSnap.cpuPercent).toBeNull();
    expect(invalidSnap.networkBytesPerSecond).toBeNull();

    // 6. 停用后同一模块实例重新启用：必须重置采样基准，重启首帧不能用旧基准给出错误数值
    expect(await session1.stop()).toEqual(["beginStop", "unregister", "dispose"]);
    const session2 = await activateSession({
      pluginId: "system-status",
      entryPath: "examples/system-status/index.cjs",
      storageDir,
      pluginInstance: plugin,
    });
    activeSessions.push(session2);

    cpuSampleIndex = 3;
    vi.advanceTimersByTime(2000);
    const afterRestartStatus = await session2.tools.get("system-status_status")!.execute({});
    expect(afterRestartStatus).not.toContain("当前占用");

    cpuSampleIndex = 4;
    vi.advanceTimersByTime(2000);
    const restartedSecondSnap = (await session2.ipc.get("plugin:system-status:snapshot")!()) as {
      cpuPercent: number | null;
      networkBytesPerSecond: number | null;
    };
    expect(restartedSecondSnap.cpuPercent).toBe(20);
    expect(restartedSecondSnap.networkBytesPerSecond).toBe(1500);
  });
});
