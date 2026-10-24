import type { ScheduledTask, ScheduleConfig } from "./types";
import { schedulerState } from "./state";
import * as controls from "./dom";
import { toLocalDateTimeInputValue, isValidTimeOfDay, formatSchedulerDate, describeSchedule } from "./utils";
import { showConfirm, showNotice } from "../shared/modal";

export function setSchedulerStatus(text: string, className = ""): void {
  const status = controls.schedulerSaveStatus;
  if (!status) return;
  status.textContent = text;
  status.className = "save-status" + (className ? " " + className : "");
}

export function renderSchedulerTools(selectedIds: string[] = []): void {
  const picker = controls.schedulerToolPicker;
  if (!picker) return;
  picker.replaceChildren();
  const chosen = new Set(selectedIds);
  for (const item of schedulerState.tools) {
    const option = document.createElement("label");
    option.className = "scheduler-tool-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = item.id;
    input.checked = chosen.has(item.id);
    input.addEventListener("change", updateSchedulerConditionalFields);
    const description = document.createElement("span");
    description.textContent = `${item.name} (${item.id}) · ${item.risk}${item.enabled ? "" : " · 已全局禁用"}`;
    option.appendChild(input);
    option.appendChild(description);
    picker.appendChild(option);
  }
}

function taskButton(label: string, clicked: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn";
  button.textContent = label;
  button.addEventListener("click", clicked);
  return button;
}

export async function renderSchedulerList(): Promise<void> {
  const list = controls.schedulerList;
  const empty = controls.schedulerEmpty;
  if (!list || !empty) return;
  list.replaceChildren();
  empty.classList.toggle("is-hidden", schedulerState.tasks.length > 0);
  for (const item of schedulerState.tasks) {
    const article = document.createElement("article");
    article.className = "scheduler-card";
    article.innerHTML = `
      <div class="scheduler-card__head">
        <div class="scheduler-card__title"><span><svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><strong></strong><span class="scheduler-badge"></span></div>
      </div>
      <div class="scheduler-card__meta"></div>
      <div class="scheduler-card__actions"></div>
      <div class="scheduler-history is-hidden"></div>
    `;
    const heading = article.querySelector("strong");
    if (heading) heading.textContent = item.title;
    const owned = Boolean(item.ownerPluginId);
    const running = owned && schedulerState.pluginRunning[item.ownerPluginId!] === true;
    const badge = article.querySelector(".scheduler-badge") as HTMLSpanElement | null;
    if (badge) {
      badge.textContent = item.enabled ? "已启用" : "已停用";
      badge.classList.toggle("is-disabled", !item.enabled);
    }
    const metadata = article.querySelector(".scheduler-card__meta");
    if (metadata) {
      const descriptions: string[] = [];
      if (owned) descriptions.push(`由插件 ${item.ownerPluginId} 创建`);
      descriptions.push(describeSchedule(item.schedule));
      descriptions.push(`下次运行：${formatSchedulerDate(item.nextFireAt)}`);
      descriptions.push(`模式：${item.mode ?? "work"}`);
      const toolNames = owned ? (item.allowedToolIds.join(", ") || "无")
        : (item.toolMode === "all-enabled" ? "全部已启用工具" : item.allowedToolIds.join(", ") || "无");
      descriptions.push(`工具：${toolNames}`);
      if (owned && !running) descriptions.push("等待插件启用");
      metadata.textContent = descriptions.join(" · ");
    }
    const actions = article.querySelector(".scheduler-card__actions") as HTMLDivElement | null;
    if (actions) {
      const fire = document.createElement("button");
      fire.type = "button";
      fire.className = "ghost-btn";
      fire.textContent = "立即运行";
      fire.disabled = owned && !running;
      if (fire.disabled) fire.title = "插件已停用，等待插件启用";
      fire.addEventListener("click", () => void fireSchedulerTask(item.id));
      const edit = taskButton("编辑", () => void openSchedulerEditor(item));
      const toggle = taskButton(item.enabled ? "停用" : "启用", () => void toggleSchedulerTask(item, !item.enabled));
      const history = taskButton("历史", () => void toggleSchedulerHistory(item.id, article));
      const remove = taskButton("删除", () => void deleteSchedulerTask(item.id));
      actions.append(fire, edit, toggle, history, remove);
    }
    list.appendChild(article);
  }
}

