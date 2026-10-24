// MCP Adapter — 将 MCP server 的工具发现和调用适配到 ToolRegistry
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolDefinition, toolRegistry, type ToolEffectKind } from "./tools/registry/tool-registry";
import type { ToolRiskLevel } from "../permission/permission-policy";
import { ToolExecutionError } from "./tools/registry/tool-execution-error";
import type { ToolContext } from "./tools/registry/tool-context";
import { createAbortError, isCancellationError, raceWithSignal } from "../utils/abort-utils";
import { createMcpSchemaValidator, discoverMcpToolCatalog } from "./mcp-tool-catalog";
import { classifyMcpFailure, isMcpAuthFailure } from "./mcp-failure";

const SECRET_ENV_KEY = /token|secret|key|passw|auth|credential|cookie|bearer|session|signature|private/i;

/** 只擦除疑似凭据的环境值：键名像凭据，或值足够长且不是纯数字；
 *  `1`、`true`、`/` 这类普通开关或路径片段若被替换，会把诊断文本改得面目全非。 */
export function redactConfiguredEnvValues(message: string, env: Record<string, string> | undefined): string {
  const candidates = Object.entries(env ?? {})
    .filter(([key, value]) => value && value.length >= 4 && (SECRET_ENV_KEY.test(key) || (value.length >= 12 && !/^\d+$/.test(value))))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return candidates.reduce((text, value) => text.split(value).join("[REDACTED]"), message);
}

const LOG_PREFIX = "[MCP Adapter]";

const MCP_EFFECT_RISK: Record<ToolEffectKind, ToolRiskLevel> = {
  read: "network",
  verification: "network",
  mutation: "fs-write",
  external_side_effect: "input-control",
  unknown: "input-control",
};

export type McpServerConfig = {
  effectKindOverrides?: Record<string, ToolEffectKind>; // 以工具名为键，逐个覆盖 effectKind
  enabled?: boolean; // 省略时视为启用；为 false 时不连接，也不暴露工具
  url?: string; // 仅 sse 使用
  cwd?: string;
  env?: Record<string, string>;
  args?: string[]; // 启动参数，仅 stdio
  command?: string; // 仅 stdio
  /** stdio runs a local command; http is the current Streamable HTTP transport; sse is the legacy HTTP+SSE one. */
  transport: "stdio" | "sse" | "http";
  name: string; // 界面展示名
  id: string; // 全局唯一标识
};

/** MCP 工具注解（协议 2025-03-26 版本） */
type McpToolAnnotations = {
  [key: string]: unknown;
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
};

type McpServerState = {
  toolIds: string[]; // 已经注册进 ToolRegistry 的工具 ID
  owner?: object; // 仅主进程持有的连接身份；绝不序列化进 MCP 配置或参数
  ownedTools: Map<string, ToolDefinition>;
  connected: boolean;
  transport: Transport;
  client: Client;
  config: McpServerConfig;
};

/**
 * 从本地 override 或 MCP Tool annotations 推导 effectKind。
 * 当前配置没有可信 server 标记，server 的 readOnlyHint 不可降低工具风险。
 *
 * 优先级（保守策略）：
 * 1. 本地有效 override（最高优先级）
 * 2. destructiveHint=true → external_side_effect（第三方 annotations 矛盾时采用保守策略）
 * 3. 其余 server annotations → unknown（按 input-control 风险检查权限）
 *
 * 注意：destructiveHint=false 不等于 readOnlyHint=true。
 * 第三方 annotations 同时设置 readOnlyHint + destructiveHint 时，destructive 优先（按外部副作用风险检查权限）。
 */
function resolveMcpEffectKind(annotations: McpToolAnnotations | undefined, overrides: Record<string, ToolEffectKind> | undefined, toolName: string): ToolEffectKind {
  // 优先级 1：本地有效 override
  const override = overrides && Object.prototype.hasOwnProperty.call(overrides, toolName)
    ? overrides[toolName]
    : undefined;
  if (typeof override === "string" && Object.prototype.hasOwnProperty.call(MCP_EFFECT_RISK, override)) {
    return override as ToolEffectKind;
  }
  if (!annotations) return "unknown";
  // 优先级 2：destructiveHint=true（保守策略，按外部副作用风险检查权限）
  if (annotations.destructiveHint === true) return "external_side_effect";
  // 优先级 3：无可信 server 标记时，其余 annotations 不能降级风险
  return "unknown";
}

function sameConnectionConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  const comparable = (config: McpServerConfig) => ({
    id: config.id, name: config.name, transport: config.transport,
    command: config.command, args: config.args ?? [], env: config.env ?? {},
    cwd: config.cwd, url: config.url, effectKindOverrides: config.effectKindOverrides ?? {},
  });
  return isDeepStrictEqual(comparable(a), comparable(b));
}

// Adapter 是每个 ID 的唯一连接所有者。相同请求合并；变更/断开按调用顺序执行。
const mcpOperations = new Map<string, { config?: McpServerConfig; owner?: object; promise: Promise<unknown> }>();

function queueMcpOperation<T>(serverId: string, config: McpServerConfig | undefined, run: () => Promise<T>, owner?: object): Promise<T> {
  const previous = mcpOperations.get(serverId);
  const promise = (previous ? previous.promise.catch(() => undefined) : Promise.resolve()).then(run);
  const operation = { config, owner, promise };
  mcpOperations.set(serverId, operation);
  const clear = () => {
    if (mcpOperations.get(serverId) === operation) mcpOperations.delete(serverId);
  };
  void promise.then(clear, clear);
  return promise;
}

/**
 * 连接一个 MCP server，发现其工具并注册到 ToolRegistry。
 * 返回注册的工具 ID 列表。
 */
// Optional Main-only identity binds cleanup, not tool authorization or persisted config.
export function connectMcpServer(config: McpServerConfig, owner?: object): Promise<string[]> {
  // 固定调用时的配置，避免等待中的 caller 修改导致沿用错误 client/工具风险。
  const snapshot: McpServerConfig = {
    ...config,
    args: config.args === undefined ? undefined : [...config.args],
    env: config.env === undefined ? undefined : { ...config.env },
    effectKindOverrides: config.effectKindOverrides === undefined ? undefined : { ...config.effectKindOverrides },
  };
  const pending = mcpOperations.get(snapshot.id);
  if (pending?.config && sameConnectionConfig(pending.config, snapshot) && (owner === undefined || pending.owner === owner)) {
    return (pending.promise as Promise<string[]>).then(ids => [...ids]);
  }
  return queueMcpOperation(snapshot.id, snapshot, async () => {
    const existing = mcpServerStates.get(snapshot.id);
    if (existing?.connected && sameConnectionConfig(existing.config, snapshot)) {
      if (owner !== undefined && existing.owner !== owner) throw new Error("MCP connection ownership conflict");
      return [...existing.toolIds];
    }
    if (existing) await disconnectMcpServerNow(snapshot.id);
    return connectMcpServerNow(snapshot, owner);
  }, owner).then(ids => [...ids]);
}

function unregisterOwnedMcpTools(state: McpServerState): void {
  for (const [id, definition] of state.ownedTools) {
    if (toolRegistry.getById(id) === definition) toolRegistry.unregister(id);
  }
  state.ownedTools.clear();
  state.toolIds = [];
}

function forgetMcpState(state: McpServerState): void {
  state.connected = false;
  unregisterOwnedMcpTools(state);
  if (mcpServerStates.get(state.config.id) === state) mcpServerStates.delete(state.config.id);
}

async function closeMcpResources(client: Client, transport: Transport): Promise<void> {
  // SDK 1.29.0 Protocol.close() 关闭其 transport；失败时直接释放 transport。
  // https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/protocol.ts
  try { await client.close(); }
  catch (err) {
    console.error(LOG_PREFIX, "client.close 失败:", classifyMcpFailure(err));
    try { await transport.close(); }
    catch (closeErr) {
      console.error(LOG_PREFIX, "transport.close 失败:", classifyMcpFailure(closeErr));
      throw closeErr;
    }
  }
}

async function releaseMcpState(state: McpServerState): Promise<void> {
  await closeMcpResources(state.client, state.transport);
  forgetMcpState(state);
}

async function cleanupFailedMcpState(state: McpServerState): Promise<void> {
  try { await releaseMcpState(state); }
  catch {
    console.error(LOG_PREFIX, "资源清理未完成，将在下次连接/断开时重试:", state.config.id);
  }
}

/** 依据配置构造 transport；缺少必填项时直接抛错，不会尝试连接。 */
function createTransport(config: McpServerConfig): Transport {
  if (config.transport === "http") {
    if (!config.url) throw new Error("http transport requires url");
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  if (config.transport === "sse") {
    if (!config.url) throw new Error("sse transport requires url");
    return new SSEClientTransport(new URL(config.url));
  }
  if (!config.command) throw new Error("stdio transport requires command");
  return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd });
}

