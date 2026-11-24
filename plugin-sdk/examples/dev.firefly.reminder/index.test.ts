import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestHost, type TestHostManifest } from "../../src/testing/index";
import { createReminderPlugin, validateReminderInput } from "./index.mjs";

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, "firefly.plugin.json"), "utf8"),
) as TestHostManifest;

describe("dev.firefly.reminder example plugin", () => {
  it("proposes a daily callback schedule as pending_approval and generates reminder text only after approval and trigger", async () => {
    const generateMock = vi.fn(async () => ({
      text: "早安！记得喝一杯温水，开启元气满满的一天。",
      usage: { inputTokens: 20, outputTokens: 16 },
    }));
    const delivered: Array<{ taskId: string; text: string; topic: string }> = [];

    const host = createTestHost({
      manifest,
      mode: "work",
      level: "full",
      model: { generate: generateMock },
    });
    await host.activate(createReminderPlugin({ onDelivered: (entry) => delivered.push(entry) }));

    const proposed = await host.callTool("create_daily_reminder", {
      title: "喝水提醒",
      topic: "提醒用户喝一杯温水",
      timeOfDay: "09:30",
      timezone: "Asia/Shanghai",
    });

    expect(proposed.status).toBe("succeeded");
    if (proposed.status !== "succeeded") throw new Error("expected succeeded");
    const output = proposed.output as { taskId: string; status: string; requiresUserApproval: boolean };
    expect(output.status).toBe("pending_approval");
    expect(output.requiresUserApproval).toBe(true);
    expect(host.schedules.get(output.taskId)?.status).toBe("pending_approval");
    expect(host.schedules.get(output.taskId)?.action).toEqual({
      type: "callback",
      payload: { topic: "提醒用户喝一杯温水", timeOfDay: "09:30" },
    });

    // While pending_approval, model.generate must not have been called; even a stray trigger is ignored.
    await host.triggerSchedule(output.taskId, { topic: "提醒用户喝一杯温水" });
    expect(generateMock).not.toHaveBeenCalled();
    expect(host.calls.filter((call) => call.method === "model.generate")).toHaveLength(0);

    const listedBefore = await host.callTool("list_reminders", {});
    expect(listedBefore).toMatchObject({
      status: "succeeded",
      output: { total: 1, pendingApproval: 1, active: 0 },
    });

    // Once approved, triggering the schedule calls model.generate and delivers the reminder.
    expect(host.approveSchedule(output.taskId)).toBe(true);
    await host.triggerSchedule(output.taskId, { topic: "提醒用户喝一杯温水" });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0].prompt).toContain("提醒用户喝一杯温水");
    expect(delivered).toEqual([
      {
        taskId: output.taskId,
        text: "早安！记得喝一杯温水，开启元气满满的一天。",
        topic: "提醒用户喝一杯温水",
      },
    ]);
  });

  it("rejects invalid inputs and unapproved tool calls without calling schedules.propose or model.generate", async () => {
    const generateMock = vi.fn();
    const host = createTestHost({
      manifest,
      mode: "work",
      level: "per-action",
      approvalDecision: "reject",
      model: { generate: generateMock },
    });
    await host.activate(createReminderPlugin());

    const rejected = await host.callTool("create_daily_reminder", {
      title: "喝水提醒",
      topic: "喝水",
      timeOfDay: "09:00",
    });
    expect(rejected).toEqual({ status: "not_executed", reason: "ERR_REJECTED: Tool approval was rejected" });

    host.setLevel("full");
    expect(validateReminderInput({ title: "x", topic: "y", timeOfDay: "25:99" }).ok).toBe(false);
    const invalidTime = await host.callTool("create_daily_reminder", {
      title: "喝水提醒",
      topic: "喝水",
      timeOfDay: "25:99",
    });
    expect(invalidTime.status).toBe("not_executed");

    const invalidTz = await host.callTool("create_daily_reminder", {
      title: "喝水提醒",
      topic: "喝水",
      timeOfDay: "09:00",
      timezone: "Invalid/Nowhere",
    });
    expect(invalidTz.status).toBe("not_executed");
    expect(host.calls.filter((call) => call.method === "schedules.propose")).toHaveLength(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("does not call model.generate when trigger signal is cancelled or model.generate permission is revoked", async () => {
    const generateMock = vi.fn(async () => ({ text: "不应生成" }));
    const host = createTestHost({
      manifest,
      mode: "work",
      level: "full",
      model: { generate: generateMock },
    });
    await host.activate(createReminderPlugin());

    const proposed = await host.callTool("create_daily_reminder", {
      title: "休息提醒",
      topic: "站起来活动一下",
      timeOfDay: "15:00",
    });
    const taskId = (proposed as { status: "succeeded"; output: { taskId: string } }).output.taskId;
    host.approveSchedule(taskId);

    const abortController = new AbortController();
    abortController.abort("cancelled");
    await host.triggerSchedule(taskId, { topic: "站起来活动一下" }, abortController.signal);
    expect(generateMock).not.toHaveBeenCalled();

    host.revokePermission("model.generate");
    await host.triggerSchedule(taskId, { topic: "站起来活动一下" });
    expect(generateMock).not.toHaveBeenCalled();

    host.revokePermission("schedules");
    const deniedCreate = await host.callTool("create_daily_reminder", {
      title: "晚间提醒",
      topic: "准备休息",
      timeOfDay: "22:00",
    });
    expect(deniedCreate).toEqual({
      status: "failed",
      error: "缺少 schedules 权限，无法提议定时任务",
      retryable: false,
    });
    expect(host.calls.filter((call) => call.method === "model.generate")).toHaveLength(0);
  });
});
