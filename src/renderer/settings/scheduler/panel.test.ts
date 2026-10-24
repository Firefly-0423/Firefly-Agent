// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, ScheduledTaskHistoryEntry, SchedulerApi, SchedulerToolInfo } from "./types";

const modal = vi.hoisted(() => ({ showConfirm: vi.fn(async () => true), showNotice: vi.fn() }));
vi.mock("../shared/modal", () => ({ showConfirm: modal.showConfirm, showNotice: modal.showNotice }));

const showConfirm = modal.showConfirm;
const showNotice = modal.showNotice;

const HTML = `
  <div id="scheduler-empty"></div>
  <div id="scheduler-list"></div>
  <div id="scheduler-editor" class="is-hidden">
    <h2 id="scheduler-editor-title"></h2>
    <input id="scheduler-title" />
    <textarea id="scheduler-prompt"></textarea>
    <input id="scheduler-enabled" type="checkbox" />
    <select id="scheduler-kind">
      <option value="once">once</option>
      <option value="daily">daily</option>
      <option value="weekly">weekly</option>
      <option value="interval">interval</option>
    </select>
    <input id="scheduler-once-run-at" />
    <input id="scheduler-time-of-day" />
    <input id="scheduler-day-of-week" />
    <input id="scheduler-interval-every" />
    <select id="scheduler-interval-unit">
      <option value="minutes">minutes</option>
      <option value="hours">hours</option>
    </select>
    <input id="scheduler-tool-limit" type="checkbox" />
    <div id="scheduler-tool-picker"></div>
    <div id="scheduler-tool-empty-hint" class="is-hidden"></div>
    <div id="scheduler-save-status"></div>
    <div class="scheduler-once-field"></div>
    <div class="scheduler-time-field"></div>
    <div class="scheduler-weekly-field"></div>
    <div class="scheduler-interval-field"></div>
  </div>
`;

async function setup(html = HTML) {
  document.body.innerHTML = html;
  if (!("fireflyScheduler" in window)) (window as unknown as { fireflyScheduler: unknown }).fireflyScheduler = api();
  vi.resetModules();
  const panel = await import("./panel");
  const { schedulerState } = await import("./state");
  const dom = await import("./dom");
  return { panel, state: schedulerState, dom };
}

function tool(overrides: Partial<SchedulerToolInfo> = {}): SchedulerToolInfo {
  return { id: "tool-a", name: "Tool A", description: "", enabled: true, risk: "low", ...overrides };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Daily task",
    prompt: "do the thing",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: null,
    toolMode: "all-enabled",
    allowedToolIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function history(overrides: Partial<ScheduledTaskHistoryEntry> = {}): ScheduledTaskHistoryEntry {
  return {
    id: "run-1",
    taskId: "task-1",
    taskTitle: "Daily task",
    firedAt: "2026-01-01T00:00:00.000Z",
    status: "success",
    effectiveToolIds: [],
    ...overrides,
  };
}

function api(overrides: Partial<SchedulerApi> = {}): SchedulerApi & Record<string, unknown> {
  return {
    list: vi.fn(async () => ({ ok: true, value: [] as ScheduledTask[] })),
    add: vi.fn(async () => ({ ok: true, value: task() })),
    update: vi.fn(async () => ({ ok: true, value: task() })),
    delete: vi.fn(async () => ({ ok: true, value: true })),
    toggle: vi.fn(async () => ({ ok: true, value: task() })),
    fireNow: vi.fn(async () => ({ ok: true, value: true })),
    getHistory: vi.fn(async () => ({ ok: true, value: [] as ScheduledTaskHistoryEntry[] })),
    getTools: vi.fn(async () => ({ ok: true, value: [] as SchedulerToolInfo[] })),
    ...overrides,
  } as SchedulerApi & Record<string, unknown>;
}

function install(value = api()) {
  (window as unknown as { fireflyScheduler: unknown }).fireflyScheduler = value;
  return value;
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "fireflyScheduler");
  Reflect.deleteProperty(window, "plugins");
  vi.clearAllMocks();
  vi.mocked(showConfirm).mockResolvedValue(true);
});

