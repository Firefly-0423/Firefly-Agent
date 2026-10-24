import type { RunActivityRecord } from "../../../../../shared/chat-types";
import { t } from "../../../i18n";

export type RunActivitySnapshot = { processing: boolean; reasoningMs: number; processingMs: number };

export function resolveRunActivitySnapshot(activity: RunActivityRecord, now: number): RunActivitySnapshot {
  const stoppedAt = activity.completedAt;
  const end = stoppedAt ?? now;
  return {
    processingMs: Math.max(0, end - activity.startedAt),
    reasoningMs: Math.max(0, activity.reasoningMs + (activity.activeReasoningStartedAt ? end - activity.activeReasoningStartedAt : 0)),
    processing: stoppedAt === undefined,
  };
}

export function resolveRunActivityExpanded(expandedById: Readonly<Record<string, boolean>>, activityId: string, activity: RunActivityRecord): boolean {
  const preference = expandedById[activityId];
  return preference ?? (activity.completedAt === undefined || activity.keepExpanded === true);
}

export function shouldAutoCollapseRunActivity(wasProcessing: boolean, isProcessing: boolean, keepExpanded = false): boolean {
  if (!wasProcessing) return false;
  return !isProcessing && !keepExpanded;
}

export function formatElapsed(milliseconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  if (minutes > 0) return t("runActivity.elapsedMinutes", { minutes, seconds });
  return t("runActivity.elapsedSeconds", { seconds });
}
