export type FireflyEnvironmentKey =
  | "FIREFLY_PERF_HARNESS"
  | "FIREFLY_PERF_PROFILE"
  | "FIREFLY_PERF_OUT_DIR"
  | "FIREFLY_LOG_LEVEL"
  | "FIREFLY_ELECTRON_BIN"
  | "FIREFLY_HOME"
  | "FIREFLY_DEBUG_LOGS"
  | "FIREFLY_TRANSCRIPT_CONTEXT_SOURCE"
  | "FIREFLY_SKIP_FFPROBE"
  | "FIREFLY_SCREENSHOT_HELPER_PATH"
  | "FIREFLY_MODELS_DIR"
  | "FIREFLY_SRT"
  | "FIREFLY_PROMPT_DUMP"
;

export function fireflyEnvironment(env: Record<string, string | undefined>, key: FireflyEnvironmentKey): string | undefined {
  return env[key];
}