export async function loadSchedulerPanel(): Promise<void> {
  const [tasks, tools, plugins] = await Promise.all([
    window.fireflyScheduler!.list(), window.fireflyScheduler!.getTools(),
    window.plugins?.list().catch(() => undefined),
  ]);
  if (tasks.ok) schedulerState.tasks = tasks.value ?? [];
  if (tools.ok) schedulerState.tools = tools.value ?? [];
  const pluginEntries = plugins ? (Array.isArray(plugins) ? plugins : plugins.plugins ?? []) : [];
  schedulerState.pluginRunning = {};
  for (const entry of pluginEntries) schedulerState.pluginRunning[entry.id] = entry.status === "running";
  renderSchedulerTools();
  await renderSchedulerList();
}

export async function openSchedulerEditor(task?: ScheduledTask): Promise<void> {
  schedulerState.editingTaskId = task?.id ?? null;
  controls.schedulerEditor?.classList.remove("is-hidden");
  if (schedulerState.tools.length === 0) {
    const available = await window.fireflyScheduler!.getTools();
    if (available.ok) schedulerState.tools = available.value ?? [];
  }
  if (controls.schedulerEditorTitle) controls.schedulerEditorTitle.textContent = task ? "编辑定时任务" : "新建定时任务";
  if (controls.schedulerTitleInput) controls.schedulerTitleInput.value = task?.title ?? "";
  if (controls.schedulerPromptInput) controls.schedulerPromptInput.value = task?.prompt ?? "";
  if (controls.schedulerEnabledInput) controls.schedulerEnabledInput.checked = task?.enabled ?? true;
  if (controls.schedulerKindInput) controls.schedulerKindInput.value = task?.schedule.kind ?? "daily";
  if (controls.schedulerOnceRunAtInput) controls.schedulerOnceRunAtInput.value = "";
  if (controls.schedulerTimeOfDayInput) controls.schedulerTimeOfDayInput.value = "08:00";
  if (controls.schedulerDayOfWeekInput) controls.schedulerDayOfWeekInput.value = "1";
  if (controls.schedulerIntervalEveryInput) controls.schedulerIntervalEveryInput.value = "1";
  if (controls.schedulerIntervalUnitInput) controls.schedulerIntervalUnitInput.value = "minutes";
  const schedule = task?.schedule;
  if (schedule?.kind === "once" && controls.schedulerOnceRunAtInput) controls.schedulerOnceRunAtInput.value = toLocalDateTimeInputValue(schedule.runAt);
  if ((schedule?.kind === "daily" || schedule?.kind === "weekly") && controls.schedulerTimeOfDayInput) controls.schedulerTimeOfDayInput.value = schedule.timeOfDay;
  if (schedule?.kind === "weekly" && controls.schedulerDayOfWeekInput) controls.schedulerDayOfWeekInput.value = String(schedule.dayOfWeek);
  if (schedule?.kind === "interval") {
    if (controls.schedulerIntervalEveryInput) controls.schedulerIntervalEveryInput.value = String(schedule.every);
    if (controls.schedulerIntervalUnitInput) controls.schedulerIntervalUnitInput.value = schedule.unit;
  }
  if (controls.schedulerToolLimitInput) {
    const pluginOwned = Boolean(task?.ownerPluginId);
    controls.schedulerToolLimitInput.checked = pluginOwned || task?.toolMode === "allow-list";
    controls.schedulerToolLimitInput.disabled = pluginOwned;
  }
  renderSchedulerTools(task?.allowedToolIds ?? []);
  updateSchedulerConditionalFields();
  setSchedulerStatus("等待操作");
}

