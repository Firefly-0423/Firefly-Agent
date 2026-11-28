import type {} from "../../global";
import { t } from "../i18n";
import { apiForm, apiRuntimeForm } from "../api/dom";
import { appearanceForm } from "../appearance/dom";
import { loadChannelsPanel } from "../channels/panel";
import { generalForm } from "../general/dom";
import { showMemoryView } from "../memory/entries-panel";
import { refreshShadowPanel } from "../memory/panel";
import { disposeMusicPanel, loadMusicPanel } from "../music/qqmusic-panel";
import { loadSchedulerPanel } from "../scheduler/panel";
import { bindSettingsNavigation, resolveSettingsSection, updateSettingsNavigation } from "./navigation";
import { disclaimerPanel, fireflyPanel, placeholderCopy, placeholderIcon, placeholderPanel, placeholderTitle, pluginsPanel, preferencesForm, sectionHint, sectionTitle } from "./shell";

const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = Object.fromEntries([
  ["usage", "", t("settings.usage.title"), t("settings.usage.hint")],
  ["subagents", "", t("settings.subagents.title"), t("settings.subagents.hint")],
  ["asr", "🎙", t("settings.desktopAsr.title"), t("settings.desktopAsr.hint")],
  ["memory", `<img src="../avatars/firefly-avatar.png" width="24" height="24" alt="" aria-hidden="true" style="vertical-align:-3px" />`, t("settings.nav.memory"), t("settings.nav.memoryHint")],
  ["chat", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M33 38H22V30H36V22H44V38H39L36 41L33 38Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 6H36V30H17L13 34L9 30H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 18H20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M26 18H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 18H13" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`, t("settings.nav.chat"), t("settings.nav.chatHint")],
  ["user", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M44 8H4V38H19L24 43L29 38H44V8Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="19" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 32C33 27.5817 28.9706 24 24 24C19.0294 24 15 27.5817 15 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, t("settings.nav.user"), t("settings.nav.userHint")],
  ["tasks", `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, t("settings.nav.tasks"), t("settings.nav.tasksHint")],
  ["plugins", "🔌", t("settings.nav.plugins"), t("settings.nav.pluginsHint")],
  ["mcp", "🧩", t("settings.nav.mcp"), t("settings.mcpUi.hint")],
  ["preferences", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>偏好设置</title><path d="M12 35.0137H9H4V8.01273C4 6.90868 4.89543 6.01367 6 6.01367H42C43.1046 6.01367 44 6.90868 44 8.01273V35.0137H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 32L14 42H34L24 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "偏好设置", "设置聊天窗口和输出行为的默认偏好"],
  ["appearance", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>外观设置</title><path d="M24 44C29.9601 44 26.3359 35.136 30 31C33.1264 27.4709 44 29.0856 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M28 17C29.6569 17 31 15.6569 31 14C31 12.3431 29.6569 11 28 11C26.3431 11 25 12.3431 25 14C25 15.6569 26.3431 17 28 17Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 21C17.6569 21 19 19.6569 19 18C19 16.3431 17.6569 15 16 15C14.3431 15 13 16.3431 13 18C13 19.6569 14.3431 21 16 21Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M17 34C18.6569 34 20 32.6569 20 31C20 29.3431 18.6569 28 17 28C15.3431 28 14 29.3431 14 31C14 32.6569 15.3431 34 17 34Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "外观设置", "调整窗口布局、界面主题与流萤桌宠"],
  ["general", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>通用设置</title><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "通用设置", t("settings.nav.generalHint")],
  ["api", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>API 设置</title><g clip-path="url(#api-key-nav-clip)"><circle cx="15" cy="33" r="8" fill="none" stroke="currentColor" stroke-width="4"/><path d="M29 16L35.5 22" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 26L37 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 11L42 17.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g><defs><clipPath id="api-key-nav-clip"><rect width="48" height="48" fill="none"/></clipPath></defs></svg>`, "API 设置", "选择预设后只需要填写 API Key。"],
  ["api-advanced", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>高级设置</title><path d="M34.0003 41L44 24L34.0003 7H14.0002L4 24L14.0002 41H34.0003Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, "高级设置", "配置 API 超时时间、调用模式．"],
  ["firefly", "🌸", t("settings.nav.firefly"), t("settings.nav.fireflyHint")],
  ["disclaimer", `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>免责声明</title><rect x="13" y="10" width="28" height="34" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M35 10V4H8C7.44772 4 7 4.44772 7 5V38H13" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 22H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 30H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, "免责声明", "使用条款与隐私说明"],
].map(([section, emoji, title, hint]) => [section, { emoji, title, hint }]));

/** Reads the usage history each time the page is opened, so it never shows stale numbers. */
async function loadUsage(): Promise<void> {
  const host = document.getElementById("usage-history-panel");
  if (!host) return;
  const { loadUsagePanel } = await import("../usage/panel");
  await loadUsagePanel(host, (window as typeof window & { tokenUsage?: import("../usage/panel").UsageBridge }).tokenUsage ?? {});
}

/** Reads the 12 sub-agents and their model choice each time the page is opened, so it never shows a stale selection. */
async function loadSubagents(): Promise<void> {
  const host = document.getElementById("agent-routing-panel");
  if (!host || !window.settings) return;
  const { loadAgentRoutingPanel } = await import("../api/agent-routing");
  await loadAgentRoutingPanel(host, window.settings);
}

export interface SectionRouter {
  switchSection: (requestedSection: string) => void;
  openInitialSection: () => void;
}

/** Creates and binds the settings section router without running top-level DOM queries on import. */
export function createSectionRouter(): SectionRouter {
  const navigationButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
  const panelSections = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"), panel => panel.dataset.panel!);

  function switchSection(requestedSection: string): void {
    const section = resolveSettingsSection(requestedSection, navigationButtons, panelSections);
    const copy = NAV_LABELS[section] ?? NAV_LABELS.api;
    sectionTitle.textContent = copy.title;
    sectionHint.textContent = copy.hint;

    const show = (key: string, panel: HTMLElement): void => {
      panel.classList.toggle("is-hidden", section !== key);
    };
    const showId = (key: string, id: string): void => {
      const panel = document.getElementById(id);
      if (panel) show(key, panel);
    };
    showId("asr", "desktop-asr-form");
    const forms: [string, HTMLElement][] = [
      ["api", apiForm], ["api-advanced", apiRuntimeForm], ["appearance", appearanceForm],
      ["general", generalForm], ["preferences", preferencesForm], ["firefly", fireflyPanel],
      ["disclaimer", disclaimerPanel],
    ];
    forms.forEach(([key, form]) => show(key, form));
    showId("memory", "memory-panel");
    if (section === "memory") void refreshShadowPanel();
    showId("user", "user-panel");
    showId("tasks", "tasks-panel");
    if (section === "tasks") void loadSchedulerPanel();
    show("plugins", pluginsPanel);
    showId("mcp", "mcp-panel");
    showId("channels", "channels-panel");
    if (section === "channels") void loadChannelsPanel();
    showId("music", "music-panel");
    if (section === "music") void loadMusicPanel();
    else disposeMusicPanel();
    showId("subagents", "subagents-panel");
    if (section === "subagents") void loadSubagents();
    showId("usage", "usage-panel");
    if (section === "usage") void loadUsage();

    const hasPanel = forms.some(([key]) => key === section) || [
      "asr", "memory", "user", "tasks", "plugins", "mcp", "channels", "music", "subagents", "usage",
    ].includes(section);
    placeholderPanel.classList.toggle("is-hidden", hasPanel);
    if (!hasPanel) {
      placeholderIcon.innerHTML = copy.emoji;
      placeholderTitle.textContent = copy.title;
      placeholderCopy.textContent = t("settings.placeholder.copy");
    }
    updateSettingsNavigation(navigationButtons, section === "music" ? "plugins" : section);
    document.querySelector(".settings-content")?.scrollTo?.({ top: 0 });
  }

  bindSettingsNavigation(navigationButtons, switchSection);

  /** "memory-graph" (from the chat's memory card) opens 流萤记忆 in its graph view. */
  function openSection(requested: string): void {
    if (requested !== "memory-graph") { switchSection(requested); return; }
    switchSection("memory"); showMemoryView("graph");
  }

  function openInitialSection(): void {
    openSection((window.location.hash || "#general").slice(1));
    window.settings?.onSwitchSection?.(section => openSection(section));
  }

  return { switchSection, openInitialSection };
}
