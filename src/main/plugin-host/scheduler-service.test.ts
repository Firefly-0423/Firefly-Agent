import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { computeExecutionSpecFingerprint, taskExecutionSpec } from "../scheduler/execution-spec";
import { createSchedulerStore } from "../scheduler/scheduler-store";
import { createPluginSchedulerService } from "./scheduler-service";

const CLOCK = new Date("2032-03-10T10:00:00.000Z");

let workdir: string;
let store: ReturnType<typeof createSchedulerStore>;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "ff-sched-"));
  let counter = 100;
  store = createSchedulerStore({
    tasksFile: join(workdir, "tasks.json"),
    historyFile: join(workdir, "history.jsonl"),
    now: () => CLOCK,
    id: () => `job-${counter++}`,
  });
  store.load();
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function svcFor(pluginId: string, signal?: AbortSignal) {
  return createPluginSchedulerService({ pluginId, store, signal, now: () => CLOCK });
}

const draft = () => ({
  title: "晨报",
  prompt: "汇总邮件",
  schedule: { kind: "weekly" as const, dayOfWeek: 1, timeOfDay: "07:30" },
  mode: "chat" as const,
  allowedToolIds: ["mail.read"],
});

/** 模拟用户在宿主 UI 中批准某个任务。 */
function approve(id: string) {
  const row = store.getTasks().find((t) => t.id === id)!;
  store.updateTask(id, {
    pluginUserEnabled: true,
    approvalFingerprint: computeExecutionSpecFingerprint(taskExecutionSpec(row)),
  });
}

async function failureOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    // 抛出的必须是宿主错误实例；形如 { code } 的普通对象不能算。
    if (!isPluginHostError(e)) return "plain-error";
    return (e as { code?: string }).code ?? "plain-error";
  }
  return "no-error";
}

describe("createTask", () => {
  test("新任务停用、无授权，所有权记在调用插件名下", async () => {
    const made = await svcFor("owner-1").createTask(draft());
    expect(made.enabled).toBe(false);
    const raw = store.getTasks().find((t) => t.id === made.id)!;
    expect(raw).toMatchObject({
      ownerPluginId: "owner-1",
      enabled: false,
      pluginUserEnabled: false,
      approvalFingerprint: "",
      toolMode: "allow-list",
      allowedToolIds: ["mail.read"],
      mode: "chat",
    });
  });

  test("返回的视图字段：id/title/schedule/prompt/mode/allowedToolIds/enabled/nextFireAt/时间戳", async () => {
    const made = await svcFor("p").createTask(draft());
    expect(Object.keys(made).sort()).toEqual(
      ["allowedToolIds", "createdAt", "enabled", "id", "mode", "nextFireAt", "prompt", "schedule", "title", "updatedAt"].sort(),
    );
    // 字段不只是存在，值也要对：下次触发时间有效，模式与工具白名单与提交的一致。
    expect(made.nextFireAt).toBeTruthy();
    expect(Number.isFinite(Date.parse(String(made.nextFireAt)))).toBe(true);
    expect(made.mode).toBe("chat");
    expect(made.allowedToolIds).toEqual(["mail.read"]);
    expect(made.schedule).toEqual(draft().schedule);
    expect(made.title).toBe("晨报");
    expect(made.prompt).toBe("汇总邮件");
  });

  test("标题与提示词首尾空白被裁剪", async () => {
    const made = await svcFor("p").createTask({ ...draft(), title: "  标题  ", prompt: "\n正文\t" });
    expect(made.title).toBe("标题");
    expect(made.prompt).toBe("正文");
  });

  test.each([
    ["空标题", { title: "" }],
    ["纯空白标题", { title: "   " }],
    ["空提示词", { prompt: "" }],
    ["纯空白提示词", { prompt: "  \n " }],
    ["未知模式", { mode: "turbo" }],
    ["白名单不是数组", { allowedToolIds: "mail.read" }],
    ["白名单含非字符串", { allowedToolIds: ["ok", 3] }],
    ["未知调度类型", { schedule: { kind: "yearly" } }],
    ["每日时间格式错", { schedule: { kind: "daily", timeOfDay: "25:99" } }],
    ["星期越界", { schedule: { kind: "weekly", dayOfWeek: 7, timeOfDay: "08:00" } }],
    ["间隔为 0", { schedule: { kind: "interval", every: 0, unit: "minutes" } }],
    ["分钟间隔过大", { schedule: { kind: "interval", every: 1441, unit: "minutes" } }],
    ["一次性时间无法解析", { schedule: { kind: "once", runAt: "not-a-date" } }],
    ["一次性时间已过去", { schedule: { kind: "once", runAt: "2032-03-10T09:59:59.000Z" } }],
    ["一次性时间等于现在", { schedule: { kind: "once", runAt: CLOCK.toISOString() } }],
  ])("非法输入被拒绝且不落盘：%s", async (_name, override) => {
    const code = await failureOf(svcFor("p").createTask({ ...draft(), ...override } as never));
    expect(code).toBe("E_INVALID_ARGUMENT");
    expect(store.getTasks()).toHaveLength(0);
  });

  test("未来的一次性任务可以创建", async () => {
    const made = await svcFor("p").createTask({
      ...draft(),
      schedule: { kind: "once", runAt: "2032-03-10T10:00:01.000Z" },
    });
    expect(made.schedule).toEqual({ kind: "once", runAt: "2032-03-10T10:00:01.000Z" });
  });

  test("输入里夹带的宿主字段不会生效", async () => {
    const made = await svcFor("p").createTask({
      ...draft(),
      enabled: true,
      ownerPluginId: "someone-else",
      pluginUserEnabled: true,
      approvalFingerprint: "forged",
    } as never);
    const raw = store.getTasks().find((t) => t.id === made.id)!;
    expect(raw).toMatchObject({ ownerPluginId: "p", pluginUserEnabled: false, approvalFingerprint: "", enabled: false });
  });

  test("底层存储抛错时包装为 E_INTERNAL，且不泄漏原始消息", async () => {
    const svc = createPluginSchedulerService({
      pluginId: "p",
      store: { ...store, addTask: () => { throw new Error("disk exploded"); } } as never,
    });
    try {
      await svc.createTask(draft());
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("E_INTERNAL");
      expect((e as Error).message).not.toContain("disk exploded");
    }
  });
});

