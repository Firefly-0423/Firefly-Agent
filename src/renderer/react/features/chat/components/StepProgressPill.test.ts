// @vitest-environment jsdom
// StepProgressPill：输入框上方的工作步骤胶囊与弹层。覆盖文案口径、显隐、无障碍属性、
// 关闭方式（Escape / 外部点击 / 焦点离开）以及退场动画结束后才卸载的时序。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepProgressPill, type StepProgressPillProps } from "./StepProgressPill";

// JSX 经典运行时（React.createElement）：被测 .tsx 需要全局 React（项目测试惯例）。
vi.stubGlobal("React", React);

const plan: StepProgressPillProps["steps"] = [
  { title: "读取需求", status: "done" },
  { title: "修改聊天输入框", status: "running" },
  { title: "补充组件测试", status: "pending" },
  { title: "运行类型检查", status: "pending" },
  { title: "验证浅色与深色主题", status: "pending" },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(props: Partial<StepProgressPillProps> = {}) {
  const merged: StepProgressPillProps = {
    steps: plan,
    running: true,
    filesChanged: 12,
    added: 403,
    removed: 0,
    ...props,
  };
  act(() => root.render(createElement(StepProgressPill, merged)));
}

function pillHost(): HTMLElement | null {
  return host.querySelector<HTMLElement>(".ff-step-pill-host");
}

function pill(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>("button.ff-step-pill")!;
}

function popover(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="group"]');
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function pointerDownOutside() {
  act(() => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
}

describe("StepProgressPill visibility", () => {
  it("renders nothing when there is no plan and nothing is running", () => {
    render({ steps: [], running: false, filesChanged: undefined, added: undefined, removed: undefined });
    expect(pillHost()).toBeNull();
  });

  it("renders nothing when a plan exists but the run is idle", () => {
    render({ running: false });
    expect(pillHost()).toBeNull();
  });

  it("renders nothing while running without any plan", () => {
    render({ steps: [] });
    expect(pillHost()).toBeNull();
  });
});

describe("StepProgressPill label", () => {
  it("shows the running position with file totals in the reference order", () => {
    render();
    expect(pill().textContent).toBe("第 2 / 5 步 · 12 个文件已更改 +403 -0");
  });

  it("colours the added and removed counts separately", () => {
    render();
    expect(pill().querySelector(".ff-step-pill__add")?.textContent).toBe("+403");
    expect(pill().querySelector(".ff-step-pill__del")?.textContent).toBe("-0");
  });

  it("reports completion while the run is still going when every step is done", () => {
    render({
      steps: [{ title: "读取需求", status: "done" }, { title: "修改组件", status: "done" }, { title: "补充测试", status: "done" }],
    });
    expect(pill().textContent).toBe("已完成 3 步 · 12 个文件已更改 +403 -0");
  });

  it("omits file totals when no counts are provided", () => {
    render({ filesChanged: undefined, added: undefined, removed: undefined });
    expect(pill().textContent).toBe("第 2 / 5 步");
    expect(pill().querySelector(".ff-step-pill__add")).toBeNull();
    expect(pill().querySelector(".ff-step-pill__del")).toBeNull();
  });
});

describe("StepProgressPill popover", () => {
  it("exposes a disclosure button tied to a labelled list of steps", () => {
    render();
    expect(pill().type).toBe("button");
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(pill().hasAttribute("aria-controls")).toBe(false);
    expect(popover()).toBeNull();

    act(() => pill().click());
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    const group = popover()!;
    expect(group.getAttribute("aria-label")).toBe("工作步骤");
    expect(pill().getAttribute("aria-controls")).toBe(group.id);
    expect(group.querySelectorAll("li")).toHaveLength(plan.length);

    act(() => pill().click());
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("lists every step title with a visually hidden status word", () => {
    render();
    act(() => pill().click());
    const items = [...popover()!.querySelectorAll("li")];
    expect(items[0].textContent).toContain("读取需求");
    expect(items[0].querySelector(".ff-step-item__status")?.textContent).toBe("完成");
    expect(items[1].querySelector(".ff-step-item__status")?.textContent).toBe("进行中");
    expect(items[2].querySelector(".ff-step-item__status")?.textContent).toBe("待办");
    expect(items[0].classList.contains("is-done")).toBe(true);
    expect(items[1].classList.contains("is-running")).toBe(true);
    expect(items[2].classList.contains("is-pending")).toBe(true);
  });

  it("closes on Escape and returns focus to the pill when focus was inside the popover", () => {
    render();
    act(() => pill().click());
    act(() => popover()!.focus());
    expect(document.activeElement).toBe(popover());

    pressEscape();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pill());
  });

  it("does not steal focus when Escape closes it while focus is elsewhere", () => {
    render();
    act(() => pill().click());
    const outside = document.createElement("input");
    document.body.append(outside);
    act(() => outside.focus());

    pressEscape();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("closes on a pointer press outside the component", () => {
    render();
    act(() => pill().click());
    pointerDownOutside();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open for a pointer press inside the component", () => {
    render();
    act(() => pill().click());
    act(() => {
      popover()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(pill().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when focus moves to an element outside the component", () => {
    render();
    act(() => pill().click());
    act(() => {
      pill().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes itself once the run is no longer busy", () => {
    render();
    act(() => pill().click());
    render({ running: false });
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("StepProgressPill transitions", () => {
  it("keeps the popover mounted through its exit animation before removing it", () => {
    vi.useFakeTimers();
    render();
    act(() => pill().click());
    expect(popover()).not.toBeNull();

    pointerDownOutside();
    expect(host.querySelector(".ff-step-popover-anchor.is-leaving")).not.toBeNull();
    act(() => vi.advanceTimersByTime(179));
    expect(popover()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(popover()).toBeNull();
  });

  it("keeps the pill mounted through its exit animation before removing it", () => {
    vi.useFakeTimers();
    render();
    render({ running: false });
    expect(pillHost()?.classList.contains("is-leaving")).toBe(true);
    expect(pill().textContent).toBe("第 2 / 5 步 · 12 个文件已更改 +403 -0");
    act(() => vi.advanceTimersByTime(199));
    expect(pillHost()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(pillHost()).toBeNull();
  });

  it("unmounts at once, without an exit frame, when the plan is cleared during a run", () => {
    vi.useFakeTimers();
    render();
    render({ steps: [] });
    expect(pillHost()).toBeNull();
  });

  it("cancels the pending removal when a run starts again during the exit", () => {
    vi.useFakeTimers();
    render();
    render({ running: false });
    act(() => vi.advanceTimersByTime(100));
    render({ running: true });
    expect(pillHost()?.classList.contains("is-leaving")).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(pillHost()).not.toBeNull();
    expect(pill().textContent).toContain("第 2 / 5 步");
  });
});

describe("StepProgressPill reduced motion", () => {
  it("renders without crashing when the system asks for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    expect(() => {
      render();
      act(() => pill().click());
    }).not.toThrow();
    expect(pill().textContent).toContain("第 2 / 5 步");
  });

  it("keeps the reduced-motion block limited to opacity and a non-rotating spinner", () => {
    const stylesheet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "StepProgressPill.css"), "utf8");
    // 媒体块内规则缩进、闭合花括号位于行首，按此截取整个块（不依赖它在文件中的位置）。
    const block = stylesheet.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain(".ff-step-item__spinner");
    expect(block).toContain("transform: none");
    expect(block).not.toMatch(/rotate\(/);
  });
});
