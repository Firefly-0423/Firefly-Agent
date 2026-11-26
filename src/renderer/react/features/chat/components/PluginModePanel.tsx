import { AppstoreOutlined, LoadingOutlined } from "@ant-design/icons";
import { FolderPlus, PackagePlus, Plus, Puzzle, RefreshCw, SlidersHorizontal, Store } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  MarketListResult,
  MarketPluginEntry,
  MarketSourceStatus,
  PendingPluginCleanup,
  PluginListEntry,
  PluginManagementApi,
  PluginOverview,
  PluginReplaceSummary,
  PluginRuntimeStatus,
  UninstallCleanupResult,
  UninstallPluginOptions,
} from "../../../../../shared/plugin-management";
import { isNewerVersion } from "../../../../../shared/version";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { useTranslation } from "../../../i18n";
import { PanelEmpty, PanelIconButton, PanelPage, PanelPrimaryButton, PanelSidebar, PanelSidebarItem, PanelSidebarSection } from "./PanelShell";
import "./PluginModePanel.css";

interface PluginModePanelProps { api?: PluginManagementApi }
type Translate = ReturnType<typeof useTranslation>["t"];
type HeaderAction = "refresh" | "import" | "importFolder" | null;
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

const STATUS_ORDER: Record<PluginRuntimeStatus, number> = {
  running: 0,
  enabled: 1,
  starting: 2,
  restarting: 3,
  failed: 4,
  "disabled-fault": 5,
  stopping: 6,
  disabled: 7,
};
function replaceConfirmation(summary: PluginReplaceSummary, t: Translate) {
  const { current, incoming } = summary;
  const originLabel = (origin: "local" | "market") => t(origin === "market" ? "pluginPanel.replaceConfirm.originMarket" : "pluginPanel.replaceConfirm.originLocal");
  const tools = incoming.tools.map(tool => `${tool.title} (${tool.name}) · ${tool.risk.join(", ")}`);
  const lines = [
    t("pluginPanel.replaceConfirm.currentLine", {
      name: current.name, version: current.version, origin: originLabel(current.origin),
      state: t(current.enabled ? "pluginPanel.replaceConfirm.stateEnabled" : "pluginPanel.replaceConfirm.stateDisabled"),
    }),
    t("pluginPanel.replaceConfirm.incomingLine", { name: incoming.name, version: incoming.version }),
    current.origin === "market" ? t("pluginPanel.replaceConfirm.originChange") : "",
    t(current.enabled ? "pluginPanel.replaceConfirm.stateEnabledNotice" : "pluginPanel.replaceConfirm.stateDisabledNotice"),
    t("pluginPanel.enableConfirm.trustNotice"),
    incoming.native ? t("pluginPanel.enableConfirm.nativeWarning") : "",
    summary.nativeEscalation ? t("pluginPanel.replaceConfirm.nativeEscalation") : "",
    summary.addedPermissions.length > 0
      ? t("pluginPanel.replaceConfirm.newPermissions", { permissions: summary.addedPermissions.map(perm => permissionLabel(perm, t)).join(", ") })
      : t("pluginPanel.replaceConfirm.noNewPermissions"),
    tools.length > 0 ? t("pluginPanel.replaceConfirm.tools", { tools: tools.join("; ") }) : t("pluginPanel.replaceConfirm.toolsNone"),
  ];
  return {
    title: t("pluginPanel.replaceConfirm.title"),
    message: lines.filter(Boolean).join("\n\n"),
    confirmText: t("pluginPanel.replaceConfirm.confirm"),
    cancelText: t("common.cancel"),
    dangerous: true,
  };
}
const causeText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const formatCleanupFailure = (
  cleanup: UninstallCleanupResult | undefined,
  error: string | undefined,
  t: Translate,
) => {
  if (!cleanup) {
    return t("pluginPanel.deleteFailed", { error: error ?? t("pluginPanel.unknownError") });
  }
  const summary = `${t("pluginPanel.deleteCleanup.secrets")}: ${t(`pluginPanel.deleteCleanup.${cleanup.secrets}`)}；${t("pluginPanel.deleteCleanup.data")}: ${t(`pluginPanel.deleteCleanup.${cleanup.data}`)}`;
  return t("pluginPanel.deleteFailed", { error: error ? `${summary}（${error}）` : summary });
};
const isActiveStatus = (status: PluginRuntimeStatus) => status === "running" || status === "enabled";
const isTransitioningStatus = (status: PluginRuntimeStatus) =>
  status === "starting" || status === "stopping" || status === "restarting";

