import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import { Briefcase, Code2, Library, RefreshCw, Store } from "lucide-react";
import { PanelIconButton, PanelPage, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./SkillModePanel.css";
import { ExternalSkillsCommitContext, ExternalSkillsPanel, useSkillConfirmationFocus } from "./ExternalSkillsPanel";

type SkillMode = "work" | "code";
type TabKey = SkillMode;
type SkillSource = "builtin" | "user";

type SkillCatalogItem = {
  references: string[];
  version?: string;
  modes: SkillMode[] | null;
  source: SkillSource;
  enabled: boolean;
  /** 这段英文描述对应的中文译文（如果已经保存过）。 */
  descriptionZh?: string;
  description: string;
  name: string;
  id: string;
};

type Overrides = Record<string, Partial<Record<SkillMode, boolean>>>;

const TABS: Array<{ key: TabKey; label: string }> = (["work", "code"] as const).map((key) => ({ key, label: key === "work" ? "Work" : "Code" }));

const SOURCE_OPTIONS: Array<{ key: "all" | SkillSource; labelKey: string }> = ([
  ["all", "skillPanel.sourceAll"],
  ["builtin", "skillPanel.sourceBuiltin"],
  ["user", "skillPanel.sourceUser"],
] as const).map(([key, labelKey]) => ({ key, labelKey }));

// 每个 skill 专属 SVG 图标的占位表，键为 skill id，目前尚未配置。
const SKILL_ICON_SVGS: Record<string, React.ReactNode> = {};

/** 刷新图标的描边参数，所有路径共用。 */
const REFRESH_STROKE = { stroke: "currentColor", strokeWidth: "4", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const RefreshIcon = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17" {...REFRESH_STROKE} />
    <path d="M42 8V17H33" {...REFRESH_STROKE} />
  </svg>
);

function PlaceholderIcon({ name }: { name: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "S";
  return <span className="skill-card__icon-letter">{letter}</span>;
}

/** 把 id 折算成 0–359 的色相：每个字符按 31 进制累加。 */
function hashHue(id: string): number {
  return [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);
}

function SkillIcon({ skillId, name }: { skillId: string; name: string }) {
  const hue = hashHue(skillId);
  const palette = { background: `hsl(${hue}, 82%, 94%)`, color: `hsl(${hue}, 55%, 42%)` };
  return (
    <span className="skill-card__icon" style={palette}>
      {SKILL_ICON_SVGS[skillId] ?? <PlaceholderIcon name={name} />}
    </span>
  );
}

/** 与主进程 getEnabledForMode 保持一致的可见性判断，这里是前端的镜像实现。 */
function isVisibleForMode(skill: SkillCatalogItem, mode: SkillMode, overrides: Overrides): boolean {
  const override = overrides[skill.id]?.[mode];
  if (override !== undefined) return override;
  return skill.modes ? skill.modes.includes(mode) : true;
}

export const SkillModePanel: React.FC = () => {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [catalog, setCatalog] = useState<SkillCatalogItem[]>([]);
  const loadGeneration = useRef(0);
  const refreshInFlight = useRef(false);
  const pendingSaves = useRef(new Set<string>());
  const [savingKeys, setSavingKeys] = useState<ReadonlySet<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<"all" | SkillSource>("all");
  const [tab, setTab] = useState<TabKey>("code");
  const [view, setView] = useState<"installed" | "external">("installed");
  const [committing, setCommitting] = useState(false);
  const commitInFlight = useRef(false);
  const setCommitBusy = useCallback((busy: boolean) => { commitInFlight.current = busy; setCommitting(busy); }, []);
  const [enableCandidate, setEnableCandidate] = useState<SkillCatalogItem>();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const enableInFlight = useRef(false), alive = useRef(false);
  const enableDialog = useRef<HTMLDivElement>(null), enableOpener = useRef<HTMLElement>(null);
  const modeButtons = useRef(new Map<string, HTMLButtonElement>());
  const closeEnable = useCallback(() => { if (!enableInFlight.current) setEnableCandidate(undefined); }, []);
  useSkillConfirmationFocus(enableDialog, !!enableCandidate, enableOpener, closeEnable, enabling);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const api = window.settings;
    if (!api?.getSkillCatalog || !api?.getSkillModeOverrides) throw new Error("SKILL_CATALOG_UNAVAILABLE");
    const [cat, ov] = await Promise.all([
      api?.getSkillCatalog?.() ?? Promise.resolve([]),
      api?.getSkillModeOverrides?.() ?? Promise.resolve({}),
    ]);
    if (generation === loadGeneration.current) {
      setCatalog(cat as SkillCatalogItem[]);
      setOverrides(ov as Overrides);
      setLoadFailed(false);
    }
  }, []);

  // Opening the page translates descriptions that still have no Chinese, once, with the default model.
  const [translating, setTranslating] = useState(false);
  const [zh, setZh] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!catalog.some(skill => !skill.descriptionZh && skill.description.trim())) return;
    const translate = (window.settings as { translateSkillDescriptions?: () => Promise<{ translated?: Record<string, string> }> } | undefined)?.translateSkillDescriptions;
    if (!translate) return;
    let active = true;
    setTranslating(true);
    void translate().then(result => { if (active && result?.translated) setZh(result.translated); }).catch(() => undefined)
      .finally(() => { if (active) setTranslating(false); });
    return () => { active = false; };
  }, [catalog]);

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    setLoading(true);
    load()
      .catch(() => { if (!cancelled) setLoadFailed(true); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; alive.current = false; loadGeneration.current++; };
  }, [load]);

  const handleRefresh = useCallback(async () => {
    if (refreshInFlight.current || pendingSaves.current.size || commitInFlight.current || enableInFlight.current) return;
    setRefreshing(true);
    refreshInFlight.current = true;
    loadGeneration.current++;
    try {
      const outcome = await window.settings?.rescanSkills?.();
      if (outcome && !outcome.ok) console.warn("[SkillModePanel] rescan failed:", outcome.error);
      await load();
    } catch (err) {
      setLoadFailed(true);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [load]);

  const toggleMode = useCallback(async (skillId: string, mode: SkillMode, next: boolean) => {
    const key = `${skillId}/${mode}`;
    if (loading || refreshInFlight.current || pendingSaves.current.has(key)) return;
    // An obsolete initial read must not replace a newer explicit user choice.
    loadGeneration.current++;
    // A synchronous admission fence also catches repeat clicks before React renders.
    pendingSaves.current.add(key);
    setSavingKeys(new Set(pendingSaves.current));
    const previous = overrides[skillId]?.[mode];
    setSaveErrors(prev => { const updated = { ...prev }; delete updated[key]; return updated; });
    setOverrides((prev) => ({
      ...prev,
      [skillId]: { ...prev[skillId], [mode]: next },
    }));
    try {
      const result = await window.settings?.setSkillModeOverride?.(skillId, mode, next);
      if (result?.ok !== true) throw new Error("SKILL_MODE_SAVE_FAILED");
    } catch {
      // Restore only this failed key; another mode may have saved in the meantime.
      setOverrides(prev => {
        const updated = { ...prev }, modes = { ...prev[skillId] };
        if (previous === undefined) delete modes[mode]; else modes[mode] = previous;
        if (Object.keys(modes).length) updated[skillId] = modes; else delete updated[skillId];
        return updated;
      });
      setSaveErrors(prev => ({ ...prev, [key]: t("skillPanel.saveFailed", { skill: skillId, mode: mode === "code" ? "Code" : "Work" }) }));
    } finally {
      pendingSaves.current.delete(key);
      setSavingKeys(new Set(pendingSaves.current));
    }
  }, [loading, overrides, t]);

  const confirmEnable = async () => {
    if (!enableCandidate || enableInFlight.current || pendingSaves.current.size) return;
    const candidate = enableCandidate, generation = ++loadGeneration.current;
    enableInFlight.current = true; setEnabling(true); setEnableError("");
    try {
      const result = await window.settings?.setSkillEnabled?.(candidate.id, true);
      if (result?.ok !== true) throw new Error("SKILL_ENABLE_FAILED");
      if (!alive.current || generation !== loadGeneration.current) return;
      enableOpener.current = modeButtons.current.get(candidate.id) ?? enableOpener.current;
      setCatalog(previous => previous.map(skill => skill.id === candidate.id ? { ...skill, enabled: true } : skill));
      setEnableCandidate(undefined);
    } catch {
      if (alive.current && generation === loadGeneration.current) {
        setEnableError(t("skillPanel.enableFailed", { skill: candidate.name })); setEnableCandidate(undefined);
      }
    } finally {
      enableInFlight.current = false;
      if (alive.current && generation === loadGeneration.current) setEnabling(false);
    }
  };

  const visibleSkills = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    // 全局的启用状态始终可见，与每个模式的覆盖设置互不影响
    const inSource = catalog.filter((s) => source === "all" || s.source === source);
    const matchesKeyword = (s: SkillCatalogItem) => [s.id, s.name, s.description, zh[s.id] ?? s.descriptionZh ?? ""]
      .some((field) => field.toLowerCase().includes(keyword));
    const searched = keyword ? inSource.filter(matchesKeyword) : inSource;
    // 当前模式下可见的排在前面，同组内按 id 排序
    return [...searched].sort((a, b) => {
      const aVisible = isVisibleForMode(a, tab, overrides);
      const bVisible = isVisibleForMode(b, tab, overrides);
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [catalog, overrides, filter, source, tab]);

  return (
    <div className="skill-panel">
      <PanelSidebar
        title={t("skillPanel.title")}
        actions={<PanelIconButton label={t("skillPanel.rescan")} disabled={view === "external" || loading || refreshing || savingKeys.size > 0 || enabling || committing} onClick={handleRefresh}>
          <RefreshCw size={15} strokeWidth={1.7} className={refreshing ? "ff-spin" : undefined} aria-hidden="true" />
        </PanelIconButton>}
        search={view === "external" ? undefined : { value: filter, onChange: setFilter, placeholder: t("skillPanel.searchPlaceholder"), className: "skill-panel__search" }}
      >
        <div className="skill-panel__views" aria-label={t("skillPanel.views")} role="group">
          <PanelSidebarSection>
            <PanelSidebarItem icon={<Library size={15} strokeWidth={1.6} />} label={t("skillPanel.installed")} count={catalog.length} active={view === "installed"}
              disabled={committing || enabling} onClick={() => { if (!commitInFlight.current && !enableInFlight.current) setView("installed"); }} />
            <PanelSidebarItem icon={<Store size={15} strokeWidth={1.6} />} label={t("skillPanel.marketplace")} active={view === "external"}
              disabled={committing || enabling} onClick={() => { if (commitInFlight.current || enableInFlight.current) return; setEnableCandidate(undefined); setView("external"); }} />
          </PanelSidebarSection>
        </div>
        {view === "installed" && (
          <>
            <PanelSidebarSection title={t("skillPanel.modeSection")}>
              {TABS.map(tabItem => (
                <PanelSidebarItem key={tabItem.key} icon={tabItem.key === "code" ? <Code2 size={15} strokeWidth={1.6} /> : <Briefcase size={15} strokeWidth={1.6} />}
                  label={tabItem.label} active={tab === tabItem.key} onClick={() => setTab(tabItem.key)} />
              ))}
            </PanelSidebarSection>
            <PanelSidebarSection title={t("skillPanel.sourceSection")}>
              {SOURCE_OPTIONS.map(opt => (
                <PanelSidebarItem key={opt.key} label={t(opt.labelKey)} active={source === opt.key} onClick={() => setSource(opt.key)} />
              ))}
            </PanelSidebarSection>
          </>
        )}
      </PanelSidebar>
      <PanelPage
        className="skill-panel__page"
        title={view === "external" ? t("skillPanel.marketplace") : t("skillPanel.title")}
        subtitle={<span className="skill-panel__subtitle">{view === "external" ? t("externalSkills.subtitle") : t("skillPanel.subtitle", { mode: TABS.find((item) => item.key === tab)?.label })}</span>}
      >

      <div role="status" aria-live="polite">
        {Object.entries(saveErrors).map(([key, message]) => <p key={key} className="skill-panel__subtitle">{message}</p>)}
        {enableError && <p>{enableError}</p>}
        {loadFailed && <p>{t("skillPanel.loadFailed")}</p>}
      </div>

      {view === "external" ? <ExternalSkillsCommitContext.Provider value={setCommitBusy}><ExternalSkillsPanel onImported={load} /></ExternalSkillsCommitContext.Provider> : <>

      {loading ? (
        <div className="skill-panel__loading">{t("common.loading")}</div>
      ) : (
        <div className="skill-panel__list">
          {translating && <p className="skill-panel__translating" role="status">{t("skillPanel.translating")}</p>}
          {visibleSkills.map((skill) => {
            const isOn = skill.enabled && isVisibleForMode(skill, tab, overrides);
            return (
              <div key={skill.id} className={"skill-card" + (isOn ? "" : " is-off")}>
                <div className="skill-card__top">
                  <SkillIcon skillId={skill.id} name={skill.name} />
                  <div className="skill-card__body">
                    <div className="skill-card__name">
                      {skill.name}
                      {!skill.enabled && <span className="skill-card__badge">{t("skillPanel.disabledBadge")}</span>}
                    </div>
                    <div className="skill-card__meta">
                      <span className={`skill-card__source skill-card__source--${skill.source}`}>
                        {t(skill.source === "builtin" ? "skillPanel.sourceBuiltin" : "skillPanel.sourceUser")}
                      </span>
                      {skill.version ? <span className="skill-card__version">v{skill.version}</span> : null}
                    </div>
                  </div>
                  <button
                    ref={node => { if (node) modeButtons.current.set(skill.id, node); else modeButtons.current.delete(skill.id); }}
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    aria-busy={savingKeys.has(`${skill.id}/${tab}`)}
                    aria-label={t("skillPanel.modeVisibility", { skill: skill.name, mode: tab === "code" ? "Code" : "Work" })}
                    disabled={!skill.enabled || refreshing || enabling || savingKeys.has(`${skill.id}/${tab}`)}
                    className={`skill-card__pill${isOn ? " is-on" : ""}`}
                    onClick={() => toggleMode(skill.id, tab, !isOn)}
                  >
                    <span className="skill-card__pill-knob" />
                  </button>
                  {!skill.enabled && <button type="button" className="skill-card__enable" disabled={refreshing || enabling || savingKeys.size > 0} onClick={event => { enableOpener.current = event.currentTarget; setEnableError(""); setEnableCandidate(skill); }}>{t("skillPanel.enable")}</button>}
                </div>
                <div className="skill-card__desc">
                  {(zh[skill.id] ?? skill.descriptionZh ?? skill.description).split("\n")[0] || t("skillPanel.noDescription")}
                </div>
              </div>
            );
          })}
          {visibleSkills.length === 0 && <div className="skill-panel__empty">{t("skillPanel.noMatch")}</div>}
        </div>
      )}
      </>}
      </PanelPage>
      {enableCandidate && <div className="skill-panel__confirm-overlay">
        <div ref={enableDialog} role="dialog" aria-modal="true" aria-labelledby="skill-enable-title"
          tabIndex={-1} className="skill-panel__confirm">
          <h2 id="skill-enable-title">{t("skillPanel.enableTitle", { skill: enableCandidate.name })}</h2>
          <p>{t("skillPanel.enableNotice")}</p>
          <div>
            <button type="button" disabled={enabling} onClick={closeEnable}>{t("common.cancel")}</button>
            <button type="button" disabled={enabling} onClick={() => void confirmEnable()}>{t("skillPanel.confirmEnable")}</button>
          </div>
        </div>
      </div>}
    </div>
  );
};

export default SkillModePanel;