async function connectMcpServerNow(config: McpServerConfig, owner?: object): Promise<string[]> {
  console.log(LOG_PREFIX, "连接 MCP server:", config.name, `(${config.id})`);

  const transport = createTransport(config);

  // transport 出错时只记日志，恢复由上层的连接生命周期负责
  transport.onerror = (err: Error) => {
    console.error(LOG_PREFIX, `transport 错误 [${config.name}]:`, classifyMcpFailure(err));
  };

  const schemaValidator = createMcpSchemaValidator();
  const client = new Client(
    { name: "firefly", version: "0.8.0" },
    { capabilities: {}, jsonSchemaValidator: schemaValidator },
  );

  // 在连接完成前也持有资源；清理失败时保留 disconnected 状态供重试。
  const state: McpServerState = {
    config, client, transport, connected: false, toolIds: [], owner, ownedTools: new Map(),
  };
  mcpServerStates.set(config.id, state);
  let closed = false;
  const discovery = new AbortController();
  client.onclose = () => {
    closed = true;
    discovery.abort();
    const owned = mcpServerStates.get(config.id);
    if (owned?.client === client) forgetMcpState(owned);
  };

  try {
    await client.connect(transport);
    console.log(LOG_PREFIX, "已连接到", config.name);
  } catch (err) {
    console.error(LOG_PREFIX, `连接失败 [${config.name}]:`, classifyMcpFailure(err));
    // 连接失败时清理 transport
    try {
      await transport.close();
      forgetMcpState(state);
    } catch (closeErr) {
      console.error(LOG_PREFIX, "连接失败后的 transport 清理未完成:", config.id,
        classifyMcpFailure(closeErr));
    }
    throw err;
  }

  // 发现工具
  let catalog: Awaited<ReturnType<typeof discoverMcpToolCatalog>>;

  try {
    catalog = await discoverMcpToolCatalog(client, discovery.signal, schemaValidator);
    console.log(LOG_PREFIX, "发现 " + catalog.tools.length + " 个工具:", catalog.tools.map(t => t.name).join(", "));
  } catch (err) {
    console.error(LOG_PREFIX, "listTools 失败 [" + config.name + "]:", classifyMcpFailure(err));
    await cleanupFailedMcpState(state);
    throw err;
  }

  // 注册到 ToolRegistry
  const registeredIds = state.toolIds;
  try {
    if (closed) throw new Error("MCP connection closed during discovery");
    for (const mt of catalog.tools) {
      // 工具 ID 用连字符连接而不用冒号：部分厂商对 function.name 的正则不接受冒号
      const toolId = `${config.id}-${mt.name}`;

      // 同 ID 的工具已经存在时直接跳过
      if (toolRegistry.getById(toolId)) {
        console.warn(LOG_PREFIX, "工具已存在，跳过:", toolId);
        continue;
      }

      // effectKind 优先取本地覆盖，其次由 annotations 推断
      const resolvedEffectKind = resolveMcpEffectKind(mt.annotations, config.effectKindOverrides, mt.name);
      if (resolvedEffectKind === "unknown") {
        console.warn(LOG_PREFIX, `工具 ${toolId} 的 effectKind 为 unknown，将按 input-control 风险检查权限`);
      }

      const schemaProperties = (mt.inputSchema?.properties as Record<string, { type: string; description: string }>) || {};
      const toolDef: ToolDefinition = {
        id: toolId, name: `[${config.name}] ${mt.name}`, description: mt.description || mt.name, enabled: true,
        effectKind: resolvedEffectKind, risk: MCP_EFFECT_RISK[resolvedEffectKind],
        inputSchema: { type: "object", properties: schemaProperties, required: mt.inputSchema?.required },
        needsContext: true,
        // Cancellation belongs to SDK request options, never to server-visible tool arguments.
        execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
          if (ctx?.signal?.aborted) throw createAbortError();
          console.log(LOG_PREFIX, "调用工具:", toolId);
          try {
            const owned = mcpServerStates.get(config.id);
            if (!owned?.connected || owned.client !== client || closed) {
              throw new Error("MCP connection is no longer owned");
            }
            if (mt.execution?.taskSupport === "required") throw new Error(`MCP task execution required for tool ${mt.name}`);
            const request = { name: mt.name, arguments: args };
            let result: Awaited<ReturnType<Client["callTool"]>>;
            try {
              result = await raceWithSignal(ctx?.signal
                ? client.callTool(request, undefined, { signal: ctx.signal })
                : client.callTool(request), ctx?.signal);
            } catch (error) {
              if (isCancellationError(error, ctx?.signal)) throw createAbortError();
              const reason = classifyMcpFailure(error);
              // Remote exception text can echo credentials. Keep recovery categories,
              // but never automatically replay a request whose effects are unknown.
              throw new ToolExecutionError(
                "E_MCP_TOOL_FAILED",
                `E_MCP_TOOL_FAILED: ${isMcpAuthFailure(error) ? "auth" : "transport"} (${reason})`,
                reason === "timeout" ? "timeout" : reason === "permission-denied" ? "permission_denied" : "transient",
                false,
                "unknown",
              );
            }
            const currentOwner = mcpServerStates.get(config.id);
            if (!currentOwner?.connected || currentOwner.client !== client || closed) {
              throw new Error("MCP connection is no longer owned");
            }
            catalog.validateResult(mt, result);
            // 只保留 text 类型的内容块；没有任何文本时退回整个 content 的 JSON
            const texts = Array.isArray(result.content)
              ? result.content
                .filter((block) => block && typeof block === "object" && (block as { type: string }).type === "text")
                .map((block) => String((block as { text: string }).text))
              : [];
            const output = texts.join("\n") || JSON.stringify(result.content);
            if (result.isError === true) throw new Error(`E_MCP_TOOL_FAILED${output ? `: ${output}` : ""}`);
            console.log(LOG_PREFIX, `工具返回 [${toolId}]`);
            return output;
          } catch (err) {
            if (isCancellationError(err, ctx?.signal)) throw createAbortError();
            console.error(LOG_PREFIX, "工具调用失败 [" + toolId + "]:", classifyMcpFailure(err));
            if (err instanceof ToolExecutionError) throw err;
            let msg = err instanceof Error ? err.message : String(err);
            // A tool-level failure may echo its environment. Preserve useful recovery
            // text, but remove exact configured values (including nonstandard key names).
            msg = redactConfiguredEnvValues(msg, config.env);
            throw new ToolExecutionError(
              "E_MCP_TOOL_FAILED",
              msg.startsWith("E_MCP_TOOL_FAILED") ? msg : `E_MCP_TOOL_FAILED: ${msg}`,
              "semantic_failure",
              false,
              "unknown",
            );
          }
        },
      };

      state.ownedTools.set(toolId, toolDef);
      toolRegistry.register(toolDef); registeredIds.push(toolId);
      console.log(LOG_PREFIX, "已注册工具:", toolId);
    }

    // 保存状态
    state.connected = true;

    console.log(LOG_PREFIX, "MCP server 就绪:", config.name, "(" + registeredIds.length + " 个工具)");
    return [...registeredIds];
  } catch (err) {
    unregisterOwnedMcpTools(state);
    await cleanupFailedMcpState(state);
    throw err;
  }
}