describe("listTasks 与启用状态", () => {
  test("只列出自己的任务，不含用户任务和其他插件的任务", async () => {
    const mine = await svcFor("mine").createTask(draft());
    await svcFor("theirs").createTask(draft());
    store.addTask({
      title: "user task",
      prompt: "x",
      enabled: true,
      schedule: { kind: "daily", timeOfDay: "10:00" },
      toolMode: "all-enabled",
      allowedToolIds: [],
    } as never);
    const listed = await svcFor("mine").listTasks();
    expect(listed.map((t) => t.id)).toEqual([mine.id]);
  });

  test("无任务时返回空数组", async () => {
    expect(await svcFor("p").listTasks()).toEqual([]);
  });

  test("用户批准后视图为启用；批准是对当前规格的指纹", async () => {
    const made = await svcFor("p").createTask(draft());
    approve(made.id);
    const [view] = await svcFor("p").listTasks();
    expect(view.enabled).toBe(true);
  });

  test("返回的 allowedToolIds 是副本，改它不影响存储", async () => {
    const made = await svcFor("p").createTask(draft());
    made.allowedToolIds.push("injected");
    const stored = store.getTasks().find((t) => t.id === made.id)!;
    expect(stored.allowedToolIds).toEqual(["mail.read"]);
  });
});

