// MCP lifecycle and persistent configuration; paths belong to StorageContext.
import { AtomicJsonStore } from "../storage/atomic-json-store";
import { getStorageContext } from "../storage/storage-context";
import { connectMcpServer, disconnectMcpServer, getMcpServerStates, McpServerConfig } from "./mcp-adapter";
import { logger, LogTag } from "../logging/logger";
import { classifyMcpFailure, type McpFailureReason } from "./mcp-failure";

const LOG_PREFIX = "[MCP Manager]";

// The adapter serializes per server; this queue owns the shared config document.
// Hold it through connection/disconnection and commit so removals cannot be undone
// by an older add snapshot. A rejected operation must not poison later callers.
let managerOperation: Promise<void> = Promise.resolve();
function queueManagerOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = managerOperation.then(operation);
  managerOperation = result.then(() => {}, () => {});
  return result;
}

// Last connection failure per server, as a fixed reason only. Memory-only: a restart retries and re-records it.
const lastFailures = new Map<string, McpFailureReason>();

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validConfigs(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((item: unknown) => {
    if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name || (item.transport !== "stdio" && item.transport !== "sse")) return false;
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    if (["command", "cwd", "url"].some((key) => item[key] !== undefined && typeof item[key] !== "string")) return false;
    if (item.args !== undefined && (!Array.isArray(item.args) || !item.args.every((arg: unknown) => typeof arg === "string"))) return false;
    if (item.env !== undefined && (!record(item.env) || !Object.values(item.env).every((entry) => typeof entry === "string"))) return false;
    return item.enabled === undefined || typeof item.enabled === "boolean";
  });
}
function configStore(): AtomicJsonStore<McpServerConfig[]> {
  return new AtomicJsonStore(getStorageContext().files.mcp, validConfigs);
}
function loadConfigs(): McpServerConfig[] {
  const store = configStore(); // initialization errors must not become empty configuration
  try {
    const configs = store.read([]);
    logger.info(LogTag.MCP, `loaded ${configs.length} MCP server configs`);
    return configs;
  } catch (error) {
    console.error(LOG_PREFIX, "configuration read failed:", classifyMcpFailure(error));
    return [];
  }
}
function saveConfigs(configs: McpServerConfig[]): void {
  configStore().write(configs); // propagate write failure; never report a false success
}
/**
 * 按固定 id 白名单清理已下线的内置 MCP server 配置。
 * 幂等：找不到对应条目时既不报错也不写盘。
 * 只删除调用方传入的 id，用户自己添加的 MCP 不会被误删。
 * 返回实际被移除的 id 列表，供日志使用。
 */
export function pruneMcpServersByIds(serverIds: string[]): Promise<string[]> {
  const ids = [...serverIds];
  return queueManagerOperation(() => pruneMcpServersByIdsNow(ids));
}
async function pruneMcpServersByIdsNow(serverIds: string[]): Promise<string[]> {
  const configs = loadConfigs();
  const removed = configs.filter((c) => serverIds.includes(c.id)).map((c) => c.id);
  const kept = configs.filter((c) => !serverIds.includes(c.id));
  if (removed.length > 0) saveConfigs(kept);
  // 若同 id 的实例仍处于连接状态则一并断开（启动阶段通常还没连，早先注册过的才会残留）
  for (const id of removed) {
    try { await disconnectMcpServer(id); } catch { /* 断开失败不影响清理结果 */ }
  }
  return removed;
}

/**
 * 启动时自动连接所有已保存的 MCP server。
 * 支持 AbortSignal 协作取消：退出（或恢复屏障超时后放弃等待）时，
 * 未开始的连接不再启动；单个连接完成后若信号已中止，立即断开该连接，
 * 保证迟到的连接不残留为无所有者资源。
 */
