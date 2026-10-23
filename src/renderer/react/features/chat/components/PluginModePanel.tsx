import { AppstoreOutlined, LoadingOutlined } from "@ant-design/icons";
import { PackagePlus, Plus, Puzzle, RefreshCw, Store } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MarketListResult, MarketPluginEntry, MarketSourceStatus, PluginListEntry, PluginManagementApi, PluginOverview, PluginRuntimeStatus } from "../../../../../shared/plugin-management";
import { isNewerVersion } from "../../../../../shared/version";
import { useTranslation } from "../../../i18n";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { PanelEmpty, PanelIconButton, PanelPage, PanelPrimaryButton, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./PluginModePanel.css";

interface PluginModePanelProps { api?: PluginManagementApi }
type Translate = ReturnType<typeof useTranslation>["t"];
type HeaderAction = "refresh" | "import" | null;
type PanelView = "installed" | "market";
interface MarketState {
  plugins: MarketPluginEntry[];
  phase: "idle" | "loading" | "ready" | "error";
  readAt?: string;
  sources?: MarketSourceStatus[];
  error?: string;
  mode?: MarketListResult["mode"];
}
type MarketCardAction = { kind: "install" } | { kind: "update" } | { kind: "replace" }
  | { kind: "installed"; version: string } | { kind: "installedLocalNewer"; version: string };
const STATUS_ORDER: Record<PluginRuntimeStatus, number> = { running: 0, starting: 1, failed: 2, stopping: 3, disabled: 4 };
const causeText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function marketSourceLabel(url: string, t: (key: string) => string): string {
  if (url === "bundled:registry") { return t("pluginPanel.market.sourceBundled"); }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname === "gitee.com" || hostname.endsWith(".gitee.com")) { return t("pluginPanel.market.sourceGitee"); }
    if (hostname === "github.com" || hostname.endsWith(".github.com") || hostname === "raw.githubusercontent.com") { return t("pluginPanel.market.sourceGithub"); }
    return parsed.host;
  } catch { return url; }
}
export function normalizePluginOverview(value: PluginOverview | PluginListEntry[]): PluginOverview {
  if (Array.isArray(value)) return { plugins: value, issues: [] };
  return value;
}
export function pluginToggleTarget(plugin: PluginListEntry): boolean {
  return plugin.status !== "running";
}
export function resolveMarketAction(entry: MarketPluginEntry, installed: PluginListEntry | undefined): MarketCardAction {
  if (!installed) { return { kind: "install" }; }
  if (installed.pendingVersion) { return { kind: "installed", version: installed.installedVersion ?? installed.pendingVersion }; }
  if (installed.origin !== "market") { return { kind: "replace" }; }
  if (isNewerVersion(entry.version, installed.version)) { return { kind: "update" }; }
  return isNewerVersion(installed.version, entry.version)
    ? { kind: "installedLocalNewer", version: installed.version }
    : { kind: "installed", version: installed.version };
}

function marketConfirmation(candidate: MarketPluginEntry, local: PluginListEntry | undefined, kind: "install" | "replace" | "update", label: string, t: Translate) {
  const lines = [
    t("pluginPanel.market.installConfirm", { action: label, name: candidate.name, version: candidate.version }),
    t(`pluginPanel.market.${!local ? "freshInstallState" : local.configuredEnabled ? "preserveEnabledState" : "preserveDisabledState"}`),
    kind === "replace" ? t("pluginPanel.market.replaceWarning") : "",
    kind === "update" ? t("pluginPanel.market.updateWarning") : "",
    t("pluginPanel.market.capabilities", { capabilities: candidate.capabilities?.join(", ") || t("pluginPanel.market.capabilitiesUnknown") }),
    t("pluginPanel.market.executionWarning"),
  ];
  return { title: label, message: lines.filter(Boolean).join("\n\n"), confirmText: label, cancelText: t("common.cancel"), dangerous: true };
}

