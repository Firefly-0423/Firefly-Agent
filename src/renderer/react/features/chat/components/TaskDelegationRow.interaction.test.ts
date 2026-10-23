// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { ChatInspectorActionsContext } from "./inspector-actions";

let host: HTMLDivElement;
let root: Root;
const running: TaskDelegationDisplayRecord = {
  invocationId: "child-1", taskId: "task-1", description: "检查取消链路，并保留已有会话的草稿与公开执行状态。",
  nickname: "艾利欧", assetFileName: "艾利欧.png", status: "running", roundId: "round-1",
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(delegation = running) { act(() => root.render(createElement(TaskDelegationRow, { delegation }))); }
function disclosure() { return host.querySelector<HTMLButtonElement>("button[aria-expanded]")!; }

describe("public delegated-task disclosure", () => {
  it("exposes a native button and expands the complete public task description", () => {
    render();
    const trigger = disclosure();
    expect(trigger).not.toBeNull();
    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const detail = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(detail.hidden).toBe(true);
    act(() => { trigger.focus(); trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain(running.description);
    expect(detail.textContent).toContain(running.taskId);
    expect(document.activeElement).toBe(trigger);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("正在运行");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps the disclosure open while a running task is cancelled and closes on Escape", () => {
    render();
    expect(disclosure()).not.toBeNull();
    act(() => disclosure().click());
    render({ ...running, status: "cancelled" });
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("已取消");
    expect(host.querySelector(".ff-task-delegation")?.classList.contains("is-running")).toBe(false);
    act(() => disclosure().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(disclosure());
  });

  it("supports repeated opening without duplicating details and resets on a different invocation", () => {
    render();
    expect(disclosure()).not.toBeNull();
    const trigger = disclosure();
    for (let index = 0; index < 3; index++) {
      act(() => trigger.click());
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      act(() => trigger.click());
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
    act(() => trigger.click());
    render({ ...running, invocationId: "child-2", taskId: "task-2" });
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll(".ff-task-delegation__details")).toHaveLength(1);
  });

  it("uses distinct disclosure targets even when the same historical task is rendered twice", () => {
    act(() => root.render(createElement("div", null,
      createElement(TaskDelegationRow, { delegation: running }), createElement(TaskDelegationRow, { delegation: running }))));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button[aria-controls]")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-controls")).not.toBe(buttons[1].getAttribute("aria-controls"));
  });

  it("opens the result in the inspector instead of unfolding when the chat provides an opener", () => {
    const open = vi.fn();
    act(() => root.render(createElement(ChatInspectorActionsContext.Provider, { value: { openDelegation: open } },
      createElement(TaskDelegationRow, { delegation: running }))));
    const trigger = host.querySelector<HTMLButtonElement>("button.ff-task-delegation__summary")!;
    expect(trigger.hasAttribute("aria-expanded")).toBe(false);
    act(() => trigger.click());
    expect(open).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(host.querySelector(".ff-task-delegation__details")).toBeNull();
  });
});