describe("setSchedulerStatus", () => {
  it("writes the text and composes the class name", async () => {
    const { panel, dom } = await setup();
    panel.setSchedulerStatus("saved", "is-ok");
    expect(dom.schedulerSaveStatus?.textContent).toBe("saved");
    expect(dom.schedulerSaveStatus?.className).toBe("save-status is-ok");
    panel.setSchedulerStatus("plain");
    expect(dom.schedulerSaveStatus?.className).toBe("save-status");
  });

  it("is a no-op when the status element is absent", async () => {
    const { panel } = await setup("<div></div>");
    expect(() => panel.setSchedulerStatus("missing")).not.toThrow();
  });
});

describe("renderSchedulerTools", () => {
  it("renders checked tools with risk, disabled state and selection", async () => {
    const { panel, state, dom } = await setup();
    state.tools = [tool({ id: "a", name: "Alpha" }), tool({ id: "b", name: "Beta", enabled: false, risk: "high" })];
    panel.renderSchedulerTools(["b"]);
    const labels = dom.schedulerToolPicker!.querySelectorAll("label");
    expect(labels).toHaveLength(2);
    const [a, b] = Array.from(labels).map((label) => label.querySelector("input")!);
    expect(a.value).toBe("a");
    expect(a.checked).toBe(false);
    expect(b.value).toBe("b");
    expect(b.checked).toBe(true);
    expect(labels[0].textContent).toContain("Alpha (a) · low");
    expect(labels[1].textContent).toContain("Beta (b) · high · 已全局禁用");
  });

  it("does nothing when the picker is absent", async () => {
    const { panel, state } = await setup("<div></div>");
    state.tools = [tool()];
    expect(() => panel.renderSchedulerTools(["tool-a"])).not.toThrow();
  });
});

describe("renderSchedulerList", () => {
  it("shows the empty state when there are no tasks", async () => {
    const { panel, state, dom } = await setup();
    state.tasks = [];
    await panel.renderSchedulerList();
    expect(dom.schedulerList!.children).toHaveLength(0);
    expect(dom.schedulerEmpty!.classList.contains("is-hidden")).toBe(false);
  });

  it("renders task metadata, badges and the five actions", async () => {
    const scheduler = install();
    const { panel, state, dom } = await setup();
    state.tasks = [task({
      title: "Morning summary",
      nextFireAt: "2026-05-01T00:00:00.000Z",
      schedule: { kind: "weekly", dayOfWeek: 1, timeOfDay: "09:30" },
      mode: "chat",
    })];
    await panel.renderSchedulerList();

    expect(dom.schedulerEmpty!.classList.contains("is-hidden")).toBe(true);
    const card = dom.schedulerList!.querySelector("article")!;
    expect(card.querySelector("strong")!.textContent).toBe("Morning summary");
    expect(card.querySelector(".scheduler-badge")!.textContent).toBe("已启用");
    expect(card.querySelector(".scheduler-card__meta")!.textContent).toContain("周一 09:30");
    expect(card.querySelector(".scheduler-card__meta")!.textContent).toContain("模式：chat");
    expect(card.querySelector(".scheduler-card__meta")!.textContent).toContain("工具：全部已启用工具");
    const buttons = card.querySelectorAll(".scheduler-card__actions button");
    expect(Array.from(buttons).map((button) => button.textContent)).toEqual(["立即运行", "编辑", "停用", "历史", "删除"]);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);

    (buttons[0] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(scheduler.fireNow).toHaveBeenCalledWith("task-1"));
  });

  it("disables fire and marks plugin tasks waiting while their plugin is stopped", async () => {
    const { panel, state, dom } = await setup();
    state.tasks = [task({
      id: "plugin-task",
      title: "Plugin task",
      ownerPluginId: "plugin-1",
      toolMode: "allow-list",
      allowedToolIds: ["a", "b"],
      enabled: false,
    })];
    state.pluginRunning = { "plugin-1": false };
    await panel.renderSchedulerList();

    const card = dom.schedulerList!.querySelector("article")!;
    expect(card.querySelector(".scheduler-badge")!.textContent).toBe("已停用");
    expect(card.querySelector(".scheduler-badge")!.classList.contains("is-disabled")).toBe(true);
    const meta = card.querySelector(".scheduler-card__meta")!.textContent!;
    expect(meta).toContain("由插件 plugin-1 创建");
    expect(meta).toContain("工具：a, b");
    expect(meta).toContain("等待插件启用");
    const fire = card.querySelector(".scheduler-card__actions button") as HTMLButtonElement;
    expect(fire.disabled).toBe(true);
    expect(fire.title).toBe("插件已停用，等待插件启用");
  });

  it("enables fire once the plugin is running and shows the toggle label for disabled tasks", async () => {
    const { panel, state, dom } = await setup();
    state.tasks = [task({ ownerPluginId: "plugin-1", enabled: false, toolMode: "allow-list", allowedToolIds: [] })];
    state.pluginRunning = { "plugin-1": true };
    await panel.renderSchedulerList();
    const card = dom.schedulerList!.querySelector("article")!;
    expect(card.querySelector(".scheduler-card__meta")!.textContent).toContain("工具：无");
    expect(card.querySelector(".scheduler-card__meta")!.textContent).not.toContain("等待插件启用");
    expect((card.querySelector(".scheduler-card__actions button") as HTMLButtonElement).disabled).toBe(false);
    const toggle = card.querySelectorAll(".scheduler-card__actions button")[2];
    expect(toggle.textContent).toBe("启用");
  });

  it("does nothing when the list or empty element is absent", async () => {
    const { panel, state } = await setup("<div id=\"scheduler-empty\"></div>");
    state.tasks = [task()];
    await expect(panel.renderSchedulerList()).resolves.toBeUndefined();
  });
});

