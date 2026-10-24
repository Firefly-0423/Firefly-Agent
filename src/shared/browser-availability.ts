/** Public presentation DTO; contains no authority or gate configuration. */
export type BrowserAvailability = { readonly available: false; readonly reason: "network_unavailable" } | { readonly available: true };
export type BrowserAvailabilityApi = import("./manual-browser").ManualBrowserApi;
