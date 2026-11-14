// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QqMusicState } from "../../shared/qqmusic-types";
import { SPECIALIST_AGENTS, type AgentRoutingView } from "../../shared/specialist-agents";
import type { UsageHistoryView } from "../../shared/usage-history";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-test-harness";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function activeNavSections(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"))
    .filter((btn) => btn.getAttribute("aria-current") === "page")
    .map((btn) => btn.dataset.section!);
}

function activeClassNavSections(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"))
    .filter((btn) => btn.classList.contains("is-active"))
    .map((btn) => btn.dataset.section!);
}

function visiblePanelIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"))
    .filter((panel) => !panel.classList.contains("is-hidden"))
    .map((panel) => panel.id);
}

function createUsageHistoryFixture(): UsageHistoryView {
  return {
    days: [
      {
        date: "11-10",
        weekday: "周二",
        tokens: 2400,
        requests: 2,
        byModel: { "model-a": 2400 },
        byFeature: { chat: 2400 },
        messages: 3,
        skillCalls: 1,
        pluginCalls: 0,
      },
    ],
    models: [{ name: "model-a", tokens: 2400, requests: 2 }],
    features: [{ name: "chat", tokens: 2400, requests: 2 }],
    sessions: [{ id: "session-1", feature: "chat", tokens: 2400, requests: 2, title: "路由集成检查" }],
    skills: [{ id: "search", count: 1 }],
    plugins: [],
  };
}

function createAgentRoutingFixture(): AgentRoutingView {
  return {
    profiles: [{ id: "profile-main", label: "DeepSeek Chat" }],
    routes: [{ id: "fast", profileId: "profile-main" }],
    agents: SPECIALIST_AGENTS.map((agent) => ({
      ...agent,
      effectiveProfileId: "profile-main",
    })),
  };
}