export function initMcpManager(options: { signal?: AbortSignal } = {}): Promise<void> {
  const signal = options.signal;
  return queueManagerOperation(() => initMcpManagerNow(signal));
}
async function initMcpManagerNow(signal?: AbortSignal): Promise<void> {
  logger.info(LogTag.MCP, "initializing MCP Manager...");
  const configs = loadConfigs();

  if (configs.length === 0) {
    logger.info(LogTag.MCP, "no MCP servers configured, skipping");
    return;
  }

  let connected = 0;
  let failed = 0;

  for (const config of configs) {
    if (config.enabled === false) continue;
    if (signal?.aborted) { console.log(LOG_PREFIX, "restore aborted, remaining servers skipped:", config.name); break; }
    try {
      await connectMcpServer(config);
      lastFailures.delete(config.id); connected += 1;
      // 建立连接之后再看一次中止信号：若已进入退出流程，就立即断开这条迟到的连接
      if (signal?.aborted) {
        try { await disconnectMcpServer(config.id); } catch { /* 忽略断开失败 */ }
        console.log(LOG_PREFIX, "late connection disconnected after abort:", config.name);
      }
    } catch (err) {
      failed++;
      lastFailures.set(config.id, classifyMcpFailure(err));
      console.error(LOG_PREFIX, "自动连接失败 [" + config.name + "]:", classifyMcpFailure(err));
    }
  }

  console.log(LOG_PREFIX, "初始化完成: " + connected + " 个成功, " + failed + " 个失败");
}

/**
 * 添加一个新的 MCP server 配置，连接并持久化。
 */
export function addMcpServer(config: McpServerConfig): Promise<{
  ok: boolean;
  toolIds?: string[];
  error?: string;
  reason?: McpFailureReason;
}> {
  const snapshot: McpServerConfig = {
    ...config,
    args: config.args === undefined ? undefined : [...config.args],
    env: config.env === undefined ? undefined : { ...config.env },
    effectKindOverrides: config.effectKindOverrides === undefined ? undefined : { ...config.effectKindOverrides },
  };
  return queueManagerOperation(() => addMcpServerNow(snapshot));
}
async function addMcpServerNow(config: McpServerConfig): Promise<{
  ok: boolean;
  toolIds?: string[];
  error?: string;
  reason?: McpFailureReason;
}> {
  console.log(LOG_PREFIX, "添加 MCP server:", config.name);

  // 同 id 已存在则直接拒绝
  const configs = loadConfigs();
  if (configs.some((c) => c.id === config.id)) return { ok: false, error: `已存在相同 ID 的 MCP server: ${config.id}` };

  let connected = false;
  try {
    const toolIds = await connectMcpServer(config);
    connected = true;
    saveConfigs([...configs, config]);
    return { ok: true, toolIds };
  } catch (err) {
    if (connected) {
      try { await disconnectMcpServer(config.id); }
      catch { logger.warn(LogTag.MCP, "failed to disconnect unpersisted MCP server", { serverId: config.id }); }
    }
    const error = connected ? "ATOMIC_JSON_WRITE_FAILED" : "MCP_CONNECTION_FAILED";
    return { ok: false, error, reason: classifyMcpFailure(err) };
  }
}

/**
 * 删除一个 MCP server：断开连接，并把配置写回磁盘。
 *
 * 清理配置不以连接状态为前提。有过这样的情况：配置存在，但连接从来没成功
 * （比如环境里缺少 npx），这种 server 在 mcpServerStates 里查不到记录。
 * 若因为 disconnect 失败就跳过了配置清理，残留的配置会让之后的 addMcpServer
 * 一直报"ID 已存在"，而且无法自行恢复。
 */
export function removeMcpServer(serverId: string): Promise<{ ok: boolean; error?: string }> {
  return queueManagerOperation(() => removeMcpServerNow(serverId));
}
async function removeMcpServerNow(serverId: string): Promise<{ ok: boolean; error?: string }> {
  console.log(LOG_PREFIX, `移除 MCP server: ${serverId}`);

  await disconnectMcpServer(serverId);

  saveConfigs(loadConfigs().filter((c) => c.id !== serverId));
  lastFailures.delete(serverId);
  return { ok: true };
}

