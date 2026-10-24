/**
 * scheduled-automation 示例：演示插件如何管理自己的定时任务，以及宿主对此的所有权约束。
 *
 * 要点：
 * - manifest 声明 scheduler 依赖后，通过 ctx.deps.scheduler 创建、查询、修改、删除任务
 * - 宿主保证：插件创建的任务一律以停用状态落盘，只有用户在宿主界面才能启用；
 *   所以这里不提供"启用"入口，也不会请求"全部工具"模式
 * - 改动执行规格（计划、提示词、模式、工具白名单）会撤销用户已给的授权；
 *   只改标题不影响授权
 * - 用 storage 记下自己创建的任务 id，用来核对 listTasks 的返回
 */
import type { FireflyPlugin, PluginDeps, PluginTool } from "@firefly/plugin-sdk";

const TIME_OF_DAY = /^\d{2}:\d{2}$/;

let deps: PluginDeps = {};
/** 本插件创建的任务 id。 */
let ownedIds: string[] = [];

/** 读取 args 中的字符串字段，缺省时按空串处理。 */
function textArg(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? "");
}

const dailyAt = (timeOfDay: string) => ({ kind: "daily" as const, timeOfDay });

/** 这四个工具共用同一套外壳：启用、safe 风险，只在读写性质和 schema 上不同。 */
function schedulerTool(
  suffix: string,
  name: string,
  description: string,
  effectKind: "read" | "mutation",
  schema: { fields: PluginTool["inputSchema"]["properties"]; required?: string[] },
  execute: PluginTool["execute"],
): PluginTool {
  const inputSchema: PluginTool["inputSchema"] = { type: "object", properties: schema.fields };
  if (schema.required) inputSchema.required = schema.required;
  return {
    execute,
    inputSchema,
    effectKind,
    description,
    name,
    id: `scheduled-automation_${suffix}`,
    risk: "safe",
    enabled: true,
  };
}

/** 仅允许操作自己创建的任务；不是自己的返回 false。 */
const isOwned = (taskId: string): boolean => ownedIds.includes(taskId);

const createTool = schedulerTool(
  "create",
  "创建定时任务",
  "创建一个每日定时提醒任务。参数 title 为任务标题，prompt 为要执行的内容，timeOfDay 为每日触发时间（HH:mm）。创建后任务处于停用状态，需用户在宿主的定时任务面板中手动启用。",
  "mutation",
  {
    required: ["title", "prompt", "timeOfDay"],
    fields: {
      timeOfDay: { type: "string", description: "每日触发时间，格式 HH:mm" },
      title: { type: "string", description: "任务标题" },
      prompt: { type: "string", description: "任务执行内容（提示词）" },
    },
  },
  async (args) => {
    const title = textArg(args, "title").trim();
    const prompt = textArg(args, "prompt").trim();
    const timeOfDay = textArg(args, "timeOfDay").trim();
    const valid = title !== "" && prompt !== "" && TIME_OF_DAY.test(timeOfDay);
    if (!valid) return "参数不合法：title/prompt 必填，timeOfDay 须为 HH:mm 格式";

    const created = await deps.scheduler!.createTask({
      title,
      prompt,
      schedule: dailyAt(timeOfDay),
      mode: "chat",
      // 插件任务必须给出显式白名单，空数组表示不授予任何工具
      allowedToolIds: [],
    });
    ownedIds.push(created.id);
    return `已创建任务「${created.title}」（${timeOfDay}，当前停用）。请在宿主的定时任务面板确认启用。`;
  },
);

const listTool = schedulerTool(
  "list",
  "列出定时任务",
  "列出本插件创建的全部定时任务及其启用状态与下次触发时间。",
  "read",
  { fields: {} },
  async () => {
    const tasks = await deps.scheduler!.listTasks();
    if (!tasks.length) return "尚无任务";
    const rows = tasks.map((task) => {
      const state = task.enabled ? "已启用" : "停用";
      return `${task.title} [${state}] 下次触发: ${task.nextFireAt ?? "无"}`;
    });
    return rows.join("\n");
  },
);

const updateTool = schedulerTool(
  "update",
  "更新定时任务",
  "更新自己创建的定时任务。参数 taskId 必填；title 只改展示名不影响授权，修改 prompt/timeOfDay 会撤销用户授权并回到停用。",
  "mutation",
  {
    required: ["taskId"],
    fields: {
      taskId: { type: "string", description: "任务 id" },
      timeOfDay: { type: "string", description: "新触发时间 HH:mm（可选，会撤销授权）" },
      title: { type: "string", description: "新标题（可选）" },
      prompt: { type: "string", description: "新提示词（可选，会撤销授权）" },
    },
  },
  async (args) => {
    const taskId = textArg(args, "taskId");
    if (!isOwned(taskId)) return "只能更新本插件创建的任务";

    // 只把调用方显式给出的字段放进补丁
    const changes: Record<string, unknown> = {};
    if (args.title !== undefined) changes.title = textArg(args, "title");
    if (args.prompt !== undefined) changes.prompt = textArg(args, "prompt");
    if (args.timeOfDay !== undefined) changes.schedule = dailyAt(textArg(args, "timeOfDay"));
    if (!Object.keys(changes).length) return "未提供任何要更新的字段";

    const updated = await deps.scheduler!.updateTask(taskId, changes as never);
    return `已更新「${updated.title}」；当前状态: ${updated.enabled ? "已启用" : "停用"}。`;
  },
);

const deleteTool = schedulerTool(
  "delete",
  "删除定时任务",
  "删除自己创建的定时任务。参数 taskId 必填。",
  "mutation",
  { fields: { taskId: { type: "string", description: "任务 id" } }, required: ["taskId"] },
  async (args) => {
    const taskId = textArg(args, "taskId");
    if (!isOwned(taskId)) return "只能删除本插件创建的任务";

    if (!(await deps.scheduler!.deleteTask(taskId))) return "删除失败";
    ownedIds = ownedIds.filter((id) => id !== taskId);
    return "已删除";
  },
);

const plugin: FireflyPlugin = {
  async register(ctx) {
    deps = ctx.deps;
    ownedIds = ctx.storage.get<string[]>("ownTaskIds") ?? [];
    ctx.onDispose(() => ctx.storage.set("ownTaskIds", ownedIds));

    [createTool, listTool, updateTool, deleteTool].forEach((tool) => ctx.registerTool(tool));
  },
  unregister() {
    ownedIds = [];
  },
};

export = plugin;
