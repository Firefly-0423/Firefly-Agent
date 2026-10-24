export type CustomEndpointMode = "cloud" | "local";
export const CUSTOM_ENDPOINT_PROVIDERS = { cloud: "自定义端点（云端）", local: "自定义端点（本地）" } as const;
export type CustomEndpointPresentation = {
  baseUrlPlaceholder: string; apiKeyOptional: boolean; displayName: string;
};
export type CustomEndpointConfigInput = { apiKey: string; model: string; baseUrl: string };

const endpointViews: Record<CustomEndpointMode, CustomEndpointPresentation> = {
  cloud: { displayName: "自定义云端", apiKeyOptional: false, baseUrlPlaceholder: "https://your-provider.example/v1" },
  local: { displayName: "本地模型", apiKeyOptional: true, baseUrlPlaceholder: "http://127.0.0.1:11434/v1" },
};
export function getCustomEndpointProvider(mode: CustomEndpointMode): string {
  return CUSTOM_ENDPOINT_PROVIDERS[mode];
}
export function getCustomEndpointMode(provider: string): CustomEndpointMode | null {
  switch (provider) {
    case CUSTOM_ENDPOINT_PROVIDERS.cloud: return "cloud";
    case CUSTOM_ENDPOINT_PROVIDERS.local: return "local";
    default: return null;
  }
}
export function getCustomEndpointPresentation(mode: CustomEndpointMode): CustomEndpointPresentation {
  return endpointViews[mode];
}
