import { getAdapterForConfig } from "./index";
import type { ChatVendorAdapter, TestConnectionResult, VendorConfig } from "./types";
import { logger, LogTag } from "../../base/logging/logger";
type AdapterResolver = (config: VendorConfig) => ChatVendorAdapter;
/** Use the same config-aware adapter path as the Agent runtime. */
export async function testVendorConnection(config: VendorConfig, resolveAdapter: AdapterResolver = getAdapterForConfig): Promise<TestConnectionResult> {
  const adapter = resolveAdapter(config);
  const result = await adapter.testConnection(config);
  // Upstream text and user-provided config can contain credentials.
  logger.info(LogTag.Firefly, "test connection result:", { ok: result.ok === true, latency: Number.isFinite(result.latency) ? result.latency : undefined });
  return result;
}