import Ajv, { type ValidateFunction } from "ajv";
import {
  PLUGIN_TOOL_MODES,
  PLUGIN_TOOL_RISKS,
  type PluginManifestV1,
  type PluginToolMode,
  type PluginToolRisk,
} from "../../../shared/plugin-manifest";
import {
  HOST_TO_PLUGIN_METHODS,
  PLUGIN_TO_HOST_METHODS,
  PluginError,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { isAbortError } from "../../../main/base/utils/abort-utils";
import type { ToolContext } from "../../../main/tooling/registry/tool-context";
import { ToolExecutionError } from "../../../main/tooling/registry/tool-execution-error";
import {
  toolRegistry as defaultToolRegistry,
  type JsonSchemaProp,
  type ToolDefinition,
  type ToolRegistry,
} from "../../../main/tooling/registry/tool-registry";
import type {
  PluginToolCaller,
  PluginToolExecuteHost,
  PluginToolExecutionMeta,
  PluginToolResult,
  PluginToolService,
  PluginToolServiceOptions,
  RegisteredPluginTool,
} from "./types";

const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

const RISK_PRIORITY: Record<PluginToolRisk, number> = {
  "fs-read": 0,
  network: 1,
  shell: 2,
  "fs-write": 3,
  "input-control": 4,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 生成写入 Firefly `ToolRegistry` 的唯一工具 ID。
 * 仅使用 `[a-zA-Z0-9_-]`，避免部分模型供应商拒绝冒号或点号；
 * 合法 `pluginId`（不含 `_`）将 `.` 映射为 `_` 可保持一对一映射不碰撞。
 */
export function pluginToolId(pluginId: string, toolName: string): string {
  const safePlugin = pluginId.replace(/\./g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `plugin_${safePlugin}__${safeTool}`;
}

function strictestDeclaredRisk(risks: readonly PluginToolRisk[]): PluginToolRisk {
  let picked = risks[0];
  for (const risk of risks) {
    if (RISK_PRIORITY[risk] > RISK_PRIORITY[picked]) picked = risk;
  }
  return picked;
}

function formatAjvErrors(validate: ValidateFunction): string {
  if (!validate.errors?.length) return "arguments failed schema validation";
  return validate.errors
    .map((err) => {
      const loc = err.instancePath ? err.instancePath : "(root)";
      return `${loc} ${err.message ?? "invalid"}`.trim();
    })
    .join("; ");
}

function containsAsyncKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsAsyncKeyword);
  if (!isPlainRecord(node)) return false;
  return node.$async === true || Object.values(node).some(containsAsyncKeyword);
}

/**
 * The model only receives `properties` / `required`, so local `#/$defs/<name>` and
 * `#/definitions/<name>` references are inlined here; any other or recursive `$ref` is refused at
 * registration instead of producing a tool spec with dangling references.
 */
function inlineLocalRefs(root: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const refused = (detail: string) =>
    new PluginError("ERR_INVALID_ARGUMENT", `Tool "${toolName}" parameters ${detail}`);
  const resolve = (ref: string): Record<string, unknown> => {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
    const defs = match ? root[match[1]] : undefined;
    const key = match ? decodeURIComponent(match[2]).replace(/~1/g, "/").replace(/~0/g, "~") : "";
    const target = isPlainRecord(defs) ? defs[key] : undefined;
    if (!isPlainRecord(target)) throw refused(`use an unsupported $ref "${ref}"; only local #/$defs/<name> references are allowed`);
    return target;
  };
  const walk = (node: unknown, seen: readonly string[], atRoot: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, seen, false));
    if (!isPlainRecord(node)) return node;
    if (typeof node.$ref === "string") {
      if (seen.includes(node.$ref)) throw refused(`contain a recursive $ref "${node.$ref}"`);
      const { $ref, ...siblings } = node;
      return walk({ ...resolve($ref), ...siblings }, [...seen, $ref], false);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (atRoot && (key === "$defs" || key === "definitions")) continue;
      out[key] = walk(value, seen, false);
    }
    return out;
  };
  return walk(root, [], true) as Record<string, unknown>;
}

function normalizeInputSchema(rawParameters: Record<string, unknown>, toolName: string): ToolDefinition["inputSchema"] {
  const parameters = inlineLocalRefs(rawParameters, toolName);
  const properties = isPlainRecord(parameters.properties)
    ? (parameters.properties as Record<string, JsonSchemaProp>)
    : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
  };
}