export function closeSchedulerEditor(): void {
  schedulerState.editingTaskId = null;
  controls.schedulerEditor?.classList.add("is-hidden");
}

export function updateSchedulerConditionalFields(): void {
  const selectedKind = controls.schedulerKindInput?.value ?? "daily";
  const show = (selector: string, visible: boolean): void => {
    document.querySelectorAll(selector).forEach(node => node.classList.toggle("is-hidden", !visible));
  };
  show(".scheduler-once-field", selectedKind === "once");
  show(".scheduler-time-field", selectedKind === "daily" || selectedKind === "weekly");
  show(".scheduler-weekly-field", selectedKind === "weekly");
  show(".scheduler-interval-field", selectedKind === "interval");
  const restricted = Boolean(controls.schedulerToolLimitInput?.checked);
  controls.schedulerToolPicker?.classList.toggle("is-hidden", !restricted);
  const chosenCount = collectAllowedToolIds().length;
  controls.schedulerToolEmptyHint?.classList.toggle("is-hidden", !restricted || chosenCount > 0);
}

export function collectSchedule(): ScheduleConfig {
  const selectedKind = controls.schedulerKindInput?.value ?? "daily";
  if (selectedKind === "once") {
    const entered = controls.schedulerOnceRunAtInput?.value;
    if (!entered) throw new Error("请选择一次性运行时间");
    const instant = new Date(entered);
    if (Number.isNaN(instant.getTime())) throw new Error("一次性运行时间无效");
    if (instant.getTime() <= Date.now()) throw new Error("一次性任务时间必须晚于当前时间");
    return { kind: "once", runAt: instant.toISOString() };
  }
  if (selectedKind === "weekly") {
    const clock = controls.schedulerTimeOfDayInput?.value || "08:00";
    if (!isValidTimeOfDay(clock)) throw new Error("每周时间格式必须是 HH:mm");
    const weekday = Number(controls.schedulerDayOfWeekInput?.value ?? 1);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error("星期必须是周一到周日");
    return { kind: "weekly", dayOfWeek: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay: clock };
  }
  if (selectedKind === "interval") {
    const count = Number(controls.schedulerIntervalEveryInput?.value ?? 1);
    const units = controls.schedulerIntervalUnitInput?.value === "hours" ? "hours" : "minutes";
    if (!Number.isInteger(count) || count <= 0) throw new Error("间隔必须是正整数");
    if (units === "minutes" && count > 1440) throw new Error("分钟间隔不能超过 1440");
    if (units === "hours" && count > 168) throw new Error("小时间隔不能超过 168");
    return { kind: "interval", every: count, unit: units };
  }
  const clock = controls.schedulerTimeOfDayInput?.value || "08:00";
  if (!isValidTimeOfDay(clock)) throw new Error("每日时间格式必须是 HH:mm");
  return { kind: "daily", timeOfDay: clock };
}

export function collectAllowedToolIds(): string[] {
  const picker = controls.schedulerToolPicker;
  if (!picker) return [];
  const checked = picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  return Array.from(checked, item => item.value);
}

export async function saveSchedulerTask(): Promise<void> {
  try {
    setSchedulerStatus("保存中…");
    const enteredTitle = (controls.schedulerTitleInput?.value ?? "").trim();
    const enteredPrompt = (controls.schedulerPromptInput?.value ?? "").trim();
    if (!enteredTitle) throw new Error("标题不能为空");
    if (!enteredPrompt) throw new Error("提示词不能为空");
    const current = schedulerState.tasks.find(item => item.id === schedulerState.editingTaskId);
    const owned = Boolean(current?.ownerPluginId);
    const payload = {
      title: enteredTitle,
      prompt: enteredPrompt,
      ...(owned ? { pluginUserEnabled: controls.schedulerEnabledInput?.checked ?? true }
        : { enabled: controls.schedulerEnabledInput?.checked ?? true }),
      schedule: collectSchedule(),
      toolMode: owned || controls.schedulerToolLimitInput?.checked ? "allow-list" : "all-enabled",
      allowedToolIds: collectAllowedToolIds(),
    };
    const saved = schedulerState.editingTaskId
      ? await window.fireflyScheduler!.update(schedulerState.editingTaskId, payload)
      : await window.fireflyScheduler!.add(payload);
    if (!saved.ok) throw new Error(saved.error ?? "保存失败");
    await loadSchedulerPanel();
    closeSchedulerEditor();
  } catch (failure) {
    setSchedulerStatus(failure instanceof Error ? failure.message : String(failure), "is-error");
  }
}

