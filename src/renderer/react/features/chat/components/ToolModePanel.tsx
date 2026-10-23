import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Briefcase, Code2, MessageSquare } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { PanelPage, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./ToolModePanel.css";

type ToolMode = "work" | "code" | "chat";
type TabKey = ToolMode;
type Overrides = Record<string, Partial<Record<string, boolean>>>;
interface ToolCatalogItem {
  name: string;
  id: string;
  enabled: boolean;
  description: string;
  modes: Array<"chat" | "work" | "code"> | null;
  deprecated: string | null;
  chatBuiltin?: boolean;
}
const BASE_TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" }, { key: "code", label: "Code" },
];
const CHAT_TOOL_WHITELIST = [
  "music_get_playback_status", "music_control", "weather",
  "web_search", "fetch_url", "translate", "exchange_rate", "query_expense", "recall_history",
];
const githubPaths = ["M24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4ZM0 24C0 10.7452 10.7452 0 24 0C37.2548 0 48 10.7452 48 24C48 37.2548 37.2548 48 24 48C10.7452 48 0 37.2548 0 24Z", "M19.1833 45.4716C18.9898 45.2219 18.9898 42.9973 19.1833 38.798C17.1114 38.8696 15.8024 38.7258 15.2563 38.3667C14.437 37.828 13.6169 36.1667 12.8891 34.9959C12.1614 33.8251 10.5463 33.64 9.89405 33.3783C9.24182 33.1165 9.07809 32.0496 11.6913 32.8565C14.3044 33.6634 14.4319 35.8607 15.2563 36.3745C16.0806 36.8883 18.0515 36.6635 18.9448 36.2519C19.8382 35.8403 19.7724 34.3078 19.9317 33.7007C20.1331 33.134 19.4233 33.0083 19.4077 33.0037C18.5355 33.0037 13.9539 32.0073 12.6955 27.5706C11.437 23.134 13.0581 20.2341 13.9229 18.9875C14.4995 18.1564 14.4485 16.3852 13.7699 13.6737C16.2335 13.3589 18.1347 14.1343 19.4734 16.0001C19.4747 16.0108 21.2285 14.9572 24.0003 14.9572C26.772 14.9572 27.7553 15.8154 28.5142 16.0001C29.2731 16.1848 29.88 12.7341 34.5668 13.6737C33.5883 15.5969 32.7689 18.0001 33.3943 18.9875C34.0198 19.9749 36.4745 23.1147 34.9666 27.5706C33.9614 30.5413 31.9853 32.3523 29.0384 33.0037C28.7005 33.1115 28.5315 33.2855 28.5315 33.5255C28.5315 33.8856 28.9884 33.9249 29.6465 35.6117C30.0853 36.7362 30.117 39.948 29.7416 45.247C28.7906 45.4891 28.0508 45.6516 27.5221 45.7347C26.5847 45.882 25.5669 45.9646 24.5669 45.9965C23.5669 46.0284 23.2196 46.0248 21.837 45.8961C20.9154 45.8103 20.0308 45.6688 19.1833 45.4716Z"];
function GithubIcon() {
  return <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
    {githubPaths.map((d, index) => <path key={index} d={d} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />)}
  </svg>;
}
function PlaceholderIcon() {
  return <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
    <circle stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray="6 4" cx="24" cy="24" r="16" />
    <path stroke="currentColor" strokeWidth="4" strokeLinecap="round" d="M24 16V32" />
    <path stroke="currentColor" strokeWidth="4" strokeLinecap="round" d="M16 24H32" />
  </svg>;
}
const TOOL_ICON_SVGS: Record<string, React.ReactNode> = Object.fromEntries([
  "git_status", "git_init", "git_commit", "git_switch_branch", "git_push", "git_revert",
  "search_code", "lsp", "apply_patch", "str_replace", "ast_grep_search", "ast_grep_replace", "run_shell", "run_verification",
].map(id => [id, <GithubIcon />]));
function ToolIcon({ toolId }: { toolId: string }) {
  return <span className="tool-card__icon" style={{ background: "var(--ff-bg-page, #f5f5f5)", color: "var(--ff-text-muted, #6e6e73)" }}>
    {TOOL_ICON_SVGS[toolId] ?? <PlaceholderIcon />}
  </span>;
}
function isChatToolOn(tool: ToolCatalogItem, overrides: Overrides): boolean {
  const chosen = overrides[tool.id]?.chat;
  return chosen !== undefined ? chosen : tool.chatBuiltin === true;
}
function isVisibleForMode(tool: ToolCatalogItem, mode: ToolMode, overrides: Overrides): boolean {
  const chosen = overrides[tool.id]?.[mode];
  if (chosen !== undefined) { return chosen; }
  return !tool.modes ? true : tool.modes.includes(mode);
}
function toolIsOn(tool: ToolCatalogItem, mode: TabKey, overrides: Overrides) {
  return mode === "chat" ? isChatToolOn(tool, overrides) : isVisibleForMode(tool, mode, overrides);
}