function normalizeCaller(caller: unknown): PluginToolCaller {
  if (
    isPlainRecord(caller)
    && typeof caller.partnerId === "string"
    && caller.partnerId.trim().length > 0
  ) {
    return {
      partnerId: caller.partnerId,
      partnerName: typeof caller.partnerName === "string" && caller.partnerName.trim().length > 0
        ? caller.partnerName
        : caller.partnerId,
    };
  }
  return "firefly";
}

function normalizePluginToolResult(raw: unknown): PluginToolResult {
  if (!isPlainRecord(raw) || typeof raw.status !== "string") {
    return {
      status: "unknown",
      reason: "Plugin returned an invalid tool result payload",
    };
  }
  switch (raw.status) {
    case "succeeded": {
      if (typeof raw.output === "string" || isPlainRecord(raw.output)) {
        return {
          status: "succeeded",
          output: raw.output,
          ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
        };
      }
      return {
        status: "unknown",
        reason: "Plugin tool succeeded result had invalid output payload",
      };
    }
    case "failed": {
      return {
        status: "failed",
        error: typeof raw.error === "string" ? raw.error : "Plugin tool failed",
        ...(typeof raw.retryable === "boolean" ? { retryable: raw.retryable } : {}),
      };
    }
    case "not_executed": {
      return {
        status: "not_executed",
        reason: typeof raw.reason === "string" ? raw.reason : "Plugin tool was not executed",
      };
    }
    case "unknown": {
      return {
        status: "unknown",
        reason: typeof raw.reason === "string" ? raw.reason : "Plugin tool outcome is unknown",
        ...(typeof raw.possibleEffects === "string" ? { possibleEffects: raw.possibleEffects } : {}),
      };
    }
    default:
      return {
        status: "unknown",
        reason: `Plugin returned unsupported tool status: ${raw.status}`,
      };
  }
}

interface StoredToolEntry {
  record: RegisteredPluginTool;
  host: PluginToolExecuteHost;
  timeoutMs: number;
  definition: ToolDefinition;
}

