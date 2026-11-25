/**
 * @file Firefly 1.2.0 SDK example: dev.firefly.reminder
 * Demonstrates `ctx.schedules.propose` (returning `pending_approval`), `ctx.schedules.list`,
 * and `ctx.schedules.onTrigger` generating and showing a notification when approved and not cancelled.
 */

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate arguments for `create_daily_reminder`.
 * @param {unknown} raw
 * @returns {{ ok: true; title: string; topic: string; expression: string; timeOfDay: string; timezone?: string } | { ok: false; reason: string }}
 */
export function validateReminderInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "参数必须是对象" };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const topic = typeof record.topic === "string" ? record.topic.trim() : "";
  const timeOfDay = typeof record.timeOfDay === "string" ? record.timeOfDay.trim() : "";
  const timezone = typeof record.timezone === "string" ? record.timezone.trim() : undefined;

  if (!title || title.length > 100) {
    return { ok: false, reason: "title 必须为 1–100 个字符的非空文本" };
  }
  if (!topic || topic.length > 500) {
    return { ok: false, reason: "topic 必须为 1–500 个字符的非空文本" };
  }
  const match = TIME_OF_DAY_RE.exec(timeOfDay);
  if (!match) {
    return { ok: false, reason: "timeOfDay 必须为 24 小时制 HH:mm 格式（例如 09:00）" };
  }
  if (record.timezone !== undefined) {
    if (!timezone || !isValidTimeZone(timezone)) {
      return { ok: false, reason: "timezone 不是有效的 IANA 时区名" };
    }
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return {
    ok: true,
    title,
    topic,
    timeOfDay,
    expression: `${minute} ${hour} * * *`,
    ...(timezone ? { timezone } : {}),
  };
}

/**
 * Create the daily reminder plugin instance.
 * @param {{ onDelivered?: (entry: { taskId: string; text: string; topic: string }) => void }} [options]
 * @returns {import("@firefly_wu/plugin-sdk").PluginDefinition}
 */
export function createReminderPlugin(options = {}) {
  /** @type {Array<{ dispose(): void }>} */
  const disposables = [];
  /** @type {Array<{ taskId: string; text: string; topic: string }>} */
  const deliveries = [];

  return {
    activate(ctx) {
      const createDisp = ctx.tools.register({
        name: "create_daily_reminder",
        description: "提议一个每日重复的回调提醒任务。提交后状态为 pending_approval，需用户在任务面板确认后生效。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "提醒标题", minLength: 1, maxLength: 100 },
            topic: { type: "string", description: "提醒主题或内容要点", minLength: 1, maxLength: 500 },
            timeOfDay: { type: "string", description: "每日触发时间，格式 HH:mm" },
            timezone: { type: "string", description: "可选 IANA 时区名，例如 Asia/Shanghai" },
          },
          required: ["title", "topic", "timeOfDay"],
          additionalProperties: false,
        },
        describeApproval(args) {
          const title = typeof args?.title === "string" ? args.title.trim() : "";
          const time = typeof args?.timeOfDay === "string" ? args.timeOfDay.trim() : "";
          return {
            summary: title ? `提议每日提醒「${title}」` : "提议每日定时提醒",
            target: time || undefined,
          };
        },
        async execute(args, call) {
          const check = validateReminderInput(args);
          if (!check.ok) {
            return { status: "not_executed", reason: check.reason };
          }
          if (call.signal.aborted) {
            return { status: "not_executed", reason: "创建提醒已在执行前取消" };
          }
          if (!ctx.has("schedules")) {
            return { status: "failed", error: "缺少 schedules 权限，无法提议定时任务", retryable: false };
          }

          const schedule = check.timezone
            ? { kind: "cron", expression: check.expression, timezone: check.timezone }
            : { kind: "cron", expression: check.expression };

          try {
            const proposed = await ctx.schedules.propose({
              title: check.title,
              schedule,
              action: {
                type: "callback",
                payload: { topic: check.topic, timeOfDay: check.timeOfDay },
              },
            });
            return {
              status: "succeeded",
              output: {
                taskId: proposed.taskId,
                status: proposed.status,
                requiresUserApproval: proposed.status === "pending_approval",
                schedule,
                message: `已提议每日提醒「${check.title}」（${check.timeOfDay}），当前状态为 ${proposed.status}，请用户在任务面板确认启用。`,
              },
              summary: `已提议每日提醒「${check.title}」（等待用户确认）`,
            };
          } catch (error) {
            return {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
          }
        },
      });
      disposables.push(createDisp);

      const listDisp = ctx.tools.register({
        name: "list_reminders",
        description: "查看本插件已提议或已启用的提醒任务及其审批状态。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_args, call) {
          if (call.signal.aborted) {
            return { status: "not_executed", reason: "查看提醒已取消" };
          }
          if (!ctx.has("schedules")) {
            return { status: "failed", error: "缺少 schedules 权限，无法读取任务列表", retryable: false };
          }
          const tasks = await ctx.schedules.list();
          return {
            status: "succeeded",
            output: {
              total: tasks.length,
              pendingApproval: tasks.filter((t) => t.status === "pending_approval").length,
              active: tasks.filter((t) => t.status === "active").length,
              tasks,
              deliveries: [...deliveries],
            },
            summary: `共 ${tasks.length} 个提醒任务`,
          };
        },
      });
      disposables.push(listDisp);

      if (ctx.has("schedules")) {
        const triggerDisp = ctx.schedules.onTrigger(async (event) => {
          if (event.signal.aborted) return;
          if (!ctx.has("schedules") || !ctx.has("model.generate") || !ctx.has("notifications")) return;

          // Defense-in-depth: never generate a reminder if the task is still pending_approval.
          const tasks = await ctx.schedules.list();
          const task = tasks.find((t) => t.taskId === event.taskId);
          if (!task || task.status !== "active") {
            return;
          }
          if (event.signal.aborted) return;

          const payload = event.payload && typeof event.payload === "object"
            ? /** @type {{ topic?: unknown }} */ (event.payload)
            : {};
          const topic = typeof payload.topic === "string" && payload.topic.trim()
            ? payload.topic.trim()
            : (task?.title ?? "日常提醒");

          const generated = await ctx.model.generate({
            prompt: `请用一句温和简短的中文写一条每日提醒，主题：${topic}`,
            system: "你是流萤的提醒助手，只输出一句可直接展示的提醒文字，不要附加多余解释。",
            maxOutputTokens: 120,
            signal: event.signal,
          });
          if (event.signal.aborted) return;

          try {
            const notification = await ctx.notifications.show({
              title: [...task.title].slice(0, 64).join(""),
              body: [...generated.text.trim()].slice(0, 256).join(""),
            });
            if (!notification.shown) return;
          } catch (error) {
            // Permission can be revoked while the model is generating; skip that reminder quietly.
            if (error?.code === "ERR_PERMISSION" || error?.code === "ERR_UNDECLARED") return;
            throw error;
          }

          const record = { taskId: event.taskId, text: generated.text.trim(), topic };
          deliveries.push(record);
          options.onDelivered?.(record);
        });
        disposables.push(triggerDisp);
      }
    },

    deactivate() {
      while (disposables.length > 0) {
        disposables.pop()?.dispose();
      }
    },
  };
}

export default createReminderPlugin();
