import type {
  PluginManifestV1,
  PluginToolMode,
  PluginToolRisk,
} from "../../../shared/plugin-manifest";
import type { ToolRegistry } from "../../../main/tooling/registry/tool-registry";
import type { PluginRpc } from "../../../shared/plugin-rpc";

export type PluginToolCaller = "firefly" | { partnerId: string; partnerName: string };

export type PluginToolResult =
  | { status: "succeeded"; output: string | Record<string, unknown>; summary?: string }
  | { status: "failed"; error: string; retryable?: boolean }
  | { status: "unknown"; reason: string; possibleEffects?: string }
  | { status: "not_executed"; reason: string };

export interface PluginToolRegistrationPayload {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PluginToolExecuteHost {
  call<T = unknown>(
    id: string,
    method: string,
    params: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T | { status: "unknown"; reason: string }>;
}

export interface PluginToolExecutionMeta {
  callId?: string;
  runId?: string;
  sessionId?: string;
  mode?: "chat" | "work" | "code";
  caller?: PluginToolCaller;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RegisteredPluginTool {
  pluginId: string;
  pluginName: string;
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  risks: PluginToolRisk[];
  modes: PluginToolMode[];
  validateArgs: (args: unknown) => { valid: true } | { valid: false; message: string };
}

export interface PluginToolProgressEvent {
  pluginId: string;
  callId: string;
  runId?: string;
  sessionId?: string;
  message: string;
  percent?: number;
}

export interface PluginToolServiceOptions {
  registry?: ToolRegistry;
  defaultTimeoutMs?: number;
  canExecute?: (pluginId: string, toolName: string) => boolean;
  onProgress?: (event: PluginToolProgressEvent) => void;
}

export interface PluginToolService {
  registerTool(input: {
    manifest: PluginManifestV1;
    registration: unknown;
    host: PluginToolExecuteHost;
    timeoutMs?: number;
  }): RegisteredPluginTool;
  unregisterTool(pluginId: string, toolName: string): boolean;
  unregisterPlugin(pluginId: string): number;
  getTool(pluginId: string, toolName: string): RegisteredPluginTool | undefined;
  listTools(pluginId?: string): RegisteredPluginTool[];
  executeTool(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    meta?: PluginToolExecutionMeta,
  ): Promise<PluginToolResult>;
  bindRpc(manifest: PluginManifestV1, rpc: PluginRpc, host: PluginToolExecuteHost): () => void;
}
