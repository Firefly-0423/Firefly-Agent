// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const schedulerNewBtn = control<HTMLButtonElement | null>("scheduler-new-btn");
export const schedulerEmpty = control<HTMLDivElement | null>("scheduler-empty");
export const schedulerList = control<HTMLDivElement | null>("scheduler-list");
export const schedulerEditor = control<HTMLDivElement | null>("scheduler-editor");
export const schedulerEditorTitle = control<HTMLHeadingElement | null>("scheduler-editor-title");
export const schedulerEditorClose = control<HTMLButtonElement | null>("scheduler-editor-close");
export const schedulerTitleInput = control<HTMLInputElement | null>("scheduler-title");
export const schedulerPromptInput = control<HTMLTextAreaElement | null>("scheduler-prompt");
export const schedulerEnabledInput = control<HTMLInputElement | null>("scheduler-enabled");
export const schedulerKindInput = control<HTMLSelectElement | null>("scheduler-kind");
export const schedulerOnceRunAtInput = control<HTMLInputElement | null>("scheduler-once-run-at");
export const schedulerTimeOfDayInput = control<HTMLInputElement | null>("scheduler-time-of-day");
export const schedulerDayOfWeekInput = control<HTMLSelectElement | null>("scheduler-day-of-week");
export const schedulerIntervalEveryInput = control<HTMLInputElement | null>("scheduler-interval-every");
export const schedulerIntervalUnitInput = control<HTMLSelectElement | null>("scheduler-interval-unit");
export const schedulerToolLimitInput = control<HTMLInputElement | null>("scheduler-tool-limit");
export const schedulerToolPicker = control<HTMLDivElement | null>("scheduler-tool-picker");
export const schedulerToolEmptyHint = control<HTMLDivElement | null>("scheduler-tool-empty-hint");
export const schedulerSaveStatus = control<HTMLDivElement | null>("scheduler-save-status");
export const schedulerCancelBtn = control<HTMLButtonElement | null>("scheduler-cancel-btn");
export const schedulerSaveBtn = control<HTMLButtonElement | null>("scheduler-save-btn");
