import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { formatContextWindowTokens } from "../../../../../shared/context-window";
import { useTranslation } from "../../../i18n";
import { PanelEmpty, PanelPage, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./ModelModePanel.css";

interface ModelProfile {
  provider: string;
  id: string;
  model: string;
  displayName?: string;
  multimodal?: boolean;
  contextWindowTokens?: number;
}
interface ModelCatalogApi {
  deleteModelProfile?: (id: string) => Promise<unknown>;
  setDefaultModelProfile?: (id: string) => Promise<unknown>;
  listModelProfiles?: () => Promise<{ profiles: ModelProfile[]; defaultModelProfileId?: string }>;
}
type Translate = ReturnType<typeof useTranslation>["t"];

const PROVIDER_ORDER = [
  "OpenAI", "Anthropic", "Google",
  "MiniMax（稀宇科技）", "GLM（智谱）", "Qwen（通义千问）",
  "DeepSeek（深度求索）", "Moonshot AI",
  "OpenRouter",
];
const providerLabels: Record<string, string> = {
  google: "Google", anthropic: "Anthropic", openai: "OpenAI",
  minimax: "MiniMax（稀宇科技）", zhipu: "GLM（智谱）",
  qwen: "Qwen（通义千问）", deepseek: "DeepSeek（深度求索）", moonshot: "Moonshot AI",
  openrouter: "OpenRouter",
};
function getProviderLabel(provider: string | undefined, fallback: string): string {
  if (!provider) { return fallback; }
  if (provider.includes("（") || provider.includes("）")) { return provider; }
  return providerLabels[provider.toLowerCase()] ?? provider;
}
function getProviderSortKey(provider: string | undefined): number {
  if (!provider) { return PROVIDER_ORDER.length; }
  const position = PROVIDER_ORDER.findIndex(label => provider.includes(label) || label.includes(provider));
  return position >= 0 ? position : PROVIDER_ORDER.length;
}
function getProviderIconUrl(provider: string | undefined): string | null {
  if (!provider) { return null; }
  const normalized = provider.toLowerCase();
  const key = (() => {
    const choices: Array<[string[], string]> = [
      [["minimax"], "minimax"], [["deepseek"], "deepseek"],
      [["glm", "智谱", "zhipu"], "glm"], [["kimi", "moonshot"], "kimi-light"],
      [["qwen", "通义", "dashscope"], "qwen"], [["openai", "chatgpt"], "openai"],
      [["anthropic", "claude"], "claude"], [["mimo", "小米"], "xiaomimimo"],
    ];
    for (const [aliases, icon] of choices) {
      if (aliases.some(alias => normalized.includes(alias))) return icon;
    }
    if (normalized.includes("openrouter")) return "custom-endpoint";
    return ["custom", "自定义", "本地模型"].some(alias => normalized.includes(alias)) ? "custom-endpoint" : null;
  })();
  return key ? `../icons/providers/${key}.svg` : null;
}

function useModelCatalogue() {
  const [savedProfiles, replaceProfiles] = useState<ModelProfile[]>([]);
  const [defaultProfileId, replaceDefaultProfileId] = useState<string>();
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const readSettingsBridge = () => (window as typeof window & { settings?: ModelCatalogApi }).settings;
  const reloadCatalogue = useCallback(async () => {
    const result = await readSettingsBridge()?.listModelProfiles?.();
    if (!result) { throw new Error("MODEL_CATALOG_UNAVAILABLE"); }
    replaceProfiles(result.profiles);
    replaceDefaultProfileId(result.defaultModelProfileId);
    setCatalogueFailed(false);
  }, []);
  useEffect(() => {
    let active = true;
    setCatalogueLoading(true);
    reloadCatalogue().catch(() => active && setCatalogueFailed(true)).finally(() => active && setCatalogueLoading(false));
    return () => { active = false; };
  }, [reloadCatalogue]);
  const selectDefault = useCallback((id: string) => {
    void readSettingsBridge()?.setDefaultModelProfile?.(id).then(reloadCatalogue).catch(() => setCatalogueFailed(true));
  }, [reloadCatalogue]);
  const remove = useCallback((id: string) => {
    void readSettingsBridge()?.deleteModelProfile?.(id).then(reloadCatalogue).catch(() => setCatalogueFailed(true));
  }, [reloadCatalogue]);
  return { profiles: savedProfiles, defaultId: defaultProfileId, loading: catalogueLoading, loadFailed: catalogueFailed, selectDefault, remove };
}

function ProfileCard({ profile, isDefault, selectDefault, remove, t }: {
  profile: ModelProfile; isDefault: boolean; t: Translate;
  selectDefault: (id: string) => void; remove: (id: string) => void;
}) {
  const icon = getProviderIconUrl(profile.provider);
  return <div className={"model-card" + (isDefault ? " is-default" : "")}>
    <span className="model-card__icon">
      {icon && <img alt="" aria-hidden="true" src={icon} width="24" height="24" style={{ objectFit: "contain" }} />}
    </span>
    <div className="model-card__body">
      <div className="model-card__name">{profile.displayName || profile.provider}
        {isDefault && <span className="model-card__badge">{t("modelPanel.badgeDefault")}</span>}
        {profile.multimodal === true && <span className="model-card__badge">{t("modelPanel.badgeMultimodal")}</span>}
        {profile.contextWindowTokens ? <span className="model-card__badge">{formatContextWindowTokens(profile.contextWindowTokens)}</span> : null}
      </div>
      <div className="model-card__meta"><span className="model-card__provider">{getProviderLabel(profile.provider, t("modelPanel.unknownProvider"))}</span></div>
      <div className="model-card__desc">{profile.model}</div>
    </div>
    <div className="model-card__actions">
      <button disabled={isDefault} type="button" onClick={() => selectDefault(profile.id)}
        title={isDefault ? t("modelPanel.currentDefault") : t("modelPanel.setDefault")}
        className={"model-card__pill" + (isDefault ? " is-on" : "")}>
        {isDefault ? t("modelPanel.badgeDefault") : t("modelPanel.setDefault")}
      </button>
      <button title={t("modelPanel.delete")} className="model-card__delete" type="button" onClick={() => remove(profile.id)}>{t("modelPanel.delete")}</button>
    </div>
  </div>;
}

export function ModelModePanel() {
  const { t } = useTranslation();
  const catalogue = useModelCatalogue();
  const { profiles, defaultId, loading, loadFailed } = catalogue;
  const [filter, setFilter] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const visibleProfiles = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const candidates = provider === null ? profiles : profiles.filter(item => getProviderLabel(item.provider, "") === provider);
    const matches = keyword ? candidates.filter(item => item.id.toLowerCase().includes(keyword)
      || item.provider.toLowerCase().includes(keyword) || item.model.toLowerCase().includes(keyword)
      || (item.displayName && item.displayName.toLowerCase().includes(keyword))) : candidates;
    return [...matches].sort((left, right) => {
      if (left.id === defaultId) return -1;
      if (right.id === defaultId) return 1;
      const leftProvider = getProviderSortKey(left.provider), rightProvider = getProviderSortKey(right.provider);
      return leftProvider !== rightProvider ? leftProvider - rightProvider : left.model.localeCompare(right.model);
    });
  }, [profiles, defaultId, filter, provider]);
  const providers = useMemo(() => {
    const totals = new Map<string, number>();
    profiles.forEach(item => {
      const label = getProviderLabel(item.provider, "");
      if (label) totals.set(label, (totals.get(label) ?? 0) + 1);
    });
    return [...totals.entries()].sort(([left], [right]) => getProviderSortKey(left) - getProviderSortKey(right) || left.localeCompare(right));
  }, [profiles]);

  let content;
  if (loading) content = <div className="model-panel__loading">{t("common.loading")}</div>;
  else if (loadFailed) content = <div role="alert" className="model-panel__empty">{t("modelPanel.loadFailed")}</div>;
  else content = <div className="model-panel__grid">
    {profiles.length === 0
      ? <PanelEmpty hint={t("modelPanel.emptyHint")} title={t("modelPanel.emptyTitle")} icon={<Cpu size={24} strokeWidth={1.5} />} />
      : visibleProfiles.map(profile => <ProfileCard key={profile.id} profile={profile} isDefault={profile.id === defaultId} t={t} selectDefault={catalogue.selectDefault} remove={catalogue.remove} />)}
    {profiles.length > 0 && visibleProfiles.length === 0 && <div className="model-panel__empty">{t("modelPanel.noMatch")}</div>}
  </div>;
  return <div className="model-panel">
    <PanelSidebar title={t("modelPanel.title")} search={{ value: filter, onChange: setFilter, placeholder: t("modelPanel.searchPlaceholder"), className: "model-panel__search" }}>
      <PanelSidebarSection><PanelSidebarItem label={t("modelPanel.allProviders")} count={profiles.length} icon={<Cpu size={15} strokeWidth={1.6} />} active={provider === null} onClick={() => setProvider(null)} /></PanelSidebarSection>
      {providers.length > 0 && <PanelSidebarSection title={t("modelPanel.providerSection")}>
        {providers.map(([label, count]) => <PanelSidebarItem label={label} key={label} active={provider === label} count={count} onClick={() => setProvider(provider === label ? null : label)} />)}
      </PanelSidebarSection>}
    </PanelSidebar>
    <PanelPage title={t("modelPanel.title")} className="model-panel__page" subtitle={<span className="model-panel__subtitle">{t("modelPanel.subtitle")}</span>}>{content}</PanelPage>
  </div>;
}

export default ModelModePanel;
