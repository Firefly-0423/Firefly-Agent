import { getCustomEndpointMode } from "../../../shared/custom-endpoint-state";

export type VendorRuntimeSettings = {
  disableMaxToken?: boolean;
  thinkingOverride?: -1 | 0 | 1;
};
export type VendorRuntimeSettingsSource = {
  disableMaxToken?: boolean;
  thinkingOverride?: -1 | 0 | 1;
  provider: string;
};
let readSettings: (() => VendorRuntimeSettings) | null = null;

export function setVendorRuntimeSettingsGetter(getter: () => VendorRuntimeSettings): void {
  readSettings = getter;
}
export function getVendorRuntimeSettings(): VendorRuntimeSettings {
  return readSettings?.() ?? {};
}
export function resolveVendorRuntimeSettings(source: VendorRuntimeSettingsSource): VendorRuntimeSettings {
  if (getCustomEndpointMode(source.provider) === null) {
    return { thinkingOverride: 0, disableMaxToken: false };
  }
  return { thinkingOverride: source.thinkingOverride, disableMaxToken: source.disableMaxToken };
}
