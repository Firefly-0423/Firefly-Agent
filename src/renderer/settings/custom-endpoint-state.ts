import type { CustomEndpointConfigInput, CustomEndpointMode } from "../../shared/custom-endpoint-state";

// 沿用渲染端导入入口，与主进程共享端点定义。
export {
  CUSTOM_ENDPOINT_PROVIDERS, getCustomEndpointMode, getCustomEndpointPresentation,
  getCustomEndpointProvider, type CustomEndpointConfigInput,
  type CustomEndpointMode, type CustomEndpointPresentation,
} from "../../shared/custom-endpoint-state";

function hasHttpAddress(address: string): boolean {
  try {
    const endpoint = new URL(address);
    const allowedProtocol = endpoint.protocol === "http:" || endpoint.protocol === "https:";
    return allowedProtocol && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}

export function validateCustomEndpointConfig(mode: CustomEndpointMode, config: CustomEndpointConfigInput): string | null {
  const address = config.baseUrl.trim();
  if (address.length === 0) return "请填写 Base URL";
  if (!hasHttpAddress(address)) return "Base URL 必须是完整的 HTTP(S) 地址";
  if (config.model.trim().length === 0) return "请填写模型 ID";
  if (mode === "cloud") {
    if (config.apiKey.trim().length === 0) return "请填写 API Key";
  }
  return null;
}
