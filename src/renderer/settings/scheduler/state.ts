import type { ScheduledTask, SchedulerToolInfo } from "./types";

// 编辑器与任务列表共用最近一次加载的状态。
interface SchedulerPanelState {
  tasks: ScheduledTask[];
  tools: SchedulerToolInfo[];
  editingTaskId: string | null;
  pluginRunning: Record<string, boolean>;
}

export const schedulerState: SchedulerPanelState = {
  tasks: [], tools: [], editingTaskId: null,
  // 未记录的插件按尚未运行处理。
  pluginRunning: {},
};
