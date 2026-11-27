import { PluginError, type PluginErrorCode } from "./plugin-protocol";

/** Marks an RPC error message that carries the plugin's own activate() failure text. */
export const PLUGIN_ACTIVATE_ERROR_PREFIX = "Plugin activate() threw: ";

const MAX_PLUGIN_MESSAGE_LENGTH = 160;

/**
 * Anything that looks like the start of a local path: drive letter, UNC, ~ or %VAR% / $VAR prefixes,
 * relative ./ ../ prefixes, or a "/x" at the start of a token (including single-segment POSIX root paths).
 * A path's end cannot be located safely (names may contain spaces and quotes), so everything from here on is dropped.
 */
const PATH_START =
  /(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?=[\\/]|$)|(?<![^\s("'`[=,;])(?:\.{1,2}[\\/]|\/(?=[^\s/]))/;

export const REDACTED_PATH_MARK = "<路径>";

/** Reduces a plugin-authored message to one short plain-text line with no stack and no file paths. */
export function sanitizePluginMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const pathAt = firstLine.search(PATH_START);
  const withoutPaths = (pathAt < 0 ? firstLine : `${firstLine.slice(0, pathAt)}${REDACTED_PATH_MARK}`)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutPaths.length > MAX_PLUGIN_MESSAGE_LENGTH
    ? `${withoutPaths.slice(0, MAX_PLUGIN_MESSAGE_LENGTH)}…`
    : withoutPaths;
}

/** Runtime side: turns whatever the plugin's activate() threw into a PluginError that keeps a safe message. */
export function wrapPluginActivationError(error: unknown): unknown {
  if (error instanceof PluginError) return error;
  const message = sanitizePluginMessage(error instanceof Error ? error.message : String(error));
  return new PluginError("ERR_INTERNAL", `${PLUGIN_ACTIVATE_ERROR_PREFIX}${message}`);
}

const CODE_TEXT: Partial<Record<PluginErrorCode, string>> = {
  ERR_TIMEOUT: "启动超时",
  ERR_CANCELLED: "启动被取消",
  ERR_PERMISSION: "缺少所需权限",
  ERR_UNAVAILABLE: "插件进程不可用",
};

/** Host side: Chinese user-facing reason for a failed start; never echoes host internals. */
export function describeActivationFailure(error: unknown): string {
  if (error instanceof PluginError) {
    if (error.code === "ERR_INTERNAL" && error.message.startsWith(PLUGIN_ACTIVATE_ERROR_PREFIX)) {
      const own = sanitizePluginMessage(error.message.slice(PLUGIN_ACTIVATE_ERROR_PREFIX.length));
      // A message that was only a path (or empty) says nothing useful.
      return own && own !== REDACTED_PATH_MARK ? `插件自身报错：${own}` : "插件启动时抛出了错误";
    }
    return CODE_TEXT[error.code] ?? "插件启动失败";
  }
  return "插件启动失败";
}