describe("loadSchedulerPanel", () => {
  it("loads tasks, tools and plugin running state, then renders", async () => {
    const scheduler = install(api({
      list: vi.fn(async () => ({ ok: true, value: [task({ title: "Loaded" })] })),
      getTools: vi.fn(async () => ({ ok: true, value: [tool()] })),
    }));
    (window as unknown as { plugins: unknown }).plugins = {
      list: vi.fn(async () => [{ id: "plugin-1", status: "running" }, { id: "plugin-2", status: "stopped" }]),
    };
    const { panel, state, dom } = await setup();
    await panel.loadSchedulerPanel();
    expect(state.tasks.map((item) => item.title)).toEqual(["Loaded"]);
    expect(state.tools).toHaveLength(1);
    expect(state.pluginRunning).toEqual({ "plugin-1": true, "plugin-2": false });
    expect(dom.schedulerList!.querySelector("strong")!.textContent).toBe("Loaded");
    expect(scheduler.list).toHaveBeenCalledTimes(1);
  });

  it("accepts a plugins object and ignores plugin lookup failure", async () => {
    install(api());
    (window as unknown as { plugins: unknown }).plugins = { list: vi.fn(async () => ({ plugins: [{ id: "p", status: "running" }] })) };
    const first = await setup();
    await first.panel.loadSchedulerPanel();
    expect(first.state.pluginRunning).toEqual({ p: true });

    vi.resetModules();
    (window as unknown as { plugins: unknown }).plugins = { list: vi.fn(async () => { throw new Error("offline"); }) };
    const second = await setup();
    await second.panel.loadSchedulerPanel();
    expect(second.state.pluginRunning).toEqual({});
  });

  it("keeps existing state when list or tools fail", async () => {
    install(api({
      list: vi.fn(async () => ({ ok: false, error: "no list" })),
      getTools: vi.fn(async () => ({ ok: false, error: "no tools" })),
    }));
    const { panel, state } = await setup();
    state.tasks = [task({ title: "old" })];
    state.tools = [tool({ id: "old-tool" })];
    await panel.loadSchedulerPanel();
    expect(state.tasks[0].title).toBe("old");
    expect(state.tools[0].id).toBe("old-tool");
  });
});