describe("settings section routing, hash initialization, IPC switch & lazy loading (T6)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("routes initial hash '#channels' to channels panel, updates aria-current & header copy, activates loadChannelsPanel, and skips lazy bridges", async () => {
    const channelsGetConfig = vi.fn(async () => ({
      wechat: { enabled: true },
      feishu: { enabled: false },
      qq: { enabled: false },
    }));
    const channelsGetStatus = vi.fn(async () => ({
      wechat: { phase: "running", message: "微信在线" },
    }));
    const channelsContextBindingsGet = vi.fn(async () => ({
      externalChats: [{ channel: "wechat", chatId: "wx-1", label: "手机端" }],
      bindings: [],
      conversations: [{ id: "conv-1", title: "日常对话" }],
    }));
    const musicGetStatus = vi.fn<() => Promise<QqMusicState>>(async () => ({
      available: false,
      errorCode: "QQ_MUSIC_NOT_RUNNING",
    }));
    const tokenUsageHistory = vi.fn(async () => createUsageHistoryFixture());
    const getAgentRouting = vi.fn(async () => createAgentRoutingFixture());

    await mountSettingsPage({
      hash: "#channels",
      settings: {
        channelsGetConfig,
        channelsGetStatus,
        channelsContextBindingsGet,
        getAgentRouting,
      },
      music: { getStatus: musicGetStatus, control: vi.fn() },
      tokenUsage: { history: tokenUsageHistory },
    });

    expect(visiblePanelIds()).toEqual(["channels-panel"]);
    expect(byId("placeholder-panel").classList.contains("is-hidden")).toBe(true);
    expect(activeNavSections()).toEqual(["channels"]);
    expect(activeClassNavSections()).toEqual(["channels"]);

    // channels is not listed in NAV_LABELS, so switchSection updates title/hint via NAV_LABELS.api fallback
    expect(byId("section-title").textContent).toBe("API 设置");
    expect(byId("section-hint").textContent).toBe("选择预设后只需要填写 API Key。");

    // loadChannelsPanel() ran at startup AND switchSection("channels") triggered the initialized refresh
    // (channelsGetStatus is called twice: once by loadChannelsPanel and once by startup proactive delivery check).
    expect(channelsGetConfig).toHaveBeenCalledTimes(1);
    expect(channelsGetStatus).toHaveBeenCalledTimes(2);
    expect(channelsContextBindingsGet).toHaveBeenCalledTimes(2);
    expect(byId<HTMLInputElement>("channels-wechat-enabled").checked).toBe(true);

    // Lazy panels not opened on startup must make zero bridge calls
    expect(musicGetStatus).toHaveBeenCalledTimes(0);
    expect(tokenUsageHistory).toHaveBeenCalledTimes(0);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);
  });

  it("switches to music, disposes in-flight music refresh when leaving for unknown-section, and falls back to general without spurious requests", async () => {
    const staleMusicStatus = deferred<QqMusicState>();
    const freshMusicStatus = deferred<QqMusicState>();
    const musicGetStatus = vi.fn<() => Promise<QqMusicState>>()
      .mockReturnValueOnce(staleMusicStatus.promise)
      .mockReturnValueOnce(freshMusicStatus.promise);
    const tokenUsageHistory = vi.fn(async () => createUsageHistoryFixture());
    const getAgentRouting = vi.fn(async () => createAgentRoutingFixture());

    const { emitSwitchSection } = await mountSettingsPage({
      hash: "#plugins",
      settings: { getAgentRouting },
      music: { getStatus: musicGetStatus, control: vi.fn() },
      tokenUsage: { history: tokenUsageHistory },
    });

    expect(visiblePanelIds()).toEqual(["plugins-panel"]);
    expect(musicGetStatus).toHaveBeenCalledTimes(0);
    expect(tokenUsageHistory).toHaveBeenCalledTimes(0);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);

    // Enter nested music panel via QQ Music link in plugins panel
    byId<HTMLButtonElement>("music-platform-qq").click();

    expect(visiblePanelIds()).toEqual(["music-panel"]);
    expect(activeNavSections()).toEqual(["plugins"]);
    expect(activeClassNavSections()).toEqual(["plugins"]);
    expect(musicGetStatus).toHaveBeenCalledTimes(1);
    expect(byId("qqmusic-status").textContent).toBe("尚未读取");
    expect(tokenUsageHistory).toHaveBeenCalledTimes(0);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);

    // Leave music for an unknown section -> falls back to general and calls disposeMusicPanel()
    emitSwitchSection("unknown-section");

    expect(visiblePanelIds()).toEqual(["general-form"]);
    expect(byId("music-panel").classList.contains("is-hidden")).toBe(true);
    expect(byId("placeholder-panel").classList.contains("is-hidden")).toBe(true);
    expect(activeNavSections()).toEqual(["general"]);
    expect(activeClassNavSections()).toEqual(["general"]);
    expect(byId("section-title").textContent).toBe("通用设置");
    expect(byId("section-hint").textContent).toBe("选择流萤的界面语言，切换后立即保存。");

    // No spurious requests to music, usage, or subagents when falling back to general
    expect(musicGetStatus).toHaveBeenCalledTimes(1);
    expect(tokenUsageHistory).toHaveBeenCalledTimes(0);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);

    // Late resolution of the stale music status must be ignored by disposeMusicPanel()
    staleMusicStatus.resolve({
      available: true,
      playbackStatus: "playing",
      title: "过期曲目",
      artist: "旧歌手",
      canPlay: false,
      canPause: true,
      canNext: true,
      canPrev: true,
    });
    await flushMicrotasks();

    expect(byId("qqmusic-status").textContent).toBe("尚未读取");
    expect(byId("qqmusic-track").textContent).toBe("");
    expect(byId("music-status-dot").classList.contains("is-connected")).toBe(false);

    // Re-entering music issues a fresh request and renders the active state
    emitSwitchSection("music");
    expect(visiblePanelIds()).toEqual(["music-panel"]);
    expect(musicGetStatus).toHaveBeenCalledTimes(2);

    freshMusicStatus.resolve({
      available: true,
      playbackStatus: "playing",
      title: "稻香",
      artist: "周杰伦",
      albumTitle: "魔杰座",
      canPlay: false,
      canPause: true,
      canNext: true,
      canPrev: true,
    });
    await flushMicrotasks();

    expect(byId("qqmusic-status").textContent).toBe("QQ Music：playing");
    expect(byId("qqmusic-track").textContent).toBe("稻香 · 周杰伦 · 魔杰座");
    expect(byId("music-status-dot").classList.contains("is-connected")).toBe(true);
  });

  it("lazy-loads usage, subagents, and memory-graph views via IPC onSwitchSection", async () => {
    const tokenUsageHistory = vi.fn(async () => createUsageHistoryFixture());
    const getAgentRouting = vi.fn(async () => createAgentRoutingFixture());
    const musicGetStatus = vi.fn<() => Promise<QqMusicState>>(async () => ({
      available: false,
      errorCode: "QQ_MUSIC_NOT_RUNNING",
    }));

    const { emitSwitchSection } = await mountSettingsPage({
      settings: { getAgentRouting },
      music: { getStatus: musicGetStatus, control: vi.fn() },
      tokenUsage: { history: tokenUsageHistory },
      memoryPanel: {
        getState: vi.fn(async () => ({
          backendStatus: { available: true },
          facts: [],
          candidates: [],
          coverage: { status: "unmeasured" },
        })),
      },
    });

    expect(visiblePanelIds()).toEqual(["general-form"]);
    expect(activeNavSections()).toEqual(["general"]);
    expect(tokenUsageHistory).toHaveBeenCalledTimes(0);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);
    expect(byId("usage-history-panel").textContent).toBe("");
    expect(byId("agent-routing-panel").textContent).toBe("");

    // Switch via IPC to usage: triggers lazy import & tokenUsage.history(7)
    emitSwitchSection("usage");
    expect(visiblePanelIds()).toEqual(["usage-panel"]);
    expect(activeNavSections()).toEqual(["usage"]);
    expect(byId("section-title").textContent).toBe("用量");
    expect(byId("section-hint").textContent).toBe(
      "看看 Token 花在了哪些模型和功能上，哪些对话最费，以及消息、技能和插件的使用次数。数据只保存在本机。",
    );

    await vi.waitFor(() => {
      expect(tokenUsageHistory).toHaveBeenCalledTimes(1);
      expect(byId("usage-history-panel").querySelector(".usage-legend__row")?.textContent).toContain("model-a");
    });
    expect(tokenUsageHistory).toHaveBeenCalledWith(7);
    expect(getAgentRouting).toHaveBeenCalledTimes(0);
    expect(musicGetStatus).toHaveBeenCalledTimes(0);

    // Switch via IPC to subagents: triggers lazy import & getAgentRouting()
    emitSwitchSection("subagents");
    expect(visiblePanelIds()).toEqual(["subagents-panel"]);
    expect(activeNavSections()).toEqual(["subagents"]);
    expect(byId("section-title").textContent).toBe("子代理");
    expect(byId("section-hint").textContent).toBe(
      "12 位专业子代理并列列出。每位可以继承主模型，也可以单独指定一个模型档案。",
    );

    await vi.waitFor(() => {
      expect(getAgentRouting).toHaveBeenCalledTimes(1);
      expect(byId("agent-routing-panel").querySelectorAll(".agent-routing-row")).toHaveLength(12);
    });
    expect(tokenUsageHistory).toHaveBeenCalledTimes(1);
    expect(musicGetStatus).toHaveBeenCalledTimes(0);

    // Switch via IPC to memory-graph: opens memory panel directly on graph view
    emitSwitchSection("memory-graph");
    expect(visiblePanelIds()).toEqual(["memory-panel"]);
    expect(activeNavSections()).toEqual(["memory"]);
    expect(byId("section-title").textContent).toBe("记忆");
    expect(byId("section-hint").textContent).toBe("管理长期记忆与画像");

    const graphBtn = byId("memory-entries-body").querySelector<HTMLButtonElement>('[data-memory-view="graph"]');
    const listBtn = byId("memory-entries-body").querySelector<HTMLButtonElement>('[data-memory-view="list"]');
    const graphWrap = byId("memory-entries-body").querySelector<HTMLElement>(".memory-graph-wrap");
    expect(graphBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(graphBtn?.classList.contains("is-active")).toBe(true);
    expect(listBtn?.getAttribute("aria-pressed")).toBe("false");
    expect(graphWrap?.hidden).toBe(false);
  });

  it("routes initial hash '#unknown-section' to general fallback and '#memory-graph' directly to memory graph view", async () => {
    await mountSettingsPage({ hash: "#unknown-section" });
    expect(visiblePanelIds()).toEqual(["general-form"]);
    expect(activeNavSections()).toEqual(["general"]);
    expect(byId("section-title").textContent).toBe("通用设置");

    cleanupSettingsPage();

    await mountSettingsPage({
      hash: "#memory-graph",
      memoryPanel: {
        getState: vi.fn(async () => ({
          backendStatus: { available: true },
          facts: [],
          candidates: [],
          coverage: { status: "unmeasured" },
        })),
      },
    });
    expect(visiblePanelIds()).toEqual(["memory-panel"]);
    expect(activeNavSections()).toEqual(["memory"]);
    expect(byId("section-title").textContent).toBe("记忆");
    expect(
      byId("memory-entries-body").querySelector('[data-memory-view="graph"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      byId("memory-entries-body").querySelector<HTMLElement>(".memory-graph-wrap")?.hidden,
    ).toBe(false);
  });
});