function initialChatOverrides(tools: ToolCatalogItem[], overrides: Overrides): Overrides {
  const available = new Set(tools.filter(item => !item.deprecated && item.enabled).map(item => item.id));
  const result: Overrides = { ...overrides };
  CHAT_TOOL_WHITELIST.forEach(id => {
    if (available.has(id)) result[id] = { ...(result[id] ?? {}), chat: true };
  });
  return result;
}
function useToolControls() {
  const [catalogueTools, replaceTools] = useState<ToolCatalogItem[]>([]);
  const [modeOverrides, replaceOverrides] = useState<Overrides>({});
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [selectedMode, selectMode] = useState<TabKey>("code");
  const [chatEnhancement, setChatEnhancement] = useState(false);
  const currentMode = useRef<TabKey>("code");
  currentMode.current = selectedMode;
  useEffect(() => {
    let active = true;
    const bridge = window.settings;
    Promise.all([bridge?.getToolCatalog?.() ?? Promise.resolve([]), bridge?.getToolModeOverrides?.() ?? Promise.resolve({}), bridge?.getGeneral?.() ?? Promise.resolve({})])
      .then(([catalog, saved, general]) => {
        if (!active) return;
        replaceTools(catalog as ToolCatalogItem[]);
        replaceOverrides(saved as Overrides);
        setChatEnhancement((general as { chatToolsEnabled?: boolean }).chatToolsEnabled === true);
      }).catch(cause => console.warn("[ToolModePanel] load failed:", cause))
      .finally(() => active && setCatalogueLoading(false));
    return () => { active = false; };
  }, []);
  const saveModeChoice = useCallback((toolId: string, mode: ToolMode, next: boolean) => {
    replaceOverrides(previous => ({ ...previous, [toolId]: { ...previous[toolId], [mode]: next } }));
    void window.settings?.setToolModeOverride?.(toolId, mode, next)?.catch(cause => console.warn("[ToolModePanel] set override failed:", cause));
  }, []);
  const saveChatEnhancement = useCallback((next: boolean) => {
    const hasChatOverride = Object.values(modeOverrides).some(modes => modes?.chat !== undefined);
    let payload: Record<string, unknown> = { chatToolsEnabled: next };
    let saved = modeOverrides;
    if (next && !hasChatOverride) {
      saved = initialChatOverrides(catalogueTools, modeOverrides);
      payload = { chatToolsEnabled: true, toolModeOverrides: saved };
    }
    setChatEnhancement(next);
    replaceOverrides(saved);
    void window.settings?.saveGeneral?.(payload)?.catch(cause => console.warn("[ToolModePanel] save general failed:", cause));
    if (next) { selectMode("chat"); }
    else if (currentMode.current === "chat") { selectMode("code"); }
  }, [modeOverrides, catalogueTools]);
  return { tools: catalogueTools, overrides: modeOverrides, loading: catalogueLoading, tab: selectedMode, setTab: selectMode, chatToolsEnabled: chatEnhancement, toggleMode: saveModeChoice, toggleChatTools: saveChatEnhancement };
}

