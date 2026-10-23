import { useId, useState } from "react";
import { Switch } from "antd";
import { X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import {
  SCHEDULE_KINDS,
  WEEK_DAY_KEYS,
  WEEK_DAY_ORDER,
  buildScheduleConfig,
  defaultScheduleDraft,
  scheduleDraftFromSchedule,
  type ScheduleDraft,
  type ScheduledTask,
  type SchedulerApi,
  type SchedulerToolInfo,
} from "./scheduled-task-model";
import "./ScheduledTaskPanel.css";

export interface ScheduledTaskEditorProps {
  /** 缺省表示新建。 */
  task?: ScheduledTask;
  /** A new task starts from this title and prompt (the suggestion cards on the empty page). */
  preset?: { title: string; prompt: string; schedule?: Partial<ScheduleDraft> };
  api: SchedulerApi | undefined;
  tools: SchedulerToolInfo[];
  onCancel: () => void;
  onSaved: () => void;
}

/**
 * 定时任务编辑器：字段、校验与保存口径与设置窗口的定时任务页一致。
 * 插件创建的任务：工具白名单开关锁定为开启，启用开关写入 pluginUserEnabled。
 */
export function ScheduledTaskEditor({ task, preset, api, tools, onCancel, onSaved }: ScheduledTaskEditorProps) {
  const { t } = useTranslation();
  const formId = useId();
  const isPlugin = Boolean(task?.ownerPluginId);
  const [title, setTitle] = useState(task?.title ?? preset?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? preset?.prompt ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [draft, setDraft] = useState<ScheduleDraft>(() => (task ? scheduleDraftFromSchedule(task.schedule) : { ...defaultScheduleDraft(), ...preset?.schedule }));
  const [toolLimit, setToolLimit] = useState(isPlugin || task?.toolMode === "allow-list");
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>(task?.allowedToolIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateDraft = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  // 与设置页一致：保存时只收集工具清单中仍存在的已选项
  const allowedToolIds = tools.filter((tool) => selectedToolIds.includes(tool.id)).map((tool) => tool.id);
  const hasDisabledSelection = tools.some((tool) => !tool.enabled && selectedToolIds.includes(tool.id));

  const toggleTool = (id: string, checked: boolean) => {
    setSelectedToolIds((current) => checked
      ? [...current.filter((item) => item !== id), id]
      : current.filter((item) => item !== id));
  };

  const save = async () => {
    if (!api) {
      setError(t("scheduledPanel.apiUnavailable"));
      return;
    }
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedTitle) {
      setError(t("scheduledPanel.errors.titleRequired"));
      return;
    }
    if (!trimmedPrompt) {
      setError(t("scheduledPanel.errors.promptRequired"));
      return;
    }
    const built = buildScheduleConfig(draft, Date.now());
    if (!built.ok) {
      setError(t(built.errorKey));
      return;
    }
    const input = {
      title: trimmedTitle,
      prompt: trimmedPrompt,
      // 插件任务没有 enabled：编辑器里的启用开关是用户授权，由主进程按新规格写入指纹
      ...(isPlugin ? { pluginUserEnabled: enabled } : { enabled }),
      schedule: built.schedule,
      toolMode: isPlugin || toolLimit ? "allow-list" : "all-enabled",
      allowedToolIds,
    };
    setSaving(true);
    setError(null);
    try {
      const result = task ? await api.update(task.id, input) : await api.add(input);
      if (!result.ok) {
        setError(result.error ?? t("scheduledPanel.errors.saveFailed"));
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("scheduledPanel.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="scheduled-editor" aria-labelledby={`${formId}-title`}>
      <header className="scheduled-editor__header">
        <h2 id={`${formId}-title`} className="scheduled-editor__title">
          {task ? t("scheduledPanel.editorEdit") : t("scheduledPanel.editorNew")}
        </h2>
        <button type="button" className="scheduled-icon-btn" onClick={onCancel}
          aria-label={t("scheduledPanel.close")} title={t("scheduledPanel.close")}>
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <form className="scheduled-editor__form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="scheduled-field">
          <span className="scheduled-field__label">{t("scheduledPanel.fieldTitle")}</span>
          <input type="text" value={title} placeholder={t("scheduledPanel.fieldTitlePlaceholder")}
            onChange={(event) => setTitle(event.target.value)} />
        </label>

        <label className="scheduled-field">
          <span className="scheduled-field__label">{t("scheduledPanel.fieldPrompt")}</span>
          <textarea rows={5} value={prompt} placeholder={t("scheduledPanel.fieldPromptPlaceholder")}
            onChange={(event) => setPrompt(event.target.value)} />
        </label>

        <div className="scheduled-switch-row">
          <div className="scheduled-switch-row__copy">
            <strong>{t("scheduledPanel.enabledTitle")}</strong>
            <span>{t("scheduledPanel.enabledDesc")}</span>
          </div>
          <Switch checked={enabled} onChange={setEnabled} aria-label={t("scheduledPanel.enabledTitle")} />
        </div>

        <fieldset className="scheduled-kind">
          <legend className="scheduled-field__label">{t("scheduledPanel.fieldKind")}</legend>
          {/* 原生单选组：后续替换为滑动胶囊分段控件时只需替换这一块。 */}
          <div className="scheduled-kind__options">
            {SCHEDULE_KINDS.map((kind) => (
              <label key={kind} className={`scheduled-kind__option ${draft.kind === kind ? "is-selected" : ""}`}>
                <input type="radio" name={`${formId}-kind`} value={kind} checked={draft.kind === kind}
                  onChange={() => updateDraft({ kind })} />
                <span>{t(`scheduledPanel.kinds.${kind}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="scheduled-form-grid">
          {draft.kind === "once" && (
            <label className="scheduled-field">
              <span className="scheduled-field__label">{t("scheduledPanel.fieldRunAt")}</span>
              <input type="datetime-local" value={draft.runAt} onChange={(event) => updateDraft({ runAt: event.target.value })} />
            </label>
          )}
          {(draft.kind === "daily" || draft.kind === "weekly") && (
            <label className="scheduled-field">
              <span className="scheduled-field__label">{t("scheduledPanel.fieldTimeOfDay")}</span>
              <input type="time" value={draft.timeOfDay} onChange={(event) => updateDraft({ timeOfDay: event.target.value })} />
            </label>
          )}
          {draft.kind === "weekly" && (
            <label className="scheduled-field">
              <span className="scheduled-field__label">{t("scheduledPanel.fieldDayOfWeek")}</span>
              <select value={String(draft.dayOfWeek)} onChange={(event) => updateDraft({ dayOfWeek: Number(event.target.value) })}>
                {WEEK_DAY_ORDER.map((day) => (
                  <option key={day} value={String(day)}>{t(`scheduledPanel.days.${WEEK_DAY_KEYS[day]}`)}</option>
                ))}
              </select>
            </label>
          )}
          {draft.kind === "interval" && (
            <>
              <label className="scheduled-field">
                <span className="scheduled-field__label">{t("scheduledPanel.fieldIntervalEvery")}</span>
                <input type="number" min={1} value={draft.every} onChange={(event) => updateDraft({ every: event.target.value })} />
              </label>
              <label className="scheduled-field">
                <span className="scheduled-field__label">{t("scheduledPanel.fieldIntervalUnit")}</span>
                <select value={draft.unit} onChange={(event) => updateDraft({ unit: event.target.value === "hours" ? "hours" : "minutes" })}>
                  <option value="minutes">{t("scheduledPanel.units.minutes")}</option>
                  <option value="hours">{t("scheduledPanel.units.hours")}</option>
                </select>
              </label>
            </>
          )}
        </div>

        <div className="scheduled-switch-row">
          <div className="scheduled-switch-row__copy">
            <strong>{t("scheduledPanel.toolLimitTitle")}</strong>
            <span>{t("scheduledPanel.toolLimitDesc")}</span>
          </div>
          <Switch checked={toolLimit} disabled={isPlugin} onChange={setToolLimit} aria-label={t("scheduledPanel.toolLimitTitle")} />
        </div>

        {toolLimit && (
          <div className="scheduled-tools" role="group" aria-label={t("scheduledPanel.toolLimitTitle")}>
            {tools.length === 0 && <div className="scheduled-hint">{t("scheduledPanel.noToolsAvailable")}</div>}
            {tools.map((tool) => (
              <label key={tool.id} className="scheduled-tool">
                <input type="checkbox" checked={selectedToolIds.includes(tool.id)}
                  onChange={(event) => toggleTool(tool.id, event.target.checked)} />
                <span className="scheduled-tool__text">{`${tool.name} (${tool.id}) · ${tool.risk}`}</span>
                {!tool.enabled && <span className="scheduled-tool__tag">{t("scheduledPanel.toolDisabledGlobally")}</span>}
              </label>
            ))}
            {allowedToolIds.length === 0 && <div className="scheduled-hint">{t("scheduledPanel.toolEmptyHint")}</div>}
            {hasDisabledSelection && <div className="scheduled-hint">{t("scheduledPanel.toolDisabledHint")}</div>}
          </div>
        )}

        <div className="scheduled-editor__footer">
          {error
            ? <div role="alert" className="scheduled-status is-error">{error}</div>
            : <div role="status" className="scheduled-status">{saving ? t("scheduledPanel.saving") : t("scheduledPanel.saveIdle")}</div>}
          <button type="button" className="scheduled-btn" onClick={onCancel}>{t("scheduledPanel.cancel")}</button>
          <button type="submit" className="scheduled-btn is-primary" disabled={saving}>{t("scheduledPanel.save")}</button>
        </div>
      </form>
    </section>
  );
}
