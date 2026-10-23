import { useRef, useEffect } from "react";
import type { ChatMessage } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";

type SchedulerStreamEvent = {
  threadId?: string; runId?: string; schedulerTaskId?: string; schedulerRunId?: string;
  toolCallDisplayName?: string; toolCallName?: string; toolCallId?: string; status?: string;
  content?: string; error?: string; message?: string; delta?: string; value?: unknown; name?: string; type?: string;
};
type SchedulerStartedValue = { runId?: string; firedAt?: string; manual?: boolean; title?: string; taskId?: string };
type SchedulerStreamState = { tools: ChatMessageItem["toolExecutions"]; content: string; replyId: string; sessionId: string | null };
export type UseSchedulerEventsDeps = {
  persistMessage?: (sessionId: string, message: ChatMessage) => void;
  patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessageItem>) => void;
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
  getActiveSessionId: () => string | undefined;
};
type SchedulerEventApi = { onEvent: (callback: (event: unknown) => void) => () => void };

function schedulerEventsApi(): SchedulerEventApi | undefined {
  return (window as typeof window & { schedulerEvents?: SchedulerEventApi }).schedulerEvents;
}
function startedValue(envelope: SchedulerStreamEvent): SchedulerStartedValue | null {
  const fields = envelope.value;
  return fields === null || typeof fields !== "object" || Array.isArray(fields) ? null : fields as SchedulerStartedValue;
}
function runKeyOf(envelope: SchedulerStreamEvent): string {
  return envelope.schedulerRunId ?? envelope.runId ?? envelope.threadId ?? "scheduler-default";
}

export function useSchedulerEvents(deps: UseSchedulerEventsDeps): void {
  const latest = useRef(deps);
  latest.current = deps;
  const runs = useRef(new Map<string, SchedulerStreamState>());
  useEffect(() => {
    const bridge = schedulerEventsApi();
    if (!bridge) return;
    function finishStream(run: SchedulerStreamState, text: string): void {
      if (!run.sessionId) return;
      const owner = run.sessionId;
      const reply = run.replyId;
      latest.current.patchMessage(owner, reply, {
        content: text, loading: false, streaming: false, waitingForFirstEvent: false, responseStarted: true,
      });
      latest.current.persistMessage?.(owner, {
        id: reply, role: "model", content: text, toolExecutions: run.tools?.length ? run.tools : undefined, at: Date.now(),
      });
    }
    return bridge.onEvent((raw) => {
      const envelope = raw as SchedulerStreamEvent;
      if (envelope.type === "CUSTOM" && envelope.name === "scheduler.started") {
        const fields = startedValue(envelope);
        const key = envelope.schedulerRunId ?? fields?.runId ?? "scheduler-" + Date.now();
        if (runs.current.has(key)) return;
        const owner = latest.current.getActiveSessionId() ?? null;
        const reply = "scheduler-reply-" + key;
        const notice = "scheduler-notice-" + key;
        const titleText = fields?.title ?? "未命名任务";
        runs.current.set(key, { sessionId: owner, replyId: reply, content: "", tools: [] });
        if (!owner) return;
        latest.current.appendMessages(owner, [
          { id: notice, role: "assistant", content: "定时任务「" + titleText + "」已触发" },
          { id: reply, role: "assistant", content: "", loading: true, waitingForFirstEvent: true, streaming: false, responseStarted: false },
        ]);
        latest.current.persistMessage?.(owner, {
          id: notice, role: "model", content: "定时任务「" + titleText + "」已触发", at: Date.now(),
        });
        return;
      }
      const key = runKeyOf(envelope);
      const run = runs.current.get(key);
      if (!run?.sessionId) return;
      const owner = run.sessionId;
      const reply = run.replyId;
      if (envelope.type === "TOOL_CALL_START") {
        if (!envelope.toolCallId) return;
        run.tools = [...(run.tools ?? []), {
          id: envelope.toolCallId, name: envelope.toolCallName ?? "工具",
          displayName: envelope.toolCallDisplayName, status: "running",
        }];
        latest.current.patchMessage(owner, reply, { toolExecutions: [...run.tools], loading: false, waitingForFirstEvent: false });
        return;
      }
      if (envelope.type === "TOOL_CALL_RESULT") {
        if (!envelope.toolCallId) return;
        run.tools = (run.tools ?? []).map((entry) => entry.id !== envelope.toolCallId ? entry : {
          ...entry, status: envelope.status === "failed" ? "error" : "success", result: (envelope.content ?? "").slice(0, 4000),
        });
        latest.current.patchMessage(owner, reply, { toolExecutions: [...run.tools] });
        return;
      }
      if (envelope.type === "TEXT_MESSAGE_START") {
        run.content = "";
        latest.current.patchMessage(owner, reply, { loading: false, waitingForFirstEvent: false, responseStarted: true, streaming: true, content: "" });
        return;
      }
      if (envelope.type === "TEXT_MESSAGE_CONTENT") {
        if (!envelope.delta) return;
        run.content += envelope.delta;
        latest.current.patchMessage(owner, reply, {
          content: run.content, loading: false, streaming: true, responseStarted: true, waitingForFirstEvent: false,
        });
        return;
      }
      if (envelope.type === "TEXT_MESSAGE_END") {
        latest.current.patchMessage(owner, reply, { streaming: false });
        return;
      }
      if (envelope.type === "RUN_FINISHED") {
        const summary = run.content || run.tools?.map((entry) =>
          (entry.displayName ?? entry.name) + "：" + (entry.status === "error" ? "失败" : "完成")).join("\n") || "任务执行完毕。";
        finishStream(run, summary);
        runs.current.delete(key);
        return;
      }
      if (envelope.type === "RUN_ERROR") {
        const failure = envelope.message ?? envelope.error ?? "未知错误";
        finishStream(run, "定时任务执行失败：" + failure);
        runs.current.delete(key);
      }
    });
  }, []);
}
