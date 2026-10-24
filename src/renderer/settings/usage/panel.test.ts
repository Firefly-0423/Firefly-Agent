// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageHistoryView } from "../../../shared/usage-history";

const modal = vi.hoisted(() => ({ showConfirm: vi.fn(async () => true) }));
vi.mock("../shared/modal", () => modal);

import { loadUsagePanel, smoothPath, type UsageBridge } from "./panel";

function day(date: string, overrides: Partial<UsageHistoryView["days"][number]> = {}): UsageHistoryView["days"][number] {
  return { date, weekday: "周一", tokens: 0, requests: 0, byModel: {}, byFeature: {}, messages: 0, skillCalls: 0, pluginCalls: 0, ...overrides };
}

function history(overrides: Partial<UsageHistoryView> = {}): UsageHistoryView {
  return {
    days: [
      day("10-15", { tokens: 3000, requests: 3, byModel: { "model-a": 2000, "model-b": 1000 }, byFeature: { chat: 2000, work: 1000 }, messages: 4, skillCalls: 2 }),
      day("10-16", { tokens: 1_000_000, requests: 9, byModel: { "model-a": 1_000_000 }, byFeature: { code: 1_000_000 }, messages: 6, pluginCalls: 1 }),
    ],
    models: [{ name: "model-a", tokens: 1_002_000, requests: 8 }, { name: "model-b", tokens: 1000, requests: 1 }],
    features: [{ name: "code", tokens: 1_000_000, requests: 5 }, { name: "chat", tokens: 2000, requests: 2 }, { name: "work", tokens: 1000, requests: 1 }],
    sessions: [
      { id: "s1", feature: "code", tokens: 1_000_000, requests: 5, title: "重构设置页" },
      { id: "s2", feature: "chat", tokens: 1500, requests: 2, title: null },
    ],
    skills: [{ id: "code-review", count: 2 }],
    plugins: [{ id: "minecraft", count: 1 }],
    ...overrides,
  };
}

let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); modal.showConfirm.mockClear(); modal.showConfirm.mockResolvedValue(true); });
afterEach(() => host.remove());
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const click = (selector: string) => { host.querySelector<HTMLElement>(selector)!.click(); };

