import { PLUGIN_TO_HOST_METHODS as P, PluginError } from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import type { PluginSecretsService } from "./secrets-service";

export interface BindPluginSecretsRpcOptions {
  pluginId: string;
  declared: boolean;
  hasPermission: () => boolean;
}

function assertObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid secrets RPC arguments");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Unexpected field in secrets RPC arguments");
  }
  return record;
}

/**
 * Attaches `secrets.*` RPC handlers for a single v2 plugin process.
 * Permission is checked on every call so live revocation rejects subsequent calls immediately.
 */
export function bindPluginSecretsRpc(
  service: PluginSecretsService,
  options: BindPluginSecretsRpcOptions,
  rpc: PluginRpc,
): () => void {
  const scoped = service.forPlugin(options.pluginId);
  const ensureAllowed = (): void => {
    if (!options.declared) {
      throw new PluginError("ERR_UNDECLARED", 'Permission "secrets" is not declared in manifest');
    }
    if (!options.hasPermission()) {
      throw new PluginError("ERR_PERMISSION", 'Permission "secrets" is not granted');
    }
  };

  const stops = [
    rpc.handle(P.secretsGet, async (params) => {
      ensureAllowed();
      const input = assertObject(params, ["key"]);
      return scoped.get(input.key as string);
    }),
    rpc.handle(P.secretsSet, async (params) => {
      ensureAllowed();
      const input = assertObject(params, ["key", "value"]);
      await scoped.set(input.key as string, input.value as string);
    }),
    rpc.handle(P.secretsDelete, async (params) => {
      ensureAllowed();
      const input = assertObject(params, ["key"]);
      return scoped.delete(input.key as string);
    }),
    rpc.handle(P.secretsKeys, async (params) => {
      ensureAllowed();
      assertObject(params ?? {}, []);
      return scoped.keys();
    }),
  ];

  return () => {
    for (const stop of stops) stop();
  };
}
