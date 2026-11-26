export type PluginRuntimeStatus = "disabled" | "starting" | "enabled" | "running" | "stopping" | "restarting" | "disabled-fault" | "failed";
export type PluginDeclaredTool = {
    modes: string[];
    name: string;
    risk: string[];
    title: string;
};
export type PluginDeclaredContext = {
    id: string;
    modes: string[];
    sources: string[];
    title: string;
};
export type PluginDeclaredChannel = {
    id: string;
    title: string;
};
export type PluginDeclaredWindow = {
    entry: string;
    height?: number;
    id: string;
    title: string;
    width?: number;
};
export type PluginListEntry = {
    activeVersion?: string | null;
    apiVersion: number;
    author: string;
    canOpen: boolean;
    channels?: PluginDeclaredChannel[];
    configuredEnabled: boolean;
    context?: PluginDeclaredContext[];
    defaultEnabled: boolean;
    description: string;
    enabled: boolean;
    entry: string;
    error?: string;
    grantedPermissions?: string[];
    hasDataDir?: boolean;
    hasSecrets?: boolean;
    hasUnregister: boolean;
    icon?: string;
    id: string;
    installedVersion?: string;
    modelRateLimit?: number;
    name: string;
    native?: boolean;
    origin?: "local" | "market";
    path: string;
    pendingVersion?: string | null;
    permissions?: string[];
    restartRequired?: boolean;
    revision?: number;
    sdk?: string;
    selectedVersion?: string | null;
    settingsPanel?: string;
    settingsSection?: "channels" | "plugins";
    source: "builtin" | "user";
    sourceId?: string;
    sourceKind?: "bundled" | "curated-market" | "local-zip" | "local-package" | "local-folder" | "legacy-unknown";
    status: PluginRuntimeStatus;
    tools?: PluginDeclaredTool[];
    version: string;
    windows?: PluginDeclaredWindow[];
};
export type PluginScanIssue = {
    message: string;
    path?: string;
    root: string;
    source: "builtin" | "user";
};
export type UninstallCleanupOutcome = "kept" | "deleted" | "delete_failed";
export type UninstallCleanupResult = {
    data: UninstallCleanupOutcome;
    dataError?: string;
    secrets: UninstallCleanupOutcome;
    secretsError?: string;
};
export type PendingPluginCleanup = {
    data: UninstallCleanupOutcome;
    dataError?: string;
    id: string;
    name: string;
    secrets: UninstallCleanupOutcome;
    secretsError?: string;
};
export type PluginOverview = {
    issues: PluginScanIssue[];
    pendingCleanups?: PendingPluginCleanup[];
    plugins: PluginListEntry[];
};
export type MarketToolSummary = {
    modes: string[];
    name: string;
    risk: string[];
    title: string;
};
export type MarketPluginEntry = {
    author: string;
    capabilities?: string[];
    compatible?: boolean;
    description: string;
    downloads?: number;
    homepage?: string;
    id: string;
    license?: string;
    name: string;
    native?: boolean;
    permissions?: string[];
    pluginApiVersion?: number;
    sdk?: string;
    source?: "bundled" | "remote";
    tools?: MarketToolSummary[];
    version: string;
};
export type MarketSourceStatus = {
    ok: boolean;
    url: string;
    used: boolean;
};
export type MarketListResult = {
    error?: string;
    mode?: "bundled" | "online" | "offline-fallback";
    ok: boolean;
    plugins: MarketPluginEntry[];
    sources?: MarketSourceStatus[];
};
export type MarketInstallResult = {
    activation?: "not-requested" | "restart-required" | "running" | "failed" | "rolled-back";
    installation?: "committed";
    ok: true;
    overview?: PluginOverview;
    plugin: {
        id: string;
        name: string;
        version: string;
    };
} | {
    activation?: "not-requested" | "restart-required" | "running" | "failed" | "rolled-back";
    error: string;
    installation?: "committed" | "rejected";
    ok: false;
    overview?: PluginOverview;
};
export type PluginV2ConfirmPermission = "sessions.read" | "workspace.read" | "model.run";
export type PluginV2ConfirmRequest = {
    id: string;
    permission: PluginV2ConfirmPermission;
    pluginId: string;
    pluginName: string;
};
export type PluginV2ConfirmSettled = {
    id: string;
    reason: "answered" | "cancelled";
};
export type PluginV2BorrowingEntry = {
    id: string;
    pluginId: string;
    pluginName: string;
};
export type UninstallPluginOptions = {
    deleteData?: boolean;
    deleteSecrets?: boolean;
};
/** What a user must see before a local package replaces an installed plugin. */
export interface PluginReplaceSummary {
  current: {
    name: string;
    version: string;
    origin: "local" | "market";
    enabled: boolean;
    native: boolean;
    grantedPermissions: string[];
  };
  incoming: {
    name: string;
    version: string;
    origin: "local" | "market";
    native: boolean;
    permissions: string[];
    tools: { name: string; title: string; risk: string[]; modes: string[] }[];
  };
  /** Permissions the incoming manifest declares that the installed plugin has not been granted. */
  addedPermissions: string[];
  /** The installed plugin has no native code but the incoming package does. */
  nativeEscalation: boolean;
  packageSha256: string;
}
export type PluginImportOutcome = {
    activation?: "not-requested" | "restart-required" | "running" | "failed" | "rolled-back";
    canceled?: boolean;
    error?: string;
    installation?: "committed" | "rejected" | "needs-confirmation";
    /** Present with "needs-confirmation": pass it back to importZip / importFolder to confirm exactly this package. */
    confirmToken?: string;
    replace?: PluginReplaceSummary;
    ok: boolean;
    overview?: PluginOverview;
    plugin?: {
        id: string;
        name: string;
        version: string;
    };
};
export type PluginManagementApi = {
    getV2Borrowing?(): Promise<{ entries: PluginV2BorrowingEntry[] }>;
    getV2Confirms?(): Promise<{ requests: PluginV2ConfirmRequest[] }>;
    importFolder?(confirmToken?: string): Promise<PluginImportOutcome>;
    importZip(confirmToken?: string): Promise<PluginImportOutcome>;
    list(): Promise<PluginOverview | PluginListEntry[]>;
    marketInstall(id: string): Promise<MarketInstallResult>;
    marketList(preferred?: string): Promise<MarketListResult>;
    onChanged?(callback: (overview: PluginOverview) => void): () => void;
    onV2BorrowingChanged?(callback: (payload: { entries: PluginV2BorrowingEntry[] }) => void): () => void;
    onV2ConfirmRequest?(callback: (request: PluginV2ConfirmRequest) => void): () => void;
    onV2ConfirmSettled?(callback: (settled: PluginV2ConfirmSettled) => void): () => void;
    open(id: string): Promise<{
        error?: string;
        ok: boolean;
    }>;
    rescan(): Promise<PluginOverview>;
    resolveV2Confirm?(id: string, allowed: boolean): Promise<{ ok: boolean }>;
    setEnabled(id: string, enabled: boolean): Promise<{
        error?: string;
        ok: boolean;
        overview?: PluginOverview;
    }>;
    setModelRateLimit?(id: string, limit: number): Promise<{
        error?: string;
        ok: boolean;
        overview?: PluginOverview;
    }>;
    setPermission?(id: string, permission: string, granted: boolean): Promise<{
        error?: string;
        ok: boolean;
        overview?: PluginOverview;
    }>;
    stopV2Borrowing?(filter?: { id?: string; pluginId?: string }): Promise<{ ok: boolean; stopped: number }>;
    uninstall(id: string, options?: UninstallPluginOptions): Promise<{
        cleanup?: UninstallCleanupResult;
        error?: string;
        ok: boolean;
        overview?: PluginOverview;
    }>;
};