describe("updateTask", () => {
  test("只改标题：保留授权，视图仍为启用", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    approve(made.id);
    const after = await svc.updateTask(made.id, { title: "新标题" });
    expect(after.title).toBe("新标题");
    expect(after.enabled).toBe(true);
    expect(store.getTasks()[0].pluginUserEnabled).toBe(true);
  });

  test.each([
    ["提示词", { prompt: "换一个提示词" }],
    ["调度", { schedule: { kind: "daily" as const, timeOfDay: "06:00" } }],
    ["模式", { mode: "code" as const }],
    ["工具白名单", { allowedToolIds: ["mail.read", "mail.send"] }],
  ])("改%s会撤销授权并清空指纹", async (_label, patch) => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    approve(made.id);
    const after = await svc.updateTask(made.id, patch);
    expect(after.enabled).toBe(false);
    const raw = store.getTasks()[0];
    expect(raw.pluginUserEnabled).toBe(false);
    expect(raw.approvalFingerprint).toBe("");
  });

  test("提交与现值相同的规格不算变更，授权保留", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    approve(made.id);
    const after = await svc.updateTask(made.id, { prompt: "汇总邮件", mode: "chat", allowedToolIds: ["mail.read"] });
    expect(after.enabled).toBe(true);
  });

  test("提示词前后空白会被裁剪后再比较与保存", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    approve(made.id);
    const after = await svc.updateTask(made.id, { prompt: "  汇总邮件  " });
    expect(after.prompt).toBe("汇总邮件");
    expect(after.enabled).toBe(true);
  });

  test("补丁里夹带的宿主字段被丢弃", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    await svc.updateTask(made.id, {
      title: "ok",
      enabled: true,
      pluginUserEnabled: true,
      approvalFingerprint: "forged",
      ownerPluginId: "thief",
    } as never);
    expect(store.getTasks()[0]).toMatchObject({
      ownerPluginId: "p",
      enabled: false,
      pluginUserEnabled: false,
      approvalFingerprint: "",
      title: "ok",
    });
  });

  test("过期的一次性计划只改标题不会被拒；提交新的过期计划则被拒", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask({ ...draft(), schedule: { kind: "once", runAt: "2032-03-10T10:00:30.000Z" } });
    const later = createPluginSchedulerService({
      pluginId: "p",
      store,
      now: () => new Date("2032-03-11T00:00:00.000Z"),
    });
    expect((await later.updateTask(made.id, { title: "仍可改名" })).title).toBe("仍可改名");
    expect(
      await failureOf(later.updateTask(made.id, { schedule: { kind: "once", runAt: "2032-03-10T12:00:00.000Z" } })),
    ).toBe("E_INVALID_ARGUMENT");
  });

  test.each([
    ["空标题", { title: " " }],
    ["空提示词", { prompt: "" }],
    ["非法模式", { mode: "x" }],
    ["非法调度", { schedule: { kind: "nope" } }],
    ["非法白名单", { allowedToolIds: [1] }],
  ])("非法补丁被拒绝且任务不变：%s", async (_n, patch) => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    const before = JSON.stringify(store.getTasks());
    expect(await failureOf(svc.updateTask(made.id, patch as never))).toBe("E_INVALID_ARGUMENT");
    expect(JSON.stringify(store.getTasks())).toBe(before);
  });

  test("任务 id 非法 -> E_INVALID_ARGUMENT", async () => {
    expect(await failureOf(svcFor("p").updateTask("", { title: "x" }))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("所有权与不存在", () => {
  test("操作不存在的任务 -> E_NOT_FOUND（update/delete/history）", async () => {
    const svc = svcFor("p");
    expect(await failureOf(svc.updateTask("ghost", { title: "x" }))).toBe("E_NOT_FOUND");
    expect(await failureOf(svc.deleteTask("ghost"))).toBe("E_NOT_FOUND");
    expect(await failureOf(svc.getHistory("ghost"))).toBe("E_NOT_FOUND");
  });

  test("操作别的插件的任务 -> E_NOT_OWNER，且任务保持原样", async () => {
    const made = await svcFor("owner").createTask(draft());
    const intruder = svcFor("intruder");
    expect(await failureOf(intruder.updateTask(made.id, { title: "hijack" }))).toBe("E_NOT_OWNER");
    expect(await failureOf(intruder.deleteTask(made.id))).toBe("E_NOT_OWNER");
    expect(await failureOf(intruder.getHistory(made.id))).toBe("E_NOT_OWNER");
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTasks()[0].title).toBe("晨报");
  });

  test("插件不能碰用户自己的任务", async () => {
    const userTask = store.addTask({
      title: "mine",
      prompt: "p",
      enabled: true,
      schedule: { kind: "daily", timeOfDay: "10:00" },
      toolMode: "all-enabled",
      allowedToolIds: [],
    } as never);
    expect(await failureOf(svcFor("p").deleteTask(userTask.id))).toBe("E_NOT_OWNER");
  });
});

describe("deleteTask", () => {
  test("删除自己的任务返回 true 并从存储移除", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    expect(await svc.deleteTask(made.id)).toBe(true);
    expect(store.getTasks()).toHaveLength(0);
  });

  test("已删除后再次删除报 E_NOT_FOUND", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    await svc.deleteTask(made.id);
    expect(await failureOf(svc.deleteTask(made.id))).toBe("E_NOT_FOUND");
  });

  test("非法 id -> E_INVALID_ARGUMENT", async () => {
    expect(await failureOf(svcFor("p").deleteTask(undefined as never))).toBe("E_INVALID_ARGUMENT");
  });
});