async function confirmPluginTaskEnable(task: ScheduledTask): Promise<boolean> {
  const preview = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
  const allowed = task.allowedToolIds.length ? task.allowedToolIds.join(", ") : "无（仅模型自身能力）";
  const explanation = [
    `插件：${task.ownerPluginId}`, `计划：${describeSchedule(task.schedule)}`,
    `提示词：${preview}`, `会话模式：${task.mode ?? "work"}`, `工具：${allowed}`,
  ].join(" · ");
  return showConfirm({ tone: "warning", title: "启用插件创建的定时任务", message: explanation, confirmText: "确认启用" });
}

export async function toggleSchedulerTask(task: ScheduledTask, enabled: boolean): Promise<void> {
  if (enabled && task.ownerPluginId) {
    const authorized = await confirmPluginTaskEnable(task);
    if (!authorized) return;
  }
  const changed = await window.fireflyScheduler!.toggle(task.id, enabled);
  if (!changed.ok) showNotice({ tone: "error", message: changed.error ?? "切换失败" });
  await loadSchedulerPanel();
}

export async function fireSchedulerTask(id: string): Promise<void> {
  const fired = await window.fireflyScheduler!.fireNow(id);
  if (!fired.ok) {
    const explanation = fired.reason === "task already running" ? "该任务正在运行中"
      : fired.reason === "plugin not running" ? "插件已停用，等待插件启用后再运行"
        : (fired.error ?? fired.reason ?? "立即运行失败");
    showNotice({ tone: "error", message: explanation });
  }
}

export async function deleteSchedulerTask(id: string): Promise<void> {
  const authorized = await showConfirm({ title: "删除定时任务", message: "确定删除这个定时任务吗？", confirmText: "删除", dangerous: true });
  if (!authorized) return;
  const removed = await window.fireflyScheduler!.delete(id);
  if (!removed.ok) showNotice({ tone: "error", message: removed.error ?? "删除失败" });
  await loadSchedulerPanel();
}

export async function toggleSchedulerHistory(taskId: string, card: Element): Promise<void> {
  const history = card.querySelector(".scheduler-history") as HTMLDivElement | null;
  if (!history) return;
  if (!history.classList.contains("is-hidden")) {
    history.classList.add("is-hidden");
    return;
  }
  const fetched = await window.fireflyScheduler!.getHistory(taskId, 10);
  const entries = fetched.value ?? [];
  history.replaceChildren();
  if (!fetched.ok || entries.length === 0) {
    history.textContent = fetched.ok ? "暂无运行历史" : (fetched.error ?? "读取历史失败");
  } else {
    for (const entry of entries) {
      const outcome = entry.status === "interrupted" ? "已中断（执行结果未知）" : entry.status;
      const caution = entry.status === "interrupted" || entry.externalEffectsMayContinue
        ? "外部操作可能仍在继续，已发生的效果不会自动撤回。" : "";
      const description = [caution, entry.outputPreview ?? entry.errorMessage ?? entry.reason ?? ""].filter(Boolean).join(" ");
      const line = document.createElement("div");
      line.textContent = `${formatSchedulerDate(entry.firedAt)} ${outcome}${entry.durationMs ? ` ${Math.round(entry.durationMs / 100) / 10}s` : ""}：${description}`;
      history.appendChild(line);
    }
  }
  history.classList.remove("is-hidden");
}