describe("openSchedulerEditor / closeSchedulerEditor", () => {
  it("opens a new task with defaults", async () => {
    const { panel, state, dom } = await setup();
    await panel.openSchedulerEditor();
    expect(state.editingTaskId).toBeNull();
    expect(dom.schedulerEditor!.classList.contains("is-hidden")).toBe(false);
    expect(dom.schedulerEditorTitle!.textContent).toBe("新建定时任务");
    expect(dom.schedulerTitleInput!.value).toBe("");
    expect(dom.schedulerPromptInput!.value).toBe("");
    expect(dom.schedulerEnabledInput!.checked).toBe(true);
    expect(dom.schedulerKindInput!.value).toBe("daily");
    expect(dom.schedulerTimeOfDayInput!.value).toBe("08:00");
    expect(dom.schedulerDayOfWeekInput!.value).toBe("1");
    expect(dom.schedulerIntervalEveryInput!.value).toBe("1");
    expect(dom.schedulerIntervalUnitInput!.value).toBe("minutes");
    expect(dom.schedulerToolLimitInput!.checked).toBe(false);
    expect(dom.schedulerToolLimitInput!.disabled).toBe(false);
    expect(dom.schedulerSaveStatus!.textContent).toBe("等待操作");
  });

  it("loads tools when the cache is empty and renders the selection", async () => {
    const scheduler = install(api({ getTools: vi.fn(async () => ({ ok: true, value: [tool()] })) }));
    const { panel, state, dom } = await setup();
    await panel.openSchedulerEditor();
    expect(scheduler.getTools).toHaveBeenCalledTimes(1);
    expect(state.tools).toHaveLength(1);
    expect(dom.schedulerToolPicker!.querySelectorAll("input")).toHaveLength(1);
  });

  it.each([
    ["weekly", { kind: "weekly", dayOfWeek: 6, timeOfDay: "23:59" }],
    ["daily", { kind: "daily", timeOfDay: "06:15" }],
    ["interval", { kind: "interval", every: 3, unit: "hours" }],
  ] as const)("restores a %s schedule", async (_kind, schedule) => {
    const { panel, dom } = await setup();
    await panel.openSchedulerEditor(task({ schedule: schedule as ScheduledTask["schedule"] }));
    expect(dom.schedulerKindInput!.value).toBe(schedule.kind);
    if (schedule.kind === "weekly" || schedule.kind === "daily") {
      expect(dom.schedulerTimeOfDayInput!.value).toBe(schedule.timeOfDay);
    }
    if (schedule.kind === "weekly") expect(dom.schedulerDayOfWeekInput!.value).toBe("6");
    if (schedule.kind === "interval") {
      expect(dom.schedulerIntervalEveryInput!.value).toBe("3");
      expect(dom.schedulerIntervalUnitInput!.value).toBe("hours");
    }
  });

  it("restores an existing once schedule into a local datetime input", async () => {
    const { panel, dom } = await setup();
    const runAt = new Date(Date.now() + 86_400_000).toISOString();
    await panel.openSchedulerEditor(task({ schedule: { kind: "once", runAt } }));
    expect(dom.schedulerKindInput!.value).toBe("once");
    expect(dom.schedulerOnceRunAtInput!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("locks the allow-list switch and checks it for plugin-owned tasks", async () => {
    const { panel, dom } = await setup();
    await panel.openSchedulerEditor(task({ ownerPluginId: "plugin-1", toolMode: "allow-list", allowedToolIds: ["a"] }));
    expect(dom.schedulerToolLimitInput!.checked).toBe(true);
    expect(dom.schedulerToolLimitInput!.disabled).toBe(true);
  });

  it("closes the editor and clears the editing id", async () => {
    const { panel, state, dom } = await setup();
    state.editingTaskId = "task-1";
    panel.closeSchedulerEditor();
    expect(state.editingTaskId).toBeNull();
    expect(dom.schedulerEditor!.classList.contains("is-hidden")).toBe(true);
  });
});

describe("updateSchedulerConditionalFields", () => {
  it.each([
    ["once", [true, false, false, false]],
    ["daily", [false, true, false, false]],
    ["weekly", [false, true, true, false]],
    ["interval", [false, false, false, true]],
  ] as const)("shows only the %s fields", async (kind, [once, time, weekly, interval]) => {
    const { panel, dom } = await setup();
    dom.schedulerKindInput!.value = kind;
    panel.updateSchedulerConditionalFields();
    expect(!dom.schedulerEditor!.querySelector(".scheduler-once-field")!.classList.contains("is-hidden")).toBe(once);
    expect(!dom.schedulerEditor!.querySelector(".scheduler-time-field")!.classList.contains("is-hidden")).toBe(time);
    expect(!dom.schedulerEditor!.querySelector(".scheduler-weekly-field")!.classList.contains("is-hidden")).toBe(weekly);
    expect(!dom.schedulerEditor!.querySelector(".scheduler-interval-field")!.classList.contains("is-hidden")).toBe(interval);
  });

  it("shows the tool picker only for an allow-list and shows the hint only when empty", async () => {
    const { panel, state, dom } = await setup();
    state.tools = [tool({ id: "a" })];
    panel.renderSchedulerTools([]);
    dom.schedulerToolLimitInput!.checked = true;
    panel.updateSchedulerConditionalFields();
    expect(dom.schedulerToolPicker!.classList.contains("is-hidden")).toBe(false);
    expect(dom.schedulerToolEmptyHint!.classList.contains("is-hidden")).toBe(false);

    const checkbox = dom.schedulerToolPicker!.querySelector("input")!;
    checkbox.checked = true;
    panel.updateSchedulerConditionalFields();
    expect(dom.schedulerToolEmptyHint!.classList.contains("is-hidden")).toBe(true);

    dom.schedulerToolLimitInput!.checked = false;
    panel.updateSchedulerConditionalFields();
    expect(dom.schedulerToolPicker!.classList.contains("is-hidden")).toBe(true);
  });
});

describe("collectSchedule", () => {
  it("defaults to a daily 08:00 schedule without form elements", async () => {
    const { panel } = await setup("<div></div>");
    expect(panel.collectSchedule()).toEqual({ kind: "daily", timeOfDay: "08:00" });
  });

  it("accepts a valid daily time and rejects a malformed one", async () => {
    const { panel, dom } = await setup();
    dom.schedulerKindInput!.value = "daily";
    dom.schedulerTimeOfDayInput!.value = "23:59";
    expect(panel.collectSchedule()).toEqual({ kind: "daily", timeOfDay: "23:59" });
    dom.schedulerTimeOfDayInput!.value = "24:00";
    expect(() => panel.collectSchedule()).toThrow("每日时间格式必须是 HH:mm");
  });

  it("validates once schedules against the current time", async () => {
    const { panel, dom } = await setup();
    dom.schedulerKindInput!.value = "once";
    dom.schedulerOnceRunAtInput!.value = "";
    expect(() => panel.collectSchedule()).toThrow("请选择一次性运行时间");
    dom.schedulerOnceRunAtInput!.value = "2000-01-01T00:00";
    expect(() => panel.collectSchedule()).toThrow("一次性任务时间必须晚于当前时间");

    const future = new Date(Date.now() + 3_600_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    dom.schedulerOnceRunAtInput!.value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    const schedule = panel.collectSchedule();
    expect(schedule.kind).toBe("once");
    if (schedule.kind === "once") expect(new Date(schedule.runAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts weekly day boundaries and rejects invalid days and times", async () => {
    const { panel, dom } = await setup();
    dom.schedulerKindInput!.value = "weekly";
    dom.schedulerTimeOfDayInput!.value = "08:30";
    for (const day of ["0", "6"]) {
      dom.schedulerDayOfWeekInput!.value = day;
      expect(panel.collectSchedule()).toEqual({ kind: "weekly", dayOfWeek: Number(day), timeOfDay: "08:30" });
    }
    for (const day of ["-1", "7", "1.5"]) {
      dom.schedulerDayOfWeekInput!.value = day;
      expect(() => panel.collectSchedule()).toThrow("星期必须是周一到周日");
    }
    dom.schedulerDayOfWeekInput!.value = "1";
    dom.schedulerTimeOfDayInput!.value = "8:00";
    expect(() => panel.collectSchedule()).toThrow("每周时间格式必须是 HH:mm");
  });

  it("validates interval ranges and normalizes the unit", async () => {
    const { panel, dom } = await setup();
    dom.schedulerKindInput!.value = "interval";
    dom.schedulerIntervalEveryInput!.value = "1440";
    dom.schedulerIntervalUnitInput!.value = "minutes";
    expect(panel.collectSchedule()).toEqual({ kind: "interval", every: 1440, unit: "minutes" });

    dom.schedulerIntervalEveryInput!.value = "1441";
    expect(() => panel.collectSchedule()).toThrow("分钟间隔不能超过 1440");

    dom.schedulerIntervalEveryInput!.value = "168";
    dom.schedulerIntervalUnitInput!.value = "hours";
    expect(panel.collectSchedule()).toEqual({ kind: "interval", every: 168, unit: "hours" });

    dom.schedulerIntervalEveryInput!.value = "169";
    expect(() => panel.collectSchedule()).toThrow("小时间隔不能超过 168");

    for (const value of ["0", "-1", "1.5", ""]) {
      dom.schedulerIntervalEveryInput!.value = value;
      expect(() => panel.collectSchedule()).toThrow("间隔必须是正整数");
    }

    dom.schedulerIntervalEveryInput!.value = "5";
    dom.schedulerIntervalUnitInput!.value = "seconds";
    expect(panel.collectSchedule()).toEqual({ kind: "interval", every: 5, unit: "minutes" });
  });
});

describe("collectAllowedToolIds", () => {
  it("returns checked tool ids in DOM order", async () => {
    const { panel, state, dom } = await setup();
    state.tools = [tool({ id: "a" }), tool({ id: "b" }), tool({ id: "c" })];
    panel.renderSchedulerTools(["a", "c"]);
    expect(panel.collectAllowedToolIds()).toEqual(["a", "c"]);
  });

  it("returns an empty array without a picker", async () => {
    const { panel } = await setup("<div></div>");
    expect(panel.collectAllowedToolIds()).toEqual([]);
  });
});

describe("saveSchedulerTask", () => {
  it("rejects an empty title and prompt before calling the API", async () => {
    const scheduler = install();
    const { panel, dom } = await setup();
    dom.schedulerTitleInput!.value = "   ";
    await panel.saveSchedulerTask();
    expect(dom.schedulerSaveStatus!.textContent).toBe("标题不能为空");
    expect(dom.schedulerSaveStatus!.className).toContain("is-error");

    dom.schedulerTitleInput!.value = "Title";
    dom.schedulerPromptInput!.value = "  ";
    await panel.saveSchedulerTask();
    expect(dom.schedulerSaveStatus!.textContent).toBe("提示词不能为空");
    expect(scheduler.add).not.toHaveBeenCalled();
  });

  it("adds a task with trimmed values, schedule, mode and selected tools", async () => {
    const scheduler = install();
    const { panel, state, dom } = await setup();
    state.tools = [tool({ id: "a" }), tool({ id: "b" })];
    dom.schedulerTitleInput!.value = "  New task  ";
    dom.schedulerPromptInput!.value = "  Prompt  ";
    dom.schedulerEnabledInput!.checked = false;
    dom.schedulerKindInput!.value = "daily";
    dom.schedulerTimeOfDayInput!.value = "07:00";
    dom.schedulerToolLimitInput!.checked = true;
    panel.renderSchedulerTools(["a", "b"]);
    dom.schedulerToolPicker!.querySelectorAll("input")[1].checked = false;
    await panel.saveSchedulerTask();

    expect(scheduler.add).toHaveBeenCalledWith({
      title: "New task",
      prompt: "Prompt",
      enabled: false,
      schedule: { kind: "daily", timeOfDay: "07:00" },
      toolMode: "allow-list",
      allowedToolIds: ["a"],
    });
    expect(dom.schedulerEditor!.classList.contains("is-hidden")).toBe(true);
    expect(scheduler.list).toHaveBeenCalledTimes(1);
  });

  it("updates an existing task and keeps plugin tasks on an allow-list with a user-enable flag", async () => {
    const scheduler = install();
    const { panel, state, dom } = await setup();
    state.tasks = [task({ id: "plugin-task", ownerPluginId: "plugin-1", toolMode: "all-enabled" })];
    state.editingTaskId = "plugin-task";
    dom.schedulerTitleInput!.value = "Plugin task";
    dom.schedulerPromptInput!.value = "prompt";
    dom.schedulerEnabledInput!.checked = false;
    dom.schedulerKindInput!.value = "daily";
    dom.schedulerTimeOfDayInput!.value = "08:00";
    await panel.saveSchedulerTask();

    const input = vi.mocked(scheduler.update).mock.calls[0][1] as Record<string, unknown>;
    expect(scheduler.update).toHaveBeenCalledWith("plugin-task", expect.any(Object));
    expect(input).toMatchObject({ pluginUserEnabled: false, toolMode: "allow-list", allowedToolIds: [] });
    expect(input).not.toHaveProperty("enabled");
  });

  it("shows API and schedule errors in the save status", async () => {
    const scheduler = install(api({ add: vi.fn(async () => ({ ok: false, error: "server rejected" })) }));
    const { panel, dom } = await setup();
    dom.schedulerTitleInput!.value = "Title";
    dom.schedulerPromptInput!.value = "Prompt";
    dom.schedulerKindInput!.value = "daily";
    dom.schedulerTimeOfDayInput!.value = "08:00";
    await panel.saveSchedulerTask();
    expect(dom.schedulerSaveStatus!.textContent).toBe("server rejected");
    expect(dom.schedulerSaveStatus!.className).toContain("is-error");

    vi.mocked(scheduler.add).mockResolvedValueOnce({ ok: true, value: task() });
    dom.schedulerKindInput!.value = "daily";
    dom.schedulerTimeOfDayInput!.value = "bad";
    await panel.saveSchedulerTask();
    expect(dom.schedulerSaveStatus!.textContent).toBe("每日时间格式必须是 HH:mm");
  });
});

describe("toggleSchedulerTask", () => {
  it("toggles a normal task without confirmation and reloads the list", async () => {
    const scheduler = install();
    const { panel } = await setup();
    await panel.toggleSchedulerTask(task({ enabled: false }), true);
    expect(showConfirm).not.toHaveBeenCalled();
    expect(scheduler.toggle).toHaveBeenCalledWith("task-1", true);
    expect(scheduler.list).toHaveBeenCalledTimes(1);
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("asks for confirmation before enabling a plugin task", async () => {
    const scheduler = install();
    const { panel } = await setup();
    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    await panel.toggleSchedulerTask(task({ ownerPluginId: "plugin-1" }), true);
    expect(showConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tone: "warning",
      title: "启用插件创建的定时任务",
      confirmText: "确认启用",
    }));
    expect(scheduler.toggle).not.toHaveBeenCalled();

    vi.mocked(showConfirm).mockResolvedValueOnce(true);
    await panel.toggleSchedulerTask(task({ ownerPluginId: "plugin-1" }), true);
    expect(scheduler.toggle).toHaveBeenCalledWith("task-1", true);
  });

  it("reports toggle failures with a non-blocking notice", async () => {
    const scheduler = install(api({ toggle: vi.fn(async () => ({ ok: false, error: "cannot toggle" })) }));
    const { panel } = await setup();
    await panel.toggleSchedulerTask(task(), false);
    expect(showNotice).toHaveBeenCalledWith({ tone: "error", message: "cannot toggle" });
    expect(scheduler.list).toHaveBeenCalledTimes(1);
  });
});

describe("fireSchedulerTask", () => {
  it("does nothing on success", async () => {
    const scheduler = install();
    const { panel } = await setup();
    await panel.fireSchedulerTask("task-1");
    expect(scheduler.fireNow).toHaveBeenCalledWith("task-1");
    expect(showNotice).not.toHaveBeenCalled();
  });

  it.each([
    ["task already running", "该任务正在运行中"],
    ["plugin not running", "插件已停用，等待插件启用后再运行"],
    ["other", "other"],
  ])("maps failure reason %s to a notice", async (reason, expected) => {
    install(api({ fireNow: vi.fn(async () => ({ ok: false, reason })) }));
    const { panel } = await setup();
    await panel.fireSchedulerTask("task-1");
    if (reason === "other") {
      expect(showNotice).toHaveBeenCalledWith({ tone: "error", message: "other" });
    } else {
      expect(showNotice).toHaveBeenCalledWith({ tone: "error", message: expected });
    }
  });

  it("prefers an explicit error and falls back to a generic message", async () => {
    install(api({ fireNow: vi.fn(async () => ({ ok: false, error: "provider down" })) }));
    const first = await setup();
    await first.panel.fireSchedulerTask("task-1");
    expect(showNotice).toHaveBeenLastCalledWith({ tone: "error", message: "provider down" });

    install(api({ fireNow: vi.fn(async () => ({ ok: false })) }));
    const second = await setup();
    await second.panel.fireSchedulerTask("task-1");
    expect(showNotice).toHaveBeenLastCalledWith({ tone: "error", message: "立即运行失败" });
  });
});

describe("deleteSchedulerTask", () => {
  it("does nothing when the dangerous confirmation is cancelled", async () => {
    const scheduler = install();
    const { panel } = await setup();
    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    await panel.deleteSchedulerTask("task-1");
    expect(showConfirm).toHaveBeenCalledWith(expect.objectContaining({ dangerous: true, confirmText: "删除" }));
    expect(scheduler.delete).not.toHaveBeenCalled();
  });

  it("deletes after confirmation and reports failures", async () => {
    const scheduler = install(api({ delete: vi.fn(async () => ({ ok: false, error: "delete failed" })) }));
    const { panel } = await setup();
    await panel.deleteSchedulerTask("task-1");
    expect(scheduler.delete).toHaveBeenCalledWith("task-1");
    expect(showNotice).toHaveBeenCalledWith({ tone: "error", message: "delete failed" });
    expect(scheduler.list).toHaveBeenCalledTimes(1);
  });
});

describe("toggleSchedulerHistory", () => {
  function card(): HTMLElement {
    const element = document.createElement("div");
    element.innerHTML = '<div class="scheduler-history is-hidden"></div>';
    document.body.append(element);
    return element;
  }

  it("hides an already visible history box without fetching", async () => {
    const scheduler = install();
    const { panel } = await setup();
    const element = card();
    const box = element.querySelector(".scheduler-history")!;
    box.classList.remove("is-hidden");
    await panel.toggleSchedulerHistory("task-1", element);
    expect(box.classList.contains("is-hidden")).toBe(true);
    expect(scheduler.getHistory).not.toHaveBeenCalled();
  });

  it("does nothing when the card has no history box", async () => {
    const { panel } = await setup();
    await expect(panel.toggleSchedulerHistory("task-1", document.createElement("div"))).resolves.toBeUndefined();
  });

  it("shows the empty message and reveals the box", async () => {
    install(api({ getHistory: vi.fn(async () => ({ ok: true, value: [] })) }));
    const { panel } = await setup();
    const element = card();
    const box = element.querySelector(".scheduler-history")!;
    await panel.toggleSchedulerHistory("task-1", element);
    expect(box.textContent).toBe("暂无运行历史");
    expect(box.classList.contains("is-hidden")).toBe(false);
  });

  it("shows the API error when history cannot be read", async () => {
    install(api({ getHistory: vi.fn(async () => ({ ok: false, error: "history unavailable" })) }));
    const { panel } = await setup();
    const element = card();
    const box = element.querySelector(".scheduler-history")!;
    await panel.toggleSchedulerHistory("task-1", element);
    expect(box.textContent).toBe("history unavailable");
  });

  it("formats duration, output and interrupted-effect warnings", async () => {
    install(api({
      getHistory: vi.fn(async () => ({
        ok: true,
        value: [
          history({ status: "success", durationMs: 1_234, outputPreview: "all good" }),
          history({
            status: "interrupted",
            externalEffectsMayContinue: true,
            reason: "host restarted",
          }),
        ],
      })),
    }));
    const { panel } = await setup();
    const element = card();
    const box = element.querySelector(".scheduler-history")!;
    await panel.toggleSchedulerHistory("task-1", element);
    expect(box.children).toHaveLength(2);
    expect(box.textContent).toContain("1.2s：all good");
    expect(box.textContent).toContain("已中断（执行结果未知）");
    expect(box.textContent).toContain("外部操作可能仍在继续");
    expect(box.textContent).toContain("host restarted");
  });
});
