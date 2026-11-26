// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginProposal, ScheduledTask, SchedulerApi, SchedulerToolInfo } from "./scheduled-task-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const feedback = vi.hoisted(() => ({
  notice: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../../components/feedback/FeedbackProvider", () => ({
  useFeedback: () => feedback,
}));

import { ScheduledTaskPanel } from "./ScheduledTaskPanel";

const NOW = "2026-10-16T08:00:00.000Z";

const DAILY_TASK: ScheduledTask = {
  id: "task-daily",
  title: "早安信息整理",
  prompt: "整理今天的日程",
  enabled: true,
  schedule: { kind: "daily", timeOfDay: "08:00" },
  nextFireAt: "2026-10-17T00:00:00.000Z",
  toolMode: "all-enabled",
  allowedToolIds: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const TOOLS: SchedulerToolInfo[] = [
  { id: "web.search", name: "网页搜索", description: "", enabled: true, risk: "safe" },
  { id: "shell.run", name: "命令执行", description: "", enabled: false, risk: "high" },
];

type Listener = (event: unknown) => void;

let container: HTMLDivElement;
let root: Root;
let emit: Listener | undefined;

function installScheduler(overrides: Partial<SchedulerApi> = {}) {
  const api: SchedulerApi = {
    list: vi.fn(async () => ({ ok: true, value: [DAILY_TASK] })),
    add: vi.fn(async () => ({ ok: true, value: DAILY_TASK })),
    update: vi.fn(async () => ({ ok: true, value: DAILY_TASK })),
    delete: vi.fn(async () => ({ ok: true, value: true })),
    toggle: vi.fn(async (_id: string, enabled: boolean) => ({ ok: true, value: { ...DAILY_TASK, enabled } })),
    fireNow: vi.fn(async () => ({ ok: true, value: true })),
    getHistory: vi.fn(async () => ({ ok: true, value: [] })),
    getTools: vi.fn(async () => ({ ok: true, value: TOOLS })),
    ...overrides,
  };
  (window as unknown as Record<string, unknown>).fireflyScheduler = api;
  return api;
}

function installPluginList(plugins: Array<{ id: string; status: string }>) {
  (window as unknown as Record<string, unknown>).plugins = { list: vi.fn(async () => ({ plugins })) };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ScheduledTaskPanel));
  });
  await flush();
}