/**
 * 启用或停用一个已保存的 MCP server。
 * 启用：连接成功后才保存 enabled；连接失败则保持原状态并返回固定原因。
 * 已启用但未连接的 server 再次启用即重新连接。
 * 停用：先断开并撤下工具，再保存 enabled=false；保存失败时抛出，调用方重新读取状态。
 */
export function setMcpServerEnabled(serverId: string, enabled: boolean): Promise<{ ok: boolean; toolIds?: string[]; error?: string; reason?: McpFailureReason }> {
  return queueManagerOperation(() => setMcpServerEnabledNow(serverId, enabled));
}
async function setMcpServerEnabledNow(serverId: string, enabled: boolean): Promise<{ ok: boolean; toolIds?: string[]; error?: string; reason?: McpFailureReason }> {
  const configs = loadConfigs();
  const index = configs.findIndex(c => c.id === serverId);
  if (index < 0) return { ok: false, error: "MCP_SERVER_NOT_FOUND" };
  const config = configs[index];
  if (!enabled) {
    await disconnectMcpServer(serverId);
    lastFailures.delete(serverId);
    if (config.enabled !== false) {
      configs[index] = { ...config, enabled: false };
      saveConfigs(configs);
    }
    return { ok: true };
  }
  const alreadyConnected = getMcpServerStates().some(s => s.id === serverId && s.connected);
  let toolIds: string[] | undefined;
  if (!alreadyConnected) {
    try {
      toolIds = await connectMcpServer(config);
    } catch (err) {
      lastFailures.set(serverId, classifyMcpFailure(err));
      return { ok: false, error: "MCP_CONNECTION_FAILED", reason: classifyMcpFailure(err) };
    }
  }
  lastFailures.delete(serverId);
  if (config.enabled === false) {
    try {
      configs[index] = { ...config, enabled: true };
      saveConfigs(configs);
    } catch (err) {
      // Never leave a connection running that the saved configuration does not allow.
      try { await disconnectMcpServer(serverId); }
      catch { logger.warn(LogTag.MCP, "failed to disconnect after a failed save", { serverId }); }
      throw err;
    }
  }
  return { ok: true, ...(toolIds ? { toolIds } : {}) };
}

type McpServerSummary = {
  failure?: McpFailureReason;
  enabled: boolean;
  toolIds: string[];
  toolCount: number;
  connected: boolean;
  name: string;
  id: string;
};

/** 汇总全部 MCP server 的状态：已保存的配置与运行态合并，外加仅存在于运行态的残留项。 */
export function listMcpServers(): McpServerSummary[] {
  // Read the persistent source directly: a failed read must not look like an
  // empty list, and disconnected saved servers must remain manageable.
  const configs = configStore().read([]);
  const runtime = getMcpServerStates();
  const byId = new Map(runtime.map(server => [server.id, server]));
  const storedIds = new Set(configs.map(config => config.id));
  return [
    ...configs.map(config => {
      const state = byId.get(config.id);
      const connected = state?.connected ?? false;
      const failure = connected ? undefined : lastFailures.get(config.id);
      return {
        id: config.id,
        name: config.name,
        connected,
        toolCount: state?.toolCount ?? 0,
        toolIds: [...(state?.toolIds ?? [])],
        enabled: config.enabled !== false,
        ...(failure ? { failure } : {}),
      };
    }),
    // Failed cleanup can leave an owned runtime entry without persisted config.
    // Keep it visible, but never return the underlying connection configuration.
    ...runtime.filter(server => !storedIds.has(server.id)).map(server => ({
      id: server.id,
      name: server.name,
      connected: server.connected,
      toolCount: server.toolCount,
      toolIds: [...server.toolIds],
      enabled: true,
    })),
  ];
}

/**
 * 读取已持久化的 MCP server 配置（含连接失败、未连接的）。
 * 内置 MCP 同步逻辑需要完整连接配置；设置页的 listMcpServers 只返回
 * 配置与运行态合并后的安全摘要，不包含 command/env 等连接信息。
 */
export function listMcpServerConfigs(): McpServerConfig[] {
  return loadConfigs();
}
