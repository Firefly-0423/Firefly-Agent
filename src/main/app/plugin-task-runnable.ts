import type { ScheduledTask } from "../platform/schedule/schedule-types";

type LegacyHost = { isRunning(id: string): boolean };
type V2Host = { status(id: string): string };

/** A plugin-owned task can fire only while its plugin runs, in either the legacy or the v2 host. */
export function isPluginTaskRunnable(task: ScheduledTask, legacy: LegacyHost | undefined, v2: V2Host | undefined): boolean {
  const owner = task.ownerPluginId;
  if (!owner) return true;
  return (legacy?.isRunning(owner) ?? false) || v2?.status(owner) === "enabled";
}
