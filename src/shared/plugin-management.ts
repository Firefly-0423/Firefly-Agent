export type PluginRuntimeStatus = "disabled" | "starting" | "running" | "stopping" | "failed";
export type PluginListEntry = {
    activeVersion?: string | null;
    apiVersion: number;
    author: string;
    canOpen: boolean;
    configuredEnabled: boolean;
    defaultEnabled: boolean;
    description: string;
    enabled: boolean;
    entry: string;
    error?: string;
    hasUnregister: boolean;
    icon?: string;
    id: string;
    installedVersion?: string;
    name: string;
    origin?: "local" | "market";
    path: string;
    pendingVersion?: string | null;
    restartRequired?: boolean;
    selectedVersion?: string | null;
    settingsPanel?: string;
    settingsSection?: "channels" | "plugins";
    source: "builtin" | "user";
    sourceId?: string;
    sourceKind?: "bundled" | "curated-market" | "local-zip" | "legacy-unknown";
    status: PluginRuntimeStatus;
    version: string;
};
export type PluginScanIssue = {
    message: string;
    path?: string;
    root: string;
    source: "builtin" | "user";
};
export type PluginOverview = {
    issues: PluginScanIssue[];
    plugins: PluginListEntry[];
};
export type MarketPluginEntry = {
    author: string;
    capabilities?: string[];
    compatible?: boolean;
    description: string;
    downloads: number;
    homepage?: string;
    id: string;
    name: string;
    pluginApiVersion?: number;
    source?: "bundled" | "remote";
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
    activation?: "not-requested" | "restart-required" | "running" | "failed";
    installation?: "committed";
    ok: true;
    overview?: PluginOverview;
    plugin: {
        id: string;
        name: string;
        version: string;
    };
} | {
    activation?: "not-requested" | "restart-required" | "running" | "failed";
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
export type PluginManagementApi = {
    getV2Borrowing?(): Promise<{ entries: PluginV2BorrowingEntry[] }>;
    importZip(): Promise<{
        activation?: "not-requested" | "restart-required" | "running" | "failed";
        canceled?: boolean;
        error?: string;
        installation?: "committed" | "rejected";
        ok: boolean;
        overview?: PluginOverview;
        plugin?: {
            id: string;
            name: string;
            version: string;
        };
    }>;
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
    }>;
    stopV2Borrowing?(filter?: { id?: string; pluginId?: string }): Promise<{ ok: boolean; stopped: number }>;
    uninstall(id: string): Promise<{
        error?: string;
        ok: boolean;
        overview?: PluginOverview;
    }>;
};
export type PluginPanelApi = {
    invoke(pluginId: string, channel: string, args: unknown[]): Promise<unknown>;
};