/**
 * 断开并清理一个 MCP server 及其注册的工具。
 */
// An owner mismatch leaves a later connection untouched; omitted owner retains the host API.
export function disconnectMcpServer(serverId: string, owner?: object): Promise<boolean> {
  return queueMcpOperation(serverId, undefined, () => disconnectMcpServerNow(serverId, owner));
}

async function disconnectMcpServerNow(serverId: string, owner?: object): Promise<boolean> {
  console.log(LOG_PREFIX, `断开 MCP server: ${serverId}`);
  const state = mcpServerStates.get(serverId);
  if (!state) {
    console.warn(LOG_PREFIX, "未找到 MCP server:", serverId);
    return false;
  }
  if (owner !== undefined && state.owner !== owner) return false;

  // 先撤销所有权与工具：关闭期间，旧 execute 闭包也拿不到可用的 client
  state.connected = false;
  unregisterOwnedMcpTools(state);
  await releaseMcpState(state);
  console.log(LOG_PREFIX, "已断开:", serverId);
  return true;
}

/**
 * 返回所有仍持有运行时所有权的 MCP server 状态，包括清理失败、等待重试的那些。
 */
export function getMcpServerStates(): Array<{ id: string; name: string; connected: boolean; toolCount: number; toolIds: string[] }> {
  return Array.from(mcpServerStates.values(), (s) => ({ id: s.config.id, name: s.config.name, connected: s.connected, toolCount: s.toolIds.length, toolIds: [...s.toolIds] }));
}

// 内部状态存储
const mcpServerStates = new Map<string, McpServerState>();