function ToolCard({ tool, enabled, toggle, t }: {
  tool: ToolCatalogItem; enabled: boolean; toggle: () => void; t: ReturnType<typeof useTranslation>["t"];
}) {
  return <div className={"tool-card" + (enabled ? "" : " is-off")}>
    <ToolIcon toolId={tool.id} />
    <div className="tool-card__body">
      <div className="tool-card__name">{tool.name}{!tool.enabled && <span className="tool-card__badge">{t("toolPanel.disabledBadge")}</span>}</div>
      <div className="tool-card__desc">{tool.description.split("\n")[0] || t("toolPanel.noDescription")}</div>
    </div>
    <button onClick={toggle} className={"tool-card__pill" + (enabled ? " is-on" : "")} aria-checked={enabled} type="button" role="switch"><span className="tool-card__pill-knob" /></button>
  </div>;
}
export const ToolModePanel: React.FC = () => {
  const { t } = useTranslation();
  const controls = useToolControls();
  const { tools, overrides, loading, tab, setTab, chatToolsEnabled, toggleMode, toggleChatTools } = controls;
  const [filter, setFilter] = useState("");
  const tabs = useMemo(() => chatToolsEnabled ? [...BASE_TABS, { key: "chat" as TabKey, label: "Chat" }] : BASE_TABS, [chatToolsEnabled]);
  const visibleTools = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const usable = tools.filter(item => !item.deprecated);
    const enabled = usable.filter(item => item.enabled);
    const matches = keyword ? enabled.filter(item => item.id.toLowerCase().includes(keyword)
      || item.name.toLowerCase().includes(keyword) || item.description.toLowerCase().includes(keyword)) : enabled;
    return [...matches].sort((left, right) => {
      const leftOn = toolIsOn(left, tab, overrides), rightOn = toolIsOn(right, tab, overrides);
      return leftOn !== rightOn ? (leftOn ? -1 : 1) : left.id.localeCompare(right.id);
    });
  }, [tools, overrides, filter, tab]);
  return <div className="tool-panel">
    <PanelSidebar title={t("toolPanel.title")} search={{ value: filter, onChange: setFilter, placeholder: t("toolPanel.searchPlaceholder"), className: "tool-panel__search" }}>
      <PanelSidebarSection title={t("toolPanel.modeSection")}>{tabs.map(item => {
        const Icon = item.key === "code" ? Code2 : item.key === "work" ? Briefcase : MessageSquare;
        return <PanelSidebarItem key={item.key} label={item.label} active={tab === item.key} onClick={() => setTab(item.key)} icon={<Icon size={15} strokeWidth={1.6} />} />;
      })}</PanelSidebarSection>
    </PanelSidebar>
    <PanelPage title={t("toolPanel.title")} className="tool-panel__page" subtitle={<span className="tool-panel__subtitle">{t("toolPanel.subtitle", { mode: tabs.find(item => item.key === tab)?.label })}</span>}>
      <div className="tool-panel__master">
        <div className="tool-panel__master-text"><strong>{t("toolPanel.chatEnhanceTitle")}</strong><span>{t("toolPanel.chatEnhanceDesc")}</span></div>
        <button className={"tool-card__pill tool-panel__master-pill" + (chatToolsEnabled ? " is-on" : "")} onClick={() => toggleChatTools(!chatToolsEnabled)} type="button" role="switch" aria-label={t("toolPanel.chatEnhanceTitle")} aria-checked={chatToolsEnabled}>
          <span className="tool-card__pill-knob" />
        </button>
      </div>
      {loading ? <div className="tool-panel__loading">{t("common.loading")}</div> : <div className="tool-panel__grid">
        {visibleTools.map(tool => {
          const enabled = toolIsOn(tool, tab, overrides);
          return <ToolCard key={tool.id} tool={tool} enabled={enabled} t={t} toggle={() => toggleMode(tool.id, tab, !enabled)} />;
        })}
        {visibleTools.length === 0 && <div className="tool-panel__empty">{t("toolPanel.noMatch")}</div>}
      </div>}
    </PanelPage>
  </div>;
};
export default ToolModePanel;
