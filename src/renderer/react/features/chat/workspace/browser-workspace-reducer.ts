import {
  beginBrowserNavigation,
  closeBrowserPage,
  completeBrowserNavigation,
  createBrowserPageState,
  failBrowserNavigation,
  type BrowserNavigationFailure,
  type BrowserNavigationResult,
  type BrowserPageState,
} from "./browser-page-state";

export interface BrowserWorkspaceState {
  readonly page: BrowserPageState;
  readonly address: string;
  readonly addressEdited: boolean;
}

export type BrowserWorkspaceAction =
  | { type: "address_edited"; value: string }
  | { type: "navigation_started"; url: string }
  | { type: "navigation_completed"; result: BrowserNavigationResult }
  | { type: "navigation_failed"; result: BrowserNavigationFailure }
  | { type: "closed" };

export function createBrowserWorkspaceState(conversationId: string, browserId: string): BrowserWorkspaceState {
  return { page: createBrowserPageState(conversationId, browserId), address: "", addressEdited: false };
}

/** Presentation only: callers own asynchronous work and the Main security boundary. */
export function browserWorkspaceReducer(state: BrowserWorkspaceState, action: BrowserWorkspaceAction): BrowserWorkspaceState {
  switch (action.type) {
    case "address_edited":
      if (state.page.closed || (state.addressEdited && state.address === action.value)) return state;
      return { ...state, address: action.value, addressEdited: true };
    case "navigation_started":
      if (state.page.closed) return state;
      return { page: beginBrowserNavigation(state.page, action.url), address: action.url, addressEdited: false };
    case "navigation_completed": {
      const page = completeBrowserNavigation(state.page, action.result);
      if (page === state.page) return state;
      return { ...state, page, address: state.addressEdited ? state.address : page.url };
    }
    case "navigation_failed": {
      const page = failBrowserNavigation(state.page, action.result);
      return page === state.page ? state : { ...state, page };
    }
    case "closed": {
      const page = closeBrowserPage(state.page);
      return page === state.page ? state : { ...state, page, addressEdited: false };
    }
  }
}
