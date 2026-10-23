/** Presentation and manual commands only. Main keeps all owner, profile and gate authority. */
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export type BrowserNetworkFailure = "permission_denied" | "owner_mismatch" | "cancelled" | "closed" | "network_unavailable" | "cleanup_failed";
export type BrowserConnectionError = "restricted_address" | "dns_failed" | "dns_timeout" | "connection_failed";
export type BrowserErrorCode = BrowserNetworkFailure | BrowserConnectionError | "blocked_url" | "load_failed" | "tab_limit";
export interface BrowserPageDto { browserId: string; conversationId: string; requestId: number; closed: boolean; loading: boolean; url: string; pendingUrl: string | null; canGoBack: boolean; canGoForward: boolean; error: BrowserErrorCode | null;
  /** Main-only discovery, bounded and non-authorizing. Navigation contains origin only. */
  blockedResourceHosts?: readonly string[]; blockedNavigationUrl?: string; blockedRequest?: boolean;
}
export type BrowserReply<T> = { ok: true; value: T } | { ok: false; code: BrowserErrorCode };
export type ManualBrowserCommand = { kind: "get" } | { kind: "open"; url: string } | { kind: "navigate"; browserId: string; url: string } | { kind: "history"; browserId: string; action: "back" | "forward" | "reload" } | { kind: "layout"; browserId: string; bounds: BrowserBounds | null } | { kind: "stop"; browserId: string } | { kind: "close"; browserId: string };
export interface ManualBrowserApi {
  getPermission(): Promise<BrowserReply<BrowserPermissionDto>>;
  requestPermission(scope: BrowserPermissionScope): Promise<BrowserReply<BrowserPermissionDto>>;
  revokePermission(conversationId?: string): Promise<BrowserReply<BrowserPermissionDto>>;
  getAvailability(): Promise<import("./browser-availability").BrowserAvailability>;
  execute(command: ManualBrowserCommand): Promise<BrowserReply<BrowserPageDto | null>>;
  onChanged(listener: (page: BrowserPageDto) => void): () => void;
}

export type BrowserAction = "navigate" | "observe" | "click" | "type";
export interface BrowserPermissionScope { readonly hosts: readonly string[]; readonly actions: readonly BrowserAction[];
  readonly mode?: "manual" | "agent"; readonly resourceHosts?: readonly string[];
  /** Manual only: ordinary web browsing of any public HTTPS site. Carries no host lists and never an Agent action. */
  readonly web?: boolean;
  /** Explicit user-selected exact-site Agent grant; never an ordinary web grant. */
  readonly site?: true;
  /** Request-only identity for adding resources discovered by this exact live page. Never part of a grant. */
  readonly sourceBrowserId?: string;
  readonly sourceRequestId?: number;
}
export interface BrowserPermissionDto {
  readonly conversationId: string;
  readonly status: "required" | "pending" | "granted" | "denied";
  readonly scope: BrowserPermissionScope;
  /** Main's bounded Agent proposal, not an active grant. Requires separate native consent. */
  readonly agentScope?: BrowserPermissionScope;
  /** Main advertises support for native-confirmed exact-site Agent proposals. */
  readonly agentSiteSelection?: boolean;
  readonly requestId: string | null;
}
/** Separate window contract preserves the existing conversation bridge during staged integration. */
export type BrowserWorkspacePageDto = Omit<BrowserPageDto, "conversationId"> & { conversationId: null; workspaceId: string; tabId?: string };
export type BrowserWorkspacePermissionDto = Omit<BrowserPermissionDto, "conversationId" | "agentScope"> & { conversationId: null; workspaceId: string; tabId?: string; agentScope?: never };
export interface BrowserWorkspaceStateDto { readonly workspaceId: string; readonly activeTabId: string | null; readonly tabs: readonly { readonly tabId: string; readonly page: BrowserWorkspacePageDto | null }[] }
export type BrowserOwnedPageDto = BrowserPageDto | BrowserWorkspacePageDto;
export type BrowserOwnedPermissionDto = BrowserPermissionDto | BrowserWorkspacePermissionDto;
export const MANUAL_BROWSER_WORKSPACE_IPC = Object.freeze({
  availability: "browser:workspace:availability", permission: "browser:workspace:permission",
  command: "browser:workspace:command", changed: "browser:workspace:changed", toolsChanged: "browser:workspace:tools-changed",
});
export interface ManualBrowserWorkspaceApi extends Partial<import("./browser-tools").BrowserToolsApi> {
  getPermission(tabId?: string): Promise<BrowserReply<BrowserWorkspacePermissionDto>>;
  requestPermission(scope: BrowserPermissionScope, tabId?: string): Promise<BrowserReply<BrowserWorkspacePermissionDto>>;
  revokePermission(workspaceId: string, tabId?: string): Promise<BrowserReply<BrowserWorkspacePermissionDto>>;
  getAvailability(): Promise<import("./browser-availability").BrowserAvailability>;
  getTabs(): Promise<BrowserReply<BrowserWorkspaceStateDto>>;
  newTab(): Promise<BrowserReply<BrowserWorkspaceStateDto>>;
  selectTab(tabId: string): Promise<BrowserReply<BrowserWorkspaceStateDto>>;
  closeTab(tabId: string): Promise<BrowserReply<BrowserWorkspaceStateDto>>;
  execute(command: ManualBrowserCommand, tabId?: string): Promise<BrowserReply<BrowserWorkspacePageDto | null>>;
  onChanged(listener: (page: BrowserWorkspacePageDto) => void): () => void;
}

/** Exact public destinations shown by Main's native confirmation. No wildcard. */
export const BROWSER_PUBLIC_SCOPE: BrowserPermissionScope = Object.freeze({
  hosts: Object.freeze(["example.com", "github.com", "github.githubassets.com", "avatars.githubusercontent.com"]),
  actions: Object.freeze(["navigate", "observe", "click", "type"] as BrowserAction[]),
});

export interface BrowserObservation {
  readonly snapshotId: string; readonly url: string; readonly title: string; readonly text: string;
  readonly elements: readonly { ref: string; tag: string; role: string; name: string; value?: string; href?: string }[];
}
export type BrowserDomInput = { kind: "observe"; snapshotId: string; url: string; hosts?: readonly string[] }
  | { kind: "click" | "type"; snapshotId: string; url: string; ref: string; text?: string; hosts?: readonly string[] };
export type BrowserWorkspaceOperation = "open" | "navigate" | "back" | "forward" | "reload" | "observe" | "click" | "type" | "close";
export interface BrowserWorkspaceCommand { operation: BrowserWorkspaceOperation; browserId?: string; url?: string; snapshotId?: string; ref?: string; text?: string }