describe("usage panel", () => {
  it("draws one stacked bar per day with a legend whose shares add up", async () => {
    const bridge: UsageBridge = { history: vi.fn(async () => history()) };
    await loadUsagePanel(host, bridge);
    expect(bridge.history).toHaveBeenCalledWith(7);
    expect(host.querySelectorAll(".usage-stack__segment")).toHaveLength(3);
    const rows = [...host.querySelectorAll(".usage-legend__row")].map(row => row.textContent);
    expect(rows[0]).toContain("model-a");
    expect(rows[0]).toContain("1M");
    expect(host.querySelector(".usage-card__summary")?.textContent).toContain("1M");
    const shares = [...host.querySelectorAll(".usage-legend__share")].map(node => Number.parseInt(node.textContent!, 10));
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(host.querySelector('[data-range="7"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to the feature view with translated names, and to 30 days with a fresh read", async () => {
    const bridge: UsageBridge = { history: vi.fn(async () => history()) };
    await loadUsagePanel(host, bridge);
    click('[data-dimension="feature"]');
    const names = [...host.querySelectorAll(".usage-legend__name")].map(node => node.textContent);
    expect(names).toEqual(["代码", "聊天", "工作"]);
    expect(document.activeElement?.getAttribute("data-dimension")).toBe("feature");

    click('[data-range="30"]');
    await flush();
    expect(bridge.history).toHaveBeenLastCalledWith(30);
    expect(host.querySelector('[data-range="30"]')?.getAttribute("aria-pressed")).toBe("true");
    // The feature choice survives the reload.
    expect(host.querySelector('[data-dimension="feature"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("files usage from before features were tracked under its own label", async () => {
    const data = history({ features: [], days: [day("10-15", { tokens: 500, requests: 1, byModel: { "model-a": 500 } })] });
    await loadUsagePanel(host, { history: async () => data });
    click('[data-dimension="feature"]');
    expect([...host.querySelectorAll(".usage-legend__name")].map(node => node.textContent)).toEqual(["此前未归类"]);
    expect(host.querySelector(".usage-note")).not.toBeNull();
  });

  it("ranks conversations by title, and names a deleted one as such", async () => {
    await loadUsagePanel(host, { history: async () => history() });
    const rows = [...host.querySelectorAll(".usage-rank__row")];
    expect(rows[0]!.querySelector(".usage-rank__name")?.textContent).toBe("重构设置页");
    expect(rows[0]!.querySelector(".usage-rank__feature")?.textContent).toBe("代码");
    expect(rows[1]!.querySelector(".usage-rank__name")?.textContent).toBe("已删除或临时的会话");
    expect((rows[1]!.querySelector(".usage-rank__bar") as HTMLElement).style.width).toBe("2%");
  });

  it("shows message, skill and plugin totals with their top names", async () => {
    await loadUsagePanel(host, { history: async () => history() });
    const cards = [...host.querySelectorAll(".usage-card--trend")];
    expect(cards.map(card => card.querySelector(".usage-card__summary")?.textContent)).toEqual(["10", "2", "1"]);
    expect(cards[1]!.textContent).toContain("code-review");
    expect(cards[2]!.textContent).toContain("minecraft");
  });

  it("says so when nothing was recorded, and when the data cannot be read", async () => {
    await loadUsagePanel(host, { history: async () => history({ days: [day("10-15")], models: [], features: [], sessions: [], skills: [], plugins: [] }) });
    expect(host.querySelector(".usage-stack")).toBeNull();
    expect(host.textContent).toContain("这段时间还没有用量记录");
    await loadUsagePanel(host, { history: async () => { throw new Error("ipc"); } });
    expect(host.textContent).toContain("读取用量失败");
    await loadUsagePanel(host, {});
    expect(host.textContent).toContain("读取不到用量数据");
  });

  it("clears the records only after confirmation, then reloads", async () => {
    const clear = vi.fn(async () => undefined);
    const read = vi.fn(async () => history());
    await loadUsagePanel(host, { history: read, clear });
    modal.showConfirm.mockResolvedValueOnce(false);
    click('[data-action="clear"]');
    await flush();
    expect(clear).not.toHaveBeenCalled();
    click('[data-action="clear"]');
    await flush(); await flush();
    expect(modal.showConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ dangerous: true }));
    expect(clear).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps working after the page is opened again, and ignores a slow read from the previous visit", async () => {
    let release!: (value: UsageHistoryView) => void;
    const slow = new Promise<UsageHistoryView>(resolve => { release = resolve; });
    const first = loadUsagePanel(host, { history: () => slow });
    const second = loadUsagePanel(host, { history: async () => history({ models: [{ name: "fresh-model", tokens: 3000, requests: 3 }] }) });
    await second;
    release(history({ models: [{ name: "stale-model", tokens: 9, requests: 1 }] }));
    await first;
    expect(host.textContent).toContain("fresh-model");
    expect(host.textContent).not.toContain("stale-model");
    click('[data-dimension="feature"]');
    expect(host.querySelector('[data-dimension="feature"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("trend lines", () => {
  it("draws a smooth curve that never dips below the baseline or above a peak", () => {
    const points = [[0, 70], [10, 70], [20, 2], [30, 70], [40, 70]] as const;
    const d = smoothPath(points);
    expect(d.startsWith("M0.0,70.0 C")).toBe(true);
    const ys = [...d.matchAll(/-?\d+\.\d,(-?\d+\.\d)/g)].map(match => Number(match[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(70);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(2);
    expect(smoothPath([[0, 1]])).toBe("");
  });

  it("gives messages, skills and plugins their own hue and a gradient of their own", async () => {
    const root = document.createElement("div");
    await loadUsagePanel(root, { history: async () => history() });
    const cards = [...root.querySelectorAll(".usage-card--trend")];
    expect(cards.map(card => ["messages", "skills", "plugins"].find(tone => card.classList.contains(`usage-card--${tone}`)))).toEqual(["messages", "skills", "plugins"]);
    const fills = [...root.querySelectorAll(".usage-line__area")].map(area => area.getAttribute("fill"));
    expect(new Set(fills).size).toBe(3);
    for (const fill of fills) expect(root.querySelector(fill!.slice(4, -1))).not.toBeNull();
    expect(root.querySelectorAll(".usage-line__dot")).toHaveLength(3);
  });
});
