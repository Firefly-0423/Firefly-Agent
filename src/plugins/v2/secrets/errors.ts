/**
 * Firefly Plugin SDK 1.2.0 error codes (Spec §6.1).
 */
export const PLUGIN_ERROR_CODES = [
  "ERR_UNDECLARED",
  "ERR_PERMISSION",
  "ERR_REJECTED",
  "ERR_CANCELLED",
  "ERR_TIMEOUT",
  "ERR_INVALID_ARGUMENT",
  "ERR_RATE_LIMITED",
  "ERR_UNAVAILABLE",
  "ERR_INTERNAL",
] as const;

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

const PLUGIN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(PLUGIN_ERROR_CODES);

export interface PluginErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Stable host/SDK error exposed across the Plugin SDK 1.2.0 boundary.
 */
export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly retryable: boolean;

  constructor(code: PluginErrorCode, message: string, options?: PluginErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function isPluginError(value: unknown): value is PluginError {
  return value instanceof Error && PLUGIN_ERROR_CODE_SET.has((value as Partial<PluginError>).code ?? "");
}
