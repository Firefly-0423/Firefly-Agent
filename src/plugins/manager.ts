import path from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PluginVersionStore, type PluginVersionState, type StoredPackage, type PackageSource } from "./version-store";
import { IPC } from "../shared/ipc-channels";
import type { PluginListEntry, PluginOverview, PluginRuntimeStatus } from "../shared/plugin-management";
import { createContext, runPluginCleanup, type PluginRuntime } from "./context";
import { createPluginEventBus, qualifyHostEvent } from "./events";
import { clearPluginModuleCache, loadPlugin, scanPluginDir, inspectPluginDir, type PluginScanIssue } from "./loader";
import { commitPreparedPlugin, discardPreparedPlugin, preparePluginZip, readHostMetadataSync, removeHostMetadata, type PreparedPluginZip, } from "./installer";
import type { FireflyPlugin, PluginContext, PluginRecord, PluginSource } from "./types";
export type { PluginListEntry, PluginOverview, PluginRuntimeStatus } from "../shared/plugin-management";
export type PluginScanRoot = {
    source: PluginSource;
    path: string;
};
export type PluginReplacementRequest = {
    sourceChange?: {
        from: PackageSource;
        to: PackageSource;
    };
    version: string;
    name: string;
    id: string;
};
export type PluginManagerOptions = {
    runtime: PluginRuntime;
    scanRoots: PluginScanRoot[];
    storageRoot: string;
    saveEnabledMap: (map: Record<string, boolean>) => void;
    loadEnabledMap: () => Record<string, boolean>;
    confirmPluginReplace?: (implementation: PluginReplacementRequest) => Promise<boolean>;
    selectPluginZip?: () => Promise<string | undefined>;
    versionStore?: PluginVersionStore;
    cleanupPersistentResources?: (pluginKey: string) => Promise<void>;
    onListChanged?: () => void;
};
export type PluginImportResult = {
    overview?: PluginOverview;
    plugin?: {
        id: string;
        name: string;
        version: string;
    };
    error?: string;
    canceled?: boolean;
    activation?: "not-requested" | "restart-required" | "running" | "failed";
    installation?: "committed" | "rejected";
    ok: boolean;
};
type DisposableContext = PluginContext & {
    dispose(): Promise<void>;
    beginStop(): void;
};
type SimpleResult = {
    ok: boolean;
    error?: string;
};
type ScanOutcome = {
    records: Map<string, PluginRecord>;
    issues: PluginScanIssue[];
    failedRoots: Set<string>;
};
type UninstallResult = SimpleResult & {
    overview?: PluginOverview;
};
type InstallOptions = {
    expectedIdentity?: {
        id: string;
        version: string;
    };
    origin?: "market";
    registryId?: string;
    packageSource?: PackageSource;
};
export const PLUGIN_ACTIVATION_TIMEOUT_MS = 10000;
const ICON_MIME: Record<string, string> = Object.fromEntries([["png", "png"], ["jpg", "jpeg"], ["jpeg", "jpeg"], ["webp", "webp"], ["svg", "svg+xml"]].map(([ext, subtype]) => [`.${ext}`, `image/${subtype}`]));
const MANAGEMENT_CHANNELS = [
    IPC.PLUGINS_LIST,
    IPC.PLUGINS_SET_ENABLED,
    IPC.PLUGINS_OPEN,
    IPC.PLUGINS_RESCAN,
    IPC.PLUGINS_IMPORT_ZIP,
    IPC.PLUGINS_UNINSTALL,
];
const invalidPluginKey = (): SimpleResult => ({ ok: false, error: "id 必须是非空字符串" });
const failedResult = (failureReason: string): SimpleResult => ({ ok: false, error: failureReason });
const hasStringValue = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const loadedPackages = new Map<string, string>();
function iconData(packageRecord: PluginRecord): string | undefined {
    const imageFilename = packageRecord.manifest.icon;
    if (!imageFilename)
        return undefined;
    try {
        const mediaType = ICON_MIME[path.extname(imageFilename).toLowerCase()];
        if (!mediaType)
            return undefined;
        const imageBytes = readFileSync(path.join(packageRecord.dir, imageFilename));
        return `data:${mediaType};base64,${imageBytes.toString("base64")}`;
    }
    catch {
        return undefined;
    }
}
const failureText = (failureReason: unknown): string => (failureReason instanceof Error ? failureReason.message : String(failureReason));
function pick<T extends object, K extends keyof T>(input: T, fields: K[]): Pick<T, K> {
    const projection = {} as Pick<T, K>;
    for (const field of fields)
        projection[field] = input[field];
    return projection;
}
function inspectStoredRecord(packageStore: PluginVersionStore, pluginKey: string, storedPackage: StoredPackage): PluginRecord {
    const dir = packageStore.packageDir(pluginKey, storedPackage.key);
    const manifest = inspectPluginDir(dir).manifest;
    const valid = manifest && manifest.id === pluginKey && manifest.version === storedPackage.version;
    if (!valid)
        throw new Error("Invalid selected plugin package");
    return { manifest, dir, source: "user", fingerprint: storedPackage.key };
}
const directSubdirectory = (relativeName: string): boolean => relativeName.length > 0 && !relativeName.startsWith("..") && !path.isAbsolute(relativeName) && !relativeName.includes(path.sep);
export class PluginManager {
    private catalog = new Map<string, PluginRecord>();
    private livePlugins = new Map<string, FireflyPlugin>();
    private resourceContexts = new Map<string, DisposableContext>();
    private runtimePhases = new Map<string, PluginRuntimeStatus>();
    private diagnostics = new Map<string, string>();
    private activationCancels = new Map<string, (failureReason: Error) => void>();
    private packageStates = new Map<string, PluginVersionState>();
    private pendingPackages = new Map<string, StoredPackage>();
    private restartOnly = new Set<string>();
    private packageIssues: PluginScanIssue[] = [];
    private discoveryIssues: PluginScanIssue[] = [];
    private readonly eventBus = createPluginEventBus();
    private desiredEnablement: Record<string, boolean>;
    private initialized = false;
    private runningObservers = new Set<(pluginKey: string, active: boolean) => void>();
    private queuedWork: Promise<void> = Promise.resolve();
    constructor(private configuration: PluginManagerOptions) {
        this.desiredEnablement = configuration.loadEnabledMap() ?? {};
    }
    list(): PluginListEntry[] {
        const installRoot = this.userRootPath();
        const entries = Array.from(this.catalog.values(), (packageRecord) => this.describe(packageRecord, installRoot));
        const sourceRank = (entry: PluginListEntry): number => (entry.source === "builtin" ? 0 : 1);
        return entries.sort((a, b) => sourceRank(a) - sourceRank(b) || a.name.localeCompare(b.name, "zh-CN"));
    }
    private changed(): void {
        this.configuration.onListChanged?.();
    }
    private reject(pluginKey: string, phase: PluginRuntimeStatus, detail: string): SimpleResult {
        this.runtimePhases.set(pluginKey, phase);
        this.diagnostics.set(pluginKey, detail);
        this.changed();
        return { ok: false, error: detail };
    }
    private userRootPath(): string | undefined {
        return this.configuration.scanRoots.find((scanRoot) => scanRoot.source === "user")?.path;
    }
    private describe(packageRecord: PluginRecord, installRoot: string | undefined): PluginListEntry {
        const { id: pluginKey } = packageRecord.manifest;
        const packageState = this.packageStates.get(pluginKey);
        const phase = this.runtimePhases.get(pluginKey) ?? "disabled";
        const implementation = this.livePlugins.get(pluginKey);
        const visiblePackage = packageState?.pending ?? packageState?.selected;
        const active = phase === "running";
        const metadataOrigin = installRoot && packageRecord.source === "user" && readHostMetadataSync(installRoot, pluginKey)
            ? "market" as const
            : "local" as const;
        const hasMarketSource = ["bundled", "curated-market"].includes(visiblePackage?.source.kind ?? "");
        const packageOrigin = packageState ? (hasMarketSource ? "market" as const : "local" as const) : metadataOrigin;
        const packageProjection = packageState ? {
            installedVersion: visiblePackage?.version ?? packageRecord.manifest.version,
            selectedVersion: packageState.selected?.version ?? null,
            activeVersion: active ? packageRecord.manifest.version : null,
            pendingVersion: packageState.pending?.version ?? null,
            restartRequired: this.restartOnly.has(pluginKey) || (!!packageState.pending && !this.pendingPackages.has(pluginKey)),
            sourceId: visiblePackage?.source.sourceId,
            sourceKind: visiblePackage?.source.kind,
        }
            : {};
        return {
            id: pluginKey,
            name: packageRecord.manifest.name,
            version: visiblePackage?.version ?? packageRecord.manifest.version,
            ...packageProjection,
            ...pick(packageRecord.manifest, ["description", "author", "entry", "apiVersion"]),
            source: packageRecord.source,
            origin: packageOrigin,
            path: packageRecord.dir,
            defaultEnabled: packageRecord.manifest.defaultEnabled,
            configuredEnabled: this.isConfiguredEnabled(packageRecord),
            enabled: active,
            status: phase,
            error: this.diagnostics.get(pluginKey) ?? packageState?.error,
            hasUnregister: typeof implementation?.unregister === "function",
            canOpen: typeof implementation?.open === "function",
            icon: iconData(packageRecord),
            settingsPanel: active ? packageRecord.manifest.settingsPanel : undefined,
            settingsSection: active ? packageRecord.manifest.settingsSection : undefined,
        };
    }
    overview(): PluginOverview {
        return { plugins: this.list(), issues: [...this.discoveryIssues] };
    }
    getSettingsPanelDir(pluginKey: string): string | undefined {
        const packageRecord = this.catalog.get(pluginKey);
        if (!packageRecord?.manifest.settingsPanel)
            return undefined;
        const live = this.runtimePhases.get(pluginKey) === "running" && this.livePlugins.has(pluginKey);
        return live ? packageRecord.dir : undefined;
    }
    publishHostEvent<T = unknown>(event: string, payload: T): Promise<void> {
        return this.eventBus.emit(qualifyHostEvent(event), payload);
    }
    publishHostLifecycleBarrier<T = unknown>(event: string, payload: T): Promise<void> {
        return this.eventBus.emitLifecycleBarrier(qualifyHostEvent(event), payload);
    }
    isRunning(pluginKey: string): boolean { return this.livePlugins.has(pluginKey); }
    onRunningStateChange(observer: (pluginKey: string, active: boolean) => void): () => void {
        this.runningObservers.add(observer);
        return () => {
            this.runningObservers.delete(observer);
        };
    }
    private notifyRunningState(pluginKey: string, active: boolean): void {
        this.runningObservers.forEach((observer) => {
            try {
                observer(pluginKey, active);
            }
            catch (failureReason) {
                console.warn(`[plugins] 运行状态监听器执行失败 (${pluginKey})`, failureReason);
            }
        });
    }
    start(): Promise<void> {
        return this.enqueueOperation(async () => {
            if (this.initialized)
                return;
            this.initialized = true;
            this.registerManagementChannels();
            await this.prepareVersionStore();
            await this.doRescan(false);
            const activeKeys = this.list().filter((entry) => entry.enabled).map((entry) => entry.id);
            await this.publishHostLifecycleBarrier("plugins:ready", { pluginIds: activeKeys });
            this.changed();
        });
    }
    private registerManagementChannels(): void {
        const { runtime: host } = this.configuration;
        host.registerIpc(IPC.PLUGINS_LIST, () => this.overview());
        host.registerIpc(IPC.PLUGINS_SET_ENABLED, async (pluginKey: unknown, requestedEnabled: unknown) => {
            if (!hasStringValue(pluginKey))
                return invalidPluginKey();
            if (typeof requestedEnabled !== "boolean")
                return { ok: false, error: "enabled 必须是布尔值" };
            return this.setEnabled(pluginKey, requestedEnabled);
        });
        host.registerIpc(IPC.PLUGINS_OPEN, (pluginKey: unknown) => {
            if (!hasStringValue(pluginKey))
                return invalidPluginKey();
            return this.open(pluginKey);
        });
        host.registerIpc(IPC.PLUGINS_RESCAN, () => this.rescan());
        host.registerIpc(IPC.PLUGINS_IMPORT_ZIP, async () => {
            if (!this.configuration.selectPluginZip)
                return { ok: false, error: "当前环境不支持选择 ZIP 文件" };
            const archivePath = await this.configuration.selectPluginZip();
            if (!archivePath)
                return { ok: false, canceled: true };
            return this.installZip(archivePath);
        });
        host.registerIpc(IPC.PLUGINS_UNINSTALL, (pluginKey: unknown) => {
            if (!hasStringValue(pluginKey))
                return invalidPluginKey();
            return this.uninstall(pluginKey);
        });
    }
    rescan(): Promise<PluginOverview> {
        return this.enqueueOperation(async () => {
            const reloadEverything = !this.configuration.versionStore;
            await this.doRescan(reloadEverything);
            this.changed();
            return this.overview();
        });
    }
    setEnabled(pluginKey: string, requestedEnabled: boolean): Promise<SimpleResult> {
        if (!requestedEnabled) {
            this.activationCancels.get(pluginKey)?.(new Error(`插件 ${pluginKey} 激活已取消`));
        }
        return this.enqueueOperation(async (): Promise<SimpleResult> => {
            const packageRecord = this.catalog.get(pluginKey);
            if (!packageRecord)
                return { ok: false, error: `插件不存在: ${pluginKey}` };
            const requiresRestart = requestedEnabled && this.configuration.versionStore && packageRecord.source === "user"
                && ((!this.packageStates.get(pluginKey)?.selected && !this.pendingPackages.has(pluginKey)) || this.restartOnly.has(pluginKey));
            if (requiresRestart)
                return { ok: false, error: "插件需要完整重启应用后才能启用" };
            const savedEnablement = { ...this.desiredEnablement, [pluginKey]: requestedEnabled };
            try {
                this.configuration.saveEnabledMap(savedEnablement);
                this.desiredEnablement = savedEnablement;
            }
            catch (failureReason) {
                return { ok: false, error: `保存插件开关失败: ${failureText(failureReason)}` };
            }
            if (!requestedEnabled) {
                await this.deactivate(pluginKey);
                this.diagnostics.delete(pluginKey);
                this.runtimePhases.set(pluginKey, "disabled");
                this.changed();
                return { ok: true };
            }
            if (this.livePlugins.has(pluginKey)) {
                this.diagnostics.delete(pluginKey);
                this.runtimePhases.set(pluginKey, "running");
                return { ok: true };
            }
            try {
                await this.activate(pluginKey);
            }
            catch (failureReason) {
                return this.reject(pluginKey, "failed", failureText(failureReason));
            }
            this.changed();
            return { ok: true };
        });
    }
    open(pluginKey: string): Promise<SimpleResult> {
        return this.enqueueOperation(async (): Promise<SimpleResult> => {
            const implementation = this.livePlugins.get(pluginKey);
            if (implementation === undefined)
                return failedResult(`插件未运行: ${pluginKey}`);
            if (!implementation.open)
                return failedResult(`插件不支持打开窗口: ${pluginKey}`);
            try {
                // V8 的错误文案包含接收者名称，错误返回也需沿用既有文本。
                const plugin = implementation;
                await plugin.open!();
            }
            catch (failureReason) {
                return failedResult(failureText(failureReason));
            }
            return { ok: true };
        });
    }
    installZip(archivePath: string, configuration: InstallOptions = {}): Promise<PluginImportResult> {
        return this.enqueueOperation(async (): Promise<PluginImportResult> => {
            const installRoot = this.userRootPath();
            if (!installRoot)
                return failedResult("未配置用户插件目录");
            let stagedPackage: PreparedPluginZip;
            try {
                stagedPackage = await preparePluginZip(archivePath, installRoot, { expectedIdentity: configuration.expectedIdentity });
            }
            catch (failureReason) {
                return failedResult(`插件包校验失败: ${failureText(failureReason)}`);
            }
            const { id: pluginKey, name: displayName, version: packageVersion } = stagedPackage.manifest;
            const implementation = { id: pluginKey, name: displayName, version: packageVersion };
            const priorPackage = this.catalog.get(pluginKey);
            if (priorPackage?.source === "builtin") {
                await discardPreparedPlugin(stagedPackage);
                return failedResult(`不能用用户插件覆盖内置插件: ${pluginKey}`);
            }
            if (this.configuration.versionStore) {
                {
                    const packageStore = this.configuration.versionStore;
                    let packageCommitted = false;
                    try {
                        const sourceDescription = configuration.packageSource ?? (configuration.origin === "market"
                            ? { kind: "legacy-unknown" as const, sourceId: configuration.registryId || "unknown-market" }
                            : { kind: "local-zip" as const, sourceId: "local-zip" });
                        const input: PackageSource = {
                            ...sourceDescription,
                            archiveSha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
                        };
                        const selectedPackage = packageStore.read(implementation.id)?.selected;
                        const marketReplacement = !!selectedPackage
                            && (selectedPackage.source.kind === "local-zip" || selectedPackage.source.kind === "bundled")
                            && input.kind === "curated-market"
                            && configuration.origin === "market"
                            && configuration.expectedIdentity?.id === implementation.id
                            && configuration.expectedIdentity.version === implementation.version;
                        const replacementSource = selectedPackage && marketReplacement
                            ? { from: { ...selectedPackage.source }, to: { ...input } }
                            : undefined;
                        if (priorPackage && !(await this.configuration.confirmPluginReplace?.({ ...implementation, sourceChange: replacementSource }))) {
                            return { ok: false, canceled: true, plugin: implementation };
                        }
                        if (!priorPackage) {
                            const remainingEnablement = { ...this.desiredEnablement };
                            delete remainingEnablement[implementation.id];
                            this.configuration.saveEnabledMap(remainingEnablement);
                            this.desiredEnablement = remainingEnablement;
                        }
                        let packageState = await packageStore.stage(implementation.id, stagedPackage.pluginDir, input, {
                            confirmedSourceReplacement: priorPackage && selectedPackage && replacementSource
                                ? { selectedKey: selectedPackage.key, from: { ...selectedPackage.source }, to: { ...input } }
                                : undefined,
                        });
                        packageCommitted = true;
                        const restartRequired = !!priorPackage || loadedPackages.has(this.processKey(implementation.id));
                        if (!restartRequired) {
                            await packageStore.beginActivation(implementation.id);
                            packageState = await packageStore.finishActivation(implementation.id);
                        }
                        this.packageStates.set(implementation.id, packageState);
                        await this.doRescan(false);
                        this.changed();
                        return {
                            ok: true,
                            installation: "committed",
                            activation: restartRequired ? "restart-required" : "not-requested",
                            plugin: implementation,
                            overview: this.overview(),
                        };
                    }
                    catch (failureReason) {
                        if (packageCommitted) {
                            this.restartOnly.add(implementation.id);
                            const latestState = packageStore.read(implementation.id);
                            if (latestState)
                                this.packageStates.set(implementation.id, latestState);
                            this.diagnostics.set(implementation.id, failureText(failureReason));
                            await this.doRescan(false);
                            this.changed();
                        }
                        const failurePrefix = packageCommitted ? "插件包已保存，但状态提交失败，需要重启恢复: " : "";
                        return {
                            ok: false,
                            installation: packageCommitted ? "committed" : "rejected",
                            activation: packageCommitted ? "failed" : undefined,
                            error: `${failurePrefix}${failureText(failureReason)}`,
                            plugin: implementation,
                            overview: this.overview(),
                        };
                    }
                    finally {
                        await discardPreparedPlugin(stagedPackage);
                    }
                }
            }
            {
                const directoryExists = await lstat(path.join(installRoot, implementation.id)).then(() => true, () => false);
                if (directoryExists) {
                    let confirmed: boolean;
                    try {
                        confirmed = (await this.configuration.confirmPluginReplace?.(implementation)) ?? false;
                    }
                    catch (failureReason) {
                        await discardPreparedPlugin(stagedPackage);
                        return failedResult(`无法确认是否替换插件: ${failureText(failureReason)}`);
                    }
                    if (!confirmed) {
                        await discardPreparedPlugin(stagedPackage);
                        return { ok: false, canceled: true, plugin: implementation };
                    }
                }
                if (priorPackage?.source === "user")
                    await this.deactivate(implementation.id);
                if (!priorPackage) {
                    const { [implementation.id]: _removedPreference, ...remainingPreferences } = this.desiredEnablement;
                    try {
                        this.configuration.saveEnabledMap(remainingPreferences);
                    }
                    catch (failureReason) {
                        await discardPreparedPlugin(stagedPackage);
                        return failedResult(`初始化插件停用状态失败，未安装: ${failureText(failureReason)}`);
                    }
                    this.desiredEnablement = remainingPreferences;
                }
                const marketMetadata = configuration.origin === "market" ? { registryId: configuration.registryId ?? "" } : undefined;
                try {
                    await commitPreparedPlugin(stagedPackage, installRoot, directoryExists, { marketOrigin: marketMetadata });
                }
                catch (failureReason) {
                    await this.doRescan(false);
                    this.changed();
                    return failedResult(`安装插件失败: ${failureText(failureReason)}`);
                }
                if (configuration.origin !== "market") {
                    try {
                        await removeHostMetadata(installRoot, implementation.id);
                    }
                    catch (failureReason) {
                        console.warn(`[plugins] 清理插件 ${implementation.id} 市场来源记录失败:`, failureReason);
                    }
                }
                await this.doRescan(false);
                this.changed();
                return { ok: true, plugin: implementation, overview: this.overview() };
            }
        });
    }
    uninstall(pluginKey: string): Promise<UninstallResult> {
        return this.enqueueOperation(async () => {
            const packageRecord = this.catalog.get(pluginKey);
            if (!packageRecord)
                return { ok: false, error: `插件不存在: ${pluginKey}` };
            if (packageRecord.source !== "user")
                return { ok: false, error: `内置插件不能卸载: ${pluginKey}` };
            const installRoot = this.userRootPath();
            if (!installRoot)
                return { ok: false, error: "未配置用户插件目录" };
            if (this.configuration.versionStore) {
                const packageStore = this.configuration.versionStore;
                await this.deactivate(pluginKey);
                try {
                    const remainingEnablement = { ...this.desiredEnablement };
                    delete remainingEnablement[pluginKey];
                    this.configuration.saveEnabledMap(remainingEnablement);
                    this.desiredEnablement = remainingEnablement;
                    await this.configuration.cleanupPersistentResources?.(pluginKey);
                    await packageStore.uninstall(pluginKey);
                    this.packageStates.set(pluginKey, packageStore.read(pluginKey)!);
                    await this.doRescan(false);
                    this.changed();
                    return { ok: true, overview: this.overview() };
                }
                catch (failureReason) {
                    this.diagnostics.set(pluginKey, failureText(failureReason));
                    this.changed();
                    return { ok: false, error: failureText(failureReason) };
                }
            }
            {
                try {
                    await this.assertSafeUserPluginDirectory(packageRecord);
                }
                catch (directoryFailure) {
                    return failedResult(`拒绝卸载不安全的插件路径: ${failureText(directoryFailure)}`);
                }
                await this.deactivate(pluginKey);
                const remainingEnablement = { ...this.desiredEnablement };
                delete remainingEnablement[pluginKey];
                try {
                    this.configuration.saveEnabledMap(remainingEnablement);
                    this.desiredEnablement = remainingEnablement;
                }
                catch (failureReason) {
                    return this.reject(pluginKey, "failed", `清理插件启停记录失败，未删除目录: ${failureText(failureReason)}`);
                }
                try {
                    await this.assertSafeUserPluginDirectory(packageRecord);
                    await this.configuration.cleanupPersistentResources?.(pluginKey);
                    clearPluginModuleCache(packageRecord.dir);
                    await rm(packageRecord.dir, { recursive: true, force: false });
                }
                catch (failureReason) {
                    return this.reject(pluginKey, "disabled", `卸载插件失败（目录未删除）: ${failureText(failureReason)}`);
                }
                try {
                    await removeHostMetadata(installRoot, pluginKey);
                }
                catch (failureReason) {
                    console.warn(`[plugins] 清理插件 ${pluginKey} 市场来源记录失败:`, failureReason);
                }
                await this.doRescan(false);
                this.changed();
                return { ok: true, overview: this.overview() };
            }
        });
    }
    stop(): Promise<void> {
        this.activationCancels.forEach((cancelActivation, pluginKey) => cancelActivation(new Error(`插件 ${pluginKey} 激活已取消`)));
        return this.enqueueOperation(async () => {
            if (!this.initialized)
                return;
            await this.publishHostLifecycleBarrier("plugins:stopping", undefined);
            for (const pluginKey of [...this.livePlugins.keys()]) {
                await this.deactivate(pluginKey);
            }
            for (const channelName of MANAGEMENT_CHANNELS) {
                try {
                    this.configuration.runtime.unregisterIpc(channelName);
                }
                catch (failureReason) {
                    console.warn(`[plugins] 管理通道 ${channelName} 清理失败`, failureReason);
                }
            }
            [this.catalog, this.runtimePhases, this.diagnostics].forEach((registry) => registry.clear());
            this.discoveryIssues = [];
            this.eventBus.clear();
            this.initialized = false;
        });
    }
    private enqueueOperation<T>(work: () => Promise<T>): Promise<T> {
        const scheduled = this.queuedWork.then(work, work);
        this.queuedWork = scheduled.then(() => undefined, () => undefined);
        return scheduled;
    }
    private isConfiguredEnabled(packageRecord: PluginRecord): boolean {
        const { id: pluginKey } = packageRecord.manifest;
        if (Object.prototype.hasOwnProperty.call(this.desiredEnablement, pluginKey))
            return this.desiredEnablement[pluginKey] === true;
        return packageRecord.source === "builtin" && packageRecord.manifest.defaultEnabled;
    }
    private async assertSafeUserPluginDirectory(packageRecord: PluginRecord): Promise<void> {
        const configuredRoot = this.configuration.scanRoots.find((scanRoot) => {
            if (scanRoot.source !== "user")
                return false;
            return directSubdirectory(path.relative(path.resolve(scanRoot.path), path.resolve(packageRecord.dir)));
        });
        if (!configuredRoot)
            throw new Error("插件目录不是用户插件根目录的一级子目录");
        const directoryInfo = await lstat(packageRecord.dir);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
            throw new Error("插件路径不是普通目录");
        const [resolvedRoot, resolvedPlugin] = await Promise.all([
            realpath(configuredRoot.path),
            realpath(packageRecord.dir),
        ]);
        if (!directSubdirectory(path.relative(resolvedRoot, resolvedPlugin))) {
            throw new Error("插件真实路径不在用户插件根目录的一级范围内");
        }
    }
    private processKey(pluginKey: string): string {
        return `${path.resolve(this.configuration.storageRoot)}:${pluginKey}`;
    }
    private async prepareVersionStore(): Promise<void> {
        const packageStore = this.configuration.versionStore;
        if (!packageStore)
            return;
        const rememberIssue = (pluginKey: string, failureReason: unknown): void => {
            this.restartOnly.add(pluginKey);
            this.packageIssues.push({ root: packageStore.userRoot, source: "user", message: `${pluginKey}: ${failureText(failureReason)}` });
        };
        for (const scanRoot of this.configuration.scanRoots.filter((r) => r.source === "user")) {
            for (const packageRecord of scanPluginDir(scanRoot.path, "user")) {
                try {
                    await packageStore.migrate(packageRecord.manifest.id, packageRecord.dir);
                }
                catch (failureReason) {
                    rememberIssue(packageRecord.manifest.id, failureReason);
                }
            }
        }
        let packageKeys: string[];
        try {
            packageKeys = packageStore.ids();
        }
        catch (failureReason) {
            rememberIssue("version-storage", failureReason);
            return;
        }
        for (const pluginKey of packageKeys) {
            try {
                const loadedInProcess = loadedPackages.has(this.processKey(pluginKey));
                if (!loadedInProcess)
                    await packageStore.recoverInterrupted(pluginKey);
                if (!loadedInProcess)
                    await packageStore.collect(pluginKey);
                let packageState = packageStore.read(pluginKey);
                if (!packageState)
                    continue;
                if (packageState.phase === "uninstalled") {
                    this.packageStates.set(pluginKey, packageState);
                    continue;
                }
                if (packageState.selected)
                    await packageStore.validate(pluginKey, packageState.selected);
                if (packageState.pending && !loadedInProcess) {
                    try {
                        await packageStore.validate(pluginKey, packageState.pending);
                        this.pendingPackages.set(pluginKey, packageState.pending);
                    }
                    catch (failureReason) {
                        packageState = await packageStore.failActivation(pluginKey, failureText(failureReason));
                    }
                }
                this.packageStates.set(pluginKey, packageState);
            }
            catch (failureReason) {
                rememberIssue(pluginKey, failureReason);
            }
        }
    }
    private scanAll(): ScanOutcome {
        const packageStore = this.configuration.versionStore;
        const unreadableRoots = new Set<string>();
        const problems: PluginScanIssue[] = [...this.packageIssues];
        const catalog = new Map<string, PluginRecord>();
        for (const scanRoot of this.configuration.scanRoots) {
            const rememberScanIssue = (issue: PluginScanIssue): void => {
                problems.push(issue);
                if (!issue.path)
                    unreadableRoots.add(scanRoot.path);
            };
            for (const packageRecord of scanPluginDir(scanRoot.path, scanRoot.source, rememberScanIssue)) {
                const trackedPackage = scanRoot.source === "user" && packageStore
                    && (this.restartOnly.has(packageRecord.manifest.id) || existsSync(packageStore.recordPath(packageRecord.manifest.id)));
                if (trackedPackage)
                    continue;
                const firstPackage = catalog.get(packageRecord.manifest.id);
                if (!firstPackage) {
                    catalog.set(packageRecord.manifest.id, packageRecord);
                    continue;
                }
                const collision: PluginScanIssue = {
                    root: scanRoot.path,
                    path: packageRecord.dir,
                    source: scanRoot.source,
                    message: `插件 id 重复，已保留 ${firstPackage.dir}`,
                };
                problems.push(collision);
                console.warn(`[plugins] ${collision.message}，忽略 ${packageRecord.dir}`);
            }
        }
        if (packageStore) {
            for (const [pluginKey, packageState] of this.packageStates) {
                if (packageState.phase === "uninstalled" || catalog.has(pluginKey))
                    continue;
                const storedPackage = this.pendingPackages.get(pluginKey) ?? packageState.selected ?? packageState.pending;
                if (!storedPackage)
                    continue;
                try {
                    catalog.set(pluginKey, inspectStoredRecord(packageStore, pluginKey, storedPackage));
                }
                catch (failureReason) {
                    problems.push({ root: packageStore.userRoot, source: "user", message: `${pluginKey}: ${failureText(failureReason)}` });
                }
            }
        }
        return { records: catalog, issues: problems, failedRoots: unreadableRoots };
    }
    private async doRescan(reloadActive: boolean): Promise<void> {
        const discovered = this.scanAll();
        const oldCatalog = this.catalog;
        for (const oldPackage of oldCatalog.values()) {
            const unreadableRoot = this.configuration.scanRoots.find((scanRoot) => discovered.failedRoots.has(scanRoot.path) && oldPackage.source === scanRoot.source);
            if (unreadableRoot && !discovered.records.has(oldPackage.manifest.id)) {
                discovered.records.set(oldPackage.manifest.id, oldPackage);
            }
        }
        const unchangedPackage = (pluginKey: string): boolean => {
            const oldPackage = oldCatalog.get(pluginKey);
            const newPackage = discovered.records.get(pluginKey);
            return !!oldPackage && !!newPackage && oldPackage.dir === newPackage.dir && oldPackage.fingerprint === newPackage.fingerprint;
        };
        for (const pluginKey of [...this.livePlugins.keys()]) {
            if (reloadActive || !unchangedPackage(pluginKey))
                await this.deactivate(pluginKey);
        }
        this.catalog = discovered.records;
        this.discoveryIssues = discovered.issues;
        [...this.runtimePhases.keys()]
            .filter((pluginKey) => !this.catalog.has(pluginKey))
            .forEach((pluginKey) => {
            this.runtimePhases.delete(pluginKey);
            this.diagnostics.delete(pluginKey);
        });
        for (const [pluginKey, packageRecord] of this.catalog) {
            if (this.livePlugins.has(pluginKey)) {
                this.runtimePhases.set(pluginKey, "running");
                continue;
            }
            if (!this.isConfiguredEnabled(packageRecord)) {
                this.runtimePhases.set(pluginKey, "disabled");
                this.diagnostics.delete(pluginKey);
                continue;
            }
            const waitForRestart = this.configuration.versionStore && packageRecord.source === "user" && (this.restartOnly.has(pluginKey)
                || (!this.packageStates.get(pluginKey)?.selected && !this.pendingPackages.has(pluginKey)));
            if (waitForRestart)
                continue;
            try {
                await this.activate(pluginKey);
            }
            catch (failureReason) {
                this.runtimePhases.set(pluginKey, "failed");
                this.diagnostics.set(pluginKey, failureText(failureReason));
                console.error(`[plugins] 插件 ${pluginKey} 启用失败，跳过`, failureReason);
            }
        }
    }
    private async activate(pluginKey: string): Promise<void> {
        const packageRecord = this.catalog.get(pluginKey);
        if (!packageRecord || this.livePlugins.has(pluginKey))
            return;
        const packageStore = packageRecord.source === "user" ? this.configuration.versionStore : undefined;
        const oldSelection = this.packageStates.get(pluginKey)?.selected ?? null;
        const oldSelectedPackage = packageStore && oldSelection && this.pendingPackages.has(pluginKey)
            ? inspectStoredRecord(packageStore, pluginKey, oldSelection)
            : undefined;
        const storedPackage = this.pendingPackages.get(pluginKey) ?? this.packageStates.get(pluginKey)?.selected;
        if (packageStore) {
            if (!storedPackage || this.restartOnly.has(pluginKey))
                throw new Error("Plugin requires application restart");
            const loadedKey = loadedPackages.get(this.processKey(pluginKey));
            if (loadedKey && loadedKey !== storedPackage.key) {
                throw new Error("Plugin version change requires application restart");
            }
            await packageStore.validate(pluginKey, storedPackage);
            if (this.pendingPackages.has(pluginKey)) {
                this.packageStates.set(pluginKey, await packageStore.beginActivation(pluginKey));
            }
            loadedPackages.set(this.processKey(pluginKey), storedPackage.key);
        }
        this.runtimePhases.set(pluginKey, "starting");
        this.diagnostics.delete(pluginKey);
        let implementation: FireflyPlugin | undefined;
        let resources: DisposableContext | undefined;
        let cancelledWith: Error | undefined;
        let cancelActivation!: (failureReason: Error) => void;
        const cancelled = new Promise<never>((_, reject) => {
            cancelActivation = (failureReason) => {
                if (cancelledWith)
                    return;
                cancelledWith = failureReason;
                resources?.beginStop();
                reject(failureReason);
            };
        });
        this.activationCancels.set(pluginKey, cancelActivation);
        const activationDeadline = setTimeout(() => {
            cancelActivation(new Error(`插件 ${pluginKey} 激活超时（${PLUGIN_ACTIVATION_TIMEOUT_MS}ms）`));
        }, PLUGIN_ACTIVATION_TIMEOUT_MS);
        const initializePlugin = async () => {
            const importedPlugin = await loadPlugin(packageRecord);
            if (cancelledWith)
                throw cancelledWith;
            implementation = importedPlugin;
            resources = createContext(pluginKey, path.join(this.configuration.storageRoot, pluginKey), this.configuration.runtime, this.eventBus, packageRecord.manifest.deps);
            await importedPlugin.register(resources);
            return { plugin: importedPlugin, ctx: resources };
        };
        try {
            const activation = await Promise.race([initializePlugin(), cancelled]);
            if (cancelledWith)
                throw cancelledWith;
            clearTimeout(activationDeadline);
            if (packageStore && this.pendingPackages.has(pluginKey)) {
                this.packageStates.set(pluginKey, await packageStore.finishActivation(pluginKey));
                if (cancelledWith)
                    throw cancelledWith;
                this.pendingPackages.delete(pluginKey);
            }
            this.livePlugins.set(pluginKey, activation.plugin);
            this.resourceContexts.set(pluginKey, activation.ctx);
            this.runtimePhases.set(pluginKey, "running");
            this.notifyRunningState(pluginKey, true);
            console.log(`[plugins] 已启用 ${pluginKey}@${packageRecord.manifest.version}`);
        }
        catch (failureReason) {
            if (packageStore) {
                resources?.beginStop();
                this.restartOnly.add(pluginKey);
                if (this.pendingPackages.has(pluginKey)) {
                    try {
                        this.packageStates.set(pluginKey, await packageStore.failActivation(pluginKey, failureText(failureReason), oldSelection));
                        if (oldSelectedPackage)
                            this.catalog.set(pluginKey, oldSelectedPackage);
                    }
                    catch (recoveryError) {
                        this.packageIssues.push({
                            root: packageStore.userRoot,
                            source: "user",
                            message: `Recovery required for ${pluginKey}: ${failureText(recoveryError)}`,
                        });
                    }
                    this.pendingPackages.delete(pluginKey);
                }
            }
            resources?.beginStop();
            if (resources) {
                if (implementation?.unregister) {
                    try {
                        await runPluginCleanup(() => implementation!.unregister!(), `插件 ${pluginKey} unregister`);
                    }
                    catch (cleanupFailure) {
                        console.warn(`[plugins] 插件 ${pluginKey} 激活回滚时 unregister 失败`, cleanupFailure);
                    }
                }
                await resources.dispose();
            }
            this.runtimePhases.set(pluginKey, "failed");
            this.diagnostics.set(pluginKey, failureText(failureReason));
            throw failureReason;
        }
        finally {
            clearTimeout(activationDeadline);
            this.activationCancels.delete(pluginKey);
        }
    }
    private async deactivate(pluginKey: string): Promise<void> {
        const implementation = this.livePlugins.get(pluginKey);
        const resources = this.resourceContexts.get(pluginKey);
        if (!implementation && !resources)
            return;
        this.runtimePhases.set(pluginKey, "stopping");
        resources?.beginStop();
        this.changed();
        try {
            if (implementation?.unregister) {
                try {
                    await runPluginCleanup(() => implementation.unregister!(), `插件 ${pluginKey} unregister`);
                }
                catch (cleanupFailure) {
                    console.warn(`[plugins] 插件 ${pluginKey} unregister 失败，继续释放框架资源`, cleanupFailure);
                }
            }
        }
        finally {
            try {
                await resources?.dispose();
            }
            finally {
                this.livePlugins.delete(pluginKey);
                this.resourceContexts.delete(pluginKey);
            }
        }
        this.runtimePhases.set(pluginKey, "disabled");
        this.notifyRunningState(pluginKey, false);
        console.log(`[plugins] 已禁用 ${pluginKey}`);
    }
}