export function permissionLabel(permission: string, t: Translate): string {
  if (!permission.includes(".")) {
    const key = `pluginPanel.permissionLabels.${permission}`;
    const resolved = t(key, { defaultValue: permission });
    return resolved && resolved !== key ? resolved : permission;
  }
  const labels = t("pluginPanel.permissionLabels", { returnObjects: true }) as unknown;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    const value = (labels as Record<string, unknown>)[permission];
    if (typeof value === "string" && value.trim()) return value;
  }
  return permission;
}

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
  return !isActiveStatus(plugin.status);
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
  const declaredCaps = [
    ...(candidate.capabilities ?? []).map(cap => permissionLabel(cap, t)),
    ...(candidate.permissions ?? []).map(perm => permissionLabel(perm, t)),
  ];
  const lines = [
    t("pluginPanel.market.installConfirm", { action: label, name: candidate.name, version: candidate.version }),
    t(`pluginPanel.market.${!local ? "freshInstallState" : local.configuredEnabled ? "preserveEnabledState" : "preserveDisabledState"}`),
    kind === "replace" ? t("pluginPanel.market.replaceWarning") : "",
    kind === "update" ? t("pluginPanel.market.updateWarning") : "",
    candidate.native ? t("pluginPanel.enableConfirm.nativeWarning") : "",
    t("pluginPanel.market.capabilities", { capabilities: declaredCaps.join(", ") || t("pluginPanel.market.capabilitiesUnknown") }),
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
  const [pendingEnablePlugin, setPendingEnablePlugin] = useState<PluginListEntry | null>(null);
  const [pendingUninstallPlugin, setPendingUninstallPlugin] = useState<PluginListEntry | null>(null);
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
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
  const handleImportOutcome = useCallback(async (kind: "import" | "importFolder") => {
    const runner = kind === "importFolder" ? api?.importFolder : api?.importZip;
    if (!runner || !beginInstalled({ header: kind })) return;
    try {
      let response = await runner();
      if (response.installation === "needs-confirmation" && response.replace && response.confirmToken) {
        // The pending replacement is bound to the exact package shown here; declining leaves the installed plugin untouched.
        if (!await feedback.confirm(replaceConfirmation(response.replace, t))) return;
        response = await runner(response.confirmToken);
      }
      if (!response.ok && !response.canceled) {
        if (response.activation === "rolled-back") {
          setInstalledFailure(t("pluginPanel.upgradeRolledBack", { error: response.error ?? t("pluginPanel.unknownError") }));
        } else {
          setInstalledFailure(t("pluginPanel.importFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
        }
      } else if (response.ok) {
        if (response.activation === "restart-required") feedback.notice({ tone: "info", message: t("pluginPanel.restartRequired") });
      }
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else if (response.ok) await reloadInstalled();
    } catch (cause) { setInstalledFailure(t("pluginPanel.importFailed", { error: causeText(cause) })); }
    finally { endInstalled(true); }
  }, [api, feedback, reloadInstalled, t]);
  const importArchive = useCallback(() => handleImportOutcome("import"), [handleImportOutcome]);
  const importFolder = useCallback(() => handleImportOutcome("importFolder"), [handleImportOutcome]);

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
        if (isCurrent()) {
          if (response.activation === "rolled-back") {
            setMarketFailure(t("pluginPanel.market.rolledBack", { name: entry.name, error: response.error ?? t("pluginPanel.unknownError") }));
          } else {
            setMarketFailure(t("pluginPanel.market.installFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
          }
        }
      } else {
        if (isCurrent()) {
          const key = response.activation === "restart-required" ? "restartSuccess"
            : !installed ? "installSuccess" : installed.configuredEnabled ? "replacementSuccessEnabled" : "replacementSuccessDisabled";
          setMarketMessage(t(`pluginPanel.market.${key}`, { action: label, name: response.plugin.name }));
        }
        if (alive.current) {
          if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
          else await reloadInstalled();
        }
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

  const executeSetEnabled = useCallback(async (plugin: PluginListEntry, target: boolean) => {
    if (!beginInstalled({ card: `${plugin.id}:toggle` })) return;
    try {
      const response = await api!.setEnabled(plugin.id, target);
      if (!response.ok) setInstalledFailure(t("pluginPanel.toggleFailed", { error: response.error ?? t("pluginPanel.unknownError") }));
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
    } catch (cause) { setInstalledFailure(t("pluginPanel.toggleFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, reloadInstalled, t]);

  const changeEnabled = useCallback(async (plugin: PluginListEntry) => {
    const target = pluginToggleTarget(plugin);
    if (target) {
      if (!api || operationFence.current) return;
      setPendingEnablePlugin(plugin);
      return;
    }
    await executeSetEnabled(plugin, false);
  }, [api, executeSetEnabled]);

  const confirmEnable = useCallback(async () => {
    const plugin = pendingEnablePlugin;
    setPendingEnablePlugin(null);
    if (!plugin) return;
    await executeSetEnabled(plugin, true);
  }, [executeSetEnabled, pendingEnablePlugin]);

  const removeInstalled = useCallback((plugin: PluginListEntry) => {
    if (!api || plugin.source !== "user" || operationFence.current) return;
    setPendingUninstallPlugin(plugin);
  }, [api]);

  const confirmUninstall = useCallback(async (options: UninstallPluginOptions) => {
    const plugin = pendingUninstallPlugin;
    setPendingUninstallPlugin(null);
    if (!plugin || !beginInstalled({ card: `${plugin.id}:delete` })) return;
    try {
      const hasOptions = Boolean(options.deleteSecrets || options.deleteData);
      const response = hasOptions ? await api!.uninstall(plugin.id, options) : await api!.uninstall(plugin.id);
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
      if (!response.ok) {
        setInstalledFailure(formatCleanupFailure(response.cleanup, response.error, t));
      }
    } catch (cause) { setInstalledFailure(t("pluginPanel.deleteFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, pendingUninstallPlugin, reloadInstalled, t]);

  const retryCleanup = useCallback(async (item: PendingPluginCleanup) => {
    if (!beginInstalled({ card: `${item.id}:cleanup` })) return;
    try {
      const response = await api!.uninstall(item.id, {
        deleteSecrets: item.secrets === "delete_failed",
        deleteData: item.data === "delete_failed",
      });
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
      if (!response.ok) {
        setInstalledFailure(formatCleanupFailure(response.cleanup, response.error, t));
      }
    } catch (cause) { setInstalledFailure(t("pluginPanel.deleteFailed", { error: causeText(cause) })); }
    finally { endInstalled(false); }
  }, [api, reloadInstalled, t]);

  const setPermission = useCallback(async (pluginId: string, permission: string, granted: boolean): Promise<string | null> => {
    if (!api?.setPermission) return t("pluginPanel.apiUnavailable");
    try {
      const response = await api.setPermission(pluginId, permission, granted);
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
      return response.ok ? null : (response.error ?? t("pluginPanel.unknownError"));
    } catch (cause) {
      return causeText(cause);
    }
  }, [api, reloadInstalled, t]);

  const setModelRateLimit = useCallback(async (pluginId: string, limit: number): Promise<string | null> => {
    if (!api?.setModelRateLimit) return t("pluginPanel.apiUnavailable");
    try {
      const response = await api.setModelRateLimit(pluginId, limit);
      if (response.overview) replaceInstalledCatalogue(normalizePluginOverview(response.overview));
      else await reloadInstalled();
      return response.ok ? null : (response.error ?? t("pluginPanel.unknownError"));
    } catch (cause) {
      return causeText(cause);
    }
  }, [api, reloadInstalled, t]);

  const matchingMarket = marketCatalogue.plugins.filter(entry => {
    const keyword = marketQuery.trim().toLowerCase();
    return [
      entry.id,
      entry.name,
      entry.description,
      entry.author,
      ...(entry.capabilities ?? []),
      ...(entry.permissions ?? []),
      ...(entry.permissions ?? []).map(perm => permissionLabel(perm, t)),
    ]
      .some(value => value.toLowerCase().includes(keyword));
  });
  const changeView = (next: PanelView) => {
    if (next === selectedView) return;
    marketGeneration.current += 1;
    replaceMarketCatalogue({ phase: "idle", plugins: [] });
    clearMarketFeedback();
    selectView(next);
  };
  const settingsPlugin = useMemo(
    () => (settingsPluginId ? installedCatalogue.plugins.find(p => p.id === settingsPluginId) ?? null : null),
    [installedCatalogue.plugins, settingsPluginId],
  );
  return {
    overview: installedCatalogue,
    filter: installedQuery,
    setFilter: changeInstalledQuery,
    marketFilter: marketQuery,
    setMarketFilter: changeMarketQuery,
    loading: initialLoadPending,
    headerAction: headerOperation,
    error: installedFailure,
    view: selectedView,
    market: marketCatalogue,
    installingId: installCandidateId,
    marketError: marketFailure,
    marketNotice: marketMessage,
    confirmingInstall: awaitingConsent,
    anyBusy: hasOperation,
    visiblePlugins: matchingInstalled,
    visibleMarket: matchingMarket,
    pendingEnablePlugin,
    cancelEnable: () => setPendingEnablePlugin(null),
    confirmEnable,
    pendingUninstallPlugin,
    cancelUninstall: () => setPendingUninstallPlugin(null),
    confirmUninstall,
    settingsPlugin,
    openSettings: (plugin: PluginListEntry) => setSettingsPluginId(plugin.id),
    closeSettings: () => setSettingsPluginId(null),
    setPermission,
    setModelRateLimit,
    loadMarket: reloadMarket,
    refreshPlugins: rescanInstalled,
    importPlugin: importArchive,
    importFolderPlugin: importFolder,
    installFromMarket: installCandidate,
    openPlugin: openInstalled,
    togglePlugin: changeEnabled,
    deletePlugin: removeInstalled,
    retryCleanup,
    switchView: changeView,
  };
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
  const transitioning = isTransitioningStatus(plugin.status);
  const active = isActiveStatus(plugin.status);
  const faulted = plugin.status === "failed" || plugin.status === "disabled-fault";
  const canOpen = (plugin.status === "running" || plugin.status === "enabled") && plugin.canOpen;
  const canDelete = plugin.source === "user" && !transitioning;
  const showSettings = plugin.apiVersion >= 2 || Boolean(plugin.permissions?.length) || plugin.modelRateLimit !== undefined;
  const toggleText = faulted ? t("common.retry") : active ? t("pluginPanel.disable") : t("pluginPanel.enable");
  return <article className={`plugin-card-ui is-${plugin.status}`}>
    <CardMain entry={plugin} icon={plugin.icon ? <img src={plugin.icon} alt="" /> : <AppstoreOutlined />}
      status={<span className={`plugin-card-ui__status is-${plugin.status}`}>{t(`pluginPanel.status.${plugin.status}`)}</span>}
      developer={t("pluginPanel.developer", { author: plugin.author.trim() || t("pluginPanel.unknownDeveloper") })}>
      {plugin.error && <p title={plugin.error} className="plugin-card-ui__error">{plugin.error}</p>}
      {plugin.installedVersion && <p>{t("pluginPanel.versions", { installed: plugin.installedVersion, active: plugin.activeVersion ?? "—", pending: plugin.pendingVersion ?? "—" })}</p>}
      <p title={plugin.sourceId}>{t(`pluginPanel.sources.${plugin.source === "builtin" ? "builtin" : plugin.sourceKind ?? "legacy-unknown"}`)}</p>
      {plugin.restartRequired && <p role="status">{t(faulted ? "pluginPanel.restartAfterFailure" : "pluginPanel.restartRequired")}</p>}
    </CardMain>
    <div className="plugin-card-ui__actions">
      {plugin.canOpen && <button className="plugin-card-ui__button" type="button" onClick={() => void state.openPlugin(plugin)} disabled={!canOpen || state.anyBusy} title={!canOpen ? t("pluginPanel.openRequiresRunning") : t("pluginPanel.open")}>{t("pluginPanel.open")}</button>}
      {showSettings && <button className="plugin-card-ui__button" type="button" disabled={state.anyBusy} onClick={() => state.openSettings(plugin)}><SlidersHorizontal size={12} aria-hidden="true" /> {t("pluginPanel.settings.button")}</button>}
      <button className={`plugin-card-ui__button${active ? " is-enabled" : ""}`} type="button" disabled={transitioning || state.anyBusy} onClick={() => void state.togglePlugin(plugin)}>{toggleText}</button>
      <button className="plugin-card-ui__button is-danger" type="button" onClick={() => state.deletePlugin(plugin)} disabled={!canDelete || state.anyBusy} title={plugin.source === "builtin" ? t("pluginPanel.builtinCannotDelete") : t("pluginPanel.delete")}>{t("pluginPanel.delete")}</button>
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
  const details = [
    entry.description,
    t("pluginPanel.market.pluginId", { id: entry.id }),
    entry.sdk
      ? t("pluginPanel.market.sdkVersion", { sdk: entry.sdk })
      : t("pluginPanel.market.apiVersion", { version: entry.pluginApiVersion ?? t("pluginPanel.market.notDeclared") }),
    entry.permissions?.length
      ? t("pluginPanel.market.permissions", { permissions: entry.permissions.map(perm => permissionLabel(perm, t)).join(", ") })
      : "",
    entry.tools?.length
      ? t("pluginPanel.market.tools", { tools: entry.tools.map(tool => `${tool.title} (${tool.name})`).join(", ") })
      : "",
    entry.license ? t("pluginPanel.market.license", { license: entry.license }) : "",
    t("pluginPanel.market.capabilities", {
      capabilities: entry.capabilities?.map(cap => permissionLabel(cap, t)).join(", ")
        || entry.permissions?.map(perm => permissionLabel(perm, t)).join(", ")
        || t("pluginPanel.market.capabilitiesUnknown"),
    }),
    t("pluginPanel.market.executionWarning"),
  ].filter(Boolean);
  return <article className="plugin-card-ui">
    <CardMain entry={entry} icon={<AppstoreOutlined />} developer={<>
      {t("pluginPanel.developer", { author: entry.author.trim() || t("pluginPanel.unknownDeveloper") })}
      <span className="plugin-card-ui__meta-sep"> · </span>
      <span className="plugin-card-ui__downloads">{bundled ? t("pluginPanel.market.sourceBundled") : t("pluginPanel.market.downloads", { downloads: entry.downloads ?? 0 })}</span>
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

function EnableConfirmDialog({ plugin, onConfirm, onCancel, t }: {
  plugin: PluginListEntry;
  onConfirm: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const tools = plugin.tools ?? [];
  const contexts = plugin.context ?? [];
  const channels = plugin.channels ?? [];
  const permissions = plugin.permissions ?? [];
  return (
    <div className="plugin-panel__modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={t("pluginPanel.enableConfirm.title", { name: plugin.name, version: plugin.version })} className="plugin-panel__modal">
        <h3 className="plugin-panel__modal-title">{t("pluginPanel.enableConfirm.title", { name: plugin.name, version: plugin.version })}</h3>
        <p className="plugin-panel__modal-warning">{t("pluginPanel.enableConfirm.trustNotice")}</p>
        {plugin.native && <p className="plugin-panel__modal-warning is-high-risk">{t("pluginPanel.enableConfirm.nativeWarning")}</p>}
        <div className="plugin-panel__modal-section">
          <h4 className="plugin-panel__modal-section-title">{t("pluginPanel.enableConfirm.tools")}</h4>
          {tools.length > 0 ? <ul className="plugin-panel__modal-list">
            {tools.map(tool => <li key={tool.name}>{tool.title} ({tool.name}) · {tool.risk.join(", ")} · [{tool.modes.join(", ")}]</li>)}
          </ul> : <p className="plugin-panel__modal-meta">{t("pluginPanel.enableConfirm.noneDeclared")}</p>}
        </div>
        <div className="plugin-panel__modal-section">
          <h4 className="plugin-panel__modal-section-title">{t("pluginPanel.enableConfirm.context")}</h4>
          {contexts.length > 0 ? <ul className="plugin-panel__modal-list">
            {contexts.map(ctx => <li key={ctx.id}>{ctx.title} ({ctx.id}) · [{ctx.modes.join(", ")}]</li>)}
          </ul> : <p className="plugin-panel__modal-meta">{t("pluginPanel.enableConfirm.noneDeclared")}</p>}
        </div>
        <div className="plugin-panel__modal-section">
          <h4 className="plugin-panel__modal-section-title">{t("pluginPanel.enableConfirm.channels")}</h4>
          {channels.length > 0 ? <ul className="plugin-panel__modal-list">
            {channels.map(ch => <li key={ch.id}>{ch.title} ({ch.id})</li>)}
          </ul> : <p className="plugin-panel__modal-meta">{t("pluginPanel.enableConfirm.noneDeclared")}</p>}
        </div>
        <div className="plugin-panel__modal-section">
          <h4 className="plugin-panel__modal-section-title">{t("pluginPanel.enableConfirm.permissions")}</h4>
          {permissions.length > 0 ? <ul className="plugin-panel__modal-list">
            {permissions.map(perm => <li key={perm}>{permissionLabel(perm, t)}</li>)}
          </ul> : <p className="plugin-panel__modal-meta">{t("pluginPanel.enableConfirm.noneDeclared")}</p>}
        </div>
        <div className="plugin-panel__modal-actions">
          <button type="button" className="plugin-card-ui__button" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="plugin-card-ui__button is-enabled" onClick={onConfirm}>{t("pluginPanel.enableConfirm.confirm")}</button>
        </div>
      </div>
    </div>
  );
}

function UninstallConfirmDialog({ plugin, onConfirm, onCancel, t }: {
  plugin: PluginListEntry;
  onConfirm: (options: UninstallPluginOptions) => void;
  onCancel: () => void;
  t: Translate;
}) {
  const [deleteSecrets, setDeleteSecrets] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  return (
    <div className="plugin-panel__modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={t("pluginPanel.deleteConfirm", { name: plugin.name })} className="plugin-panel__modal">
        <h3 className="plugin-panel__modal-title">{t("pluginPanel.deleteConfirm", { name: plugin.name })}</h3>
        <p className="plugin-panel__modal-meta">{t("pluginPanel.deleteDesc")}</p>
        <label className="plugin-panel__checkbox-row">
          <input type="checkbox" checked={deleteSecrets} onChange={e => setDeleteSecrets(e.target.checked)} />
          <span>{t("pluginPanel.deleteSecretsOption")}</span>
        </label>
        <label className="plugin-panel__checkbox-row">
          <input type="checkbox" checked={deleteData} onChange={e => setDeleteData(e.target.checked)} />
          <span>{t("pluginPanel.deleteDataOption")}</span>
        </label>
        <div className="plugin-panel__modal-actions">
          <button type="button" className="plugin-card-ui__button" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="plugin-card-ui__button is-danger is-enabled" onClick={() => onConfirm({ deleteSecrets, deleteData })}>{t("pluginPanel.delete")}</button>
        </div>
      </div>
    </div>
  );
}

function PluginSettingsDialog({ plugin, state, onClose, t }: {
  plugin: PluginListEntry;
  state: Controller;
  onClose: () => void;
  t: Translate;
}) {
  const [rateInput, setRateInput] = useState(String(plugin.modelRateLimit ?? 10));
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogNotice, setDialogNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRateInput(String(plugin.modelRateLimit ?? 10));
  }, [plugin.id, plugin.modelRateLimit]);

  const granted = new Set(plugin.grantedPermissions ?? []);
  const permissions = Array.from(new Set([
    ...(plugin.permissions ?? []),
    ...(plugin.tools ?? []).map(tool => `tool:${tool.name}`),
    ...granted,
  ]));

  const togglePermission = async (permission: string, nextGranted: boolean) => {
    setDialogError(null);
    setDialogNotice(null);
    setSaving(true);
    const err = await state.setPermission(plugin.id, permission, nextGranted);
    setSaving(false);
    if (err) setDialogError(t("pluginPanel.settings.permissionFailed", { error: err }));
  };

  const applyRateLimit = async () => {
    setDialogError(null);
    setDialogNotice(null);
    const parsed = Math.trunc(Number(rateInput));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      setDialogError(t("pluginPanel.settings.modelRateLimitRangeError"));
      return;
    }
    setSaving(true);
    const err = await state.setModelRateLimit(plugin.id, parsed);
    setSaving(false);
    if (err) setDialogError(t("pluginPanel.settings.rateLimitFailed", { error: err }));
    else setDialogNotice(t("pluginPanel.settings.rateLimitSaved", { limit: parsed }));
  };

  return (
    <div className="plugin-panel__modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={t("pluginPanel.settings.title", { name: plugin.name })} className="plugin-panel__modal">
        <div className="plugin-card-ui__name-row">
          <h3 className="plugin-panel__modal-title">{t("pluginPanel.settings.title", { name: plugin.name })}</h3>
          <span className={`plugin-card-ui__status is-${plugin.status}`}>{t(`pluginPanel.status.${plugin.status}`)}</span>
        </div>
        <p className="plugin-panel__modal-meta">
          {plugin.id} · v{plugin.version} · {t("pluginPanel.settings.revision", { revision: plugin.revision ?? 0 })}
        </p>
        {plugin.error && <p className="plugin-panel__notice is-error">{plugin.error}</p>}
        {dialogError && <p className="plugin-panel__notice is-error">{dialogError}</p>}
        {dialogNotice && <p className="plugin-panel__notice">{dialogNotice}</p>}
        <div className="plugin-panel__modal-section">
          <h4 className="plugin-panel__modal-section-title">{t("pluginPanel.settings.permissionsTitle")}</h4>
          {permissions.length > 0 ? permissions.map(perm => (
            <label key={perm} className="plugin-panel__perm-row">
              <input
                type="checkbox"
                checked={granted.has(perm)}
                disabled={saving}
                onChange={e => void togglePermission(perm, e.target.checked)}
              />
              <span>{permissionLabel(perm, t)}</span>
            </label>
          )) : <p className="plugin-panel__modal-meta">{t("pluginPanel.settings.noPermissions")}</p>}
        </div>
        <div className="plugin-panel__modal-section">
          <label htmlFor="plugin-rate-limit-input" className="plugin-panel__modal-section-title">
            {t("pluginPanel.settings.modelRateLimitLabel")}
          </label>
          <p className="plugin-panel__modal-meta">{t("pluginPanel.settings.modelRateLimitHint")}</p>
          <div className="plugin-panel__rate-row">
            <input
              id="plugin-rate-limit-input"
              className="plugin-panel__rate-input"
              type="number"
              min={1}
              max={60}
              value={rateInput}
              disabled={saving}
              onChange={e => setRateInput(e.target.value)}
            />
            <button type="button" className="plugin-card-ui__button" disabled={saving} onClick={() => void applyRateLimit()}>
              {t("pluginPanel.settings.modelRateLimitSave")}
            </button>
          </div>
        </div>
        <div className="plugin-panel__modal-actions">
          <button type="button" className="plugin-card-ui__button" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
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
  const pendingCleanups = overview.pendingCleanups ?? [];
  return <>
    {(error || overview.issues.length > 0 || pendingCleanups.length > 0) && <div role="status" className="plugin-panel__notices">
      {error && <div className="plugin-panel__notice is-error">{error}</div>}
      {pendingCleanups.map(item => {
        const errorDetails = [item.secretsError, item.dataError].filter(Boolean).join("；");
        return <div key={`cleanup:${item.id}`} className="plugin-panel__notice is-error">
          <span>{t("pluginPanel.deleteCleanup.pendingSummary", {
            name: item.name,
            id: item.id,
            secretsStatus: t(`pluginPanel.deleteCleanup.${item.secrets}`),
            dataStatus: t(`pluginPanel.deleteCleanup.${item.data}`),
            errorSuffix: errorDetails ? `（${errorDetails}）` : "",
          })}</span>{" "}
          <button type="button" className="plugin-card-ui__button" disabled={state.anyBusy} onClick={() => void state.retryCleanup(item)}>
            {t("pluginPanel.deleteCleanup.retry")}
          </button>
        </div>;
      })}
      {overview.issues.map((issue, index) => <div key={`${issue.path ?? issue.root}:${index}`} className="plugin-panel__notice">{issue.message}</div>)}
    </div>}
    {loading ? <div className="plugin-panel__loading">{t("common.loading")}</div> : <div className="plugin-panel__grid">
      {overview.plugins.length === 0 ? <PanelEmpty icon={<Puzzle size={24} strokeWidth={1.5} />} title={t("pluginPanel.emptyTitle")} hint={t("pluginPanel.emptyHint")} suggestions={[
        { icon: <Store size={16} strokeWidth={1.6} />, title: t("pluginPanel.suggestMarket"), description: t("pluginPanel.suggestMarketDesc"), onClick: () => state.switchView("market"), disabled: !api },
        { icon: <PackagePlus size={16} strokeWidth={1.6} />, title: t("pluginPanel.suggestImport"), description: t("pluginPanel.suggestImportDesc"), onClick: () => void state.importPlugin(), disabled: !api || state.anyBusy },
        ...(api?.importFolder ? [{ icon: <FolderPlus size={16} strokeWidth={1.6} />, title: t("pluginPanel.suggestImportFolder"), description: t("pluginPanel.suggestImportFolderDesc"), onClick: () => void state.importFolderPlugin(), disabled: !api || state.anyBusy }] : []),
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
    <PanelPage title={inMarket ? t("pluginPanel.market.title") : t("pluginPanel.title")} className="plugin-panel__page"
      actions={!inMarket && api?.importFolder ? <button type="button" className="plugin-card-ui__button" disabled={!api || state.anyBusy} onClick={() => void state.importFolderPlugin()}>{t("pluginPanel.importFolder")}</button> : undefined}
      subtitle={<>
      <span className="plugin-panel__subtitle">{inMarket ? t("pluginPanel.market.subtitle") : t("pluginPanel.subtitle")}</span>
      <span className="plugin-panel__subtitle plugin-panel__registry">{inMarket ? t("pluginPanel.market.catalogHint") : t("pluginPanel.registryLink")}</span>
    </>}>
      {inMarket ? renderMarketView({ state, api, t }) : renderInstalledView({ state, api, t })}
    </PanelPage>
    {state.pendingEnablePlugin && (
      <EnableConfirmDialog plugin={state.pendingEnablePlugin} onCancel={state.cancelEnable} onConfirm={() => void state.confirmEnable()} t={t} />
    )}
    {state.pendingUninstallPlugin && (
      <UninstallConfirmDialog plugin={state.pendingUninstallPlugin} onCancel={state.cancelUninstall} onConfirm={opts => void state.confirmUninstall(opts)} t={t} />
    )}
    {state.settingsPlugin && (
      <PluginSettingsDialog plugin={state.settingsPlugin} state={state} onClose={state.closeSettings} t={t} />
    )}
  </div>;
}
export default PluginModePanel;
