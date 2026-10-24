// @vitest-environment jsdom
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShadowPanelApi, ShadowPanelOutcome, ShadowPanelState } from "../../../shared/memory-panel-contracts";

const baseState = (patch: Partial<ShadowPanelState> = {}): ShadowPanelState => ({
  available: true, enabled: false, dailyCap: 50, revision: 1, day: "2026-10-15", used: 0, stopped: null, records: 0, counters: {}, ...patch,
});
const ok = (state: ShadowPanelState): ShadowPanelOutcome => ({ ok: true, state });
const text = (id: string) => document.getElementById(id)?.textContent ?? "";
const hidden = (id: string) => { const node = document.getElementById(id); return !node || node.hidden || node.classList.contains("is-hidden"); };
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

async function mount(api: Partial<ShadowPanelApi> | undefined) {
  vi.resetModules();
  document.body.innerHTML = fs.readFileSync("src/renderer/settings/index.html", "utf8");
  const { createShadowPanel } = await import("./shadow-panel");
  const panel = createShadowPanel(api);
  await panel.load();
  return panel;
}
function api(initial: ShadowPanelState = baseState()) {
  let current = initial;
  const calls: string[] = [];
  const impl: ShadowPanelApi = {
    shadowState: vi.fn(async () => ok(current)),
    shadowConfigure: vi.fn(async (input) => { calls.push("configure"); current = { ...current, enabled: input.enabled, dailyCap: input.dailyCap, revision: current.revision + 1 }; return ok(current); }),
    shadowExport: vi.fn(async () => ({ ok: true as const, canceled: false as const, count: current.records })),
    shadowClear: vi.fn(async () => { current = { ...current, records: 0, revision: current.revision + 1 }; return ok(current); }),
  };
  return { impl, calls, set: (state: ShadowPanelState) => { current = state; } };
}

beforeEach(() => { document.body.replaceChildren(); });