export function createPluginToolService(options: PluginToolServiceOptions = {}): PluginToolService {
  const registry = options.registry ?? defaultToolRegistry;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const tools = new Map<string, StoredToolEntry>();

  const keyFor = (pluginId: string, toolName: string) => `${pluginId}\0${toolName}`;

  const executeTool: PluginToolService["executeTool"] = async (
    pluginId,
    toolName,
    args,
    meta: PluginToolExecutionMeta = {},
  ): Promise<PluginToolResult> => {
    const entry = tools.get(keyFor(pluginId, toolName));
    if (!entry) {
      return {
        status: "not_executed",
        reason: `ERR_UNDECLARED: Tool "${toolName}" for plugin "${pluginId}" is not registered`,
      };
    }
    if (meta.mode === "chat") {
      return {
        status: "not_executed",
        reason: "ERR_PERMISSION: Plugin tools are not available in chat mode",
      };
    }
    if (meta.mode !== undefined && !entry.record.modes.includes(meta.mode)) {
      return {
        status: "not_executed",
        reason: `ERR_PERMISSION: Tool "${toolName}" is not enabled for mode "${meta.mode}"`,
      };
    }
    if (!isPlainRecord(args)) {
      return {
        status: "not_executed",
        reason: "ERR_INVALID_ARGUMENT: Tool arguments must be a plain object",
      };
    }
    const validation = entry.record.validateArgs(args);
    if (!validation.valid) {
      return {
        status: "not_executed",
        reason: `ERR_INVALID_ARGUMENT: ${validation.message}`,
      };
    }
    if (meta.signal?.aborted) {
      return {
        status: "not_executed",
        reason: "ERR_CANCELLED: Tool call cancelled before dispatch",
      };
    }

    const mode: "work" | "code" = meta.mode === "code" ? "code" : "work";
    const caller = normalizeCaller(meta.caller);
    try {
      const raw = await entry.host.call(
        pluginId,
        HOST_TO_PLUGIN_METHODS.toolExecute,
        {
          name: toolName,
          args,
          callId: meta.callId ?? "",
          sessionId: meta.sessionId ?? "",
          mode,
          caller,
        },
        {
          signal: meta.signal,
          timeoutMs: meta.timeoutMs ?? entry.timeoutMs,
        },
      );
      return normalizePluginToolResult(raw);
    } catch (error) {
      if (isAbortError(error) || meta.signal?.aborted) {
        return {
          status: "unknown",
          reason: "ERR_CANCELLED: Tool call aborted after dispatch",
        };
      }
      if (error instanceof PluginError) {
        if (error.code === "ERR_TIMEOUT" || error.code === "ERR_CANCELLED" || error.code === "ERR_UNAVAILABLE") {
          return {
            status: "unknown",
            reason: `${error.code}: ${error.message}`,
          };
        }
        return {
          status: "failed",
          error: `${error.code}: ${error.message}`,
          retryable: error.retryable,
        };
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const registerTool: PluginToolService["registerTool"] = ({
    manifest,
    registration,
    host,
    timeoutMs,
  }) => {
    if (!isPlainRecord(registration)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "tools.register payload must be an object");
    }
    const name = typeof registration.name === "string" ? registration.name.trim() : "";
    if (!name || name !== registration.name) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "tools.register requires a non-empty tool name");
    }
    if (typeof registration.description !== "string") {
      throw new PluginError("ERR_INVALID_ARGUMENT", "tools.register requires a string description");
    }
    if (!isPlainRecord(registration.parameters) || registration.parameters.type !== "object") {
      throw new PluginError("ERR_INVALID_ARGUMENT", 'tools.register requires parameters JSON Schema with type: "object"');
    }

    const declared = manifest.tools?.find((candidate) => candidate.name === name);
    if (!declared) {
      throw new PluginError("ERR_UNDECLARED", `Tool "${name}" is not declared in the manifest`);
    }

    if (
      !Array.isArray(declared.risk)
      || declared.risk.length === 0
      || declared.risk.some((risk) => !PLUGIN_TOOL_RISKS.includes(risk))
    ) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Tool "${name}" has invalid declared risk`);
    }
    if (
      !Array.isArray(declared.modes)
      || declared.modes.length === 0
      || declared.modes.some((mode) => !PLUGIN_TOOL_MODES.includes(mode))
    ) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Tool "${name}" has invalid declared modes`);
    }

    // validateArgs is synchronous: an async schema would return a Promise that always looks valid.
    if (containsAsyncKeyword(registration.parameters)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Tool "${name}" parameters must not use $async schemas`);
    }
    let validate: ValidateFunction;
    try {
      // One Ajv per registration: a schema `$id` must not collide with another plugin's or with a
      // previous registration of the same tool after it was unregistered.
      validate = new AjvCtor({ strict: false, allErrors: true }).compile(registration.parameters);
    } catch (error) {
      throw new PluginError(
        "ERR_INVALID_ARGUMENT",
        `Invalid parameters JSON Schema for "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ((validate as { $async?: unknown }).$async === true) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Tool "${name}" parameters must not use $async schemas`);
    }
    const inputSchema = normalizeInputSchema(registration.parameters, name);

    const validateArgs: RegisteredPluginTool["validateArgs"] = (args) => {
      if (!isPlainRecord(args)) {
        return { valid: false, message: "arguments must be a JSON object" };
      }
      if (validate(args)) return { valid: true };
      return { valid: false, message: formatAjvErrors(validate) };
    };

    const toolId = pluginToolId(manifest.id, name);
    const existingGlobal = registry.getById(toolId);
    const mapKey = keyFor(manifest.id, name);
    const existingOwned = tools.get(mapKey);
    if (existingGlobal && existingGlobal !== existingOwned?.definition) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `Tool ID "${toolId}" is already occupied`);
    }

    const risks = [...declared.risk];
    const modes = [...declared.modes];
    const record: RegisteredPluginTool = {
      pluginId: manifest.id,
      pluginName: manifest.name,
      name,
      toolId,
      description: registration.description,
      parameters: registration.parameters,
      risks,
      modes,
      validateArgs,
    };

    const definition: ToolDefinition = {
      id: toolId,
      name: declared.title || name,
      description: registration.description,
      enabled: true,
      modes,
      risk: strictestDeclaredRisk(risks),
      risks,
      // 仅声明 fs-read 的插件工具按只读（read）处理；其余插件工具宿主无法核实其幂等性，
      // 显式标为 external_side_effect（经 resolveSideEffect 映射为 non_idempotent_side_effect），
      // 确保崩溃、超时或中途取消产生 effectState: "unknown" 时触发 uncertainEffects 门禁并禁止自动重试。
      effectKind: risks.length === 1 && risks[0] === "fs-read" ? "read" : "external_side_effect",
      pluginMeta: {
        pluginId: manifest.id,
        pluginName: manifest.name,
        toolName: name,
      },
      inputSchema,
      // The four-state result is the outcome; output content must not be re-read as a status.
      explicitOutcome: true,
      needsContext: true,
      validateArgs,
      execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
        if (ctx?.signal?.aborted) {
          throw new ToolExecutionError("ERR_CANCELLED", "Tool call aborted", "runtime_safety", false, "not_applied", false);
        }
        const result = await executeTool(manifest.id, name, args, {
          callId: ctx?.toolCallId ?? "",
          sessionId: ctx?.conversationId ?? "",
          mode: ctx?.mode,
          caller: ctx?.caller ?? "firefly",
          signal: ctx?.signal,
          timeoutMs: timeoutMs ?? defaultTimeoutMs,
        });
        switch (result.status) {
          case "succeeded":
            return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
          case "not_executed": {
            const isInvalid = result.reason.startsWith("ERR_INVALID_ARGUMENT");
            const isDenied = result.reason.startsWith("ERR_PERMISSION");
            const code = isInvalid
              ? "ERR_INVALID_ARGUMENT"
              : isDenied
                ? "ERR_PERMISSION"
                : result.reason.startsWith("ERR_CANCELLED")
                  ? "ERR_CANCELLED"
                  : "ERR_NOT_EXECUTED";
            throw new ToolExecutionError(
              code,
              result.reason,
              isInvalid ? "invalid_arguments" : isDenied ? "permission_denied" : "runtime_safety",
              false,
              "not_applied",
              false,
            );
          }
          case "unknown": {
            const detail = result.possibleEffects
              ? `${result.reason} (${result.possibleEffects})`
              : result.reason;
            throw new ToolExecutionError("ERR_PLUGIN_TOOL_UNKNOWN", detail, "fatal", false, "unknown");
          }
          case "failed":
            throw new ToolExecutionError(
              "ERR_PLUGIN_TOOL_FAILED",
              result.error,
              "semantic_failure",
              Boolean(result.retryable),
              "not_applied",
            );
        }
      },
    };

    registry.register(definition);
    tools.set(mapKey, {
      record,
      host,
      timeoutMs: timeoutMs ?? defaultTimeoutMs,
      definition,
    });
    return record;
  };

  const unregisterTool: PluginToolService["unregisterTool"] = (pluginId, toolName) => {
    const mapKey = keyFor(pluginId, toolName);
    const entry = tools.get(mapKey);
    if (!entry) return false;
    tools.delete(mapKey);
    if (registry.getById(entry.definition.id) === entry.definition) {
      registry.unregister(entry.definition.id);
    }
    return true;
  };

  const unregisterPlugin: PluginToolService["unregisterPlugin"] = (pluginId) => {
    let removed = 0;
    for (const [key, entry] of [...tools.entries()]) {
      if (entry.record.pluginId !== pluginId) continue;
      tools.delete(key);
      if (registry.getById(entry.definition.id) === entry.definition) {
        registry.unregister(entry.definition.id);
      }
      removed += 1;
    }
    return removed;
  };

  const getTool: PluginToolService["getTool"] = (pluginId, toolName) => tools.get(keyFor(pluginId, toolName))?.record;

  const listTools: PluginToolService["listTools"] = (pluginId) =>
    [...tools.values()]
      .filter((entry) => pluginId === undefined || entry.record.pluginId === pluginId)
      .map((entry) => entry.record);

  const bindRpc: PluginToolService["bindRpc"] = (manifest, rpc, host) => {
    const offRegister = rpc.handle(PLUGIN_TO_HOST_METHODS.toolsRegister, (params) => {
      registerTool({ manifest, registration: params, host });
      return null;
    });
    const offUnregister = rpc.handle(PLUGIN_TO_HOST_METHODS.toolsUnregister, (params) => {
      if (!isPlainRecord(params) || typeof params.name !== "string" || !params.name.trim()) {
        throw new PluginError("ERR_INVALID_ARGUMENT", "tools.unregister requires a non-empty tool name");
      }
      unregisterTool(manifest.id, params.name);
      return null;
    });
    return () => {
      offRegister();
      offUnregister();
    };
  };

  return {
    registerTool,
    unregisterTool,
    unregisterPlugin,
    getTool,
    listTools,
    executeTool,
    bindRpc,
  };
}
