import { createHash } from "node:crypto";
import type { PluginScheduledExecutionSpec } from "../../plugins/api";
import type { ScheduleConfig, ScheduledTask, ScheduledTaskPatch } from "./types";

// 指纹依赖这里的键序；只选执行所需字段。
function scheduleForDigest(plan: ScheduleConfig): Record<string, unknown> {
  if (plan.kind === "once") return { kind: "once", runAt: plan.runAt };
  if (plan.kind === "daily") return { kind: "daily", timeOfDay: plan.timeOfDay };
  if (plan.kind === "weekly") {
    return { kind: "weekly", dayOfWeek: plan.dayOfWeek, timeOfDay: plan.timeOfDay };
  }
  if (plan.kind === "interval") return { kind: "interval", every: plan.every, unit: plan.unit };
  return undefined as never;
}

export function computeExecutionSpecFingerprint(execution: PluginScheduledExecutionSpec): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify({
    schedule: scheduleForDigest(execution.schedule),
    prompt: execution.prompt,
    mode: execution.mode,
    allowedToolIds: Array.from(new Set(execution.allowedToolIds)).sort(),
  }), "utf8");
  return digest.digest("hex");
}

export function taskExecutionSpec(job: ScheduledTask): PluginScheduledExecutionSpec {
  return { schedule: job.schedule, prompt: job.prompt, mode: job.mode ?? "work", allowedToolIds: job.allowedToolIds };
}

export function isPluginTaskEffectivelyEnabled(job: ScheduledTask): boolean {
  if (!job.ownerPluginId || job.pluginUserEnabled !== true) return false;
  const approved = job.approvalFingerprint;
  return approved ? approved === computeExecutionSpecFingerprint(taskExecutionSpec(job)) : false;
}

export function isTaskEnabled(job: ScheduledTask): boolean {
  return job.ownerPluginId ? isPluginTaskEffectivelyEnabled(job) : job.enabled === true;
}

export function pluginTaskTogglePatch(job: ScheduledTask, enabled: boolean): ScheduledTaskPatch {
  return enabled
    ? { pluginUserEnabled: true, approvalFingerprint: computeExecutionSpecFingerprint(taskExecutionSpec(job)) }
    : { pluginUserEnabled: false };
}

export function authorizePluginTaskUpdatePatch(job: ScheduledTask, changes: ScheduledTaskPatch): ScheduledTaskPatch {
  const authorizedChanges = { ...changes };
  delete authorizedChanges.enabled;
  delete authorizedChanges.toolMode;
  if (authorizedChanges.pluginUserEnabled === true ||
      (authorizedChanges.pluginUserEnabled === undefined && isPluginTaskEffectivelyEnabled(job))) {
    const execution = taskExecutionSpec({
      ...job,
      schedule: authorizedChanges.schedule ?? job.schedule,
      prompt: authorizedChanges.prompt ?? job.prompt,
      mode: authorizedChanges.mode !== undefined ? authorizedChanges.mode : job.mode,
      allowedToolIds: authorizedChanges.allowedToolIds ?? job.allowedToolIds,
    });
    authorizedChanges.pluginUserEnabled = true;
    authorizedChanges.approvalFingerprint = computeExecutionSpecFingerprint(execution);
  }
  return authorizedChanges;
}
