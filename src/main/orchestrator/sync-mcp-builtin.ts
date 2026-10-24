import * as path from "path";
import { addMcpServer, removeMcpServer, listMcpServerConfigs } from "./mcp-manager";
import type { McpServerConfig } from "./mcp-adapter";
import { classifyMcpFailure } from "./mcp-failure";
export const PLAYWRIGHT_MCP_ID = "playwright-mcp";
export const REMOVED_BUILTIN_MCP_IDS: readonly string[] = ["firecrawl-hosted"];
export function resolvePlaywrightMcpCliPath(): string {
  const packageRoot = path.dirname(require.resolve("@playwright/mcp/package.json"));
  return path.join(packageRoot, "cli.js").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
export function buildPlaywrightMcpConfig(): McpServerConfig {
  return { id: PLAYWRIGHT_MCP_ID, name: "Playwright 浏览器", transport: "stdio", command: process.execPath,
    args: [resolvePlaywrightMcpCliPath(), "--isolated", "--headless", "--browser", "msedge"], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
function equivalent(stored: McpServerConfig | undefined, desired: McpServerConfig): boolean {
  if (!stored) return false;
  if (stored.command !== desired.command) return false;
  if (JSON.stringify(stored.args ?? []) !== JSON.stringify(desired.args ?? [])) return false;
  return JSON.stringify(stored.env ?? {}) === JSON.stringify(desired.env ?? {});
}
export async function syncPlaywrightMcp(settings: { playwrightMcpEnabled: boolean }): Promise<void> {
  const previous = listMcpServerConfigs().find((configuration) => configuration.id === PLAYWRIGHT_MCP_ID);
  if (!settings.playwrightMcpEnabled) {
    if (!previous) return;
    console.log("[Firefly]", "移除 Playwright MCP Server...");
    try { await removeMcpServer(PLAYWRIGHT_MCP_ID); }
    catch (failure) { console.error("[Firefly]", "Playwright MCP 移除异常:", classifyMcpFailure(failure)); }
    return;
  }
  const desired = buildPlaywrightMcpConfig();
  const obsolete = !!previous && !equivalent(previous, desired);
  if (obsolete) {
    console.log("[Firefly]", "Playwright MCP 配置过期，自动迁移");
    try { await removeMcpServer(PLAYWRIGHT_MCP_ID); }
    catch (failure) { console.error("[Firefly]", "Playwright MCP 旧配置移除异常:", classifyMcpFailure(failure)); }
  }
  if (previous && !obsolete) return;
  console.log("[Firefly]", "注册 Playwright MCP Server...");
  try {
    const registration = await addMcpServer(buildPlaywrightMcpConfig());
    if (registration.ok) console.log("[Firefly]", "Playwright MCP 注册成功,工具:", registration.toolIds?.join(", "));
    else console.error("[Firefly]", "Playwright MCP 注册失败:", registration.reason ?? "failed");
  } catch (failure) { console.error("[Firefly]", "Playwright MCP 注册异常:", classifyMcpFailure(failure)); }
}
