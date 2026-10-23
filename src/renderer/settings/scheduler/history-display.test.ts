// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { toggleSchedulerHistory } from "./panel";

vi.mock("../shared/modal", () => ({ showConfirm: vi.fn(), showNotice: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); Reflect.deleteProperty(window, "fireflyScheduler"); });

it("shows unknown external effects ahead of partial output in the settings history", async () => {
  Object.assign(window, { fireflyScheduler: { getHistory: async () => ({ ok: true, value: [{
    id: "synthetic-run", taskId: "synthetic-task", taskTitle: "synthetic", firedAt: "2026-10-19T10:00:00Z",
    status: "interrupted", executionOutcome: "unknown", externalEffectsMayContinue: true,
    outputPreview: "synthetic partial output", effectiveToolIds: [],
  }] }) } });
  const card = document.createElement("div"); card.innerHTML = '<div class="scheduler-history is-hidden"></div>';
  document.body.append(card); await toggleSchedulerHistory("synthetic-task", card);
  expect(card.textContent).toContain("已中断"); expect(card.textContent).toContain("执行结果未知");
  expect(card.textContent).toContain("外部操作可能仍在继续"); expect(card.textContent).toContain("synthetic partial output");
});
