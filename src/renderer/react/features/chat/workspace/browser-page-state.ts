/**
 * Pure presentation state for a manually controlled browser page.
 * Addresses and navigation results must come through the Main browser boundary;
 * this module does not validate network targets or grant browser authority.
 */
export interface BrowserPageState {
  readonly conversationId: string | null;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly browserId: string;
  readonly requestId: number;
  readonly closed: boolean;
  readonly loading: boolean;
  readonly url: string;
  readonly pendingUrl: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error: "blocked" | "load_failed" | null;
}

interface BrowserNavigationIdentity {
  readonly conversationId: string;
  readonly browserId: string;
  readonly requestId: number;
}

export interface BrowserNavigationResult extends BrowserNavigationIdentity {
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface BrowserNavigationFailure extends BrowserNavigationIdentity {
  readonly error: NonNullable<BrowserPageState["error"]>;
}

export function createBrowserPageState(conversationId: string | null, browserId: string): BrowserPageState {
  return {
    conversationId,
    browserId,
    requestId: 0,
    closed: false,
    loading: false,
    url: "",
    pendingUrl: null,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
}

export function beginBrowserNavigation(state: BrowserPageState, url: string): BrowserPageState {
  if (state.closed) return state;
  return {
    ...state,
    requestId: state.requestId + 1,
    loading: true,
    pendingUrl: url,
    error: null,
  };
}

function isPendingNavigation(state: BrowserPageState, result: BrowserNavigationIdentity): boolean {
  return !state.closed
    && state.loading
    && state.conversationId === result.conversationId
    && state.browserId === result.browserId
    && state.requestId === result.requestId;
}

export function completeBrowserNavigation(state: BrowserPageState, result: BrowserNavigationResult): BrowserPageState {
  if (!isPendingNavigation(state, result)) return state;
  return {
    ...state,
    loading: false,
    pendingUrl: null,
    url: result.url,
    canGoBack: result.canGoBack,
    canGoForward: result.canGoForward,
    error: null,
  };
}

export function failBrowserNavigation(state: BrowserPageState, result: BrowserNavigationFailure): BrowserPageState {
  if (!isPendingNavigation(state, result)) return state;
  return { ...state, loading: false, pendingUrl: null, error: result.error };
}

export function closeBrowserPage(state: BrowserPageState): BrowserPageState {
  if (state.closed) return state;
  return {
    ...state,
    closed: true,
    loading: false,
    pendingUrl: null,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
}
