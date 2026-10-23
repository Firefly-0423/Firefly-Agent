// @vitest-environment jsdom
import { act, createElement as element } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useSchedulerEvents } from "./useSchedulerEvents";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ChatMessage } from "../../../../../shared/chat-types";

let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; vi.unstubAllGlobals(); });
function scheduleView() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let selected: string | undefined = "inbox";
  let deliver: ((data: unknown) => void) | undefined;
  const append = vi.fn<(id: string, rows: ChatMessageItem[]) => void>();
  const patch = vi.fn<(id: string, message: string, changes: Partial<ChatMessageItem>) => void>();
  const persist = vi.fn<(id: string, message: ChatMessage) => void>();
  const detach = vi.fn(() => { deliver = undefined; });
  vi.stubGlobal("schedulerEvents", { onEvent: (callback: typeof deliver) => { deliver = callback; return detach; } });
  function Screen() { useSchedulerEvents({ getActiveSessionId: () => selected, appendMessages: append, patchMessage: patch, persistMessage: persist }); return null; }
  const node = document.body.appendChild(document.createElement("section"));
  const renderer = createRoot(node); act(() => renderer.render(element(Screen)));
  const unmount = () => { act(() => renderer.unmount()); node.remove(); release = undefined; }; release = unmount;
  return { append, patch, persist, detach, unmount, select: (id?: string) => { selected = id; }, send: (...events: Record<string, unknown>[]) => act(() => { events.forEach(event => deliver?.({ schedulerRunId: "clock-run", ...event })); }) };
}
const beginning = (title: string) => ({ type: "CUSTOM", name: "scheduler.started", schedulerTaskId: "clock-task", value: { title, taskId: "clock-task", manual: true, runId: "clock-run" } });

test("starting a task appends notice before the pending assistant and stores the notice as model", () => {
  const page = scheduleView(); page.send(beginning("Release digest"));
  expect(page.append).toHaveBeenCalledTimes(1);
  expect(page.append.mock.calls[0][0]).toBe("inbox");
  expect(page.append.mock.calls[0][1]).toEqual([
    { id: "scheduler-notice-clock-run", role: "assistant", content: "\u5b9a\u65f6\u4efb\u52a1\u300cRelease digest\u300d\u5df2\u89e6\u53d1" },
    { id: "scheduler-reply-clock-run", role: "assistant", content: "", loading: true, waitingForFirstEvent: true, streaming: false, responseStarted: false },
  ]);
  expect(page.persist).toHaveBeenCalledTimes(1);
  expect(page.persist.mock.calls[0][1]).toMatchObject({ role: "model", content: "\u5b9a\u65f6\u4efb\u52a1\u300cRelease digest\u300d\u5df2\u89e6\u53d1" });
});
test("a task begun without selection discards the entire stream", () => {
  const page = scheduleView(); page.select(); page.send(beginning("orphan"), { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }, { type: "RUN_FINISHED" });
  expect([page.append.mock.calls, page.patch.mock.calls, page.persist.mock.calls]).toEqual([[], [], []]);
});
test("text deltas accumulate before a complete nonstreaming reply is persisted", () => {
  const page = scheduleView();
  page.send(beginning("weather"), { type: "TEXT_MESSAGE_START" }, { type: "TEXT_MESSAGE_CONTENT", delta: "Build " }, { type: "TEXT_MESSAGE_CONTENT", delta: "ready" }, { type: "TEXT_MESSAGE_END" }, { type: "RUN_FINISHED" });
  const changes = page.patch.mock.calls.map(call => call[2]);
  expect(changes.filter(change => change.content !== undefined).at(-1)?.content).toBe("Build ready");
  expect(changes.at(-1)).toMatchObject({ loading: false, streaming: false });
  expect(page.persist.mock.calls.at(-1)?.[1].content).toBe("Build ready");
});
test("a tool-only run writes the exact tool list and completion summary", () => {
  const page = scheduleView(); page.send(beginning("disk"), { type: "TOOL_CALL_START", toolCallId: "disk-call", toolCallName: "inspect_volume" }, { type: "TOOL_CALL_RESULT", toolCallId: "disk-call", content: "E: 42%", status: "success" }, { type: "RUN_FINISHED" });
  const tools = [{ id: "disk-call", name: "inspect_volume", status: "success", result: "E: 42%" }];
  expect(page.patch.mock.calls.map(call => call[2]).filter(change => change.toolExecutions).at(-1)?.toolExecutions).toEqual(tools);
  expect(page.persist.mock.calls.at(-1)?.[1]).toMatchObject({ content: "inspect_volume\uff1a\u5b8c\u6210", toolExecutions: tools });
});
test("run errors use the same exact failure copy in rendering and storage", () => {
  const page = scheduleView(); page.send(beginning("failure"), { type: "RUN_ERROR", message: "Backend unreachable" });
  const failure = "\u5b9a\u65f6\u4efb\u52a1\u6267\u884c\u5931\u8d25\uff1aBackend unreachable";
  expect(page.patch.mock.calls.at(-1)?.[2].content).toBe(failure);
  expect(page.persist.mock.calls.at(-1)?.[1].content).toBe(failure);
});
test("detaching the page prevents future task writes", () => {
  const page = scheduleView(); page.unmount(); page.send(beginning("after-close"));
  expect(page.detach).toHaveBeenCalledTimes(1); expect(page.append.mock.calls).toEqual([]); expect(page.persist.mock.calls).toEqual([]);
});