describe("shadow extraction settings card", () => {
  it("shows a clear note and hides the controls when this build has no shadow storage", async () => {
    await mount({ shadowState: async () => ok(baseState({ available: false })) });
    expect(hidden("memory-shadow-note")).toBe(false);
    expect(text("memory-shadow-note")).toContain("暂不支持");
    expect(hidden("memory-shadow-body")).toBe(true);
  });

  it("picks the bridge up later when it was not there on the first load", async () => {
    let bridge: ShadowPanelApi | undefined;
    vi.resetModules();
    document.body.innerHTML = fs.readFileSync("src/renderer/settings/index.html", "utf8");
    const { createShadowPanel } = await import("./shadow-panel");
    const panel = createShadowPanel(() => bridge);
    await panel.load();
    expect(text("memory-shadow-note")).toContain("暂不支持");
    bridge = api(baseState({ used: 1 })).impl;
    await panel.load();
    expect(hidden("memory-shadow-note")).toBe(true); expect(hidden("memory-shadow-body")).toBe(false);
    expect(text("memory-shadow-usage")).toBe("1 / 50 次");
  });

  it("treats a missing bridge as unavailable instead of failing", async () => {
    await mount(undefined);
    expect(text("memory-shadow-note")).toContain("暂不支持"); expect(hidden("memory-shadow-body")).toBe(true);
  });

  it("states both parts of the privacy notice on the page", async () => {
    await mount(api().impl);
    const card = text("memory-shadow");
    expect(card).toContain("不会保存健康、财务、证件、住址、联系方式或别人的事");
    expect(card).toContain("原文");
    expect(card).toContain("发送一次给当前使用的模型服务商");
  });

  it("starts switched off with the real numbers", async () => {
    await mount(api(baseState({ used: 3, dailyCap: 20, records: 4, counters: { "skip:secret": 2, "skip:empty": 1, "error:timeout": 1, "cancel:disabled": 2, "drop:schema": 5 } })).impl);
    expect((document.getElementById("memory-shadow-enabled") as HTMLInputElement).checked).toBe(false);
    expect(text("memory-shadow-status")).toBe("已关闭");
    expect(text("memory-shadow-usage")).toBe("3 / 20 次");
    expect(text("memory-shadow-records")).toBe("4 条");
    expect(text("memory-shadow-detail")).toBe("未发送 3 次 · 出错 1 次 · 取消 2 次 · 校验丢弃 5 条");
    expect((document.getElementById("memory-shadow-cap") as HTMLInputElement).value).toBe("20");
  });

  it("counts reservation refusals as not sent", async () => {
    await mount(api(baseState({ counters: { "skip:secret": 1, "refuse:cap-reached": 2, "discard:source-unavailable": 4 } })).impl);
    expect(text("memory-shadow-detail")).toContain("未发送 3 次");
  });

  it("does not turn on until the user confirms on the page", async () => {
    const f = api(); await mount(f.impl);
    const toggle = document.getElementById("memory-shadow-enabled") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    expect(hidden("memory-shadow-consent")).toBe(false); expect(toggle.checked).toBe(false);
    expect(f.impl.shadowConfigure).not.toHaveBeenCalled();
    click("memory-shadow-consent-cancel"); await flush();
    expect(hidden("memory-shadow-consent")).toBe(true); expect(f.impl.shadowConfigure).not.toHaveBeenCalled();
  });

  it("turns on after confirmation, with the current revision and cap", async () => {
    const f = api(); await mount(f.impl);
    const toggle = document.getElementById("memory-shadow-enabled") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    click("memory-shadow-consent-ok"); await flush();
    expect(f.impl.shadowConfigure).toHaveBeenCalledWith({ enabled: true, dailyCap: 50, expectedRevision: 1 });
    expect(toggle.checked).toBe(true); expect(text("memory-shadow-status")).toBe("已开启"); expect(text("memory-shadow-message")).toBe("已开启。");
  });

  it("turns off right away without asking", async () => {
    const f = api(baseState({ enabled: true, revision: 4 })); await mount(f.impl);
    const toggle = document.getElementById("memory-shadow-enabled") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false; toggle.dispatchEvent(new Event("change")); await flush();
    expect(f.impl.shadowConfigure).toHaveBeenCalledWith({ enabled: false, dailyCap: 50, expectedRevision: 4 });
    expect(text("memory-shadow-status")).toBe("已关闭");
  });

  it.each([["0"], ["1001"], ["2.5"], [""], ["abc"]])("rejects the cap %j without calling the main process", async (value) => {
    const f = api(baseState({ enabled: true })); await mount(f.impl);
    (document.getElementById("memory-shadow-cap") as HTMLInputElement).value = value;
    click("memory-shadow-cap-save"); await flush();
    expect(f.impl.shadowConfigure).not.toHaveBeenCalled(); expect(text("memory-shadow-message")).toContain("1 到 1000");
  });

  it("saves a valid cap and keeps the switch as it was", async () => {
    const f = api(baseState({ enabled: true, revision: 2 })); await mount(f.impl);
    (document.getElementById("memory-shadow-cap") as HTMLInputElement).value = "120";
    click("memory-shadow-cap-save"); await flush();
    expect(f.impl.shadowConfigure).toHaveBeenCalledWith({ enabled: true, dailyCap: 120, expectedRevision: 2 });
    expect(text("memory-shadow-usage")).toBe("0 / 120 次"); expect(text("memory-shadow-message")).toBe("已保存。");
  });

  it.each([
    [{ stopped: "quota" as const }, "今天已停止：额度不足，明天自动恢复"],
    [{ stopped: "rate-limit" as const }, "今天已停止：被限流，明天自动恢复"],
    [{ used: 50 }, "今天已达上限，明天自动恢复"],
    [{}, "已开启"],
  ])("explains why extraction is not running: %j", async (patch, expected) => {
    await mount(api(baseState({ enabled: true, ...patch })).impl);
    expect(text("memory-shadow-status")).toBe(expected);
  });

  it("refreshes instead of overwriting when the setting changed elsewhere", async () => {
    const f = api(baseState({ revision: 1 })); await mount(f.impl);
    f.impl.shadowConfigure = vi.fn(async () => { f.set(baseState({ revision: 7, enabled: true })); return { ok: false as const, error: "SHADOW_REVISION_CONFLICT" as const }; });
    const toggle = document.getElementById("memory-shadow-enabled") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change")); click("memory-shadow-consent-ok"); await flush();
    expect(text("memory-shadow-message")).toContain("已刷新");
    expect(toggle.checked).toBe(true);
  });

  it("exports through the main process and reports the count or the cancel", async () => {
    const f = api(baseState({ records: 3 })); await mount(f.impl);
    click("memory-shadow-export"); await flush();
    expect(f.impl.shadowExport).toHaveBeenCalledTimes(1); expect(text("memory-shadow-message")).toBe("已导出 3 条记录。");
    f.impl.shadowExport = vi.fn(async () => ({ ok: true as const, canceled: true as const }));
    click("memory-shadow-export"); await flush();
    expect(text("memory-shadow-message")).toBe("已取消导出。");
  });

  it("disables export and clear while there is nothing to export", async () => {
    await mount(api(baseState({ records: 0 })).impl);
    expect((document.getElementById("memory-shadow-export") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("memory-shadow-clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears only after a second confirmation, and can back out", async () => {
    const f = api(baseState({ records: 2 })); await mount(f.impl);
    click("memory-shadow-clear");
    expect(hidden("memory-shadow-clear-confirm")).toBe(false); expect(f.impl.shadowClear).not.toHaveBeenCalled();
    click("memory-shadow-clear-cancel"); expect(hidden("memory-shadow-clear-confirm")).toBe(true); expect(f.impl.shadowClear).not.toHaveBeenCalled();
    click("memory-shadow-clear"); click("memory-shadow-clear-ok"); await flush();
    expect(f.impl.shadowClear).toHaveBeenCalledTimes(1);
    expect(text("memory-shadow-records")).toBe("0 条"); expect(text("memory-shadow-message")).toBe("已清空。");
  });

  it("shows a safe message when the main process refuses or fails", async () => {
    const f = api(baseState({ records: 1 })); await mount(f.impl);
    f.impl.shadowExport = vi.fn(async () => ({ ok: false as const, error: "SHADOW_FORBIDDEN" as const }));
    click("memory-shadow-export"); await flush();
    expect(text("memory-shadow-message")).toBe("没有权限执行此操作。");
    f.impl.shadowClear = vi.fn(async () => { throw new Error("C:\\secret\\path"); });
    click("memory-shadow-clear"); click("memory-shadow-clear-ok"); await flush();
    expect(text("memory-shadow-message")).toBe("操作未完成，请稍后重试。"); expect(text("memory-shadow-message")).not.toContain("secret");
  });
});