describe("getHistory", () => {
  function record(taskId: string, n: number, extra: object = {}) {
    store.recordHistory({
      id: `h${n}`,
      taskId,
      taskTitle: "晨报",
      firedAt: `2032-03-10T0${n % 10}:00:00.000Z`,
      status: "success",
      effectiveToolIds: [],
      ...extra,
    } as never);
  }

  test("投影为 id/taskId/status/startedAt，可选的 finishedAt 与 summary 仅在有值时出现", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    record(made.id, 1);
    record(made.id, 2, { finishedAt: "2032-03-10T02:00:09.000Z", outputPreview: "done", status: "failed" });
    const rows = await svc.getHistory(made.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.h1).toEqual({ id: "h1", taskId: made.id, status: "success", startedAt: "2032-03-10T01:00:00.000Z" });
    expect(byId.h2).toEqual({
      id: "h2",
      taskId: made.id,
      status: "failed",
      startedAt: "2032-03-10T02:00:00.000Z",
      finishedAt: "2032-03-10T02:00:09.000Z",
      summary: "done",
    });
  });

  test("只返回该任务自己的记录", async () => {
    const svc = svcFor("p");
    const a = await svc.createTask(draft());
    const b = await svc.createTask(draft());
    record(a.id, 1);
    record(b.id, 2);
    expect((await svc.getHistory(a.id)).map((r) => r.id)).toEqual(["h1"]);
  });

  test("默认最多 10 条，limit 可调，范围 1-100", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    for (let i = 0; i < 15; i++) record(made.id, i);
    expect(await svc.getHistory(made.id)).toHaveLength(10);
    expect(await svc.getHistory(made.id, 3)).toHaveLength(3);
    expect(await svc.getHistory(made.id, 100)).toHaveLength(15);
  });

  test.each([0, 101, -2, 2.5, Number.NaN])("limit=%s 被拒绝", async (limit) => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    expect(await failureOf(svc.getHistory(made.id, limit))).toBe("E_INVALID_ARGUMENT");
  });

  test("没有记录时返回空数组", async () => {
    const svc = svcFor("p");
    const made = await svc.createTask(draft());
    expect(await svc.getHistory(made.id)).toEqual([]);
  });
});

describe("停止信号", () => {
  test("中止后五个方法全部 E_PLUGIN_STOPPING，任务数据不受影响", async () => {
    const ac = new AbortController();
    const svc = svcFor("p", ac.signal);
    const made = await svc.createTask(draft());
    ac.abort();
    expect(await failureOf(svc.createTask(draft()))).toBe("E_PLUGIN_STOPPING");
    expect(await failureOf(svc.listTasks())).toBe("E_PLUGIN_STOPPING");
    expect(await failureOf(svc.updateTask(made.id, { title: "x" }))).toBe("E_PLUGIN_STOPPING");
    expect(await failureOf(svc.deleteTask(made.id))).toBe("E_PLUGIN_STOPPING");
    expect(await failureOf(svc.getHistory(made.id))).toBe("E_PLUGIN_STOPPING");
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTasks()[0].title).toBe("晨报");
  });
});