function text(): string {
  return container.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

function switchByLabel(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
  if (!found) throw new Error(`switch "${label}" not found`);
  return found;
}

/** 按可见标签取表单控件（标签文本位于 .scheduled-field__label 内）。 */
function field<T extends HTMLElement>(label: string): T {
  const span = [...container.querySelectorAll<HTMLElement>(".scheduled-field__label")].find((el) => el.textContent === label);
  const control = span?.closest("label")?.querySelector<T>("input, select, textarea");
  if (!control) throw new Error(`field "${label}" not found`);
  return control;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  const eventName = element instanceof HTMLSelectElement ? "change" : "input";
  act(() => {
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

function kindRadio(kind: string): HTMLInputElement {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${kind}"]`);
  if (!radio) throw new Error(`kind "${kind}" not found`);
  return radio;
}

async function openNewEditor() {
  await click(buttonByText("新建任务"));
}

beforeEach(() => {
  feedback.notice.mockClear();
  feedback.alert.mockClear();
  feedback.confirm.mockReset();
  feedback.confirm.mockResolvedValue(true);
  installPluginList([]);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  emit = undefined;
  delete (window as unknown as Record<string, unknown>).fireflyScheduler;
  delete (window as unknown as Record<string, unknown>).schedulerEvents;
  delete (window as unknown as Record<string, unknown>).plugins;
  vi.unstubAllGlobals();
});

describe("ScheduledTaskPanel — list", () => {
  it("lists tasks with schedule, enabled state, next run and the row actions", async () => {
    installScheduler();
    await renderPanel();
    expect(text()).toContain("早安信息整理");
    expect(text()).toContain("每天 08:00");
    expect(text()).toContain("已启用");
    for (const label of ["立即运行", "编辑", "历史", "删除"]) {
      expect(buttonByText(label)).toBeDefined();
    }
  });

  it("shows the empty state when there are no tasks", async () => {
    installScheduler({ list: vi.fn(async () => ({ ok: true, value: [] })) });
    await renderPanel();
    expect(text()).toContain("还没有定时任务");
  });

  it("reports a failed list read in an alert", async () => {
    installScheduler({ list: vi.fn(async () => ({ ok: false, error: "disk unavailable" })) });
    await renderPanel();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("disk unavailable");
  });

  it("reports a missing scheduler interface instead of rendering an empty list", async () => {
    await renderPanel();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("定时任务接口不可用");
  });
});

describe("ScheduledTaskPanel — create and edit", () => {
  it("creates a daily task with trimmed title and prompt and reloads the list", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "  新任务  ");
    setValue(field<HTMLTextAreaElement>("提示词"), " 做点事 ");
    await click(buttonByText("保存任务"));
    expect(api.add).toHaveBeenCalledWith({
      title: "新任务",
      prompt: "做点事",
      enabled: true,
      schedule: { kind: "daily", timeOfDay: "08:00" },
      toolMode: "all-enabled",
      allowedToolIds: [],
    });
    expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("prefills the editor from an existing task and saves changes through update", async () => {
    const api = installScheduler();
    await renderPanel();
    await click(buttonByText("编辑"));
    expect(field<HTMLInputElement>("标题").value).toBe("早安信息整理");
    expect(field<HTMLTextAreaElement>("提示词").value).toBe("整理今天的日程");
    setValue(field<HTMLInputElement>("标题"), "改过的标题");
    await click(buttonByText("保存任务"));
    expect(api.update).toHaveBeenCalledWith("task-daily", expect.objectContaining({
      title: "改过的标题",
      enabled: true,
      schedule: { kind: "daily", timeOfDay: "08:00" },
    }));
    expect(api.add).not.toHaveBeenCalled();
  });

  it("opens a suggestion with the schedule its card promises, and saves exactly that", async () => {
    const api = installScheduler({ list: vi.fn(async () => ({ ok: true, value: [] })) });
    await renderPanel();
    const cards = [...container.querySelectorAll<HTMLButtonElement>(".ff-panel-empty__card")];
    expect(cards.map(card => card.querySelector(".ff-panel-empty__card-title")?.textContent)).toEqual(["每日工作回顾", "每周计划整理", "定时检查待办"]);
    await click(cards[1]!);
    expect(kindRadio("weekly").checked).toBe(true);
    expect(field<HTMLSelectElement>("星期").value).toBe("1");
    expect(field<HTMLInputElement>("标题").value).toBe("每周计划整理");
    await click(buttonByText("保存任务"));
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ schedule: { kind: "weekly", dayOfWeek: 1, timeOfDay: "09:00" } }));
  });

  it("saves a weekly schedule with the chosen weekday", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "周报");
    setValue(field<HTMLTextAreaElement>("提示词"), "写周报");
    await click(kindRadio("weekly"));
    setValue(field<HTMLSelectElement>("星期"), "5");
    await click(buttonByText("保存任务"));
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({
      schedule: { kind: "weekly", dayOfWeek: 5, timeOfDay: "08:00" },
    }));
  });

  it("restores a saved interval schedule into the form", async () => {
    installScheduler({
      list: vi.fn(async () => ({ ok: true, value: [{ ...DAILY_TASK, schedule: { kind: "interval", every: 2, unit: "hours" } }] })),
    });
    await renderPanel();
    await click(buttonByText("编辑"));
    expect(kindRadio("interval").checked).toBe(true);
    expect(field<HTMLInputElement>("间隔数值").value).toBe("2");
    expect(field<HTMLSelectElement>("间隔单位").value).toBe("hours");
  });

  it("rejects an empty title with an inline error and does not call the API", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLTextAreaElement>("提示词"), "做点事");
    await click(buttonByText("保存任务"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("标题不能为空");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "标题");
    await click(buttonByText("保存任务"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("提示词不能为空");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("rejects a one-time run time in the past", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "一次性");
    setValue(field<HTMLTextAreaElement>("提示词"), "执行");
    await click(kindRadio("once"));
    setValue(field<HTMLInputElement>("运行时间"), "2000-01-01T08:00");
    await click(buttonByText("保存任务"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("一次性任务时间必须晚于当前时间");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("rejects a minute interval above 1440", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "间隔");
    setValue(field<HTMLTextAreaElement>("提示词"), "执行");
    await click(kindRadio("interval"));
    setValue(field<HTMLInputElement>("间隔数值"), "2000");
    await click(buttonByText("保存任务"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("分钟间隔不能超过 1440");
    expect(api.add).not.toHaveBeenCalled();
  });

  it("shows the server error when the save is refused", async () => {
    installScheduler({ add: vi.fn(async () => ({ ok: false, error: "store is read-only" })) });
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "标题");
    setValue(field<HTMLTextAreaElement>("提示词"), "执行");
    await click(buttonByText("保存任务"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("store is read-only");
  });

  it("sends the allow-list and selected tools when the tool limit is on, and hints at globally disabled tools", async () => {
    const api = installScheduler();
    await renderPanel();
    await openNewEditor();
    setValue(field<HTMLInputElement>("标题"), "工具任务");
    setValue(field<HTMLTextAreaElement>("提示词"), "执行");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click(switchByLabel("高级工具限制"));
    expect(text()).toContain("未选择工具时，任务只能使用模型自身能力");
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.scheduled-tool input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(container.textContent).toContain("已全局禁用");
    await click(boxes[0]);
    await click(boxes[1]);
    expect(text()).toContain("已全局禁用的工具即使被选中也不会被调用");
    await click(buttonByText("保存任务"));
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({
      toolMode: "allow-list",
      allowedToolIds: ["web.search", "shell.run"],
    }));
  });
});

describe("ScheduledTaskPanel — row actions", () => {
  it("toggles enabled state through the row switch", async () => {
    const api = installScheduler();
    await renderPanel();
    await click(switchByLabel("停用任务"));
    expect(api.toggle).toHaveBeenCalledWith("task-daily", false);
    expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("runs a task now and maps the already-running reason to a notice", async () => {
    const api = installScheduler({
      fireNow: vi.fn(async () => ({ ok: false, reason: "task already running" })),
    });
    await renderPanel();
    await click(buttonByText("立即运行"));
    expect(api.fireNow).toHaveBeenCalledWith("task-daily");
    expect(feedback.notice).toHaveBeenCalledWith({ tone: "error", message: "该任务正在运行中" });
  });

  it("deletes a task only after the danger confirmation", async () => {
    const api = installScheduler();
    feedback.confirm.mockResolvedValueOnce(false);
    await renderPanel();
    await click(buttonByText("删除"));
    expect(feedback.confirm).toHaveBeenCalledWith(expect.objectContaining({ dangerous: true }));
    expect(api.delete).not.toHaveBeenCalled();

    feedback.confirm.mockResolvedValueOnce(true);
    await click(buttonByText("删除"));
    expect(api.delete).toHaveBeenCalledWith("task-daily");
  });

  it("shows interrupted history as unknown with an effects warning even when partial output exists", async () => {
    installScheduler({ getHistory: vi.fn(async () => ({ ok: true, value: [{
      id: "interrupted-run", taskId: "task-daily", taskTitle: "synthetic", firedAt: NOW,
      status: "interrupted", executionOutcome: "unknown", externalEffectsMayContinue: true,
      outputPreview: "synthetic partial output", effectiveToolIds: [],
    }] })) });
    await renderPanel(); await click(buttonByText("历史"));
    expect(text()).toContain("已中断"); expect(text()).toContain("执行结果未知");
    expect(text()).toContain("外部操作可能仍在继续"); expect(text()).toContain("synthetic partial output");
    expect(text()).not.toContain("运行中");
  });

  it("opens history for a task and renders its rows", async () => {
    const api = installScheduler({
      getHistory: vi.fn(async () => ({
        ok: true,
        value: [{
          id: "run-1",
          taskId: "task-daily",
          taskTitle: "早安信息整理",
          firedAt: NOW,
          status: "failed",
          durationMs: 2300,
          errorMessage: "boom",
          effectiveToolIds: [],
        }],
      })),
    });
    await renderPanel();
    await click(buttonByText("历史"));
    expect(api.getHistory).toHaveBeenCalledWith("task-daily", 10);
    expect(text()).toContain("失败");
    expect(text()).toContain("2.3s");
    expect(text()).toContain("boom");
  });

  it("shows an empty history message", async () => {
    installScheduler();
    await renderPanel();
    await click(buttonByText("历史"));
    expect(text()).toContain("暂无运行历史");
  });
});

describe("ScheduledTaskPanel — plugin-owned tasks", () => {
  const PLUGIN_TASK: ScheduledTask = {
    ...DAILY_TASK,
    id: "task-plugin",
    title: "插件任务",
    enabled: false,
    ownerPluginId: "demo.plugin",
    mode: "work",
    toolMode: "allow-list",
    allowedToolIds: ["web.search"],
  };

  it("waits for the plugin, disables run now, and confirms before enabling", async () => {
    const api = installScheduler({ list: vi.fn(async () => ({ ok: true, value: [PLUGIN_TASK] })) });
    installPluginList([{ id: "demo.plugin", status: "disabled" }]);
    await renderPanel();
    expect(text()).toContain("等待插件启用");
    expect(buttonByText("立即运行").disabled).toBe(true);

    feedback.confirm.mockResolvedValueOnce(false);
    await click(switchByLabel("启用任务"));
    expect(feedback.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "启用插件创建的定时任务" }));
    expect(api.toggle).not.toHaveBeenCalled();

    feedback.confirm.mockResolvedValueOnce(true);
    await click(switchByLabel("启用任务"));
    expect(api.toggle).toHaveBeenCalledWith("task-plugin", true);
  });
});

describe("ScheduledTaskPanel — review follow-ups", () => {
  it("follows plugin status changes while the panel stays focused", async () => {
    const task: ScheduledTask = { ...DAILY_TASK, id: "task-plugin", ownerPluginId: "demo.plugin" };
    installScheduler({ list: vi.fn(async () => ({ ok: true, value: [task] })) });
    let status = "disabled"; let changed: (() => void) | undefined;
    (window as unknown as Record<string, unknown>).plugins = {
      list: vi.fn(async () => ({ plugins: [{ id: "demo.plugin", status }] })),
      onChanged: vi.fn((callback: () => void) => { changed = callback; return () => { changed = undefined; }; }),
    };
    await renderPanel();
    expect(buttonByText("立即运行").disabled).toBe(true);
    status = "running";
    await act(async () => { changed!(); });
    await flush();
    expect(buttonByText("立即运行").disabled).toBe(false);
    status = "stopped";
    await act(async () => { changed!(); });
    await flush();
    expect(buttonByText("立即运行").disabled).toBe(true);
  });

  it.each([
    { pluginRunnable: true, disabled: false },
    { pluginRunnable: false, disabled: true },
  ])("uses the host's pluginRunnable=$pluginRunnable over the legacy list for a v2 plugin task (Run now disabled: $disabled)", async ({ pluginRunnable, disabled }) => {
    const task: ScheduledTask = { ...DAILY_TASK, id: "task-v2", ownerPluginId: "v2.plugin", pluginRunnable };
    installScheduler({ list: vi.fn(async () => ({ ok: true, value: [task] })) });
    installPluginList([]);
    await renderPanel();

    expect(buttonByText("立即运行").disabled).toBe(disabled);
  });

  it("re-reads the task list on a legacy plugin change so a cached pluginRunnable does not go stale", async () => {
    let runnable = false; let changed: (() => void) | undefined;
    const list = vi.fn(async () => ({ ok: true, value: [{ ...DAILY_TASK, id: "task-plugin", ownerPluginId: "demo.plugin", pluginRunnable: runnable }] }));
    installScheduler({ list });
    (window as unknown as Record<string, unknown>).plugins = {
      list: vi.fn(async () => ({ plugins: [] })),
      onChanged: vi.fn((callback: () => void) => { changed = callback; return () => { changed = undefined; }; }),
    };
    await renderPanel();
    expect(buttonByText("立即运行").disabled).toBe(true);

    runnable = true;
    await act(async () => { changed!(); });
    await flush();
    expect(buttonByText("立即运行").disabled).toBe(false);
  });

  it("stops listening to plugin changes when the panel unmounts", async () => {
    installScheduler();
    const off = vi.fn();
    (window as unknown as Record<string, unknown>).plugins = { list: vi.fn(async () => ({ plugins: [] })), onChanged: vi.fn(() => off) };
    await renderPanel();
    await act(async () => { root.unmount(); });
    expect(off).toHaveBeenCalled();
  });

  it("refreshes an expanded history when a run finishes, keeping the rows while it loads", async () => {
    const row = (id: string, status: string) => ({ id, taskId: "task-daily", taskTitle: "早安信息整理", firedAt: NOW, status, durationMs: 1000, effectiveToolIds: [] });
    let rows: any[] = [row("run-1", "running")];
    const api = installScheduler({ getHistory: vi.fn(async () => ({ ok: true, value: rows })) });
    (window as unknown as Record<string, unknown>).schedulerEvents = { onEvent: vi.fn((callback: Listener) => { emit = callback; return () => { emit = undefined; }; }) };
    await renderPanel();
    await click(buttonByText("历史"));
    expect(text()).toContain("运行中");
    rows = [row("run-1", "success"), row("run-0", "failed")];
    await act(async () => { emit!({ type: "RUN_FINISHED" }); });
    await flush();
    expect(api.getHistory.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(text()).not.toContain("运行中");
    expect(text()).toContain("失败");
  });

  it("refreshes the expanded history when the plugin host reports a finished run of that task", async () => {
    const row = (id: string, status: string) => ({ id, taskId: "task-daily", taskTitle: "早安信息整理", firedAt: NOW, status, durationMs: 1000, effectiveToolIds: [] });
    let rows: any[] = [];
    const api = installScheduler({ getHistory: vi.fn(async () => ({ ok: true, value: rows })) });
    (window as unknown as Record<string, unknown>).schedulerEvents = { onEvent: vi.fn((callback: Listener) => { emit = callback; return () => { emit = undefined; }; }) };
    await renderPanel();
    await click(buttonByText("历史"));
    const listCalls = api.list.mock.calls.length;
    rows = [row("run-1", "failed")];
    await act(async () => { emit!({ type: "CUSTOM", name: "scheduler.plugin_task_finished", schedulerTaskId: "task-daily" }); });
    await flush();
    expect(api.list.mock.calls.length).toBeGreaterThan(listCalls);
    expect(text()).toContain("失败");
  });

  it("refreshes only the history of the task a run event names, and every open history on focus", async () => {
    const second: ScheduledTask = { ...DAILY_TASK, id: "task-second", title: "每周报告" };
    const api = installScheduler({ list: vi.fn(async () => ({ ok: true, value: [DAILY_TASK, second] })) });
    (window as unknown as Record<string, unknown>).schedulerEvents = { onEvent: vi.fn((callback: Listener) => { emit = callback; return () => { emit = undefined; }; }) };
    await renderPanel();
    for (const button of [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "历史")) await click(button);
    const calls = () => api.getHistory.mock.calls.map((call) => call[0]);
    expect(calls().sort()).toEqual(["task-daily", "task-second"]);
    api.getHistory.mockClear();
    await act(async () => { emit!({ type: "RUN_FINISHED", schedulerTaskId: "task-second", schedulerRunId: "r1" }); });
    await flush();
    expect(calls()).toEqual(["task-second"]);
    api.getHistory.mockClear();
    await act(async () => { emit!({ type: "CUSTOM", name: "scheduler.started", schedulerTaskId: "task-daily", value: {} }); });
    await flush();
    expect(calls()).toEqual(["task-daily"]);
    api.getHistory.mockClear();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(calls().sort()).toEqual(["task-daily", "task-second"]);
    // An event that does not say which task it belongs to cannot be narrowed, so every open history is refreshed.
    api.getHistory.mockClear();
    await act(async () => { emit!({ type: "RUN_ERROR", message: "x" }); });
    await flush();
    expect(calls().sort()).toEqual(["task-daily", "task-second"]);
  });

  it("does not fetch history for tasks whose history is collapsed", async () => {
    const api = installScheduler();
    (window as unknown as Record<string, unknown>).schedulerEvents = { onEvent: vi.fn((callback: Listener) => { emit = callback; return () => { emit = undefined; }; }) };
    await renderPanel();
    await act(async () => { emit!({ type: "RUN_FINISHED" }); });
    await flush();
    expect(api.getHistory).not.toHaveBeenCalled();
  });
});

describe("ScheduledTaskPanel — live refresh", () => {
  it("reloads when a run starts, finishes or fails, but not on streaming chunks", async () => {
    const api = installScheduler();
    (window as unknown as Record<string, unknown>).schedulerEvents = {
      onEvent: vi.fn((callback: Listener) => {
        emit = callback;
        return () => { emit = undefined; };
      }),
    };
    await renderPanel();
    expect(emit).toBeDefined();
    const afterMount = api.list.mock.calls.length;

    await act(async () => { emit!({ type: "TEXT_MESSAGE_CONTENT", delta: "x" }); });
    await flush();
    expect(api.list.mock.calls.length).toBe(afterMount);

    await act(async () => { emit!({ type: "CUSTOM", name: "scheduler.started", value: {} }); });
    await flush();
    expect(api.list.mock.calls.length).toBe(afterMount + 1);

    await act(async () => { emit!({ type: "RUN_FINISHED" }); });
    await flush();
    expect(api.list.mock.calls.length).toBe(afterMount + 2);

    await act(async () => { emit!({ type: "RUN_ERROR", message: "x" }); });
    await flush();
    expect(api.list.mock.calls.length).toBe(afterMount + 3);
  });
});

it("shows native cron read-only without offering an editor that could change its schedule", async () => {
  const cronTask: ScheduledTask = { ...DAILY_TASK, schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" } };
  const api = installScheduler({ list: vi.fn(async () => ({ ok: true, value: [cronTask] })) });
  await renderPanel();
  expect(text()).toContain("Cron */15 * * * * (UTC)");
  expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "编辑")).toBe(false);
  expect(api.update).not.toHaveBeenCalled();
});

describe("plugin schedule proposals", () => {
  const CALLBACK_PROPOSAL: PluginProposal = {
    proposalId: "p-1",
    revision: "rev-p-1",
    taskId: "plugin-task-1",
    pluginId: "dev.firefly.digest",
    pluginName: "Digest plugin",
    kind: "create",
    title: "Hourly sync",
    schedule: { kind: "interval", minutes: 60 },
    action: { type: "callback" },
    allowedToolIds: [],
    createdAt: NOW,
  };
  const UPDATE_PROPOSAL: PluginProposal = {
    ...CALLBACK_PROPOSAL,
    proposalId: "p-2",
    revision: "rev-p-2",
    taskId: "plugin-task-2",
    kind: "update",
    title: "Evening digest",
    schedule: { kind: "interval", minutes: 120 },
    action: { type: "run", prompt: "Summarize the day", mode: "work" },
    current: {
      title: "Morning digest",
      schedule: { kind: "interval", minutes: 30 },
      action: { type: "run", prompt: "Summarize the day", mode: "work" },
      allowedToolIds: [],
    },
  };

  function installWithProposals(proposals: PluginProposal[], overrides: Partial<SchedulerApi> = {}) {
    return installScheduler({
      listPluginProposals: vi.fn(async () => ({ ok: true, value: proposals })),
      confirmPluginProposal: vi.fn(async () => ({ ok: true, value: true })),
      rejectPluginProposal: vi.fn(async () => ({ ok: true, value: true })),
      ...overrides,
    });
  }

  it("hides the pending section when there are no proposals", async () => {
    installWithProposals([]);
    await renderPanel();
    expect(text()).not.toContain("待确认");
    expect(container.querySelector(".scheduled-pending")).toBeNull();
  });

  it("hides the pending section when the preload API has no proposal methods", async () => {
    installScheduler();
    await renderPanel();
    expect(container.querySelector(".scheduled-pending")).toBeNull();
    expect(text()).toContain("早安信息整理");
  });

  it("shows plugin name, title, schedule and a plain plugin-callback action for a new callback task", async () => {
    installWithProposals([CALLBACK_PROPOSAL]);
    await renderPanel();

    const section = container.querySelector<HTMLElement>(".scheduled-pending")!;
    expect(section.querySelector("h2")?.textContent).toBe("待确认");
    const card = section.querySelector<HTMLElement>("article")!;
    expect(card.querySelector("h3")?.textContent).toBe("Hourly sync");
    expect(card.textContent).toContain("Digest plugin");
    expect(card.textContent).toContain("新建任务");
    expect(card.textContent).toContain("插件回调");
    expect(card.textContent).not.toContain("运行提示词");
    expect(card.textContent).not.toContain("变更内容");
  });

  it("shows prompt and mode for a run action", async () => {
    installWithProposals([{ ...CALLBACK_PROPOSAL, action: { type: "run", prompt: "Summarize unread", mode: "chat" } }]);
    await renderPanel();
    expect(container.querySelector(".scheduled-pending")!.textContent).toContain("以chat模式运行提示词：Summarize unread");
  });

  it("confirm calls the API with the proposal's taskId only, then reloads the lists", async () => {
    const api = installWithProposals([CALLBACK_PROPOSAL, UPDATE_PROPOSAL]);
    await renderPanel();
    const listCalls = (api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length;
    const secondCard = container.querySelectorAll<HTMLElement>(".scheduled-pending article")[1];
    const confirmButton = [...secondCard.querySelectorAll("button")].find((b) => b.textContent?.trim() === "确认")!;

    await click(confirmButton);

    expect(api.confirmPluginProposal).toHaveBeenCalledTimes(1);
    expect(api.confirmPluginProposal).toHaveBeenCalledWith("plugin-task-2", "rev-p-2");
    expect(api.rejectPluginProposal).not.toHaveBeenCalled();
    expect((api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCalls + 1);
  });

  it("reject calls the reject API and never the confirm API", async () => {
    const api = installWithProposals([CALLBACK_PROPOSAL]);
    await renderPanel();

    await click(buttonByText("拒绝"));

    expect(api.rejectPluginProposal).toHaveBeenCalledWith("plugin-task-1");
    expect(api.confirmPluginProposal).not.toHaveBeenCalled();
  });

  it("disables both buttons while a request is in flight and enables them again afterwards", async () => {
    let finish!: (value: { ok: boolean; value: boolean }) => void;
    const api = installWithProposals([CALLBACK_PROPOSAL], {
      confirmPluginProposal: vi.fn(() => new Promise((resolve) => { finish = resolve; })) as never,
    });
    await renderPanel();

    await click(buttonByText("确认"));
    expect(buttonByText("确认").disabled).toBe(true);
    expect(buttonByText("拒绝").disabled).toBe(true);
    await click(buttonByText("确认"));
    expect(api.confirmPluginProposal).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ ok: false, value: false }); });
    await flush();
    expect(buttonByText("确认").disabled).toBe(false);
    expect(buttonByText("拒绝").disabled).toBe(false);
  });

  it.each([
    ["ERR_INVALID_ARGUMENT", "这条提案已经处理过或不存在了。"],
    ["ERR_REJECTED", "这条提案已经被拒绝了。"],
    [undefined, "No pending proposal found"],
  ])("shows a readable message for code %s and keeps the proposal on screen", async (code, expected) => {
    installWithProposals([CALLBACK_PROPOSAL], {
      confirmPluginProposal: vi.fn(async () => ({ ok: false, error: "No pending proposal found", ...(code ? { code } : {}) })),
    });
    await renderPanel();

    await click(buttonByText("确认"));

    const alert = container.querySelector(".scheduled-pending [role='alert']");
    expect(alert?.textContent).toBe(expected);
    expect(container.querySelectorAll(".scheduled-pending article")).toHaveLength(1);
  });

  it("a proposal that would need approval on every run explains why it cannot be confirmed and stays pending", async () => {
    const api = installWithProposals([CALLBACK_PROPOSAL], {
      confirmPluginProposal: vi.fn(async () => ({
        ok: false, error: "This task needs approval each time it runs (shell).", code: "ERR_PERMISSION", reason: "unattended_approval_unsupported",
      })),
    });
    await renderPanel();
    const listCalls = (api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length;

    await click(buttonByText("确认"));

    expect(container.querySelector(".scheduled-pending [role='alert']")?.textContent)
      .toBe("这个任务每次运行都需要审批，Firefly 1.2.0 还不支持无人值守审批，因此无法确认。");
    expect(container.querySelectorAll(".scheduled-pending article")).toHaveLength(1);
    expect(buttonByText("拒绝").disabled).toBe(false);
    expect((api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCalls);
  });

  it("a proposal the plugin edited after review is not confirmed, shows a re-review message and reloads the list", async () => {
    const edited: PluginProposal = { ...CALLBACK_PROPOSAL, revision: "rev-p-1-edited", action: { type: "run", prompt: "x", mode: "work" }, allowedToolIds: ["shell"] };
    const api = installWithProposals([CALLBACK_PROPOSAL], {
      confirmPluginProposal: vi.fn(async () => ({ ok: false, error: "changed", code: "ERR_UNAVAILABLE" })),
    });
    await renderPanel();
    (api.listPluginProposals as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: [edited] });
    const listCalls = (api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length;

    await click(buttonByText("确认"));

    expect(api.confirmPluginProposal).toHaveBeenCalledWith("plugin-task-1", "rev-p-1");
    expect((api.listPluginProposals as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCalls + 1);
    expect(container.querySelector(".scheduled-pending [role='alert']")?.textContent)
      .toBe("这条提案在你查看后被插件修改过，请重新审阅后再确认。");
    expect(container.textContent).toContain("shell");
  });

  it("an update proposal lists only the fields that changed", async () => {
    installWithProposals([UPDATE_PROPOSAL]);
    await renderPanel();

    const card = container.querySelector<HTMLElement>(".scheduled-pending article")!;
    expect(card.textContent).toContain("修改已有任务");
    const changes = [...card.querySelectorAll(".scheduled-pending__changes li")].map((li) => li.textContent);
    expect(changes).toEqual([
      "标题：Morning digest -> Evening digest",
      "计划：每隔 30 分钟 -> 每隔 2 小时",
    ]);
  });

  it("an update with no visible difference says so, and one whose task is gone says it cannot be applied", async () => {
    installWithProposals([
      { ...UPDATE_PROPOSAL, current: { title: UPDATE_PROPOSAL.title, schedule: UPDATE_PROPOSAL.schedule, action: UPDATE_PROPOSAL.action, allowedToolIds: [] } },
      { ...UPDATE_PROPOSAL, proposalId: "p-3", taskId: "plugin-task-3", current: undefined },
    ]);
    await renderPanel();

    const [same, gone] = [...container.querySelectorAll<HTMLElement>(".scheduled-pending article")];
    expect(same.textContent).toContain("与当前任务相同");
    expect(gone.textContent).toContain("原任务已不存在，此变更无法应用");
  });

  it("reloads the proposal list when the main process reports a proposal change", async () => {
    const api = installWithProposals([]);
    (window as unknown as Record<string, unknown>).schedulerEvents = { onEvent: vi.fn((callback: Listener) => { emit = callback; return () => { emit = undefined; }; }) };
    await renderPanel();
    expect(container.querySelector(".scheduled-pending")).toBeNull();

    (api.listPluginProposals as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: [CALLBACK_PROPOSAL] });
    await act(async () => { emit!({ type: "CUSTOM", name: "scheduler.plugin_proposals_changed" }); });
    await flush();

    expect(container.querySelector(".scheduled-pending")).not.toBeNull();
  });
});