function usePluginController(api: PluginManagementApi | undefined, t: Translate, feedback: ReturnType<typeof useFeedback>) {
  const [installedCatalogue, replaceInstalledCatalogue] = useState<PluginOverview>({ plugins: [], issues: [] });
  const [initialLoadPending, setInitialLoadPending] = useState(true);
  const [installedQuery, changeInstalledQuery] = useState("");
  const [installedFailure, setInstalledFailure] = useState<string | null>(null);
  const [headerOperation, setHeaderOperation] = useState<HeaderAction>(null);
  const [cardOperation, setCardOperation] = useState<string | null>(null);
  const [selectedView, selectView] = useState<PanelView>("installed");
  const [marketQuery, changeMarketQuery] = useState("");
  const [marketCatalogue, replaceMarketCatalogue] = useState<MarketState>({ phase: "idle", plugins: [] });
  const [marketFailure, setMarketFailure] = useState<string | null>(null);
  const [marketMessage, setMarketMessage] = useState<string | null>(null);
  const [installCandidateId, setInstallCandidateId] = useState<string | null>(null);
  const [awaitingConsent, setAwaitingConsent] = useState(false);
  const alive = useRef(true), marketGeneration = useRef(0), overviewGeneration = useRef(0);
  const operationFence = useRef(false);
  const hasOperation = headerOperation !== null || cardOperation !== null || installCandidateId !== null;
  const clearMarketFeedback = () => { setMarketFailure(null); setMarketMessage(null); };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      marketGeneration.current += 1;
      overviewGeneration.current += 1;
    };
  }, [api]);
  const reloadInstalled = useCallback(async () => {
    if (!api) { throw new Error(t("pluginPanel.apiUnavailable")); }
    const generation = ++overviewGeneration.current;
    const response = await api.list();
    if (alive.current && generation === overviewGeneration.current) { replaceInstalledCatalogue(normalizePluginOverview(response)); }
  }, [api, t]);
  useEffect(() => {
    let active = true;
    setInitialLoadPending(true);
    setInstalledFailure(null);
    reloadInstalled().catch(cause => { if (active) setInstalledFailure(causeText(cause)); })
      .finally(() => { if (active) setInitialLoadPending(false); });
    return () => { active = false; };
  }, [reloadInstalled]);
  useEffect(() => api?.onChanged?.(next => {
    overviewGeneration.current++;
    replaceInstalledCatalogue(next);
  }), [api]);

  const reloadMarket = useCallback(async (preferred?: string) => {
    const generation = ++marketGeneration.current;
    if (!api) {
      replaceMarketCatalogue({ phase: "error", plugins: [], error: t("pluginPanel.apiUnavailable") });
      return;
    }
    replaceMarketCatalogue({ phase: "loading", plugins: [] });
    clearMarketFeedback();
    try {
      const response = await api.marketList(preferred);
      if (!alive.current || generation !== marketGeneration.current) return;
      replaceMarketCatalogue(response.ok
        ? { phase: "ready", plugins: response.plugins, sources: response.sources, mode: response.mode, readAt: new Date().toLocaleString() }
        : { phase: "error", plugins: [], error: response.error ?? t("pluginPanel.unknownError"), sources: response.sources, mode: response.mode });
    } catch (cause) {
      if (!alive.current || generation !== marketGeneration.current) return;
      replaceMarketCatalogue({ phase: "error", plugins: [], error: causeText(cause) });
    }
  }, [api, t]);
  useEffect(() => {
    if (selectedView === "market") { void reloadMarket(); }
    return () => { marketGeneration.current += 1; };
  }, [selectedView, reloadMarket]);

  const matchingInstalled = useMemo(() => {
    const keyword = installedQuery.trim().toLowerCase();
    const matches = keyword ? installedCatalogue.plugins.filter(item => item.name.toLowerCase().includes(keyword)
      || item.description.toLowerCase().includes(keyword) || item.author.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword)) : installedCatalogue.plugins;
    return [...matches].sort((left, right) => (STATUS_ORDER[left.status] - STATUS_ORDER[right.status]) || left.name.localeCompare(right.name, "zh-CN"));
  }, [installedQuery, installedCatalogue.plugins]);

  const beginInstalled = (busy: { header: Exclude<HeaderAction, null> } | { card: string }) => {
    if (!api || operationFence.current) return false;
    operationFence.current = true;
    if ("header" in busy) setHeaderOperation(busy.header); else setCardOperation(busy.card);
    setInstalledFailure(null);
    return true;
  };
  const endInstalled = (header: boolean) => {
    operationFence.current = false;
    if (header) setHeaderOperation(null); else setCardOperation(null);
  };
  const rescanInstalled = useCallback(async () => {
    if (!beginInstalled({ header: "refresh" })) return;
    try { replaceInstalledCatalogue(normalizePluginOverview(await api!.rescan())); }
    catch (cause) { setInstalledFailure(t("pluginPanel.refreshFailed", { error: causeText(cause) })); }
    finally { endInstalled(true); }
  }, [api, t]);
  const importArchive = useCallback(async () => {
    if (!beginInstalled({ header: "import" })) return;
    try {
      const response = await api!.importZip();
      if (!response.ok && !response.canceled) setInstalledFailure(t("pluginPanel.importFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
      else if (response.ok) {
        if (response.activation === "restart-required") feedback.notice({ tone: "info", message: t("pluginPanel.restartRequired") });
        if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview)); else await reloadInstalled();
      }
    } catch (cause) { setInstalledFailure(t("pluginPanel.importFailed", { error: causeText(cause) })); }
    finally { endInstalled(true); }
  }, [api, reloadInstalled, t]);
  const installCandidate = useCallback(async (entry: MarketPluginEntry) => {
    if (!api || entry.compatible === false || operationFence.current) return;
    const installed = installedCatalogue.plugins.find(item => item.id === entry.id);
    const action = resolveMarketAction(entry, installed);
    if (action.kind === "installed" || action.kind === "installedLocalNewer") return;
    operationFence.current = true;
    const generation = marketGeneration.current;
    const isCurrent = () => alive.current && generation === marketGeneration.current;
    setInstallCandidateId(entry.id);
    setAwaitingConsent(true);
    clearMarketFeedback();
    try {
      const label = t(`pluginPanel.market.${action.kind === "replace" ? "replaceInstall" : action.kind}`);
      const confirmed = await feedback.confirm(marketConfirmation(entry, installed, action.kind, label, t));
      if (!confirmed || !isCurrent()) return;
      setAwaitingConsent(false);
      const response = await api.marketInstall(entry.id);
      if (!response.ok) {
        if (isCurrent()) setMarketFailure(t("pluginPanel.market.installFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
      } else {
        if (isCurrent()) {
          const key = response.activation === "restart-required" ? "restartSuccess"
            : !installed ? "installSuccess" : installed.configuredEnabled ? "replacementSuccessEnabled" : "replacementSuccessDisabled";
          setMarketMessage(t(`pluginPanel.market.${key}`, { action: label, name: response.plugin.name }));
        }
        if (alive.current) { await reloadInstalled(); }
      }
    } catch (cause) {
      if (isCurrent()) setMarketFailure(t("pluginPanel.market.installFailed", { error: causeText(cause) }));
    } finally {
      operationFence.current = false;
      if (alive.current) { setInstallCandidateId(null); setAwaitingConsent(false); }
    }
  }, [api, feedback, installedCatalogue.plugins, reloadInstalled, t]);
  const openInstalled = useCallback(async (plugin: PluginListEntry) => {
    if (!beginInstalled({ card: `${plugin.id}:open` })) return;
    try {
      const response = await api!.open(plugin.id);
      if (!response.ok) setInstalledFailure(t("pluginPanel.openFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
    } catch (cause) { setInstalledFailure(t("pluginPanel.openFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, t]);
  const changeEnabled = useCallback(async (plugin: PluginListEntry) => {
    if (!beginInstalled({ card: `${plugin.id}:toggle` })) return;
    try {
      const response = await api!.setEnabled(plugin.id, pluginToggleTarget(plugin));
      if (!response.ok) setInstalledFailure(t("pluginPanel.toggleFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
      await reloadInstalled();
    } catch (cause) { setInstalledFailure(t("pluginPanel.toggleFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, reloadInstalled, t]);
  const removeInstalled = useCallback(async (plugin: PluginListEntry) => {
    if (!api || plugin.source !== "user" || operationFence.current) return;
    beginInstalled({ card: `${plugin.id}:delete` });
    try {
      const confirmed = await feedback.confirm({ title: t("pluginPanel.delete"), message: t("pluginPanel.deleteConfirm", { name: plugin.name }), confirmText: t("pluginPanel.delete"), cancelText: t("common.cancel"), dangerous: true });
      if (!confirmed) return;
      const response = await api.uninstall(plugin.id);
      if (!response.ok) setInstalledFailure(t("pluginPanel.deleteFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
      else if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
    } catch (cause) { setInstalledFailure(t("pluginPanel.deleteFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, feedback, reloadInstalled, t]);
  const matchingMarket = marketCatalogue.plugins.filter(entry => {
    const keyword = marketQuery.trim().toLowerCase();
    return [entry.id, entry.name, entry.description, entry.author, ...(entry.capabilities ?? [])].some(value => value.toLowerCase().includes(keyword));
  });
  const changeView = (next: PanelView) => {
    if (next === selectedView) return;
    marketGeneration.current += 1;
    replaceMarketCatalogue({ phase: "idle", plugins: [] });
    clearMarketFeedback();
    selectView(next);
  };
  return { overview: installedCatalogue, filter: installedQuery, setFilter: changeInstalledQuery, marketFilter: marketQuery, setMarketFilter: changeMarketQuery, loading: initialLoadPending, headerAction: headerOperation, error: installedFailure, view: selectedView, market: marketCatalogue, installingId: installCandidateId, marketError: marketFailure, marketNotice: marketMessage, confirmingInstall: awaitingConsent, anyBusy: hasOperation, visiblePlugins: matchingInstalled, visibleMarket: matchingMarket, loadMarket: reloadMarket, refreshPlugins: rescanInstalled, importPlugin: importArchive, installFromMarket: installCandidate, openPlugin: openInstalled, togglePlugin: changeEnabled, deletePlugin: removeInstalled, switchView: changeView };
}
type Controller = ReturnType<typeof usePluginController>;

function CardMain({ entry, icon, status, developer, children }: {
  entry: Pick<MarketPluginEntry, "name" | "version" | "description">; icon: ReactNode; status?: ReactNode; developer: ReactNode; children?: ReactNode;
}) {
  return <div className="plugin-card-ui__main">
    <span aria-hidden="true" className="plugin-card-ui__icon">{icon}</span>
    <div className="plugin-card-ui__body">
      <div className="plugin-card-ui__name-row"><strong className="plugin-card-ui__name">{entry.name}</strong><span className="plugin-card-ui__version">v{entry.version}</span>{status}</div>
      <p title={entry.description} className="plugin-card-ui__description">{entry.description}</p>
      <p className="plugin-card-ui__developer">{developer}</p>
      {children}
    </div>
  </div>;
}
function InstalledCard({ plugin, state, t }: { plugin: PluginListEntry; state: Controller; t: Translate }) {
  const transitioning = plugin.status === "starting" || plugin.status === "stopping";
  const canOpen = plugin.status === "running" && plugin.canOpen;
  const canDelete = plugin.source === "user" && !transitioning;
  const toggleText = plugin.status === "failed" ? t("common.retry") : plugin.status === "running" ? t("pluginPanel.disable") : t("pluginPanel.enable");
  return <article className={`plugin-card-ui is-${plugin.status}`}>
    <CardMain entry={plugin} icon={plugin.icon ? <img src={plugin.icon} alt="" /> : <AppstoreOutlined />}
      status={<span className={`plugin-card-ui__status is-${plugin.status}`}>{t(`pluginPanel.status.${plugin.status}`)}</span>}
      developer={t("pluginPanel.developer", { author: plugin.author.trim() || t("pluginPanel.unknownDeveloper") })}>
      {plugin.error && <p title={plugin.error} className="plugin-card-ui__error">{plugin.error}</p>}
      {plugin.installedVersion && <p>{t("pluginPanel.versions", { installed: plugin.installedVersion, active: plugin.activeVersion ?? "—", pending: plugin.pendingVersion ?? "—" })}</p>}
      <p title={plugin.sourceId}>{t(`pluginPanel.sources.${plugin.source === "builtin" ? "builtin" : plugin.sourceKind ?? "legacy-unknown"}`)}</p>
      {plugin.restartRequired && <p role="status">{t(plugin.status === "failed" ? "pluginPanel.restartAfterFailure" : "pluginPanel.restartRequired")}</p>}
    </CardMain>
    <div className="plugin-card-ui__actions">
      {plugin.canOpen && <button className="plugin-card-ui__button" type="button" onClick={() => void state.openPlugin(plugin)} disabled={!canOpen || state.anyBusy} title={!canOpen ? t("pluginPanel.openRequiresRunning") : t("pluginPanel.open")}>{t("pluginPanel.open")}</button>}
      <button className={`plugin-card-ui__button${plugin.status === "running" ? " is-enabled" : ""}`} type="button" disabled={transitioning || state.anyBusy} onClick={() => void state.togglePlugin(plugin)}>{toggleText}</button>
      <button className="plugin-card-ui__button is-danger" type="button" onClick={() => void state.deletePlugin(plugin)} disabled={!canDelete || state.anyBusy} title={plugin.source === "builtin" ? t("pluginPanel.builtinCannotDelete") : t("pluginPanel.delete")}>{t("pluginPanel.delete")}</button>
    </div>
  </article>;
}
function marketButton(action: MarketCardAction, t: Translate) {
  switch (action.kind) {
    case "install": return { label: t("pluginPanel.market.install"), primary: true, disabled: false, hint: undefined };
    case "update": return { label: t("pluginPanel.market.update"), primary: true, disabled: false, hint: undefined };
    case "replace": return { label: t("pluginPanel.market.replaceInstall"), primary: false, disabled: false, hint: t("pluginPanel.market.replaceHint") };
    case "installed": return { label: t("pluginPanel.market.installed", { version: action.version }), primary: false, disabled: true, hint: undefined };
    case "installedLocalNewer": return { label: t("pluginPanel.market.installedLocalNewer", { version: action.version }), primary: false, disabled: true, hint: undefined };
  }
}
function MarketCard({ entry, state, t }: { entry: MarketPluginEntry; state: Controller; t: Translate }) {
  const installed = state.overview.plugins.find(plugin => plugin.id === entry.id);
  const action = resolveMarketAction(entry, installed);
  const installing = state.installingId === entry.id;
  const blocked = state.anyBusy || entry.compatible === false;
  const bundled = entry.source === "bundled" || state.market.mode === "bundled" || (state.market.mode === "offline-fallback" && entry.source !== "remote");
  const compatibility = t(`pluginPanel.market.${entry.compatible === false ? "incompatible" : entry.compatible === true ? "compatible" : "compatibilityUnknown"}`);
  const button = marketButton(action, t);
  const details = [entry.description, t("pluginPanel.market.pluginId", { id: entry.id }),
    t("pluginPanel.market.apiVersion", { version: entry.pluginApiVersion ?? t("pluginPanel.market.notDeclared") }),
    t("pluginPanel.market.capabilities", { capabilities: entry.capabilities?.join(", ") || t("pluginPanel.market.capabilitiesUnknown") }),
    t("pluginPanel.market.executionWarning")];
  return <article className="plugin-card-ui">
    <CardMain entry={entry} icon={<AppstoreOutlined />} developer={<>
      {t("pluginPanel.developer", { author: entry.author.trim() || t("pluginPanel.unknownDeveloper") })}
      <span className="plugin-card-ui__meta-sep"> · </span>
      <span className="plugin-card-ui__downloads">{bundled ? t("pluginPanel.market.sourceBundled") : t("pluginPanel.market.downloads", { downloads: entry.downloads })}</span>
    </>} />
    <p className={`plugin-card-ui__compatibility${entry.compatible === false ? " is-incompatible" : ""}`}>{compatibility}</p>
    <details className="plugin-card-ui__details">
      <summary>{t("pluginPanel.market.details")}</summary>
      {details.map((value, index) => <p key={index}>{value}</p>)}
    </details>
    <div className="plugin-card-ui__actions"><button type="button" onClick={() => void state.installFromMarket(entry)}
      className={`plugin-card-ui__button${button.primary ? " is-enabled" : ""}`} disabled={button.disabled || blocked} title={entry.compatible === false ? compatibility : button.hint}>
      {installing && <LoadingOutlined spin />}
      {installing ? ` ${t(state.confirmingInstall ? "pluginPanel.market.confirming" : "pluginPanel.market.installing")}` : button.label}
    </button></div>
  </article>;
}
function renderMarketView({ state, api, t }: { state: Controller; api: PluginManagementApi | undefined; t: Translate }) {
  const { market, marketError, marketNotice, anyBusy } = state;
  const notice = market.mode === "bundled" ? t("pluginPanel.market.bundledNotice") : market.mode === "offline-fallback" ? t("pluginPanel.market.fallbackNotice") : null;
  let content;
  if (market.phase === "loading") content = <div className="plugin-panel__loading">{t("common.loading")}</div>;
  else if (market.phase === "error") content = <div className="plugin-panel__empty">
    <p>{t("pluginPanel.market.loadFailed", { error: market.error ?? t("pluginPanel.unknownError") })}</p>
    <button className="plugin-card-ui__button" type="button" disabled={!api} onClick={() => void state.loadMarket()}>{t("common.retry")}</button>
  </div>;
  else if (state.visibleMarket.length === 0) content = <div className="plugin-panel__empty">{t(market.plugins.length ? "pluginPanel.noMatch" : "pluginPanel.market.emptyHint")}</div>;
  else content = <div className="plugin-panel__grid">{state.visibleMarket.map(entry => <MarketCard key={entry.id} entry={entry} state={state} t={t} />)}</div>;
  return <>
    {market.readAt && <p className="plugin-panel__notice">{t("pluginPanel.catalogReadAt", { time: market.readAt })}</p>}
    {market.sources && market.sources.length > 0 && <div role="group" aria-label={t("pluginPanel.market.sourceSection")} className="plugin-panel__source-switch">
      <span className="plugin-panel__source-switch-label">{t("pluginPanel.market.sourceSection")}</span>
      {market.sources.map(source => {
        const status = source.used ? t("pluginPanel.market.sourceUsed") : source.ok ? t("pluginPanel.market.sourceStandby") : t("pluginPanel.market.sourceDead");
        return <button key={source.url} type="button" onClick={() => void state.loadMarket(source.url)}
          className={`plugin-panel__source-chip${source.used ? " is-used" : source.ok ? " is-standby" : " is-dead"}`}
          disabled={!api || anyBusy || market.phase === "loading" || source.url === "bundled:registry"} title={`${marketSourceLabel(source.url, t)} · ${status}`}>{marketSourceLabel(source.url, t)}</button>;
      })}
    </div>}
    {(notice || marketError || marketNotice) && <div role="status" className="plugin-panel__notices">
      {notice && <div className="plugin-panel__notice">{notice}</div>}
      {marketError && <div className="plugin-panel__notice is-error">{marketError}</div>}
      {marketNotice && <div className="plugin-panel__notice">{marketNotice}</div>}
    </div>}
    {content}
  </>;
}
function renderInstalledView({ state, api, t }: { state: Controller; api: PluginManagementApi | undefined; t: Translate }) {
  const { error, overview, loading } = state;
  return <>
    {(error || overview.issues.length > 0) && <div role="status" className="plugin-panel__notices">
      {error && <div className="plugin-panel__notice is-error">{error}</div>}
      {overview.issues.map((issue, index) => <div key={`${issue.path ?? issue.root}:${index}`} className="plugin-panel__notice">{issue.message}</div>)}
    </div>}
    {loading ? <div className="plugin-panel__loading">{t("common.loading")}</div> : <div className="plugin-panel__grid">
      {overview.plugins.length === 0 ? <PanelEmpty icon={<Puzzle size={24} strokeWidth={1.5} />} title={t("pluginPanel.emptyTitle")} hint={t("pluginPanel.emptyHint")} suggestions={[
        { icon: <Store size={16} strokeWidth={1.6} />, title: t("pluginPanel.suggestMarket"), description: t("pluginPanel.suggestMarketDesc"), onClick: () => state.switchView("market"), disabled: !api },
        { icon: <PackagePlus size={16} strokeWidth={1.6} />, title: t("pluginPanel.suggestImport"), description: t("pluginPanel.suggestImportDesc"), onClick: () => void state.importPlugin(), disabled: !api || state.anyBusy },
      ]} /> : state.visiblePlugins.map(plugin => <InstalledCard key={plugin.id} plugin={plugin} state={state} t={t} />)}
      {overview.plugins.length > 0 && state.visiblePlugins.length === 0 && <div className="plugin-panel__empty">{t("pluginPanel.noMatch")}</div>}
    </div>}
  </>;
}
export function PluginModePanel({ api: providedApi }: PluginModePanelProps) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const api = providedApi ?? window.plugins;
  const state = usePluginController(api, t, feedback);
  const inMarket = state.view === "market";
  return <div className="plugin-panel">
    <PanelSidebar title={t("pluginPanel.title")}
      actions={<PanelIconButton label={t("pluginPanel.refresh")} disabled={!api || state.anyBusy} onClick={() => void (inMarket ? state.loadMarket() : state.refreshPlugins())}>
        <RefreshCw aria-hidden="true" size={15} strokeWidth={1.7} className={state.headerAction === "refresh" || (inMarket && state.market.phase === "loading") ? "ff-spin" : undefined} />
      </PanelIconButton>}
      search={{ value: inMarket ? state.marketFilter : state.filter, onChange: inMarket ? state.setMarketFilter : state.setFilter, placeholder: t("pluginPanel.searchPlaceholder"), className: "plugin-panel__search" }}
      primary={<PanelPrimaryButton label={t("pluginPanel.add")} icon={<Plus size={15} strokeWidth={1.8} />} disabled={!api || state.anyBusy} onClick={() => void state.importPlugin()} />}>
      <PanelSidebarSection>
        <PanelSidebarItem label={t("pluginPanel.navInstalled")} icon={<Puzzle size={15} strokeWidth={1.6} />} count={state.overview.plugins.length} active={!inMarket} disabled={!api} onClick={() => state.switchView("installed")} />
        <PanelSidebarItem label={t("pluginPanel.market.toggle")} icon={<Store size={15} strokeWidth={1.6} />} active={inMarket} disabled={!api} onClick={() => state.switchView("market")} />
      </PanelSidebarSection>
    </PanelSidebar>
    <PanelPage title={inMarket ? t("pluginPanel.market.title") : t("pluginPanel.title")} className="plugin-panel__page" subtitle={<>
      <span className="plugin-panel__subtitle">{inMarket ? t("pluginPanel.market.subtitle") : t("pluginPanel.subtitle")}</span>
      <span className="plugin-panel__subtitle plugin-panel__registry">{inMarket ? t("pluginPanel.market.catalogHint") : t("pluginPanel.registryLink")}</span>
    </>}>
      {inMarket ? renderMarketView({ state, api, t }) : renderInstalledView({ state, api, t })}
    </PanelPage>
  </div>;
}
export default PluginModePanel;
