import type { PluginHostError, PluginHostErrorCode } from "../../plugins/api";

export interface PluginHostErrorOptions {
  /** 底层原因，只写入宿主控制台，不挂到返回的错误对象上。 */
  cause?: unknown;
  /** 控制台标签前缀，缺省为 plugin-host。 */
  logPrefix?: string;
}

function reportCause(options: PluginHostErrorOptions, code: PluginHostErrorCode, message: string): void {
  const tag = options.logPrefix ?? "plugin-host";
  console.warn(`[${tag}] ${code}: ${message}`, options.cause);
}

/**
 * 构造插件可见的宿主错误。调用方应按 code 分支，文案仅供人读；
 * 带 cause 时原始异常只会进入宿主日志。
 */
export function pluginHostError(
  code: PluginHostErrorCode,
  message: string,
  options?: PluginHostErrorOptions,
): PluginHostError {
  if (options && options.cause !== undefined) {
    reportCause(options, code, message);
  }
  const failure = new Error(message) as PluginHostError;
  failure.code = code;
  return failure;
}
