import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Switch } from "antd";
import { AlarmClock, CalendarCheck, CalendarClock, History, ListChecks, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { ScheduledTaskEditor } from "./ScheduledTaskEditor";
import {
  describeSchedule,
  describeTaskTools,
  fireNowErrorMessage,
  formatScheduledTime,
  type ScheduleDraft,
  type ScheduledTask,
  type ScheduledTaskHistoryEntry,
  type SchedulerApi,
  type SchedulerToolInfo,
  type Translate,
} from "./scheduled-task-model";
import { PanelEmpty, PanelPage, PanelPrimaryButton, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./ScheduledTaskPanel.css";

interface PluginEntryLike {
  id: string;
  status?: string;
}

type PluginListing = PluginEntryLike[] | { plugins?: PluginEntryLike[] };

/** preload 暴露的全局对象（定时任务 IPC、运行事件、插件列表）。 */
type ChatWindowWithScheduler = Window & {
  fireflyScheduler?: SchedulerApi;
  schedulerEvents?: { onEvent: (callback: (event: unknown) => void) => () => void };
  plugins?: { list?: () => Promise<unknown>; onChanged?: (callback: (overview: unknown) => void) => () => void };
};

interface HistoryState {
  loading: boolean;
  rows: ScheduledTaskHistoryEntry[];
  error?: string;
}

function getSchedulerApi(): SchedulerApi | undefined {
  return (window as ChatWindowWithScheduler).fireflyScheduler;
}

async function readPluginRunning(): Promise<Record<string, boolean>> {
  const plugins = (window as ChatWindowWithScheduler).plugins;
  // 插件状态只影响"等待插件启用"提示与立即运行按钮；查询失败按未知处理，不阻塞任务列表
  const listed = plugins?.list
    ? (await plugins.list().catch(() => undefined)) as PluginListing | undefined
    : undefined;
  const entries = Array.isArray(listed) ? listed : listed?.plugins ?? [];
  return Object.fromEntries(entries.map((plugin) => [plugin.id, plugin.status === "running"]));
}

/** 运行边界事件：任务触发、运行结束或失败时任务的 lastFiredAt / nextFireAt 会变化。 */
/** Which expanded histories a reload re-reads: all of them (focus, or an event that names no task), one task, or none. */
type HistoryScope = "all" | "none" | { taskId: string };

/** The task a scheduler event belongs to; absent when the event does not say. */
function eventTaskId(raw: unknown): string | undefined {
  const id = (raw as { schedulerTaskId?: unknown } | null)?.schedulerTaskId;
  return typeof id === "string" && id ? id : undefined;
}

function isRunBoundaryEvent(raw: unknown): boolean {
  const event = raw as { type?: string; name?: string } | null;
  if (!event) return false;
  return event.type === "RUN_FINISHED"
    || event.type === "RUN_ERROR"
    || (event.type === "CUSTOM" && event.name === "scheduler.started");
}

function pluginEnableMessage(task: ScheduledTask, t: Translate): string {
  const promptPreview = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
  return t("scheduledPanel.pluginEnableMessage", {
    plugin: task.ownerPluginId,
    schedule: describeSchedule(task.schedule, t),
    prompt: promptPreview,
    mode: task.mode ?? "work",
    tools: task.allowedToolIds.length ? task.allowedToolIds.join(", ") : t("scheduledPanel.noToolsModelOnly"),
  });
}

export function ScheduledTaskPanel() {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [tools, setTools] = useState<SchedulerToolInfo[]>([]);
  const [pluginRunning, setPluginRunning] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** null 表示列表视图；{} 为新建；{ task } 为编辑。 */
  const [editor, setEditor] = useState<{ task?: ScheduledTask; preset?: { title: string; prompt: string; schedule?: Partial<ScheduleDraft> } } | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | "enabled" | "disabled">("all");
  /** 存在键即表示该任务的历史已展开。 */
  const [histories, setHistories] = useState<Record<string, HistoryState>>({});
  const historiesRef = useRef(histories);
  historiesRef.current = histories;

  /** Re-reads one expanded history in place: the rows stay on screen while it loads, and a failure keeps them. */
  const refreshHistory = useCallback(async (taskId: string) => {
    try {
      const result = await getSchedulerApi()?.getHistory(taskId, 10);
      setHistories((current) => current[taskId] && result?.ok
        ? { ...current, [taskId]: { loading: false, rows: result.value ?? [] } }
        : current);
    } catch { /* an expanded list that cannot refresh keeps what it shows */ }
  }, []);

  const reload = useCallback(async (historyScope: HistoryScope = "none") => {
    try {
      const scheduler = getSchedulerApi();
      if (!scheduler) throw new Error(t("scheduledPanel.apiUnavailable"));
      const [tasksResult, toolsResult, running] = await Promise.all([
        scheduler.list(),
        scheduler.getTools(),
        readPluginRunning(),
      ]);
      if (!tasksResult.ok) throw new Error(tasksResult.error ?? t("scheduledPanel.loadFailed"));
      setTasks(tasksResult.value ?? []);
      if (toolsResult.ok) setTools(toolsResult.value ?? []);
      setPluginRunning(running);
      setLoadError(null);
      // Open histories must follow a run boundary or they keep showing a finished run as running. Each history read parses the whole
      // history file, so a run event refreshes only the task it names; focus (or an unnamed event) refreshes every open one.
      const open = Object.keys(historiesRef.current);
      const targets = historyScope === "all" ? open : historyScope === "none" ? [] : open.filter((id) => id === historyScope.taskId);
      void Promise.all(targets.map(refreshHistory));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("scheduledPanel.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t, refreshHistory]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 实时刷新：运行事件与窗口重新获得焦点时重新读取（设置窗口里的修改也会在这里生效）
  useEffect(() => {
    const refreshAll = () => void reload("all");
    const off = (window as ChatWindowWithScheduler).schedulerEvents?.onEvent((event) => {
      if (!isRunBoundaryEvent(event)) return;
      const taskId = eventTaskId(event);
      void reload(taskId ? { taskId } : "all");
    });
    window.addEventListener("focus", refreshAll);
    // A plugin can start or stop while the panel keeps focus; only the cached run state needs re-reading.
    const offPlugins = (window as ChatWindowWithScheduler).plugins?.onChanged?.(() => {
      void readPluginRunning().then(setPluginRunning).catch(() => undefined);
    });
    return () => {
      off?.();
      offPlugins?.();
      window.removeEventListener("focus", refreshAll);
    };
  }, [reload]);

  /** 统一的操作兜底：调用异常时以轻提示反馈，不让 Promise 悬挂。 */
  const attempt = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      feedback.notice({ tone: "error", message: err instanceof Error ? err.message : t("scheduledPanel.errors.actionFailed") });
    }
  }, [feedback, t]);

  const requireApi = (): SchedulerApi => {
    const scheduler = getSchedulerApi();
    if (!scheduler) throw new Error(t("scheduledPanel.apiUnavailable"));
    return scheduler;
  };

  const runNow = (task: ScheduledTask) => attempt(async () => {
    const result = await requireApi().fireNow(task.id);
    if (!result.ok) feedback.notice({ tone: "error", message: fireNowErrorMessage(result, t) });
  });

  const toggleTask = (task: ScheduledTask, enabled: boolean) => attempt(async () => {
    const scheduler = requireApi();
    // 启用插件任务前确认：启用即对该任务执行规格的一次明确授权
    if (enabled && task.ownerPluginId) {
      const confirmed = await feedback.confirm({
        tone: "warning",
        title: t("scheduledPanel.pluginEnableTitle"),
        message: pluginEnableMessage(task, t),
        confirmText: t("scheduledPanel.pluginEnableConfirm"),
      });
      if (!confirmed) return;
    }
    const result = await scheduler.toggle(task.id, enabled);
    if (!result.ok) feedback.notice({ tone: "error", message: result.error ?? t("scheduledPanel.errors.toggleFailed") });
    await reload();
  });

  const deleteTask = (task: ScheduledTask) => attempt(async () => {
    const scheduler = requireApi();
    // 删除不可撤销：危险确认，默认聚焦取消
    const confirmed = await feedback.confirm({
      title: t("scheduledPanel.deleteTitle"),
      message: t("scheduledPanel.deleteMessage"),
      confirmText: t("scheduledPanel.delete"),
      dangerous: true,
    });
    if (!confirmed) return;
    const result = await scheduler.delete(task.id);
    if (!result.ok) feedback.notice({ tone: "error", message: result.error ?? t("scheduledPanel.errors.deleteFailed") });
    setHistories((current) => withoutKey(current, task.id));
    await reload();
  });

  const toggleHistory = (task: ScheduledTask) => {
    if (histories[task.id]) {
      setHistories((current) => withoutKey(current, task.id));
      return;
    }
    setHistories((current) => ({ ...current, [task.id]: { loading: true, rows: [] } }));
    void (async () => {
      try {
        const result = await requireApi().getHistory(task.id, 10);
        setHistories((current) => current[task.id]
          ? {
            ...current,
            [task.id]: result.ok
              ? { loading: false, rows: result.value ?? [] }
              : { loading: false, rows: [], error: result.error ?? t("scheduledPanel.errors.historyFailed") },
          }
          : current);
      } catch (err) {
        setHistories((current) => current[task.id]
          ? { ...current, [task.id]: { loading: false, rows: [], error: err instanceof Error ? err.message : t("scheduledPanel.errors.historyFailed") } }
          : current);
      }
    })();
  };

  const shownTasks = tasks.filter(task => stateFilter === "all" || (stateFilter === "enabled") === task.enabled);

  return (
    <div className="scheduled-panel">
      <PanelSidebar
        title={t("scheduledPanel.title")}
        primary={<PanelPrimaryButton icon={<Plus size={15} strokeWidth={1.8} />} label={t("scheduledPanel.newTask")} onClick={() => setEditor({})} />}
      >
        <PanelSidebarSection>
          <PanelSidebarItem icon={<ListChecks size={15} strokeWidth={1.6} />} label={t("scheduledPanel.filterAll")} count={tasks.length}
            active={stateFilter === "all"} onClick={() => setStateFilter("all")} />
          <PanelSidebarItem icon={<CalendarCheck size={15} strokeWidth={1.6} />} label={t("scheduledPanel.badgeEnabled")} count={tasks.filter(task => task.enabled).length}
            active={stateFilter === "enabled"} onClick={() => setStateFilter("enabled")} />
          <PanelSidebarItem icon={<AlarmClock size={15} strokeWidth={1.6} />} label={t("scheduledPanel.badgeDisabled")} count={tasks.filter(task => !task.enabled).length}
            active={stateFilter === "disabled"} onClick={() => setStateFilter("disabled")} />
        </PanelSidebarSection>
        {shownTasks.length > 0 && (
          <PanelSidebarSection title={t("scheduledPanel.listSection")}>
            {shownTasks.map(task => (
              <PanelSidebarItem key={task.id} label={task.title} dot={task.enabled ? "on" : "off"}
                onClick={() => { setEditor(null); requestAnimationFrame(() => document.getElementById(`scheduled-task-${task.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }} />
            ))}
          </PanelSidebarSection>
        )}
      </PanelSidebar>
      <PanelPage className="scheduled-panel__page" title={t("scheduledPanel.title")} subtitle={<span className="scheduled-panel__subtitle">{t("scheduledPanel.subtitle")}</span>}>

      {editor ? (
        <ScheduledTaskEditor
          key={editor.task?.id ?? (editor.preset?.title ?? "new")}
          task={editor.task}
          preset={editor.preset}
          api={getSchedulerApi()}
          tools={tools}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void reload();
          }}
        />
      ) : (
        <>
          {tasks.length > 0 && <p className="scheduled-panel__hint">{t("scheduledPanel.listHint")}</p>}

          {loadError && <div role="alert" className="scheduled-state is-error">{loadError}</div>}
          {loading ? (
            <div className="scheduled-state">{t("common.loading")}</div>
          ) : tasks.length === 0 && !loadError ? (
            <PanelEmpty
              icon={<CalendarClock size={24} strokeWidth={1.5} />}
              title={t("scheduledPanel.emptyTitle")}
              hint={t("scheduledPanel.empty")}
              suggestions={SUGGESTIONS.map(card => ({
                icon: card.icon,
                title: t(`scheduledPanel.suggestions.${card.key}.title`),
                description: t(`scheduledPanel.suggestions.${card.key}.description`),
                onClick: () => setEditor({ preset: { title: t(`scheduledPanel.suggestions.${card.key}.title`), prompt: t(`scheduledPanel.suggestions.${card.key}.prompt`), schedule: card.schedule } }),
              }))}
            />
          ) : (
            <div className="scheduled-list">
              {shownTasks.map((task) => (
                <ScheduledTaskCard
                  key={task.id}
                  task={task}
                  pluginRunning={task.ownerPluginId ? pluginRunning[task.ownerPluginId] === true : true}
                  history={histories[task.id]}
                  onRun={() => void runNow(task)}
                  onEdit={() => setEditor({ task })}
                  onToggle={(enabled) => void toggleTask(task, enabled)}
                  onHistory={() => toggleHistory(task)}
                  onDelete={() => void deleteTask(task)}
                />
              ))}
            </div>
          )}
        </>
      )}
      </PanelPage>
    </div>
  );
}

/** First-run suggestions: each opens the editor with a starting title and prompt; nothing is saved until the user does. */
const SUGGESTIONS: Array<{ key: string; icon: ReactNode; schedule: Partial<ScheduleDraft> }> = [
  { key: "daily", icon: <CalendarClock size={16} strokeWidth={1.6} />, schedule: { kind: "daily", timeOfDay: "18:00" } },
  { key: "weekly", icon: <CalendarCheck size={16} strokeWidth={1.6} />, schedule: { kind: "weekly", dayOfWeek: 1, timeOfDay: "09:00" } },
  { key: "todos", icon: <ListChecks size={16} strokeWidth={1.6} />, schedule: { kind: "daily", timeOfDay: "09:00" } },
];

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

interface ScheduledTaskCardProps {
  task: ScheduledTask;
  /** 非插件任务恒为 true；插件任务按插件运行状态。 */
  pluginRunning: boolean;
  history?: HistoryState;
  onRun: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onHistory: () => void;
  onDelete: () => void;
}

function ScheduledTaskCard({ task, pluginRunning, history, onRun, onEdit, onToggle, onHistory, onDelete }: ScheduledTaskCardProps) {
  const { t } = useTranslation();
  const pluginOwned = Boolean(task.ownerPluginId);
  const pluginWaiting = pluginOwned && !pluginRunning;
  const metaItems = [
    pluginOwned ? t("scheduledPanel.createdByPlugin", { plugin: task.ownerPluginId }) : null,
    describeSchedule(task.schedule, t),
    t("scheduledPanel.nextRun", { time: formatScheduledTime(task.nextFireAt, t) }),
    task.lastFiredAt ? t("scheduledPanel.lastRun", { time: formatScheduledTime(task.lastFiredAt, t) }) : null,
    t("scheduledPanel.mode", { mode: task.mode ?? "work" }),
    t("scheduledPanel.tools", { tools: describeTaskTools(task, t) }),
    pluginWaiting ? t("scheduledPanel.waitingPlugin") : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <article id={`scheduled-task-${task.id}`} className={`scheduled-card ${task.enabled ? "" : "is-disabled"}`}>
      <div className="scheduled-card__head">
        <h2 className="scheduled-card__name">{task.title}</h2>
        <span className={`scheduled-card__badge ${task.enabled ? "is-on" : ""}`}>
          {task.enabled ? t("scheduledPanel.badgeEnabled") : t("scheduledPanel.badgeDisabled")}
        </span>
        <Switch size="small" checked={task.enabled} onChange={(checked) => onToggle(checked)}
          aria-label={task.enabled ? t("scheduledPanel.disable") : t("scheduledPanel.enable")} />
      </div>
      <ul className="scheduled-card__meta">
        {metaItems.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
      <div className="scheduled-card__actions">
        <button type="button" className="scheduled-btn" onClick={onRun} disabled={!pluginRunning}
          title={pluginRunning ? undefined : t("scheduledPanel.errors.pluginNotRunning")}>
          <Play size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("scheduledPanel.runNow")}</span>
        </button>
        <button type="button" className="scheduled-btn" onClick={onEdit}>
          <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("scheduledPanel.edit")}</span>
        </button>
        <button type="button" className="scheduled-btn" onClick={onHistory} aria-expanded={Boolean(history)}>
          <History size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("scheduledPanel.history")}</span>
        </button>
        <button type="button" className="scheduled-btn is-danger" onClick={onDelete}>
          <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("scheduledPanel.delete")}</span>
        </button>
      </div>
      {history && <ScheduledHistory history={history} />}
    </article>
  );
}

function ScheduledHistory({ history }: { history: HistoryState }) {
  const { t } = useTranslation();
  if (history.loading) return <div className="scheduled-card__history">{t("common.loading")}</div>;
  if (history.error) return <div className="scheduled-card__history is-error" role="alert">{history.error}</div>;
  if (history.rows.length === 0) return <div className="scheduled-card__history">{t("scheduledPanel.historyEmpty")}</div>;
  return (
    <ul className="scheduled-card__history" aria-label={t("scheduledPanel.history")}>
      {history.rows.map((row) => {
        const duration = row.durationMs ? ` · ${Math.round(row.durationMs / 100) / 10}s` : "";
        const warning = row.status === "interrupted" || row.externalEffectsMayContinue
          ? t("scheduledPanel.historyEffectsUnknown") : "";
        const detail = [warning, row.outputPreview ?? row.errorMessage ?? row.reason ?? ""].filter(Boolean).join(" ");
        return (
          <li key={row.id} className="scheduled-card__history-row">
            <span>{formatScheduledTime(row.firedAt, t)}</span>
            <span className={`scheduled-card__history-status is-${row.status}`}>{t(`scheduledPanel.historyStatus.${row.status}`)}{duration}</span>
            {detail && <span className="scheduled-card__history-detail">{detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}
