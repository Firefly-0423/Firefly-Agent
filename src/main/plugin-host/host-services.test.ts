import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createHostServiceFactory, type PluginHostServicesOptions } from "./host-services";

let dataRoot: string;
beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ff-hostsvc-"));
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b: Buffer) => b.toString().split("").reverse().join(""),
};

function emptyChats() {
  return {
    listSessions: () => [],
    getSession: () => null,
    getWorkspaceBinding: () => undefined,
  };
}

/** 只保存任务数组的最小调度存储。 */
function tinySchedulerStore() {
  const rows: any[] = [];
  return {
    getTasks: () => rows,
    addTask: (input: any) => {
      const row = { id: `T${rows.length}`, enabled: false, ...input };
      rows.push(row);
      return row;
    },
    updateTask: (id: string, patch: any) => Object.assign(rows.find((r) => r.id === id), patch),
    deleteTask: (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
      return at >= 0;
    },
    getHistory: () => [],
  };
}

function build(extra: Partial<PluginHostServicesOptions> = {}) {
  return createHostServiceFactory({
    pluginDataRoot: dataRoot,
    channelManager: { has: (id: string) => id === "known-channel" },
    llm: { generateText: async () => "shared-answer" },
    storage,
    chatsReader: emptyChats(),
    schedulerStore: tinySchedulerStore(),
    ...extra,
  } as PluginHostServicesOptions);
}

function mount(factory: ReturnType<typeof build>, pluginId: string, signal = new AbortController().signal) {
  return factory.createForPlugin({ pluginId, signal, trackResource: (() => () => undefined) as never });
}

async function codeOf(p: Promise<unknown> | undefined) {
  try {
    await p;
  } catch (e) {
    // 契约要求是宿主错误实例，只带 code 的普通对象不算。
    expect(isPluginHostError(e)).toBe(true);
    return (e as { code?: string }).code;
  }
  return "resolved";
}

describe("服务集合", () => {
  test("提供 channels、llm、secrets、workspace、conversations、scheduler 六项", () => {
    const deps = mount(build(), "p");
    for (const key of ["channels", "llm", "secrets", "workspace", "conversations", "scheduler"] as const) {
      expect(deps[key], key).toBeDefined();
    }
  });

  test("channels.has 转发给通道管理器", () => {
    const deps = mount(build(), "p");
    expect(deps.channels?.has("known-channel")).toBe(true);
    expect(deps.channels?.has("unknown")).toBe(false);
  });

  test("llm.generateText 返回共享服务的结果", async () => {
    const deps = mount(build(), "p");
    expect(await deps.llm?.generateText([{ role: "user", content: "?" }])).toBe("shared-answer");
  });

  test("workspace 与 conversations 读取注入的会话视图", async () => {
    const chats = {
      listSessions: () => [],
      getSession: () => null,
      getWorkspaceBinding: (id: string) => (id === "c1" ? { workspaceRoot: "/r", displayName: "R" } : undefined),
    };
    const deps = mount(build({ chatsReader: chats as never }), "p");
    expect(await deps.workspace?.getBinding("c1")).toEqual({ conversationId: "c1", root: "/r", displayName: "R" });
    expect(await deps.workspace?.getBinding("c2")).toBeNull();
    expect((await deps.conversations?.list())?.items).toEqual([]);
  });
});

describe("按插件隔离", () => {
  test("密钥落在 <根>/<pluginId>/secrets 下，互相读不到", async () => {
    const factory = build();
    const one = mount(factory, "alpha");
    const two = mount(factory, "beta");
    await one.secrets?.set("token", "T-alpha");
    expect(await two.secrets?.get("token")).toBeUndefined();
    expect(await one.secrets?.get("token")).toBe("T-alpha");
    expect(await readdir(join(dataRoot, "alpha", "secrets"))).toHaveLength(1);
    await expect(readdir(join(dataRoot, "beta"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("调度任务只对创建它的插件可见", async () => {
    const factory = build();
    const owner = mount(factory, "owner");
    const other = mount(factory, "other");
    const made = await owner.scheduler?.createTask({
      title: "t",
      prompt: "p",
      schedule: { kind: "daily", timeOfDay: "08:30" },
      mode: "work",
      allowedToolIds: [],
    } as never);
    expect(made?.enabled).toBe(false);
    expect(await owner.scheduler?.listTasks()).toHaveLength(1);
    expect(await other.scheduler?.listTasks()).toEqual([]);
  });
});

describe("停止信号", () => {
  test("同一个信号同时让各服务失效，其他插件不受影响", async () => {
    const factory = build();
    const ac = new AbortController();
    const dying = mount(factory, "dying", ac.signal);
    const alive = mount(factory, "alive");
    ac.abort();
    expect(await codeOf(dying.secrets?.get("k"))).toBe("E_PLUGIN_STOPPING");
    expect(await codeOf(dying.workspace?.getBinding("c"))).toBe("E_PLUGIN_STOPPING");
    expect(await codeOf(dying.conversations?.list())).toBe("E_PLUGIN_STOPPING");
    expect(await codeOf(dying.scheduler?.listTasks())).toBe("E_PLUGIN_STOPPING");
    expect(await codeOf(alive.workspace?.getBinding("c"))).toBe("resolved");
  });
});

describe("可选的 runGoal", () => {
  const goalResult = { text: "ok", terminal: { status: "success", externalEffectsMayContinue: false }, rounds: 1 };

  test("提供运行器工厂时按插件 id 与信号调用，并把结果挂到 llm.runGoal", () => {
    const perPlugin = new Map<string, () => Promise<unknown>>();
    const createAgentRunner = vi.fn(({ pluginId }: { pluginId: string }) => {
      const fn = async () => goalResult;
      perPlugin.set(pluginId, fn);
      return fn as never;
    });
    const factory = build({ createAgentRunner });
    const ac = new AbortController();
    const a = mount(factory, "a", ac.signal);
    const b = mount(factory, "b");
    expect(createAgentRunner).toHaveBeenCalledTimes(2);
    expect(createAgentRunner.mock.calls[0][0]).toMatchObject({ pluginId: "a", signal: ac.signal });
    expect(a.llm?.runGoal).toBe(perPlugin.get("a"));
    expect(b.llm?.runGoal).toBe(perPlugin.get("b"));
    expect(a.llm?.runGoal).not.toBe(b.llm?.runGoal);
  });

  test("未提供工厂时 llm 不带 runGoal", () => {
    expect(mount(build(), "p").llm?.runGoal).toBeUndefined();
  });

  test("工厂返回 undefined 时同样不带 runGoal", () => {
    const deps = mount(build({ createAgentRunner: () => undefined as never }), "p");
    expect(deps.llm?.runGoal).toBeUndefined();
  });
});
