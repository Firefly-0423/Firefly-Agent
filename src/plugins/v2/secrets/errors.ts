import {
  PLUGIN_ERROR_CODES,
  PluginError,
  type PluginErrorCode,
} from "../../../shared/plugin-protocol";

export { PLUGIN_ERROR_CODES, PluginError, type PluginErrorCode };

const PLUGIN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(PLUGIN_ERROR_CODES);

export function isPluginError(value: unknown): value is PluginError {
  return (
    value instanceof Error
    && value.name === "PluginError"
    && PLUGIN_ERROR_CODE_SET.has((value as Partial<PluginError>).code ?? "")
  );
}
